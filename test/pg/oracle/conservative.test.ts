/**
 * The conservative lowering against the brute-force reference evaluator on PostgreSQL 19.
 *
 * Generated cases of the generator's own population, and of the same population with denser facts so that fewer
 * results are empty, each population a property of its own, each case in its own database under a plan perturbation: one to four relations with composite and candidate keys, closed rosters, pure sets and
 * containments, small-domain facts including NaN, -0, numeric display scales and supplementary-plane text in their
 * stored spellings, and queries over match, filter, project, semi- and anti-join, union, intersection, difference,
 * group, take, attach and recursion, at the root as a plain set, with attachments, or as a heterogeneous union. For
 * every case, every statement the conservative lowering emits returns exactly the canonical cell set the
 * reference evaluator computes by definition: the same rows, each once, since every statement delivers a set. And the
 * runner judges the case against itself (runner.ts runOracle, its second reading): its facts stored otherwise, another
 * storage order and one value in another spelling, under another plan, must deliver exactly the same rows, with no
 * reference in the judgment. A failing case shrinks and is reported in printable form.
 *
 * Oracle: the brute-force reference evaluator, and the case against itself under another storage and spelling.
 *
 * Features: the situations below, every operator kind among them, and each decline of the reference, rated.
 */
import { type Budget, ReplayToken } from "@bjornpagen/testing/property"
import { conservativeAgreement } from "#test/pg/oracle/conservative.fixtures.ts"
import { denseQueryCaseGen } from "#test/pg/oracle/support.ts"
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"

/**
 * Its search budget: the fewest runs at which each kill it declares still fails a witness, the cull rule's measure
 * (grizzle main, 2026-11-23).
 *
 * @limitKind measured
 * @owner test/pg/oracle/conservative.test.ts generated
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
 * @workload its witnesses with each of its two kills applied, every kill on workers of its own, and its full run, at
 *   runs 2000, 45, 41 and 1, steered 2000
 * @result runs 2000 (pre-conversion): the anti-join kill fails floor case 11, the dag-digest kill floor case 5; runs
 *   45: both killed, its situations reached with 208 steered cases, 265 cases in all; runs 41: steered case 25 and
 *   floor case 5; runs 1: both killed, 96 steered, 98 cases in all where f1bf91a2f's gate ran 2,025
 * @decision runs 1, the fewest that keeps a floor case and a fresh one each run and the fewest cases in all. steered
 *   stays its pre-conversion 2000: the phase stops once every required situation is reached, so a green run spends
 *   only its need, 96 here, and the cap only bounds a run whose situation went unreached
 * @revalidate a change of its generator, its check or a kill's file, a kill added, or a change of how the testing
 *   library draws a floor or steered case; the kill gate (toolchain-test kills, affected) reports a kill that
 *   survives
 */
const generatedBudget: Budget = { runs: 1, steered: 2000 }

/**
 * Its search budget: the fewest runs at which each kill it declares still fails a witness, the cull rule's measure
 * (grizzle main, 2026-11-23).
 *
 * @limitKind measured
 * @owner test/pg/oracle/conservative.test.ts dense
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
 * @workload its witnesses with its kill applied, on workers of its own, and its full run, at runs 2000, 1373 and
 *   1369, steered 2000
 * @result runs 2000 (pre-conversion): the gen/ops.ts kill fails floor case 343; runs 1373 (a floor of 344): killed,
 *   its situations reached on the floor, 1,717 cases in all where f1bf91a2f's gate ran 2,500; runs 1369 (a floor of
 *   343): it survives, every witness passing
 * @decision runs 1373, the fewest whose floor holds case 343. steered stays its pre-conversion 2000: the phase stops
 *   once every required situation is reached, so a green run spends only its need, none here, and the cap only bounds
 *   a run whose situation went unreached
 * @revalidate a change of its generator, its check or a kill's file, a kill added, or a change of how the testing
 *   library draws a floor or steered case; the kill gate (toolchain-test kills, affected) reports a kill that
 *   survives
 */
const denseBudget: Budget = { runs: 1373, steered: 2000 }

/** The conservative lowering agrees with the reference evaluator on generated cases, raw text sets, no repeated row. */
export const generated = conservativeAgreement(
	queryCaseGen(defaultGenConfig),
	[
		{
			token: ReplayToken(
				"test/pg/oracle/conservative.test.ts#generated:-:1.7.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0.1.2.1.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.b.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0"
			),
			reason:
				"f1bf91a2f's gate, rotating 0x45dc0b3e, case 710: a relation parameter's facts (0) and ('-0') matched whole, two rows the conservative lowering delivered and the reference evaluator held as one (c7da3c9b1)",
			since: "2026-11-22"
		}
	],
	[
		{
			file: "packages/engine/src/lower/conservative/anti-join/index.ts",
			original: "\t\texistenceTest(cx, env, node, nodeLabel(node), true, atLeftRow)",
			replacement: "\t\texistenceTest(cx, env, node, nodeLabel(node), false, atLeftRow)",
			why: "The conservative AntiJoin lowers as a semi-join (lower/conservative/anti-join/index.ts)."
		},
		{
			file: "packages/engine/src/ir/dag-digest.ts",
			original:
				'\t\tif (!this.exprs.has(expr.id)) {\n\t\t\tthis.met.push({ kind: "expr", expr })\n\t\t}\n\t\treturn this.exprs.index(expr.id)\n\t}\n\n\t/**\n\t * An expression\'s dependencies as the form names them',
			replacement:
				'\t\tif (this.exprs.has(expr.id)) {\n\t\t\tthis.met.push({ kind: "expr", expr })\n\t\t}\n\t\treturn this.exprs.index(expr.id)\n\t}\n\n\t/**\n\t * An expression\'s dependencies as the form names them',
			why: "Operator mutant (negation) at packages/engine/src/ir/dag-digest.ts ReachNumbering.expr, formerly ir/dag.ts:856 in exprRef: `!e.has(expr.id)` becomes `e.has(expr.id)`; the property fails (lane CATCH, grizzle 0baff5d6, against the mutation tester's oracle subset scripts/dev/mutate/oracle/queries.test.ts, which this property's agreement replaces)."
		}
	],
	generatedBudget
)

/** The same agreement on generated cases with dense facts, so fewer results are empty. */
export const dense = conservativeAgreement(
	denseQueryCaseGen(defaultGenConfig),
	[],
	[
		{
			file: "test/support/oracle/gen/ops.ts",
			original: '\tfn === "count" ? naturalType : overloadOf(fn, type).result',
			replacement:
				'\tfn === "count"\n\t\t? Object.assign({}, naturalType, { contract: Object.assign({}, naturalType.contract, { predicate: undefined }) })\n\t\t: overloadOf(fn, type).result',
			why: "A count is typed natural without its predicate, as a builder's environment builds it, so the classes a union arm's literal of a count's column is drawn from hold int8's negatives, and the floor's union of a count with -1 stores a value natural's domain refuses (23514)."
		}
	],
	denseBudget
)
