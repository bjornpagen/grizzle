/** What seeks.test.ts reads: a stored table with drawn indexes, a read of it in a drawn shape, and the read's verdict. */

import { aimed, boolean, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { Holds, SeekIndex, SeekTable, SeekTargets } from "#compiler/physical/access/seeks.ts"
import {
	type CreateView,
	type Expr,
	type FromItem,
	type NameKey,
	nameKey,
	type SqlStatement
} from "#compiler/sql/ast.ts"
import {
	and,
	col,
	derived,
	distinctCore,
	eq,
	lit,
	operandSelect,
	provedCore,
	select,
	table,
	target,
	types
} from "#compiler/sql/build.ts"
import { seekView } from "#compiler/sql/seeks.ts"

/**
 * The table read, its schema, and the relations beside it: one keyed by `id`, one no index holds, and the views a role
 * reads them through, a plain one of the table, one behind a security barrier, and a plain one of the keyed table.
 */
const schema = "s"
const read = "t"
const keyed = "k"
const loose = "u"
const plainView = "tv"
const barrierView = "tb"
const keyedView = "kv"

/** The width of the keyed table beside the read one: its key `id` and one column for each the read table may have. */
const keyedWidth = 4

/**
 * How the read binds the table's columns: at literals (`direct`); at the columns of a row before it, read LATERAL
 * (`lateral`); at a literal over a DISTINCT derived table, which pushes the equality into its core (`pushed`); at the
 * columns of a table its key binds at a literal, one row (`oneRow`); at the columns of a table no index binds, a join
 * PostgreSQL orders by its estimates, which binds nothing (`joined`); at an uncorrelated sub-link's array, a value the
 * level fixes (`sublink`); at literals through a plain view PostgreSQL pulls up (`view`); at literals through a
 * security barrier, which a leaky equality does not pass (`barrier`); at the columns of the keyed table read through
 * its plain view at its key, one row (`viewOneRow`); or at literals over two reads of a CTE of the table's columns,
 * which the printer leaves a CTE where a statement reads it twice: NOT MATERIALIZED, PostgreSQL inlining it into each,
 * the equality reaching its core (`inlinedCte`), or MATERIALIZED, read once, whole, which binds nothing
 * (`materializedCte`).
 */
export type Shape =
	| "direct"
	| "lateral"
	| "pushed"
	| "oneRow"
	| "joined"
	| "sublink"
	| "view"
	| "barrier"
	| "viewOneRow"
	| "inlinedCte"
	| "materializedCte"

/**
 * A drawn case: what each column holds and whether its equality is leaky (a numeric's), the indexes over the columns,
 * the columns the read binds, and how.
 */
export interface SeekCase {
	readonly holds: ReadonlyArray<Holds>
	readonly leaky: ReadonlyArray<boolean>
	readonly indexes: ReadonlyArray<{
		readonly columns: ReadonlyArray<number>
		readonly unique: boolean
		readonly gist: boolean
	}>
	readonly bound: ReadonlyArray<number>
	readonly shape: Shape
}

const columnName = (at: number): string => `c${String(at)}`

/** The columns `count` of `columns`, drawn in a drawn order: a permutation's prefix. */
const orderedPrefix =
	(columns: ReadonlyArray<number>): Gen<ReadonlyArray<number>> =>
	(s) => {
		const left = [...columns]
		const out: Array<number> = []
		const count = s.draw(int(1, left.length))
		for (let i = 0; i < count; i++) {
			const [picked] = left.splice(s.draw(int(0, left.length - 1)), 1)
			if (picked !== undefined) {
				out.push(picked)
			}
		}
		return out
	}

const seekGen: Gen<SeekCase> = (s) => {
	const width = s.draw(int(2, 4))
	const holds = Array.from({ length: width }, () =>
		s.draw(
			weighted<Holds>([
				[4, () => "many"],
				[1, () => "few"],
				[1, () => "none"]
			])
		)
	)
	const leaky = Arr.map(
		holds,
		(h) =>
			h === "many" &&
			s.draw(
				weighted([
					[3, () => false],
					[1, () => true]
				])
			)
	)
	const columns = Array.from({ length: width }, (_, at) => at)
	const indexed = Arr.filter(columns, (at) => holds[at] !== "none")
	const indexes = Arr.isReadonlyArrayNonEmpty(indexed)
		? Array.from({ length: s.draw(int(1, 3)) }, () =>
				s.draw(
					weighted([
						[
							3,
							() => ({
								columns: s.draw(orderedPrefix(indexed)),
								unique: s.draw(boolean),
								gist: false
							})
						],
						[1, () => ({ columns: s.draw(orderedPrefix(columns)), unique: false, gist: true })]
					])
				)
			)
		: []
	return {
		holds,
		leaky,
		indexes,
		bound: s.draw(orderedPrefix(columns)),
		shape: s.draw(
			element<Shape>([
				"direct",
				"lateral",
				"pushed",
				"oneRow",
				"joined",
				"sublink",
				"view",
				"barrier",
				"viewOneRow",
				"inlinedCte",
				"materializedCte"
			])
		)
	}
}

/**
 * A missed seek at an uncorrelated sub-link: a drawn case read so, its first column of many values bound beside the
 * rest it binds, over no index, which a plain draw reaches about once in forty cases.
 */
const missedSublink: Gen<SeekCase> = (s) => {
	const c = s.draw(seekGen)
	return {
		...c,
		holds: ["many", ...c.holds.slice(1)],
		leaky: [false, ...c.leaky.slice(1)],
		indexes: [],
		bound: [0, ...Arr.filter(c.bound, (at) => at !== 0)],
		shape: "sublink"
	}
}

/** The space, aimed: a missed seek at an uncorrelated sub-link, which the floor and the steered phase draw rarely. */
/**
 * A read through the security barrier whose verdict its leaky equality turns: the first column, leaky, held out, the
 * second read through an index of it alone, served beneath the barrier and missed were the leaky one pushed.
 */
const barrierTurns: Gen<SeekCase> = (s) => {
	const c = s.draw(seekGen)
	return {
		...c,
		holds: ["many", "many", ...c.holds.slice(2)],
		leaky: [true, false, ...c.leaky.slice(2)],
		indexes: [{ columns: [1], unique: false, gist: false }],
		bound: [0, 1],
		shape: "barrier"
	}
}

export const seekSpace = aimed(seekGen, [
	["a missed seek at an uncorrelated sub-link", missedSublink],
	["a barrier holding out a leaky equality the verdict turns on", barrierTurns]
])

/** The keyed table's columns: its key, then one for each column the read table may have. */
const keyedColumns: Arr.NonEmptyReadonlyArray<string> = [
	"id",
	...Array.from({ length: keyedWidth }, (_, at) => columnName(at))
]

/** The view `name` of every column of the table `of`, `columns`, behind a security barrier where `barrier` says. */
const viewOf = (
	name: string,
	of: string,
	columns: Arr.NonEmptyReadonlyArray<string>,
	barrier: boolean
): CreateView => ({
	kind: "createView",
	name: { schema, name },
	columns,
	barrier,
	query: select(
		provedCore(
			"certified",
			Arr.map(columns, (c) => target(col("v", c))),
			[table(schema, of, "v")],
			undefined
		)
	)
})

/**
 * The installation as the check reads it: the table read, the keyed table beside it, and the three views over them.
 */
export const tablesOf = (c: SeekCase): SeekTargets => {
	const columns: Arr.NonEmptyReadonlyArray<string> = [
		columnName(0),
		...Arr.map(c.holds.slice(1), (_, at) => columnName(at + 1))
	]
	return {
		tables: new Map<NameKey, SeekTable>([
			[
				nameKey({ schema, name: read }),
				{
					relation: "T",
					derived: false,
					columns: new Map(Arr.map(columns, (c) => [c, { kind: "field", field: c }] as const)),
					holds: new Map<string, Holds>(Arr.map(c.holds, (h, at) => [columnName(at), h] as const)),
					leaky: new Set(Arr.filter(columns, (_, at) => c.leaky[at] === true)),
					indexes: Arr.map(c.indexes, (i, at): SeekIndex => ({
						name: `i${String(at)}`,
						columns: Arr.map(i.columns, columnName),
						unique: i.unique,
						gist: i.gist
					}))
				}
			],
			[
				nameKey({ schema, name: keyed }),
				{
					relation: "K",
					derived: false,
					columns: new Map(Arr.map(keyedColumns, (c) => [c, { kind: "field", field: c }] as const)),
					holds: new Map<string, Holds>(Arr.map(keyedColumns, (k) => [k, "many"] as const)),
					leaky: new Set(),
					indexes: [{ name: "k_pk", columns: ["id"], unique: true, gist: false }]
				}
			]
		]),
		views: new Map([
			[nameKey({ schema, name: plainView }), seekView(viewOf(plainView, read, columns, false))],
			[nameKey({ schema, name: barrierView }), seekView(viewOf(barrierView, read, columns, true))],
			[
				nameKey({ schema, name: keyedView }),
				seekView(viewOf(keyedView, keyed, keyedColumns, false))
			]
		])
	}
}

const one = lit.int(1, types.bigint)

/** `left` equal to each column of the read the case binds, at `value` of each column's place. */
const bindings = (c: SeekCase, alias: string, value: (at: number) => Expr): ReadonlyArray<Expr> =>
	Arr.map(c.bound, (at) => eq(col(alias, columnName(at)), value(at)))

const conjunction = (conditions: ReadonlyArray<Expr>): Expr | undefined =>
	Arr.isReadonlyArrayNonEmpty(conditions)
		? conditions.length === 1
			? conditions[0]
			: and(conditions)
		: undefined

/** The read of the case's table in its shape (`Shape`). */
export const statementOf = (c: SeekCase): SqlStatement => {
	const r = table(schema, read, "r")
	const whole = (from: ReadonlyArray<FromItem>, where: Expr | undefined) =>
		provedCore("certified", [target(one)], from, where)
	switch (c.shape) {
		case "direct":
			return selectOf(whole([r], conjunction(bindings(c, "r", () => one))))
		case "lateral":
			return selectOf(
				whole(
					[
						table(schema, loose, "o"),
						derived(
							{
								...operandSelect(
									provedCore(
										"certified",
										[target(col("r", columnName(0)))],
										[r],
										conjunction(bindings(c, "r", (at) => col("o", columnName(at))))
									)
								),
								offset: lit.int(0, types.bigint)
							},
							"l",
							true
						)
					],
					undefined
				)
			)
		case "pushed": {
			const all = Arr.map(c.holds, (_, at) => target(col("r", columnName(at))))
			return selectOf(
				whole(
					[
						derived(
							operandSelect(
								distinctCore([target(col("r", columnName(0))), ...all.slice(1)], [r], undefined)
							),
							"d",
							false
						)
					],
					conjunction(bindings(c, "d", () => one))
				)
			)
		}
		case "oneRow":
			return selectOf(
				whole(
					[table(schema, keyed, "k"), r],
					conjunction([
						eq(col("k", "id"), one),
						...bindings(c, "r", (at) => col("k", columnName(at)))
					])
				)
			)
		case "joined":
			return selectOf(
				whole(
					[table(schema, loose, "o"), r],
					conjunction(bindings(c, "r", (at) => col("o", columnName(at))))
				)
			)
		case "sublink":
			return selectOf(
				whole(
					[r],
					conjunction(
						Arr.map(c.bound, (at): Expr => ({
							kind: "equalsAny",
							expr: col("r", columnName(at)),
							array: {
								kind: "array",
								query: select(
									provedCore(
										"certified",
										[target(col("o", columnName(at)))],
										[table(schema, loose, "o")],
										undefined
									)
								)
							},
							schema: undefined
						}))
					)
				)
			)
		case "view":
			return selectOf(
				whole([table(schema, plainView, "r")], conjunction(bindings(c, "r", () => one)))
			)
		case "barrier":
			return selectOf(
				whole([table(schema, barrierView, "r")], conjunction(bindings(c, "r", () => one)))
			)
		case "viewOneRow":
			return selectOf(
				whole(
					[table(schema, keyedView, "k"), r],
					conjunction([
						eq(col("k", "id"), one),
						...bindings(c, "r", (at) => col("k", columnName(at)))
					])
				)
			)
		case "inlinedCte":
		case "materializedCte": {
			const all = Arr.map(c.holds, (_, at) => target(col("r", columnName(at))))
			return {
				kind: "select",
				body: whole(
					[
						{ kind: "cte", name: "d", alias: "d1" },
						{ kind: "cte", name: "d", alias: "d2" }
					],
					conjunction([...bindings(c, "d1", () => one), ...bindings(c, "d2", () => one)])
				),
				orderBy: [],
				limit: undefined,
				offset: undefined,
				with: {
					recursive: false,
					ctes: [
						{
							name: "d",
							materialized: c.shape === "inlinedCte" ? "NOT MATERIALIZED" : "MATERIALIZED",
							query: operandSelect(
								provedCore(
									"certified",
									[target(col("r", columnName(0))), ...all.slice(1)],
									[r],
									undefined
								)
							)
						}
					]
				}
			}
		}
	}
}

const selectOf = (body: ReturnType<typeof provedCore>): SqlStatement => ({
	kind: "select",
	with: undefined,
	body,
	orderBy: [],
	limit: undefined,
	offset: undefined
})

/**
 * The columns the read binds of the table: none through a join or over a MATERIALIZED CTE, read once, whole, and past
 * a barrier the ones of no leaky equality.
 */
const boundBy = (c: SeekCase): ReadonlyArray<number> =>
	c.shape === "joined" || c.shape === "materializedCte"
		? []
		: c.shape === "barrier"
			? Arr.filter(c.bound, (at) => c.leaky[at] !== true)
			: c.bound

/** Whether a seek of the case's table at `columns` is served by no index (`missed`). */
const missedAt = (c: SeekCase, columns: ReadonlyArray<number>): boolean => {
	const bound = new Set(columns)
	const held = Arr.filter(columns, (at) => c.holds[at] === "many")
	if (!Arr.isReadonlyArrayNonEmpty(held)) {
		return false
	}
	return !Arr.some(c.indexes, (i) => {
		const run = Arr.takeWhile(i.columns, (at) => bound.has(at))
		return (
			(i.unique && run.length === i.columns.length) ||
			(i.gist && run.length > 0) ||
			Arr.every(held, (at) => run.includes(at))
		)
	})
}

/**
 * The specification: the read seeks the table at its bound columns (`boundBy`), none where it binds them through a join
 * PostgreSQL orders by its estimates, and through a security barrier only those whose equality is no leaky one; such a
 * seek is served where it binds no column of many values, or the leading run of some index holds every one it binds, or
 * holds a unique index whole, or it binds a GiST index's first column, which decides how much of it is scanned; a column
 * of few values is a filter beside the run.
 */
export const missed = (c: SeekCase): boolean => missedAt(c, boundBy(c))

export type SeekFeature =
	| "a missed seek"
	| "a seek an index's leading run serves"
	| "a seek a unique index serves whole"
	| "a seek of columns of few values alone no index serves"
	| "a seek an index holds out of order"
	| "a barrier holding out a leaky equality the verdict turns on"
	| "a missed seek at an uncorrelated sub-link"
	| "a missed seek through a view"
	| "a missed seek at the row a view reads by its key"
	| "a missed seek through a NOT MATERIALIZED CTE"
	| "a seek a MATERIALIZED CTE holds out"
	| "a seek a GiST index serves at its first column alone"
	| Shape

/** The situation a missed seek reaches in each shape whose binding a kill of its own reads. */
const missedAtShape: Readonly<Record<Shape, ReadonlyArray<SeekFeature>>> = {
	direct: [],
	lateral: [],
	pushed: [],
	oneRow: [],
	joined: [],
	sublink: ["a missed seek at an uncorrelated sub-link"],
	view: ["a missed seek through a view"],
	barrier: [],
	viewOneRow: ["a missed seek at the row a view reads by its key"],
	inlinedCte: ["a missed seek through a NOT MATERIALIZED CTE"],
	materializedCte: []
}

/** The situations a case reaches. */
export const featuresOf = (c: SeekCase): ReadonlyArray<SeekFeature> => {
	const bound = new Set(boundBy(c))
	const outOfOrder = Arr.some(
		c.indexes,
		(i) =>
			Arr.every([...bound], (at) => i.columns.includes(at)) &&
			Arr.takeWhile(i.columns, (at) => bound.has(at)).length < bound.size
	)
	const held = Arr.filter([...bound], (at) => c.holds[at] !== "none")
	return [
		c.shape,
		...(missed(c) ? (["a missed seek"] as const) : []),
		...(!missed(c) && c.shape !== "joined" && Arr.some(held, (at) => c.holds[at] === "many")
			? Arr.some(c.indexes, (i) => i.unique && Arr.every(i.columns, (at) => bound.has(at)))
				? (["a seek a unique index serves whole"] as const)
				: (["a seek an index's leading run serves"] as const)
			: []),
		...(Arr.isReadonlyArrayNonEmpty(held) &&
		!Arr.some(held, (at) => c.holds[at] === "many") &&
		!Arr.some(c.indexes, (i) => {
			const run = Arr.takeWhile(i.columns, (at: number) => bound.has(at))
			return Arr.every(held, (at: number) => run.includes(at))
		})
			? (["a seek of columns of few values alone no index serves"] as const)
			: []),
		...(outOfOrder && missed(c) ? (["a seek an index holds out of order"] as const) : []),
		...(c.shape === "barrier" && missed(c) !== missedAt(c, c.bound)
			? (["a barrier holding out a leaky equality the verdict turns on"] as const)
			: []),
		...(missed(c) ? missedAtShape[c.shape] : []),
		...(!missed(c) && missedAt({ ...c, indexes: Arr.filter(c.indexes, (i) => !i.gist) }, boundBy(c))
			? (["a seek a GiST index serves at its first column alone"] as const)
			: []),
		...(c.shape === "materializedCte" && missedAt(c, c.bound)
			? (["a seek a MATERIALIZED CTE holds out"] as const)
			: [])
	]
}
