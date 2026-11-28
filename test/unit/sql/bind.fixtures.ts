/**
 * What the binding's property reads (bind.test.ts): its catalog of two stored tables, its space of statements over
 * them, each read of T stated where the binding meets it, and the read the specification says each binds.
 */

import { defined } from "@bjornpagen/testing/assert"
import { type Gen, boolean, element } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order } from "effect"
import { defaultOpclass } from "#compiler/ir/law.ts"
import type { AccessIndexRequest } from "#compiler/ir/products.ts"
import type {
	Expr,
	FromSource,
	LevelAccess,
	OperandSelect,
	Select,
	SelectCore
} from "#compiler/sql/ast.ts"
import { nameKey } from "#compiler/sql/ast.ts"
import { type BindTable, type BindView, bindView, type ReadCatalog } from "#compiler/sql/bind.ts"
import {
	and,
	asc,
	binary,
	call,
	col,
	columnDefinition,
	core,
	continuedAll,
	countStar,
	cte,
	cteRefAs,
	derived,
	eq,
	exists,
	grouped,
	keyedRead,
	keyedSet,
	lit,
	namedType,
	not,
	notExists,
	objectName,
	operandSelect,
	param,
	provedCore,
	select,
	setOperation,
	table,
	target,
	targetAs,
	types,
	unionAll,
	windowOf
} from "#compiler/sql/build.ts"
import { wholeViewAlias } from "#compiler/sql/naming.ts"
import type { JoinedMember, JoinMember, PlanItem, ReadPlan } from "#compiler/sql/plan.ts"
import { levelItems, scannedItems } from "#compiler/sql/plan.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { identityHooks, Transform } from "#compiler/sql/transform.ts"
import { installedTypes } from "#compiler/sql/type-schemas.ts"

/** What a case of the property reaches: each way a read of T is bound, or is not. */
export type BindFeature =
	| "a seek at a literal"
	| "a seek's range past its bound columns"
	| "a whole read of few values alone"
	| "a probe driven by an earlier item"
	| "a seek at an enclosing level's column"
	| "a seek beneath a window, at its partition"
	| "a whole read beneath a window, at no partition"
	| "an extension's equality bound"
	| "a column no B-tree holds left a filter"
	| "a derived table joined to an earlier item by a hash"
	| "a derived table read per earlier row at its stored read's key"
	| "a whole view's read named by its body's alias"
	| "a whole view read twice at one level, the second a level of its own"
	| "a context source's row named by the scope, its level's one item"
	| "a world view's read planned under its body's aliases, the reader's qual pushed past its barrier"
	| "a world view's read whose qual its barrier keeps out"
	| "an INSERT's met rows planned apart under the scope's names"
	| "a UNION ALL's append level, each arm's one item a member"
	| "a derived UNION ALL's members appended to its reader's item"
	| "a derived UNION ALL in parentheses, its members appended to its reader's item"
	| "a NOT EXISTS of a set PostgreSQL anti-joins, hashed after its level's items"
	| "a NOT EXISTS whose level side its level fixes, anti-joined by a nested loop"
	| "an EXISTS of a set read through a fenced item, a subplan"
	| "a VALUES list fenced, planned apart under its alias"
	| "a reader's conjunct moved beneath a fence, binding the read there"
	| "a reader's conjunct moved through every arm of a fenced UNION nested in another's arm, binding the read there"
	| "byte strings bound together, one equality of their row"
	| "one byte string bound alone, an equality lookup"
	| "a probe of a group in its order, an ordered seek of its group then its order"
	| "a probe of a group's last row, an ordered seek of its group then its order"
	| "a probe in an order no B-tree holds, an internal compiler error"

export const bindFeatures = [
	"a seek at a literal",
	"a seek's range past its bound columns",
	"a whole read of few values alone",
	"a probe driven by an earlier item",
	"a seek at an enclosing level's column",
	"a seek beneath a window, at its partition",
	"a whole read beneath a window, at no partition",
	"an extension's equality bound",
	"a column no B-tree holds left a filter",
	"a derived table joined to an earlier item by a hash",
	"a derived table read per earlier row at its stored read's key",
	"a whole view's read named by its body's alias",
	"a whole view read twice at one level, the second a level of its own",
	"a context source's row named by the scope, its level's one item",
	"a world view's read planned under its body's aliases, the reader's qual pushed past its barrier",
	"a world view's read whose qual its barrier keeps out",
	"an INSERT's met rows planned apart under the scope's names",
	"a UNION ALL's append level, each arm's one item a member",
	"a derived UNION ALL's members appended to its reader's item",
	"a derived UNION ALL in parentheses, its members appended to its reader's item",
	"a NOT EXISTS of a set PostgreSQL anti-joins, hashed after its level's items",
	"a NOT EXISTS whose level side its level fixes, anti-joined by a nested loop",
	"an EXISTS of a set read through a fenced item, a subplan",
	"a VALUES list fenced, planned apart under its alias",
	"a reader's conjunct moved beneath a fence, binding the read there",
	"a reader's conjunct moved through every arm of a fenced UNION nested in another's arm, binding the read there",
	"byte strings bound together, one equality of their row",
	"one byte string bound alone, an equality lookup",
	"a probe of a group in its order, an ordered seek of its group then its order",
	"a probe of a group's last row, an ordered seek of its group then its order",
	"a probe in an order no B-tree holds, an internal compiler error"
] as const

