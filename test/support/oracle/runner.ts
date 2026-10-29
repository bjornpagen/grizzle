import {
	type Case,
	CaseDiscarded,
	type Draw,
	type Explored,
	explore,
	type Kept,
	type PropertyFalsified,
	type Run as SearchRun,
	type SearchFailure,
	type Steering,
	sketched
} from "@grizzle/testing/explore"
import type { Features } from "@grizzle/testing/features"
import { constant, type Gen } from "@grizzle/testing/gen"
import type { ShrinkBudget } from "@grizzle/testing/shrink"
import {
	Array as Arr,
	Cause,
	Data,
	type Duration,
	Effect,
	Option,
	Record as Rec,
	Result,
	Schema,
	type Scope
} from "effect"
import { BudgetMeter } from "#compiler/core/budget.ts"
import { canonicalTag } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { compileBudgets } from "#compiler/core/policy.ts"
import * as Engine from "#compiler/core/result.ts"
import { moneyMinorUnits } from "#compiler/ir/carriers.ts"
import { decimalPayload } from "#compiler/ir/decimal.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import {
	conservativeInput,
	type ConservativeParamSlot,
	type ConservativeProgram,
	type ConservativeStatement,
	flight,
	type PhysicalNames,
	statementOutput
} from "#compiler/lower/conservative/types.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { messageOf } from "#test/support/message.ts"
import {
	type Comparison,
	compareRuns,
	printComparison,
	printRun,
	type Run,
	type StatementRows,
	statementLabels
} from "#test/support/oracle/compare.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { typedLiteralDesc } from "#test/support/oracle/gen/domain.ts"
import { printQueryCase } from "#test/support/oracle/gen/print.ts"
import { genParamDecls } from "#test/support/oracle/gen/query.ts"
import { schemaDesc } from "#test/support/oracle/gen/schema.ts"
import { captureRows } from "#test/support/oracle/install/capture.ts"
import { moneyText } from "#test/support/oracle/install/literal.ts"
import { type FactSet, factStatements } from "#test/support/oracle/install/load.ts"
import type { InstallPlan } from "#test/support/oracle/install/model.ts"
import { oraclePlan, type RealInstallPlan } from "#test/support/oracle/install/real.ts"
import {
	CurrentPerturbation,
	isPerturbed,
	multiplyFacts,
	type Perturbation,
	perturbationGen,
	plannerPerturbationGen,
	plannerStatements,
	printPerturbation,
	unperturbed
} from "#test/support/oracle/perturb.ts"
import { elementAt } from "#test/support/oracle/pick.ts"
import {
	type ExpectedStatement,
	expectedStatements
} from "#test/support/oracle/reference/deliver.ts"
import { statingReference, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { renderExpected } from "#test/support/oracle/reference/render.ts"
import { ReferenceUnsupported } from "#test/support/oracle/reference/values.ts"
import { checkedStatements } from "#test/support/oracle/verify/index.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A hand-built case with the name its suite reports it by (runLabelledOracle). */
export interface LabelledCase extends QueryCase {
	readonly label: string
}

/** The name an outcome's report opens with: none for a generated case, a hand-built case's label otherwise. */
type CaseName =
	| { readonly kind: "unlabelled" }
	| { readonly kind: "labelled"; readonly label: string }

/** What a lowering lowers: a case, under the physical names of its installation. */
export interface LoweringInput {
	readonly case: QueryCase
	readonly names: PhysicalNames
}

/** A way to lower a case's query: the conservative lowering, an optimized one, or a mutant of the conservative. */
export interface Lowering {
	readonly name: string
	readonly lower: (input: LoweringInput) => Engine.Result<ConservativeProgram, CompileError>
}

/** The right side of a comparison: another Lowering, or the reference evaluator. */
interface ReferenceSide {
	readonly name: "reference"
	readonly reference: true
}

export type RunnerSide = Lowering | ReferenceSide

export const reference: ReferenceSide = { name: "reference", reference: true }

const isReference = (side: RunnerSide): side is ReferenceSide => "reference" in side

/**
 * The oracle baseline: deduplication at every set boundary, no certificate. Every statement it emits passes the
 * kernel's structural audit (oracle/verify checkedStatements).
 */
export const conservative: Lowering = {
	name: "conservative",
	lower: ({ case: c, names }) =>
		Engine.map(
			lowerConservative(conservativeInput(c.query), {
				names,
				params: genParamDecls(c.query),
				subject: { kind: "query" },
				meter: new BudgetMeter(compileBudgets)
			}),
			(program) => {
				checkedStatements(
					Arr.map(flight(program.roots), (s) => s.ast),
					"conservative statement"
				)
				return program
			}
		)
}

class OracleFailure extends Schema.TaggedError<OracleFailure, { readonly brand: unique symbol }>()(
	"OracleFailure",
	{
		stage: Schema.Literals(["plan", "lower", "execute", "reference"]),
		side: Schema.String,
		message: Schema.String
	}
) {}

/** A Lowering's run, with the program it produced. */
interface LoweredRun {
	readonly kind: "lowered"
	readonly run: Run
	readonly program: ConservativeProgram
}

/** A side's run: a Lowering's, or the reference's, which has no program. */
type SideRun = LoweredRun | { readonly kind: "reference"; readonly run: Run }

export class OracleOutcome extends Data.Class<{
	/** The case as generated; its facts ran repeated when the perturbation multiplies them. */
	readonly case: QueryCase
	/** Its name, which travels beside it. */
	readonly name: CaseName
	readonly perturbation: Perturbation
	/** The real installer's plan the case ran on. */
	readonly plan: RealInstallPlan
	readonly left: LoweredRun
	readonly right: SideRun
	readonly comparison: Comparison
}> {}

export interface RunOptions {
	/**
	 * The PostgreSQL schema the case installs under: a unique one the runner allocates for this case, or a named one.
	 * Every case is rolled back, so one name serves every case of a test.
	 */
	readonly schema: { readonly kind: "fresh" } | { readonly kind: "named"; readonly name: string }
}

/** A unique schema. */
export const defaultRunOptions: RunOptions = { schema: { kind: "fresh" } }

/** The harness's per-statement guard. */
const statementTimeout = "30s"

/** The case's facts as the loader's records: each row a field-to-value record of the relation's authored values. */
export const factSet = (c: QueryCase): FactSet => {
	const out: Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>> = {}
	for (const relation of c.schema.relations) {
		const rows = c.facts[relation.name] ?? []
		out[relation.name] = Arr.map(rows, (row) =>
			Rec.fromEntries(
				Arr.map(relation.columns, (col, i) => [
					col.name,
					typedLiteralDesc(elementAt(row, i, "a fact row"), col.type)
				])
			)
		)
	}
	return out
}

/**
 * A literal as the text its type's input function reads: what a placeholder or a recordset field carries.
 *
 * A double as its input function reads it: -0 keeps its sign, which String drops.
 *
 * The canonical text of the components, [c1,...,cn], which is pgvector's input form.
 */
export const inputText = (literal: TypedLiteral): string => {
	switch (literal.kind) {
		case "int":
			return literal.value.toString()
		case "numeric":
			return decimalPayload(literal.value)
		case "float":
			return Object.is(literal.value, -0) ? "-0" : String(literal.value)
		case "floatSpecial":
			return literal.value
		case "money":
			return moneyText(moneyMinorUnits(literal.value))
		case "bool":
			return literal.value ? "true" : "false"
		case "text":
		case "uuid":
			return literal.value
		case "enum":
			return literal.handle
		case "span":
			return `[${literal.start},${literal.end})`
		case "vector":
			return literal.value[canonicalTag]().payload
	}
}

const failure = (stage: OracleFailure["stage"], side: string, message: string) =>
	OracleFailure.make({ stage, side, message })

/** A failure of a statement as one line: PostgreSQL's SQLSTATE, message and DETAIL, or the error's own message. */
export const sqlMessage = (error: unknown): string => {
	const fields = pgErrorFields(error)
	if (fields !== undefined) {
		return `${fields.code}: ${fields.message}${Option.match(fields.detail, { onNone: () => "", onSome: (detail) => ` (${detail})` })}`
	}
	return messageOf(error)
}

/** The text of each placeholder of a statement. */
const paramValues = (
	c: QueryCase,
	statement: ConservativeStatement,
	side: string
): Result.Result<ReadonlyArray<string>, OracleFailure> => {
	const out: Array<string> = []
	for (const slot of statement.params) {
		const value = slotValue(c, slot)
		if (value === undefined) {
			return Result.fail(failure("execute", side, `no value for a ${slot.kind} placeholder`))
		}
		out.push(value)
	}
	return Result.succeed(out)
}

/**
 * What fills one placeholder: a scalar parameter's input text, or a relation parameter's jsonb recordset.
 *
 * A write's member slot or a page's placeholder: no query statement holds one, so the caller fails the case.
 */
export const slotValue = (c: QueryCase, slot: ConservativeParamSlot): string | undefined => {
	switch (slot.kind) {
		case "scalar": {
			const p = c.query.params[slot.param]
			return p?.kind === "scalar" ? inputText(p.value) : undefined
		}
		case "relation": {
			const p = c.query.params[slot.param]
			if (p?.kind !== "relation") {
				return undefined
			}
			const found = Option.all(
				Arr.map(slot.columns, (col) => Arr.findFirstIndex(p.heading, (h) => h.name === col.name))
			)
			if (Option.isNone(found)) {
				return undefined
			}
			const index = found.value
			return JSON.stringify(
				Arr.map(p.rows, (row) =>
					Rec.fromEntries(
						Arr.map(slot.columns, (col, k) => [
							col.definition.name,
							inputText(
								elementAt(
									row,
									elementAt(index, k, "the slot's column positions"),
									"a parameter row"
								)
							)
						])
					)
				)
			)
		}
		case "member":
		case "page":
			return undefined
	}
}

/** Runs every statement of a program in order on `session`. */
export const runProgram = (
	session: PgConnection,
	c: QueryCase,
	program: ConservativeProgram,
	name: string
): Effect.Effect<Run, OracleFailure> =>
	Effect.gen(function* () {
		const labels = statementLabels(program)
		const statements: Array<StatementRows> = []
		for (const [i, statement] of flight(program.roots).entries()) {
			const params = yield* Effect.fromResult(paramValues(c, statement, name))
			const heading = statementOutput(statement.role, statement.heading, []).heading
			const rows = yield* captureRows(session, statement.sql.text, params, {
				columns: heading.length
			}).pipe(
				Effect.mapError((e) =>
					failure(
						"execute",
						name,
						`statement ${labels[i]}: ${sqlMessage(e)}\n${statement.sql.text}`
					)
				)
			)
			statements.push({
				label: elementAt(labels, i, "the statement labels"),
				columns: Arr.map(heading, (h) => h.name),
				unstated: { kind: "none" },
				types: Arr.map(heading, (h) => h.type),
				rows
			})
		}
		return { name, statements }
	})

const lowerSide = (
	lowering: Lowering,
	c: QueryCase,
	names: PhysicalNames
): Effect.Effect<ConservativeProgram, OracleFailure> =>
	Effect.try({
		try: () => lowering.lower({ case: c, names }),
		catch: (e) => failure("lower", lowering.name, messageOf(e))
	}).pipe(
		Effect.flatMap((r) =>
			r.ok ? Effect.succeed(r.value) : Effect.fail(failure("lower", lowering.name, r.error.message))
		)
	)

/**
 * The statements the query's delivery defines and their rows, derived by the reference evaluator from the IR alone and
 * never from the program it is compared with, so a program that drops, adds or misnames a statement,
 * or types a column differently, is a structural difference of the comparison. A case the evaluator does not evaluate
 * is the ReferenceUnsupported it throws; over facts repeated `multiplier` times, so is one past the scaled reference's
 * rows (evaluate.ts ScaledReference).
 */
const referenceStatements = (
	c: QueryCase,
	multiplier: number
): Result.Result<ReadonlyArray<ExpectedStatement>, unknown> => {
	try {
		const ref = statingReference(
			c.query.dag,
			{ schema: c.schema, facts: c.facts, params: c.query.params, observer: unobserved },
			multiplier
		)
		return Result.succeed(expectedStatements(ref, c.query.dag.roots[0]))
	} catch (e) {
		return Result.fail(e)
	}
}

const referenceFailure = (e: unknown): OracleFailure =>
	failure("reference", reference.name, messageOf(e))

/** The reference's run: its statements' rows, spelled by PostgreSQL's output functions at the query's column types. */
const referenceRun = (
	session: PgConnection,
	expected: ReadonlyArray<ExpectedStatement>,
	plan: InstallPlan
): Effect.Effect<Run, OracleFailure> =>
	renderExpected(session, plan, expected).pipe(
		Effect.mapError((e) => failure("reference", reference.name, `rendering: ${sqlMessage(e)}`))
	)

/** Runs the body in one transaction on a pinned owner session and rolls it back. */
const inRolledBackTransaction = <A>(
	body: (session: PgConnection) => Effect.Effect<A, OracleFailure>,
	timeout: string
): Effect.Effect<A, OracleFailure, Substrate> =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const session = yield* substrate.admin.pin
			const begin = (sql: string) =>
				session
					.query(sql, [])
					.pipe(Effect.mapError((e) => failure("execute", "setup", sqlMessage(e))))
			yield* begin("BEGIN")
			return yield* Effect.gen(function* () {
				yield* begin(`SET LOCAL statement_timeout = '${timeout}'`)
				return yield* body(session)
			}).pipe(Effect.ensuring(Effect.ignore(session.query("ROLLBACK", []))))
		})
	)

