import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import {
	caseOfSketch,
	shapes,
	type SiteFeature,
	sketchGen
} from "#test/pg/recursion/graph/seed-sites.fixtures.ts"
import { isGraphRule, optimizedLoweringWith } from "#test/pg/recursion/graph/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import {
	conservative,
	defaultRunOptions,
	printOutcome,
	reference,
	runLabelledOracle
} from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Graph.seedPushdown at the constant and region sites against the reference each site's certificate fires and its artifact agrees with the reference and the conservative lowering. */
export const graphSeedPushdownAtTheConstantAndRegionSitesAgainstTheReferenceEachSitesCertificateFiresAndItsArtifactAgreesWithTheReferenceAndTheConservativeLowering =
	property.explore(sketchGen, {
		needs: { tx: Substrate.transaction },
		situations: Arr.map(
			shapes,
			(shape): SiteFeature => `${shape} agreed with rows`
		) satisfies ReadonlyArray<Reached<SiteFeature>>,
		/** Its pre-conversion budget: runs 12, coverage cases 24 (seed-sites.test.ts at 4fbc3e95). */
		budget: { runs: 12, steered: 24 },
		check:
			({ tx }, c: Case<SiteFeature>) =>
			(k) =>
				Effect.flatMap(tx, (held) =>
					Effect.provideService(
						Effect.gen(function* () {
							const seat = yield* OracleSeat
							const schema = yield* seat.schema("seedsites")
							return yield* Effect.forEach(
								shapes,
								(shape) =>
									Effect.gen(function* () {
										const [labelled, rule] = caseOfSketch(shape, k)
										const fired: Array<string> = []
										const optimized = optimizedLoweringWith((features) => {
											appendAll(fired, Arr.filter(features, isGraphRule))
										}, "snapshot")
										const withReference = yield* runLabelledOracle(labelled, optimized, reference, {
											...defaultRunOptions,
											schema: { kind: "named", name: schema }
										})
										assert.equal(withReference.comparison.equal, true, printOutcome(withReference))
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
											defined(withReference.left.run.statements[0], "the statement").rows.length > 0
												? `${shape} agreed with rows`
												: `${shape} agreed with none`
										)
									}),
								{ discard: true }
							)
						}),
						OracleSeat,
						OracleSeat.rolledBack(held)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator and the conservative lowering over the same facts, raw text sets with no repeated row"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/graph/index.ts",
				original: "\trules: [seedPushdown],",
				replacement: "\trules: [],",
				why: "The graph pass holds no seed pushdown rule, so no predicate over a recursion's carried columns reaches its seed."
			}
		]
	})