/**
 * T(a, b, f, v, d) keyed by a: a and b of many values, f of few (a roster's handle), v a vector, of many, which
 * pgvector's B-tree class keys by its own `=`, and d none a B-tree holds (a text of no byte bound); S(k, w) keyed by k.
 */
const tTable: BindTable = {
	relation: "T",
	columns: new Map([
		["a", { kind: "scalar", column: { kind: "field", field: "a" }, holds: "many" }],
		["b", { kind: "scalar", column: { kind: "field", field: "b" }, holds: "many" }],
		["f", { kind: "scalar", column: { kind: "field", field: "f" }, holds: "few" }],
		[
			"v",
			{
				kind: "vector",
				column: { kind: "field", field: "v" },
				holds: "many",
				cosine: defaultOpclass
			}
		]
	]),
	keys: [["a"]],
	hashRow: { kind: "none" },
	digests: new Map()
}

const sTable: BindTable = {
	relation: "S",
	columns: new Map([
		["k", { kind: "scalar", column: { kind: "field", field: "k" }, holds: "many" }],
		["w", { kind: "scalar", column: { kind: "field", field: "w" }, holds: "many" }]
	]),
	keys: [["k"]],
	hashRow: { kind: "none" },
	digests: new Map()
}

/**
 * U(p, q, x), a stored derived relation's table of no key: p and q byte strings, which no B-tree entry holds, read
 * together through the hash index over their row, cast to its type `app.u_<columns>` (sql/bind.ts HashRow); x a scalar.
 */
const uTable: BindTable = {
	relation: "U",
	columns: new Map([
		["p", { kind: "bytes", column: { kind: "field", field: "p" }, holds: "many" }],
		["q", { kind: "bytes", column: { kind: "field", field: "q" }, holds: "many" }],
		["x", { kind: "scalar", column: { kind: "field", field: "x" }, holds: "many" }]
	]),
	keys: [],
	hashRow: {
		kind: "typed",
		type: (columns) => namedType(installedTypes("app"), `u_${Arr.join(columns, "_")}`, [])
	},
	digests: new Map()
}

/** The alias T's whole view's body names T by, which PostgreSQL plans T under where it flattens the view. */
export const tViewAlias = wholeViewAlias(1)

/** T's whole view, `app.t_whole`, every column of T as itself (sql/bind.ts BindView `whole`). */
const tWhole: BindView = {
	kind: "whole",
	table: tTable,
	alias: tViewAlias,
	columns: new Map(Arr.map(["a", "b", "f", "v", "d"], (c) => [c, c] as const))
}

/** The tables of the catalog alone: what a world view's body is bound over. */
const tablesOnly: ReadCatalog = {
	table: (key) =>
		key === nameKey({ schema: "app", name: "t" })
			? tTable
			: key === nameKey({ schema: "app", name: "s" })
				? sTable
				: key === nameKey({ schema: "app", name: "u" })
					? uTable
					: undefined,
	view: () => undefined,
	fired: () => undefined
}

/** A world view's definition over T, every row's a and b, and its body bound under its view scope, the first. */
const worldDefinition = select(
	keyedSet(
		[target(col("t", "a")), target(col("t", "b"))],
		[table("app", "t", "t")],
		undefined,
		"T's world"
	)
)
export const worldBody = bindView(worldDefinition, 1, tablesOnly)

/**
 * T's world view, `app.t_world`, its columns named `wa` and `wb` where its definition delivers T's a and b, and the same
 * view of wa's equality leaky, `app.t_leaky` (sql/bind.ts WorldBinding).
 */
const worldOf = (name: string, leaky: ReadonlyArray<string>): BindView => ({
	kind: "world",
	view: {
		name: { schema: "app", name },
		prepared: worldBody.prepared,
		ordinal: 1,
		minted: worldBody.minted,
		columns: ["wa", "wb"],
		leaky: new Set(leaky)
	}
})