/**
 * The differential runner.
 *
 * runOracle(case, left, right) runs one generated case on PostgreSQL 19 and compares two sides of it:
 *
 * 1. install the case's schema under the runner's schema name with the real installer, packages/engine/src/physical/install
 *    presented as the oracle's plan (install/real.ts, adopted after test/pg/physical's equivalence check of the two
 *    installers), and load the facts as typed literal INSERTs (install/load.ts);
 * 2. lower the query with the left Lowering and run every statement of its program in order, each placeholder filled
 *    from the case's parameter values, a relation parameter as one jsonb recordset, and an attachment's parent keys
 *    from the rows its parent statement delivered, capturing each statement's rows as raw
 *    output-function text (install/capture.ts);
 * 3. do the same with the right side: another Lowering, or the reference evaluator, which derives the statements the
 *    query's delivery defines from the IR alone (one per heading group and per attachment), computes their rows on the
 *    host by definition and spells them by PostgreSQL's output functions at the query's own column types (reference/);
 * 4. compare the two runs statement by statement as raw text multisets, and count the rows the right side repeats
 *    (compare.ts).
 *
 * Everything runs in one transaction on one pinned owner session and is rolled back, so a case leaves nothing behind
 * and the next case reuses the schema name. The transaction carries a statement_timeout as a test harness guard against a mutant
 * that does not terminate; it is the harness's, never a grizzle session's.
 *
 * oracleCheck explores a property over a suite's draw with the library's exploration (@grizzle/testing/explore), so a
 * failing case shrinks and is reported in its printable form (the suite's literal) with the comparison that failed. A
 * suite names itself to oracleCheck: its kept sketches replay first, then its floor stream, seeded from the suite's
 * label, and the run's rotating stream, every case under a plan perturbation drawn with it (perturb.ts), which
 * runOracle applies: the facts repeated under fresh keys, and a subset of planner settings set for the case's
 * statements. A kept sketch replays unperturbed.
 *
 * Runs one case and compares its two sides (left is the baseline; the reference may only be the right side).
 */
