import { Array as Arr, Effect, Result, type Scope } from "effect"
import { hostInputs, valuesFailure } from "#adapter/apply/run.ts"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { variantOf } from "#adapter/db/handles.ts"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import { LawRejected, UnreadableAnswer } from "#adapter/errors/failures.ts"
import { decodePlan } from "#adapter/explain/plan.ts"
import { hostParams } from "#adapter/reader/params.ts"
import { executionInputs } from "#adapter/reader/relations.ts"
import { programStatements } from "#adapter/reader/run.ts"
import {
	type LoadedChange,
	type LoadedMember,
	type LoadedRead,
	noFacts,
	servedCall
} from "#adapter/served/load.ts"
import type { Plan } from "#adapter/types/db.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import {
	asReadFailure,
	type BatchOutcome,
	type BatchStatement,
	runFramed,
	runFramedTwice,
	type Transaction
} from "#adapter/wire/batch.ts"
import { type Chunks, inForce } from "#compiler/plan/change.ts"
import {
	type EmittedText,
	explainOf,
	malformedDescription,
	type Param,
	type ParamMap,
	SourceLoc
} from "#compiler/plan/common.ts"

/**
 * One statement a member would run: planned by EXPLAIN (FORMAT JSON) with its placeholder texts, or, for a carrier's
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

/** A read's EXPLAINs in a read-only transaction, a ChangeSet's in a read-write one; either rolled back, never committed. */
const readFrame: Transaction = { access: "readOnly", end: "ROLLBACK" }
const changeFrame: Transaction = { access: "readWrite", end: "ROLLBACK" }

/** The Plan of each planned statement of `explained`, one outcome each in order (UnreadableAnswer at an index whose
 * answer is no plan). */
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

/** Sends `statements` in one flight on a session of the context's pool and decodes the Plan of each planned one. */
const plansOf = Effect.fn("plansOf")(function* (
	ctx: ServedDbContext,
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
 * Sends `first`, then the statements `second` makes from `first`'s outcomes, in one transaction of two flights, and
 * decodes the Plan of each planned one across both.
 */
const plansAfter = Effect.fn("plansAfter")(function* (
	ctx: ServedDbContext,
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

/** A read member's statements for `params`, each planned, in one rolled-back read-only transaction. */
const explainRead = Effect.fn("explainRead")(function* (
	ctx: ServedDbContext,
	read: LoadedRead,
	params: ParamMap
): Effect.fn.Return<ReadonlyArray<Plan>, ReadError> {
	const values = yield* hostParams(read.params, params)
	const inputs = yield* Effect.mapError(
		Effect.fromResult(executionInputs(read.codecs, values)),
		(reason) => new ReadFailure({ reason })
	)
	const statements = yield* Effect.mapError(
		programStatements(read.program, inputs),
		(reason) => new ReadFailure({ reason })
	)
	return yield* plansOf(
		ctx,
		readFrame,
		Arr.map(statements, (s) => planned(s.sql, s.params))
	)
})

/** A change member's program for `params`, each statement planned against empty carriers, rolled back. */
const explainChange = Effect.fn("explainChange")(function* (
	ctx: ServedDbContext,
	change: LoadedChange,
	params: ParamMap
): Effect.fn.Return<ReadonlyArray<Plan>, ReadError> {
	const entry = change.entry
	const inputs = yield* Effect.mapError(
		Effect.flatMap(Effect.fromResult(servedCall(change, params, noFacts)), (call) =>
			hostInputs(entry, call)
		),
		(reason) => new ReadFailure({ reason })
	)
	if (inputs.kind === "rejected") {
		return yield* new ReadFailure({ reason: new LawRejected({ law: inputs.law }) })
	}
	const skip = inputs.bound.skip
	const explainedOf = (chunks: Chunks): Result.Result<ReadonlyArray<Explained>, ReadFailure> => {
		const statements: Array<Explained> = []
		for (const s of entry.program.flight.statements) {
			if (skip.has(s.index)) {
				continue
			}
			const executions = chunks(s, inForce(bindFrame))
			if (!executions.ok) {
				return Result.fail(new ReadFailure({ reason: valuesFailure(executions.error) }))
			}
			const step = s.step
			for (const { sql, params: sent, part } of executions.value) {
				statements.push(
					(step.kind === "carrier" && step.step === "create") ||
						step.kind === "analyze" ||
						part.kind === "create" ||
						part.kind === "analyze"
						? { statement: { sql, params: sent }, planned: false }
						: planned(sql, sent)
				)
			}
		}
		return Result.succeed(statements)
	}
	const flights = inputs.bound.flights
	if (flights.kind === "write") {
		const statements = yield* Effect.fromResult(explainedOf(flights.chunks))
		return yield* plansOf(ctx, changeFrame, statements)
	}
	const reads = Arr.flatMap(flights.reads, (r): ReadonlyArray<Explained> => [
		planned(r.sql, r.params),
		{ statement: { sql: r.sql, params: r.params }, planned: false }
	])
	return yield* plansAfter(ctx, changeFrame, reads, (outcomes) => {
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
 * The estimate-only plan of every statement a loaded member runs for `params`, on a session of `ctx`'s pool: EXPLAIN
 * (FORMAT JSON), never ANALYZE, in one transaction of the Db's role that is rolled back. A read, a key and a paged
 * member plan their rows' statements; a ChangeSet plans the variant the Db's claims select, its carriers created and
 * analyzed empty at their places, and a plan that reads before it writes plans its reads, runs them, and plans the
 * writes it fills from their rows in a second flight of the same transaction.
 */
export const explainMember = (
	ctx: ServedDbContext,
	member: LoadedMember,
	params: ParamMap
): Effect.Effect<ReadonlyArray<Plan>, ReadError> => {
	switch (member.kind) {
		case "read":
		case "key":
		case "paged":
			return explainRead(ctx, member.read, params)
		case "change":
			return explainChange(ctx, variantOf(ctx, member.variants), params)
		case "refresh":
			return Effect.fail(
				new ReadFailure({
					reason: malformedDescription(
						SourceLoc("explainMember", [member.name]),
						"a member whose statements EXPLAIN plans: a refresh runs REFRESH MATERIALIZED VIEW, which has no plan"
					)
				})
			)
	}
}
