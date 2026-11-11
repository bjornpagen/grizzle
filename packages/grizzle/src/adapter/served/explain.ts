import { Array as Arr, Effect, Result, type Scope } from "effect"
import { type HostCall, hostInputs, sessionTransport, valuesFailure } from "#adapter/apply/run.ts"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import { LawRejected, UnreadableAnswer } from "#adapter/errors/failures.ts"
import { decodeExecuted, decodePlan, explainFailure } from "#adapter/explain/plan.ts"
import { hostParams } from "#adapter/reader/params.ts"
import { executionInputs } from "#adapter/reader/relations.ts"
import { programStatement } from "#adapter/reader/run.ts"
import type { ChangeCall, LoadedChange, LoadedRead } from "#adapter/served/load.ts"
import type { ExecutedStatement, StatementPlan } from "#adapter/types/db.ts"
import {
	type BatchOutcome,
	type BatchStatement,
	oneShotStatement,
	type PreparedStatement,
	preparedStatement,
	runFramed,
	type Transaction
} from "#adapter/wire/batch.ts"
import type { Session } from "#adapter/wire/session.ts"
import type { Chunks, ExecutionPart } from "#compiler/plan/change.ts"
import {
	type CompileError,
	type EncodingFailure,
	explainAnalyzeOf,
	explainOf,
	malformedDescription,
	type ParamMap,
	SourceLoc
} from "#compiler/plan/common.ts"
import { defect } from "#compiler/plan/runtime.ts"
import type { ServedTables } from "#compiler/plan/serve.ts"

/**
 * Explaining a served member: the statements it sends for one call, each planned by PostgreSQL over its served text and
 * that call's values, decoded into a typed plan whose nodes name what they read by the login's served file
 * (explain/plan.ts), in one transaction of the Db's role that is rolled back.
 *
 * Each planned statement is sent as its EXPLAIN, PostgreSQL's unnamed statement over the served statement's text
 * (sql/emit.ts explainOf), with the parameters the application binds to the named prepared statement, and is reported
 * under that statement's name. A carrier's CREATE TEMPORARY TABLE and an ANALYZE, which have no plan, run as the
 * application runs them, so every statement after them plans against the carrier.
 */

/** One statement an explain sends: planned, for the served statement it names, or run as it is, with what it does. */
type Explained =
	| {
			readonly kind: "planned"
			readonly statement: BatchStatement
			readonly name: PreparedStatement["text"]["name"]
			readonly part: ExecutionPart
	  }
	| { readonly kind: "run"; readonly statement: BatchStatement; readonly part: ExecutionPart }

/** How a statement is planned: PostgreSQL's estimates alone, or the statement run under EXPLAIN ANALYZE. */
type Planning = typeof explainOf

/** The served statement `served` planned by `planning`, under its name. */
const planned = (served: PreparedStatement, planning: Planning): Explained => ({
	kind: "planned",
	statement: oneShotStatement(planning(served.text.sql), served.params),
	name: served.text.name,
	part: "statement"
})

/**
 * A read's EXPLAINs in a read-only transaction, a ChangeSet's in a read-write one, each SERIALIZABLE and rolled back,
 * never committed.
 */
const readFrame: Transaction = { access: "readOnly", isolation: "serializable", end: "ROLLBACK" }
const changeFrame: Transaction = { access: "readWrite", isolation: "serializable", end: "ROLLBACK" }

/**
 * The plan of each planned statement of `explained` by `decode`, one outcome each in order, under the statement's
 * name: a planned statement whose answer `decode` refuses is UnreadableAnswer at its index.
 */
