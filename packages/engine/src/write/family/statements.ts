/**
 * A family member relation's rows as the family statements write them (write/family/additions.ts, removals.ts): its
 * row layout (`rowLayout`), the families it is a member of, an owner's end fields, and an INSERT's gate of the rows it
 * places (`candidateGate`).
 */
import type { StoredRelationName } from "#compiler/core/ids.ts"
import { defined } from "#compiler/core/invariant.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Family } from "#compiler/ir/family.ts"
import {
	type LawField,
	type NativeColumn,
	type RelationInfo,
	type ColumnKey,
	columnKey,
	columnKeyOf
} from "#compiler/ir/law.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { LaidColumn, LaidLayout } from "#compiler/runtime/write/nesting.ts"
import type { Cte, Expr } from "#compiler/sql/ast.ts"
import type { NameSupply } from "#compiler/sql/naming.ts"
import { fieldColumns } from "#compiler/write/defined.ts"
import type { WriteContext } from "#compiler/write/insert/statement.ts"
import {
	buildProbe,
	type Probed,
	probeGuard,
	type RelationUniques,
	type Requested
} from "#compiler/write/insert/unique.ts"

/**
 * A column of a member relation's row layout: its native column, its key, its type, whether an update sets it, and
 * whether it is a copy of an owner's count, which only a refill sets.
 */
export interface RowColumn {
	readonly column: NativeColumn
	readonly key: ColumnKey
	readonly type: ScalarType
	/** An update in place leaves the key, every group field and every copy of an owner's count: a move between groups
	 * is a delete and an insert, and the owner axes cascade the counts. */
	readonly settable: boolean
	readonly copy: boolean
}

/**
 * A member relation's rows as every family statement writes them (draw.ts Row): its key fields, in key order; then
 * every other column the host writes, its caller's, serial, drawn and accumulated fields in its field order, and then,
 * for each family it is a member of, in the law model's order, its drawn law columns: a counted index ‹i›, ‹n›, a
 * tree's ‹ps›, and each fold's hidden accumulators, by fold and plane, the before then the after. A generated field is
 * PostgreSQL's, so none is listed.
 */
export interface RowLayout {
	readonly relation: StoredRelationName
	readonly key: NonEmptyReadonlyArray<RowColumn>
	readonly columns: ReadonlyArray<RowColumn>
}

/** A row layout as a binding holds it (`LaidLayout`), each column projected to what binding reads of it. */
export const laidLayout = (layout: LaidLayout): LaidLayout => {
	const laid = (c: LaidColumn): LaidColumn => ({
		key: c.key,
		type: c.type,
		column:
			c.column.kind === "field"
				? { kind: "field", field: { name: c.column.field.name } }
				: { kind: "law", column: c.column.column }
	})
	return {
		relation: layout.relation,
		key: mapNonEmpty(layout.key, laid),
		columns: layout.columns.map(laid)
	}
}

/** The families `relation` is a member of, in the law model's order. */
export const memberFamilies = (
	relation: string,
	families: ReadonlyArray<Family>
): ReadonlyArray<Family> => families.filter((f) => f.member.name === relation)

/**
 * The row layout of `relation` over the law model's `families` (`RowLayout`): its primary key's fields, its other
 * written fields, and each law column its families draw on it, each of the type its family gives it: a counted index
 * and ‹n› the count's, a tree's ‹ps› its start's, a hidden accumulator its plane's end's.
 */
export const rowLayout = (relation: RelationInfo, families: ReadonlyArray<Family>): RowLayout => {
	const mine = memberFamilies(relation.name, families)
	const groups = new Set(mine.flatMap((f) => f.group.map((g) => columnKeyOf(g.member.name))))
	const copies = new Set(mine.map((f) => columnKeyOf(f.copy)))
	const of = (column: NativeColumn, type: ScalarType): RowColumn => {
		const key = columnKey(column)
		const copy = copies.has(key)
		return { column, key, type, settable: !groups.has(key) && !copy, copy }
	}
	const keyNames = new Set(relation.primaryFields.map((f) => f.name))
	const fields = relation.fields.flatMap((f) =>
		f.writing.kind === "generated" || keyNames.has(f.name)
			? []
			: [of({ kind: "field", field: f }, f.type)]
	)
	const law = mine.flatMap((f): ReadonlyArray<RowColumn> => [
		...(f.index.kind === "law" ? [of(f.index, f.count.type)] : []),
		of({ kind: "law", column: f.copy }, f.count.type),
		...f.folds.flatMap((fold) =>
			fold.planes.flatMap((plane) =>
				[plane.before, plane.after].flatMap((c) =>
					c.kind === "law" ? [of(c, plane.end.type)] : []
				)
			)
		)
	])
	const keyColumns = mapNonEmpty(relation.primaryFields, (f) => ({
		column: { kind: "field", field: f } as const,
		key: columnKey({ kind: "field", field: f }),
		type: f.type,
		settable: false,
		copy: false
	}))
	return Object.freeze({ relation: relation.name, key: keyColumns, columns: [...fields, ...law] })
}