export const runOracle = (
	input: QueryCase,
	left: Lowering,
	right: RunnerSide,
	options: RunOptions
): Effect.Effect<OracleOutcome, OracleFailure | SqlError, Substrate> =>
	runNamed(input, { kind: "unlabelled" }, left, right, options)

/** runOracle of a hand-built case its suite names: the outcome's report opens with the case's label. */
export const runLabelledOracle = (
	input: LabelledCase,
	left: Lowering,
	right: RunnerSide,
	options: RunOptions
): Effect.Effect<OracleOutcome, OracleFailure | SqlError, Substrate> =>
	runNamed(input, { kind: "labelled", label: input.label }, left, right, options)

/** The perturbation's planner settings, for every statement of both sides. */
const runNamed = (
	input: QueryCase,
	name: CaseName,
	left: Lowering,
	right: RunnerSide,
	options: RunOptions
): Effect.Effect<OracleOutcome, OracleFailure | SqlError, Substrate> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		/**
		 * The case as it runs: its facts repeated under fresh keys when the case's perturbation multiplies them, for
		 * both sides alike.
		 */
		const perturbation = yield* CurrentPerturbation
		const multiplied: QueryCase = {
			...input,
			facts: multiplyFacts(input.schema, input.facts, perturbation.multiplier)
		}
		/**
		 * The reference's statements, computed on the host before any SQL. The evaluator sums a float aggregate only over
		 * as many values as it sums exactly, and completes only so many region rows over repeated facts, which repeated
		 * facts can pass: such a case runs with its facts as generated.
		 */
		const first = isReference(right)
			? referenceStatements(multiplied, perturbation.multiplier)
			: undefined
		const scaledPast =
			first !== undefined &&
			Result.isFailure(first) &&
			Schema.is(ReferenceUnsupported)(first.failure) &&
			perturbation.multiplier > 1
		const c: QueryCase = scaledPast ? input : multiplied
		const expected = scaledPast ? referenceStatements(input, 1) : first
		if (expected !== undefined && Result.isFailure(expected)) {
			return yield* referenceFailure(expected.failure)
		}
		const schema =
			options.schema.kind === "named"
				? options.schema.name
				: yield* Effect.scoped(substrate.schema({ create: false, label: "oracle" }))
		/**
		 * One full role writes every stored relation (oracleLogin), so the catalog is the one a deployment of the
		 * schema's whole world gets.
		 */
		const desc = schemaDesc(c.schema)
		const planned = oraclePlan(
			desc,
			identity.schema(parsedSchemaName(schema)),
			substrate.owner.role
		)
		if (!planned.ok) {
			return yield* failure("plan", "install", planned.error.message)
		}
		const plan = planned.value
		const facts = factStatements(plan, factSet(c))
		if (!facts.ok) {
			return yield* failure("plan", "facts", facts.error.message)
		}
		/** The lowerings emit the installation's own physical names, structural text domains included. */
		const names = plan.installation.names
		const leftProgram = yield* lowerSide(left, c, names)
		const rightProgram = isReference(right) ? undefined : yield* lowerSide(right, c, names)
		return yield* inRolledBackTransaction(
			(session) =>
				Effect.gen(function* () {
					const exec = (sql: string, stage: string) =>
						session
							.query(sql, [])
							.pipe(Effect.mapError((e) => failure("execute", stage, `${sqlMessage(e)}\n${sql}`)))
					for (const sql of plan.sql) {
						yield* exec(sql, "install")
					}
					for (const sql of facts.value) {
						yield* exec(sql, "facts")
					}
					/**
					 * Tables created and filled in this transaction have no statistics, so the planner assumes some
					 * thousand rows each and a few cross-joined scans estimate billions; the executor sizes its startup
					 * of a recursive union or hash aggregate by that estimate, even for EXPLAIN and a handful of actual
					 * rows. ANALYZE sees this transaction's own rows and is rolled back with it; results are unchanged.
					 */
					const tables = Arr.map(Rec.values(plan.tables), (t) => printObjectName(t.name))
					if (tables.length > 0) {
						yield* exec(`ANALYZE ${Arr.join(tables, ", ")}`, "facts")
					}
					for (const sql of plannerStatements(perturbation)) {
						yield* exec(sql, "perturbation")
					}
					const leftRun = yield* runProgram(session, c, leftProgram, left.name)
					const rightRun =
						rightProgram !== undefined
							? yield* runProgram(session, c, rightProgram, right.name)
							: yield* referenceRun(session, expected?.success ?? [], plan)
					return new OracleOutcome({
						case: input,
						name,
						perturbation: scaledPast ? { ...perturbation, multiplier: 1 } : perturbation,
						plan,
						left: { kind: "lowered", run: leftRun, program: leftProgram },
						right:
							rightProgram === undefined
								? { kind: "reference", run: rightRun }
								: { kind: "lowered", run: rightRun, program: rightProgram },
						comparison: compareRuns(leftRun, rightRun)
					})
				}),
			statementTimeout
		)
	})

