import { array, type Gen } from "@bjornpagen/testing/gen"
import { Effect } from "effect"
import { compileInstallation } from "#compiler/program/install.ts"
import { type PayrollProgram, payrollPrograms } from "#test/pg/oracle/payroll/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { templateNeedBudget } from "#test/support/budgets.ts"
import * as P from "#test/support/fixtures/api/payroll.ts"
import {
	appliedHistory,
	draftedHistory,
	type HistoryOptions,
	type Installed,
	noPlaceholders,
	templateInstalled
} from "#test/support/install-migrate.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import {
	type ParamSketch,
	type PayrollSketch,
	paramSketchGen,
	payrollSketchGen
} from "#test/support/oracle/gen/payroll.ts"
import { installTemplate } from "#test/support/substrate/substrate.ts"

/**
 * A state and one parameter sketch per program, reused cyclically: eight sketches vary the bindings of every program.
 */
export interface CaseSketch {
	readonly facts: PayrollSketch
	readonly params: ReadonlyArray<ParamSketch>
}

/** A case: a payroll state's sketch and up to eight parameter sketches. */
export const caseGen: Gen<CaseSketch> = (source) => ({
	facts: source.draw(payrollSketchGen),
	params: source.draw(array(paramSketchGen, { min: 1, max: 8 }))
})

/** How Reporting is installed: through its first migration, as an ordinary session, with no extension or login. */
const options: HistoryOptions = {
	label: "real",
	extensions: [],
	compile: compileInstallation,
	ambient: ordinarySession,
	review: noPlaceholders
}

/** What a case over the payroll template reads: Reporting installed in its clone, and every payroll program compiled for it. */
interface PayrollInstalled {
	readonly installed: Installed
	readonly programs: ReadonlyArray<PayrollProgram>
}

/**
 * Reporting installed through its first migration, as the search installed it once before its cases, and every payroll
 * program compiled for its installed name: the template every case clones, built once per member and planned (the
 * programs compiled) once per worker, so no case installs or compiles again.
 */
export const payrollTemplate = installTemplate({
	budget: templateNeedBudget,
	declaredIn: import.meta,
	name: "payroll",
	content: { schema: "Reporting", logins: [], ambient: "ordinary", label: "real" },
	plan: (names) =>
		Effect.map(
			draftedHistory(
				[{ schema: P.Reporting, declarations: noDeclarations }],
				options,
				names.schema
			),
			(history) => ({ names, history, programs: payrollPrograms(names.schema) })
		),
	install: ({ names, history }) =>
		Effect.asVoid(appliedHistory(history, names.schema, options, new Map())),
	bind: ({ names, history, programs }, binding): PayrollInstalled => ({
		installed: templateInstalled(names, history, options.ambient, new Map(), binding),
		programs
	})
})
