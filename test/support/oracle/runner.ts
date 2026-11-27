import * as Engine from "@bjornpagen/grizzle-text/base/result"
import { failureText } from "@bjornpagen/testing/failure"
import type { Reached } from "@bjornpagen/testing/features"
import {
	type Aimed,
	aimed,
	constant,
	type Gen,
	type Space,
	type Steered,
	steered
} from "@bjornpagen/testing/gen"
import { inlineRun, searchInline } from "@bjornpagen/testing/inline"
import {
	type Case as PropertyCase,
	type CheckContext,
	type Kept as KeptToken,
	type Budget,
	type Kill,
	type Oracle,
	property
} from "@bjornpagen/testing/property"
import { fnv1a32 } from "@bjornpagen/testing/random"
import type { PgCluster } from "@bjornpagen/testing/resources"
import {
	Array as Arr,
	Cause,
	Context,
	Data,
	Effect,
	Formatter,
	MutableHashMap,
	Option,
	Order,
	pipe,
	Record as Rec,
	Ref,
	Result,
	Scope,
	String as Str
} from "effect"
import { partRuns } from "#adapter/reader/execution.ts"
import { assembled, cellKindOf, deliveryOf } from "#compiler/codec/delivery.ts"
import { canonicalTag, catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { moneyMinorUnits } from "#compiler/ir/carriers.ts"
import { type Codebook, codecOf, codeOf, type RosterCodec } from "#compiler/ir/codes.ts"
import { decimalPayload } from "#compiler/ir/decimal.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import { rosterOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import {
	conservativeInput,
	type ConservativeParamSlot,
	type ConservativeProgram,
	flight
} from "#compiler/lower/conservative/types.ts"
import type { PartDivision } from "#compiler/lower/parts.ts"
import {
	conservativeStatement,
	type DeliveredPart,
	type SentStatement,
	type StatementParts
} from "#compiler/lower/shapes/index.ts"
import { paramDomainIdentity, servedTypesOf } from "#compiler/physical/ddl/domains.ts"
import { statementOutput, type StatementRoots } from "#compiler/runtime/lower/tree.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { hexOfText, setText } from "#test/support/closed/bit-text.ts"
import { filledSql } from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { messageOf } from "#test/support/message.ts"
import {
	type Comparison,
	compareRuns,
	printComparison,
	printRun,
	type Labeled,
	labeledStatements,
	type Run,
	type StatementRows
} from "#test/support/oracle/compare.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { type SpelledValue, typedLiteralDesc } from "#test/support/oracle/gen/domain.ts"
import type { StoredRow } from "#test/support/oracle/gen/facts.ts"
import { printQueryCase } from "#test/support/oracle/gen/print.ts"
import { genParamDecls } from "#test/support/oracle/gen/query.ts"
import {
	CurrentRestorage,
	permuted,
	type Restorage,
	restorageGen,
	restoredFacts,
	spelledRespelling,
	type StoredRelation
} from "#test/support/oracle/gen/restorage.ts"
import { type GenSchema, schemaCodes, schemaDesc } from "#test/support/oracle/gen/schema.ts"
import {
	captureTexts,
	everyRow,
	RawCaptureError,
	type RawRow,
	type QueryRunner,
	type RowBound
} from "#test/support/oracle/install/capture.ts"
import { oraclePlanUnder } from "#test/support/oracle/install/drafted.ts"
import { InputSpelling, moneyText } from "#test/support/oracle/install/literal.ts"
import { type FactSet, factStatements } from "#test/support/oracle/install/load.ts"
import type { InstallPlan } from "#test/support/oracle/install/model.ts"
import type { RealInstallPlan } from "#test/support/oracle/install/real.ts"
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
import { noFunctions } from "#test/support/oracle/reference/functions.ts"
import { renderExpected } from "#test/support/oracle/reference/render.ts"
import { type DeclineReason, ReferenceUnsupported } from "#test/support/oracle/reference/values.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"
import { checkedStatements } from "#test/support/oracle/verify/index.ts"
import type { PgConnection, PipelineRefused, SqlError } from "#test/support/pg.ts"
import type { WorkerBudgets } from "#test/support/runner.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import {
	Substrate,
	type SubstrateTemplate,
	baseSubstrate
} from "#test/support/substrate/substrate.ts"
import { outputRows } from "#test/support/wire.ts"

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

/**
 * A lowered program as the oracles send it: its one statement, how its rows divide into parts, and its parts' delivered
 * relations in their tree (shapes/index.ts PartedStatement).
 */
export interface SentProgram {
	readonly statement: SentStatement<ConservativeParamSlot>
	readonly parts: StatementParts<ConservativeParamSlot>
	readonly roots: StatementRoots<DeliveredPart>
}