/**
 * The catalog of T and S, of the schema `app`, T's whole view `app.t_whole`, its world views `app.t_world` and
 * `app.t_leaky`, and no trigger function.
 */
export const catalog: ReadCatalog = {
	table: tablesOnly.table,
	view: (key) =>
		key === nameKey({ schema: "app", name: "t_whole" })
			? tWhole
			: key === nameKey({ schema: "app", name: "t_world" })
				? worldOf("t_world", [])
				: key === nameKey({ schema: "app", name: "t_leaky" })
					? worldOf("t_leaky", ["wa"])
					: undefined,
	fired: () => undefined
}

/**
 * The met rows of the CTE `i` proposing the CTE `p`, keyed by a, delivering a and b, read as `m`, each name of their own
 * written as the lowering writes one: what PostgreSQL plans as the level `mm` reading `md`, the append relation of `ms`
 * and `mr`.
 */
export const metSource: Extract<FromSource, { readonly kind: "metRows" }> = {
	kind: "metRows",
	insert: "i",
	proposed: "p",
	key: [{ column: "a", from: "a", schema: undefined }],
	columns: [
		{ column: "a", returned: "a" },
		{ column: "b", returned: "b" }
	],
	scan: "ms",
	returned: "mr",
	sides: "md",
	marker: "mk",
	marked: "mm",
	hit: "mh",
	alias: "m"
}

/** A session's context, one claim `sub` delivered as `c1`, read as `x`, its claims document's row written `m`. */
const contextSource: FromSource = {
	kind: "context",
	context: "Session",
	columns: [{ field: "sub", column: columnDefinition("c1", types.integer), judged: types.integer }],
	refusal: { kind: "qualified", schema: "app", name: "refuse", volatility: "VOLATILE" },
	inner: "m",
	alias: "x"
}

/** The columns a case binds T at by a value its level fixes, each by a conjunct of T's WHERE. */
export type Fixed = "a" | "b" | "f" | "v" | "d"

/**
 * Where a case reads T: its level's own top, its first literal equality stated twice; after S, joined to it at b; beneath S's EXISTS at a; through a window;
 * inside groups by b, a derived table S is joined to at b, over T itself or over a MATERIALIZED CTE of T's rows; or
 * through T's whole view at its level's top, once, or twice, the second read whole beside the first; or none, a
 * session's context read instead, its claims document's row written `m`, or an INSERT's met rows, their own names
 * written as the lowering writes them; or in the first arm of a UNION ALL with S's, the statement's own or a derived
 * table its top reads; or in a MATERIALIZED CTE beside a read of S an EXISTS or a NOT EXISTS of its WHERE tests at b
 * against S's key, over that CTE or over a VALUES list (`exists`); or in a LATERAL derived table fenced by OFFSET 0
 * after S, its level equating its a with S's key (`fenced`); or in a fenced arm of a UNION that is the second arm of a
 * derived UNION S's EXISTS equates at a with S's key, each other arm a read of S (`nested`), rule-whole's reach of a
 * region's roots; or none, U read at a parameter of each of its byte strings or of p alone (`hashed`); or after S, T's
 * rows at b = S.k probed in an order of a or of d, every one or the last (`ordered`), the stored group a write reads
 * in its order (write/probe.ts probeGroup).
 */
export type Place =
	| { readonly kind: "top" }
	| { readonly kind: "driven" }
	| { readonly kind: "sublink" }
	| { readonly kind: "window"; readonly at: "a" | "b" }
	| { readonly kind: "joined"; readonly over: "stored" | "cte" }
	| { readonly kind: "viewed"; readonly reads: 1 | 2 }
	| { readonly kind: "context" }
	| { readonly kind: "world"; readonly leaky: boolean }
	| { readonly kind: "met" }
	| { readonly kind: "union"; readonly at: "top" | "derived" | "parenthesized" }
	| {
			readonly kind: "exists"
			readonly not: boolean
			readonly over: "cte" | "values"
			/** Whether S's key, the level's side of the test's equality, is fixed at the level too, `s.k = 7`. */
			readonly pinned: boolean
	  }
	| { readonly kind: "fenced" }
	| { readonly kind: "nested" }
	| { readonly kind: "hashed"; readonly both: boolean }
	| { readonly kind: "ordered"; readonly how: "group" | "last"; readonly order: "a" | "d" }

export interface BindCase {
	readonly place: Place
	readonly fixed: ReadonlyArray<Fixed>
	/** Whether T's level also orders its column b against a literal, `t.b > 7`, at the top alone. */
	readonly ranged: boolean
}

const fixedColumns = ["a", "b", "f", "v", "d"] as const satisfies ReadonlyArray<Fixed>

