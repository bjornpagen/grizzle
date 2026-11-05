import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect } from "effect"
import { appendAll, indices } from "#compiler/core/array.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, on, relation, schema as declareSchema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { isGraphRule, optimizedLoweringWith, publicCase } from "#test/pg/recursion/graph/support.ts"
import { assert, defined, unorderedEqual } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
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
 * reference evaluator and with the conservative lowering, raw text multisets with no repeated row, and must carry the
 * site's certificate: a wrong column mapping in the region site, or a wrong equality in the constant's seed
 * predicate, changes the answer here.
 */

const text = str.regex("^[a-z]{1,8}$")

const V = relation("V", { id: pg.integer }, ["id"])
const E = relation("E", { from: pg.integer, to: pg.integer }, ["from", "to"])
const W = relation("W", { id: text }, ["id"])
const T = relation("T", { from: text, to: text }, ["from", "to"])
const Net = declareSchema("Net", { V, E, W, T }, [
	contained(on(E, "from"), on(V, "id")),
	contained(on(E, "to"), on(V, "id")),
	contained(on(T, "from"), on(W, "id")),
	contained(on(T, "to"), on(W, "id"))
])

const containments: ReadonlyArray<GenContainment> = [
	{ from: { relation: "E", fields: ["from"] }, to: { relation: "V", fields: ["id"] } },
	{ from: { relation: "E", fields: ["to"] }, to: { relation: "V", fields: ["id"] } },
	{ from: { relation: "T", fields: ["from"] }, to: { relation: "W", fields: ["id"] } },
	{ from: { relation: "T", fields: ["to"] }, to: { relation: "W", fields: ["id"] } }
]

const int = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })
const word = (s: string): TypedLiteral => ({ kind: "text", value: s })

/** A chain 0 -> 1 -> 2 -> 3, a diamond 3 -> {4, 5} -> 6, a cycle 6 -> 7 -> 8 -> 6, a branch 2 -> 9 and a self-loop on 9. */
const intEdges = [
	[0, 1],
	[1, 2],
	[2, 3],
	[3, 4],
	[3, 5],
	[4, 6],
	[5, 6],
	[6, 7],
	[7, 8],
	[8, 6],
	[2, 9],
	[9, 9]
] as const

/** A cycle a -> b -> c -> a, a branch b -> d, and parallel routes d -> {e, f} -> g. */
const textEdges = [
	["a", "b"],
	["b", "c"],
	["c", "a"],
	["b", "d"],
	["d", "e"],
	["d", "f"],
	["e", "g"],
	["f", "g"]
] as const

const facts = {
	V: Arr.map(indices(10), (i) => [int(i)]),
	E: Arr.map(intEdges, ([a, b]) => [int(a), int(b)]),
	W: Arr.map(["a", "b", "c", "d", "e", "f", "g"], (s) => [word(s)]),
	T: Arr.map(textEdges, ([a, b]) => [word(a), word(b)])
}

const caseOf = (
	label: string,
	q: unknown,
	params: Readonly<Record<string, TypedLiteral>>
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
const ConstantLiteral = query(Net).rule((r) => {
	const { node } = v(IntClosure, "intClosure")
	return r.match(IntClosure, { origin: 9, node }).find({ node })
})

/** A text literal constant: the seed predicate's equality is the text one. */
const ConstantText = query(Net).rule((r) => {
	const { node } = v(TextClosure, "textClosure")
	return r.match(TextClosure, { origin: "b", node }).find({ node })
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

/** A hand-built case and the site's certificate it must carry. */
type SiteCase = readonly [LabelledCase, CertificateRule]

const cases: Arr.NonEmptyReadonlyArray<SiteCase> = [
	[caseOf("ConstantParam", ConstantParam, { p: int(3) }), "graph.seedPushdown.constant"],
	[caseOf("ConstantLiteral", ConstantLiteral, {}), "graph.seedPushdown.constant"],
	[caseOf("ConstantText", ConstantText, {}), "graph.seedPushdown.constant"],
	[caseOf("ConstantTextParam", ConstantTextParam, { p: word("b") }), "graph.seedPushdown.region"],
	[caseOf("RegionEq", RegionEq, { p: int(3) }), "graph.seedPushdown.region"],
	[caseOf("RegionLt", RegionLt, { p: int(3) }), "graph.seedPushdown.region"],
	[caseOf("RegionMixed", RegionMixed, { p: int(6) }), "graph.seedPushdown.region"],
	[caseOf("RegionText", RegionText, { p: word("d") }), "graph.seedPushdown.region"]
]

/** A case whose site's certificate fired and whose artifact agreed, by its label. */
type SiteFeature = `fired: ${string}`

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
						return yield* exhaust(
							{
								suite: "recursion/graph/seed-sites",
								generator: element(cases),
								literal: ([c, rule]: SiteCase) => `${c.label}: ${rule}`,
								limit: cases.length,
								coverage: requiredInSpace<SiteFeature>(
									Arr.map(cases, ([c]): SiteFeature => `fired: ${c.label}`)
								),
								caseHang
							},
							([c, rule], k) =>
								Effect.gen(function* () {
									const fired: Array<string> = []
									const optimized = optimizedLoweringWith((features) => {
										appendAll(fired, Arr.filter(features, isGraphRule))
									}, "snapshot")
									const withReference = yield* runLabelledOracle(c, optimized, reference, {
										...defaultRunOptions,
										schema: { kind: "named", name: schema }
									})
									assert.equal(withReference.comparison.equal, true, printOutcome(withReference))
									assert.equal(
										withReference.comparison.leftDuplicates,
										0,
										printOutcome(withReference)
									)
									const withConservative = yield* runLabelledOracle(c, optimized, conservative, {
										...defaultRunOptions,
										schema: { kind: "named", name: schema }
									})
									assert.equal(
										withConservative.comparison.equal,
										true,
										printOutcome(withConservative)
									)
									assert.equal(
										withConservative.comparison.leftDuplicates,
										0,
										printOutcome(withConservative)
									)
									assert.notDeepEqual(
										defined(withReference.left.run.statements[0], "the statement").rows,
										[],
										printOutcome(withReference)
									)
									unorderedEqual(Arr.dedupe(fired), [rule])
									k.note(`fired: ${c.label}`)
								})
						)
					})
				)
		)
	}
)
