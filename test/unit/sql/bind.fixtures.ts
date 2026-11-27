/**
 * What the binding's property reads (bind.test.ts): its catalog of two stored tables, its space of statements over
 * them, each read of T stated where the binding meets it, and the read the specification says each binds.
 */

import { type Gen, boolean, element } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order } from "effect"
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
	derived,
	eq,
	exists,
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

export const bindFeatures = [
	"a seek at a literal",
	"a seek's range past its bound columns",
	"a whole read of few values alone",
	"a probe driven by an earlier item",
	"a seek at an enclosing level's column",
	"a seek beneath a window, at its partition",
	"a whole read beneath a window, at no partition",
	"an extension's equality bound",
	"a column no B-tree holds left a filter"
] as const

/**
 * T(a, b, f, v, d) keyed by a: a and b of many values, f of few (a roster's handle), v a vector, of many, which
 * pgvector's B-tree class keys by its own `=`, and d none a B-tree holds (a text of no byte bound); S(k, w) keyed by k.
 */
const tTable: BindTable = {
	relation: "T",
	columns: new Map([
		["a", { field: "a", holds: "many" }],
		["b", { field: "b", holds: "many" }],
		["f", { field: "f", holds: "few" }],
		["v", { field: "v", holds: "many" }]
	]),
	keys: [["a"]]
}

const sTable: BindTable = {
	relation: "S",
	columns: new Map([
		["k", { field: "k", holds: "many" }],
		["w", { field: "w", holds: "many" }]
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

/** Where a case reads T: its level's own top; after S, joined to it at b; beneath S's EXISTS at a; or through a window. */
export type Place =
	| { readonly kind: "top" }
	| { readonly kind: "driven" }
	| { readonly kind: "sublink" }
	| { readonly kind: "window"; readonly at: "a" | "b" }

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
			{ kind: "window", at: "b" }
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
 * item before it; a probe where one binding reads an item before it, every binding its index's; else a seek where one
 * bound column holds many values, every binding its index's; else whole. Beneath a window, the reader's equality binds T
 * only at a column every window partitions by.
 */
export const specified = (c: BindCase): SpecifiedRead => {
	const held = Arr.filter(c.fixed, (f) => f !== "d")
	const sorted = (columns: ReadonlyArray<string>) => Arr.sort(Arr.dedupe(columns), Order.String)
	switch (c.place.kind) {
		case "driven":
			return { kind: "index", probe: true, bound: sorted(["b", ...held]) }
		case "sublink":
			return { kind: "index", probe: false, bound: sorted(["a", ...held]) }
		case "window":
			return c.place.at === "a" ? { kind: "index", probe: false, bound: ["a"] } : { kind: "whole" }
		case "top":
			return Arr.some(held, (f) => f !== "f")
				? {
						kind: "index",
						probe: false,
						bound: c.ranged && !Arr.contains(held, "b") ? [...sorted(held), "b"] : sorted(held)
					}
				: { kind: "whole" }
	}
}
