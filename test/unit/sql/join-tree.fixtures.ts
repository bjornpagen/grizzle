/**
 * What the join tree's property reads (join-tree.test.ts): its space of levels, each a FROM of CTE scans and LATERAL
 * derived tables over one CTE with the clauses between them, the statement the binding binds of one, and the
 * specification of the links, the lateral reads and the equivalence classes PostgreSQL makes of it, each its own
 * implementation, read off the drawn level alone.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { Expr, FromSource, Select } from "#compiler/sql/ast.ts"
import {
	and,
	binary,
	col,
	core,
	cteRefAs,
	derived,
	eq,
	keyedSet,
	lit,
	operandSelect,
	param,
	select,
	table,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"

/** What a case of the property reaches. */
export type TreeFeature =
	| "a level linked left-deep in its FROM's order"
	| "an entry reading one no entry before it is linked to, joined in a group"
	| "entries linked to nothing before them, a cross product"
	| "a level past join_collapse_limit, nested"
	| "a set join keyed by a class of no fixed value, hashed"
	| "a set join whose classes each hold a fixed value, a nested loop"
	| "a group on a join's inner side reading the entries before it, a nested loop"

export const treeFeatures = [
	"a level linked left-deep in its FROM's order",
	"an entry reading one no entry before it is linked to, joined in a group",
	"entries linked to nothing before them, a cross product",
	"a level past join_collapse_limit, nested",
	"a set join keyed by a class of no fixed value, hashed",
	"a set join whose classes each hold a fixed value, a nested loop",
	"a group on a join's inner side reading the entries before it, a nested loop"
] as const satisfies ReadonlyArray<Reached<TreeFeature>>

/** The two columns every entry delivers, the CTE's. */
const columns = ["x", "y"] as const
type Column = (typeof columns)[number]

/**
 * A clause of the level between two entries, `from` before `to`, at a column of each: an equality, or an order, `<`,
 * which no class holds. Where `to` is a LATERAL derived table the binding moves the clause into it, a lateral read of
 * `from`; else it stays the level's.
 */
export interface Clause {
	readonly from: number
	readonly to: number
	readonly fromColumn: Column
	readonly toColumn: Column
	readonly equal: boolean
}

/** A CTE scan's column fixed by its equality with a parameter, which stays the level's. */
export interface Fixed {
	readonly at: number
	readonly column: Column
}

/** A level: its entries, each a CTE scan (`scan`) or a LATERAL derived table over the CTE (`lateral`), in FROM order;
 * its clauses; its fixed columns. */
export interface TreeCase {
	readonly entries: ReadonlyArray<"scan" | "lateral">
	readonly clauses: ReadonlyArray<Clause>
	readonly fixed: ReadonlyArray<Fixed>
}

/**
 * A level of one to twelve entries, past join_collapse_limit for one in three, each a CTE scan or a LATERAL derived
 * table, up to twice its entries' count of clauses between drawn pairs, three in four of them equalities, and up to
 * three CTE scans' columns fixed.
 */
export const treeCaseGen: Gen<TreeCase> = (source) => {
	const n = source.draw(boolean) ? source.draw(int(1, 6)) : source.draw(int(7, 12))
	const entries = Array.from({ length: n }, () =>
		source.draw(element(["scan", "lateral"] as const))
	)
	const clauses =
		n < 2
			? []
			: source.draw(
					array(
						(s): Clause => {
							const a = s.draw(int(0, n - 1))
							const b = s.draw(int(0, n - 2))
							const [from, to] = b >= a ? [a, b + 1] : [b, a]
							return {
								from,
								to,
								fromColumn: s.draw(element(columns)),
								toColumn: s.draw(element(columns)),
								equal: s.draw(int(0, 3)) > 0
							}
						},
						{ min: 0, max: 2 * n }
					)
				)
	const scans = Arr.flatMap(entries, (k, at) => (k === "scan" ? [at] : []))
	const fixed = !Arr.isReadonlyArrayNonEmpty(scans)
		? []
		: source.draw(
				array((s): Fixed => ({ at: s.draw(element(scans)), column: s.draw(element(columns)) }), {
					min: 0,
					max: 3
				})
			)
	return { entries, clauses, fixed }
}

/** An entry's written alias. */
const entryAlias = (at: number): string => `e${at}`

/** A clause as the level states it. */
const clauseExpr = (c: Clause): Expr =>
	c.equal
		? eq(col(entryAlias(c.from), c.fromColumn), col(entryAlias(c.to), c.toColumn))
		: binary("<", col(entryAlias(c.from), c.fromColumn), col(entryAlias(c.to), c.toColumn))

