import {
	type Case,
	type CaseDiscarded,
	type Draw,
	type Explored,
	explore,
	isCaseDiscarded,
	isWitness,
	type Kept,
	type PropertyFalsified,
	type Run as SearchRun,
	type SearchFailure,
	sketched
} from "@grizzle/testing/explore"
import type { Coverage } from "@grizzle/testing/features"
import { constant, type Gen } from "@grizzle/testing/gen"
import type { ShrinkBudget } from "@grizzle/testing/shrink"
import {
	Array as Arr,
	Cause,
	Data,
	Effect,
	Option,
	pipe,
	Record as Rec,
	Result,
	type Scope,
	String as Str
} from "effect"
import { resultTextCasts } from "#compiler/codec/scalar.ts"
import { canonicalTag } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import * as Engine from "#compiler/core/result.ts"
import { moneyMinorUnits } from "#compiler/ir/carriers.ts"
import { type Codebook, codecOf, codeOf, type RosterCodec } from "#compiler/ir/codes.ts"
import { decimalPayload } from "#compiler/ir/decimal.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { rosterOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import {
	conservativeInput,
	type ConservativeParamSlot,
	type ConservativeProgram,
	type ConservativeStatement,
	flight,
	statementOutput
} from "#compiler/lower/conservative/types.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { hexOfText, setText } from "#test/support/closed/bit-text.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
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
import { type SpelledValue, typedLiteralDesc } from "#test/support/oracle/gen/domain.ts"
import type { StoredRow } from "#test/support/oracle/gen/facts.ts"
import { printQueryCase } from "#test/support/oracle/gen/print.ts"
import { genParamDecls } from "#test/support/oracle/gen/query.ts"
import {
	CurrentRestorage,
	onceRotated,
	permuted,
	type Restorage,
	restorageGen,
	restoredFacts,
	spelledRespelling,
	type StoredRelation
} from "#test/support/oracle/gen/restorage.ts"
import { schemaCodes, schemaDesc } from "#test/support/oracle/gen/schema.ts"
import { captureRows } from "#test/support/oracle/install/capture.ts"
import { InputSpelling, moneyText } from "#test/support/oracle/install/literal.ts"
import { type FactSet, factStatements } from "#test/support/oracle/install/load.ts"
import type { InstallPlan } from "#test/support/oracle/install/model.ts"
import {
	oracleLogin,
	planRealInstall,
	type RealInstallPlan
} from "#test/support/oracle/install/real.ts"
import {
	complementOf,
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
import { type DeclineReason, ReferenceUnsupported } from "#test/support/oracle/reference/values.ts"
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
				subject: { kind: "query" }
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

/** A failure of the harness to run a case: planning, lowering, executing or rendering the reference. */
class OracleFailure extends Data.TaggedError("OracleFailure")<{
	readonly stage: "plan" | "lower" | "execute" | "reference"
	readonly side: string
	readonly message: string
}> {}

/** Which side of a comparison a lowered run is: the baseline, or the side judged against it. */
type SideRole = "left" | "right"

/**
 * A side's two readings of a case (runOracle step 5): the case as generated, the run over its facts, the run over its
 * facts stored otherwise under the complement plan, their comparison (the first reading on the left), and how the second
 * reading was stored.
 */
class Readings extends Data.Class<{
	readonly case: QueryCase
	readonly first: Run
	readonly again: Run
	readonly comparison: Comparison
	readonly reading: SecondReading
}> {}

/**
 * A verdict on a side, never a failure of the harness: its second reading (runOracle step 5) delivered otherwise than
 * its first, so its answer depends on something other than the facts.
 */
class InvarianceFailed extends Data.TaggedError("InvarianceFailed")<{
	readonly role: SideRole
	readonly side: string
	readonly report: string
	readonly readings: Readings
}> {
	override get message(): string {
		return this.report
	}
}

/** A Lowering's run, with the program it produced. */
interface LoweredRun {
	readonly kind: "lowered"
	readonly run: Run
	readonly program: ConservativeProgram
}

/**
 * A side's run: a Lowering's, or the reference's, which has no program and names every term it declined to state
 * (reference/values.ts DeclineReason), so a suite notes how often and why its reference gave up instead of judging.
 */
type SideRun =
	| LoweredRun
	| {
			readonly kind: "reference"
			readonly run: Run
			readonly declines: ReadonlyArray<DeclineReason>
	  }

/** The reference's statements of a case, and every decline its evaluation met, by reason. */
interface Stated {
	readonly statements: ReadonlyArray<ExpectedStatement>
	readonly declines: ReadonlyArray<DeclineReason>
}

/**
 * How a case was read a second time, against itself: its facts stored otherwise (gen/restorage.ts), whether that moved
 * some relation's order and a value's spelling, and the plan the second reading ran under (perturb.ts complementOf).
 */
export interface SecondReading {
	readonly reordered: boolean
	readonly respelled: boolean
	readonly plan: Perturbation
}

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
	/** The second reading every lowered side delivered exactly what it delivered the first time. */
	readonly again: SecondReading
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

/** A stored value as the loader takes it: its authored value, or its twin spelling (install/literal.ts InputSpelling). */
export const storedInput = (stored: SpelledValue, type: ScalarType): unknown => {
	switch (stored.spelling.kind) {
		case "canonical":
			return typedLiteralDesc(stored.literal, type)
		case "twin":
			return new InputSpelling(stored.spelling.text)
	}
}

/** A case with its facts stored otherwise, and what its restorage changed: some relation's order, a value's spelling. */
interface RestoredCase {
	readonly case: QueryCase
	readonly reordered: boolean
	readonly respelled: boolean
}

/** A case's stored facts of `name`; a relation without its facts is a defect of the case. */
const factsOf = (c: QueryCase, name: string): ReadonlyArray<StoredRow> => {
	const rows = c.facts[name]
	if (rows === undefined) {
		throw new Error(`a case with no facts of its relation ${name}`)
	}
	return rows
}

/** The case with its facts stored otherwise (gen/restorage.ts restoredFacts), each in another order. */
const restoredCase = (c: QueryCase, r: Restorage): RestoredCase => {
	const restored = restoredFacts(
		Arr.map(c.schema.relations, (relation): StoredRelation<SpelledValue> => ({
			name: relation.name,
			columns: Arr.map(relation.columns, (col) => spelledRespelling(col.type)),
			rows: factsOf(c, relation.name)
		})),
		permuted,
		r
	)
	const facts = Rec.fromEntries(
		Arr.map(restored.relations, (relation): readonly [string, ReadonlyArray<StoredRow>] => [
			relation.name,
			relation.rows
		])
	)
	return { case: { ...c, facts }, reordered: restored.reordered, respelled: restored.respelled }
}

/** What an explored case runs under beside its sketch: its plan perturbation, and its second reading's restorage. */
interface Conditions {
	readonly perturbation: Perturbation
	readonly restorage: Restorage
}

/**
 * The case's facts as the loader's records: each row a field-to-value record of the relation's authored values, each
 * in the spelling the case drew for it.
 */
export const factSet = (c: QueryCase): FactSet => {
	const out: Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>> = {}
	for (const relation of c.schema.relations) {
		const rows = c.facts[relation.name] ?? []
		out[relation.name] = Arr.map(rows, (row) =>
			Rec.fromEntries(
				Arr.map(relation.columns, (col, i) => [
					col.name,
					storedInput(elementAt(row, i, "a fact row"), col.type)
				])
			)
		)
	}
	return out
}

/** The codec of a closed id's or a set's roster; a literal of either names handles of its type's roster. */
const rosterCodecOf = (type: ScalarType, codes: Codebook): RosterCodec => {
	const roster = rosterOf(type)
	if (roster === undefined) {
		throw new Error(`a handle literal of ${type.carrier}, a type of no roster`)
	}
	return codecOf(codes, roster)
}

/**
 * A literal of `type` as the text its type's input function reads: what a placeholder or an input array's element
 * carries.
 *
 * A double as its shortest round-trip text; a literal holds the one zero.
 *
 * A closed id as its handle's code under the installation's codes, smallint's text, and a set as X and the hex digits
 * of its bits domain's text, position c code c, every hole and padding bit 0.
 *
 * The canonical text of the components, [c1,...,cn], which is pgvector's input form.
 */
export const inputText = (literal: TypedLiteral, type: ScalarType, codes: Codebook): string => {
	switch (literal.kind) {
		case "int":
			return literal.value.toString()
		case "numeric":
			return decimalPayload(literal.value)
		case "float":
			return String(literal.value)
		case "floatSpecial":
			return literal.value
		case "money":
			return moneyText(moneyMinorUnits(literal.value))
		case "bool":
			return literal.value ? "true" : "false"
		case "text":
		case "uuid":
		case "date":
			return literal.value
		case "handle":
			return String(codeOf(rosterCodecOf(type, codes), literal.handle))
		case "handles": {
			const codec = rosterCodecOf(type, codes)
			return `X${hexOfText(
				setText(
					codec.size,
					Arr.map(literal.handles, (handle) => codeOf(codec, handle))
				)
			)}`
		}
		case "span":
			return `[${literal.start},${literal.end})`
		case "vector":
			return literal.value[canonicalTag]().payload
	}
}

const failure = (stage: OracleFailure["stage"], side: string, message: string) =>
	new OracleFailure({ stage, side, message })

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
 * What fills one placeholder: a scalar parameter's input text, or one array of a relation parameter: its column's
 * array literal, `{"t1","t2",...}` of the case's rows as given, repeats kept, which the conservative baseline
 * deduplicates itself, or, for an input of no column, its count of rows. The literal is the oracle's own, each element
 * quoted with its backslashes and quotes escaped (array_in's quoting, test/support/arrays.ts).
 *
 * A write's member slot or a page's placeholder: no query statement holds one, so the caller fails the case.
 */
export const slotValue = (c: QueryCase, slot: ConservativeParamSlot): string | undefined => {
	switch (slot.kind) {
		case "scalar": {
			const p = c.query.params[slot.param]
			return p?.kind === "scalar" ? inputText(p.value, p.type, schemaCodes(c.schema)) : undefined
		}
		case "relation": {
			const p = c.query.params[slot.param]
			if (p?.kind !== "relation") {
				return undefined
			}
			const part = slot.part
			if (part.kind === "count") {
				return String(p.rows.length)
			}
			const column = slot.columns[part.index]
			const at =
				column === undefined
					? Option.none()
					: Arr.findFirstIndex(p.heading, (h) => h.name === column.name)
			if (Option.isNone(at)) {
				return undefined
			}
			const type = elementAt(p.heading, at.value, "a parameter column").type
			const codes = schemaCodes(c.schema)
			const elements = Arr.map(p.rows, (row) => {
				const text = inputText(elementAt(row, at.value, "a parameter row"), type, codes)
				return `"${pipe(text, Str.replaceAll("\\", "\\\\"), Str.replaceAll('"', '\\"'))}"`
			})
			return `{${Arr.join(elements, ",")}}`
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
			const rows = yield* captureRows(
				session,
				statement.sql.text,
				params,
				Arr.map(heading, (h) => resultTextCasts(h.type))
			).pipe(
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
				codes: schemaCodes(c.schema),
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
const referenceStatements = (c: QueryCase, multiplier: number): Result.Result<Stated, unknown> => {
	const declines: Array<DeclineReason> = []
	try {
		const ref = statingReference(
			c.query.dag,
			{
				schema: c.schema,
				facts: c.facts,
				params: c.query.params,
				observer: {
					...unobserved,
					decline: (reason) => {
						declines.push(reason)
					}
				}
			},
			multiplier
		)
		return Result.succeed({ statements: expectedStatements(ref, c.query.dag.roots[0]), declines })
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

/**
 * Runs the body in one transaction on a pinned owner session and rolls it back. No statement of it has a deadline: a
 * statement that never ends is a hang, which the case's hang guard (caseHang) reports, cancelling the statement it
 * interrupts (pg.ts), and no verdict rests on how long a statement took.
 */
const inRolledBackTransaction = <A, E>(
	body: (session: PgConnection) => Effect.Effect<A, E>
): Effect.Effect<A, E | OracleFailure, Substrate> =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const session = yield* substrate.admin.pin
			const begin = (sql: string) =>
				session
					.query(sql, [])
					.pipe(Effect.mapError((e) => failure("execute", "setup", sqlMessage(e))))
			yield* begin("BEGIN")
			return yield* body(session).pipe(
				Effect.ensuring(Effect.ignore(session.query("ROLLBACK", [])))
			)
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
 *    from the case's parameter values, a relation parameter as its arrays, and an attachment's parent keys
 *    from the rows its parent statement delivered, capturing each statement's rows as raw
 *    output-function text (install/capture.ts);
 * 3. do the same with the right side: another Lowering, or the reference evaluator, which derives the statements the
 *    query's delivery defines from the IR alone (one per heading group and per attachment), computes their rows on the
 *    host by definition and spells them by PostgreSQL's output functions at the query's own column types (reference/);
 * 4. compare the two runs statement by statement as raw text sets, and count the rows the right side repeats
 *    (compare.ts);
 * 5. read the case a second time against itself, with no reference in the judgment: the first reading's facts and
 *    settings rolled back to a savepoint, the facts stored otherwise through a fresh load (CurrentRestorage: another
 *    storage order, one value in its next twin spelling), and every lowered side run again under the complement of the
 *    first plan's settings (perturb.ts complementOf). An answer is a function of the facts, so where the two sides
 *    agree, a side whose second reading differs from its first fails the case with the verdict InvarianceFailed, never a
 *    harness failure.
 *
 * Everything runs in one transaction on one pinned owner session and is rolled back, so a case leaves nothing behind
 * and the next case reuses the schema name. No statement has a deadline: a mutant whose statement does not terminate is a
 * hang, which the case's hang guard reports, and the mutation tester's own timeout counts.
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
): Effect.Effect<OracleOutcome, OracleFailure | InvarianceFailed | SqlError, Substrate> =>
	runNamed(input, { kind: "unlabelled" }, left, right, options)

/** runOracle of a hand-built case its suite names: the outcome's report opens with the case's label. */
export const runLabelledOracle = (
	input: LabelledCase,
	left: Lowering,
	right: RunnerSide,
	options: RunOptions
): Effect.Effect<OracleOutcome, OracleFailure | InvarianceFailed | SqlError, Substrate> =>
	runNamed(input, { kind: "labelled", label: input.label }, left, right, options)

/** The perturbation's planner settings, for every statement of both sides. */
const runNamed = (
	input: QueryCase,
	name: CaseName,
	left: Lowering,
	right: RunnerSide,
	options: RunOptions
): Effect.Effect<OracleOutcome, OracleFailure | InvarianceFailed | SqlError, Substrate> =>
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
		 * The reference's statements, computed on the host before any SQL. The evaluator completes only so many region
		 * rows, which repeated facts can pass: such a case runs with its facts as generated.
		 */
		const first = isReference(right)
			? referenceStatements(multiplied, perturbation.multiplier)
			: undefined
		const scaledPast =
			first !== undefined &&
			Result.isFailure(first) &&
			first.failure instanceof ReferenceUnsupported &&
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
		const planned = planRealInstall(desc, {
			installation: identity.schema(parsedSchemaName(schema)),
			owner: substrate.owner.role,
			logins: [oracleLogin(desc)],
			extensions: [],
			codes: schemaCodes(c.schema)
		})
		if (!planned.ok) {
			return yield* failure("plan", "install", planned.error.message)
		}
		const plan = planned.value
		const facts = factStatements(plan, factSet(c))
		if (!facts.ok) {
			return yield* failure("plan", "facts", facts.error.message)
		}
		const restorage = yield* CurrentRestorage
		const restoration = restoredCase(c, restorage)
		const restoredStatements = factStatements(plan, factSet(restoration.case))
		if (!restoredStatements.ok) {
			return yield* failure("plan", "facts stored otherwise", restoredStatements.error.message)
		}
		const secondPlan = complementOf(perturbation)
		/** The lowerings emit the installation's own physical names, structural text domains included. */
		const names = plan.installation.names
		const leftProgram = yield* lowerSide(left, c, names)
		const rightProgram = isReference(right) ? undefined : yield* lowerSide(right, c, names)
		return yield* inRolledBackTransaction((session) =>
			Effect.gen(function* () {
				const exec = (sql: string, stage: string) =>
					session
						.query(sql, [])
						.pipe(Effect.mapError((e) => failure("execute", stage, `${sqlMessage(e)}\n${sql}`)))
				for (const sql of plan.sql) {
					yield* exec(sql, "install")
				}
				/**
				 * Tables created and filled in this transaction have no statistics, so the planner assumes some
				 * thousand rows each and a few cross-joined scans estimate billions; the executor sizes its startup
				 * of a recursive union or hash aggregate by that estimate, even for EXPLAIN and a handful of actual
				 * rows. ANALYZE sees this transaction's own rows and is rolled back with it; results are unchanged.
				 */
				const tables = Arr.map(Rec.values(plan.tables), (t) => printObjectName(t.name))
				/** Stores `statements`, analyzes the tables and sets `under`'s planner settings. */
				const stored = (
					statements: ReadonlyArray<string>,
					under: Perturbation,
					stage: string
				): Effect.Effect<void, OracleFailure> =>
					Effect.gen(function* () {
						for (const sql of statements) {
							yield* exec(sql, stage)
						}
						if (tables.length > 0) {
							yield* exec(`ANALYZE ${Arr.join(tables, ", ")}`, stage)
						}
						for (const sql of plannerStatements(under)) {
							yield* exec(sql, stage)
						}
					})
				yield* exec("SAVEPOINT stored", "facts")
				yield* stored(facts.value, perturbation, "facts")
				const leftRun = yield* runProgram(session, c, leftProgram, left.name)
				const rightRun =
					rightProgram !== undefined
						? yield* runProgram(session, c, rightProgram, right.name)
						: yield* referenceRun(session, expected?.success.statements ?? [], plan)
				const comparison = compareRuns(leftRun, rightRun)
				yield* exec("ROLLBACK TO SAVEPOINT stored", "facts stored otherwise")
				yield* stored(restoredStatements.value, secondPlan, "facts stored otherwise")
				const lowered: ReadonlyArray<{
					readonly role: SideRole
					readonly name: string
					readonly program: ConservativeProgram
					readonly first: Run
				}> = [
					{ role: "left", name: left.name, program: leftProgram, first: leftRun },
					...(rightProgram === undefined
						? []
						: [
								{
									role: "right" as const,
									name: right.name,
									program: rightProgram,
									first: rightRun
								}
							])
				]
				const second: SecondReading = {
					reordered: restoration.reordered,
					respelled: restoration.respelled,
					plan: secondPlan
				}
				const order = second.reordered ? "reordered" : "in their order"
				const spelling = second.respelled ? "one value respelled" : "no value respelled"
				for (const side of lowered) {
					const again = yield* runProgram(session, restoration.case, side.program, side.name)
					const itself = compareRuns(side.first, again)
					if (comparison.equal && !itself.equal) {
						return yield* new InvarianceFailed({
							role: side.role,
							side: side.name,
							readings: new Readings({
								case: input,
								first: side.first,
								again,
								comparison: itself,
								reading: second
							}),
							report: Arr.join(
								[
									`${side.name}: the facts stored otherwise (${order}, ${spelling}) under another plan deliver otherwise`,
									printOracleCase(input),
									printPerturbation(secondPlan),
									printComparison(itself, "the first reading", "the second reading"),
									printRun(side.first),
									printRun(again)
								],
								"\n"
							)
						})
					}
				}
				return new OracleOutcome({
					case: input,
					name,
					perturbation: scaledPast ? { ...perturbation, multiplier: 1 } : perturbation,
					plan,
					left: { kind: "lowered", run: leftRun, program: leftProgram },
					right:
						rightProgram === undefined
							? { kind: "reference", run: rightRun, declines: expected?.success.declines ?? [] }
							: { kind: "lowered", run: rightRun, program: rightProgram },
					comparison,
					again: second
				})
			})
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
export class PropertyFailed extends Data.TaggedError("PropertyFailed")<{
	readonly report: string
}> {
	override get message(): string {
		return this.report
	}
}

/** The failure of an oracle comparison, with the outcome that failed. */
class ComparisonFailed extends Data.TaggedError("ComparisonFailed")<{
	readonly report: string
	readonly outcome: OracleOutcome
}> {
	override get message(): string {
		return this.report
	}
}

/** The failure of a comparison: its printable report and the outcome itself. */
export const comparisonFailed = (outcome: OracleOutcome): ComparisonFailed =>
	new ComparisonFailed({ report: printOutcome(outcome), outcome })

/**
 * What one exploration of oracleCheck is: the library's exploration minus its draw (oracleCheck's first argument), its
 * concurrency, its steering cadence and its hang guard (the tiers' caseHang), plus the plan perturbation each case
 * draws. Oracle cases share their substrate's database and schema, so they run one at a time.
 */
export interface CheckOptions<S, F extends string> {
	readonly suite: string
	readonly literal: (sketch: S) => string
	readonly coverage: Coverage<F>
	readonly kept: ReadonlyArray<Kept<S, F>>
	readonly runs: number
	readonly shrink: ShrinkBudget
	/** The plan perturbation each case draws: the facts repeated and planner settings, the settings alone, or none. */
	readonly perturb: "all" | "planner" | "none"
}

/**
 * The property of one case under its perturbation, failing with the report of why, the perturbation appended. A case
 * that gives itself up, or is interrupted, ends as it did.
 */
const underPerturbation = <E, R>(
	property: Effect.Effect<void, E, R>,
	conditions: Conditions
): Effect.Effect<void, PropertyFailed | ComparisonFailed | CaseDiscarded, R> => {
	const perturbation = conditions.perturbation
	return Effect.provideService(property, CurrentPerturbation, perturbation).pipe(
		Effect.provideService(CurrentRestorage, conditions.restorage),
		Effect.catchCause(
			(cause): Effect.Effect<never, PropertyFailed | ComparisonFailed | CaseDiscarded> => {
				if (Cause.hasInterruptsOnly(cause)) {
					return Effect.interrupt
				}
				const error = Cause.squash(cause)
				if (isCaseDiscarded(error)) {
					return Effect.fail(error)
				}
				const failed =
					error instanceof PropertyFailed || error instanceof ComparisonFailed
						? error
						: new PropertyFailed({ report: reportOf(cause) })
				if (!isPerturbed(perturbation)) {
					return Effect.fail(failed)
				}
				const report = Arr.join([failed.report, printPerturbation(perturbation)], "\n")
				return Effect.fail(
					failed instanceof ComparisonFailed
						? new ComparisonFailed({ report, outcome: failed.outcome })
						: new PropertyFailed({ report })
				)
			}
		)
	)
}

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
			oracle: { kind: "unstated" },
			suite: options.suite,
			draw: sketched(
				(source): readonly [S, Conditions] => [
					source.draw(draw.generator),
					{
						perturbation: source.draw(perturbations(options.perturb)),
						restorage: source.draw(restorageGen)
					}
				],
				([sketch, conditions]): readonly [T, Conditions] => [draw.resolve(sketch), conditions]
			),
			literal: ([sketch]) => options.literal(sketch),
			coverage: options.coverage,
			kept: Arr.map(options.kept, (k): Kept<readonly [S, Conditions], F> => ({
				...k,
				sketch: [k.sketch, { perturbation: unperturbed, restorage: onceRotated }]
			})),
			runs: options.runs,
			shrink: options.shrink,
			concurrency: 1,
			steerEvery: 16,
			caseHang
		},
		([value, conditions], c) => underPerturbation(property(value, c), conditions)
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
 * report (the shrunk case and how to replay it) and the last case whose property failed, with the verdict its typed
 * failure carried. A verdict is a kill only when a witness found it (the floor stream or the steered phase, which the
 * suite's label fixes), so a kill search passes or fails alike on every run seed; one only a case the run's seed drew
 * found is unwitnessed, its counterexample carried so the population gains an arm that reaches it. A failure that
 * carries no verdict, a harness's, is no kill. Shrinking runs failing cases until the shrunk one, so the last failing
 * case is the shrunk case unless a later candidate failed without drawing fewer decisions.
 */
export type KillResult<T> =
	| { readonly kind: "survived"; readonly explored: Explored }
	| {
			readonly kind: "killed"
			readonly report: string
			readonly counterexample: T
			readonly verdict: KillVerdict
	  }
	| {
			readonly kind: "unwitnessed"
			readonly report: string
			readonly counterexample: T
	  }
	| {
			readonly kind: "failed"
			readonly report: string
			readonly counterexample: Option.Option<T>
	  }

/**
 * What a failing case was caught by, as its typed failure says: the two sides' comparison, with its outcome, or one
 * side's second reading against its first (InvarianceFailed), with that verdict.
 */
export type KillVerdict =
	| { readonly kind: "comparison"; readonly outcome: OracleOutcome }
	| { readonly kind: "invariance"; readonly failure: InvarianceFailed }

/**
 * What a kill population's property may fail with: a verdict on the population, the two sides' comparison or one
 * side's second reading. A harness failure is the property's to record, never a kill, and a defect is no verdict.
 */
type Verdict = ComparisonFailed | InvarianceFailed

const verdictOf = (failure: Verdict): KillVerdict => {
	switch (failure._tag) {
		case "ComparisonFailed":
			return { kind: "comparison", outcome: failure.outcome }
		case "InvarianceFailed":
			return { kind: "invariance", failure }
	}
}

/** The last case a kill search's property failed on, and the verdict its failure carried. */
type LastFailure<T> = { readonly value: T; readonly verdict: Option.Option<KillVerdict> }

/**
 * oracleCheck for a population that must be killed (a mutant's): a failing case is the result rather than the search's
 * failure, so the suite can judge the kill's verdict and where it was found. Every other way the search fails (a hang,
 * a stall, an unreached feature, a stale kept case) fails it still.
 */
export const oracleKill = <S, T, F extends string, R>(
	draw: Draw<S, T>,
	options: CheckOptions<S, F>,
	property: (value: T, c: Case<F>) => Effect.Effect<void, Verdict, R>
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
						if (!Cause.hasInterruptsOnly(cause) && !isCaseDiscarded(Cause.squash(cause))) {
							last = Option.some({
								value,
								verdict: Option.map(Cause.findErrorOption(cause), verdictOf)
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
							Option.map(failure.verdict, (verdict) => ({ value: failure.value, verdict }))
						),
						{
							onNone: (): KillResult<T> => ({
								kind: "failed",
								report: falsified.message,
								counterexample: Option.map(last, (failure) => failure.value)
							}),
							onSome: ({ value, verdict }): KillResult<T> =>
								isWitness(falsified.phase)
									? { kind: "killed", report: falsified.message, counterexample: value, verdict }
									: { kind: "unwitnessed", report: falsified.message, counterexample: value }
						}
					)
				)
			)
		)
	})

/**
 * The report of a failed property: its own report, an invariance verdict's, an oracle failure's stage and message, or
 * the cause.
 */
const reportOf = (cause: Cause.Cause<unknown>): string => {
	const error = Cause.squash(cause)
	if (
		error instanceof PropertyFailed ||
		error instanceof ComparisonFailed ||
		error instanceof InvarianceFailed
	) {
		return error.report
	}
	if (error instanceof OracleFailure) {
		return `${error.stage} failed on ${error.side}: ${error.message}`
	}
	return Cause.pretty(cause)
}
