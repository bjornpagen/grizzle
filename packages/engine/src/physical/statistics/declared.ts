import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { compareStrings } from "#compiler/core/order.ts"
import { type Bound, leastExponents } from "#compiler/physical/statistics/least.ts"
import type { CreateTable, DeclaredDistinct, DeclareStatistics } from "#compiler/sql/ast.ts"

/**
 * A relation's declared statistics: what PostgreSQL is told of each column of its table in place of a sample, derived
 * from the schema's facts alone, so the planner ranks the access paths of every statement the installation compiles by
 * how much of a key each binds, at any size of the table, and no ANALYZE ever changes it (README "Declared statistics").
 *
 * PostgreSQL estimates a set of equalities over one table as independent (clausesel.c clauselist_selectivity): the rows
 * a set binds are the table's rows times each column's selectivity, 1/n_distinct for a column compared with a value it
 * does not know (selfuncs.c var_eq_non_const), and no extended statistics reach a probe whose comparison names a second
 * relation (clausesel.c find_single_rel_for_clauses). Where two index paths both price at one row, it keeps the one it
 * built first, the index of the highest OID (plancat.c get_relation_info, pathnode.c add_path), so a primary key, created
 * with its table, loses every tie. So the declaration states a number of distinct values for every column such that,
 * for every statement:
 * - a set of columns holding a key binds at most one row;
 * - a set at which an index's equalities stop short of the statement's binding, holding no key, binds two rows or more,
 *   strictly more than the binding: PostgreSQL then prices the index the statement's binding asks for below every
 *   index binding less of it.
 *
 * The columns are of three kinds:
 * - an anchor (`anchorsOf`), a column of many values: PostgreSQL is told a relative number of distinct values, -1/2^y,
 *   so each value holds 2^y rows at any size of the table. A unit's key leads every index of its members, and its first
 *   field of many values is the anchor of them all, the unit holding 2^y rows (a unit's key alone is no key: a unit
 *   holds more than one row); then the first column of many values of the primary key, of each other key and of each
 *   index, each where no set apart would hold two anchors, whose product PostgreSQL prices below one row at any size
 *   worth planning. A key of one column is an anchor of exponent 0, unique;
 * - a column of one value: a field of a unit's key after its anchor, the unit's count of rows sitting on the anchor,
 *   since PostgreSQL multiplies the fields as independent, and a roster's of one handle. A set holds a key where it
 *   holds every column of one but these;
 * - every other column: 2^x values, x ≥ 1, so each column a set binds at least halves its rows. A roster of k handles
 *   holds at most k values, so 2^x ≤ k; a boolean holds 2.
 * Each bound is PostgreSQL's own independence product over the exact columns the set holds, a generated column and the
 * columns it is computed from together, so a set that binds both is priced as PostgreSQL prices it. The exponents are
 * the least integers meeting every bound (physical/statistics/least.ts): a key holding two anchors binds at most one
 * row at any size worth planning and needs no bound; a key or a set apart holding none, of a relation whose indexes lead
 * by several columns, is priced by its unique index alone, or binds the more rows the larger the table.
 */

/** How many values a column may hold, by its type: any number, or at most `handles` (a roster's live handles, a
 * boolean's 2). */
export type ColumnValues =
	| { readonly kind: "many" }
	| { readonly kind: "few"; readonly handles: number }

/**
 * What a statement binds of a relation by equality, the column set an access path's index is asked for, and what binds
 * it: a key's probe, or a request by its use and its relation.
 */
export interface Binding {
	readonly columns: ReadonlyArray<string>
	readonly by: string
}

/**
 * A relation's shape as its declaration reads it: its columns, each by its text (physical/indexes/engine.ts
 * keyTermText) and what it holds; the fields holding its unit's key, none where it sits in no unit; its keys, each by
 * its columns; its indexes, each
 * by the columns its equalities may bind in key order, cut before a key no equality reads; and every binding a
 * statement of the installation makes of it.
 */
export interface RelationShape {
	readonly relation: string
	readonly columns: ReadonlyArray<{ readonly column: string; readonly values: ColumnValues }>
	readonly unit: ReadonlyArray<string>
	readonly keys: ReadonlyArray<ReadonlyArray<string>>
	readonly indexes: ReadonlyArray<ReadonlyArray<string>>
	readonly bindings: ReadonlyArray<Binding>
}

/** One bound of a refusal as it reads: a key, or a set an index's equalities stop at short of the binding that stops
 * there. */
