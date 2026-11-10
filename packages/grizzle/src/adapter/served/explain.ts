import { Array as Arr, Effect, Result, type Scope } from "effect"
import { type HostCall, hostInputs, sessionTransport, valuesFailure } from "#adapter/apply/run.ts"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { variantOf } from "#adapter/db/handles.ts"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import { LawRejected, UnreadableAnswer } from "#adapter/errors/failures.ts"
import { decodePlan, explainFailure } from "#adapter/explain/plan.ts"
import { hostParams } from "#adapter/reader/params.ts"
import { executionInputs } from "#adapter/reader/relations.ts"
import { programStatements } from "#adapter/reader/run.ts"
import {
	type ChangeCall,
	type LoadedChange,
	type LoadedMember,
	type LoadedRead
} from "#adapter/served/load.ts"
import type { Plan } from "#adapter/types/db.ts"
import {
	type BatchOutcome,
	type BatchStatement,
	oneShotStatement,
	preparedStatement,
	runFramed,
	runFramedTwice,
	type Transaction
} from "#adapter/wire/batch.ts"
import type { Session } from "#adapter/wire/session.ts"
import type { Chunks, ExecutionPart } from "#compiler/plan/change.ts"
import {
	type CompileError,
	type EmittedText,
	type EncodingFailure,
	explainOf,
	malformedDescription,
	type Param,
	type ParamMap,
	SourceLoc
} from "#compiler/plan/common.ts"

/**
 * One statement a member would run: planned by EXPLAIN (FORMAT JSON) with its placeholder texts, or, for a carrier's
 * CREATE TEMPORARY TABLE and an ANALYZE, which have no plan, run as it is; with what it does (write/program/staged.ts
 * ExecutionPart), a read's and every planned one's `statement`.
 */
interface Explained {
	readonly statement: BatchStatement
	readonly planned: boolean
	readonly part: ExecutionPart
}

const planned = (sql: EmittedText, params: ReadonlyArray<Param>): Explained => ({
	statement: oneShotStatement(explainOf(sql), params),
	planned: true,
	part: "statement"
})

/** A read's EXPLAINs in a read-only transaction, a ChangeSet's in a read-write one; either rolled back, never committed. */
const readFrame: Transaction = { access: "readOnly", isolation: "serializable", end: "ROLLBACK" }
const changeFrame: Transaction = { access: "readWrite", isolation: "serializable", end: "ROLLBACK" }

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

/**
 * Sends the statements `made` makes for the session it leases from the context's pool, in one flight on that session,
 * and decodes the Plan of each planned one.
 */
const plansOf = Effect.fn("plansOf")(function* (
	ctx: ServedDbContext,
	frame: Transaction,
	made: (session: Session) => Result.Result<ReadonlyArray<Explained>, ReadFailure>
): Effect.fn.Return<ReadonlyArray<Plan>, ReadError, Scope.Scope> {
	const session = yield* Effect.mapError(ctx.pool.lease, (reason) => new ReadFailure({ reason }))
	const statements = yield* Effect.fromResult(made(session))
	const outcomes = yield* Effect.mapError(
		runFramed(
			session,
			{ ...frame, prologue: ctx.prologue },
			Arr.map(statements, (e) => e.statement)
		),
		(failure) => explainFailure(statements, failure)
	)
	return yield* Effect.fromResult(decodedPlans(statements, outcomes))
}, Effect.scoped)

/**
 * Sends `first`, then the statements `second` makes from `first`'s outcomes for the session it leases, in one
 * transaction of two flights on that session, and decodes the Plan of each planned one across both.
 */
const plansAfter = Effect.fn("plansAfter")(function* (
	ctx: ServedDbContext,
	frame: Transaction,
	first: ReadonlyArray<Explained>,
	second: (
		session: Session,
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
					Result.map(second(session, read), (made) => {
						explained = [...first, ...made]
						return Arr.map(made, (e) => e.statement)
					})
				)
		),
		(failure) => (failure._tag === "ReadFailure" ? failure : explainFailure(explained, failure))
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
	return yield* plansOf(ctx, readFrame, () =>
		Result.succeed(Arr.map(statements, (s) => planned(s.text.sql, s.params)))
	)
})

/**
 * A member's call as explain plans it, as its handle takes it (types/db WorkloadHandles): its parameters, and, for a
 * ChangeSet that holds array members, each call's facts beside them (FactsApply), on which a chunk's binding depends.
 */
export type MemberCall =
	| { readonly kind: "params"; readonly params: ParamMap }
	| { readonly kind: "facts"; readonly facts: unknown; readonly params: ParamMap }

/**
 * The host call of `call` for the change member `name`, whose calls read as `reads` (load.ts ChangeCall); a call of the
 * other shape is refused as the member's handle never takes it.
 */
