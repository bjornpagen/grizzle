/** What the properties of walk.test.ts read: its space and its oracle. */

import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	map,
	oneOf,
	recursive
} from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	type BindTermDesc,
	type ExprDesc,
	guardedExpr,
	type Inferred,
	type InferredExpr,
	type InferredQuery,
	type InferredSource,
	type Located
} from "#compiler/ir/desc.ts"

/** Every kind of expression, each once. */
const kindRoster: { readonly [K in ExprDesc["kind"]]: K } = {
	var: "var",
	field: "field",
	value: "value",
	parent: "parent",
	param: "param",
	literal: "literal",
	compute: "compute",
	cast: "cast",
	base: "base",
	guarded: "guarded",
	cond: "cond",
	when: "when",
	compare: "compare",
	between: "between",
	in: "in",
	and: "and",
	or: "or",
	not: "not",
	allen: "allen",
	pointIn: "pointIn",
	absent: "absent",
	exists: "exists",
	closedAt: "closedAt",
	closedRow: "closedRow",
	closedHas: "closedHas",
	call: "call"
}

export const exprKinds = Rec.values(kindRoster)

/**
 * What a case reached: each kind of expression it holds, a variable and a parameter only an imported query's bind map
 * reads, a relation parameter a bind map binds, and a variable an imported query reads in its own scope.
 */
export type Feature =
	| `holds ${ExprDesc["kind"]}`
	| "a variable only a bind map reads"
	| "a parameter only a bind map reads"
	| "a relation parameter bound"
	| "an import's own variable"

/** A few names, so one name stands for a variable, a field and a parameter in several places. */
const name = element(["a", "b", "c"])

const loc = SourceLoc("a walked expression", ["walk"])

const integer = { kind: "pg", type: "integer" } as const

const leaf: Gen<InferredExpr> = oneOf<InferredExpr>([
	map(name, (v) => ({ kind: "var", var: v })),
	map(name, (field) => ({ kind: "field", field })),
	constant({ kind: "value" }),
	map(name, (column) => ({ kind: "parent", column })),
	map(name, (n) => ({ kind: "param", name: n, type: integer })),
	constant({ kind: "literal", value: 1 })
])

/** A record over two names, each present or not, its values `value`'s. */
const record =
	<A>(value: Gen<A>): Gen<Readonly<Record<string, A>>> =>
	(source) =>
		Rec.fromEntries(
			Arr.flatMap(["a", "b"], (key) =>
				source.draw(boolean) ? [[key, source.draw(value)] as const] : []
			)
		)

/** A query of one rule in its own scope: a match's bindings, a condition and a head term, each of `inner`'s terms. */
const nested =
	(inner: Gen<InferredExpr>): Gen<InferredQuery> =>
	(source) => ({
		stage: {
			kind: "rules",
			loc,
			arms: [
				{
					vars: [],
					matches: [
						{ source: { kind: "relation", name: "R" }, bindings: source.draw(record(inner)), loc }
					],
					where: [source.draw(inner)],
					head: { h: source.draw(inner) },
					interiors: [],
					attach: [],
					loc
				}
			]
		}
	})

/** What a bind map binds a parameter to: a term of `inner`'s, or a relation parameter of the importer. */
const bound = (inner: Gen<InferredExpr>): Gen<BindTermDesc<Located, Inferred>> =>
	oneOf<BindTermDesc<Located, Inferred>>([
		inner,
		map(name, (n) => ({ kind: "relationParam", name: n }))
	])

/**
 * What an absent negates or an exists asks of: every kind of source, an imported query and a step with a bind map and
 * a scope of its own, and a call of a value argument and of rows of an imported query under a bind map.
 */
const sourceOf = (inner: Gen<InferredExpr>): Gen<InferredSource> =>
	oneOf<InferredSource>([
		constant({ kind: "relation", name: "R" }),
		(source) => ({
			kind: "query",
			query: source.draw(nested(inner)),
			bind: source.draw(record(bound(inner)))
		}),
		(source) => ({
			kind: "step",
			query: source.draw(nested(inner)),
			bind: source.draw(record(bound(inner)))
		}),
		map(name, (n) => ({ kind: "param", name: n, heading: { x: integer } })),
		map(name, (n) => ({ kind: "paramOf", name: n, relation: "R" })),
		constant({ kind: "interior", id: "i" }),
		constant({ kind: "self" }),
		constant({ kind: "delta", side: "added", relation: "R" }),
		constant({
			kind: "context",
			context: { name: "Session", fields: { x: integer }, claim: undefined }
		}),
		constant({ kind: "row", heading: { x: integer } }),
		(source) => ({
			kind: "call",
			function: "f",
			args: {
				v: source.draw(inner),
				r: {
					kind: "rows",
					query: source.draw(nested(inner)),
					bind: source.draw(record(bound(inner)))
				}
			}
		})
	])

