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
	/** Its pre-conversion budget: runs 60, coverage cases 60 (differential.test.ts `cases` at 4fbc3e95). */
	budget: { runs: 60, steered: 60 },
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
