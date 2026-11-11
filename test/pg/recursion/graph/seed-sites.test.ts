import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { type Gen, int, subarray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, on, relation, schema as declareSchema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { isGraphRule, optimizedLoweringWith, publicCase } from "#test/pg/recursion/graph/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import type { ValueFacts } from "#test/support/oracle/gen/facts.ts"
import type { GenContainment } from "#test/support/oracle/gen/schema.ts"
import {
	conservative,
	defaultRunOptions,
	type LabelledCase,
	printOutcome,
	reference,
	runLabelledOracle
} from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * Every site of the proved root pushdown agrees on PostgreSQL 19 (lower/optimize/graph/seed.ts).
 *
 * graph.seedPushdown has three sites: a conjunct of a filter directly over a recursion (filter), a constant an
 * occurrence of the recursion fixes a column to (constant), and a conjunct of a filter over a region whose variables
 * one occurrence of the recursion binds (region). The generated seed-filter population (equivalence.test.ts) always
 * filters the recursion directly, so it exercises only the first; each case here is a hand-built query over a
 * recursion whose origin differs from the vertex it advances, consumed through one of the other two sites, with an
 * equality and a non-equality on the origin, a parameter and a literal, an integer and a text origin, and a conjunct
 * on the endpoint beside the origin's, which must stay where it was. Each optimized artifact is compared with the
 * reference evaluator and with the conservative lowering, raw text sets with no repeated row, and must carry its
 * site's certificate: the constant site's for a constant a match fixes the origin to, but a text parameter, which the
 * checker binds through a hidden variable of the region, and the region site's for a conjunct of a filter over it. A
 * wrong column mapping in the region site, or a wrong equality in the constant's seed predicate, changes the answer.
 *
 * A case draws an integer graph over up to six vertices and a text graph over up to six words, each ordered pair of
 * vertices an edge or not, so chains, diamonds, cycles and self-loops arrive by several routes, and the origin a
 * parameter or literal names, now and then one past the graph's last vertex, and runs every query over them.
 *
 * Plants (main's test phase): recursion-seed-pushdown-off.patch.
 */

const text = str.regex("^[a-z]{1,8}$")

const V = relation("V", { id: pg.integer }, ["id"])
const E = relation("E", { from: pg.integer, to: pg.integer }, ["from", "to"])
const W = relation("W", { id: text }, ["id"])
const T = relation("T", { from: text, to: text }, ["from", "to"])
const Net = declareSchema(
	"Net",
	[V, E, W, T],
	[
		contained(on(E, "from"), on(V, "id")),
		contained(on(E, "to"), on(V, "id")),
		contained(on(T, "from"), on(W, "id")),
		contained(on(T, "to"), on(W, "id"))
	]
)

const containments: ReadonlyArray<GenContainment> = [
	{ from: { relation: "E", fields: ["from"] }, to: { relation: "V", fields: ["id"] } },
	{ from: { relation: "E", fields: ["to"] }, to: { relation: "V", fields: ["id"] } },
	{ from: { relation: "T", fields: ["from"] }, to: { relation: "W", fields: ["id"] } },
	{ from: { relation: "T", fields: ["to"] }, to: { relation: "W", fields: ["id"] } }
]

const intLit = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })
const word = (s: string): TypedLiteral => ({ kind: "text", value: s })

/** The word of text vertex `i`: the letters from a. */
const wordOf = (i: number): string => String.fromCharCode(0x61 + i)

/** A graph over the vertices 0 … n - 1, each ordered pair of them an edge or not. */
interface Graph {
	readonly vertices: number
	readonly edges: ReadonlyArray<readonly [number, number]>
}

const graphGen: Gen<Graph> = (source) => {
	const vertices = source.draw(int(1, 6))
	const each = upTo(vertices, (i) => i)
	return {
		vertices,
		edges: source.draw(subarray(Arr.flatMap(each, (a) => Arr.map(each, (b) => [a, b] as const))))
	}
}

/** The facts of the integer graph E over V and the text graph T over W, its vertices the words of their indices. */
const factsOf = (ints: Graph, words: Graph): ValueFacts => ({
	V: upTo(ints.vertices, (i) => [intLit(i)]),
	E: Arr.map(ints.edges, ([a, b]) => [intLit(a), intLit(b)]),
	W: upTo(words.vertices, (i) => [word(wordOf(i))]),
	T: Arr.map(words.edges, ([a, b]) => [word(wordOf(a)), word(wordOf(b))])
})