/** Every place a case reads T at (Place), each its own arm of the box. */
const places: Arr.NonEmptyReadonlyArray<Place> = [
	{ kind: "top" },
	{ kind: "driven" },
	{ kind: "sublink" },
	{ kind: "window", at: "a" },
	{ kind: "window", at: "b" },
	{ kind: "joined", over: "stored" },
	{ kind: "joined", over: "cte" },
	{ kind: "viewed", reads: 1 },
	{ kind: "viewed", reads: 2 },
	{ kind: "context" },
	{ kind: "world", leaky: false },
	{ kind: "world", leaky: true },
	{ kind: "met" },
	{ kind: "union", at: "top" },
	{ kind: "union", at: "derived" },
	{ kind: "union", at: "parenthesized" },
	{ kind: "exists", not: true, over: "cte", pinned: false },
	{ kind: "exists", not: false, over: "cte", pinned: false },
	{ kind: "exists", not: true, over: "values", pinned: false },
	{ kind: "exists", not: true, over: "values", pinned: true },
	{ kind: "fenced" },
	{ kind: "nested" },
	{ kind: "hashed", both: true },
	{ kind: "hashed", both: false },
	{ kind: "ordered", how: "group", order: "a" },
	{ kind: "ordered", how: "last", order: "a" },
	{ kind: "ordered", how: "last", order: "d" }
]

/** A case reading T at `place`, its literal equalities drawn (BindCase). */
const caseAt =
	(place: Place): Gen<BindCase> =>
	(source) => ({
		place,
		fixed: place.kind === "window" ? [] : Arr.filter(fixedColumns, () => source.draw(boolean)),
		ranged: place.kind === "top" && source.draw(boolean)
	})

export const bindCaseGen: Gen<BindCase> = (source) =>
	source.draw(caseAt(source.draw(element(places))))

/**
 * The places only one arm of the box reaches, each aimed at by a case of that arm alone, so the floor stream and the
 * steered phase reach their situations whatever the box holds beside them: a probe's ordered seek, of its group or its
 * last row, its internal error, and the nested fenced UNION's pushed conjunct.
 */
export const bindAims: ReadonlyArray<readonly [BindFeature, Gen<BindCase>]> = [
	[
		"a probe of a group in its order, an ordered seek of its group then its order",
		caseAt({ kind: "ordered", how: "group", order: "a" })
	],
	[
		"a probe of a group's last row, an ordered seek of its group then its order",
		caseAt({ kind: "ordered", how: "last", order: "a" })
	],
	[
		"a probe in an order no B-tree holds, an internal compiler error",
		caseAt({ kind: "ordered", how: "last", order: "d" })
	],
	[
		"a reader's conjunct moved through every arm of a fenced UNION nested in another's arm, binding the read there",
		caseAt({ kind: "nested" })
	]
]

/** The conjunct of T's WHERE fixing `column`: a literal's, a placeholder's, and v's through pgvector's `=`. */
const fixing = (column: Fixed): Expr =>
	column === "v"
		? {
				kind: "binary",
				op: "=",
				left: col("t", "v"),
				right: param(1, types.integer),
				schema: "vector_ext"
			}
		: eq(col("t", column), lit.int(7, types.integer))

const whereOf = (conjuncts: ReadonlyArray<Expr>): Expr | undefined => {
	const [first, ...rest] = conjuncts
	return first === undefined ? undefined : rest.length === 0 ? first : and([first, ...rest])
}

