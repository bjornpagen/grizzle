import { Array as Arr, Effect, Result, type Scope } from "effect"
import { hostInputs, valuesFailure } from "#adapter/apply/index.ts"
import type { DbContext } from "#adapter/db/context.ts"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import { LawRejected, UnreadableAnswer } from "#adapter/errors/failures.ts"
import { decodePlan } from "#adapter/explain/plan.ts"
import { executionOf, formFor, readBinding } from "#adapter/reader/execution.ts"
import { hostParams } from "#adapter/reader/params.ts"
import { executionInputs, paramCodecs } from "#adapter/reader/relations.ts"
import { readExceeds, readProgram } from "#adapter/reader/run.ts"
import { compiledWrite } from "#adapter/served/forms.ts"
import type { Plan } from "#adapter/types/db.ts"
import {
	asReadFailure,
	type BatchOutcome,
	type BatchStatement,
	bindFrame,
	runFramed,
	runFramedTwice,
	type Transaction
} from "#adapter/wire/batch.ts"
import { type Chunks, inForce, isChangeSetValue } from "#compiler/plan/change.ts"
import {
	type EmittedText,
	Engine,
	explainOf,
	malformedDescription,
	type Param,
	type ParamMap,
	SourceLoc
} from "#compiler/plan/common.ts"
import {
	isOrderedValue,
	isQueryValue,
	queryInput,
	servedSource,
	servedSpine
} from "#compiler/plan/read.ts"

/**
 * One statement the program would run: planned by EXPLAIN (FORMAT JSON) with its placeholder texts, or, for a carrier's
 * CREATE TEMPORARY TABLE and an ANALYZE, which have no plan, run as it is.
 */
interface Explained {
	readonly statement: BatchStatement
	readonly planned: boolean
}

const planned = (sql: EmittedText, params: ReadonlyArray<Param>): Explained => ({
	statement: { sql: explainOf(sql), params },
	planned: true
})

/**
 * A query's EXPLAINs in a read-only transaction, a ChangeSet's in a read-write one; either rolled back, never committed.
 */
const queryFrame: Transaction = { access: "readOnly", end: "ROLLBACK" }
const changeSetFrame: Transaction = { access: "readWrite", end: "ROLLBACK" }

/**
 * The Plan of each planned statement of `explained`, one outcome each in order; a planned statement whose answer is no
 * plan is UnreadableAnswer at its index.
 */
const decodedPlans = (
	explained: ReadonlyArray<Explained>,
	outcomes: ReadonlyArray<BatchOutcome>
): Result.Result<ReadonlyArray<Plan>, ReadFailure> => {
	const plans: Array<Plan> = []
	for (const [index, [e, outcome]] of Arr.zip(explained, outcomes).entries()) {
		if (!e.planned) {
			continue
		}
		const plan = decodePlan(outcome.rows[0]?.[0])
		if (Result.isFailure(plan)) {
			return Result.fail(
				new ReadFailure({ reason: new UnreadableAnswer({ index, fate: "rolledBack" }) })
			)
		}
		plans.push(plan.success)
	}
	return Result.succeed(plans)
}

/** Sends `statements` in one flight on a leased session and decodes the Plan of each planned one. */
const plansOf = Effect.fn("plansOf")(function* (
	ctx: DbContext,
	frame: Transaction,
	statements: ReadonlyArray<Explained>
): Effect.fn.Return<ReadonlyArray<Plan>, ReadError, Scope.Scope> {
	const session = yield* Effect.mapError(ctx.pool.lease, (reason) => new ReadFailure({ reason }))
	const outcomes = yield* Effect.mapError(
		runFramed(
			session,
			{ ...frame, prologue: ctx.prologue },
			Arr.map(statements, (e) => e.statement)
		),
		asReadFailure
	)
	return yield* Effect.fromResult(decodedPlans(statements, outcomes))
}, Effect.scoped)

/**
 * Sends `first`, then the statements `second` makes from `first`'s outcomes, in one transaction of two flights on a
 * leased session (wire/batch.ts runFramedTwice), and decodes the Plan of each planned one across both.
 */
