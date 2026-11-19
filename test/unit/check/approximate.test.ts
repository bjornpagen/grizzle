import { assert, defined, matchesObject } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { hnswPolicy } from "#compiler/check/approximate/policy.ts"
import { approximateMisuse, approximatePageMisuse } from "#compiler/check/approximate/provenance.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { checkAuthored, checking, checkOptions } from "#test/support/policy.ts"
import {
	type EligibilityFeature,
	rules,
	searchCaseSpace,
	searches
} from "#test/unit/check/approximate.fixtures.ts"
import {
	approximate,
	type Composition,
	provenanceDesc,
	provenanceGen,
	searchCaseDesc,
	searchSchema,
	searchVerdict
} from "#test/unit/check/approximate.ts"

/** ApproximateNearest admits exactly a search whose one rule, read once per execution, ranks by a query vector's cosine distance to an indexable stored vector, refusing every other with its reason. Its budget is its suite's before it was a property (test/unit/check/approximate.test.ts at 4ca3036a): 300 runs and 600 steered cases. */
export const approximateNearestAdmitsExactlyASearchWhoseOneRuleReadOncePerExecutionRanksByAQueryVectorsCosineDistanceToAnIndexableStoredVectorRefusingEveryOtherWithItsReason =
	property.explore(searchCaseSpace, {
		needs: {},
		budget: { runs: 300, steered: 600 },
		situations: [
			...rules,
			"refused, an attachment filtering by its parent",
			"refused, an attachment binding its parent",
			"admitted, the query",
			"admitted, an import bound to a parameter",
			"admitted at HNSW's bound",
			"admitted, a keyed vector",
			"admitted, a vector its where keys",
			"refused, its own keyed vector"
		] satisfies ReadonlyArray<Reached<EligibilityFeature>>,
		check: (_, k: Case<EligibilityFeature>) => (c) =>
			Effect.sync(() => {
				const v = searchVerdict(c)
				const result = checkAuthored(
					checking(searchSchema(c.dimensions)),
					searchCaseDesc(c),
					checkOptions("search")
				)
				if (v.kind === "refused") {
					k.noteAll(v.rules)
					if (c.score === "its own keyed vector") {
						k.note("refused, its own keyed vector")
					}
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
				if (c.dimensions === hnswPolicy.maxDimensions) {
					k.note("admitted at HNSW's bound")
				}
				if (c.score === "a keyed vector" || c.score === "a vector its where keys") {
					k.note(`admitted, ${c.score}`)
				}
				const q = succeeded(result, "the eligible search")
				assert.equal(searches(q.dag).length, 1, "one sealed search")
			}),
		oracle: {
			kind: "specification",
			name: "the eligibility rule restated over the drawn search (test/unit/check/approximate.ts)"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/check/approximate.test.ts#approximateNearestAdmitsExactlyASearchWhoseOneRuleReadOncePerExecutionRanksByAQueryVectorsCosineDistanceToAnIndexableStoredVectorRefusingEveryOtherWithItsReason:-:e.0.0.6.0.0.0.2.0"
				),
				reason:
					"an aggregate filtering by its parent, nearest by id: the correlation column the filter's parent id adds is named id, so by names a column and the parent's read is what refuses it",
				since: "2026-11-08"
			}
		],
		kills: [
			{
				file: "packages/engine/src/check/approximate/trace.ts",
				original: "\treturn anchorKeys(o.source).some((k) => k.every((field) => fixed.has(field)))",
				replacement:
					"\treturn anchorKeys(o.source).some((k) => k.some((field) => fixed.has(field)))",
				why: "A match that fixes part of its source's key is taken for one row, so a search ranks by the vector of one of many G rows (check/approximate/trace.ts anchorOf); the eligibility property fails."
			},
			{
				file: "packages/engine/src/check/approximate/trace.ts",
				original: "\t\tif (anchor === undefined || unanchored) {",
				replacement: "\t\tif (unanchored) {",
				why: "A query vector read from any match is taken for a statement constant, so a distance between two stored vectors is admitted (check/approximate/trace.ts queryVectorOf); the eligibility property fails."
			},
			{
				file: "packages/engine/src/check/approximate/trace.ts",
				original: "\t\t\t\t\treturn [...fixed(a, b), ...fixed(b, a)]",
				replacement: "\t\t\t\t\treturn []",
				why: "A key a `where` fixes is not seen, so a search by the vector of the one G a rule's equalities key is refused (check/approximate/trace.ts fixingConjuncts); the eligibility property fails."
			},
			{
				file: "packages/engine/src/check/approximate/trace.ts",
				original: "\t\tquery.anchors.some((anchor) => anchor.occurrence === binder.occurrence)",
				replacement: "\t\tquery.anchors.length < 0",
				why: "A query vector read from the ranked match itself taken for an anchor, so a search ranks a key-bound match's one row by its distance to its own fields (agreement's faults: Slot's embedding ranked by its distance to its own image under a fixed key, admitted by the engine and refused by the types); the eligibility property fails."
			},
			{
				file: "packages/engine/src/check/approximate/trace.ts",
				original: "\tif (dimensions > hnswPolicy.maxDimensions) {",
				replacement: "\tif (dimensions >= hnswPolicy.maxDimensions) {",
				why: "A vector at HNSW's bound is refused (check/approximate/trace.ts); the eligibility property fails."
			}
		]
	})

/** ApproximateNearest bans a page over, and a derived definition of, exactly the results computed from a search. Its budget is its suite's before it was a property (test/unit/check/approximate.test.ts at 4ca3036a): 60 runs and 100 steered cases. */
export const approximateNearestBansAPageOverAndADerivedDefinitionOfExactlyTheResultsComputedFromASearch =
	property.explore(provenanceGen, {
		needs: {},
		budget: { runs: 60, steered: 100 },
		situations: [
			"the search",
			"an import of the search",
			"a count over the search",
			"the source ordered by distance",
			"the source"
		] satisfies ReadonlyArray<Reached<Composition>>,
		check: (_, k: Case<Composition>) => (p) =>
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
				matchesObject(defined(derived, `${p.composition}: a derived definition over candidates`), {
					use: "derived"
				})
			}),
		oracle: {
			kind: "specification",
			name: "a result is approximate exactly when a search lies among what it is computed from"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/approximate/provenance.ts",
				original:
					'\t[...subtree(node)].filter((n) => n.kind === "ApproximateNearest").toSorted(byLabel)',
				replacement: '\t[node].filter((n) => n.kind === "ApproximateNearest").toSorted(byLabel)',
				why: "Only a search itself is approximate, not what is computed from it (check/approximate/provenance.ts); the provenance property fails."
			}
		]
	})