const caseOf = (
	label: string,
	q: unknown,
	params: Readonly<Record<string, TypedLiteral>>,
	facts: ValueFacts
): LabelledCase =>
	publicCase({
		schema: Net,
		name: "Net",
		relations: ["V", "E", "W", "T"],
		containments,
		facts,
		label,
		query: q,
		params
	})

/**
 * Every vertex one or more steps from each origin: the base is every edge, the step carries the origin and advances
 * the node, so the origin is a carried column and the node is not. The same definition over the integer graph E and
 * the text graph T.
 */
const IntClosure = query(Net).recursive("IntClosure", {
	row: { origin: pg.integer, node: pg.integer },
	base: [
		(r) => {
			const { from, to } = v(E, "e")
			return r.match(E, { from, to }).find({ origin: from, node: to })
		}
	],
	rec: [
		(r, self) => {
			const { origin, node } = v(self, "self")
			const { to } = v(E, "e")
			return r.match(self, { origin, node }).match(E, { from: node, to }).find({ origin, node: to })
		}
	]
})

const TextClosure = query(Net).recursive("TextClosure", {
	row: { origin: text, node: text },
	base: [
		(r) => {
			const { from, to } = v(T, "t")
			return r.match(T, { from, to }).find({ origin: from, node: to })
		}
	],
	rec: [
		(r, self) => {
			const { origin, node } = v(self, "self")
			const { to } = v(T, "t")
			return r.match(self, { origin, node }).match(T, { from: node, to }).find({ origin, node: to })
		}
	]
})

/** (a) A parameter constant on the origin. */
const ConstantParam = query(Net).rule((r) => {
	const { node } = v(IntClosure, "intClosure")
	return r.match(IntClosure, { origin: r.param("p", pg.integer), node }).find({ node })
})

/** A literal constant on the origin. */
const constantLiteral = (origin: number) =>
	query(Net).rule((r) => {
		const { node } = v(IntClosure, "intClosure")
		return r.match(IntClosure, { origin, node }).find({ node })
	})

/** A text literal constant: the seed predicate's equality is the text one. */
const constantText = (origin: string) =>
	query(Net).rule((r) => {
		const { node } = v(TextClosure, "textClosure")
		return r.match(TextClosure, { origin, node }).find({ node })
	})

/**
 * A text parameter constant on a regex-refined column is a hidden variable the region equates with the parameter
 * (check/checker.ts #constant), so it is the region site.
 */
const ConstantTextParam = query(Net).rule((r) => {
	const { node } = v(TextClosure, "textClosure")
	return r.match(TextClosure, { origin: r.param("p", text), node }).find({ node })
})

/** (b) An equality on the origin's region variable. */
const RegionEq = query(Net).rule((r) => {
	const { origin, node } = v(IntClosure, "intClosure")
	return r
		.match(IntClosure, { origin, node })
		.where(r.eq(origin, r.param("p", pg.integer)))
		.find({ node })
})

/** (c) A non-equality on the origin's region variable. */
const RegionLt = query(Net).rule((r) => {
	const { origin, node } = v(IntClosure, "intClosure")
	return r
		.match(IntClosure, { origin, node })
		.where(r.lt(origin, r.param("p", pg.integer)))
		.find({ origin, node })
})

/** The origin's conjunct moves; the endpoint's beside it stays where it was. */
const RegionMixed = query(Net).rule((r) => {
	const { origin, node } = v(IntClosure, "intClosure")
	return r
		.match(IntClosure, { origin, node })
		.where(r.ge(origin, r.param("p", pg.integer)), r.ne(node, origin))
		.find({ origin, node })
})

/** A text origin compared in the region. */
const RegionText = query(Net).rule((r) => {
	const { origin, node } = v(TextClosure, "textClosure")
	return r
		.match(TextClosure, { origin, node })
		.where(r.eq(origin, r.param("p", text)))
		.find({ node })
})

/** The queries every case runs. */
const shapes = [
	"ConstantParam",
	"ConstantLiteral",
	"ConstantText",
	"ConstantTextParam",
	"RegionEq",
	"RegionLt",
	"RegionMixed",
	"RegionText"
] as const
type Shape = (typeof shapes)[number]

