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
		/** Its pre-conversion budget: runs 300, coverage cases 300 (valid-rewrites.test.ts:65 at fe79ac6b2^). */
		budget: { runs: 300, steered: 300 },
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
