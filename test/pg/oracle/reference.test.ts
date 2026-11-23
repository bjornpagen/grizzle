/**
 * The reference side of the oracle discriminates the structure of a program: the reference derives the delivered
 * statements from the IR, so a lowering that drops an attachment's part, delivers one under another name, or reports a
 * narrowed column type is a structural difference, never a reference built to match it. A fault the conservative
 * program of a generated case offers a target for is planted in it, or none, and the comparison must report exactly
 * the differences the plant makes, read off the program's statement labels (compare.ts labeledStatements) before and
 * after it, and none where it plants nothing. The cases are the generator's own with an attaching root, so most
 * programs offer an attachment to drop or rename; each case draws the fault it plants, a fault still pending where its
 * turn is steered, and plants it where the program offers it a target.
 *
 * That the reference tells a wrong lowering's rows apart (the I1 mutant, a DISTINCT dropped from a projection that
 * keeps no key) is the mutant roster's kill search against it (mutants/invalid.test.ts); that the reference agrees with
 * PostgreSQL's capture of every hard spelling is the conservative gate's (conservative.test.ts), whose generated facts
 * store NaN, -0, display scales and supplementary-plane text.
 *
 * Every planted lowering is the left side, the reference the right; the order of the two is no contract.
 *
 * Features: each fault planted where the program offers it.
 */
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import {
	type Offered,
	type PlantFeature,
	plantFeatures,
	planted,
	plantOf,
	structureSpace
} from "#test/pg/oracle/reference.fixtures.ts"
import {
	conservative,
	defaultRunOptions,
	type Lowering,
	reference,
	runOracle
} from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The comparison reports exactly the structure a lowering drops, renames or narrows, planted in a generated case's program. */
export const structure = property.explore(structureSpace, {
	needs: { tx: Substrate.transaction },
	situations: plantFeatures satisfies ReadonlyArray<Reached<PlantFeature>>,
	/**
	 * Its search budget: the fewest runs at which each kill it declares still fails a witness, the cull rule's measure
	 * (grizzle main, 2026-11-23).
	 *
	 * @limitKind measured
	 * @owner test/pg/oracle/reference.test.ts structure
	 * @unit cases
	 * @scope one search of this property: `runs` cases of its rotating stream and a quarter of them, rounded up, of its
	 *   floor stream; `steered` the most its steered phase runs while a required situation is unreached
	 * @evidence `toolchain-test kills` and `toolchain-test run` of test/pg/oracle's test files at TEST_SEED=2219874524 (a
	 *   property's witnesses, its kept cases, floor and steered phase, are fixed by its identity, the same on every
	 *   seed), each killed kill's failing witness printed by an uncommitted line in vendor/toolchain's
	 *   mutate/commands.ts; the logs kills0.log (the pre-conversion budgets), run1.log, kills2.log, run3.log, kills4.log,
	 *   v1at5.log, fs5.log, fs9.log, fs13.log and run5.log in ~/.cache/grizzle/CULL-ORACLE-out on cassowary, uncommitted
	 * @observed 2026-11-23 03:12 to 04:36 UTC
	 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, load average 130 to 410 from other
	 *   lanes; vendor/toolchain 2cc48172; the budgets measured on grizzle f87b2aaab with 47748474c's change and verified
	 *   on dff9200ef (run5.log, every property green and every kill killed); lane CULL-ORACLE's in-memory family of two
	 *   PostgreSQL 19 members
	 * @workload its witnesses with its kill applied, on workers of its own, and its full run, at runs 40, 17, 13, 5 and
	 *   1, steered 300
	 * @result runs 40 (pre-conversion): the runtime/lower/tree.ts kill fails floor case 4; runs 17: killed; runs 13:
	 *   steered case 0; runs 5: steered case 4; runs 1 (a floor of one): it survives, every witness passing
	 * @decision runs 5, a floor of two, the fewest at which the kill fails a witness: every run from 1 to 4 has the floor
	 *   of one at which it survived. steered stays its pre-conversion 300: the phase stops once every required situation
	 *   is reached, so a green run spends only its need, 16 here, and the cap only bounds a run whose situation went
	 *   unreached
	 * @revalidate a change of its generator, its check or a kill's file, a kill added, or a change of how the testing
	 *   library draws a floor or steered case; the kill gate (toolchain-test kills, affected) reports a kill that
	 *   survives
	 */
	budget: { runs: 5, steered: 300 },
	check:
		({ tx }, c: Case<PlantFeature>) =>
		(sketch) =>
			Effect.flatMap(tx, (held) =>
				Effect.provideService(
					Effect.gen(function* () {
						const seat = yield* OracleSeat
						const name = yield* seat.schema("oracle")
						const chosen: Array<Offered> = []
						const lowering: Lowering = {
							name: planted,
							lower: (input) =>
								Result.map(conservative.lower(input), (program) => {
									const plant = plantOf(program, sketch.fault, sketch.pick)
									chosen.push(plant)
									return plant[1].program
								})
						}
						const outcome = yield* runOracle(sketch.case, lowering, reference, {
							...defaultRunOptions,
							schema: { kind: "named", name }
						})
						const [feature, plant] = defined(chosen[0], "the planted lowering's plant")
						c.note(feature)
						assert.equal(outcome.comparison.equal, plant.expected.length === 0)
						unorderedEqual(outcome.comparison.structural, plant.expected)
					}),
					OracleSeat,
					OracleSeat.rolledBack(held)
				)
			),
	oracle: {
		kind: "specification",
		name: "the structural differences a plant makes, read off the program's statement labels before and after it"
	},
	show: Formatter.format,
	kept: [],
	kills: [
		{
			file: "packages/engine/src/runtime/lower/tree.ts",
			original: "\theading.length === 0 ? unitHeading : heading",
			replacement: "\theading.length === 1 ? unitHeading : heading",
			why: "Operator mutant (bound) at packages/engine/src/runtime/lower/tree.ts:37 in deliveredHeading: `0` becomes `1`; the property fails (lane CATCH, grizzle 0baff5d6)."
		}
	]
})