/** The printable form of a case: the generator's. */
export const printOracleCase = (c: QueryCase): string => printQueryCase(c)

/**
 * The printable report of an outcome: the case's label where it has one, the case, the comparison, both runs and the
 * right program's SQL.
 */
export const printOutcome = (o: OracleOutcome): string =>
	Arr.join(
		[
			...(o.name.kind === "labelled" ? [`case ${o.name.label}`] : []),
			printOracleCase(o.case),
			printComparison(o.comparison, o.left.run.name, o.right.run.name),
			printRun(o.left.run),
			printRun(o.right.run),
			...(o.right.kind === "lowered"
				? Arr.map(
						flight(o.right.program.roots),
						(s, i) => `${o.right.run.name} statement ${i}:\n${s.sql.text}`
					)
				: [])
		],
		"\n"
	)

/**
 * A property's verdict on one case: it holds, or it fails with the report of why (ComparisonFailed when an oracle
 * comparison failed).
 */
export class PropertyFailed extends Schema.TaggedError<
	PropertyFailed,
	{ readonly brand: unique symbol }
>()("PropertyFailed", { report: Schema.String }) {
	override get message(): string {
		return this.report
	}
}

/** The failure of an oracle comparison, with the outcome that failed. */
class ComparisonFailed extends Schema.TaggedError<
	ComparisonFailed,
	{ readonly brand: unique symbol }