/** A drawn case: both graphs, and the integer and the text vertex an origin's parameter or literal names. */
interface Sketch {
	readonly ints: Graph
	readonly words: Graph
	readonly p: number
	readonly w: number
}

const sketchGen: Gen<Sketch> = (source) => {
	const ints = source.draw(graphGen)
	const words = source.draw(graphGen)
	return {
		ints,
		words,
		p: source.draw(int(0, ints.vertices)),
		w: source.draw(int(0, words.vertices))
	}
}

/** A query's oracle case over a sketch, and the site whose certificate it must carry. */
const caseOfSketch = (shape: Shape, k: Sketch): readonly [LabelledCase, CertificateRule] => {
	const facts = factsOf(k.ints, k.words)
	const p = intLit(k.p)
	const w = word(wordOf(k.w))
	switch (shape) {
		case "ConstantParam":
			return [caseOf(shape, ConstantParam, { p }, facts), "graph.seedPushdown.constant"]
		case "ConstantLiteral":
			return [caseOf(shape, constantLiteral(k.p), {}, facts), "graph.seedPushdown.constant"]
		case "ConstantText":
			return [caseOf(shape, constantText(wordOf(k.w)), {}, facts), "graph.seedPushdown.constant"]
		case "ConstantTextParam":
			return [caseOf(shape, ConstantTextParam, { p: w }, facts), "graph.seedPushdown.region"]
		case "RegionEq":
			return [caseOf(shape, RegionEq, { p }, facts), "graph.seedPushdown.region"]
		case "RegionLt":
			return [caseOf(shape, RegionLt, { p }, facts), "graph.seedPushdown.region"]
		case "RegionMixed":
			return [caseOf(shape, RegionMixed, { p }, facts), "graph.seedPushdown.region"]
		case "RegionText":
			return [caseOf(shape, RegionText, { p: w }, facts), "graph.seedPushdown.region"]
	}
}

/** A query whose site's certificate fired and whose artifact agreed, with rows or with none. */
type SiteFeature = `${Shape} agreed with rows` | `${Shape} agreed with none`

layer(Substrate.layer)(
	"graph.seedPushdown at the constant and region sites against the reference",
	(it) => {
		it.effect(
			"each site's certificate fires and its artifact agrees with the reference and the conservative lowering",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const schema = yield* s.schema({ create: false, label: "seedsites" })
						return yield* explore(
							{
								suite: "recursion/graph/seed-sites",
								draw: drawn(sketchGen),
								literal: Formatter.format,
								oracle: {
									kind: "second-implementation",
									name: "the reference evaluator and the conservative lowering over the same facts, raw text sets with no repeated row"
								},
								coverage: required<SiteFeature>(
									Arr.map(shapes, (shape): SiteFeature => `${shape} agreed with rows`),
									{ cases: 24, sense: notesOnly }
								),
								kept: [],
								runs: 12,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								caseHang
							},
							(k, c) =>
								Effect.forEach(
									shapes,
									(shape) =>
										Effect.gen(function* () {
											const [labelled, rule] = caseOfSketch(shape, k)
											const fired: Array<string> = []
											const optimized = optimizedLoweringWith((features) => {
												appendAll(fired, Arr.filter(features, isGraphRule))
											}, "snapshot")
											const withReference = yield* runLabelledOracle(
												labelled,
												optimized,
												reference,
												{
													...defaultRunOptions,
													schema: { kind: "named", name: schema }
												}
											)
											assert.equal(
												withReference.comparison.equal,
												true,
												printOutcome(withReference)
											)
											const withConservative = yield* runLabelledOracle(
												labelled,
												optimized,
												conservative,
												{
													...defaultRunOptions,
													schema: { kind: "named", name: schema }
												}
											)
											assert.equal(
												withConservative.comparison.equal,
												true,
												printOutcome(withConservative)
											)
											assert.ok(
												fired.includes(rule),
												`${shape} fired ${Arr.join(Arr.dedupe(fired), ", ")}, not ${rule}`
											)
											c.note(
												defined(withReference.left.run.statements[0], "the statement").rows.length >
													0
													? `${shape} agreed with rows`
													: `${shape} agreed with none`
											)
										}),
									{ discard: true }
								)
						)
					})
				)
		)
	}
)
