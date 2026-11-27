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
	type InferredHead,
	type InferredMatch,
	type InferredQuery,
	type InferredRule,
	type InferredSource,
	type InferredStage,
	type Located,
	type QueryStageDesc
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
	retype: "retype",
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
	call: "call",
	variant: "variant"
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

/** How a space holds each query it imports: as generated, or behind a tripwire (tripwire). */
type Imported = (q: InferredQuery) => InferredQuery

const asGenerated: Imported = (q) => q

/**
 * What an absent negates or an exists asks of: every kind of source, an imported query and a step with a bind map and
 * a scope of its own, and a call of a value argument and of rows of an imported query under a bind map, each imported
 * query held as `imported` holds it.
 */
const sourceOf = (inner: Gen<InferredExpr>, imported: Imported): Gen<InferredSource> =>
	oneOf<InferredSource>([
		constant({ kind: "relation", name: "R" }),
		(source) => ({
			kind: "query",
			query: imported(source.draw(nested(inner))),
			bind: source.draw(record(bound(inner)))
		}),
		(source) => ({
			kind: "step",
			query: imported(source.draw(nested(inner))),
			bind: source.draw(record(bound(inner)))
		}),
		map(name, (n) => ({ kind: "param", name: n, heading: { x: integer } })),
		map(name, (n) => ({ kind: "paramOf", name: n, relation: "R" })),
		constant({ kind: "interior", id: "i" }),
		constant({ kind: "self" }),
		constant({ kind: "delta", side: "added", relation: "R" }),
		constant({
			kind: "context",
			context: {
				name: "Session",
				fields: { x: integer },
				source: { kind: "token", claim: undefined }
			}
		}),
		constant({ kind: "row", heading: { x: integer } }),
		(source) => ({
			kind: "call",
			function: "f",
			args: {
				v: source.draw(inner),
				r: {
					kind: "rows",
					query: imported(source.draw(nested(inner))),
					bind: source.draw(record(bound(inner)))
				}
			}
		})
	])

/**
 * One more level over `inner`: every kind that holds terms, each with its terms of `inner`'s, each imported query held
 * as `imported` holds it.
 */
const node =
	(imported: Imported) =>
	(inner: Gen<InferredExpr>): Gen<InferredExpr> => {
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
				source: source.draw(sourceOf(inner, imported)),
				bindings: source.draw(record(inner))
			}),
			(source) => ({
				kind: "exists",
				source: source.draw(sourceOf(inner, imported)),
				bindings: source.draw(record(inner))
			}),
			map(nonEmpty, (args) => ({ kind: "closedAt", relation: "C", field: "f", args })),
			map(some, (args) => ({ kind: "closedRow", relation: "C", args })),
			map(nonEmpty, (args) => ({ kind: "closedHas", relation: "C", args })),
			map(record(inner), (args) => ({ kind: "call", function: "f", args })),
			map(inner, (arg) => ({ kind: "retype", to: integer, arg })),
			map(inner, (arg) => ({ kind: "variant", op: { kind: "tag" }, args: [arg] })),
			map(inner, (arg) => ({
				kind: "variant",
				op: { kind: "field", handle: "a", field: "b" },
				args: [arg]
			}))
		])
	}

/**
 * Expressions at most three levels deep, of every kind, a leaf first so a failure shrinks toward one, each imported
 * query held as `imported` holds it.
 */
const exprsHolding = (imported: Imported, depth: number): Gen<InferredExpr> =>
	recursive(leaf, node(imported), depth)

/** Expressions at most three levels deep, of every kind, a leaf first so a failure shrinks toward one. */
export const exprs: Gen<InferredExpr> = exprsHolding(asGenerated, 3)

/** A value's members that hold no expression of its scope: a cast's type, a literal's, a guard, an in's values, a
 * variant's operation. */