/** A conjunction of `conjuncts`, none of none. */
const whereOf = (conjuncts: ReadonlyArray<Expr>): Expr | undefined => {
	const [first, ...rest] = conjuncts
	return first === undefined ? undefined : rest.length === 0 ? first : and([first, ...rest])
}

/**
 * The statement of a case: the MATERIALIZED CTE `c`, every row's a and b of T as x and y; each entry a scan of it, or a
 * LATERAL derived table of its scan fenced by OFFSET 0; every clause and every fixed column's equality with $1 a
 * conjunct of the level's WHERE.
 */
export const treeStatement = (c: TreeCase): Select => {
	const entry = (kind: "scan" | "lateral", at: number): FromSource =>
		kind === "scan"
			? cteRefAs("c", entryAlias(at))
			: derived(
					{
						...select(
							keyedSet(
								Arr.map(columns, (column) => targetAs(col(`q${at}`, column), column)),
								[cteRefAs("c", `q${at}`)],
								undefined,
								"an entry's rows of the CTE"
							)
						),
						offset: lit.int(0, types.bigint)
					},
					entryAlias(at),
					true
				)
	return {
		...select(
			keyedSet(
				[target(col(entryAlias(0), "x"))],
				Arr.map(c.entries, entry),
				whereOf([
					...Arr.map(c.clauses, clauseExpr),
					...Arr.map(c.fixed, (f) => eq(col(entryAlias(f.at), f.column), param(1, types.integer)))
				]),
				"a level of the CTE's scans"
			)
		),
		with: {
			recursive: false,
			ctes: [
				{
					name: "c",
					materialized: "MATERIALIZED",
					query: operandSelect(
						core(
							[targetAs(col("t", "a"), "x"), targetAs(col("t", "b"), "y")],
							[table("app", "t", "t")],
							undefined
						)
					)
				}
			]
		}
	}
}

/**
 * What PostgreSQL's join search reads of a level, by its entries' places (the specification, read off the case):
 * each entry's lateral reads, the clauses moved into it; its links, a lateral read either way, a clause the level
 * keeps reading both, or a class of its equalities holding a member of each; and the classes, each with the entries
 * its members read and whether it holds a fixed value.
 */
export interface LevelFacts {
	readonly reads: ReadonlyArray<ReadonlySet<number>>
	readonly linked: ReadonlyArray<ReadonlySet<number>>
	readonly classes: ReadonlyArray<{
		readonly entries: ReadonlySet<number>
		readonly fixed: boolean
	}>
}

export const levelFacts = (c: TreeCase): LevelFacts => {
	const n = c.entries.length
	const kept = Arr.filter(c.clauses, (cl) => c.entries[cl.to] === "scan")
	const reads = Arr.map(
		c.entries,
		(_, at) =>
			new Set(
				Arr.flatMap(c.clauses, (cl) =>
					cl.to === at && c.entries[at] === "lateral" ? [cl.from] : []
				)
			)
	)
	const parent = new Map<string, string>()
	const find = (k: string): string => {
		const p = parent.get(k)
		return p === undefined || p === k ? k : find(p)
	}
	const unite = (a: string, b: string): void => {
		const [ra, rb] = [find(a), find(b)]
		if (ra !== rb) {
			parent.set(ra, rb)
		}
	}
	const member = (at: number, column: Column): string => `${at}.${column}`
	for (const cl of kept) {
		if (cl.equal) {
			unite(member(cl.from, cl.fromColumn), member(cl.to, cl.toColumn))
		}
	}
	for (const f of c.fixed) {
		unite(member(f.at, f.column), "fixed")
	}
	const members: ReadonlyArray<readonly [number, Column]> = [
		...Arr.flatMap(kept, (cl): ReadonlyArray<readonly [number, Column]> =>
			cl.equal
				? [
						[cl.from, cl.fromColumn],
						[cl.to, cl.toColumn]
					]
				: []
		),
		...Arr.map(c.fixed, (f): readonly [number, Column] => [f.at, f.column])
	]
	const byRoot = new Map<string, Set<number>>()
	for (const [at, column] of members) {
		byRoot.getOrInsertComputed(find(member(at, column)), () => new Set<number>()).add(at)
	}
	const classes = Arr.map([...byRoot], ([root, entries]) => ({
		entries,
		fixed: root === find("fixed")
	}))
	const linked = Array.from({ length: n }, () => new Set<number>())
	const link = (a: number, b: number): void => {
		if (a !== b) {
			linked[a]?.add(b)
			linked[b]?.add(a)
		}
	}
	for (const [at, r] of reads.entries()) {
		for (const p of r) {
			link(p, at)
		}
	}
	for (const cl of kept) {
		link(cl.from, cl.to)
	}
	for (const k of classes) {
		for (const a of k.entries) {
			for (const b of k.entries) {
				link(a, b)
			}
		}
	}
	return { reads, linked, classes }
}
