/**
 * The mutant suite's valid transformation V1, a DISTINCT elided where a projection retains a primary key, is performed
 * by the optimized lowering, which its certificate (R17.elide.retainedPrimaryKey) asserts.
 *
 * It runs on the generated population rooted at a projection (test/support/oracle/mutants cases.ts projectRoot, dense
 * facts) through the optimized differential, so every case also agrees with the conservative lowering in raw sets with
 * no repeated row. Some case records the certificate (the property's required situation), and wherever it is recorded
 * the optimized statements hold fewer DISTINCT cores than the conservative ones, read from the statements' ASTs, never
 * from the text. That the optimizer reaches the other valid transformations' certificates (V2 combinedJoinKeys, V3
 * R02.existence, V5 R17.unionAll, V6 R17.recursiveTerms) is the optimizer population's required situations
 * (optimizer.test.ts, suite.ts generatedRules).
 *
 * Oracle: the conservative lowering's raw text sets, and V1's certificate read from the statements' ASTs.
 *
 * Features: V1's certificate recorded.
 */
import type { Case as PropertyCase } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	agrees,
	baselineIsSet,
	differentialCase,
	plainDifferential,
	printDifferential
} from "#test/pg/oracle/optimized/support.ts"
import {
	fewerDistinctCores,
	retainedPrimaryKey
} from "#test/pg/oracle/optimized/valid-rewrites.fixtures.ts"
import { defaultGenConfig } from "#test/support/oracle/gen/case.ts"
import { projectRoot, rootedCaseGen } from "#test/support/oracle/mutants/cases.ts"
import { namedPlacement, oracleProperty, PropertyFailed } from "#test/support/oracle/runner.ts"

/** V1 is performed and certified on its mutant's population: fewer DISTINCT cores wherever its certificate is recorded. */
export const retainedPrimaryKeyElided = oracleProperty(
	rootedCaseGen(projectRoot, defaultGenConfig),
	{
		situations: [retainedPrimaryKey],
		perturb: "all",
		oracle: {
			kind: "second-implementation",
			name: "the conservative lowering's raw text sets, and V1's certificate read from the statements' ASTs"
		},
		kept: [],
		/**
		 * Its search budget: the fewest runs at which each kill it declares still fails a witness, the cull rule's measure
		 * (grizzle main, 2026-11-23).
		 *
		 * @limitKind measured
		 * @owner test/pg/oracle/optimized/valid-rewrites.test.ts retainedPrimaryKeyElided
		 * @unit cases
		 * @scope one search of this property: `runs` cases of its rotating stream and a quarter of them, rounded up, of its
		 *   floor stream; `steered` the most its steered phase runs while a required situation is unreached
		 * @evidence `toolchain-test kills` and `toolchain-test run` of test/pg/oracle's test files at TEST_SEED=2219874524
		 *   (a property's witnesses, its kept cases, floor and steered phase, are fixed by its identity, the same on every
		 *   seed), each killed kill's failing witness printed by an uncommitted line in vendor/toolchain's
		 *   mutate/commands.ts; the logs kills0.log (the pre-conversion budgets), run1.log, kills2.log, run3.log,
		 *   kills4.log, v1at5.log, fs5.log, fs9.log, fs13.log and run5.log in ~/.cache/grizzle/CULL-ORACLE-out on
		 *   cassowary, uncommitted
		 * @observed 2026-11-23 03:12 to 04:36 UTC
		 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, load average 130 to 410 from other
		 *   lanes; vendor/toolchain 2cc48172; the budgets measured on grizzle f87b2aaab with 47748474c's change and
		 *   verified on dff9200ef (run5.log, every property green and every kill killed); lane CULL-ORACLE's in-memory
		 *   family of two PostgreSQL 19 members
		 * @workload its witnesses with its kill applied, on workers of its own, and its full run, at runs 298, 9 and 5,
		 *   steered 300
		 * @result runs 298: the dedup/place.ts kill fails floor case 2; runs 9 (a floor of three): killed, its situation
		 *   reached on the floor; runs 5 (a floor of two): it survives
		 * @decision runs 9, the fewest whose floor holds case 2. steered stays its pre-conversion 300: the phase stops once
		 *   every required situation is reached, so a green run spends only its need, none here, and the cap only bounds a
		 *   run whose situation went unreached
		 * @revalidate a change of its generator, its check or a kill's file, a kill added, or a change of how the testing
		 *   library draws a floor or steered case; the kill gate (toolchain-test kills, affected) reports a kill that
		 *   survives
		 */
		budget: { runs: 9, steered: 300 },
		kills: [
			{
				file: "packages/engine/src/lower/optimize/dedup/place.ts",
				original: "\t\tconst outstanding = a.obligations.flatMap((o) => (o.discharged ? [] : [o]))",
				replacement: "\t\tconst outstanding = a.obligations.flatMap(() => [])",
				why: "The dedup placement discharges no obligation (lower/optimize/dedup/place.ts), so a DISTINCT owed is never placed and the optimized artifact repeats rows."
			}
		],
		show: Formatter.format,
		check: (k: PropertyCase<typeof retainedPrimaryKey>) => (c) =>
			Effect.gen(function* () {
				const placement = yield* namedPlacement("valid")
				const o = yield* differentialCase(c, { ...plainDifferential, placement })
				if (!baselineIsSet(o) || !agrees(o)) {
					return yield* new PropertyFailed({ report: printDifferential(o) })
				}
				if (!Arr.some(o.certificates, (cert) => cert.rule === retainedPrimaryKey)) {
					return
				}
				k.note(retainedPrimaryKey)
				if (!fewerDistinctCores(o)) {
					return yield* new PropertyFailed({
						report: `V1: ${retainedPrimaryKey} is recorded but the SQL has no fewer DISTINCT cores than the conservative statements\n${printDifferential(o)}`
					})
				}
			})
	}
)
