/**
 * What the binding's property reads (bind.test.ts): its catalog of two stored tables, its space of statements over
 * them, each read of T stated where the binding meets it, and the read the specification says each binds.
 */

import { type Gen, boolean, element } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order } from "effect"
import { defaultOpclass } from "#compiler/ir/law.ts"
import type { AccessIndexRequest } from "#compiler/ir/products.ts"
import type { Expr, FromSource, OperandSelect, Select } from "#compiler/sql/ast.ts"
import { nameKey } from "#compiler/sql/ast.ts"
import type { BindTable, ReadCatalog } from "#compiler/sql/bind.ts"
import {
	and,
	asc,
	binary,
	call,
	col,
	core,
	countStar,
	cteRefAs,
	derived,
	eq,
	exists,
	grouped,
	keyedRead,
	keyedSet,
	lit,
	operandSelect,
	param,
	select,
	table,
	target,
	targetAs,
	types,
	windowOf
} from "#compiler/sql/build.ts"
import type { PlanItem, ReadPlan } from "#compiler/sql/plan.ts"
import { levelItems } from "#compiler/sql/plan.ts"
import { identityHooks, Transform } from "#compiler/sql/transform.ts"

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
	"a derived table read per earlier row at its stored read's key"
] as const

/**
 * T(a, b, f, v, d) keyed by a: a and b of many values, f of few (a roster's handle), v a vector, of many, which
 * pgvector's B-tree class keys by its own `=`, and d none a B-tree holds (a text of no byte bound); S(k, w) keyed by k.
 */
const tTable: BindTable = {
	relation: "T",
	columns: new Map([
		["a", { kind: "scalar", field: "a", holds: "many" }],
		["b", { kind: "scalar", field: "b", holds: "many" }],
		["f", { kind: "scalar", field: "f", holds: "few" }],
		["v", { kind: "vector", field: "v", holds: "many", cosine: defaultOpclass }]
	]),
	keys: [["a"]]
}

const sTable: BindTable = {
	relation: "S",
	columns: new Map([
		["k", { kind: "scalar", field: "k", holds: "many" }],
		["w", { kind: "scalar", field: "w", holds: "many" }]
	]),
	keys: [["k"]]
}

/** The catalog of T and S, of the schema `app`, no view, and no trigger function. */
export const catalog: ReadCatalog = {
	table: (key) =>
		key === nameKey({ schema: "app", name: "t" })
			? tTable
			: key === nameKey({ schema: "app", name: "s" })
				? sTable
				: undefined,
	view: () => false,
	fired: () => undefined
}

/** The columns a case binds T at by a value its level fixes, each by a conjunct of T's WHERE. */
export type Fixed = "a" | "b" | "f" | "v" | "d"

/**
 * Where a case reads T: its level's own top; after S, joined to it at b; beneath S's EXISTS at a; through a window; or
 * inside groups by b, a derived table S is joined to at b, over T itself or over a MATERIALIZED CTE of T's rows.
 */
export type Place =
	| { readonly kind: "top" }
	| { readonly kind: "driven" }
	| { readonly kind: "sublink" }
	| { readonly kind: "window"; readonly at: "a" | "b" }
	| { readonly kind: "joined"; readonly over: "stored" | "cte" }

export interface BindCase {
	readonly place: Place
	readonly fixed: ReadonlyArray<Fixed>
	/** Whether T's level also orders its column b against a literal, `t.b > 7`, at the top alone. */
	readonly ranged: boolean
}

const fixedColumns = ["a", "b", "f", "v", "d"] as const satisfies ReadonlyArray<Fixed>

export const bindCaseGen: Gen<BindCase> = (source) => {
	const place = source.draw(
		element<Place>([
			{ kind: "top" },
			{ kind: "driven" },
			{ kind: "sublink" },
			{ kind: "window", at: "a" },
			{ kind: "window", at: "b" },
			{ kind: "joined", over: "stored" },
			{ kind: "joined", over: "cte" }
		])
	)
	return {
		place,
		fixed: place.kind === "window" ? [] : Arr.filter(fixedColumns, () => source.draw(boolean)),
		ranged: place.kind === "top" && source.draw(boolean)
	}
}

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
					whereOf(
						c.ranged ? [...fixed, binary(">", col("t", "b"), lit.int(7, types.integer))] : fixed
					),
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
				level.name.kind === "top" &&
				Arr.some(level.joined, (j) => j.join === "hash" && j.item.scan.kind === "rows")
		)
	}
}

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
	Arr.findFirst(
		Arr.flatMap(plan.levels, (level) => [...levelItems(level), ...level.appended]),
		(item) => item.alias === alias
	)

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
		case "top": {
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