/**
 * The owner's end fields a family's recount sets beside its count: every accumulated field of the owner its family's
 * last axis carries, a fold's ends among them, in the order the axis carries them.
 */
export const endColumns = (family: Family): ReadonlyArray<LawField> => {
	const out: Array<LawField> = []
	for (const pair of family.axes.last) {
		const from = pair.from
		if (
			from.kind === "field" &&
			from.field.writing.kind === "accumulated" &&
			!out.some((f) => f.name === from.field.name)
		) {
			out.push(from.field)
		}
	}
	return out
}

/** A member relation's rows as a CTE of each column of its row layout, key first, in layout order (`RowLayout`). */
export interface LaidRows {
	readonly name: string
	readonly columns: NonEmptyReadonlyArray<string>
}

/**
 * A member relation's INSERT as its gate reads it: its relation, its row layout, its unique objects, and the key it
 * arbitrates: its primary key, ON CONFLICT at which meets an exact repeat and the key's conflict witness
 * (write/family/additions.ts insertOf); or none, a plain INSERT of rows no stored row repeats.
 */
interface GatedInsert {
	readonly relation: RelationInfo
	readonly layout: RowLayout
	readonly uniques: RelationUniques
	readonly arbiter: "primaryKey" | "none"
}

/**
 * The gate of a member relation's INSERT of `candidates`: the probe (write/insert/unique.ts buildProbe) of the
 * candidates under the statement's snapshot at every unique object the INSERT does not arbitrate, every other one where
 * it arbitrates its primary key, for a candidate whose key no stored row holds (Requested `complete`), and every one,
 * the primary key first, where it arbitrates none (Requested `none`); and the refusal guard that raises the probe's
 * refusal (probeGuard), none where it probes nothing. As every insert of the insert protocol probes each unique object
 * besides its arbiter, a stated row that meets one, a stored occupant or another candidate, is refused by the object's
 * law, its witness the row's values at the object's fields (witnessFields), never by PostgreSQL's 23505, which names no
 * row. The candidates are drawn on the host and in the statement (a tree's starts, a sequence's indexes), which no host
 * check of a pair within an input reads, so a pair is the statement's at every object. A 23505 or 23P01 the INSERT still
 * raises at a probed object is an occupant its snapshot did not see; one at an object over a drawn law column, which no
 * field names and the scans draw apart, is no stated row's.
 */
export const candidateGate = (
	w: WriteContext,
	supply: NameSupply,
	insert: GatedInsert,
	candidates: LaidRows
): { readonly ctes: ReadonlyArray<Cte>; readonly guards: ReadonlyArray<Expr> } => {
	const { relation, layout, uniques } = insert
	const columns = [...layout.key, ...layout.columns]
	const fields = relation.fields.filter((f) => f.writing.kind !== "generated")
	const inputs = fieldColumns(fields, (f) =>
		defined(
			candidates.columns[
				columns.findIndex((c) => c.column.kind === "field" && c.column.field.name === f.name)
			],
			`the candidate column of ${relation.name}.${f.name}`
		)
	)
	const probed: { readonly requested: Requested; readonly checks: ReadonlyArray<Probed> } =
		insert.arbiter === "primaryKey"
			? { requested: { kind: "complete", arbiter: uniques.arbiter }, checks: uniques.checks }
			: {
					requested: { kind: "none", fields },
					checks: [
						{ object: uniques.arbiter, pairs: "statement", witness: "every" },
						...uniques.checks
					]
				}
	const probe = buildProbe(w, supply, {
		relation,
		...probed,
		input: candidates.name,
		inputs,
		normalized: false,
		occupants: "probed"
	})
	if (probe === undefined) {
		return { ctes: [], guards: [] }
	}
	const guarded = probeGuard(w, supply, relation.name, probe)
	return { ctes: [...probe.ctes, guarded.cte], guards: [guarded.guard] }
}
