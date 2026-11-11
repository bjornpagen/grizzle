/**
 * Proved root pushdown (lower/optimize/graph/seed.ts) and the carried columns it rests on
 * (shapes/attach-recursive/carried.ts). The PostgreSQL agreement of every rewrite here is test/pg/recursion/graph.
 *
 * - A carried column is a state column the step delivers unchanged from the state it extends: over generated
 *   recursions, exactly the origin the generator's recursion keeps (a walk's or reach's origin column, a pair closure's
 *   fixed end), never the advanced endpoint or a computed counter; and every generated recursion is positive linear.
 * - A predicate moves into a recursion's seed exactly when it reads only a carried column and the recursion has no
 *   other reader: exhausted over the Network example (each recursion, column, spelling of the predicate and sharing),
 *   where a recursion also delivered as a root, read by another node, or a second import left unfiltered never moves;
 *   the pass leaves a query it moves nothing in as it was, and is idempotent.
 * - Two conjuncts on a carried column alike but for one part, a literal, a parameter, an operator, a closed relation's
 *   field or a closed read's key, are two predicates: over a reach between closed ids, each is moved into the seed, the
 *   second whatever the first placed there, and one conjunct is moved once.
 * - Over generated origin filters of every vertex type, double precision included, the recursion's seed applies the
 *   filter after the pass, whether the pass placed it there or the seed applied it already, and the pass is
 *   idempotent; over generated recursions read by every other consumer, the pass fires no rule.
 *
 * Oracle: the generator's own model of the recursion it built (the origin it keeps, the consumer that reads it), and
 * the carried-column rule as a checker over the planted spaces (specifications). A pass's output is compared to its
 * input by canonical structure, never by object identity.
 *
 * Features: each recursion form, origin and linearity; each spelling moved or kept and each sharing kept; one conjunct
 * or two moved; an origin filter applied over any vertex type and over double precision; each other consumer.
 *
 * Plants, each failing its search: every state column carried (graph-carried-all); a recursion read by another node
 * restricted at its seed (graph-sole-reader); two literals alike to the seed whatever their values
 * (graph-alike-literal); a double precision origin never restrictable (graph-float8-origin); every state column of a
 * recursion restrictable, the advanced endpoint included (graph-restrict-endpoint).
 */