const plansAfter = Effect.fn("plansAfter")(function* (
	ctx: DbContext,
	frame: Transaction,
	first: ReadonlyArray<Explained>,
	second: (
		outcomes: ReadonlyArray<BatchOutcome>
	) => Result.Result<ReadonlyArray<Explained>, ReadFailure>
): Effect.fn.Return<ReadonlyArray<Plan>, ReadError, Scope.Scope> {
	const session = yield* Effect.mapError(ctx.pool.lease, (reason) => new ReadFailure({ reason }))
	let explained: ReadonlyArray<Explained> = first
	const outcomes = yield* Effect.mapError(
		runFramedTwice(
			session,
			{ ...frame, prologue: ctx.prologue },
			Arr.map(first, (e) => e.statement),
			(read) =>
				Effect.fromResult(
					Result.map(second(read), (made) => {
						explained = [...first, ...made]
						return Arr.map(made, (e) => e.statement)
					})
				)
		),
		(failure) => (failure._tag === "ReadFailure" ? failure : asReadFailure(failure))
	)
	return yield* Effect.fromResult(decodedPlans(explained, outcomes))
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
		return yield* new ReadFailure({ reason: compiled.error })
	}
	const template = compiled.value.compiled.template
	const values = yield* hostParams(template.params, params)
	const ready = executionInputs(paramCodecs(template.params, ctx.artifacts.names.codes), values)
	if (Result.isFailure(ready)) {
		return yield* new ReadFailure({ reason: ready.failure })
	}
	const inputs = ready.success
	const exceeds = readExceeds(inputs)
	/** A query's statements depend on none other (reader/run.ts), so they run in index order. */
	const statements: Array<Explained> = []
	const program = readProgram(
		servedSource(template.run),
		servedSpine(compiled.value.compiled.desc),
		ctx.artifacts.names.codes
	)
	for (const { run } of program.records) {
		const execution = executionOf(formFor(run, exceeds), (slot) => readBinding(slot, inputs))
		if (Result.isFailure(execution)) {
			return yield* new ReadFailure({ reason: execution.failure })
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
		return yield* new ReadFailure({ reason: compiled.failure })
	}
	const entry = compiled.success
	const inputs = yield* Effect.mapError(
		hostInputs(entry, params),
		(reason) => new ReadFailure({ reason })
	)
	if (inputs.kind === "rejected") {
		return yield* new ReadFailure({ reason: new LawRejected({ law: inputs.law }) })
	}
	const skip = inputs.bound.skip
	/**
	 * Every statement of the artifact as the application sends it, under the bound in force, each of its executions with
	 * its text and placeholder values: a family step's one per statement its plan cuts, and a staged statement's
	 * carriers' creations, fills and ANALYZE before it (write/program/bind.ts Chunks). A creation and an ANALYZE run
	 * unplanned, as the program's own carriers' do, so every statement after them plans against its carrier.
	 */
	const explainedOf = (chunks: Chunks): Result.Result<ReadonlyArray<Explained>, ReadFailure> => {
		const statements: Array<Explained> = []
		for (const s of entry.flight.statements) {
			if (skip.has(s.index)) {
				continue
			}
			const executions = chunks(s, inForce(bindFrame))
			if (!executions.ok) {
				return Result.fail(new ReadFailure({ reason: valuesFailure(executions.error) }))
			}
			const step = s.step
			for (const { sql, params, part } of executions.value) {
				statements.push(
					(step.kind === "carrier" && step.step === "create") ||
						step.kind === "analyze" ||
						part.kind === "create" ||
						part.kind === "analyze"
						? { statement: { sql, params }, planned: false }
						: planned(sql, params)
				)
			}
		}
		return Result.succeed(statements)
	}
	const flights = inputs.bound.flights
	if (flights.kind === "write") {
		const statements = yield* Effect.fromResult(explainedOf(flights.chunks))
		return yield* plansOf(ctx, changeSetFrame, statements)
	}
	/**
	 * A plan that reads before it writes: each family's read planned, then run, its rows filling the statements the
	 * plan writes, which are planned in the second flight of the same transaction, rolled back like the first.
	 */
	const reads = Arr.flatMap(flights.reads, (r): ReadonlyArray<Explained> => [
		planned(r.sql, r.params),
		{ statement: { sql: r.sql, params: r.params }, planned: false }
	])
	return yield* plansAfter(ctx, changeSetFrame, reads, (outcomes) => {
		const rows = Arr.flatMap(outcomes, (outcome, at) => (at % 2 === 1 ? [outcome.rows] : []))
		const filled = flights.writes(rows)
		return filled.ok
			? explainedOf(filled.value.chunks)
			: Result.fail(
					new ReadFailure({
						reason:
							filled.error._tag === "GeneratedRejection"
								? new LawRejected({ law: filled.error.law })
								: valuesFailure(filled.error)
					})
				)
	})
})

/**
 * db.explain(program, params): the estimate-only plan of every statement a query or ChangeSet emits.
 *
 * Each statement the program would run for these parameters is planned by `EXPLAIN (FORMAT JSON)`, never ANALYZE, so
 * nothing is executed, and decoded into a Plan with unknown fields dropped (plan.ts); the result is one Plan per
 * statement in execution order. The statements are planned as they would run: the parameters bound through each
 * statement's own encoders, on a session leased like any other. Bound parameters
 * are planned with their values, a custom plan. Every EXPLAIN goes in one flight, in one transaction of the Db's role
 * that is rolled back; a ChangeSet whose plan reads before it writes plans and runs its reads in a first flight of that
 * transaction, and plans the writes it fills from their rows in a second.
 *
 * A query, an ordered query: the template a direct read would select (`snapshot` context, the Db's role), its
 * statements in order. A relation parameter travels as its arrays, as it does on a read, and a statement with
 * per-execution forms takes the form its relation inputs select. An attachment is planned as it runs: it computes its
 * parent's rows itself.
 *
 * A ChangeSet: the WriteProgram an apply would run, its inputs readied exactly as an apply readies them (host
 * normalization, each statement's arrays), in a SERIALIZABLE transaction that is rolled back. The transaction
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
 * binding of its inputs included, its CompileError (stage compile); an input the codec refuses its EncodingFailure, and
 * a same-key pair host normalization refuses LawRejected (stage encode); parameters past a bound of their transport
 * InputTooLarge (stage resource); an acquisition failure its refusal (stage acquire); a statement PostgreSQL refuses to
 * plan the server's report (wire/batch.ts asReadFailure), a type the role cannot use among them, and a plan that does
 * not decode UnreadableAnswer (stage decode).
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
			new ReadFailure({
				reason: malformedDescription(
					SourceLoc("db.explain", []),
					"a query, an ordered query or a ChangeSet value"
				)
			})
		)
	})