>()("ComparisonFailed", { report: Schema.String, outcome: Schema.instanceOf(OracleOutcome) }) {
	override get message(): string {
		return this.report
	}
}

/** The failure of a comparison: its printable report and the outcome itself. */
export const comparisonFailed = (outcome: OracleOutcome): ComparisonFailed =>
	ComparisonFailed.make({ report: printOutcome(outcome), outcome })

/**
 * What one exploration of oracleCheck is: the library's exploration minus its draw (oracleCheck's first argument), its
 * concurrency and its steering cadence, plus the plan perturbation each case draws. Oracle cases share their
 * substrate's database and schema, so they run one at a time.
 */
export interface CheckOptions<S, F extends string> {
	readonly suite: string
	readonly literal: (sketch: S) => string
	readonly features: Features<F>
	readonly kept: ReadonlyArray<Kept<S, F>>
	readonly runs: number
	readonly shrink: ShrinkBudget
	readonly steering: Steering
	readonly caseHang: Duration.Input
	/** The plan perturbation each case draws: the facts repeated and planner settings, the settings alone, or none. */
	readonly perturb: "all" | "planner" | "none"
}

/**
 * The property of one case under its perturbation, failing with the report of why, the perturbation appended. A case
 * that gives itself up, or is interrupted, ends as it did.
 */