const hostCallOf = (
	name: string,
	reads: ChangeCall,
	call: MemberCall
): Result.Result<HostCall, EncodingFailure | CompileError> => {
	const at = SourceLoc("explainMember", [name])
	switch (reads.kind) {
		case "facts":
			return call.kind === "facts"
				? reads.call(call.facts, call.params)
				: Result.fail(
						malformedDescription(
							at,
							"a call's facts beside its parameters, for a ChangeSet with array members"
						)
					)
		case "params":
			return call.kind === "params"
				? Result.succeed(reads.call(call.params))
				: Result.fail(
						malformedDescription(
							at,
							"a call's parameters alone, for a ChangeSet with no array member"
						)
					)
	}
}

/**
 * A change member's program for `call`, each statement planned against empty carriers, rolled back: its write
 * statements, then its read-backs' (change.reads), each read-back's statements as apply's flight sends them behind the
 * writes (apply/readback.ts readBackFlight), over the same inputs, in the artifact's order.
 */
const explainChange = Effect.fn("explainChange")(function* (
	ctx: ServedDbContext,
	name: string,
	change: LoadedChange,
	call: MemberCall
): Effect.fn.Return<ReadonlyArray<Plan>, ReadError> {
	const entry = change.entry
	const inputs = yield* Effect.mapError(
		Effect.flatMap(Effect.fromResult(hostCallOf(name, change.call, call)), (host) =>
			hostInputs(entry, host)
		),
		(reason) => new ReadFailure({ reason })
	)
	if (inputs.kind === "rejected") {
		return yield* new ReadFailure({ reason: new LawRejected({ law: inputs.refused.law }) })
	}
	const readBacks = yield* Effect.mapError(
		Effect.forEach(change.reads.runs.runs, (run) => programStatements(run.program, inputs)),
		(reason) => new ReadFailure({ reason })
	)
	const backs = Arr.map(Arr.flatten(readBacks), (s) => planned(s.text.sql, s.params))
	const skip = inputs.bound.skip
	const explainedOf = (
		chunks: Chunks,
		session: Session
	): Result.Result<ReadonlyArray<Explained>, ReadFailure> => {
		const transport = sessionTransport(session)
		const statements: Array<Explained> = []
		for (const s of entry.program.flight.statements) {
			if (skip.has(s.index)) {
				continue
			}
			const executions = chunks(s, transport)
			if (!executions.ok) {
				return Result.fail(new ReadFailure({ reason: valuesFailure(executions.error) }))
			}
			for (const execution of executions.value) {
				statements.push(
					execution.part === "create" || execution.part === "analyze"
						? {
								statement: preparedStatement(execution.text, execution.params),
								planned: false,
								part: execution.part
							}
						: planned(execution.text.sql, execution.params)
				)
			}
		}
		return Result.succeed(Arr.appendAll(statements, backs))
	}
	const flights = inputs.bound.flights
	if (flights.kind === "write") {
		return yield* plansOf(ctx, changeFrame, (session) => explainedOf(flights.chunks, session))
	}
	const reads = Arr.flatMap(flights.reads, (r): ReadonlyArray<Explained> => [
		planned(r.sql, r.params),
		{ statement: oneShotStatement(r.sql, r.params), planned: false, part: "statement" }
	])
	return yield* plansAfter(ctx, changeFrame, reads, (session, outcomes) => {
		const rows = Arr.flatMap(outcomes, (outcome, at) => (at % 2 === 1 ? [outcome.rows] : []))
		const filled = flights.writes(rows)
		return filled.ok
			? explainedOf(filled.value.chunks, session)
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
 * The estimate-only plan of every statement a loaded member runs for `call` (MemberCall), on a session of `ctx`'s pool:
 * EXPLAIN (FORMAT JSON), never ANALYZE, in one transaction of the Db's role that is rolled back. A read, a key and a paged
 * member plan their rows' statements; a ChangeSet plans the variant the Db's claims select, its carriers created and
 * analyzed empty at their places, then its read-backs behind its writes, and a plan that reads before it writes plans
 * its reads, runs them, and plans the writes it fills from their rows, and the read-backs, in a second flight of the
 * same transaction: one plan per plannable statement its apply sends, in the order it sends them. Each planned
 * statement is sent as its EXPLAIN, a longer text than the one the application sends, so a statement whose text fits the
 * session's message bound only without EXPLAIN's prefix is refused here at stage resource, where the application sends it.
 */
export const explainMember = (
	ctx: ServedDbContext,
	member: LoadedMember,
	call: MemberCall
): Effect.Effect<ReadonlyArray<Plan>, ReadError> => {
	switch (member.kind) {
		case "read":
		case "key":
		case "paged":
			return call.kind === "params"
				? explainRead(ctx, member.read, call.params)
				: Effect.fail(
						new ReadFailure({
							reason: malformedDescription(
								SourceLoc("explainMember", [member.name]),
								"a call's parameters alone, for a read"
							)
						})
					)
		case "change":
			return explainChange(ctx, member.name, variantOf(ctx, member.variants), call)
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
