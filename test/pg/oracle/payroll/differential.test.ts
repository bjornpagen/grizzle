/**
 * Every payroll program through the optimized artifact against the conservative lowering, on generated lawful payroll
 * facts (./support.ts). The property runs through the oracle runner (test/support/oracle/runner.ts): each case under
 * planner settings, in a clone of its own of Reporting installed (differential.fixtures.ts payrollTemplate); a failing
 * case shrinks to its state and bindings.
 *
 * The population must reach every program with rows: a program that never delivers a row compares nothing, so each
 * program's delivering a row is a required situation. Two ChangeSet members compile only inside their ChangeSet.
 *
 * Oracle: the conservative lowering of every payroll program.
 *
 * No payroll program owes a DISTINCT its keys leave undischarged, so a dedup placement that places none compiles every
 * one of them to the same artifact; the optimized population suites (test/pg/oracle/optimized) hold the placement.
 *
 * Features: each payroll program, and a case that delivers rows.
 */
import type { Reached } from "@bjornpagen/testing/features"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { caseGen, payrollTemplate } from "#test/pg/oracle/payroll/differential.fixtures.ts"
import {
	type PayrollProgramName,
	payrollProgramNames,
	runPayrollCase
} from "#test/pg/oracle/payroll/support.ts"
import { resolvePayroll } from "#test/support/oracle/gen/payroll.ts"
import { installedOracleProperty } from "#test/support/oracle/runner.ts"

/** Every payroll program, each compiled standalone, agrees optimized against conservative on generated states. */
export const differential = installedOracleProperty(payrollTemplate, caseGen, {
	situations: Arr.map(
		payrollProgramNames,
		(name): `delivered ${PayrollProgramName}` => `delivered ${name}`
	) satisfies ReadonlyArray<Reached<`delivered ${PayrollProgramName}`>>,
	perturb: "planner",
	oracle: {
		kind: "second-implementation",
		name: "the conservative lowering of every payroll program"
	},
	kept: [],
	/**
	 * Its search budget: the fewest runs at which each kill it declares still fails a witness, the cull rule's measure
	 * (grizzle main, 2026-11-23).
	 *
	 * @limitKind measured
	 * @owner test/pg/oracle/payroll/differential.test.ts differential
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
	 * @workload its witnesses with its kill applied, on workers of its own, and its full run, at runs 60 and 1, steered
	 *   60
	 * @result runs 60 (pre-conversion): with the sql/print.ts kill applied its need, Reporting's template installed
	 *   (differential.fixtures.ts payrollTemplate), fails before any case runs, so the kill fails it at every budget;
	 *   runs 1: killed, its situations reached with 32 steered cases, 34 cases in all where f1bf91a2f's gate ran 107
	 * @decision runs 1, the fewest that keeps a floor case and a fresh one each run. steered stays its pre-conversion 60:
	 *   the phase stops once every required situation is reached, so a green run spends only its need, 32 here, and the
	 *   cap only bounds a run whose situation went unreached
	 * @revalidate a change of its generator, its check or a kill's file, a kill added, or a change of how the testing
	 *   library draws a floor or steered case; the kill gate (toolchain-test kills, affected) reports a kill that
	 *   survives
	 */
	budget: { runs: 1, steered: 60 },
	kills: [
		{
			file: "packages/engine/src/sql/print.ts",
			original: '\ttype.kind === "builtin" && type.name === "integer" && !type.array',
			replacement: '\ttype.kind === "builtin" && !type.array',
			why: 'Operator mutant (conjunct) at packages/engine/src/sql/print.ts:388 in isInt4: `type.kind === "builtin" && type.name === "integer" && !type.array` becomes `type.kind === "builtin" && !type.array`; the property fails (lane CATCH, grizzle 0baff5d6).'
		}
	],
	show: Formatter.format,
	check:
		(notes: Case<`delivered ${PayrollProgramName}`>, { installed, programs }) =>
		(sketch) =>
			Effect.map(
				runPayrollCase(installed, programs, {
					facts: resolvePayroll(sketch.facts),
					params: sketch.params
				}),
				(outcomes) => {
					for (const o of outcomes) {
						if (Arr.some(o.conservative.statements, (s) => s.rows.length > 0)) {
							notes.note(`delivered ${o.name}`)
						}
					}
				}
			)
})