export type CrossingBound =
	| { readonly kind: "key"; readonly columns: ReadonlyArray<string> }
	| {
			readonly kind: "apart"
			readonly columns: ReadonlyArray<string>
			readonly binding: Binding
	  }

/**
 * A relation's declaration: each column's number of distinct values, in the shape's column order; or no number of
 * distinct values ranks its statements' access paths: `crossing`, the least set of bounds that no exponents meet
 * together (keys whose columns the sets apart cover, as a pair of keys crossed by a pair of sets); or `beyondValues`, the least
 * exponents asking a column for more values than its type holds.
 */
export type Declaration =
	| {
			readonly kind: "declared"
			readonly columns: ReadonlyArray<{
				readonly column: string
				readonly distinct: DeclaredDistinct
			}>
	  }
	| { readonly kind: "crossing"; readonly bounds: NonEmptyReadonlyArray<CrossingBound> }
	| {
			readonly kind: "beyondValues"
			readonly column: string
			readonly exponent: number
			readonly handles: number
	  }

/** The leading run of an index's columns a binding holds: the columns its equalities bind of it. */
const boundPrefix = (
	index: ReadonlyArray<string>,
	binding: ReadonlySet<string>
): ReadonlyArray<string> => {
	const end = index.findIndex((c) => !binding.has(c))
	return end < 0 ? index : index.slice(0, end)
}

const sameSet = (a: ReadonlyArray<string>, b: ReadonlySet<string>): boolean =>
	a.length === b.size && a.every((c) => b.has(c))

/**
 * The sets a statement stops short at: for each binding, each index's leading run of the binding's columns that is
 * neither empty, nor the whole binding, nor holding a key.
 */
const apartSets = (
	shape: RelationShape,
	isKey: (cols: ReadonlyArray<string>) => boolean
): ReadonlyArray<{ readonly columns: ReadonlyArray<string>; readonly binding: Binding }> =>
	shape.bindings.flatMap((binding) => {
		const bound = new Set(binding.columns)
		return shape.indexes.flatMap((index) => {
			const prefix = boundPrefix(index, bound)
			return prefix.length === 0 || sameSet(prefix, bound) || isKey(prefix)
				? []
				: [{ columns: prefix, binding }]
		})
	})

/**
 * The anchors of a relation: its unit's anchor, then the first column of many values of its primary key, of each other
 * key and of each index, in that order, each taken where no set apart then holds two of them, so every set apart holds
 * one anchor at most and its rows stand at any size of the table. A column of few values is never one: it holds no more
 * values than its handles at any size. A key holding none is priced at one row by its own unique index alone; a set
 * apart holding none binds the more rows the larger the table.
 */
const anchorsOf = (
	shape: RelationShape,
	apart: ReadonlyArray<{ readonly columns: ReadonlyArray<string> }>,
	single: ReadonlySet<string>,
	unitAnchor: string | undefined
): ReadonlyArray<string> => {
	const many = new Set(shape.columns.flatMap((c) => (c.values.kind === "many" ? [c.column] : [])))
	const taken: Array<string> = []
	const candidates = [
		...(unitAnchor === undefined ? [] : [unitAnchor]),
		...[...shape.keys, ...shape.indexes].flatMap((cols) => {
			const first = cols.find((c) => many.has(c) && !single.has(c))
			return first === undefined ? [] : [first]
		})
	]
	for (const c of candidates) {
		if (taken.includes(c)) {
			continue
		}
		const admitted =
			c === unitAnchor ||
			apart.every(
				(p) => !p.columns.includes(c) || p.columns.every((other) => !taken.includes(other))
			)
		if (admitted) {
			taken.push(c)
		}
	}
	return taken
}