import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore, type Kept, sketched } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, type GenValue, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { appendAll } from "#compiler/core/array.ts"
import { canonicalEquals, everyProperty } from "#compiler/core/canonical.ts"
import { NodeId } from "#compiler/core/ids.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import { relNode, rooted, topoOrder } from "#compiler/ir/dag.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { makePassContext } from "#compiler/ir/pass.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { metaSpecOf, type NodeOf } from "#compiler/ir/rel.ts"
import { conjuncts } from "#compiler/logical/props.ts"
import { graphPass } from "#compiler/lower/optimize/graph/index.ts"
import type { OptimizedProgram } from "#compiler/lower/optimize/pipeline.ts"
import { carriedColumns, positiveLinear } from "#compiler/lower/shapes/attach-recursive/carried.ts"
import { Compute } from "#compiler/public/compute.ts"
import { closedId, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, contained, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { assert, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { lowerAligned } from "#test/support/compile.ts"
import { exactValue } from "#test/support/equivalence.ts"
import { genCatalog, ownedSchemaFixture } from "#test/support/evidence.ts"
import { standInNames } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import { genParamDecls } from "#test/support/oracle/gen/query.ts"
import {
	defaultRecursiveLimits,
	firstGraphSketch,
	firstRecursionSketch,
	type RecursiveCase,
	type RecursiveFeature,
	type RecursiveLimits,
	recursiveCaseGen,
	recursiveCaseSketchGen,
	resolveRecursiveCase,
	vertexKinds
} from "#test/support/oracle/gen/recursive.ts"
import { schemaCodes } from "#test/support/oracle/gen/schema.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import { nodeOfKind, present } from "#test/unit/lower/support.ts"

/** The graph example's schema. */
const text = str.regex("^.*$", "su")
const Person = relation("Person", { id: uuid, name: text }, ["id"])
const Follows = relation("Follows", { from: uuid, to: uuid }, ["from", "to"])
const Network = schema("Network", { Person, Follows }, [
	contained(on(Follows, "from"), on(Person, "id")),
	contained(on(Follows, "to"), on(Person, "id"))
])

const logical = (q: unknown): LogicalQuery => {
	const desc = queryValueDesc(q)
	if (desc === undefined) {
		throw new Error("not a query value")
	}
	return succeeded(checkQuery(checking(Network), desc, checkOptions("query")))
}

/** The network's own catalog, every key and containment named as ownership installs it. */
const network = ownedSchemaFixture(Network).catalog

const context = () =>
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

const recursions = (q: LogicalQuery): ReadonlyArray<NodeOf<"Recursive">> =>
	Arr.filter(topoOrder(q.dag), (n): n is NodeOf<"Recursive"> => n.kind === "Recursive")

describe("carried state columns (shapes/attach-recursive/carried.ts)", () => {
	it.effect(
		"on generated recursions, carries exactly the origin the recursion keeps, and every one is positive linear",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the origin the generator's recursion keeps, and positive linear feedback"
						},
						suite: "unit/lower/graph/carried",
						draw: drawn(recursiveCaseGen({ ...defaultRecursiveLimits, consumers: ["state"] })),
						literal: Formatter.format,
						coverage: required<RecursiveFeature>(
							["form:reach", "form:walks", "form:pairs", "origin", "left-linear", "right-linear"],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, note) =>
						Effect.sync(() => {
							const q = { dag: validateDag(c.query.dag), params: genParamDecls(c.query) }
							/** The state consumer delivers the case's recursion itself; a stratum it negates is another recursion. */
							const recursion = nodeOfKind(q.dag.roots[0], "Recursive")
							/** The end a pair closure's step keeps, or the origin a walk or a reach carries from its seed. */
							const parts = c.parts
							const kept =
								parts.form === "pairs"
									? [parts.leftLinear ? "dst" : "src"]
									: parts.origin
										? ["origin"]
										: []
							unorderedEqual([...carriedColumns(recursion)], kept, c.label)
							assert.equal(positiveLinear(recursion), true, c.label)
							note.noteAll(c.features)
						})
				)
			)
	)
})

/** The Walks example: hops computed, the person advanced. */
const Walks = query(Network).recursive("Walks", {
	row: { person: uuid, hops: pg.integer },
	base: [
		(r) => {
			const { id } = v(Person, "person")
			return r
				.match(Person, { id })
				.where(r.eq(id, r.param("start", uuid)))
				.find({ person: id, hops: Compute.literal(pg.integer, 0) })
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
				.find({ person: to, hops: Compute.add(hops, Compute.literal(pg.integer, 1)) })
		}
	]
})

