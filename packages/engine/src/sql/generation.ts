/**
 * The SET list of every UPDATE grizzle emits, an ON CONFLICT DO UPDATE's and a MERGE's UPDATE among them: it assigns at
 * least one column some stored generated column of its table reads, wherever the UPDATE may assign such a column.
 *
 * PostgreSQL 19.0 (nodeModifyTable.c ExecComputeStoredGenerated, ExecInitGenerated)
 * builds an UPDATE's generation expressions on its first row and keep them in ri_GeneratedExprsU, which is
 * how the later rows find them built. When no stored generated column reads a column the UPDATE assigns,
 * ExecInitGenerated pfrees the array it built ("didn't need it after all") and leaves ri_GeneratedExprsU NULL, so every
 * row builds it again: build_column_default's stringToNode of every stored generated column's expression and
 * pull_varattnos of it, in the query's memory, ExecutorState, which nothing frees before the statement ends. On 19.0,
 * qti.attribute's 104 generation expressions at its C18 fill are 83 KB of trees, so that fill over 865,000 rows grows
 * ExecutorState to 72 GB, as it did in production in 17 minutes (lane FILLMEM). An UPDATE that assigns a column a stored generated column reads leaves the array in place after its first
 * row: memory flat in the rows, the generation expressions built once (test/pg/migrate/generated-fill-memory.test.ts;
 * upstream/generated-update-rebuild).
 *
 * So an UPDATE whose own SET list feeds no stored generated column also assigns its table's anchor to itself
 * (`"anchor" = "<target>"."anchor"`): among the columns its updater may assign (laws/model/generation.ts Updater), the one
 * whose readers cost least per row, since PostgreSQL then recomputes each stored generated column that reads it, on
 * every row the UPDATE writes. A value assigned to itself changes no index key, so the update stays HOT where it was,
 * no key a foreign key compares changes, and no trigger grizzle installs lists columns. A table whose every stored
 * generated column reads no column, a constant tag's, has no anchor, nor has a role's UPDATE whose grants list no
 * column a generated one reads; those UPDATEs keep PostgreSQL's per-row rebuild.
 *
 * Delete this module, and Assignments with it, once production runs a PostgreSQL release whose ExecInitGenerated keeps
 * the array, or a flag that nothing is needed, when no stored generated column needs computing.
 */
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { nominal } from "#compiler/core/brand.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { Assignment, Expr } from "#compiler/sql/ast.ts"
import { col } from "#compiler/sql/build.ts"

declare const assignmentsBrand: unique symbol
/** An UPDATE's SET list, built by `assignments` alone: its own assignments, then its table's anchor where they feed no
 * stored generated column. */
export type Assignments = NonEmptyReadonlyArray<Assignment> & { readonly [assignmentsBrand]: true }
const brand = nominal<NonEmptyReadonlyArray<Assignment>, Assignments>()

/** A stored generated column of a table: the columns its expression reads, as PostgreSQL's pull_varattnos finds them,
 * and its expression's size, the nodes it evaluates for a row. */
export interface StoredGenerated {
	readonly column: string
	readonly reads: ReadonlyArray<string>
	readonly size: number
}

/** An assignable column some stored generated column reads, with what an UPDATE that assigns it alone recomputes on each
 * row: those stored generated columns, by name, and their summed size. */
export interface GenerationAnchor {
	readonly column: string
	readonly recomputes: NonEmptyReadonlyArray<string>
	readonly cost: number
}

/**
 * What an UPDATE of a table meets of its stored generated columns: none; or the columns they read, which an UPDATE
 * assigning any of them meets as PostgreSQL keeps its expressions, with the anchor an UPDATE assigning none of them
 * assigns too, or none where no assignable column feeds one.
 */
export type TableGeneration =
	| { readonly kind: "none" }
	| {
			readonly kind: "stored"
			readonly feeds: ReadonlySet<string>
			readonly anchor: GenerationAnchor | undefined
	  }

/** A table with no stored generated column: grizzle's own ledger, and each table of a relation that has none. */
export const ungenerated: TableGeneration = Object.freeze({ kind: "none" })

/**
 * A table's generation from its stored generated columns: the columns they read, and the anchor, the column for which
 * the readers' summed size is least, then their number, then its name, among the columns `assignable` admits.
 */
export const tableGeneration = (
	generated: ReadonlyArray<StoredGenerated>,
	assignable: (column: string) => boolean
): TableGeneration => {
	if (generated.length === 0) {
		return ungenerated
	}
	const readers = new Map<string, Array<StoredGenerated>>()
	for (const g of generated) {
		for (const column of new Set(g.reads)) {
			readers.getOrInsertComputed(column, () => []).push(g)
		}
	}
	let anchor: GenerationAnchor | undefined
	for (const [column, of] of [...readers].toSorted(([a], [b]) => compareStrings(a, b))) {
		const [first, ...rest] = of
		if (first === undefined || !assignable(column)) {
			continue
		}
		const candidate: GenerationAnchor = {
			column,
			recomputes: [first.column, ...rest.map((g) => g.column)],
			cost: of.reduce((sum, g) => sum + g.size, 0)
		}
		if (
			anchor === undefined ||
			candidate.cost < anchor.cost ||
			(candidate.cost === anchor.cost && candidate.recomputes.length < anchor.recomputes.length)
		) {
			anchor = candidate
		}
	}
	return Object.freeze({ kind: "stored", feeds: new Set(readers.keys()), anchor })
}

/**
 * The anchor an UPDATE of a table of `generation` that assigns `columns` assigns too: its table's, where none of
 * `columns` feeds a stored generated column; none where one does, or where the table has no stored generated column or
 * no anchor.
 */
export const anchorFor = (
	generation: TableGeneration,
	columns: ReadonlyArray<string>
): GenerationAnchor | undefined =>
	generation.kind === "none" || columns.some((c) => generation.feeds.has(c))
		? undefined
		: generation.anchor

/**
 * The SET list of an UPDATE of a table of `generation` whose target is `target` (its alias, or the table's name where
 * it has none): `set`, then its anchor assigned its own value (`anchorFor`).
 */
export const assignments = (
	generation: TableGeneration,
	target: string,
	set: NonEmptyReadonlyArray<Assignment>
): Assignments => {
	const anchor = anchorFor(
		generation,
		set.map((a) => a.column)
	)
	return anchor === undefined
		? brand(set)
		: brand([...set, { column: anchor.column, value: col(target, anchor.column) }])
}

/** `list` with each value as `f` maps it, the same list where no value changes: it assigns the same columns, so it meets
 * its table's generation as `list` does (sql/transform.ts). */
export const mapValues = (list: Assignments, f: (value: Expr) => Expr): Assignments => {
	const out = mapNonEmpty(list, (a): Assignment => {
		const value = f(a.value)
		return value === a.value ? a : { ...a, value }
	})
	return out.every((a, i) => a === list[i]) ? list : brand(out)
}
