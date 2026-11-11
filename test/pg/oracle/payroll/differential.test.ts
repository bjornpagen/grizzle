/**
 * Every payroll program through the optimized artifact against the conservative lowering, on generated lawful payroll
 * facts (./support.ts). The suite explores through the oracle runner (test/support/oracle/runner.ts): each case under
 * planner settings; a failing case shrinks to its state and bindings.
 *
 * The population must reach every program with rows: a program that never delivers a row compares nothing, so each
 * program's delivering a row is a required feature. Two ChangeSet members compile only inside their ChangeSet.
 *
 * Oracle: the conservative lowering of every payroll program.
 *
 * Plants: oracle-optimized-obligations-dropped (a DISTINCT owed is never placed).
 *
 * Features: each payroll program, and a case that delivers rows.
 */
import { layer } from "@effect/vitest"
import { sketched } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	type PayrollProgramName,
	payrollPrograms,
	runPayrollCase
} from "#test/pg/oracle/payroll/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { nonEmpty } from "#test/support/assert.ts"
import * as P from "#test/support/fixtures/api/payroll.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import {
	type ParamSketch,
	type PayrollSketch,
	paramSketchGen,
	payrollSketchGen,
	resolvePayroll
} from "#test/support/oracle/gen/payroll.ts"
import { oracleCheck } from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const cases = 60

/** A payroll program whose conservative run delivered a row, by its exported name. */
type PayrollFeature = `delivered ${PayrollProgramName}`

/**
 * A state and one parameter sketch per program, reused cyclically: eight sketches vary the bindings of every program.
 */
interface CaseSketch {
	readonly facts: PayrollSketch
	readonly params: ReadonlyArray<ParamSketch>
}

const caseGen: Gen<CaseSketch> = (source) => ({
	facts: source.draw(payrollSketchGen),
	params: source.draw(array(paramSketchGen, { min: 1, max: 8 }))
})

/** Every payroll program, each compiled standalone, optimized against conservative on generated states. */
const run = Effect.gen(function* () {
	const installed = yield* install(P.Reporting, {
		ambient: ordinarySession,
		extensions: [],
		logins: [],
		label: "real"
	})
	const programs = payrollPrograms(installed)
	return yield* oracleCheck(
		sketched(caseGen, (k) => ({ facts: resolvePayroll(k.facts), params: k.params })),
		{
			suite: "payroll/differential",
			oracle: {
				kind: "second-implementation",
				name: "the conservative lowering of every payroll program"
			},
			literal: Formatter.format,
			coverage: required<PayrollFeature>(
				Arr.map(
					nonEmpty(programs, "the payroll programs the compiler admits"),
					(p): PayrollFeature => `delivered ${p.name}`
				),
				{ cases: cases, sense: notesOnly }
			),
			kept: [],
			runs: cases,
			shrink: completeShrink,
			perturb: "planner"
		},
		(c, notes) =>
			Effect.map(runPayrollCase(installed, programs, c), (outcomes) => {
				for (const o of outcomes) {
					if (Arr.some(o.conservative.statements, (s) => s.rows.length > 0)) {
						notes.note(`delivered ${o.name}`)
					}
				}
			})
	)
})

layer(Substrate.layer, { excludeTestServices: true })(
	"the payroll programs, optimized against conservative on generated facts",
	(it) => {
		it.effect(`${cases} generated payroll states: every program agrees`, (ctx) =>
			searched(ctx, run)
		)
	}
)
