/**
 * An attachment's parent key set deduplicates exactly where the rows it reads prove no key over it: in every
 * attachment part of an optimized program, the set's core is SELECT DISTINCT exactly when keys.ts keySetOf leaves it
 * unproved, and a plain core where it proves it, so no statement deduplicates a set its parent's keys already make one
 * and none reads as it is a set they do not. Compile-only.
 *
 * - Over generated programs: the oracle generator's per-evaluation population (test/support/oracle/gen/case.ts
 *   perEvaluationGenConfig), every root attached, with chains of attachments nested below a child under its own
 *   per-parent take, each compiled as a query is (admitted, annotated, lowerOptimized) and, where every column of its
 *   root is ordered, ordered by its heading and compiled as a page, whose four requests' programs hold key sets of their
 *   own (lower/shapes/page/compile.ts).
 * - Over the platform's billing reads: every read of the platform's workload (test/support/fixtures/api/platform.ts
 *   platformWorkload), compiled as billing compiles it.
 *
 * Oracle: keySetOf over the physical analysis of the program's own placement (shapes/share/physical.ts
 * shapeFactsFromPlan), at the rows each set reads (test/support/key-sets.ts keySetSites): a rows part's, the delivered
 * relation's (an ordered result's input) or a heterogeneous union's, with the free references that say whether they are
 * evaluated once; or an attachment's children, whose key within one parent holds across parents only through the
 * correlation that fixes their parent (keys.ts parentFixed). That a set the statement reads as it is holds no repeated
 * key on PostgreSQL is the optimized differential's (test/pg/oracle/optimized/support.ts, keySetRepeats).
 *
 * Aimed and kept: the page/generated-optimized case at TEST_SEED=28094260, whose nested key set holds a key within
 * one parent only, and its twin paired on the column that fixes the parent, whose nested key set is proved across
 * parents (cases.ts): a case aimed at either situation draws their shape with its correlation drawn.
 */

import { nonEmpty } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplateOver, testCompile } from "#test/support/compile.ts"
import * as P from "#test/support/fixtures/api/platform.ts"
import {
	artifacts,
	billingReads,
	judge,
	judgeCase,
	keySetCases,
	type KeySetFeature,
	readsNeed
} from "#test/unit/lower/dedup/key-sets.fixtures.ts"

/**
 * An attachment's parent key set deduplicates exactly where it is unproved on generated programs, their pages'
 * included.
 *
 * Budget: 200 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/lower/dedup/key-sets.test.ts:305 at 8cad5bce, its runs and its coverage's cases).
 */