/** The statement of a case (see BindCase): every read of T under the alias `t`, of S under `s`. */
export const statementOf = (c: BindCase): Select => {
	const tRead = table("app", "t", "t")
	const sRead = table("app", "s", "s")
	const fixed = Arr.map(c.fixed, fixing)
	switch (c.place.kind) {
		case "top":
			return select(
				keyedSet(
					[target(col("t", "b"))],
					[tRead],
					whereOf([
						...fixed,
						...Arr.take(fixed, 1),
						...(c.ranged ? [binary(">", col("t", "b"), lit.int(7, types.integer))] : [])
					]),
					"a read of T"
				)
			)
		case "driven":
			return select(
				keyedSet(
					[target(col("t", "b"))],
					[sRead, tRead],
					whereOf([eq(col("t", "b"), col("s", "k")), ...fixed]),
					"a read of T after S"
				)
			)
		case "sublink": {
			const probe: OperandSelect = operandSelect(
				keyedRead(
					[target(lit.int(1, types.integer))],
					[tRead],
					whereOf([eq(col("t", "a"), col("s", "k")), ...fixed])
				)
			)
			return select(
				keyedSet([target(col("s", "w"))], [sRead], exists(probe), "a read of S beside T")
			)
		}
		case "window": {
			const ranked: OperandSelect = operandSelect(
				keyedRead(
					[
						target(col("t", "a")),
						target(col("t", "b")),
						targetAs(
							{ ...call("row_number", []), over: windowOf([col("t", "a")], [asc(col("t", "b"))]) },
							"n"
						)
					],
					[tRead],
					undefined
				)
			)
			const w: FromSource = derived(ranked, "w", false)
			return select(
				keyedSet(
					[target(col("w", "n"))],
					[w],
					eq(col("w", c.place.at), lit.int(7, types.integer)),
					"a read of T's window"
				)
			)
		}
		case "context":
			return select(provedCore("oneRow", [target(col("x", "c1"))], [contextSource], undefined))
		case "exists": {
			const tested: FromSource =
				c.place.over === "cte"
					? cteRefAs("t_rows", "x")
					: {
							kind: "values",
							rows: [[lit.int(1, types.integer)], [lit.int(2, types.integer)]],
							alias: "x",
							columns: ["b"]
						}
			const test = operandSelect(
				core([target(lit.int(1, types.integer))], [tested], eq(col("x", "b"), col("s", "k")))
			)
			return {
				...select(
					keyedSet(
						[target(col("s", "w"))],
						[sRead],
						c.place.pinned
							? and([notExists(test), eq(col("s", "k"), lit.int(7, types.integer))])
							: c.place.not
								? notExists(test)
								: exists(test),
						"a read of S its rows' test reads"
					)
				),
				with: {
					recursive: false,
					ctes: [
						{
							name: "t_rows",
							materialized: "MATERIALIZED",
							query: operandSelect(core([target(col("t", "b"))], [tRead], whereOf(fixed)))
						}
					]
				}
			}
		}
		case "hashed":
			return select(
				keyedSet(
					[target(col("u", "x"))],
					[table("app", "u", "u")],
					c.place.both
						? and([
								eq(col("u", "p"), param(1, types.bytea)),
								eq(col("u", "q"), param(2, types.bytea))
							])
						: eq(col("u", "p"), param(1, types.bytea)),
					"a read of U at its byte strings"
				)
			)
		case "fenced": {
			const inner: OperandSelect = {
				...operandSelect(
					keyedRead([target(col("t", "a")), target(col("t", "b"))], [tRead], whereOf(fixed))
				),
				offset: lit.int(0, types.bigint)
			}
			return select(
				keyedSet(
					[target(col("d", "b"))],
					[sRead, derived(inner, "d", true)],
					eq(col("d", "a"), col("s", "k")),
					"a read of S beside T's fenced rows"
				)
			)
		}
		case "ordered": {
			const probed: FromSource = {
				kind: "probe",
				table: objectName("app", "t"),
				inner: "q",
				by: {
					kind: c.place.how,
					columns: [{ column: "b", value: col("s", "k"), schema: undefined }],
					order: [c.place.order]
				},
				filter: [],
				columns: [{ read: "a", as: "x" }],
				alias: "pr"
			}
			return select(
				keyedSet(
					[target(col("pr", "x"))],
					[sRead, probed],
					undefined,
					"a read of S and T's group in order"
				)
			)
		}
		case "nested": {
			/** A query fenced by OFFSET 0, which PostgreSQL pushes no qual past. */
			const fence = (fenced: SelectCore): OperandSelect => ({
				...operandSelect(fenced),
				offset: lit.int(0, types.bigint)
			})
			const roots = setOperation("UNION", [
				keyedRead(
					[target(col("f", "a"))],
					[derived(fence(keyedRead([target(col("t", "a"))], [tRead], whereOf(fixed))), "f", false)],
					undefined
				),
				keyedRead(
					[targetAs(col("g", "k"), "a")],
					[
						derived(
							fence(keyedRead([target(col("p", "k"))], [table("app", "s", "p")], undefined)),
							"g",
							false
						)
					],
					undefined
				)
			])
			const reach = setOperation("UNION", [
				keyedRead([targetAs(col("o", "k"), "a")], [table("app", "s", "o")], undefined),
				keyedRead([target(col("n", "a"))], [derived(select(roots), "n", false)], undefined)
			])
			const test = operandSelect(
				core(
					[target(lit.int(1, types.integer))],
					[derived(select(reach), "u", false)],
					eq(col("u", "a"), col("s", "k"))
				)
			)
			return select(
				keyedSet([target(col("s", "w"))], [sRead], exists(test), "a read of S its reach tests")
			)
		}
		case "union": {
			const united = continuedAll(
				"disjoint",
				keyedSet([target(col("t", "b"))], [tRead], whereOf(fixed), "T's arm"),
				keyedSet([target(col("s", "w"))], [sRead], undefined, "S's arm")
			)
			return c.place.at === "top"
				? select(united)
				: select(
						keyedSet(
							[target(col("u", "b"))],
							[
								derived(
									c.place.at === "derived" ? select(united) : select(select(united)),
									"u",
									false
								)
							],
							undefined,
							"a read of T's and S's union"
						)
					)
		}
		case "met": {
			const rowsOfT = operandSelect(
				core([target(col("t", "a")), target(col("t", "b"))], [tRead], undefined)
			)
			const rowsOfP = operandSelect(
				core([target(col("q", "a")), target(col("q", "b"))], [cteRefAs("p", "q")], undefined)
			)
			return {
				...select(
					keyedSet([target(col("m", "b"))], [metSource], undefined, "an INSERT's met rows")
				),
				with: { recursive: false, ctes: [cte("p", rowsOfT), cte("i", rowsOfP)] }
			}
		}
		case "world":
			return select(
				keyedSet(
					[target(col("w", "wb"))],
					[table("app", c.place.leaky ? "t_leaky" : "t_world", "w")],
					eq(col("w", "wa"), lit.int(7, types.integer)),
					"a read of T's world view"
				)
			)
		case "viewed": {
			const viewRead = table("app", "t_whole", "t")
			return select(
				keyedSet(
					[target(col("t", "b"))],
					c.place.reads === 1 ? [viewRead] : [viewRead, table("app", "t_whole", "u")],
					whereOf(fixed),
					"a read of T through its whole view"
				)
			)
		}
		case "joined": {
			const grouping = c.place.over === "stored" ? "t" : "c"
			const counted: OperandSelect = operandSelect(
				grouped(
					core(
						[target(col(grouping, "b")), targetAs(countStar(), "n")],
						[c.place.over === "stored" ? tRead : cteRefAs("t_rows", "c")],
						c.place.over === "stored" ? whereOf(fixed) : undefined
					),
					[col(grouping, "b")]
				)
			)
			const joined = select(
				keyedSet(
					[target(col("g", "n"))],
					[sRead, derived(counted, "g", false)],
					eq(col("g", "b"), col("s", "k")),
					"a read of S joined to groups by b"
				)
			)
			return c.place.over === "stored"
				? joined
				: {
						...joined,
						with: {
							recursive: false,
							ctes: [
								{
									name: "t_rows",
									materialized: "MATERIALIZED",
									query: operandSelect(core([target(col("t", "b"))], [tRead], whereOf(fixed)))
								}
							]
						}
					}
		}
	}
}

