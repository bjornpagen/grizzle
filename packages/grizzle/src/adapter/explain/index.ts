import { Array as Arr, Effect, Result, type Scope } from "effect"
import { missingExtension } from "#adapter/admission/expectation.ts"
import { compiledWrite, missingCapability, hostInputs } from "#adapter/apply/index.ts"
import type { DbContext } from "#adapter/db/context.ts"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import { LawRejected, MissingCapability, UnreadableAnswer } from "#adapter/errors/failures.ts"
import { decodePlan } from "#adapter/explain/plan.ts"
import { executionOf, formFor, readBinding } from "#adapter/reader/execution.ts"
import { hostParams } from "#adapter/reader/params.ts"
import { executionInputs, paramCodecs } from "#adapter/reader/relations.ts"
import { readExceeds, templateStatements } from "#adapter/reader/run.ts"
import type { Plan } from "#adapter/types/db.ts"
import {
	asReadFailure,
	type BatchStatement,
	runFramed,
	type Transaction
} from "#adapter/wire/batch.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { recordsetMaxRows } from "#compiler/core/policy.ts"
import * as Engine from "#compiler/core/result.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { transportLimits } from "#compiler/lower/shapes/relparam/index.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { isOrderedValue, isQueryValue } from "#compiler/query/build/index.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"
import { explainOf } from "#compiler/sql/emit.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import { isChangeSetValue } from "#compiler/write/changeset/value.ts"

/**
 * One statement the program would run: planned by EXPLAIN (FORMAT JSON) with its placeholder texts, or, for a carrier's
 * CREATE TEMPORARY TABLE and an ANALYZE, which have no plan, run as it is.
 */
interface Explained {
	readonly statement: BatchStatement
	readonly planned: boolean
}

const planned = (sql: EmittedText, params: ReadonlyArray<string>): Explained => ({
	statement: { sql: explainOf(sql), params },
	planned: true
})

/**
 * A query's EXPLAINs in a read-only transaction, a ChangeSet's in a read-write one; either rolled back, never committed.
 */
const queryFrame: Transaction = { access: "readOnly", end: "ROLLBACK" }
const changeSetFrame: Transaction = { access: "readWrite", end: "ROLLBACK" }

/** Sends `statements` in one flight on a leased session and decodes the Plan of each planned one. */
const plansOf = Effect.fn("plansOf")(function* (
	ctx: DbContext,
	frame: Transaction,
	statements: ReadonlyArray<Explained>
): Effect.fn.Return<ReadonlyArray<Plan>, ReadError, Scope.Scope> {
	const session = yield* Effect.mapError(ctx.pool.lease, (reason) => ReadFailure.make({ reason }))
	const outcomes = yield* Effect.mapError(
		runFramed(
			session,
			{ ...frame, prologue: ctx.prologue },
			Arr.map(statements, (e) => e.statement)
		),
		asReadFailure
	)
	const plans: Array<Plan> = []
	for (const [index, [e, outcome]] of Arr.zip(statements, outcomes).entries()) {
		if (!e.planned) {
			continue
		}
		const plan = decodePlan(outcome.rows[0]?.[0])
		if (Result.isFailure(plan)) {
			return yield* ReadFailure.make({
				reason: UnreadableAnswer.make({ index, fate: "rolledBack" })
			})
		}
		plans.push(plan.success)
	}
	return plans
}, Effect.scoped)

const explainQuery = Effect.fn("explainQuery")(function* (
	ctx: DbContext,
	query: unknown,
	params: ParamMap
): Effect.fn.Return<ReadonlyArray<Plan>, ReadError> {
	const compiled = Engine.flatMap(queryInput(query), (input) =>
		ctx.compile(input, {
			context: "snapshot",
			read: "rows"
		})
	)
	if (!compiled.ok) {
		return yield* ReadFailure.make({ reason: compiled.error })
	}
	const read = compiled.value
	const template = read.template
	const missing = missingExtension(template.requirements, ctx.installedExtensions)
	if (missing !== undefined) {
		return yield* ReadFailure.make({ reason: MissingCapability.make({ capability: missing }) })
	}
	const values = yield* hostParams(template.params, params, recordsetMaxRows)
	const ready = executionInputs(paramCodecs(template.params), values, transportLimits)
	if (Result.isFailure(ready)) {
		return yield* ReadFailure.make({ reason: ready.failure })
	}
	const inputs = ready.success
	const exceeds = readExceeds(inputs)
	/** A query's statements depend on none other (reader/run.ts), so they run in index order. */
	const statements: Array<Explained> = []
	for (const run of flight(templateStatements(template, read.selection.artifact))) {
		const execution = executionOf(formFor(run, exceeds), (slot) => readBinding(slot, inputs))
		if (Result.isFailure(execution)) {
			return yield* ReadFailure.make({ reason: execution.failure })
		}
		statements.push(planned(execution.success.sql, execution.success.params))
	}
	return yield* plansOf(ctx, queryFrame, statements)
})

