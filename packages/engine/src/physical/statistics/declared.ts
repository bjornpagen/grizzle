import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { compareStrings } from "#compiler/core/order.ts"
import { type Bound, exponentsOf } from "#compiler/physical/statistics/exponents.ts"
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
 * - an anchor (`anchorsOf`), a column of many values the schema scopes rows by: PostgreSQL is told a relative number of
 *   distinct values, -1/2^y, so each value holds 2^y rows at any size of the table. The first field of many values of a
 *   unit's key is the anchor of the unit's every member, the unit holding 2^y rows (a unit's key alone is no key: a
 *   unit holds more than one row); then the first column of many values of the primary key and of each other key, its
 *   scope, which a key needs to bind one row at any size; then each column of many values the relation's containments
 *   prove determines one of those (RelationShape `determined`), which binds no more rows than what it determines; and,
 *   in a relation in no unit, which states no scope of its rows' growth, the first column of many values of each index.
 *   Each is taken where no set apart would hold two anchors, whose product PostgreSQL prices below one row at any size
 *   worth planning. A key of one column is an anchor of exponent 0, unique. In a unit's member no other column is one,
 *   however many indexes it leads: a member's rows are its units', so many units over so many rows a unit, and a column
 *   no fact binds to a unit recurs across the units, as metis's package, an item's content coordinate, recurs under
 *   every child, so what an equality on it alone binds grows with the units, a share of the table. Where the first
 *   column of a member's index was taken as an anchor, metis's processed_attempt, keyed (child, package, path, n, at),
 *   declared package at 2 rows a value for its index (package, path, n, child), and PostgreSQL read a probe binding the
 *   whole key through that index's prefix (package, path, n), priced at one row, and filtered child after: every
 *   child's rows at the item, 41,208 for each of the 34 probes of metis's submit at 45785e7c9, where the key reads one;
 * - a pair of anchors one set apart holds together: a dependency of the later on the earlier is declared
 *   (DeclaredDependency), so PostgreSQL prices the pair at 2^m rows at any size of the table, m ≥ 1 its own exponent,
 *   which every set apart holding it bounds as an anchor's, where two independent anchors multiply below one row;
 * - a column of one value: a field of a unit's key after its anchor, the unit's count of rows sitting on the anchor,
 *   since PostgreSQL multiplies the fields as independent, and a roster's of one handle. A set holds a key where it
 *   holds every column of one but these;
 * - every other column: 2^x values, x ≥ 1, so each column a set binds at least halves its rows. A roster of k handles
 *   holds at most k values, so 2^x ≤ k; a boolean holds 2.
 * Each bound is PostgreSQL's own independence product over the exact columns the set holds, a generated column and the
 * columns it is computed from together, so a set that binds both is priced as PostgreSQL prices it. The exponents are
 * the integers a raise from all ones reaches (physical/statistics/exponents.ts): a key holding two anchors binds at most one
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
 * A functional dependency of one column of a relation on another, which a containment of the relation proves: where its
 * columns are contained in another relation at fields holding a key of one field of that relation, the column paired
 * with the key determines every column paired with the rest, as metis's assignment (user, child), contained in
 * person_user (number, person) keyed by number, has user determine child.
 */
export interface Determined {
	readonly determinant: string
	readonly dependent: string
}

/**
 * A relation's shape as its declaration reads it: its columns, each by its text (physical/indexes/engine.ts
 * keyTermText) and what it holds; the fields holding its unit's key, none where it sits in no unit; its keys, each by
 * its columns; its indexes, each by the columns its equalities may bind in key order, cut before a key no equality
 * reads; every binding a statement of the installation makes of it; and the dependencies of one column on another its
 * containments prove.
 */
export interface RelationShape {
	readonly relation: string
	readonly columns: ReadonlyArray<{ readonly column: string; readonly values: ColumnValues }>
	readonly unit: ReadonlyArray<string>
	readonly keys: ReadonlyArray<ReadonlyArray<string>>
	readonly indexes: ReadonlyArray<ReadonlyArray<string>>
	readonly bindings: ReadonlyArray<Binding>
	readonly determined: ReadonlyArray<Determined>
}