const decodedPlans = <P>(
	explained: ReadonlyArray<Explained>,
	outcomes: ReadonlyArray<BatchOutcome>,
	decode: (name: string, cell: string | undefined) => Result.Result<P, string>
): Result.Result<ReadonlyArray<P>, ReadFailure> => {
	const plans: Array<P> = []
	for (const [index, [e, outcome]] of Arr.zip(explained, outcomes).entries()) {
		if (e.kind === "run") {
			continue
		}
		const plan = decode(e.name, outcome.rows[0]?.[0])
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
 * Sends the statements `made` makes for the session it leases from the context's pool, in one flight on that session
 * in `frame`, and decodes the plan of each planned one by `decode`.
 */
const plansOf = Effect.fn("plansOf")(function* <P>(
	ctx: ServedDbContext,
	frame: Transaction,
	made: (session: Session) => Result.Result<ReadonlyArray<Explained>, ReadFailure>,
	decode: (name: string, cell: string | undefined) => Result.Result<P, string>
): Effect.fn.Return<ReadonlyArray<P>, ReadError, Scope.Scope> {
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
	return yield* Effect.fromResult(decodedPlans(statements, outcomes, decode))
}, Effect.scoped)

/** A read member's one statement for `params`, planned by `planning`, its inputs readied as its execute readies them. */
const readStatement = (
	read: LoadedRead,
	params: ParamMap,
	planning: Planning
): Effect.Effect<Explained, ReadError> =>
	Effect.gen(function* () {
		const values = yield* hostParams(read.params, params)
		const inputs = yield* Effect.mapError(
			Effect.fromResult(executionInputs(read.codecs, values)),
			(reason) => new ReadFailure({ reason })
		)
		const statement = yield* Effect.mapError(
			programStatement(read.program, inputs),
			(reason) => new ReadFailure({ reason })
		)
		return planned(statement, planning)
	})

/**
 * A read member's statement for `params`, the one its execute and get send, its estimates planned in one rolled-back
 * read-only transaction (see the header).
 */
export const explainRead = (
	ctx: ServedDbContext,
	installed: ServedTables,
	read: LoadedRead,
	params: ParamMap
): Effect.Effect<ReadonlyArray<StatementPlan>, ReadError> =>
	Effect.flatMap(readStatement(read, params, explainOf), (statement) =>
		plansOf(
			ctx,
			readFrame,
			() => Result.succeed([statement]),
			(name, cell) => Result.map(decodePlan(cell, installed), (plan) => ({ statement: name, plan }))
		)
	)

/**
 * A read member's statement for `params` run under EXPLAIN ANALYZE in one rolled-back read-only transaction: what each
 * node did beside its estimates, and the statement's planning and execution times.
 */
export const explainReadAnalyzed = (
	ctx: ServedDbContext,
	installed: ServedTables,
	read: LoadedRead,
	params: ParamMap
): Effect.Effect<ReadonlyArray<ExecutedStatement>, ReadError> =>
	Effect.flatMap(readStatement(read, params, explainAnalyzeOf), (statement) =>
		plansOf(
			ctx,
			readFrame,
			() => Result.succeed([statement]),
			(name, cell) =>
				Result.map(decodeExecuted(cell, installed), (executed) => ({ statement: name, ...executed }))
		)
	)

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
	const at = SourceLoc("explain", [name])
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
 * statements, then its read-backs' (change.reads), each read-back's statement as apply's flight sends it behind the
 * writes (apply/readback.ts readBackFlight), over the same inputs, in the artifact's order; a riding read-back's is a
 * part of the write statement it rides, planned with it. A served write's statements all go in its one flight
 * (runtime/write/bind.ts servedFlights), so a flight that reads before it writes is a defect of the file's load.
 */
export const explainChange = (
	ctx: ServedDbContext,
	installed: ServedTables,
	name: string,
	change: LoadedChange,
	call: MemberCall
): Effect.Effect<ReadonlyArray<StatementPlan>, ReadError> =>
	Effect.gen(function* () {
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
			Effect.forEach(
				Arr.flatMap(change.reads.runs.runs, (run) => (run.kind === "sent" ? [run] : [])),
				(run) => programStatement(run.program, inputs)
			),
			(reason) => new ReadFailure({ reason })
		)
		const backs = Arr.map(readBacks, (s) => planned(s, explainOf))
		const skip = inputs.bound.skip
		const flights = inputs.bound.flights
		if (flights.kind === "read") {
			return yield* Effect.die(
				defect(`a served write ${name} whose flight reads before it writes, which no served file holds`)
			)
		}
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
									kind: "run",
									statement: preparedStatement(execution.text, execution.params),
									part: execution.part
								}
							: planned(preparedStatement(execution.text, execution.params), explainOf)
					)
				}
			}
			return Result.succeed(Arr.appendAll(statements, backs))
		}
		return yield* plansOf(
			ctx,
			changeFrame,
			(session) => explainedOf(flights.chunks, session),
			(statement, cell) => Result.map(decodePlan(cell, installed), (plan) => ({ statement, plan }))
		)
	})
