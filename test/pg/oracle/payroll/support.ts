import { Array as Arr, Effect, Formatter, Option, pipe, Record as Rec, String as Str } from "effect"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import { identity } from "#compiler/core/identity.ts"
import * as Result from "#compiler/core/result.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import {
	type ConservativeParamSlot,
	flight,
	type StatementRoots
} from "#compiler/lower/conservative/types.ts"
import { deliveredAsOptimized, type OptimizedStatement } from "#compiler/lower/shapes/index.ts"
import type { QueryTemplate } from "#compiler/program/compile.ts"
import { parseSchemaInput } from "#compiler/program/schema.ts"
import { isOrderedValue, isQueryValue } from "#compiler/query/build/query.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { delivered, executeStatements, orderProblems } from "#test/pg/oracle/optimized/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { codebookFor, compileTemplate, testCompile } from "#test/support/compile.ts"
import * as P from "#test/support/fixtures/api/payroll.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	type Comparison,
	compareRuns,
	printComparison,
	printRun,
	type Run
} from "#test/support/oracle/compare.ts"
import { largeFormPrograms } from "#test/support/oracle/forms.ts"
import {
	type ParamSketch,
	type PayrollFacts,
	payrollParam
} from "#test/support/oracle/gen/payroll.ts"
import { factStatements } from "#test/support/oracle/install/load.ts"
import { CurrentPerturbation, plannerStatements } from "#test/support/oracle/perturb.ts"
import { PropertyFailed, sqlMessage } from "#test/support/oracle/runner.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Every program name payrollPrograms builds, in the fixture's export order: a program renamed, added or removed is a
 * compile error wherever its name is typed (the differential's required features), and payrollPrograms refuses a
 * fixture whose programs differ from it.
 */
const payrollProgramNames = [
	"Org",
	"approveShiftsMember",
	"employeeCard",
	"employeesByPrefix",
	"ledger",
	"ledgerBalance",
	"orgOf",
	"payPaymentMember",
	"payPutMember",
	"payslip",
	"postingMember",
	"reverseDeleteMember",
	"reversePutMember",
	"reverseVoidingMember",
	"runStages",
	"runTotalOf",
	"runTotals",
	"splitSegments",
	"withholdingFor",
	"withinTwo"
] as const

export type PayrollProgramName = (typeof payrollProgramNames)[number]

export interface PayrollProgram {
	readonly name: PayrollProgramName
	readonly template: QueryTemplate
	/** The codes the program is compiled under, which its delivered rows decode closed ids by. */
	readonly codes: Codebook
}

/** The program name of an export, or a defect: payrollProgramNames names every program the fixture exports. */
const programNameOf = (name: string): PayrollProgramName => {
	const known = Arr.findFirst(payrollProgramNames, (n) => n === name)
	if (Option.isNone(known)) {
		throw new Error(
			`the payroll fixture exports the program ${name}, which payrollProgramNames lacks`
		)
	}
	return known.value
}

/**
 * Every query and ordered query the payroll fixture exports, compiled against Reporting under the installed name. Each
 * compiles standalone, a ChangeSet member included, since a parameter is of its declared type wherever it stands; one
 * that does not is a defect.
 */
export const payrollPrograms = (installed: Installed): ReadonlyArray<PayrollProgram> => {
	const programs: Array<PayrollProgram> = []
	const codes = succeeded(
		Result.flatMap(parseSchemaInput(P.Reporting), (input) => codebookFor(input, testCompile.codes))
	)
	for (const [name, value] of Rec.toEntries(P)) {
		if (!isQueryValue(value) && !isOrderedValue(value)) {
			continue
		}
		const compiled = compileTemplate(value, P.Reporting, {
			...testCompile,
			installation: identity.schema(parsedSchemaName(installed.declared))
		})
		if (!compiled.ok) {
			throw new Error(`the payroll program ${name} does not compile: ${compiled.error.message}`)
		}
		programs.push({ name: programNameOf(name), template: compiled.value, codes })
	}
	const built = Arr.map(programs, (p) => p.name)
	if (Arr.join(built, ",") !== Arr.join(payrollProgramNames, ",")) {
		throw new Error(`the payroll programs ${Arr.join(built, ", ")} differ from payrollProgramNames`)
	}
	return programs
}

export interface PayrollCase {
	readonly facts: PayrollFacts
	/** One parameter sketch per program, by position, reused cyclically. */
	readonly params: ReadonlyArray<ParamSketch>
}

/** What one program delivered and how its optimized forms compared. */
export interface ProgramOutcome {
	readonly name: PayrollProgramName
	readonly params: Readonly<Record<string, string>>
	readonly conservative: Run
	readonly optimized: ReadonlyArray<{
		readonly form: string
		readonly run: Run
		readonly comparison: Comparison
		readonly order: ReadonlyArray<string>
	}>
}

const fail = (message: string) => Effect.fail(new PropertyFailed({ report: message }))

/** The input texts of a program's scalar parameters for one case. */
const bindings = (
	params: ReadonlyArray<ParamDecl>,
	facts: PayrollFacts,
	sketch: ParamSketch
): Readonly<Record<string, string>> =>
	Rec.fromEntries(
		Arr.map(params, (p, i) => [
			p.id,
			payrollParam(facts, p.name, { pick: sketch.pick + i * 3, absent: sketch.absent && i === 0 })
		])
	)

/** A placeholder's text: a scalar parameter's binding. */
const fill =
	(values: Readonly<Record<string, string>>) =>
	(slot: ConservativeParamSlot): string | undefined => {
		switch (slot.kind) {
			case "scalar":
				return values[slot.param]
			case "relation":
				return undefined
			case "member":
			case "page":
				throw new Error(
					`a query statement's placeholder is a declared parameter, not a ${slot.kind} placeholder`
				)
		}
	}

const ordered = (root: RelNode): boolean => root.kind === "OrderedResult"

/** Runs one program under both artifacts on the session's current state. */
const runProgram = (
	session: PgConnection,
	program: PayrollProgram,
	values: Readonly<Record<string, string>>
) =>
	Effect.gen(function* () {
		const { optimized, conservative, checked } = program.template.programs
		const conservativeRun = yield* executeStatements(
			session,
			deliveredAsOptimized(conservative).roots,
			"conservative",
			fill(values)
		)
		const baseline = yield* delivered(
			checked.dag,
			conservativeRun,
			"conservative",
			ordered(checked.dag.roots[0]),
			program.codes
		)
		const forms: Array<{
			readonly form: string
			readonly roots: StatementRoots<OptimizedStatement>
		}> = [{ form: "optimized", roots: optimized.roots }]
		for (const v of largeFormPrograms(optimized.roots, (l) => l.statement)) {
			forms.push({ form: `optimized variant ${v.statement}`, roots: v.roots })
		}
		const runs: Array<ProgramOutcome["optimized"][number]> = []
		for (const f of forms) {
			const run = yield* executeStatements(session, f.roots, f.form, fill(values))
			const d = yield* delivered(
				optimized.query.dag,
				run,
				f.form,
				ordered(optimized.query.dag.roots[0]),
				program.codes
			)
			runs.push({
				form: f.form,
				run: d.run,
				comparison: compareRuns(baseline.run, d.run),
				order: orderProblems(baseline, d)
			})
		}
		return {
			name: program.name,
			params: values,
			conservative: baseline.run,
			optimized: runs
		} satisfies ProgramOutcome
	})

/**
 * Whether every optimized form agrees with the conservative run, repeats no row and keeps every order, and the
 * conservative run is a set.
 */
const programAgrees = (o: ProgramOutcome): boolean =>
	Arr.every(
		o.conservative.statements,
		(s) => new Set(Arr.map(s.rows, (r) => canonicalTextOf(r))).size === s.rows.length
	) && Arr.every(o.optimized, (r) => r.comparison.equal && r.order.length === 0)

const printProgramOutcome = (o: ProgramOutcome, program: PayrollProgram): string => {
	const lines = [`program ${o.name} with ${Formatter.format(o.params)}`]
	for (const r of o.optimized) {
		if (r.comparison.equal && r.order.length === 0) {
			continue
		}
		lines.push(printComparison(r.comparison, "conservative", r.form))
		for (const p of r.order) {
			lines.push(`  order: ${p}`)
		}
		lines.push(printRun(r.run))
	}
	lines.push(printRun(o.conservative))
	for (const [i, s] of flight(program.template.programs.optimized.roots).entries()) {
		lines.push(`optimized statement ${i}:\n${s.sql.text}`)
	}
	for (const [i, s] of flight(program.template.programs.conservative.roots).entries()) {
		lines.push(`conservative statement ${i}:\n${s.sql.text}`)
	}
	lines.push(
		`certificates: ${Arr.join(
			Arr.map(program.template.certificates, (c) => c.rule),
			", "
		)}`
	)
	return Arr.join(lines, "\n")
}

/** A printable state, each relation's facts as JSON lines with bigints marked. */
const printFacts = (facts: PayrollFacts): string =>
	Arr.join(
		Arr.map(
			Arr.filter(Rec.toEntries(facts), ([, rows]) => rows.length > 0),
			([relation, rows]) =>
				`${relation}:\n${Arr.join(
					Arr.map(rows, (r) => `  ${pipe(Formatter.format(r), Str.slice(0, 400))}`),
					"\n"
				)}`
		),
		"\n"
	)

/**
 * The payroll differential: every payroll program through the optimized artifact against the conservative lowering, on
 * generated lawful payroll facts.
 *
 * Reporting installs once, completely and empty, under a fresh schema name. Every exported query of the payroll
 * fixture (test/support/fixtures/api/payroll.ts: the workload queries, the ChangeSets' query members, RunTotal's
 * definition) is compiled by the real compiler (packages/engine/src/program compileQuery) against Reporting under the
 * installed name, which gives both of a template's artifacts: the conservative lowering, the oracle baseline that
 * deduplicates at every set boundary and rests on no certificate, and the optimized artifact, which rests on the
 * schema's laws as evidence. A case is a generated state (test/support/oracle/gen/payroll.ts) and one parameter binding
 * per program, run in one rolled-back transaction on one pinned owner session:
 *
 * 1. the facts load as typed literal INSERTs, every deferred law judges them at once (SET CONSTRAINTS ALL IMMEDIATE),
 *    so an unlawful state fails as such, RunTotal's view is refreshed, and the tables are analyzed;
 * 2. under the case's planner settings, each program's conservative statements run, then its optimized statements and
 *    each per-execution variant, an attachment's parent keys read from its parent statement's delivered rows;
 * 3. every optimized run equals the conservative run statement by statement as raw output-function text multisets,
 *    repeats no row, and keeps every ordered delivery's order; a fused attachment is unfused first.
 *
 * Runs every program on one case in one rolled-back transaction; fails with the printable case on a disagreement.
 *
 * Every deferred law judges the generated state now: the generator's laws are the schema's.
 */
export const runPayrollCase = (
	installed: Installed,
	programs: ReadonlyArray<PayrollProgram>,
	c: PayrollCase
): Effect.Effect<ReadonlyArray<ProgramOutcome>, PropertyFailed, Substrate> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const perturbation = yield* CurrentPerturbation
		const statements = factStatements(installed.plan, c.facts)
		if (!statements.ok) {
			return yield* fail(`the facts do not load: ${statements.error.message}`)
		}
		return yield* Effect.scoped(
			Effect.gen(function* () {
				const session = yield* substrate.admin.pin
				const exec = (sql: string, stage: string) =>
					session
						.query(sql, [])
						.pipe(
							Effect.catch((e) =>
								fail(
									`${stage}: ${sqlMessage(e)}\n${Str.slice(0, 2_000)(sql)}\n${printFacts(c.facts)}`
								)
							)
						)
				yield* exec("BEGIN", "setup")
				return yield* Effect.gen(function* () {
					yield* exec("SET LOCAL statement_timeout = '60s'", "setup")
					for (const sql of statements.value) {
						yield* exec(sql, "facts")
					}
					yield* exec("SET CONSTRAINTS ALL IMMEDIATE", "the generated state's laws")
					const views = yield* session
						.queryValues(
							"SELECT pg_catalog.format('%I.%I', schemaname, matviewname) FROM pg_catalog.pg_matviews WHERE schemaname = $1",
							[installed.schema]
						)
						.pipe(Effect.catch((e) => e.pipe(sqlMessage, fail)))
					for (const [view] of views) {
						yield* exec(`REFRESH MATERIALIZED VIEW ${String(view)}`, "refresh")
					}
					const tables = Arr.map(Rec.values(installed.plan.tables), (t) => printObjectName(t.name))
					yield* exec(`ANALYZE ${Arr.join(tables, ", ")}`, "analyze")
					for (const sql of plannerStatements(perturbation)) {
						yield* exec(sql, "perturbation")
					}
					const outcomes: Array<ProgramOutcome> = []
					for (const [i, program] of programs.entries()) {
						const sketch = c.params[i % Math.max(1, c.params.length)] ?? {
							pick: 0,
							absent: false
						}
						const values = bindings(program.template.params, c.facts, sketch)
						const outcome = yield* runProgram(session, program, values).pipe(
							Effect.catch((e) =>
								fail(
									`${program.name}: ${e.stage} failed on ${e.side}: ${e.message}\n${printFacts(c.facts)}`
								)
							)
						)
						if (!programAgrees(outcome)) {
							return yield* fail(`${printProgramOutcome(outcome, program)}\n${printFacts(c.facts)}`)
						}
						outcomes.push(outcome)
					}
					return outcomes
				}).pipe(Effect.ensuring(Effect.ignore(session.query("ROLLBACK", []))))
			})
		)
	})