/** One bound of a refusal as it reads: a key, a pair a dependency ties, which binds two rows or more, or a set an
 * index's equalities stop at short of the binding that stops there. */
export type CrossingBound =
	| { readonly kind: "key"; readonly columns: ReadonlyArray<string> }
	| { readonly kind: "pair"; readonly columns: readonly [string, string] }
	| {
			readonly kind: "apart"
			readonly columns: ReadonlyArray<string>
			readonly binding: Binding
	  }

/**
 * A relation's declaration: each column's number of distinct values, in the shape's column order; or no number of
 * distinct values ranks its statements' access paths: `crossing`, bounds that no exponents meet together, by their proof
 * (a key whose columns a set apart covers, or keys crossed by sets whose differences sum to no column, exponents.ts);
 * `unsettled`, bounds grizzle's raise did not meet within its rounds, a limitation of grizzle's; or `beyondValues`, the
 * raised exponents asking a column for more values than its type holds.
 */
export type Declaration =
	| {
			readonly kind: "declared"
			readonly columns: ReadonlyArray<{
				readonly column: string
				readonly distinct: DeclaredDistinct
			}>
			readonly dependencies: ReadonlyArray<DeclaredDependency>
	  }
	| { readonly kind: "crossing"; readonly bounds: NonEmptyReadonlyArray<CrossingBound> }
	| { readonly kind: "unsettled"; readonly bounds: NonEmptyReadonlyArray<CrossingBound> }
	| {
			readonly kind: "beyondValues"
			readonly column: string
			readonly exponent: number
			readonly handles: number
	  }

/**
 * A dependency declared between two anchors a set apart holds together (`anchorsOf`): the determinant `determinant`
 * functionally determines `dependent` to the degree 1/2^`exponent`, so PostgreSQL prices a set holding both at
 * P(determinant) · (d + (1 − d) · P(dependent)) (dependencies.c dependencies_clauselist_selectivity), 2^y · 2^(m−y)
 * = 2^m rows at any size of the table, y the determinant's exponent and m ≥ 1 the pair's, at most y, so the degree is
 * at most 1: the exponent is y − m.
 */