const explainChangeSet = Effect.fn("explainChangeSet")(function* (
	ctx: DbContext,
	changes: unknown,
	params: ParamMap
): Effect.fn.Return<ReadonlyArray<Plan>, ReadError> {
	const compiled = compiledWrite(ctx, changes, ctx.claims)
	if (Result.isFailure(compiled)) {
		return yield* ReadFailure.make({ reason: compiled.failure })
	}
	const entry = compiled.success
	const missing = missingCapability(entry, ctx.installedExtensions)
	if (missing !== undefined) {
		return yield* ReadFailure.make({ reason: missing })
	}
	const inputs = yield* Effect.mapError(hostInputs(entry, params), (reason) =>
		ReadFailure.make({ reason })
	)
	if (inputs.kind === "rejected") {
		return yield* ReadFailure.make({ reason: LawRejected.make({ law: inputs.law }) })
	}
	const program = entry.program
	const artifact = program.artifacts.optimized
	const skip = inputs.bound.skip(artifact)
	const statements: Array<Explained> = []
	for (const s of artifact.statements) {
		if (skip.has(s.index)) {
			continue
		}
		/** The form of the statement the application sends, with its placeholder texts (write/program/bind.ts). */
		const sql = inputs.bound.form(s).sql
		const texts = inputs.bound.values(s)
		if (!texts.ok) {
			return yield* ReadFailure.make({ reason: texts.error })
		}
		const step = s.step
		statements.push(
			(step.kind === "carrier" && step.step === "create") || step.kind === "analyze"
				? { statement: { sql, params: texts.value }, planned: false }
				: planned(sql, texts.value)
		)
	}
	return yield* plansOf(ctx, changeSetFrame, statements)
})

/**
 * db.explain(program, params): the estimate-only plan of every statement a query or ChangeSet emits.
 *
 * Each statement the program would run for these parameters is planned by `EXPLAIN (FORMAT JSON)`, never ANALYZE, so
 * nothing is executed, and decoded into a Plan with unknown fields dropped (plan.ts); the result is one Plan per
 * statement in execution order. The statements are planned as they would run: the parameters bound through each
 * statement's own encoders, on a session leased like any other. Bound parameters
 * are planned with their values, a custom plan. Every EXPLAIN goes in one flight, in one transaction of the Db's role
 * that is rolled back.
 *
 * A query, an ordered query: the template a direct read would select (`snapshot` context, the Db's role), its
 * statements in order. A relation parameter takes the transport its distinct fact count selects, a VALUES
 * list of typed literals for a small input and the recordset otherwise, and a statement with
 * per-execution forms the form its relation inputs select. An attachment is planned as it runs: it computes its
 * parent's rows itself.
 *
 * A ChangeSet: the WriteProgram an apply would run, its inputs readied exactly as an apply readies them (host
 * normalization, the per-transaction host bound), in a SERIALIZABLE transaction that is rolled back. The transaction
 * carriers are
 * created, empty, by running their CREATE TEMPORARY TABLE statements, and analyzed by running the program's ANALYZE
 * statements at their places, neither of which has a plan; every other statement, a carrier's fill, each stratum's
 * writes, a sequence advance and each read-back, is planned against them in execution order, so the strata and the
 * read-backs are planned against empty carriers and the state before the change. Nothing fills a carrier, but each one
 * a statement joins against a stored relation has been analyzed empty by then, which PostgreSQL estimates at one row,
 * as it estimates an analyzed carrier holding one fact; that is the plan an apply of a small ChangeSet runs. A carrier
 * never analyzed would be planned at PostgreSQL's ten-page guess instead, which no apply sees. A statement an empty
 * enumerated member skips is not emitted and has no plan.
 *
 * Failures are a read's, a ReadFailure with its reason: a program that does not compile for this Db, a ChangeSet's
 * binding of its inputs included, its CompileError (stage compile), and a capability it lacks MissingCapability (stage
 * capability); an input the codec refuses its EncodingFailure, and a same-key pair host normalization refuses
 * LawRejected (stage encode); an input above a size rule InputTooLarge (stage resource); an acquisition failure its
 * refusal (stage acquire); a statement PostgreSQL refuses to plan the server's report (wire/batch.ts asReadFailure),
 * and a plan that does not decode UnreadableAnswer (stage decode).
 *
 * `program` is a query, an ordered query or a ChangeSet over a level of the Db's schema.
 *
 * A JavaScript caller may pass any value; one that is no program does not compile.
 */
export const explain = (
	ctx: DbContext,
	program: unknown,
	params: ParamMap
): Effect.Effect<ReadonlyArray<Plan>, ReadError> =>
	Effect.suspend(() => {
		if (isQueryValue(program) || isOrderedValue(program)) {
			return explainQuery(ctx, program, params)
		}
		if (isChangeSetValue(program)) {
			return explainChangeSet(ctx, program, params)
		}
		return Effect.fail(
			ReadFailure.make({
				reason: malformedDescription(
					SourceLoc("db.explain", []),
					"a query, an ordered query or a ChangeSet value"
				)
			})
		)
	})