const termless: ReadonlySet<string> = new Set([
	"to",
	"type",
	"guard",
	"values",
	"heading",
	"context",
	"op"
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

/** The reads of the stage of any query a description imports: none, for a walk that never enters one. */
export interface ImportReads {
	count: number
}

/** `q` behind a tripwire: each read of its stage counted in `reads`. */
const tripwire =
	(reads: ImportReads): Imported =>
	(q) => ({
		get stage(): InferredStage {
			reads.count += 1
			return q.stage
		}
	})

/** A head term of every kind: a scalar term, a count, an aggregate of a term, and a producer of one and of two. */
const headTerm = (inner: Gen<InferredExpr>): Gen<InferredHead> =>
	oneOf<InferredHead>([
		inner,
		constant({ kind: "aggregate", fn: "count" }),
		map(inner, (arg) => ({ kind: "aggregate", fn: "sum", arg })),
		map(inner, (arg) => ({ kind: "producer", fn: "pack", args: [arg] })),
		(source) => ({
			kind: "producer",
			fn: "intersection",
			args: [source.draw(inner), source.draw(inner)]
		})
	])

/** At least one and at most two of `gen`'s. */
const oneOrTwo =
	<A>(gen: Gen<A>): Gen<Arr.NonEmptyReadonlyArray<A>> =>
	(source) => [source.draw(gen), ...source.draw(array(gen, { min: 0, max: 1 }))]

/**
 * A rule of every part: matches of every source, conditions and head terms of every kind of `inner`'s, and, where
 * `child` is given, an interior of one arm and an attachment of one of its queries, all in the rule's own namespace.
 */
const ruleOf = (
	inner: Gen<InferredExpr>,
	imported: Imported,
	child: Gen<InferredQuery> | undefined
): Gen<InferredRule> => {
	const match: Gen<InferredMatch> = (source) => ({
		source: source.draw(sourceOf(inner, imported)),
		bindings: source.draw(record(inner)),
		loc
	})
	const flat: Gen<InferredRule> = (source) => ({
		vars: [],
		matches: source.draw(array(match, { min: 0, max: 2 })),
		where: source.draw(array(inner, { min: 0, max: 2 })),
		head: source.draw(record(headTerm(inner))),
		interiors: [],
		attach: [],
		loc
	})
	if (child === undefined) {
		return flat
	}
	return (source) => ({
		...source.draw(flat),
		interiors: source.draw(
			array(
				map(flat, (arm) => ({ id: "i", arms: [arm] })),
				{ min: 0, max: 1 }
			)
		),
		attach: source.draw(
			array(
				map(child, (c) => ({ name: "a", child: c, loc })),
				{ min: 0, max: 1 }
			)
		)
	})
}

/** A take's bound: a literal, or a parameter. */
const takeBound: Gen<
	Extract<QueryStageDesc<Located, Inferred>, { readonly kind: "take" }>["take"]
> = oneOf<Extract<QueryStageDesc<Located, Inferred>, { readonly kind: "take" }>["take"]>([
	constant({ kind: "literal", k: 1 }),
	map(name, (n) => ({ kind: "param", name: n }))
])

/**
 * A query of every kind of stage over rules of `inner`'s terms: rules, a recursive definition, a union, a name, an
 * approximation, a take of an order, and, `depth` above zero, an attachment, whose child and whose rules' interiors and
 * attachments are queries `depth - 1` deep.
 */
const queryOf = (
	inner: Gen<InferredExpr>,
	imported: Imported,
	depth: number
): Gen<InferredQuery> => {
	const child = depth === 0 ? undefined : queryOf(inner, imported, depth - 1)
	const arms = oneOrTwo(ruleOf(inner, imported, child))
	const rules: Gen<InferredStage> = map(arms, (a) => ({ kind: "rules", arms: a, loc }))
	const recursiveStage: Gen<InferredStage> = (source) => ({
		kind: "recursive",
		recursive: { name: "r", row: {}, base: source.draw(arms), rec: source.draw(arms) },
		loc
	})
	const union: Gen<InferredStage> = (source) => ({
		kind: "union",
		input: source.draw(rules),
		arms: source.draw(arms),
		loc
	})
	const take: Gen<InferredStage> = (source) => ({
		kind: "take",
		input: { kind: "order", input: source.draw(rules), order: [], loc },
		take: source.draw(takeBound),
		loc
	})
	const flat: Arr.NonEmptyReadonlyArray<Gen<InferredStage>> = [
		rules,
		recursiveStage,
		union,
		map(rules, (input) => ({ kind: "named", input, name: "n", loc })),
		map(rules, (input) => ({ kind: "approx", input, by: "v", take: 1, loc })),
		take
	]
	if (child === undefined) {
		return map(oneOf<InferredStage>(flat), (stage) => ({ stage }))
	}
	const attach: Gen<InferredStage> = (source) => ({
		kind: "attach",
		input: source.draw(rules),
		attach: { name: "a", child: source.draw(child), loc }
	})
	const stages: Arr.NonEmptyReadonlyArray<Gen<InferredStage>> = [...flat, attach]
	return map(oneOf<InferredStage>(stages), (stage) => ({ stage }))
}

/** A query of every stage, its rules of every part, and the count of reads of the queries it imports. */
export interface WalkedQuery {
	readonly query: InferredQuery
	readonly reads: ImportReads
}

/**
 * Queries of every stage and every part of a rule, an attachment's child and an interior's arms among them, holding
 * expressions at most two levels deep of every kind, each imported query behind a tripwire counting the reads of its
 * stage (ImportReads), one count per case.
 */
export const walkedQueries: Gen<WalkedQuery> = (source) => {
	const reads: ImportReads = { count: 0 }
	const imported = tripwire(reads)
	return { query: source.draw(queryOf(exprsHolding(imported, 2), imported, 1)), reads }
}

/** An object a query's own namespace holds, by the oracle: its kind, and its name where it has one. */
export interface OwnSite {
	readonly kind: unknown
	readonly name: unknown
}

/**
 * The objects a query holds in its own namespace, by the oracle: each object with a kind its values reach outside an
 * imported query (a member `query`) and outside a member `termless` names, walked as data by no stage's, rule's or
 * source's spelling. It reads no imported query's stage.
 */
export const ownSites = (q: InferredQuery): ReadonlyArray<OwnSite> => {
	const out: Array<OwnSite> = []
	const reach = (v: unknown): void => {
		if (Arr.isArray(v)) {
			for (const item of v) {
				reach(item)
			}
			return
		}
		if (v === null || typeof v !== "object") {
			return
		}
		const kind: unknown = Reflect.get(v, "kind")
		if (kind !== undefined) {
			out.push({ kind, name: Reflect.get(v, "name") })
		}
		for (const [key, member] of Rec.toEntries(v)) {
			if (key !== "query" && !termless.has(key)) {
				reach(member)
			}
		}
	}
	reach(q)
	return out
}

/** The parameters a query reads in its own namespace, by the oracle: the name of each own site of kind param, paramOf or relationParam. */
export const ownParamNames = (q: InferredQuery): ReadonlySet<unknown> =>
	new Set(
		Arr.map(
			Arr.filter(
				ownSites(q),
				(site) => site.kind === "param" || site.kind === "paramOf" || site.kind === "relationParam"
			),
			(site) => site.name
		)
	)