export interface DeclaredDependency {
	readonly determinant: string
	readonly dependent: string
	readonly exponent: number
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
 * The anchors of a relation, and the pairs of them a dependency ties: its unit's anchor, then the first column of many
 * values of its primary key and of each other key, then each column of many values a containment proves determines one
 * taken (RelationShape `determined`), and, in a relation in no unit, the first column of many values of each index, in
 * that order, each taken where every set apart holding it holds no anchor taken before, or holds exactly one, `a`: then
 * the two are a pair (DeclaredDependency), which binds 2^m rows at any size, m its own exponent, as two independent
 * anchors could not (PostgreSQL would multiply them below one row). So every set apart holds one anchor or one pair,
 * and its rows stand at any size of the table: metis's assignment, whose `user` leads four indexes beside the anchor
 * `child` of its key (child, number) and determines child by its containment in person_user (number, person), is priced
 * at two rows a user where e2abf18f2, pairing none, priced it at half the table. An index is no anchor's source (see
 * the module's doc): metis's test_presented, keyed (child, stage, at), whose stage leads index (stage, package, child),
 * declares stage a share of the table, as 56851404d did; the 13.7 s its submit took then (plan-08) was a read of
 * test_presented binding package and stage with no child, priced at 357,994 rows and read 42,121 times over, which no
 * declaration makes local, and its every probe since binds child. An anchor may be in several pairs, and no set apart
 * holds two of them: PostgreSQL applies a dependency only to a set holding all its columns (dependencies.c
 * dependency_is_compatible_clause), so one dependency at most applies to any set. A column of few values is never one:
 * it holds no more values than its handles at any size. A key holding none is priced at one row by its own unique index
 * alone; a set apart holding none binds the more rows the larger the table. PostgreSQL applies a dependency to a set of
 * one relation's columns alone (clausesel.c find_single_rel_for_clauses), so a join's probe of a pair multiplies them.
 */
const anchorsOf = (
	shape: RelationShape,
	apart: ReadonlyArray<{ readonly columns: ReadonlyArray<string> }>,
	single: ReadonlySet<string>,
	unitAnchor: string | undefined
): {
	readonly anchors: ReadonlyArray<string>
	readonly pairs: ReadonlyArray<readonly [string, string]>
} => {
	const many = new Set(
		shape.columns.flatMap((c) =>
			c.values.kind === "many" && !single.has(c.column) ? [c.column] : []
		)
	)
	const firstOf = (cols: ReadonlyArray<string>): ReadonlyArray<string> => {
		const first = cols.find((c) => many.has(c))
		return first === undefined ? [] : [first]
	}
	const taken: Array<string> = []
	const pairs: Array<readonly [string, string]> = []
	const admit = (c: string): void => {
		if (taken.includes(c)) {
			return
		}
		const sharers = new Set<string>()
		const admitted =
			c === unitAnchor ||
			apart.every((p) => {
				if (!p.columns.includes(c)) {
					return true
				}
				const [only, ...more] = p.columns.filter((o) => taken.includes(o))
				if (only === undefined) {
					return true
				}
				sharers.add(only)
				return more.length === 0
			})
		if (admitted && sharers.size <= 1) {
			taken.push(c)
			for (const a of sharers) {
				pairs.push([a, c])
			}
		}
	}
	for (const c of [
		...(unitAnchor === undefined ? [] : [unitAnchor]),
		...shape.keys.flatMap(firstOf)
	]) {
		admit(c)
	}
	for (const d of shape.determined) {
		if (many.has(d.determinant) && taken.includes(d.dependent)) {
			admit(d.determinant)
		}
	}
	if (shape.unit.length === 0) {
		for (const c of shape.indexes.flatMap(firstOf)) {
			admit(c)
		}
	}
	return { anchors: taken, pairs }
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
	const { anchors, pairs } = anchorsOf(shape, apart, single, unitAnchor)
	/** The position of the pair a set's anchors are, where they are exactly one, or -1. */
	const pairOf = (held: ReadonlyArray<string>): number =>
		held.length === 2 ? pairs.findIndex(([a, b]) => held.includes(a) && held.includes(b)) : -1
	const free = shape.columns
		.map((c) => c.column)
		.filter((c) => !anchors.includes(c) && !single.has(c))
		.toSorted(compareStrings)
	const anchorOf = new Map(anchors.map((a, i) => [a, i]))
	const freeOf = new Map(free.map((c, i) => [c, i]))

	const bounds: Array<Bound> = []
	const meaning: Array<CrossingBound> = []
	/**
	 * A bound over `cols`, held by one anchor or by a pair, which the raise reads as an anchor of its own placed after the
	 * anchors (exponents.ts). A set apart holding a pair bounds its determinant as well, whose exponent is at least the
	 * pair's: a dependency's degree, 2^(m − y), is at most 1.
	 */
	const place = (
		kind: Bound["kind"],
		cols: ReadonlyArray<string>,
		by:
			| { readonly kind: "anchor"; readonly anchor: string }
			| { readonly kind: "pair"; readonly at: number },
		said: CrossingBound
	): void => {
		const columns = cols.flatMap((c) => {
			const at = freeOf.get(c)
			return at === undefined ? [] : [at]
		})
		const anchor = (name: string): number => defined(anchorOf.get(name), "an anchor's place")
		if (by.kind === "anchor") {
			bounds.push({ kind, anchor: anchor(by.anchor), columns })
			meaning.push(said)
			return
		}
		bounds.push({ kind, anchor: anchors.length + by.at, columns })
		meaning.push(said)
		if (kind === "apart") {
			const [determinant] = defined(pairs[by.at], "a pair")
			bounds.push({ kind, anchor: anchor(determinant), columns })
			meaning.push(said)
		}
	}
	for (const anchor of anchors) {
		if (isKey([anchor])) {
			place("key", [], { kind: "anchor", anchor }, { kind: "key", columns: [anchor] })
		} else {
			place(
				"apart",
				[],
				{ kind: "anchor", anchor },
				{
					kind: "apart",
					columns: [anchor],
					binding: { columns: [anchor], by: `${anchor} alone, which is no key` }
				}
			)
		}
	}
	for (const [at, [a, b]] of pairs.entries()) {
		place("apart", [], { kind: "pair", at }, { kind: "pair", columns: [a, b] })
	}
	for (const key of shape.keys) {
		const held = key.filter((c) => anchors.includes(c))
		const [only, ...more] = held
		const pair = pairOf(held)
		if (only !== undefined && more.length === 0) {
			place("key", key, { kind: "anchor", anchor: only }, { kind: "key", columns: key })
		} else if (pair >= 0) {
			place("key", key, { kind: "pair", at: pair }, { kind: "key", columns: key })
		}
	}
	for (const p of apart) {
		const held = p.columns.filter((c) => anchors.includes(c))
		const [only, ...more] = held
		const pair = pairOf(held)
		if (only !== undefined && more.length === 0) {
			place(
				"apart",
				p.columns,
				{ kind: "anchor", anchor: only },
				{ kind: "apart", columns: p.columns, binding: p.binding }
			)
		} else if (pair >= 0) {
			place(
				"apart",
				p.columns,
				{ kind: "pair", at: pair },
				{ kind: "apart", columns: p.columns, binding: p.binding }
			)
		}
	}

	const raised = exponentsOf({
		anchors: anchors.length + pairs.length,
		columns: free.length,
		bounds
	})
	if (raised.kind !== "exponents") {
		const [first, ...rest] = raised.bounds.map((i) => defined(meaning[i], "a bound's meaning"))
		return { kind: raised.kind, bounds: [defined(first, "a refused bound"), ...rest] }
	}
	for (const [c, exponent] of free.map(
		(col, i) => [col, defined(raised.columns[i], "an exponent")] as const
	)) {
		const v = values.get(c)
		if (v?.kind === "few" && 2 ** exponent > v.handles) {
			return { kind: "beyondValues", column: c, exponent, handles: v.handles }
		}
	}
	return {
		kind: "declared",
		dependencies: pairs.map(([determinant, dependent], at) => ({
			determinant,
			dependent,
			exponent:
				defined(
					raised.anchors[defined(anchorOf.get(determinant), "a determinant's place")],
					"its exponent"
				) - defined(raised.anchors[anchors.length + at], "the pair's exponent")
		})),
		columns: shape.columns.map(({ column }) => {
			const anchor = anchorOf.get(column)
			if (anchor !== undefined) {
				return {
					column,
					distinct: {
						kind: "relative",
						exponent: defined(raised.anchors[anchor], "an anchor's exponent")
					}
				}
			}
			const at = freeOf.get(column)
			return {
				column,
				distinct: {
					kind: "absolute",
					exponent: at === undefined ? 0 : defined(raised.columns[at], "a column's exponent")
				}
			}
		})
	}
}

/**
 * The declared statistics of one of grizzle's bookkeeping tables (deploy/ledger/ledger.ts bookkeepingTables), which no
 * schema declares, as every table grizzle installs holds them: its columns, each of many values, its primary key its
 * one key and index, and the key's probe its one binding. One key crosses nothing and sets nothing apart, so it is
 * always declared, with no dependency.
 */
export const bookkeepingDeclaration = (create: CreateTable): DeclareStatistics => {
	const key = create.primaryKey.columns.map((c) => c.column)
	const declaration = declarationOf({
		relation: create.table.name,
		columns: create.columns.map((c) => ({ column: c.name, values: { kind: "many" } })),
		unit: [],
		keys: [key],
		indexes: [key],
		bindings: [{ columns: key, by: `the probe of key (${key.join(", ")})` }],
		determined: []
	})
	if (declaration.kind !== "declared" || declaration.dependencies.length > 0) {
		throw defect(
			`a bookkeeping table of one key, ${create.table.name}, is declared with no dependency`
		)
	}
	const distinct = new Map(declaration.columns.map((c) => [c.column, c.distinct] as const))
	return {
		kind: "declareStatistics",
		table: create.table,
		columns: mapNonEmpty(create.columns, (c) => ({
			column: c.name,
			distinct: defined(distinct.get(c.name), `the declared statistics of ${c.name}`)
		})),
		dependencies: []
	}
}