/** Every person with the people it reaches: the origin carried by the step, the person advanced. */
const Reach = query(Network).recursive("Reach", {
	row: { origin: uuid, person: uuid },
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
type Column = "Reach.origin" | "Reach.person" | "Walks.person" | "Walks.hops"
/**
 * Stated as a where over the match, or as a constant the match fixes the column to. A second import, matched beside
 * the first, is read by the same region and delivers nothing of its own.
 */
type Spelling = "where" | "constant"
/**
 * The recursion read by the consumer alone, delivered as a root as well, read by another node too (a second root
 * ordering it), or imported twice with only the first import filtered.
 */
type Sharing = "sole reader" | "also a root" | "read by another node" | "imported twice"

const pushQuery = (column: Column, spelling: Spelling, twice: boolean): unknown => {
	switch (column) {
		case "Reach.origin":
			return query(Network).rule((r) => {
				const { origin, person } = v(Reach, "reach")
				const { origin: o2 } = v(Reach, "second")
				const first =
					spelling === "where"
						? r.match(Reach, { origin, person }).where(r.eq(origin, r.param("p", uuid)))
						: r.match(Reach, { origin: r.param("p", uuid), person })
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
						? r.match(Reach, { origin, person }).where(r.eq(person, r.param("p", uuid)))
						: r.match(Reach, { origin, person: r.param("p", uuid) })
				return twice
					? first.match(Reach, { origin, person: p2 }).find({ origin })
					: first.find({ origin })
			})
		case "Walks.person":
			return query(Network).rule((r) => {
				const walks = Walks.bind({ start: r.param("start", uuid) })
				const again = Walks.bind({ start: r.param("start", uuid) })
				const { person, hops } = v(walks, "walks")
				const { person: p2 } = v(again, "again")
				const first =
					spelling === "where"
						? r.match(walks, { person, hops }).where(r.eq(person, r.param("p", uuid)))
						: r.match(walks, { person: r.param("p", uuid), hops })
				return twice
					? first.match(again, { person: p2, hops }).find({ hops })
					: first.find({ hops })
			})
		case "Walks.hops":
			return query(Network).rule((r) => {
				const walks = Walks.bind({ start: r.param("start", uuid) })
				const again = Walks.bind({ start: r.param("start", uuid) })
				const { person, hops } = v(walks, "walks")
				const { hops: h2 } = v(again, "again")
				const first =
					spelling === "where"
						? r.match(walks, { person, hops }).where(r.eq(hops, Compute.literal(pg.integer, 2)))
						: r.match(walks, { person, hops: Compute.literal(pg.integer, 2) })
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
const shared = (q: LogicalQuery, sharing: Sharing): LogicalQuery => {
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
		order: { keys: Arr.map(rec.heading, (c) => ({ column: c.name, dir: "asc" as const })) },
		heading: rec.heading,
		meta: metaSpecOf(rec.meta),
		loc: undefined
	})
	return { ...q, dag: validateDag(rooted([q.dag.roots[0], ordered])) }
}

const seedPushdowns = (rules: ReadonlyArray<CertificateRule>): number =>
	Arr.filter(rules, (r) => Str.startsWith("graph.seedPushdown.")(r)).length

/**
 * A graph between closed ids: Kind's handles linked by Link, the zones each kind is allowed in, and two weights per
 * kind, so a predicate on a kind reads a closed relation's field, a key's completions or a key's presence.
 */
const Kind = closed("Kind", ["a", "b", "c"])
const Zone = closed("Zone", ["north", "south"])
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
const Link = relation("Link", { from: closedId(Kind), to: closedId(Kind) }, ["from", "to"])
const Kinds = schema("Kinds", { Kind, Zone, Allowed, Weight, Link }, [])

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
type Part = "literal" | "parameter" | "operator" | "field" | "completions" | "presence"
/** One conjunct, or both of a part's two. */
type Conjuncts = "one" | "two"

/** The query filtering KindReach's origin by the part's first conjunct, or by both. */
const alikeQuery = (part: Part, conjuncts: Conjuncts): unknown =>
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
						r.eq(Compute.subset(Compute.singleton(origin), Allowed.row("north")), true),
						r.eq(Compute.subset(Compute.singleton(origin), Allowed.row("south")), true)
					] as const
				case "presence":
					return [Allowed.has("north", origin), Allowed.has("south", origin)] as const
			}
		})()
		const [first, second] = pair
		return r
			.match(KindReach, { origin, kind })
			.where(conjuncts === "one" ? first : r.and(first, second))
			.find({ kind })
	})

const kindsCatalog = ownedSchemaFixture(Kinds).catalog

type PushFeature = `${"moved" | "kept"} ${Spelling}` | `${Sharing} kept`

type RecursiveCaseSketch = GenValue<typeof recursiveCaseSketchGen>

