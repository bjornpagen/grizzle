/**
 * The correlated take, in its one probe form (lower/shapes/take), and the one fused attachment, against the
 * conservative lowering: the optimized output equals the conservative output.
 *
 * The cases are built over one fixed schema, their shapes and facts generated, so every one of them reaches a take of
 * a relation's first k rows per parent, in a total order, read LATERAL once per parent:
 *
 * - an attachment's delivered parent keys: accounts P(id, a, e) with each one's first k entries C(k, p, v) attached by
 *   p = id, through a narrow child over a region of C, a wide one that also delivers C's further columns, and one that
 *   delivers only the entry's key. Each is pipelined over the parent-key recordset, its parents reading no approximate
 *   search;
 * - the same attachments to the accounts nearest a probe vector by the cosine distance of their embedding e, one
 *   ApproximateNearest search over one rule's projection, which keeps the account's key id or only its group a (so the
 *   search deduplicates its candidates), the entries attached by p equal to that column. This is the one case an
 *   attachment fuses: its parent's rows read an approximate search, which a pipelined statement would run a second
 *   time (lower/shapes/index.ts rowsStatement), so the child is an array column of the parent statement, one field
 *   as text[] and several as jsonb[], which the runner unfuses and compares with the conservative lowering's pipelined
 *   statement. The oracle installation builds no HNSW index, so both lowerings' searches are the exact top k, ties at
 *   the cutoff settled by the heading's other column in both;
 * - a relation parameter: a region binding each id of the parameter to the first k entries with that p.
 *
 * Every case runs through the differential (support.ts): the program's statement, and the VALUES transport of a small
 * relation parameter, each compared with the conservative run as raw text sets
 * with no repeated row. Each case installs the schema in its own database (runner.ts installedPlacement), and loads
 * its facts in its own rolled-back transaction.
 *
 * Oracle: the conservative lowering's raw text sets, no repeated row on the optimized side.
 *
 * Features: the population's required features (suite.ts and the file's own).
 */
import type { Reached } from "@bjornpagen/testing/features"
import { differentialProperty, type OptimizedFeature } from "#test/pg/oracle/optimized/suite.ts"
import {
	resolve,
	sketchGen,
	variantSituations
} from "#test/pg/oracle/optimized/variants.fixtures.ts"
import { installedPlacement } from "#test/support/oracle/runner.ts"

/** Correlated-take cases agree with the conservative lowering. */
export const variants = differentialProperty(sketchGen, resolve, installedPlacement("variants"), {
	situations: variantSituations satisfies ReadonlyArray<Reached<OptimizedFeature>>,
	/**
	 * Its search budget: the fewest runs at which each kill it declares still fails a witness, the cull rule's measure
	 * (grizzle main, 2026-11-23).
	 *
	 * @limitKind measured
	 * @owner test/pg/oracle/optimized/variants.test.ts variants
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
	 * @workload its witnesses with its kill applied, on workers of its own, and its full run, at runs 250, 105, 101 and
	 *   1, steered 250
	 * @result runs 250 (pre-conversion): the dedup/place.ts kill fails floor case 26; runs 105: killed; runs 101: steered
	 *   case 16; runs 1: killed, its situations reached with 32 steered cases, 34 cases in all where f1bf91a2f's gate ran
	 *   313
	 * @decision runs 1, the fewest that keeps a floor case and a fresh one each run. steered stays its pre-conversion
	 *   250: the phase stops once every required situation is reached, so a green run spends only its need, 32 here, and
	 *   the cap only bounds a run whose situation went unreached
	 * @revalidate a change of its generator, its check or a kill's file, a kill added, or a change of how the testing
	 *   library draws a floor or steered case; the kill gate (toolchain-test kills, affected) reports a kill that
	 *   survives
	 */
	budget: { runs: 1, steered: 250 },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/lower/optimize/dedup/place.ts",
			original: "\t\tconst outstanding = a.obligations.flatMap((o) => (o.discharged ? [] : [o]))",
			replacement: "\t\tconst outstanding = a.obligations.flatMap(() => [])",
			why: "The dedup placement discharges no obligation (lower/optimize/dedup/place.ts), so a DISTINCT owed is never placed and the optimized artifact repeats rows."
		}
	]
})