const underPerturbation = <E, R>(
	property: Effect.Effect<void, E, R>,
	perturbation: Perturbation
): Effect.Effect<void, PropertyFailed | ComparisonFailed | CaseDiscarded, R> =>
	Effect.provideService(property, CurrentPerturbation, perturbation).pipe(
		Effect.catchCause(
			(cause): Effect.Effect<never, PropertyFailed | ComparisonFailed | CaseDiscarded> => {
				if (Cause.hasInterruptsOnly(cause)) {
					return Effect.interrupt
				}
				const error = Cause.squash(cause)
				if (Schema.is(CaseDiscarded)(error)) {
					return Effect.fail(error)
				}
				const failed =
					Schema.is(PropertyFailed)(error) || Schema.is(ComparisonFailed)(error)
						? error
						: PropertyFailed.make({ report: reportOf(cause) })
				if (!isPerturbed(perturbation)) {
					return Effect.fail(failed)
				}
				const report = Arr.join([failed.report, printPerturbation(perturbation)], "\n")
				return Effect.fail(
					Schema.is(ComparisonFailed)(failed)
						? ComparisonFailed.make({ report, outcome: failed.outcome })
						: PropertyFailed.make({ report })
				)
			}
		)
	)

/** The perturbations a case of a check draws. */
const perturbations = (perturb: CheckOptions<unknown, string>["perturb"]): Gen<Perturbation> => {
	switch (perturb) {
		case "all":
			return perturbationGen
		case "planner":
			return plannerPerturbationGen
		case "none":
			return constant(unperturbed)
	}
}

/**
 * The exploration of a check: the suite's draw with each case's perturbation drawn after its sketch, so the two shrink
 * together; a kept sketch replays unperturbed, and a sketch prints as the suite prints it, ready to keep.
 */
const checked = <S, T, F extends string, E, R>(
	draw: Draw<S, T>,
	options: CheckOptions<S, F>,
	property: (value: T, c: Case<F>) => Effect.Effect<void, E, R>
): Effect.Effect<Explored, SearchFailure, SearchRun | Exclude<R, Scope.Scope>> =>
	explore(
		{
			suite: options.suite,
			draw: sketched(
				(source): readonly [S, Perturbation] => [
					source.draw(draw.generator),
					source.draw(perturbations(options.perturb))
				],
				([sketch, perturbation]): readonly [T, Perturbation] => [draw.resolve(sketch), perturbation]
			),
			literal: ([sketch]) => options.literal(sketch),
			features: options.features,
			kept: Arr.map(options.kept, (k): Kept<readonly [S, Perturbation], F> => ({
				...k,
				sketch: [k.sketch, unperturbed]
			})),
			runs: options.runs,
			shrink: options.shrink,
			concurrency: 1,
			steerEvery: 16,
			steering: options.steering,
			caseHang: options.caseHang
		},
		([value, perturbation], c) => underPerturbation(property(value, c), perturbation)
	)