/** One more level over `inner`: every kind that holds terms, each with its terms of `inner`'s. */
const node = (inner: Gen<InferredExpr>): Gen<InferredExpr> => {
	const some = array(inner, { min: 0, max: 3 })
	const nonEmpty: Gen<Arr.NonEmptyReadonlyArray<InferredExpr>> = (source) => [
		source.draw(inner),
		...source.draw(array(inner, { min: 0, max: 2 }))
	]
	return oneOf<InferredExpr>([
		map(some, (args) => ({ kind: "compute", fn: "add", args })),
		map(inner, (a) => ({ kind: "compute", fn: "round", args: [a], scale: 2 })),
		map(inner, (arg) => ({ kind: "cast", to: integer, arg })),
		map(inner, (arg) => ({ kind: "base", arg })),
		map(inner, (arg) => guardedExpr({ kind: "nonzero" }, arg)),
		(source) => ({
			kind: "cond",
			pred: source.draw(inner),
			onTrue: source.draw(inner),
			onFalse: source.draw(inner)
		}),
		(source) => ({
			kind: "when",
			guard: { kind: "nonzero" },
			subject: source.draw(inner),
			proved: source.draw(inner),
			otherwise: source.draw(inner)
		}),
		(source) => ({
			kind: "compare",
			op: "eq",
			left: source.draw(inner),
			right: source.draw(inner)
		}),
		(source) => ({
			kind: "between",
			arg: source.draw(inner),
			low: source.draw(inner),
			high: source.draw(inner)
		}),
		map(inner, (arg) => ({ kind: "in", arg, values: [1, 2] })),
		map(nonEmpty, (args) => ({ kind: "and", args })),
		map(nonEmpty, (args) => ({ kind: "or", args })),
		map(inner, (arg) => ({ kind: "not", arg })),
		(source) => ({ kind: "allen", left: source.draw(inner), mask: 1, right: source.draw(inner) }),
		(source) => ({ kind: "pointIn", point: source.draw(inner), span: source.draw(inner) }),
		(source) => ({
			kind: "absent",
			source: source.draw(sourceOf(inner)),
			bindings: source.draw(record(inner))
		}),
		(source) => ({
			kind: "exists",
			source: source.draw(sourceOf(inner)),
			bindings: source.draw(record(inner))
		}),
		map(nonEmpty, (args) => ({ kind: "closedAt", relation: "C", field: "f", args })),
		map(some, (args) => ({ kind: "closedRow", relation: "C", args })),
		map(nonEmpty, (args) => ({ kind: "closedHas", relation: "C", args })),
		map(record(inner), (args) => ({ kind: "call", function: "f", args }))
	])
}

/** Expressions at most three levels deep, of every kind, a leaf first so a failure shrinks toward one. */
export const exprs: Gen<InferredExpr> = recursive(leaf, node, 3)

/** A value's members that hold no expression of its scope: a cast's type, a literal's, a guard, an in's values. */
const termless: ReadonlySet<string> = new Set([
	"to",
	"type",
	"guard",
	"values",
	"heading",
	"context"
])

/** A node the oracle reached: whether it stands in the walked expression's own scope, and whether through a bind map. */
interface Site {
	readonly node: object
	readonly kind: unknown
	readonly own: boolean
	readonly bound: boolean
}

/**
 * The oracle: the nodes below `value`'s members, walked over the description's own values rather than by its kinds,
 * every one if `deep`, else the first on each path. Each object reachable is visited but through a member `termless`
 * names; one at an import's `query` member stands in a scope of its own, one at a `bind` member is bound, and an object
 * at a `source` member is a source, and a call's rows argument (kind "rows") the query and bind map it passes, never
 * a node.
 */
const sitesBelow = (value: object, deep: boolean): ReadonlyArray<Site> => {
	const out: Array<Site> = []
	const members = (v: object, own: boolean, bound: boolean): void => {
		for (const [key, member] of Rec.toEntries(v)) {
			if (!termless.has(key)) {
				reach(member, own && key !== "query", bound || key === "bind", key === "source")
			}
		}
	}
	const reach = (v: unknown, own: boolean, bound: boolean, isSource: boolean): void => {
		if (Arr.isArray(v)) {
			for (const item of v) {
				reach(item, own, bound, false)
			}
			return
		}
		if (v === null || typeof v !== "object") {
			return
		}
		const kind: unknown = Reflect.get(v, "kind")
		if (kind !== undefined && !isSource && kind !== "rows") {
			out.push({ node: v, kind, own, bound })
			if (!deep) {
				return
			}
		}
		members(v, own, bound)
	}
	members(value, true, false)
	return out
}

/** Every node `e` holds, itself among them, at any depth of its own scope or an import's. */
const sitesOf = (e: InferredExpr): ReadonlyArray<Site> => [
	{ node: e, kind: e.kind, own: true, bound: false },
	...sitesBelow(e, true)
]

const nameOf = (site: Site): unknown => Reflect.get(site.node, site.kind === "var" ? "var" : "name")

/** The names of the leaves of `kind` an expression holds: in its own scope (`own`), or in an import's (not `own`). */
export const leafNames = (
	e: InferredExpr,
	kind: "var" | "param" | "relationParam",
	own: boolean
): ReadonlySet<unknown> =>
	new Set(
		Arr.map(
			Arr.filter(sitesOf(e), (s) => s.kind === kind && s.own === own),
			nameOf
		)
	)

/** The kinds of every node `e` holds in its own scope. */
export const kindsIn = (e: InferredExpr): ReadonlySet<unknown> =>
	new Set(
		Arr.map(
			Arr.filter(sitesOf(e), (s) => s.own),
			(s) => s.kind
		)
	)

/** The names of the leaves of `kind` `e` reads in its own scope only through a bind map. */
export const bindOnly = (e: InferredExpr, kind: "var" | "param"): ReadonlySet<unknown> => {
	const own = Arr.filter(sitesOf(e), (s) => s.kind === kind && s.own)
	const unbound = new Set(
		Arr.map(
			Arr.filter(own, (s) => !s.bound),
			nameOf
		)
	)
	return new Set(Arr.filter(Arr.map(own, nameOf), (n) => !unbound.has(n)))
}

/**
 * The terms `e` holds directly, in the order its description states them, as the oracle walks its values: the first
 * node on each path from its own members, an imported query's and a relation parameter aside.
 */
export const directTerms = (e: InferredExpr): ReadonlyArray<unknown> =>
	Arr.map(
		Arr.filter(sitesBelow(e, false), (s) => s.own && s.kind !== "relationParam"),
		(s) => s.node
	)