export const anAttachmentsParentKeySetDeduplicatesExactlyWhereItIsUnprovedOnGeneratedProgramsTheirPagesIncluded =
	property.explore(keySetCases, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: [
			"a proved key set",
			"an unproved key set",
			"a correlated child under a nested attachment",
			"a page request's key set",
			"a key of one parent, deduplicated across parents",
			"a key set proved across parents by the correlation that fixes them"
		] satisfies ReadonlyArray<Reached<KeySetFeature>>,
		check: (_, k: Case<KeySetFeature>) => (c) => Effect.sync(() => judgeCase(c, k.note)),
		oracle: {
			kind: "specification",
			name: "keys.ts keySetOf over the program's own placement"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/lower/dedup/key-sets.test.ts#anAttachmentsParentKeySetDeduplicatesExactlyWhereItIsUnprovedOnGeneratedProgramsTheirPagesIncluded:10.4:1.0"
				),
				reason:
					"page/generated-optimized, TEST_SEED=28094260: a nested key set whose parent rows are a take of one row per parent, keyed by a within one parent only",
				since: "2026-11-11"
			},
			{
				token: ReplayToken(
					"test/unit/lower/dedup/key-sets.test.ts#anAttachmentsParentKeySetDeduplicatesExactlyWhereItIsUnprovedOnGeneratedProgramsTheirPagesIncluded:10.4:2"
				),
				reason:
					"the TEST_SEED=28094260 case with its nested attachment paired on the column that fixes the parent too",
				since: "2026-11-11"
			},
			{
				token: ReplayToken(
					"test/unit/lower/dedup/key-sets.test.ts#anAttachmentsParentKeySetDeduplicatesExactlyWhereItIsUnprovedOnGeneratedProgramsTheirPagesIncluded:-:1.0.0.0.1.3.0.0.0.0.0.0.0.0.0.0.0.0.0.1.b.1.2.0.0.0.0.0.0.0.0.0.0.5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.5.0.0.0.8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.1.0.1.b.a.1.0.0.0.0.0.0.0.0.0.0.5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.1.0.0.1.5.0.3.4.2.0.0.0.0.0.0.5.0.0.0.5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.3.1.0.0.0.0.0.0.5.0.0.0.8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.4.1.0.0.0.0.0.0.0.0.0.0.5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.1.3.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.104c.1.0.1.0.0.0.0.0.0.0.0.0.0.0.0.8.0.0.0.3.0.0.0.0.1.2.0.1.0.0.1.3.1.0.1.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.2.0.1.1.0.1.0.0.1.0.1.0.0.1.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.1"
				),
				reason:
					"a semi-join over a region the statement shares as a CTE of its own, whose correlated node the region holds (cte-policy sharedCorrelated): the semi-join opened the region's held CTEs around its own query, so the held CTE led the semi-join's query while its read stood in the region's CTE, out of its reach, which the printer refuses (BRAND-P3's run, rotating 0x2f1e3cf5, case 146). A region's held CTEs lead the query its own body is spelled in (lower/shapes holdingRegion)",
				since: "2026-11-26"
			},
			{
				token: ReplayToken(
					"test/unit/lower/dedup/key-sets.test.ts#anAttachmentsParentKeySetDeduplicatesExactlyWhereItIsUnprovedOnGeneratedProgramsTheirPagesIncluded:-:1.0.0.1.0.2.0.0.0.0.0.0.1.2.0.0.0.0.0.1.0.0.0.0.0.0.a.b.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.4.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.1.9.5.2.0.0.0.0.0.0.5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.5.0.0.0.5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.2.0.0.0.0.0.0.5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.4.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.5.0.0.0.5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.0.1.5.3.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.b.2.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.a44.0.0.0.0.0.0.0.0.1.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.3.0.0.0.3.0.1.0.1.0.3.0.0.1.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0"
				),
				reason:
					"a take per parent correlated to the closed relation its region's chain leads with, bound at the column its correlation reads, read at the key set of the rows before it (lower/shapes/region chainKeySets): its correlation read the lead's row from the key set's derived table, which stands beside the lead, never LATERAL to it, so the printer refused the read of r82 out of its reach (rotating 0x9368d051, case 35). A key set's source is read in the scope of its key alone (keyScope), each row of the region its correlation reads at the key's column, and one whose correlation reads a column of no class its key holds is fenced, read per row",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/region/index.ts",
				original: "\t\t\t\t\tconst scope = step.key.scope(within, at)\n",
				replacement: "\t\t\t\t\tconst scope = within\n",
				why: "A key set's source read in the region's scope: the kept take's correlation reads the lead's row from the key set's derived table beside it, not LATERAL, which the printer refuses."
			},
			{
				file: "packages/engine/src/lower/shapes/index.ts",
				original: "\t\t\tconst region = holdingRegion(node, cx)\n",
				replacement: "\t\t\tconst region = filteredRegion(node)\n",
				why: "A semi-join over a region the statement shares as its own CTE opens that region's held CTEs around the semi-join's query: the kept case's held CTE leads the semi-join while the region's CTE reads it, out of its reach."
			},
			{
				file: "packages/engine/src/lower/conservative/deliver.ts",
				original:
					'\t\tproof.kind === "proved"\n\t\t\t? provedCore("certified", targets, [source.item], undefined)\n\t\t\t: distinctCore(targets, [source.item], undefined)',
				replacement: "\t\tdistinctCore(targets, [source.item], undefined)",
				why: "Every key set is read through DISTINCT (conservative/deliver.ts keysOf), proved or not; a proved set, which both populations reach, fails both searches."
			},
			{
				file: "packages/engine/src/lower/conservative/deliver.ts",
				original:
					'\t\tproof.kind === "proved"\n\t\t\t? provedCore("certified", targets, [source.item], undefined)\n\t\t\t: distinctCore(targets, [source.item], undefined)',
				replacement: '\t\tprovedCore("certified", targets, [source.item], undefined)',
				why: "Every key set is read as it is, where keySetOf leaves it unproved too; an unproved set fails the generated programs' search."
			}
		]
	})

/** An attachment's parent key set deduplicates exactly where it is unproved on every billing read of the platform. */
export const anAttachmentsParentKeySetDeduplicatesExactlyWhereItIsUnprovedOnEveryBillingReadOfThePlatform =
	property.exhaust(
		finite((source) =>
			source.draw(
				element(
					nonEmpty(
						Arr.map(billingReads, ([name]) => name),
						"a read"
					)
				)
			)
		),
		{
			needs: { readsNeed },
			situations: ["a proved key set"] satisfies ReadonlyArray<Reached<KeySetFeature>>,
			check:
				({ readsNeed }, c: Case<KeySetFeature>) =>
				(name) =>
					Effect.gen(function* () {
						const reads = yield* readsNeed
						return yield* Effect.sync(() => {
							const template = succeeded(
								compileTemplateOver(reads.get(name), P.Billing, artifacts, testCompile),
								`${name} compiles`
							)
							judge(
								{
									where: name,
									program: template.programs.optimized,
									optimized: template.programs.optimized,
									names: artifacts.names
								},
								c.note
							)
						})
					}),
			oracle: {
				kind: "specification",
				name: "keys.ts keySetOf over the read's own placement"
			},
			box: "every read of the platform's workload",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/conservative/deliver.ts",
					original:
						'\t\tproof.kind === "proved"\n\t\t\t? provedCore("certified", targets, [source.item], undefined)\n\t\t\t: distinctCore(targets, [source.item], undefined)',
					replacement: "\t\tdistinctCore(targets, [source.item], undefined)",
					why: "Every key set is read through DISTINCT (conservative/deliver.ts keysOf), proved or not; a proved set, which both populations reach, fails both searches."
				}
			]
		}
	)