/** A way to lower a case's query: the conservative lowering, an optimized one, or a mutant of the conservative. */
export interface Lowering {
	readonly name: string
	readonly lower: (input: LoweringInput) => Engine.Result<SentProgram, CompileError>
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
 * The oracle baseline's program: deduplication at every set boundary, no certificate, a statement per delivered
 * relation. Every statement it emits passes the kernel's structural audit (oracle/verify checkedStatements).
 */
export const conservativeProgram = ({
	case: c,
	names
}: LoweringInput): Engine.Result<ConservativeProgram, CompileError> =>
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

/**
 * A conservative program as the oracles send it: its statements the parts of one (shapes/index.ts
 * conservativeStatement), which passes the structural audit too.
 */
export const sentConservative = (
	program: ConservativeProgram
): Engine.Result<SentProgram, CompileError> =>
	Engine.map(
		catchRefusal(() => conservativeStatement(program)),
		(sent) => {
			checkedStatements([sent.statement.ast], "conservative program statement")
			return sent
		}
	)

/** The oracle baseline (conservativeProgram), sent as one statement (sentConservative). */
export const conservative: Lowering = {
	name: "conservative",
	lower: (input) => Engine.flatMap(conservativeProgram(input), sentConservative)
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
	readonly program: SentProgram
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

/**
 * Where a case's schema is installed. Named: under a schema name the test holds, inside the case's own transaction,
 * which rolls the installation back with the rest, so one name serves every case of the test. Installed: once per
 * distinct case schema of the test, committed (Installations), so a case's transaction only loads its facts.
 */
export type Placement =
	| { readonly kind: "named"; readonly name: string }
	| { readonly kind: "installed"; readonly installations: Installations }

export interface RunOptions {
	/** Where the case's schema is installed: under a unique schema the runner allocates for the case, or a Placement. */
	readonly schema: { readonly kind: "fresh" } | Placement
}

/** Setting a case's schema up failed: its plan was refused, or PostgreSQL refused a statement installing it. */
class InstallationFailed extends Data.TaggedError("InstallationFailed")<{
	readonly stage: "plan" | "install"
	readonly message: string
}> {}

/**
 * The installations of one test: each distinct case schema it meets with each distinct set of types its cases' queries
 * cast their parameters to, installed once and committed under a schema of its own that the substrate allocated in the
 * test's scope, whose finalizer drops the schema's roles and the schema when the test ends. Two case schemas are one
 * when they are structurally equal (Effect's Equal over the GenSchema, from which the plan is derived), and two sets of
 * parameter types are one when they name the same pattern domains and contracts (paramTypesKey). An explicit value the
 * test makes (installations) and passes in RunOptions, never a memo.
 *
 * The committed installation runs every statement of its plan, which sets no database default, so the database's
 * settings, the test database's own (test/support/pg.ts testDatabaseSettings), never change.
 */
export interface Installations {
	/**
	 * The plan of `schema`'s installation with the types `params` are cast to, installed and committed the first time the
	 * test meets the schema with those types.
	 */
	readonly planOf: (
		schema: GenSchema,
		params: ReadonlyArray<ParamDecl>
	) => Effect.Effect<RealInstallPlan, InstallationFailed>
}

/**
 * The plan of `schema`'s installation under the schema `name`, owned by `owner`, installing the types the case's query
 * casts its declared parameters `params` to (install/drafted.ts oraclePlanUnder).
 */
const planned = (
	schema: GenSchema,
	params: ReadonlyArray<ParamDecl>,
	name: string
): Effect.Effect<RealInstallPlan, InstallationFailed> => {
	const plan = oraclePlanUnder(
		schemaDesc(schema),
		identity.schema(parsedSchemaName(name)),
		schemaCodes(schema),
		params
	)
	return plan.ok
		? Effect.succeed(plan.value)
		: Effect.fail(new InstallationFailed({ stage: "plan", message: plan.error.message }))
}

/** A statement of a case's setup, and the stage its refusal is reported under. */
export interface Staged {
	readonly stage: string
	readonly sql: string
}

/** Each statement under one stage. */
export const staged = (stage: string, statements: ReadonlyArray<string>): ReadonlyArray<Staged> =>
	Arr.map(statements, (sql) => ({ stage, sql }))

/**
 * Statements in one flush (PgConnection pipeline), their answers discarded: the first refusal as `failed` reports it, at
 * its statement's stage, with PostgreSQL's message and the statement's text.
 */
export const runStaged = <E>(
	session: PgConnection,
	statements: ReadonlyArray<Staged>,
	failed: (refusal: { readonly stage: string; readonly message: string }) => E
): Effect.Effect<void, E> =>
	session.pipeline(Arr.map(statements, (s) => s.sql)).pipe(
		Effect.mapError((refused: PipelineRefused) => {
			const at = elementAt(statements, refused.index, "the refused statement")
			return failed({ stage: at.stage, message: `${sqlMessage(refused.error)}\n${at.sql}` })
		}),
		Effect.asVoid
	)

/**
 * The types declared parameters `params` are cast to as one key: the identifier of each pattern domain they name and
 * the name of each contract they are typed by, each kind sorted, each once. Two cases of one schema whose keys agree
 * install the same installation.
 */
const paramTypesKey = (params: ReadonlyArray<ParamDecl>): string => {
	const types = servedTypesOf("the case's query", params, [])
	const sortedOnce = (names: ReadonlyArray<string>): string =>
		Arr.join(Arr.dedupe(Arr.sort(names, Order.String)), " ")
	return `${sortedOnce(
		Arr.map(types.domains, (d) => identifierOf(paramDomainIdentity(d.place, d.regex)))
	)}\n${sortedOnce(Arr.map(types.contracts, (c) => c.contract.name))}`
}

/** A test's Installations, each of its schemas allocated under `label` in the test's scope. */
const installations = (
	label: string
): Effect.Effect<Installations, never, Scope.Scope | OracleSeat> =>
	Effect.gen(function* () {
		const scope = yield* Effect.scope
		const seat = yield* OracleSeat
		const installed = MutableHashMap.empty<GenSchema, Map<string, RealInstallPlan>>()
		const install = (schema: GenSchema, params: ReadonlyArray<ParamDecl>, key: string) =>
			Effect.gen(function* () {
				const name = yield* Scope.provide(seat.schema(label), scope).pipe(
					Effect.mapError(
						(e) => new InstallationFailed({ stage: "install", message: sqlMessage(e) })
					)
				)
				const plan = yield* planned(schema, params, name)
				yield* runStaged(
					seat.lasting.connection,
					staged("install", [
						...seat.lasting.open,
						...filledSql(plan.drafted, seat.database),
						...seat.lasting.close
					]),
					({ message }) => new InstallationFailed({ stage: "install", message })
				)
				const byTypes = Option.getOrElse(
					MutableHashMap.get(installed, schema),
					() => new Map<string, RealInstallPlan>()
				)
				byTypes.set(key, plan)
				MutableHashMap.set(installed, schema, byTypes)
				return plan
			})
		return {
			planOf: (schema, params) => {
				const key = paramTypesKey(params)
				return Option.match(
					Option.flatMapNullishOr(MutableHashMap.get(installed, schema), (byTypes) =>
						byTypes.get(key)
					),
					{
						onSome: (plan) => Effect.succeed(plan),
						onNone: () => install(schema, params, key)
					}
				)
			}
		}
	})

/** A test's named placement: a schema name the test holds, allocated under `label` in its scope. */
export const namedPlacement = (
	label: string
): Effect.Effect<Placement, SqlError, Scope.Scope | OracleSeat> =>
	Effect.gen(function* () {
		const seat = yield* OracleSeat
		const name = yield* seat.schema(label)
		return { kind: "named", name }
	})

/** A test's installed placement: its Installations, each schema allocated under `label` in its scope. */
export const installedPlacement = (
	label: string
): Effect.Effect<Placement, never, Scope.Scope | OracleSeat> =>
	Effect.map(installations(label), (i) => ({ kind: "installed", installations: i }))

/**
 * A case's installation as its transaction runs it: the plan its lowerings and facts are planned against, and the
 * statements installing it inside the transaction, none for an installed schema.
 */
export interface CaseInstallation {
	readonly plan: RealInstallPlan
	readonly statements: ReadonlyArray<string>
}

/**
 * The installation of a case of `schema` placed by `placement`, installing the types its query casts its declared
 * parameters `params` to (planned).
 */
export const caseInstallation = (
	schema: GenSchema,
	params: ReadonlyArray<ParamDecl>,
	placement: Placement
): Effect.Effect<CaseInstallation, InstallationFailed, OracleSeat> => {
	switch (placement.kind) {
		case "named":
			return Effect.gen(function* () {
				const seat = yield* OracleSeat
				const plan = yield* planned(schema, params, placement.name)
				return { plan, statements: filledSql(plan.drafted, seat.database) }
			})
		case "installed":
			return Effect.map(placement.installations.planOf(schema, params), (plan) => ({
				plan,
				statements: []
			}))
	}
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
		case "sha256":
		case "uuid":
		case "inet":
		case "cidr":
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
		case "pattern":
			throw new Error("a value has no pattern literal: only a match reads one")
	}
}

const failure = (stage: OracleFailure["stage"], side: string, message: string) =>
	new OracleFailure({ stage, side, message })

/** A refusal of a case's setup statement: an execution failure of the stage it was staged under. */
const executeFailure = (refusal: {
	readonly stage: string
	readonly message: string
}): OracleFailure => failure("execute", refusal.stage, refusal.message)

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
	statement: { readonly params: ReadonlyArray<ConservativeParamSlot> },
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
 * A write's member slot, nested rows or admission, or a page's placeholder: no query statement holds one, so the caller
 * fails the case.
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
		case "nestedRows":
		case "admission":
		case "page":
			return undefined
	}
}