/** The declaration of a relation of `shape` (see the module's doc). */
export const declarationOf = (shape: RelationShape): Declaration => {
	const values = new Map(shape.columns.map((c) => [c.column, c.values]))
	/** The unit's anchor: the first field of its key of many values, on which the unit's count of rows sits. */
	const unitAt = shape.unit.findIndex((c) => values.get(c)?.kind === "many")
	const unitAnchor = unitAt < 0 ? undefined : shape.unit[unitAt]
	/** The columns of one value: the fields of the unit's key after its anchor, and a roster's of one handle. A set holds
	 * a key where it holds every other column of one. */
	const single = new Set([
		...(unitAt < 0 ? [] : shape.unit.slice(unitAt + 1)),
		...shape.columns.flatMap((c) =>
			c.values.kind === "few" && c.values.handles <= 1 ? [c.column] : []
		)
	])
	const isKey = (cols: ReadonlyArray<string>): boolean => {
		const held = new Set(cols)
		return shape.keys.some((k) => k.every((c) => held.has(c) || single.has(c)))
	}
	const apart = apartSets(shape, isKey)
	const anchors = anchorsOf(shape, apart, single, unitAnchor)
	const free = shape.columns
		.map((c) => c.column)
		.filter((c) => !anchors.includes(c) && !single.has(c))
		.toSorted(compareStrings)
	const anchorOf = new Map(anchors.map((a, i) => [a, i]))
	const freeOf = new Map(free.map((c, i) => [c, i]))

	const bounds: Array<Bound> = []
	const meaning: Array<CrossingBound> = []
	const place = (
		kind: Bound["kind"],
		cols: ReadonlyArray<string>,
		anchor: string,
		said: CrossingBound
	): void => {
		bounds.push({
			kind,
			anchor: defined(anchorOf.get(anchor), "an anchor's place"),
			columns: cols.flatMap((c) => {
				const at = freeOf.get(c)
				return at === undefined ? [] : [at]
			})
		})
		meaning.push(said)
	}
	for (const anchor of anchors) {
		if (isKey([anchor])) {
			place("key", [], anchor, { kind: "key", columns: [anchor] })
		} else {
			place("apart", [], anchor, {
				kind: "apart",
				columns: [anchor],
				binding: { columns: [anchor], by: `${anchor} alone, which is no key` }
			})
		}
	}
	for (const key of shape.keys) {
		const [only, ...more] = key.filter((c) => anchors.includes(c))
		if (only !== undefined && more.length === 0) {
			place("key", key, only, { kind: "key", columns: key })
		}
	}
	for (const p of apart) {
		const [only, ...more] = p.columns.filter((c) => anchors.includes(c))
		if (only !== undefined && more.length === 0) {
			place("apart", p.columns, only, { kind: "apart", columns: p.columns, binding: p.binding })
		}
	}

	const least = leastExponents({ anchors: anchors.length, columns: free.length, bounds })
	if (least.kind === "crossing") {
		const [first, ...rest] = least.bounds.map((i) => defined(meaning[i], "a bound's meaning"))
		return { kind: "crossing", bounds: [defined(first, "a crossing's bound"), ...rest] }
	}
	for (const [c, exponent] of free.map(
		(col, i) => [col, defined(least.columns[i], "an exponent")] as const
	)) {
		const v = values.get(c)
		if (v?.kind === "few" && 2 ** exponent > v.handles) {
			return { kind: "beyondValues", column: c, exponent, handles: v.handles }
		}
	}
	return {
		kind: "declared",
		columns: shape.columns.map(({ column }) => {
			const anchor = anchorOf.get(column)
			if (anchor !== undefined) {
				return {
					column,
					distinct: {
						kind: "relative",
						exponent: defined(least.anchors[anchor], "an anchor's exponent")
					}
				}
			}
			const at = freeOf.get(column)
			return {
				column,
				distinct: {
					kind: "absolute",
					exponent: at === undefined ? 0 : defined(least.columns[at], "a column's exponent")
				}
			}
		})
	}
}

/**
 * The declared statistics of one of grizzle's bookkeeping tables (deploy/ledger/ledger.ts bookkeepingTables), which no
 * schema declares, as every table grizzle installs holds them: its columns, each of many values, its primary key its
 * one key and index, and the key's probe its one binding. One key crosses nothing, so it is always declared.
 */
export const bookkeepingDeclaration = (create: CreateTable): DeclareStatistics => {
	const key = create.primaryKey.columns.map((c) => c.column)
	const declaration = declarationOf({
		relation: create.table.name,
		columns: create.columns.map((c) => ({ column: c.name, values: { kind: "many" } })),
		unit: [],
		keys: [key],
		indexes: [key],
		bindings: [{ columns: key, by: `the probe of key (${key.join(", ")})` }]
	})
	if (declaration.kind !== "declared") {
		throw defect(`a bookkeeping table of one key, ${create.table.name}, is declared`)
	}
	const distinct = new Map(declaration.columns.map((c) => [c.column, c.distinct] as const))
	return {
		kind: "declareStatistics",
		table: create.table,
		columns: mapNonEmpty(create.columns, (c) => ({
			column: c.name,
			distinct: defined(distinct.get(c.name), `the declared statistics of ${c.name}`)
		}))
	}
}