/**
 * Explores `property` over the suite's draw with the library's exploration, each case under a plan perturbation drawn
 * with it. A case fails when the property fails or dies; the exploration then shrinks it and fails with the shrunk
 * case's report, its perturbation appended. Plain suites pass `drawn(gen)`; a suite with kept sketches passes
 * `sketched(gen, resolve)` and its kept sketches, which replay unperturbed.
 */
export const oracleCheck = <S, T, F extends string, E, R>(
	draw: Draw<S, T>,
	options: CheckOptions<S, F>,
	property: (value: T, c: Case<F>) => Effect.Effect<void, E, R>
): Effect.Effect<Explored, SearchFailure, SearchRun | Exclude<R, Scope.Scope>> =>
	checked(draw, options, property)

/**
 * What a kill search ends with: every case passed, so the population survived; or a case failed, with the library's
 * report (the shrunk case and how to replay it) and the last case whose property failed, with its outcome when an
 * oracle comparison failed. Shrinking runs failing cases until the shrunk one, so the last failing case is the shrunk
 * case unless a later candidate failed without drawing fewer decisions.
 */
export type KillResult<T> =
	| { readonly kind: "survived"; readonly explored: Explored }
	| {
			readonly kind: "killed"
			readonly report: string
			readonly counterexample: T
			readonly outcome: OracleOutcome
	  }
	| {
			readonly kind: "failed"
			readonly report: string
			readonly counterexample: Option.Option<T>
	  }

/** The last case a kill search's property failed on, and the outcome when an oracle comparison failed. */
type LastFailure<T> = { readonly value: T; readonly outcome: Option.Option<OracleOutcome> }

/**
 * oracleCheck for a population that must be killed (a mutant's): a failing case is the result rather than the search's
 * failure, so the suite can judge the kill's outcome. Every other way the search fails (a hang, a stall, an unreached
 * feature, a stale kept case) fails it still.
 */
export const oracleKill = <S, T, F extends string, E, R>(
	draw: Draw<S, T>,
	options: CheckOptions<S, F>,
	property: (value: T, c: Case<F>) => Effect.Effect<void, E, R>
): Effect.Effect<
	KillResult<T>,
	Exclude<SearchFailure, PropertyFalsified>,
	SearchRun | Exclude<R, Scope.Scope>
> =>
	Effect.suspend(() => {
		let last: Option.Option<LastFailure<T>> = Option.none()
		return checked(draw, options, (value, c) =>
			property(value, c).pipe(
				Effect.tapCause((cause) =>
					Effect.sync(() => {
						const error = Cause.squash(cause)
						if (!Cause.hasInterruptsOnly(cause) && !Schema.is(CaseDiscarded)(error)) {
							last = Option.some({
								value,
								outcome: Schema.is(ComparisonFailed)(error)
									? Option.some(error.outcome)
									: Option.none()
							})
						}
					})
				)
			)
		).pipe(
			Effect.map((explored): KillResult<T> => ({ kind: "survived", explored })),
			Effect.catchTag("PropertyFalsified", (falsified) =>
				Effect.succeed(
					Option.match(
						Option.flatMap(last, (failure) =>
							Option.map(failure.outcome, (outcome) => ({ value: failure.value, outcome }))
						),
						{
							onNone: (): KillResult<T> => ({
								kind: "failed",
								report: falsified.message,
								counterexample: Option.map(last, (failure) => failure.value)
							}),
							onSome: ({ value, outcome }): KillResult<T> => ({
								kind: "killed",
								report: falsified.message,
								counterexample: value,
								outcome
							})
						}
					)
				)
			)
		)
	})

/** The report of a failed property: its own report, an oracle failure's stage and message, or the cause. */
const reportOf = (cause: Cause.Cause<unknown>): string => {
	const error = Cause.squash(cause)
	if (Schema.is(PropertyFailed)(error) || Schema.is(ComparisonFailed)(error)) {
		return error.report
	}
	if (Schema.is(OracleFailure)(error)) {
		return `${error.stage} failed on ${error.side}: ${error.message}`
	}
	return Cause.pretty(cause)
}