/**
 * A part's run as the runtime assembles it (codec/delivery.ts assembled), by the delivery its output's cells take: each
 * text cell as sent, and a bytes value as its hex text, the text PostgreSQL's output function writes for it.
 */
const partTexts = (part: DeliveredPart, run: ReadonlyArray<RawRow>): ReadonlyArray<RawRow> => {
	const output = statementOutput(part.role, part.heading, part.fused)
	const delivery = deliveryOf([
		...Arr.map(output.heading, (c) => cellKindOf(c.type)),
		...Arr.map(output.fused, () => "text" as const)
	])
	return Arr.map(assembled(delivery, outputRows(run)), (row) =>
		Arr.map(row, (cell) => (typeof cell === "string" ? cell : `\\x${cell.toHex()}`))
	)
}

/**
 * Each delivered relation of `program`, labeled, and its rows as one execution of the statement of text `text` the
 * program sends delivers them, its placeholders `params`: every cell its text as sent (captureTexts), at most what
 * `bound` reads, the rows divided into its parts' runs as the runtime divides them (adapter/reader/execution.ts
 * partRuns), and each relation's its part's run assembled (partTexts), a relation another's part feeds reading that
 * part's run.
 */
export const sentRows = (
	session: QueryRunner,
	program: { readonly parts: PartDivision; readonly roots: StatementRoots<DeliveredPart> },
	text: string,
	params: ReadonlyArray<string>,
	bound: RowBound
): Effect.Effect<
	ReadonlyArray<{ readonly labeled: Labeled<DeliveredPart>; readonly rows: ReadonlyArray<RawRow> }>,
	SqlError | RawCaptureError