/** A drawn case with its recursion's form and consumer set by their places in the forms and the consumer list. */
const formAndConsumer =
	(form: number, consumer: number): Gen<RecursiveCaseSketch> =>
	(source) => {
		const sketch = source.draw(recursiveCaseSketchGen)
		return { ...sketch, recursion: { ...sketch.recursion, form, consumer } }
	}

/**
 * The cases of a consumer list drawn by `sketch`, and its planted cases: each a smallest graph of a vertex kind, its
 * recursion of a form and a consumer, by their places in the kinds, the forms and the consumer list.
 */
const cases = <F extends RecursiveFeature | GraphFeature>(
	consumers: RecursiveLimits["consumers"],
	sketch: Gen<RecursiveCaseSketch>,
	kept: ReadonlyArray<{
		readonly note: string
		readonly vertexKind: number
		readonly form: number
		readonly consumer: number
		readonly reaches: Arr.NonEmptyReadonlyArray<F>
	}>
) => {
	const limits: RecursiveLimits = { ...defaultRecursiveLimits, consumers }
	return {
		draw: sketched(sketch, (drawn) => resolveRecursiveCase(drawn, limits, "unmutated")),
		kept: Arr.map(kept, (k): Kept<RecursiveCaseSketch, F> => ({
			note: k.note,
			sketch: {
				graph: { ...firstGraphSketch, vertexKind: k.vertexKind },
				recursion: { ...firstRecursionSketch, form: k.form, consumer: k.consumer },
				spelling: [0, 0, 0, 0, 0, 0, 0, 0]
			},
			draws: "",
			reaches: k.reaches
		}))
	}
}

/** A drawn case over float8 vertices, which the drawn vertex kinds, led by int4, rarely are. */
const overFloat8: Gen<RecursiveCaseSketch> = (source) => {
	const sketch = source.draw(recursiveCaseSketchGen)
	return { ...sketch, graph: { ...sketch.graph, vertexKind: vertexKinds.indexOf("float8") } }
}

/** The origin filter's cases: one drawn case in four over float8 vertices, and a closure over them planted. */
const originFilterCases = cases<GraphFeature>(
	["originFilter"],
	weighted([
		[3, recursiveCaseSketchGen],
		[1, overFloat8]
	]),
	[
		{
			note: "an origin filter over float8",
			vertexKind: vertexKinds.indexOf("float8"),
			form: 0,
			consumer: 0,
			reaches: ["the seed applies an origin filter over double precision"]
		}
	]
)

/** The consumers besides the origin filter: the pass fires no rule over any of them. */
const otherConsumers: RecursiveLimits["consumers"] = [
	"endFilter",
	"endNe",
	"minLength",
	"state",
	"endpoints"
]

/**
 * Kept: a pair closure from a literal root its origin filter names again, whose seed may apply the filter already, so
 * the seed applies it after the pass whether the pass moves it or not.
 */
const restatedRoots: Kept<RecursiveCaseSketch, GraphFeature> = {
	note: "a pair closure from a literal root its origin filter names again",
	sketch: {
		graph: {
			shape: 0,
			vertexKind: 0,
			size: 0,
			offset: 0,
			keyed: false,
			contained: true,
			parents: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
			extra: [],
			loops: [],
			parallel: [],
			missing: 0,
			second: false,
			secondEdges: [],
			blocked: []
		},
		recursion: {
			form: 2,
			roots: 1,
			rootPicks: [0],
			origin: false,
			oneOrMore: false,
			direction: 0,
			viaSecond: false,
			exists: false,
			blocking: 0,
			stepFilter: 0,
			filterPick: 0,
			hopKind: 0,
			bound: 0,
			lower: 0,
			leftLinear: false,
			consumer: 0,
			endPick: 0,
			endParam: false,
			paramNames: [0, 0, 0, 0]
		},
		spelling: [0, 0, 0, 0, 0, 0, 0, 0]
	},
	draws: "",
	reaches: ["the seed applies an origin filter"]
}