/**
 * How the bound statement joins the derived tables of its top level: each LATERAL or not, the top level's WHERE, which
 * holds a set join's condition, and whether the top level's plan joins an item that is no stored read by a hash.
 */
export const topJoins = (
	bound: Select,
	plan: ReadPlan<AccessIndexRequest>
): {
	readonly lateral: ReadonlyArray<boolean>
	readonly where: boolean
	readonly hashed: boolean
} => {
	const body = bound.body
	const from = body.kind === "core" ? body.from : []
	const sources = Arr.flatMap(from, (item): ReadonlyArray<FromSource> =>
		item.kind === "joins" ? [item.first, ...Arr.map(item.steps, (s) => s.source)] : [item]
	)
	return {
		lateral: Arr.flatMap(sources, (s) => (s.kind === "derived" ? [s.lateral] : [])),
		where: body.kind === "core" && body.where !== undefined,
		hashed: Arr.some(
			plan.levels,
			(level) =>
				level.kind === "joins" &&
				level.name.kind === "top" &&
				Arr.some(
					joinedMembers(level.problem),
					(j) => j.join === "hash" && j.member.kind === "item" && j.member.item.scan.kind === "rows"
				)
		)
	}
}

/** Every member a join tree joins after a join's first, each join's in order, a member's own joins after it. */
export const joinedMembers = <I>(member: JoinMember<I>): ReadonlyArray<JoinedMember<I>> =>
	member.kind === "item"
		? []
		: [
				...joinedMembers(member.tree.first),
				...Arr.flatMap(member.tree.joined, (j) => [j, ...joinedMembers(j.member)])
			]

/** A join tree's driving item: its first member's, as far as a tree's first goes. */
export const firstItemOf = <I>(member: JoinMember<I>): PlanItem<I> =>
	member.kind === "item" ? member.item : firstItemOf(member.tree.first)

/** A read of T the bound statement holds: its alias as the plan names it, and whether it is a probe's inner read. */
export interface TRead {
	readonly alias: string
	readonly probe: boolean
}

