/**
 * The optimized lowering against the conservative lowering on the optimizer's population (gen/case.ts
 * optimizerGenConfig), each case under a plan perturbation drawn with it (test/support/oracle/perturb.ts), so joins,
 * fanout, groups, projected duplicates, unions and closures meet real rows.
 *
 * The population is the conservative suite's: one to four relations with composite and candidate keys, closed rosters,
 * pure sets, containments and mutable relations, small-domain facts including NaN, -0, numeric display scales and
 * supplementary-plane text, and queries over match, filter, project, semi- and anti-join, union, intersection,
 * difference, group, take, attach and recursion, at the root as a plain set, with attachments, or as a heterogeneous
 * union, with scalar and relation parameters; and it draws what each rewrite family needs besides: containments to read
 * through, wide payload under takes with stated orders, total computed terms, equations, filters read through regions
 * and rooted closures. Each case runs under the optimized artifact compiled for the `snapshot` context against the
 * installation's own evidence catalog, against the conservative lowering (support.ts), and
 * the population must reach every rewrite family (its required features). No generated term raises (every partial
 * operation is guarded, gen/compute.ts), so an execution error of any form is a defect.
 *
 * Oracle: the conservative lowering's raw text sets, no repeated row on the optimized side.
 *
 * Features: the population's required features (suite.ts and the file's own), "a fold key correlated with two parent
 * columns" among them, which a case whose turn aims at it reaches by the case built to (suite.ts foldKeyTwiceGen). Its
 * escaped counterexamples are recorded beside its population and kept by their tokens (optimizer.fixtures.ts
 * optimizerCounterexamples).
 */
import type { Reached } from "@bjornpagen/testing/features"
import { recorded } from "@bjornpagen/testing/gen"
import { ReplayToken } from "@bjornpagen/testing/property"
import { Function } from "effect"
import {
	optimizerCounterexamples,
	optimizerSituations
} from "#test/pg/oracle/optimized/optimizer.fixtures.ts"
import {
	differentialProperty,
	optimizedSpace,
	type OptimizedFeature
} from "#test/pg/oracle/optimized/suite.ts"
import { optimizerGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { namedPlacement } from "#test/support/oracle/runner.ts"

/** The optimized lowering agrees with the conservative on the optimizer's population, raw text sets, no repeated row. */
export const optimizer = differentialProperty(
	optimizedSpace(recorded(queryCaseGen(optimizerGenConfig), optimizerCounterexamples)),
	Function.identity,
	namedPlacement("opt"),
	{
		situations: optimizerSituations satisfies ReadonlyArray<Reached<OptimizedFeature>>,
		/**
		 * Its search budget: the fewest runs at which each kill it declares still fails a witness, the cull rule's measure
		 * (grizzle main, 2026-11-23).
		 *
		 * @limitKind measured
		 * @owner test/pg/oracle/optimized/optimizer.test.ts optimizer
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
		 * @workload its witnesses with each of its two kills applied, every kill on workers of its own, and its full run,
		 *   at runs 1250, 141, 137 and 1, steered 1250
		 * @result runs 1250 (pre-conversion): the dedup/place.ts kill fails floor case 10, the shapes/attach kill floor
		 *   case 35, its situations reached with 688 steered cases, 2,251 cases at f1bf91a2f's gate; runs 141: both killed,
		 *   1,120 steered, 1,297 cases; runs 137: floor case 10 and steered case 19; runs 1: both killed, 1,216 steered,
		 *   1,218 cases. 2026-11-24, lane KILLFIX, on grizzle 930b3243b: a counterexample its steered phase caught at
		 *   case 411 (seed 0x97ccc399), recorded and kept, and its kill, the co-group keyed by each parent column's first
		 *   pair, added; the kept case kills it at every budget. A per-key fold whose key two parent columns pair, built
		 *   and kept beside it, kills the fold kill, which survived the whole steered phase once DECIDE8 co-grouped the
		 *   aimed fold (suite.ts foldKeyTwiceCase)
		 * @decision runs 1, the fewest that keeps a floor case and a fresh one each run and the fewest cases in all, since
		 *   its 244 required situations are reached by the steered phase wherever the floor leaves them. steered 2500,
		 *   about twice the 1,216 its situations took at runs 1 and past the 1,250 it had: the phase stops once every
		 *   situation is reached, so a green run spends only its need, and the headroom keeps a drawn case's change from
		 *   leaving a situation unreached by a few cases
		 * @revalidate a change of its generator, its check or a kill's file, a kill added, or a change of how the testing
		 *   library draws a floor or steered case; the kill gate (toolchain-test kills, affected) reports a kill that
		 *   survives
		 */
		budget: { runs: 1, steered: 2500 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/oracle/optimized/optimizer.test.ts#optimizer:-:1.0.0.0.0.0.0.0.0.1.0"
				),
				reason:
					"seed 0x97ccc399, steered case 411, shrunk by hand: a parent column paired with two child columns of a co-grouped attachment",
				since: "2026-11-24"
			},
			{
				token: ReplayToken(
					"test/pg/oracle/optimized/optimizer.test.ts#optimizer:-:2.0.0.0.0.0.0.0.0.1.0"
				),
				reason:
					"built by hand: a fold's key paired with two parent columns, read per key, which no drawn case reaches since DECIDE8 co-groups the aimed fold",
				since: "2026-11-24"
			}
		],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/dedup/place.ts",
				original: "\t\tconst outstanding = a.obligations.flatMap((o) => (o.discharged ? [] : [o]))",
				replacement: "\t\tconst outstanding = a.obligations.flatMap(() => [])",
				why: "The dedup placement discharges no obligation (lower/optimize/dedup/place.ts), so a DISTINCT owed is never placed and the optimized artifact repeats rows."
			},
			{
				file: "packages/engine/src/lower/shapes/attach/index.ts",
				original:
					"\tconst correlation = pairs.map((c) => ({ column: c.child, value: columnIn(parentMap, c.parent) }))\n",
				replacement:
					'\tconst correlation = (\n\t\tchild.kind === "Group" ? [...new Map(pairs.map((c) => [c.child, c] as const)).values()] : pairs\n\t).map((c) => ({ column: c.child, value: columnIn(parentMap, c.parent) }))\n',
				why: "The fold an attachment restricts by its parent's values keeps one equality per key column (lower/shapes/attach/index.ts keyedRows), so a key paired with two parent columns is restricted by one of them and a parent whose two columns differ receives a group."
			},
			{
				file: "packages/engine/src/lower/shapes/attach/index.ts",
				original: "\tconst pairs = attach.correlation\n",
				replacement:
					"\tconst pairs = attach.correlation.filter(\n\t\t(p, i) => attach.correlation.findIndex((q) => q.parent === p.parent) === i\n\t)\n",
				why: "The co-group keys each parent column by the first child column paired with it (lower/shapes/attach/index.ts coGroupedRows), so a parent column paired with two child columns drops the second pair's equality and a parent receives the child rows that equal it at one of them."
			}
		]
	}
)
