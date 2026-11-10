import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { hnswPolicy } from "#compiler/check/approximate/policy.ts"
import { approximateMisuse, approximatePageMisuse } from "#compiler/check/approximate/provenance.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { NodeOf, RelDag } from "#compiler/ir/rel.ts"
import { assert, defined, matchesObject, refused, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { checkAuthored, checking, checkOptions } from "#test/support/policy.ts"
import {
	approximate,
	type Composition,
	type Reading,
	provenanceDesc,
	provenanceGen,
	type SearchCase,
	type SearchRule,
	searchCaseDesc,
	searchCaseGen,
	searchSchema,
	searchVerdict
} from "#test/unit/check/approximate.ts"

const searches = (dag: RelDag): ReadonlyArray<NodeOf<"ApproximateNearest">> =>
	Arr.filter(
		topoOrder(dag),
		(n): n is NodeOf<"ApproximateNearest"> => n.kind === "ApproximateNearest"
	)

/** The readings of a search inside an attachment's child. */
type AttachedReading = Extract<
	Reading,
	"an attachment filtering by its parent" | "an attachment binding its parent"
>

type EligibilityFeature =
	| SearchRule
	| `refused, ${AttachedReading}`
	| `admitted, ${Extract<Reading, "the query" | "an import bound to a parameter">}`
	| "admitted at HNSW's bound"

const rules: Arr.NonEmptyReadonlyArray<SearchRule> = [
	"by naming no column",
	"a bound that is no positive integer",
	"a source read per parent row",
	"a source read per outer row",
	"a score that is no query distance",
	"a union",
	"an aggregate",
	"an indexed vector past HNSW's bound",
	"by naming another column"
]

/** An aggregate source filtered by its attachment's parent, nearest by the parent's id its correlation column delivers. */
const aggregateFilteringById: SearchCase = {
	dimensions: 3,
	score: "an aggregate",
	union: true,
	by: "id",
	take: 1,
	reading: "an attachment filtering by its parent"
}

describe("approximateNearest", () => {
	it.effect(
		"admits exactly a search whose one rule, read once per execution, ranks by a query vector's cosine distance to an indexable stored vector, refusing every other with its reason",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/check/approximate-eligibility",
						draw: drawn(searchCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the eligibility rule restated over the drawn search (test/unit/check/approximate.ts)"
						},
						coverage: required<EligibilityFeature>(
							[
								...rules,
								"refused, an attachment filtering by its parent",
								"refused, an attachment binding its parent",
								"admitted, the query",
								"admitted, an import bound to a parameter",
								"admitted at HNSW's bound"
							],
							{ cases: 600, sense: notesOnly }
						),
						kept: [
							{
								note: "an aggregate filtering by its parent, nearest by id: the correlation column the filter's parent id adds is named id, so by names a column and the parent's read is what refuses it",
								sketch: aggregateFilteringById,
								draws: "",
								reaches: [
									"a source read per parent row",
									"a union",
									"an aggregate",
									"by naming another column",
									"refused, an attachment filtering by its parent"
								]
							}
						],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const v = searchVerdict(c)
							const result = checkAuthored(
								checking(searchSchema(c.dimensions)),
								searchCaseDesc(c),
								checkOptions("search")
							)
							if (v.kind === "refused") {
								k.noteAll(v.rules)
								if (
									c.reading === "an attachment filtering by its parent" ||
									c.reading === "an attachment binding its parent"
								) {
									k.note(`refused, ${c.reading}`)
								}
								refused(result, v.reason, Arr.join(v.rules, ", "))
								return
							}
							if (c.reading === "the query" || c.reading === "an import bound to a parameter") {
								k.note(`admitted, ${c.reading}`)
							}
							if (c.dimensions === hnswPolicy.maxDimensions.value) {
								k.note("admitted at HNSW's bound")
							}
							const q = succeeded(result, "the eligible search")
							assert.equal(searches(q.dag).length, 1, "one sealed search")
						})
				)
			)
	)

	it.effect(
		"bans a page over, and a derived definition of, exactly the results computed from a search",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/check/approximate-provenance",
						draw: drawn(provenanceGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "a result is approximate exactly when a search lies among what it is computed from"
						},
						coverage: required<Composition>(
							[
								"the search",
								"an import of the search",
								"a count over the search",
								"the source ordered by distance",
								"the source"
							],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(p, k) =>
						Effect.sync(() => {
							k.note(p.composition)
							const q = succeeded(
								checkAuthored(
									checking(searchSchema(p.search.dimensions)),
									provenanceDesc(p),
									checkOptions("provenance")
								),
								p.composition
							)
							const root = q.dag.roots[0]
							const page = approximatePageMisuse(root)
							const derived = approximateMisuse(q.dag, { derivedDefinition: true })
							if (!approximate(p.composition)) {
								assert.equal(page, undefined, `${p.composition}: no page misuse`)
								assert.equal(derived, undefined, `${p.composition}: no derived misuse`)
								return
							}
							const search = defined(searches(q.dag)[0], "the search")
							const misuse = defined(page, `${p.composition}: a page over candidates`)
							assert.equal(misuse.use, "page")
							assert.equal(misuse.consumer, root)
							assert.equal(misuse.approximate, search)
							matchesObject(
								defined(derived, `${p.composition}: a derived definition over candidates`),
								{
									use: "derived"
								}
							)
						})
				)
			)
	)
})