/** Every read of T in the bound statement `bound`, each a read node's or a probe's inner read. */
export const tReadsOf = (bound: Select): ReadonlyArray<TRead> => {
	const found: Array<TRead> = []
	new Transform({
		...identityHooks,
		fromSource: (s) => {
			if (s.kind === "read" && typeof s.table !== "string" && s.table.name === "t") {
				found.push({ alias: s.alias, probe: false })
			}

			if (s.kind === "probe" && typeof s.table !== "string" && s.table.name === "t") {
				found.push({ alias: s.inner, probe: true })
			}
			return s
		}
	}).statement(bound)
	return found
}

/** The plan's item of `alias`, wherever its level stands. */
export const itemOf = (
	plan: ReadPlan<AccessIndexRequest>,
	alias: string
): Option.Option<PlanItem<AccessIndexRequest>> =>
	Arr.findFirst(Arr.flatMap(plan.levels, scannedItems), (item) => item.alias === alias)

/** How the specification reads T: through an index at `bound`, a probe's or a seek's, or whole. */
export type SpecifiedRead =
	| { readonly kind: "index"; readonly probe: boolean; readonly bound: ReadonlyArray<string> }
	| { readonly kind: "whole" }

/**
 * The read of T the specification states (CARRY-CONTRACT §1, sql/bind.ts): its bindings each an equality of a column a
 * B-tree holds with a value its level fixes, a literal, a placeholder, an enclosing level's column, or a column of an
 * item before it; a probe where one binding reads an item before it, every binding its index's; else a key lookup where
 * its bindings hold T's key and one holds many values; else the one range past its bindings, of a column of many values
 * it does not bind, after every binding; else a seek where one bound column holds many values, every binding its
 * index's; else whole. Beneath a window, the reader's equality binds T only at a column every window partitions by.
 * Inside groups its level joins to an item before it: over T itself, the join binds T at b, the groups read per row of S
 * at its key, as a probe is; over a CTE of T's rows, it binds none of T's columns, the groups derived once and joined
 * by a hash.
 */
export const specified = (c: BindCase): SpecifiedRead => {
	const held = Arr.filter(c.fixed, (f) => f !== "d")
	const sorted = (columns: ReadonlyArray<string>) => Arr.sort(Arr.dedupe(columns), Order.String)
	switch (c.place.kind) {
		case "driven":
			return { kind: "index", probe: true, bound: sorted(["b", ...held]) }
		case "context":
		case "met":
		case "hashed":
		case "ordered":
			return { kind: "whole" }
		case "world":
			return c.place.leaky ? { kind: "whole" } : { kind: "index", probe: false, bound: ["a"] }
		case "viewed": {
			const many = Arr.some(held, (f) => f !== "f")
			return many ? { kind: "index", probe: false, bound: sorted(held) } : { kind: "whole" }
		}
		case "joined": {
			if (c.place.over === "stored") {
				return { kind: "index", probe: false, bound: sorted(["b", ...held]) }
			}
			const many = Arr.some(held, (f) => f !== "f")
			return many ? { kind: "index", probe: false, bound: sorted(held) } : { kind: "whole" }
		}
		case "sublink":
			return { kind: "index", probe: false, bound: sorted(["a", ...held]) }
		case "window":
			return c.place.at === "a" ? { kind: "index", probe: false, bound: ["a"] } : { kind: "whole" }
		case "fenced":
		case "nested":
			return { kind: "index", probe: false, bound: sorted(["a", ...held]) }
		case "top":
		case "union":
		case "exists": {
			const many = Arr.some(held, (f) => f !== "f")
			if (many && Arr.contains(held, "a")) {
				return { kind: "index", probe: false, bound: sorted(held) }
			}
			if (c.ranged && !Arr.contains(held, "b")) {
				return { kind: "index", probe: false, bound: [...sorted(held), "b"] }
			}
			return many ? { kind: "index", probe: false, bound: sorted(held) } : { kind: "whole" }
		}
	}
}

/**
 * How the plan of a read through T's whole view names it: the top level's items, by alias, and the items of every level
 * the scope named, each level's aliases in order.
 */
export const viewedLevels = (
	plan: ReadPlan<AccessIndexRequest>
): {
	readonly top: ReadonlyArray<PlanItem<AccessIndexRequest>>
	readonly named: ReadonlyArray<ReadonlyArray<string>>
} => ({
	top: Arr.flatMap(plan.levels, (level) => (level.name.kind === "top" ? levelItems(level) : [])),
	named: Arr.flatMap(plan.levels, (level) =>
		level.name.kind === "named" ? [Arr.map(levelItems(level), (i) => i.alias)] : []
	)
})