describe("proved root pushdown (graph.seedPushdown)", () => {
	it.effect(
		"moves a predicate on a carried column of a recursion its consumer alone reads, and nothing else",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "each of four columns of Reach and Walks, each spelling of the predicate, each sharing of the recursion",
						oracle: {
							kind: "specification",
							name: "a predicate on a carried column of a recursion its consumer alone reads moves, and nothing else"
						},
						suite: "unit/lower/graph/pushdown",
						generator: (source) =>
							[
								source.draw(
									element<Column>(["Reach.origin", "Reach.person", "Walks.person", "Walks.hops"])
								),
								source.draw(element<Spelling>(["where", "constant"])),
								source.draw(
									element<Sharing>([
										"sole reader",
										"also a root",
										"read by another node",
										"imported twice"
									])
								)
							] as const,
						literal: Formatter.format,
						limit: 32,
						coverage: requiredInSpace<PushFeature>([
							"moved where",
							"moved constant",
							"kept where",
							"kept constant",
							"also a root kept",
							"read by another node kept"
						]),
						caseHang
					},
					([column, spelling, sharing], c) =>
						Effect.sync(() => {
							const checked = logical(pushQuery(column, spelling, sharing === "imported twice"))
							const q = shared(checked, sharing)
							/** Each import is its own recursion; only the one the consumer alone filters, on its carried origin, moves. */
							const moves =
								column === "Reach.origin" &&
								(sharing === "sole reader" || sharing === "imported twice")
									? 1
									: 0
							const ctx = context()
							const once = succeeded(graphPass.run(q, ctx))
							const rules = Arr.map(ctx.certificates.all(), (x) => x.rule)
							assert.equal(seedPushdowns(rules), moves)
							assert.equal(
								canonicalEquals(once, q, everyProperty),
								moves === 0,
								"the query is as it was exactly where nothing moves"
							)
							assert.ok(
								canonicalEquals(succeeded(graphPass.run(once, context())), once, everyProperty),
								"idempotent"
							)
							c.note(`${moves === 1 ? "moved" : "kept"} ${spelling}`)
							if (moves === 0 && column === "Reach.origin") {
								c.note(`${sharing} kept`)
							}
						})
				)
			)
	)

	it.effect(
		"moves each of two conjuncts alike but for one part into the seed, and one conjunct once",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "each part two conjuncts on the carried origin differ in, one conjunct or both",
						oracle: {
							kind: "specification",
							name: "every conjunct on the carried origin moves, once"
						},
						suite: "unit/lower/graph/alike-conjuncts",
						generator: (source) =>
							[
								source.draw(
									element<Part>([
										"literal",
										"parameter",
										"operator",
										"field",
										"completions",
										"presence"
									])
								),
								source.draw(element<Conjuncts>(["one", "two"]))
							] as const,
						literal: Formatter.format,
						limit: 12,
						coverage: requiredInSpace<`${Conjuncts} moved`>(["one moved", "two moved"]),
						caseHang
					},
					([part, conjuncts], c) =>
						Effect.sync(() => {
							const desc = queryValueDesc(alikeQuery(part, conjuncts))
							if (desc === undefined) {
								throw new Error("not a query value")
							}
							const q = succeeded(checkQuery(checking(Kinds), desc, checkOptions("query")))
							const passContext = () =>
								makePassContext({ evidenceContext: "snapshot", catalog: kindsCatalog })
							const run = passContext()
							const once = succeeded(graphPass.run(q, run))
							assert.equal(
								seedPushdowns(Arr.map(run.certificates.all(), (x) => x.rule)),
								conjuncts === "one" ? 1 : 2,
								`${part}: every conjunct on the carried origin moves`
							)
							assert.ok(
								canonicalEquals(succeeded(graphPass.run(once, passContext())), once, everyProperty),
								"idempotent"
							)
							c.note(`${conjuncts} moved`)
						})
				)
			)
	)

	it.effect(
		"on generated cases, applies an origin filter of every vertex type in the seed, and fires on nothing else",
		(ctx) =>
			searched(
				ctx,
				Effect.andThen(
					explore(
						{
							oracle: {
								kind: "specification",
								name: "the seed applies every conjunct of an origin filter that reads the recursion alone"
							},
							suite: "unit/lower/graph/origin-filter",
							draw: originFilterCases.draw,
							kept: [...originFilterCases.kept, restatedRoots],
							literal: Formatter.format,
							runs: 60,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang,
							coverage: required<GraphFeature>(
								[
									"the seed applies an origin filter",
									"the seed applies an origin filter over double precision"
								],
								{ cases: 60, sense: notesOnly }
							)
						},
						(q, c) =>
							Effect.sync(() => {
								const once = succeeded(graphPass.run(generatedQuery(q), caseContext(q)))
								assert.deepEqual(
									Arr.dedupe(seedApplications(once)),
									["applied"],
									`${q.label}: the seed applies the origin filter`
								)
								assert.ok(
									canonicalEquals(
										succeeded(graphPass.run(once, caseContext(q))),
										once,
										everyProperty
									),
									`${q.label}: idempotent`
								)
								c.note(
									q.graph.kind === "float8"
										? "the seed applies an origin filter over double precision"
										: "the seed applies an origin filter"
								)
							})
					),
					explore(
						{
							oracle: {
								kind: "specification",
								name: "no graph rule fires on a recursion read by any consumer but an origin filter"
							},
							/**
							 * Planted: walks read by a minimum length, which the forms and consumers drawn freely pair about one
							 * case in fifteen, so one drawn case in four pairs them.
							 */
							suite: "unit/lower/graph/other-consumers",
							...cases<RecursiveFeature>(
								otherConsumers,
								weighted([
									[3, recursiveCaseSketchGen],
									[
										1,
										formAndConsumer(
											defaultRecursiveLimits.forms.indexOf("walks"),
											otherConsumers.indexOf("minLength")
										)
									]
								]),
								[
									{
										note: "walks under a minimum length",
										vertexKind: 0,
										form: defaultRecursiveLimits.forms.indexOf("walks"),
										consumer: otherConsumers.indexOf("minLength"),
										reaches: ["consumer:minLength", "form:walks"]
									}
								]
							),
							literal: Formatter.format,
							runs: 60,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang,
							coverage: required<RecursiveFeature>(
								["consumer:endFilter", "consumer:endNe", ["consumer:minLength", "form:walks"]],
								{ cases: 60, sense: notesOnly }
							)
						},
						(q, c) =>
							Effect.sync(() => {
								assert.deepEqual(graphRules(optimizedOf(q)), [], q.label)
								c.noteAll(q.features)
								c.pair(`consumer:${q.parts.consumer}`, `form:${q.parts.form}`)
							})
					)
				)
			)
	)
})

/**
 * Where a generated origin filter's recursion's seed applied it: over any vertex type, and over double precision, the
 * type the seed once refused because equal values could print apart.
 */
type GraphFeature =
	| "the seed applies an origin filter"
	| "the seed applies an origin filter over double precision"

/** The pass context of a generated case: its own catalog. */
const caseContext = (c: RecursiveCase) =>
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
		case "value":
		case "domainCast":
		case "cond":
			return true
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
const seedApplications = (q: LogicalQuery): ReadonlyArray<"applied" | "not applied"> =>
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
const generatedQuery = (c: RecursiveCase): LogicalQuery => ({
	dag: validateDag(c.query.dag),
	params: genParamDecls(c.query)
})

/** The optimized program of a generated case, aligned with its conservative program. */
const optimizedOf = (c: RecursiveCase): OptimizedProgram => {
	const r = lowerAligned(generatedQuery(c), "query", {
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
const graphRules = (optimized: OptimizedProgram): ReadonlyArray<CertificateRule> =>
	Arr.filter(
		Arr.map(optimized.certificates, (x) => x.rule),
		(x) => Str.startsWith("graph.")(x)
	)
