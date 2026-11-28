/** What the properties of graph.test.ts read: its spaces, models and helpers. */

import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { type Gen, type GenValue, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { NodeId } from "#compiler/core/ids.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import { relNode, rooted, topoOrder } from "#compiler/ir/dag.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { makePassContext } from "#compiler/ir/pass.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { metaSpecOf, type NodeOf } from "#compiler/ir/rel.ts"
import { conjuncts } from "#compiler/logical/props.ts"
import type { OptimizedProgram } from "#compiler/lower/optimize/pipeline.ts"
import { Num, Type } from "#compiler/public/compute.ts"
import { Bits, closedId, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, contained, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { costChosen } from "#compiler/sql/emit.ts"
import { succeeded } from "#test/support/assert.ts"
import { lowerAligned } from "#test/support/compile.ts"
import { exactValue } from "#test/support/equivalence.ts"
import { genCatalog, ownedSchemaFixture } from "#test/support/evidence.ts"
import { Id } from "#test/support/ids.ts"
import { standInNames } from "#test/support/kernel/naming.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import { genParamDecls } from "#test/support/oracle/gen/query.ts"
import {
	defaultRecursiveLimits,
	type RecursiveCase,
	recursiveCaseSketchGen,
	type RecursiveLimits,
	vertexKinds
} from "#test/support/oracle/gen/recursive.ts"
import { schemaCodes } from "#test/support/oracle/gen/schema.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import { present } from "#test/support/unit/lower/support.ts"

/** The graph example's schema. */
const text = str.regex("^.*$", "su")

/** The network's people. */
const Person = relation("Person", { id: Id, name: text }, ["id"])

/** Who follows whom. */
const Follows = relation("Follows", { from: Id, to: Id }, ["from", "to"])

/** The network: people and follows, each end of a follow a person. */
const Network = schema(
	"Network",
	[Person, Follows],
	[contained(on(Follows, "from"), on(Person, "id")), contained(on(Follows, "to"), on(Person, "id"))]
)

/** A query value over the network, checked into its logical query. */
export const logical = (q: unknown): LogicalQuery => {
	const desc = queryValueDesc(q)
	if (desc === undefined) {
		throw new Error("not a query value")
	}
	return succeeded(checkQuery(checking(Network), desc, checkOptions("query")))
}

/** The network's own catalog, every key and containment named as ownership installs it. */
const network = ownedSchemaFixture(Network).catalog

/** A fresh pass context over the network's catalog in a snapshot. */
export const context = () =>
	makePassContext({
		evidenceContext: "snapshot",
		catalog: network
	})

/**
 * A generated case's physical names. Its text vertices carry a regex refinement, and the optimized delivery casts an
 * unproved refined output (a recordset parent key, a base-typed recursive state column) to the structural text domain
 * (lower/shapes/refined), so the names must name one, as an installation's InstallNames do.
 */
const caseNames = (schema: RecursiveCase["schema"]): PhysicalNames =>
	standInNames(schema.name, schemaCodes(schema))

/** The recursions of a query. */
const recursions = (q: LogicalQuery): ReadonlyArray<NodeOf<"Recursive">> =>
	Arr.filter(topoOrder(q.dag), (n): n is NodeOf<"Recursive"> => n.kind === "Recursive")

/** The Walks example: hops computed, the person advanced. */
const Walks = query(Network).recursive("Walks", {
	row: { person: Id, hops: pg.integer },
	base: [
		(r) => {
			const { id } = v(Person, "person")
			return r
				.match(Person, { id })
				.where(r.eq(id, r.param("start", Id)))
				.find({ person: id, hops: Type.literal(pg.integer, 0) })
		}
	],
	rec: [
		(r, self) => {
			const { person, hops } = v(self, "self")
			const { to } = v(Follows, "follows")
			return r
				.match(self, { person, hops })
				.match(Follows, { from: person, to })
				.match(Person, { id: to })
				.where(r.lt(hops, 4))
				.find({ person: to, hops: Num.add(hops, Type.literal(pg.integer, 1)) })
		}
	]
})

/** Every person with the people it reaches: the origin carried by the step, the person advanced. */
const Reach = query(Network).recursive("Reach", {
	row: { origin: Id, person: Id },
	base: [
		(r) => {
			const { id } = v(Person, "person")
			return r.match(Person, { id }).find({ origin: id, person: id })
		}
	],
	rec: [
		(r, self) => {
			const { origin, person } = v(self, "self")
			const { to } = v(Follows, "follows")
			return r
				.match(self, { origin, person })
				.match(Follows, { from: person, to })
				.find({ origin, person: to })
		}
	]
})

/**
 * A predicate on one column of a recursion: Reach's carried origin or advanced person, Walks' advanced person or
 * computed hops.
 */
export type Column = "Reach.origin" | "Reach.person" | "Walks.person" | "Walks.hops"

/**
 * Stated as a where over the match, or as a constant the match fixes the column to. A second import, matched beside
 * the first, is read by the same region and delivers nothing of its own.
 */
export type Spelling = "where" | "constant"

/**
 * The recursion read by the consumer alone, delivered as a root as well, read by another node too (a second root
 * ordering it), or imported twice with only the first import filtered, the two imports one node (check/checker.ts
 * importedKey).
 */
export type Sharing = "sole reader" | "also a root" | "read by another node" | "imported twice"

/** The query filtering one column of Reach or Walks as the spelling says, importing the recursion a second time where `twice`. */
export const pushQuery = (column: Column, spelling: Spelling, twice: boolean): unknown => {
	switch (column) {
		case "Reach.origin":
			return query(Network).rule((r) => {
				const { origin, person } = v(Reach, "reach")
				const { origin: o2 } = v(Reach, "second")
				const first =
					spelling === "where"
						? r.match(Reach, { origin, person }).where(r.eq(origin, r.param("p", Id)))
						: r.match(Reach, { origin: r.param("p", Id), person })
				return twice
					? first.match(Reach, { origin: o2, person }).find({ person })
					: first.find({ person })
			})
		case "Reach.person":
			return query(Network).rule((r) => {
				const { origin, person } = v(Reach, "reach")
				const { person: p2 } = v(Reach, "second")
				const first =
					spelling === "where"
						? r.match(Reach, { origin, person }).where(r.eq(person, r.param("p", Id)))
						: r.match(Reach, { origin, person: r.param("p", Id) })
				return twice
					? first.match(Reach, { origin, person: p2 }).find({ origin })
					: first.find({ origin })
			})
		case "Walks.person":
			return query(Network).rule((r) => {
				const walks = Walks.bind({ start: r.param("start", Id) })
				const again = Walks.bind({ start: r.param("start", Id) })
				const { person, hops } = v(walks, "walks")
				const { person: p2 } = v(again, "again")
				const first =
					spelling === "where"
						? r.match(walks, { person, hops }).where(r.eq(person, r.param("p", Id)))
						: r.match(walks, { person: r.param("p", Id), hops })
				return twice
					? first.match(again, { person: p2, hops }).find({ hops })
					: first.find({ hops })
			})
		case "Walks.hops":
			return query(Network).rule((r) => {
				const walks = Walks.bind({ start: r.param("start", Id) })
				const again = Walks.bind({ start: r.param("start", Id) })
				const { person, hops } = v(walks, "walks")
				const { hops: h2 } = v(again, "again")
				const first =
					spelling === "where"
						? r.match(walks, { person, hops }).where(r.eq(hops, Type.literal(pg.integer, 2)))
						: r.match(walks, { person, hops: Type.literal(pg.integer, 2) })
				return twice
					? first.match(again, { person, hops: h2 }).find({ person })
					: first.find({ person })
			})
	}
}

/**
 * The checked query with its one recursion read as the sharing states: a planted DAG, since no checked query delivers a
 * recursion it also filters.
 */
export const shared = (q: LogicalQuery, sharing: Sharing): LogicalQuery => {
	if (sharing === "sole reader" || sharing === "imported twice") {
		return q
	}
	const rec = present(recursions(q)[0], "the recursion")
	if (sharing === "also a root") {
		return { ...q, dag: rooted([q.dag.roots[0], rec]) }
	}
	const ordered = relNode(NodeId("n_ordered"), {
		kind: "OrderedResult",
		input: rec,
		orders: [{ keys: Arr.map(rec.heading, (c) => ({ column: c.name, dir: "asc" as const })) }],
		heading: rec.heading,
		meta: metaSpecOf(rec.meta),
		loc: undefined
	})
	return { ...q, dag: validateDag(rooted([q.dag.roots[0], ordered])) }
}

/** How many of the rules are seed pushdowns. */
export const seedPushdowns = (rules: ReadonlyArray<CertificateRule>): number =>
	Arr.filter(rules, (r) => Str.startsWith("graph.seedPushdown.")(r)).length

/**
 * A graph between closed ids: Kind's handles linked by Link, the zones each kind is allowed in, and two weights per
 * kind, so a predicate on a kind reads a closed relation's field, a key's completions or a key's presence.
 */
const Kind = closed.ordered("Kind", ["a", "b", "c"])

/** The zones a kind may be allowed in. */
const Zone = closed.ordered("Zone", ["north", "south"])

/** The zones each kind is allowed in. */
const Allowed = closed.relation(
	"Allowed",
	{ zone: closedId(Zone), kind: closedId(Kind) },
	["zone", "kind"],
	[
		{ zone: "north", kind: "a" },
		{ zone: "north", kind: "b" },
		{ zone: "south", kind: "b" },
		{ zone: "south", kind: "c" }
	]
)

/** Two weights per kind. */
const Weight = closed.relation(
	"Weight",
	{ kind: closedId(Kind), light: pg.integer, heavy: pg.integer },
	["kind"],
	[
		{ kind: "a", light: 1, heavy: 2 },
		{ kind: "b", light: 2, heavy: 1 },
		{ kind: "c", light: 1, heavy: 1 }
	]
)

/** The links between kinds. */
const Link = relation("Link", { from: closedId(Kind), to: closedId(Kind) }, ["from", "to"])

/** The graph between closed ids. */
export const Kinds = schema("Kinds", [Kind, Zone, Allowed, Weight, Link], [])

/** Every kind with the kinds it reaches: the origin carried by the step, the kind advanced. */
const KindReach = query(Kinds).recursive("KindReach", {
	row: { origin: closedId(Kind), kind: closedId(Kind) },
	base: [
		(r) => {
			const { from } = v(Link, "link")
			return r.match(Link, { from }).find({ origin: from, kind: from })
		}
	],
	rec: [
		(r, self) => {
			const { origin, kind } = v(self, "self")
			const { to } = v(Link, "link")
			return r
				.match(self, { origin, kind })
				.match(Link, { from: kind, to })
				.find({ origin, kind: to })
		}
	]
})

/**
 * The part two conjuncts on the carried origin differ in: a literal, a parameter, the operator, the field a closed read
 * reads, or the key of a closed relation's completions or presence.
 */
export type Part = "literal" | "parameter" | "operator" | "field" | "completions" | "presence"

/** One conjunct, or both of a part's two. */
export type Conjuncts = "one" | "two"

/** The query filtering KindReach's origin by the part's first conjunct, or by both. */
export const alikeQuery = (part: Part, conjuncts: Conjuncts): unknown =>
	query(Kinds).rule((r) => {
		const { origin, kind } = v(KindReach, "reach")
		const pair = (() => {
			switch (part) {
				case "literal":
					return [r.eq(origin, "a"), r.eq(origin, "b")] as const
				case "parameter":
					return [
						r.eq(origin, r.param("p", Link.fields.from)),
						r.eq(origin, r.param("q", Link.fields.from))
					] as const
				case "operator":
					return [r.eq(origin, "a"), r.ne(origin, "a")] as const
				case "field":
					return [r.eq(Weight.at("light", origin), 1), r.eq(Weight.at("heavy", origin), 1)] as const
				case "completions":
					return [
						r.eq(Bits.subset(Bits.singleton(origin), Allowed.row("north")), true),
						r.eq(Bits.subset(Bits.singleton(origin), Allowed.row("south")), true)
					] as const
				case "presence":
					return [Allowed.has("north", origin), Allowed.has("south", origin)] as const
			}
		})()
		const [first, second] = pair
		return r
			.match(KindReach, { origin, kind })
			.where(conjuncts === "one" ? first : r.and([first, second]))
			.find({ kind })
	})

/** The graph's own catalog, as ownership installs it. */
export const kindsCatalog = ownedSchemaFixture(Kinds).catalog

/** What the Network pushdown reaches: each spelling moved or kept, and each sharing kept. */
export type PushFeature = `${"moved" | "kept"} ${Spelling}` | `${Sharing} kept`

/** A generated recursive case's sketch. */
type RecursiveCaseSketch = GenValue<typeof recursiveCaseSketchGen>

/** A drawn case with its recursion's form and consumer set by their places in the forms and the consumer list. */
const formAndConsumer =
	(form: number, consumer: number): Gen<RecursiveCaseSketch> =>
	(source) => {
		const sketch = source.draw(recursiveCaseSketchGen)
		return { ...sketch, recursion: { ...sketch.recursion, form, consumer } }
	}

/** A drawn case over float8 vertices, which the drawn vertex kinds, led by int4, rarely are. */
const overFloat8: Gen<RecursiveCaseSketch> = (source) => {
	const sketch = source.draw(recursiveCaseSketchGen)
	return { ...sketch, graph: { ...sketch.graph, vertexKind: vertexKinds.indexOf("float8") } }
}

/** The origin filter's cases: one drawn case in four over float8 vertices. */
export const originFilterSketches: Gen<RecursiveCaseSketch> = weighted([
	[3, recursiveCaseSketchGen],
	[1, overFloat8]
])

/** The limits the origin filter's cases resolve under: an origin filter reads each recursion. */
export const originFilterLimits: RecursiveLimits = {
	...defaultRecursiveLimits,
	consumers: ["originFilter"]
}

/** The consumers besides the origin filter: the pass fires no rule over any of them. */
const otherConsumers: RecursiveLimits["consumers"] = [
	"endFilter",
	"endNe",
	"minLength",
	"state",
	"endpoints"
]

/**
 * Walks read by a minimum length, which the forms and consumers drawn freely pair about one case in fifteen, so one
 * drawn case in four pairs them.
 */
export const otherConsumerSketches: Gen<RecursiveCaseSketch> = weighted([
	[3, recursiveCaseSketchGen],
	[
		1,
		formAndConsumer(
			defaultRecursiveLimits.forms.indexOf("walks"),
			otherConsumers.indexOf("minLength")
		)
	]
])

/** The limits the other consumers' cases resolve under. */
export const otherConsumerLimits: RecursiveLimits = {
	...defaultRecursiveLimits,
	consumers: otherConsumers
}

/**
 * Where a generated origin filter's recursion's seed applied it: over any vertex type, and over double precision, the
 * type the seed once refused because equal values could print apart.
 */
export type GraphFeature =
	| "the seed applies an origin filter"
	| "the seed applies an origin filter over double precision"

/** The pass context of a generated case: its own catalog. */
export const caseContext = (c: RecursiveCase) =>
	makePassContext({
		evidenceContext: "snapshot",
		catalog: genCatalog(c.schema)
	})

/** Two scalar expressions alike but for the nodes they read: the same tree and types, each column by its name. */
const alikeByName = (x: ScalarExpr, y: ScalarExpr): boolean => {
	if (
		x.kind !== y.kind ||
		x.args.length !== y.args.length ||
		Option.isSome(exactValue(x.type, y.type)) ||
		!Arr.every(x.args, (a, i) => {
			const b = y.args[i]
			return b !== undefined && alikeByName(a, b)
		})
	) {
		return false
	}
	switch (x.kind) {
		case "column":
			return y.kind === "column" && x.column.name === y.column.name
		case "param":
			return y.kind === "param" && x.param === y.param && x.role === y.role
		case "literal":
			return y.kind === "literal" && Option.isNone(exactValue(x.value, y.value))
		case "op":
			return y.kind === "op" && x.op === y.op
		case "cast":
			return y.kind === "cast" && x.cast === y.cast
		case "closedAt":
			return y.kind === "closedAt" && x.relation === y.relation && x.field === y.field
		case "closedRow":
			return y.kind === "closedRow" && x.relation === y.relation
		case "closedHas":
			return y.kind === "closedHas" && x.relation === y.relation
		case "call":
			return y.kind === "call" && x.function.definition === y.function.definition
		case "value":
		case "domainCast":
		case "cond":
			return true
		case "variant":
			return y.kind === "variant" && x.op.kind === y.op.kind
	}
}

/** The column references an expression reads. */
const columnsRead = (e: ScalarExpr): ReadonlyArray<NodeId> =>
	e.kind === "column" ? [e.column.node] : Arr.flatMap(e.args, columnsRead)

/** The conjuncts of the filters stacked at a recursion's base, outermost first. */
const seedConjuncts = (r: NodeOf<"Recursive">): ReadonlyArray<ScalarExpr> => {
	const out: Array<ScalarExpr> = []
	for (let n = r.base; n.kind === "Filter"; n = n.input) {
		appendAll(out, conjuncts(n.pred))
	}
	return out
}

/**
 * For each filter over a recursion in the query, whether the recursion's seed applies it: every conjunct that reads the
 * recursion's columns alone is, by column name, a conjunct of a filter stacked at the recursion's base.
 */
export const seedApplications = (q: LogicalQuery): ReadonlyArray<"applied" | "not applied"> =>
	Arr.flatMap(topoOrder(q.dag), (n) => {
		if (n.kind !== "Filter" || n.input.kind !== "Recursive") {
			return []
		}
		const recursion = n.input
		const seed = seedConjuncts(recursion)
		const own = Arr.filter(conjuncts(n.pred), (p) => {
			const read = columnsRead(p)
			return Arr.isReadonlyArrayNonEmpty(read) && Arr.every(read, (id) => id === recursion.id)
		})
		return [
			Arr.every(own, (p) => Arr.some(seed, (s) => alikeByName(p, s))) ? "applied" : "not applied"
		]
	})

/** A generated case's query, its DAG validated, its parameters declared. */
export const generatedQuery = (c: RecursiveCase): LogicalQuery => ({
	dag: validateDag(c.query.dag),
	params: genParamDecls(c.query)
})

/** The optimized program of a generated case, aligned with its conservative program. */
export const optimizedOf = (c: RecursiveCase): OptimizedProgram => {
	const r = lowerAligned(generatedQuery(c), "query", {
		binding: costChosen,
		names: caseNames(c.schema),
		context: "snapshot",
		catalog: genCatalog(c.schema)
	})
	if (!r.ok) {
		throw new Error(`${c.label}: ${r.error.message}`)
	}
	return r.value
}

/** The graph rules an optimized program's certificates record. */
export const graphRules = (optimized: OptimizedProgram): ReadonlyArray<CertificateRule> =>
	Arr.filter(
		Arr.map(optimized.certificates, (x) => x.rule),
		(x) => Str.startsWith("graph.")(x)
	)