/** The context source the bound statement reads at its top, with the plan's level its alias names. */
export const contextLevel = (
	bound: Select,
	plan: ReadPlan<AccessIndexRequest>
): {
	readonly source: Option.Option<Extract<FromSource, { readonly kind: "context" }>>
	readonly levels: ReadonlyArray<ReadonlyArray<string>>
} => {
	const body = bound.body
	const [first] = body.kind === "core" ? body.from : []
	const source = first?.kind === "context" ? Option.some(first) : Option.none()
	return {
		source,
		levels: Option.match(source, {
			onNone: () => [],
			onSome: (s) =>
				Arr.flatMap(plan.levels, (level) =>
					level.name.kind === "named" && level.name.name === s.alias
						? [Arr.map(levelItems(level), (i) => i.alias)]
						: []
				)
		})
	}
}

/**
 * Whether the bound statement's top WHERE tests an EXISTS that reads one derived table fenced by OFFSET 0, which
 * PostgreSQL plans as a subplan, never a join of the level.
 */
export const existsFenced = (bound: Select): boolean => {
	const body = bound.body
	const where = body.kind === "core" ? body.where : undefined
	if (where?.kind !== "exists") {
		return false
	}
	const test = where.query.body
	const [first, ...others] = test.kind === "core" ? test.from : []
	return (
		others.length === 0 &&
		first?.kind === "derived" &&
		first.query.offset?.kind === "literal" &&
		first.query.offset.value.kind === "int" &&
		first.query.offset.value.value === 0n
	)
}

/** The access of the read the bound statement holds at its top, none where it holds no bound read there. */
export const boundAccess = (bound: Select): LevelAccess | undefined => {
	const body = bound.body
	const [first] = body.kind === "core" ? body.from : []
	return first?.kind === "read" ? first.access : undefined
}

/** The met rows the bound statement reads at its top, as the binding wrote them. */
export const boundMet = (
	bound: Select
): Option.Option<Extract<FromSource, { readonly kind: "metRows" }>> => {
	const body = bound.body
	const [first] = body.kind === "core" ? body.from : []
	return first?.kind === "metRows" ? Option.some(first) : Option.none()
}

/** The conditions of every seek's bindings the bound statement reads T by, each as printed. */
export const seekConditionsOf = (bound: Select): ReadonlyArray<string> => {
	const found: Array<string> = []
	new Transform({
		...identityHooks,
		fromSource: (s) => {
			if (s.kind === "read" && s.access.kind === "seek") {
				for (const b of s.access.bound) {
					found.push(printExpr(b.condition))
				}
			}
			return s
		}
	}).statement(bound)
	return found
}

/** The alias the world view's body names T by, which its bound body reads T under. */
export const worldTAlias = (): string =>
	defined(tReadsOf(worldBody.bound)[0], "T's read in its world view's body").alias

/**
 * Where a statement reads one probe of T in two places (printedTwiceOf): two conjuncts of S's WHERE, the existence and
 * its negation; two arms of a union of S's rows; or a target of S's read and that read's order.
 */
export const twicePlaces = ["two conjuncts", "two arms", "a target and the order"] as const

export type TwicePlace = (typeof twicePlaces)[number]

/** A case: where the probe stands twice, and whether its two places share one query or each builds its own. */
export interface TwiceCase {
	readonly place: TwicePlace
	readonly shared: boolean
}

export const twiceCaseGen: Gen<TwiceCase> = (source) => ({
	place: source.draw(element(twicePlaces)),
	shared: source.draw(boolean)
})

/**
 * The statement of a case: S read with T's probe at S's key, `EXISTS (SELECT 1 FROM t WHERE t.a = s.k)`, in each of the
 * case's two places, one query object read in both where the case shares it, each place's own otherwise.
 */
export const printedTwiceOf = (c: TwiceCase): Select => {
	const probe = (): OperandSelect =>
		operandSelect(
			keyedRead(
				[target(lit.int(1, types.integer))],
				[table("app", "t", "t")],
				eq(col("t", "a"), col("s", "k"))
			)
		)
	const one = probe()
	const place = (): OperandSelect => (c.shared ? one : probe())
	const sRead = () => table("app", "s", "s")
	switch (c.place) {
		case "two conjuncts":
			return select(
				keyedSet(
					[target(col("s", "w"))],
					[sRead()],
					and([exists(place()), not(exists(place()))]),
					"S beside T and beside none"
				)
			)
		case "two arms":
			return select(
				unionAll("disjoint", [
					keyedSet([target(col("s", "w"))], [sRead()], exists(place()), "S beside T"),
					keyedSet([target(col("s", "w"))], [sRead()], not(exists(place())), "S beside none")
				])
			)
		case "a target and the order":
			return {
				...select(
					keyedSet(
						[target(col("s", "w")), targetAs(exists(place()), "beside")],
						[sRead()],
						undefined,
						"S, whether beside T"
					)
				),
				orderBy: [asc(exists(place()))]
			}
	}
}