> =>
	Effect.flatMap(captureTexts(session, text, params, bound), (rows) => {
		const runs = partRuns(program.parts, outputRows(rows))
		const out: Array<{
			readonly labeled: Labeled<DeliveredPart>
			readonly rows: ReadonlyArray<RawRow>
		}> = []
		for (const labeled of labeledStatements(program.roots)) {
			const run = runs[labeled.statement.answer]
			if (run === undefined) {
				return Effect.fail(
					new RawCaptureError({
						reason: `${labeled.label}: no part answers ${labeled.statement.answer}`,
						at: { kind: "result" }
					})
				)
			}
			out.push({ labeled, rows: partTexts(labeled.statement, run) })
		}
		return Effect.succeed(out)
	})

/**
 * Runs a program's statement on `session`: each delivered relation's rows (sentRows), at most what `bound` reads, under
 * its label, its heading's columns. A fused attachment fails the run: the runner compares only a relation's own columns.
 */
export const runProgram = (
	session: PgConnection,
	c: QueryCase,
	program: SentProgram,
	name: string,
	bound: RowBound
): Effect.Effect<Run, OracleFailure> =>
	Effect.gen(function* () {
		const text = program.statement.sql.text
		const params = yield* Effect.fromResult(paramValues(c, program.statement, name))
		const parts = yield* sentRows(session, program, text, params, bound).pipe(
			Effect.mapError((e) => failure("execute", name, `${sqlMessage(e)}\n${text}`))
		)
		const statements: Array<StatementRows> = []
		for (const { labeled, rows } of parts) {
			const part = labeled.statement
			if (part.fused.length > 0) {
				return yield* failure(
					"execute",
					name,
					`${labeled.label}: a fused attachment, whose rows the runner compares none of`
				)
			}
			const heading = statementOutput(part.role, part.heading, []).heading
			statements.push({
				label: labeled.label,
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
): Effect.Effect<SentProgram, OracleFailure> =>
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
				functions: noFunctions,
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
 * Runs `opening` and then the body as one reading of the case (OracleSeat reading): in a transaction of its own, or
 * under a savepoint of the case's transaction, opened in one flush with the opening statements and undone after the
 * body. No statement of it has a deadline: a statement that never ends is a hang, which the case's hang guard (caseHang)
 * reports, cancelling the statement it interrupts (pg.ts), and no verdict rests on how long a statement took.
 */
const inRolledBackTransaction = <A, E>(
	opening: ReadonlyArray<Staged>,
	body: (session: PgConnection) => Effect.Effect<A, E>
): Effect.Effect<A, E | OracleFailure, OracleSeat> =>
	Effect.scoped(
		Effect.gen(function* () {
			const seat = yield* OracleSeat
			const reading = yield* seat.reading
			const session = reading.connection
			return yield* runStaged(
				session,
				[...Arr.map(reading.open, (sql) => ({ stage: "setup", sql })), ...opening],
				executeFailure
			).pipe(
				Effect.andThen(body(session)),
				Effect.ensuring(Effect.ignore(session.pipeline(reading.close)))
			)
		})
	)

/**
 * The differential runner.
 *
 * runOracle(case, left, right) runs one generated case on PostgreSQL 19 and compares two sides of it:
 *
 * 1. install the case's schema with the real installer, packages/engine/src/physical/install presented as the oracle's
 *    plan (install/real.ts, adopted after test/pg/physical's equivalence check of the two installers), where its
 *    Placement says: under the test's schema name inside the case's transaction, or once for the test, committed
 *    (Installations); and load the facts as typed literal INSERTs (install/load.ts), BEGIN, the installation, the facts,
 *    ANALYZE and the planner settings sent in one flush;
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
 * and the next case reuses the schema name, or the installed schema. No statement has a deadline: a mutant whose
 * statement does not terminate is a hang, which the case's hang guard reports, and the mutation tester's own timeout
 * counts.
 *
 * An oracle property (oracleProperty) draws every case under a plan perturbation drawn with it (perturb.ts), which
 * runOracle applies: the facts repeated under fresh keys, and a subset of planner settings set for the case's
 * statements.
 *
 * Runs one case and compares its two sides (left is the baseline; the reference may only be the right side).
 */
export const runOracle = (
	input: QueryCase,
	left: Lowering,
	right: RunnerSide,
	options: RunOptions
): Effect.Effect<OracleOutcome, OracleFailure | InvarianceFailed | SqlError, OracleSeat> =>
	runNamed(input, { kind: "unlabelled" }, left, right, options)

/** runOracle of a hand-built case its suite names: the outcome's report opens with the case's label. */
export const runLabelledOracle = (
	input: LabelledCase,
	left: Lowering,
	right: RunnerSide,
	options: RunOptions
): Effect.Effect<OracleOutcome, OracleFailure | InvarianceFailed | SqlError, OracleSeat> =>
	runNamed(input, { kind: "labelled", label: input.label }, left, right, options)

/** The perturbation's planner settings, for every statement of both sides. */
const runNamed = (
	input: QueryCase,
	name: CaseName,
	left: Lowering,
	right: RunnerSide,
	options: RunOptions
): Effect.Effect<OracleOutcome, OracleFailure | InvarianceFailed | SqlError, OracleSeat> =>
	Effect.gen(function* () {
		const seat = yield* OracleSeat
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
		/**
		 * What each side's statement is read to: one row past every row the reference states, when it states them, since
		 * a statement that delivers more has already disagreed with it; every row when two lowerings meet, which state no
		 * count beforehand.
		 */
		const bound: RowBound =
			expected === undefined
				? everyRow
				: {
						kind: "atMost",
						rows: Arr.reduce(expected.success.statements, 1, (n, st) => n + st.rows.length)
					}
		/**
		 * One full role writes every stored relation (oracleLogin), so the catalog is the one a deployment of the
		 * schema's whole world gets.
		 */
		const placement: Placement =
			options.schema.kind === "fresh"
				? {
						kind: "named",
						name: yield* Effect.scoped(seat.schema("oracle"))
					}
				: options.schema
		const installation = yield* caseInstallation(c.schema, genParamDecls(c.query), placement).pipe(
			Effect.mapError((e) =>
				e.stage === "plan"
					? failure("plan", "install", e.message)
					: failure("execute", "install", e.message)
			)
		)
		const plan = installation.plan
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
		/**
		 * Tables filled in this transaction have no statistics, so the planner assumes some thousand rows each and a few
		 * cross-joined scans estimate billions; the executor sizes its startup of a recursive union or hash aggregate by
		 * that estimate, even for EXPLAIN and a handful of actual rows. ANALYZE sees this transaction's own rows and is
		 * rolled back with it; results are unchanged.
		 */
		const tables = Arr.map(Rec.values(plan.tables), (t) => printObjectName(t.name))
		const analyzed = tables.length > 0 ? [`ANALYZE ${Arr.join(tables, ", ")}`] : []
		/** Storing `statements`, analyzing the tables and setting `under`'s planner settings, all under `stage`. */
		const stored = (
			statements: ReadonlyArray<string>,
			under: Perturbation,
			stage: string
		): ReadonlyArray<Staged> =>
			staged(stage, [...statements, ...analyzed, ...plannerStatements(under)])
		return yield* inRolledBackTransaction(
			[
				...staged("install", installation.statements),
				{ stage: "facts", sql: "SAVEPOINT stored" },
				...stored(facts.value, perturbation, "facts")
			],
			(session) =>
				Effect.gen(function* () {
					const leftRun = yield* runProgram(session, c, leftProgram, left.name, bound)
					const rightRun =
						rightProgram !== undefined
							? yield* runProgram(session, c, rightProgram, right.name, bound)
							: yield* referenceRun(session, expected?.success.statements ?? [], plan)
					const comparison = compareRuns(leftRun, rightRun)
					yield* runStaged(
						session,
						[
							{ stage: "facts stored otherwise", sql: "ROLLBACK TO SAVEPOINT stored" },
							...stored(restoredStatements.value, secondPlan, "facts stored otherwise")
						],
						executeFailure
					)
					const lowered: ReadonlyArray<{
						readonly role: SideRole
						readonly name: string
						readonly program: SentProgram
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
						const again = yield* runProgram(
							session,
							restoration.case,
							side.program,
							side.name,
							bound
						)
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
				? [`${o.right.run.name} statement:\n${o.right.program.statement.sql.text}`]
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

/** The plan perturbation each case draws: the facts repeated and planner settings, the settings alone, or none. */
export type Perturb = "all" | "planner" | "none"

/**
 * The property of one case under its perturbation, failing with the report of why, the perturbation appended. A case
 * that is interrupted ends as it did.
 */
const underPerturbation = <E, R>(
	property: Effect.Effect<void, E, R>,
	conditions: Conditions
): Effect.Effect<void, PropertyFailed | ComparisonFailed, R> => {
	const perturbation = conditions.perturbation
	return Effect.provideService(property, CurrentPerturbation, perturbation).pipe(
		Effect.provideService(CurrentRestorage, conditions.restorage),
		Effect.catchCause((cause): Effect.Effect<never, PropertyFailed | ComparisonFailed> => {
			if (Cause.hasInterruptsOnly(cause)) {
				return Effect.interrupt
			}
			const error = Cause.squash(cause)
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
		})
	)
}

/** The perturbations a case of an oracle property draws. */
const perturbations = (perturb: Perturb): Gen<Perturbation> => {
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
 * What an oracle property states (oracleProperty): its space, its required situations, the perturbation its cases draw
 * ("all": the facts repeated and planner settings; "planner": the settings alone; "none"), the oracle it is checked
 * against, its kept tokens and kills, how a case prints (its value alone, as the old suites' literal printed it), and
 * the check of one case, which runs in the case's one rolled-back transaction on the worker's own clone
 * (Substrate.rolledBack, provided as the OracleSeat service, which runOracle and every helper read).
 */
export interface OracleSpec<S, F extends string, E> {
	readonly situations: ReadonlyArray<Reached<F>>
	readonly perturb: Perturb
	readonly oracle: Oracle
	readonly kept: ReadonlyArray<KeptToken>
	readonly kills: ReadonlyArray<Kill>
	/** The property's own search budget: its pre-conversion runs and steered cases, cited where it is stated. */
	readonly budget: Budget
	readonly show: (value: S) => string
	readonly check: (
		c: PropertyCase<F>
	) => (value: S) => Effect.Effect<void, E, OracleSeat | Scope.Scope>
}

/** What an oracle property draws its cases from: a space, aimed at its situations or read of its case's steering. */
type OracleSpace<S, F extends string> = Space<S> | Aimed<S, F> | Steered<S, F>

/** A space's values, each drawn with the conditions it runs under after it, so the two shrink together. */
const conditioned =
	<S>(space: Space<S>, perturb: Perturb): Space<readonly [S, Conditions]> =>
	(source) => [
		source.draw(space),
		{ perturbation: source.draw(perturbations(perturb)), restorage: source.draw(restorageGen) }
	]

/**
 * A property's space conditioned (conditioned): an aimed space's every aim too, so a case aimed at a situation runs
 * perturbed alike, and a steered space under every steering.
 */
const conditionedSpace = <S, F extends string>(
	space: OracleSpace<S, F>,
	perturb: Perturb
): OracleSpace<readonly [S, Conditions], F> =>
	"aims" in space
		? aimed(
				conditioned(space.space, perturb),
				Arr.map(space.aims, ([situation, aim]) => [situation, conditioned(aim, perturb)] as const)
			)
		: "under" in space
			? steered<readonly [S, Conditions], F>((steering) =>
					conditioned(space.under(steering), perturb)
				)
			: conditioned(space, perturb)

/**
 * An oracle property (the runner's, replacing oracleCheck): `space`'s values, each drawn with its plan perturbation and
 * its second reading's restorage (they shrink together), each case checked in its one rolled-back transaction on the
 * worker's own clone of the base template (Substrate.rolledBack, OracleSeat.rolledBack)
 * under its perturbation (underPerturbation), a failure's report the perturbation appended.
 */
export const oracleProperty = <S, const F extends string, E>(
	space: OracleSpace<S, F>,
	spec: OracleSpec<S, F, E>
) =>
	property.explore(conditionedSpace(space, spec.perturb), {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: spec.situations,
		check:
			({ tx }, c: PropertyCase<F>) =>
			([value, conditions]) =>
				Effect.flatMap(tx, (held) =>
					Effect.provideService(
						underPerturbation(spec.check(c)(value), conditions),
						OracleSeat,
						OracleSeat.rolledBack(held)
					)
				),
		oracle: spec.oracle,
		kept: spec.kept,
		kills: spec.kills,
		budget: spec.budget,
		show: ([value]: readonly [S, Conditions]) => spec.show(value)
	})

/**
 * What an oracle property over templates states (seatedOracleProperty): an oracle property's statement (OracleSpec)
 * whose check of a case runs on the case's own Substrate, its own clone of the template its value names, and reads
 * that template's value bound to the clone.
 */
export interface SeatedOracleSpec<S, T, F extends string, E> extends Omit<
	OracleSpec<S, F, E>,
	"check"
> {
	readonly check: (
		c: PropertyCase<F>,
		installed: T
	) => (value: S) => Effect.Effect<void, E, Substrate | Scope.Scope>
}

/**
 * An oracle property (oracleProperty) whose case runs on its own clone of the one of `templates` its value names
 * (`seatOf`; Substrate.oneOf with Substrate.fresh, so a worker builds only the templates its cases drew), provided as
 * the Substrate service, with the template's value bound to its clone, under its perturbation.
 */
export const seatedOracleProperty = <K extends string, T, S, const F extends string, E>(
	templates: Readonly<Record<K, SubstrateTemplate<T>>>,
	seatOf: (value: S) => K,
	space: OracleSpace<S, F>,
	spec: SeatedOracleSpec<S, T, F, E>
) =>
	property.explore(conditionedSpace(space, spec.perturb), {
		needs: Substrate.oneOf(templates, Substrate.fresh),
		situations: spec.situations,
		check:
			(seats, c: PropertyCase<F>) =>
			([value, conditions]) =>
				Effect.scoped(
					Effect.flatMap(seats[seatOf(value)], (taken) =>
						Effect.provideService(
							underPerturbation(spec.check(c, taken.value)(value), conditions),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: spec.oracle,
		kept: spec.kept,
		kills: spec.kills,
		budget: spec.budget,
		show: ([value]: readonly [S, Conditions]) => spec.show(value)
	})

/**
 * What an oracle property over an installed template states (installedOracleProperty): an oracle property's statement
 * (OracleSpec) whose check of a case also reads the template's value bound to the case's clone.
 */
export interface InstalledOracleSpec<S, T, F extends string, E> extends Omit<
	OracleSpec<S, F, E>,
	"check"
> {
	readonly check: (
		c: PropertyCase<F>,
		installed: T
	) => (value: S) => Effect.Effect<void, E, OracleSeat | Scope.Scope>
}

/**
 * An oracle property (oracleProperty) whose every case runs in its one rolled-back transaction on the worker's own clone
 * of `template` (Substrate.rolledBack), so what the template installs once per member is each case's from its start,
 * under the case's perturbation.
 */
export const installedOracleProperty = <S, T, const F extends string, E>(
	template: SubstrateTemplate<T>,
	space: OracleSpace<S, F>,
	spec: InstalledOracleSpec<S, T, F, E>
) =>
	property.explore(conditionedSpace(space, spec.perturb), {
		needs: { installed: Substrate.rolledBack(template) },
		situations: spec.situations,
		check:
			({ installed }, c: PropertyCase<F>) =>
			([value, conditions]) =>
				Effect.flatMap(installed, (held) =>
					Effect.provideService(
						underPerturbation(spec.check(c, held.value)(value), conditions),
						OracleSeat,
						OracleSeat.rolledBack(held)
					)
				),
		oracle: spec.oracle,
		kept: spec.kept,
		kills: spec.kills,
		budget: spec.budget,
		show: ([value]: readonly [S, Conditions]) => spec.show(value)
	})

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

/**
 * What a kill population's search (killSearched) ends with: every witness passed, so the population survived; a witness
 * failed with a verdict (the two sides' comparison or one side's second reading), the shrunk kill, its report and the
 * last case whose check failed with one, which is the shrunk case unless a later candidate failed without drawing fewer
 * decisions; or the search failed otherwise (a check's failure that carries no verdict, a hang, an unreached situation),
 * with its report.
 */
export type KillFound<S> =
	| { readonly kind: "survived" }
	| {
			readonly kind: "killed"
			readonly report: string
			readonly counterexample: S
			readonly verdict: KillVerdict
	  }
	| { readonly kind: "failed"; readonly report: string }

/** What a kill population's search states: its required situations, its witnesses' budget, its oracle, and how a case prints. */
export interface KillSpec<S, F extends string> {
	readonly situations: ReadonlyArray<Reached<F>>
	/** Its witnesses' cases: a floor of a quarter of `runs`, and up to `steered` steered cases while a situation is unreached. */
	readonly budget: Budget
	readonly oracle: Oracle
	readonly show: (value: S) => string
}

/**
 * A kill population's search (a mutant's), nested in the case that states it and run in its process (searchInline) under
 * the worker's own runner services (`services`, the case's workerCluster need), on its witnesses alone, the floor and steered phase its identity `id` fixes, so a mutant is killed on every run seed or
 * on none: `space`'s values, each drawn with its second reading's restorage, run unperturbed by `check` on the case's
 * own seat (OracleSeat). A failing witness is the search's result rather than the case's failure: the shrunk kill, with the
 * verdict its check's typed failure carried, which the case then judges (KillFound).
 */
export const killSearched = <S, const F extends string>(
	id: string,
	services: Context.Context<PgCluster | WorkerBudgets>,
	space: Space<S>,
	spec: KillSpec<S, F>,
	check: (
		c: PropertyCase<F>
	) => (value: S) => Effect.Effect<void, Verdict | PropertyFailed, OracleSeat | Scope.Scope>
): Effect.Effect<KillFound<S>, never, OracleSeat | CheckContext> =>
	Effect.gen(function* () {
		const seat = yield* OracleSeat
		const last = yield* Ref.make(
			Option.none<{ readonly value: S; readonly verdict: KillVerdict }>()
		)
		const recorded =
			(value: S) =>
			(cause: Cause.Cause<Verdict | PropertyFailed>): Effect.Effect<void> =>
				Cause.hasInterruptsOnly(cause)
					? Effect.void
					: Ref.set(
							last,
							Option.map(
								Option.filter(
									Cause.findErrorOption(cause),
									(error): error is Verdict => error._tag !== "PropertyFailed"
								),
								(error) => ({ value, verdict: verdictOf(error) })
							)
						)
		const verdict = yield* Effect.provideContext(
			searchInline(
				property.explore(conditioned(space, "none"), {
					needs: {},
					situations: spec.situations,
					check:
						(_, c: PropertyCase<F>) =>
						([value, conditions]) =>
							Effect.provideService(
								underPerturbation(Effect.tapCause(check(c)(value), recorded(value)), conditions),
								OracleSeat,
								seat
							),
					oracle: spec.oracle,
					kept: [],
					kills: [],
					budget: spec.budget,
					show: ([value]: readonly [S, Conditions]) => spec.show(value)
				}),
				{ ...inlineRun(id, fnv1a32(id)), reach: "witnesses" }
			),
			services
		)
		if (verdict.kind !== "failed") {
			return { kind: "survived" } satisfies KillFound<S>
		}
		const finding = verdict.finding
		if (finding.kind !== "falsified") {
			return { kind: "failed", report: Formatter.format(finding) } satisfies KillFound<S>
		}
		const report = Arr.join(
			[
				`${finding.where}, shrunk: ${Formatter.format(finding.shrinking)}`,
				finding.printed.kind === "drawn" ? finding.printed.value : finding.printed.why,
				finding.failure,
				`replay: ${finding.token}`
			],
			"\n"
		)
		const shrunk = yield* Ref.get(last)
		return Option.match(shrunk, {
			onNone: (): KillFound<S> => ({ kind: "failed", report }),
			onSome: ({ value, verdict: killed }): KillFound<S> => ({
				kind: "killed",
				report,
				counterexample: value,
				verdict: killed
			})
		})
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
	return failureText(cause)
}
