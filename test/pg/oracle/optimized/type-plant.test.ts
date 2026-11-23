/**
 * The type oracle (test/support/oracle/verify/types.ts) judges each part of a statement of tagged parts as lowered,
 * before its executable form casts its columns to texts, and not only through the rows the differential compares: over
 * the optimizer's population (gen/case.ts optimizerGenConfig), every optimized program's parts pass as lowered, and an
 * attachment's part whose outermost core's first output column is planted another type is reported at that part, and
 * only there. The plant casts the column through text to PostgreSQL's `name`, which no heading claims and which spells
 * a short value as its text does, so the differential's text comparison would not tell the part from the one lowered.
 *
 * Oracle: the type oracle (test/support/oracle/verify/types.ts) over each part as lowered.
 *
 * Features: an attachment's part planted, and each part passed.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { typedPlants } from "#test/pg/oracle/optimized/support.ts"
import { type PlantFeature, plantsOf } from "#test/pg/oracle/optimized/type-plant.fixtures.ts"
import { optimizerGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { namedPlacement, oracleProperty, PropertyFailed } from "#test/support/oracle/runner.ts"

/** Every part as lowered passes the type oracle, and an attachment's part planted another column type is reported there alone. */
export const typePlant = oracleProperty(queryCaseGen(optimizerGenConfig), {
	situations: ["a part planted"] satisfies ReadonlyArray<Reached<PlantFeature>>,
	perturb: "none",
	oracle: {
		kind: "specification",
		name: "the type oracle (test/support/oracle/verify/types.ts) over each part as lowered"
	},
	kept: [],
	/**
	 * Its search budget: the fewest runs at which each kill it declares still fails a witness, the cull rule's measure
	 * (grizzle main, 2026-11-23).
	 *
	 * @limitKind measured
	 * @owner test/pg/oracle/optimized/type-plant.test.ts typePlant
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
	 * @workload its witnesses with its kill applied, on workers of its own, and its full run, at runs 150, 17, 13 and 1,
	 *   steered 150
	 * @result runs 150 (pre-conversion): the ir/decimal.ts kill fails floor case 4; runs 17: killed; runs 13: steered
	 *   case 11; runs 1: killed, its situation reached with 96 steered cases, 98 cases in all where f1bf91a2f's gate ran
	 *   188
	 * @decision runs 1, the fewest that keeps a floor case and a fresh one each run. steered stays its pre-conversion
	 *   150: the phase stops once every required situation is reached, so a green run spends only its need, 96 here, and
	 *   the cap only bounds a run whose situation went unreached
	 * @revalidate a change of its generator, its check or a kill's file, a kill added, or a change of how the testing
	 *   library draws a floor or steered case; the kill gate (toolchain-test kills, affected) reports a kill that
	 *   survives
	 */
	budget: { runs: 1, steered: 150 },
	kills: [
		{
			file: "packages/engine/src/ir/decimal.ts",
			original: '\t\tif (text[i] === ".") {\n\t\t\ti++\n\t\t\tfracStart = i',
			replacement: '\t\tif (text[i] === ".") {\n\t\t\t{}\n\t\t\tfracStart = i',
			why: "Operator mutant (statement) at packages/engine/src/ir/decimal.ts:80 in <module>: `i++` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6)."
		}
	],
	show: Formatter.format,
	check: (k: Case<PlantFeature>) => (queryCase) =>
		Effect.gen(function* () {
			const placement = yield* namedPlacement("typeplant")
			const typed = yield* typedPlants(queryCase, { placement }, plantsOf).pipe(
				Effect.mapError(
					(e) => new PropertyFailed({ report: `${e.stage} failed on ${e.side}: ${e.message}` })
				)
			)
			assert.deepEqual(typed.clean, [], "every part as lowered is of its heading's types")
			for (const plant of typed.planted) {
				assert.ok(plant.problems.length > 0, `${plant.where}: the planted column reported`)
				assert.deepEqual(
					Arr.filter(plant.problems, (line) => !Str.startsWith(`${plant.where} column `)(line)),
					[],
					`${plant.where}: every problem at the planted part`
				)
			}
			k.note(typed.planted.length > 0 ? "a part planted" : "no attachment's part to plant")
		})
})
