/**
 * Flights, a hot path: every statement of every Db call is planned, written and answered here, so the per-statement
 * work is native loops with no Option, tuple or closure per statement, and Effect stays at the flight's boundary.
 */
import { Buffer } from "node:buffer"
import {
	absurd,
	type Array as Arr,
	type Brand,
	type Cause,
	Data,
	Deferred,
	Duration,
	Effect,
	Exit,
	Option,
	Result
} from "effect"

import {
	type ReadError,
	ReadFailure,
	serializationRefusal,
	StaleSnapshot,
	TransientFailure
} from "#adapter/errors/execution.ts"

import {
	type AloneFailure,
	type BatchFailure,
	BatchRefused,
	CommitLost,
	CommitRefused,
	ConnectionLost,
	DriverFailure,
	InputTooLarge,
	Migrated,
	Migrating,
	ServerError,
	StaleName,
	type StaleReason,
	StaleStatement,
	type TransactionFate,
	UnreadableAnswer
} from "#adapter/errors/failures.ts"

import {
	type Answer,
	type WireQuery,
	type ServerStatement,
	type Session,
	unnamed
} from "#adapter/wire/session.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import { messageMaxBytes } from "#compiler/core/policy.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"

/** A statement of a reviewed migration file, minted where migrate/input.ts splits a file into its statements. */
export type MigrationText = string & Brand.Brand<"MigrationText">

/**
 * SQL grizzle sends: printed from an AST by the engine (sql/emit.ts), or a reviewed migration file's own statement.
 * Hand-written SQL is no SentText, so it never reaches the wire.
 */
export type SentText = EmittedText | MigrationText

/** One statement of a flight: its SQL and its parameters' texts, in placeholder order. */
export interface BatchStatement {
	readonly sql: SentText
	readonly params: ReadonlyArray<string>
}

/** One run of a server statement of the session's pool, with its parameters' texts, in placeholder order. */
export interface NamedStatement {
	readonly server: ServerStatement
	readonly params: ReadonlyArray<string>
}

/**
 * A statement of a flight: run as PostgreSQL's unnamed statement, parsed with this execution, or as a server statement
 * of the pool, parsed on the session's first use of it (session.ts SessionStatements).
 */
export type FlightStatement = BatchStatement | NamedStatement

/**
 * What one statement of a flight returned: its command tag, and its rows, every cell the text the server sent
 * (session.ts admits no NULL).
 */
export interface BatchOutcome {
	readonly command: string
	readonly rows: ReadonlyArray<ReadonlyArray<string>>
}

/** The transaction a flight runs its statements in, always SERIALIZABLE: whether it writes, and how it ends. */
export interface Transaction {
	readonly access: "readOnly" | "readWrite"
	readonly end: "COMMIT" | "ROLLBACK"
}

/**
 * What every transaction of a Db begins with, at the pipeline positions right after BEGIN, both run as the login (see
 * the header): `fence`, the ledger's ACCESS SHARE lock NOWAIT, and `enter`, the first statement that takes the
 * transaction's snapshot, which calls the snapshot guard with `snapshot`, the fingerprint the Db was admitted at, then
 * takes on `role` and sets the Db's `claims` for the transaction. Built once per Db (prologueOf), at Db.open.
 */
export interface Prologue {
	readonly role: string
	readonly claims: string
	readonly snapshot: SchemaFingerprint
	readonly fence: NamedStatement
	readonly enter: NamedStatement
}

/**
 * The prologue's two statements, server statements of the layer's pool from its schema's ledger statements
 * (deploy/ledger/ledger.ts fence and enter): named once per session, for the pool's life.
 */
export interface PrologueStatements {
	readonly fence: ServerStatement
	readonly enter: ServerStatement
}

/** The prologue of a Db of `role` with `claims`, admitted at `snapshot`, from its pool's prologue statements. */
export const prologueOf = (
	statements: PrologueStatements,
	role: string,
	claims: string,
	snapshot: SchemaFingerprint
): Prologue => ({
	role,
	claims,
	snapshot,
	fence: { server: statements.fence, params: [] },
	enter: { server: statements.enter, params: [snapshot, role, claims] }
})

/** A Db's transaction: framed as a transaction is, and begun by the Db's prologue (see the header). */
export interface Frame extends Transaction {
	readonly prologue: Prologue
}

/** The prologue was refused at the pipeline positions right after BEGIN, for no reason of the fence's: nothing ran. */
class PrologueRefused extends Data.TaggedError("PrologueRefused")<{
	readonly failure: ServerError
}> {}

/**
 * How a Db call's flight fails: as any flight, at its prologue, or at its fence; or, before anything is sent, with a
 * statement whose Bind message PostgreSQL would not read (bindOverrun).
 */
export type FlightFailure = BatchFailure | PrologueRefused | StaleSnapshot | InputTooLarge

/** The fence's two steps: the ledger's lock NOWAIT, and the guard's call. */
export type FenceStep = "lock" | "guard"

/**
 * Why the fence refused, from the server's refusal of its `step`, or none for any other refusal: the lock refused at once
 * (55P03) while a migration holds or awaits it; the guard's 55Z02, a folder unfinished, and 55Z01, another latest
 * target. The one reading of a fence's refusal: every Db transaction's (failureAt) and admission's.
 */
export const fenceReason = (step: FenceStep, failure: ServerError): Option.Option<StaleReason> => {
	switch (step) {
		case "lock":
			return failure.sqlstate === sqlstates.lockNotAvailable
				? Option.some(new Migrating())
				: Option.none()
		case "guard":
			return failure.sqlstate === sqlstates.grizzleMigrating
				? Option.some(new Migrating())
				: failure.sqlstate === sqlstates.grizzleMigrated
					? Option.some(new Migrated())
					: Option.none()
	}
}

/**
 * How a read surfaces a flight's failure: the fence's refusal as itself, SERIALIZABLE's refusal and a stale statement
 * as the TransientFailure a write meets for them, any other refusal as the server's, and a session's failure as the
 * session's.
 */
export const asReadFailure = (failure: FlightFailure): ReadError => {
	switch (failure._tag) {
		case "StaleSnapshot":
			return failure
		case "StaleName":
			return new TransientFailure({ reason: new StaleStatement(), error: failure.failure })
		case "BatchRefused":
		case "CommitRefused":
		case "PrologueRefused":
			return serializationRefusal(failure.failure) ?? new ReadFailure({ reason: failure.failure })
		case "CommitLost":
		case "ConnectionLost":
		case "DriverFailure":
		case "UnreadableAnswer":
		case "InputTooLarge":
			return new ReadFailure({ reason: failure })
	}
}

/** A statement of a flight as planned: its query in the pipeline. */
interface Planned {
	readonly query: Extract<WireQuery, { readonly _tag: "statement" }>
}

/** A statement under its name for this execution: unnamed, or its server statement's, parsed now or bound. */
const queryOf = (session: Session, statement: FlightStatement): Planned["query"] =>
	"server" in statement
		? {
				_tag: "statement",
				sql: statement.server.sql,
				params: statement.params,
				name: session.statements.name(statement.server)
			}
		: { _tag: "statement", sql: statement.sql, params: statement.params, name: unnamed }

const plannedOf = (session: Session, statement: FlightStatement): Planned => ({
	query: queryOf(session, statement)
})

/** Plans each of `statements`. */
const planAll = (
	session: Session,
	statements: ReadonlyArray<FlightStatement>
): ReadonlyArray<Planned> => statements.map((statement) => plannedOf(session, statement))

/** The queries of `planned`, in order. */
const queriesOf = (planned: ReadonlyArray<Planned>): Array<WireQuery> =>
	planned.map((one) => one.query)

/** A statement of a transaction as planned, at its index among the transaction's statements. */
interface PlannedStatement extends Planned {
	readonly kind: "statement"
	readonly at: number
}

/**
 * What a position of a transaction's flight is, from BEGIN on: BEGIN, a step `P` of its principal's prologue, one of
 * its statements, or its end.
 */
type Position<P> =
	| { readonly kind: "begin" }
	| { readonly kind: "prologue"; readonly planned: Planned; readonly step: P }
	| PlannedStatement
	| { readonly kind: "end" }

const beginStep: Position<never> = { kind: "begin" }

const endStep: Position<never> = { kind: "end" }

/**
 * Whom a transaction runs as: the statements of the prologue it begins with, each at a step `P`, and how the flight
 * fails, as `F`, when the server refuses one for no reason of the session's. The login itself has no prologue, so
 * nothing of it is refused.
 */
interface Principal<P, F> {
	readonly prologue: ReadonlyArray<{ readonly statement: NamedStatement; readonly step: P }>
	readonly refused: (step: P, failure: ServerError) => F
}

const asLogin: Principal<never, never> = { prologue: [], refused: absurd }

/**
 * A Db's role, entered by its prologue's two statements, both run as the login: the fence's lock and the statement
 * that calls the guard and enters the role. A refusal the fence explains (fenceReason) is StaleSnapshot, any other
 * PrologueRefused.
 */
const asDb = (prologue: Prologue): Principal<FenceStep, PrologueRefused | StaleSnapshot> => ({
	prologue: [
		{ statement: prologue.fence, step: "lock" },
		{ statement: prologue.enter, step: "guard" }
	],
	refused: (step, failure) =>
		Option.getOrElse(
			Option.map(
				fenceReason(step, failure),
				(reason): PrologueRefused | StaleSnapshot =>
					new StaleSnapshot({ reason, snapshot: prologue.snapshot, error: failure })
			),
			() => new PrologueRefused({ failure })
		)
})

/**
 * A transaction's flight as planned: the statements alone in front of it (runAlongside) at the first pipeline
 * positions, then BEGIN, the prologue of its principal (none for the login), its statements and its end, each a
 * position of `steps` from BEGIN on.
 */
interface Plan<P, F> {
	readonly pipeline: ReadonlyArray<WireQuery>
	readonly before: ReadonlyArray<Planned>
	readonly prologue: ReadonlyArray<Planned>
	readonly statements: ReadonlyArray<PlannedStatement>
	readonly steps: ReadonlyArray<Position<P>>
	readonly refused: Principal<P, F>["refused"]
	readonly transaction: Transaction
}

const planOf = <P, F>(
	session: Session,
	alone: ReadonlyArray<FlightStatement>,
	principal: Principal<P, F>,
	statements: ReadonlyArray<FlightStatement>,
	transaction: Transaction
): Plan<P, F> => {
	const before = planAll(session, alone)
	const pipeline = queriesOf(before)
	const steps: Array<Position<P>> = [beginStep]
	const prologue: Array<Planned> = []
	const framed: Array<PlannedStatement> = []
	pipeline.push({ _tag: "control", control: { kind: "begin", access: transaction.access } })
	for (const { statement, step } of principal.prologue) {
		const planned = plannedOf(session, statement)
		prologue.push(planned)
		steps.push({ kind: "prologue", planned, step })
		pipeline.push(planned.query)
	}
	for (const statement of statements) {
		const planned: PlannedStatement = {
			kind: "statement",
			at: framed.length,
			query: queryOf(session, statement)
		}
		framed.push(planned)
		steps.push(planned)
		pipeline.push(planned.query)
	}
	steps.push(endStep)
	pipeline.push({ _tag: "control", control: { kind: "end", end: transaction.end } })
	return {
		pipeline,
		before,
		prologue,
		statements: framed,
		steps,
		refused: principal.refused,
		transaction
	}
}

/** The pipeline position of a transaction's first statement: behind the statements alone, BEGIN and the prologue. */
const offsetOf = <P, F>(plan: Plan<P, F>): number => plan.before.length + 1 + plan.prologue.length

/** Forgets the name of a statement whose Parse may not have run. */
const forget = (session: Session, planned: Planned): void => {
	const { name } = planned.query
	if (name._tag === "parsing") {
		session.statements.forget(name.name)
	}
}

/** A refused statement whose name the server no longer honors, which the session forgets; false for any other. */
const staleName = (session: Session, planned: Planned, failure: ServerError): boolean => {
	const { name } = planned.query
	if (name._tag !== "parsed") {
		return false
	}
	if (
		failure.sqlstate !== sqlstates.invalidSqlStatementName &&
		failure.sqlstate !== sqlstates.featureNotSupported
	) {
		return false
	}
	session.statements.forget(name.name)
	return true
}

/** Forgets the names of `planned` from `from` on, whose Parse may not have run. */
const forgetFrom = (session: Session, planned: ReadonlyArray<Planned>, from: number): void => {
	for (let index = from; index < planned.length; index++) {
		const one = planned[index]
		if (one !== undefined) {
			forget(session, one)
		}
	}
}

/**
 * What a pipeline position holds once its flight has drained: the server's answer, or none, because the connection
 * ended before one came.
 */
type Received = Answer | { readonly _tag: "unanswered" }

const unanswered: Received = { _tag: "unanswered" }

/**
 * The answer at a position of a pipeline: sentAnswer's fact, send filling one slot per query at the position the
 * plan's arithmetic (BEGIN's offset, the prologue's, the statements', the end's) computes.
 */
const receivedAt = (answers: ReadonlyArray<Received>, index: number): Received =>
	sentAnswer(answers, index)

/** The answers that decide: a query that ran, readably or not, decided nothing. */
type Unanswered = Exclude<Received, { readonly _tag: "result" } | { readonly _tag: "unreadable" }>

/** The answers that decide nothing: a query that ran, readably or not. */
type Decided = Exclude<Received, Unanswered>

/** The answers after which the session is unusable: none came, it failed, or the server ended the session with it. */
type Broken = Exclude<Unanswered, { readonly _tag: "refused" }>

/**
 * The failure of a query no ErrorResponse explains, the session retired: the connection was lost, or pg would not send
 * the query or answered what the pipeline cannot account for.
 */
const broken = (session: Session): ConnectionLost | DriverFailure => {
	session.retire()
	return session.lost()
		? new ConnectionLost({ operation: "query", ended: { by: "transport" } })
		: new DriverFailure({ operation: "query" })
}

/** The failure of a query whose answer leaves the session unusable. */
const lost = (session: Session, answer: Broken): ConnectionLost | DriverFailure => {
	if (answer._tag !== "terminated") {
		return broken(session)
	}
	session.retire()
	return new ConnectionLost({ operation: "query", ended: { by: "server", error: answer.error } })
}

/** The failure of statement `index`, `planned`, from its answer, with no COMMIT at stake. */
const statementFailure = (
	session: Session,
	planned: Planned,
	index: number,
	answer: Unanswered
): AloneFailure => {
	if (answer._tag !== "refused") {
		return lost(session, answer)
	}
	const failure = answer.error
	return staleName(session, planned, failure)
		? new StaleName({ index, failure })
		: new BatchRefused({ index, failure })
}

/**
 * The flight's failure, from the first query of its transaction the server answered neither with a result nor with an
 * unreadable one: `answer` at `position`, pipeline `index`.
 */
const failureAt = <P, F>(
	session: Session,
	plan: Plan<P, F>,
	position: Position<P>,
	index: number,
	answer: Unanswered
): BatchFailure | F => {
	const first = index - offsetOf(plan)
	if (first < 0) {
		forgetFrom(session, plan.prologue, 0)
	}
	forgetFrom(session, plan.statements, Math.max(0, first))
	const commits = plan.transaction.end === "COMMIT"
	if (
		commits &&
		(answer._tag === "unanswered" ||
			answer._tag === "failed" ||
			(answer._tag === "terminated" && position.kind === "end"))
	) {
		session.retire()
		return new CommitLost()
	}
	switch (position.kind) {
		case "begin":
			if (answer._tag !== "refused") {
				return lost(session, answer)
			}
			session.retire()
			return new ConnectionLost({
				operation: "begin",
				ended: { by: "server", error: answer.error }
			})
		case "end":
			if (answer._tag !== "refused") {
				return lost(session, answer)
			}
			if (commits) {
				return new CommitRefused({ failure: answer.error })
			}
			session.retire()
			return new DriverFailure({ operation: "rollback" })
		case "prologue":
			if (answer._tag !== "refused") {
				return lost(session, answer)
			}
			staleName(session, position.planned, answer.error)
			return plan.refused(position.step, answer.error)
		case "statement":
			return statementFailure(session, position, position.at, answer)
	}
}

/**
 * The fate of a transaction's flight from every answer it got (TransactionFate), in pipeline order: BEGIN's, its
 * statements', then its end's.
 *
 * The connection broke: COMMIT may have run, as failureAt's CommitLost says.
 */
const transactionFate = <P, F>(
	plan: Plan<P, F>,
	answers: ReadonlyArray<Received>
): TransactionFate => {
	const endAt = plan.pipeline.length - 1
	for (let index = plan.before.length; index < endAt; index++) {
		const answer = receivedAt(answers, index)
		switch (answer._tag) {
			case "result":
			case "unreadable":
				continue
			case "refused":
			case "terminated":
				return index === plan.before.length ? "noTransaction" : "aborted"
			case "failed":
			case "unanswered":
				return "unknown"
		}
	}
	const end = receivedAt(answers, endAt)
	switch (end._tag) {
		case "result":
			return end.outcome.command === "COMMIT" ? "committed" : "rolledBack"
		case "unreadable":
			return end.command === "COMMIT" ? "committed" : "rolledBack"
		case "refused":
			return "rolledBack"
		case "terminated":
		case "failed":
		case "unanswered":
			return "unknown"
	}
}

/**
 * The flight's failure from the answers before pipeline position `end`: the first query of its transaction answered
 * neither with a result nor with an unreadable one decides (failureAt). Otherwise the answers from BEGIN on, each one
 * that decided nothing.
 */
const decide = <P, F>(
	session: Session,
	plan: Plan<P, F>,
	answers: ReadonlyArray<Received>,
	until: number
): Result.Result<ReadonlyArray<Decided>, BatchFailure | F> => {
	const decided: Array<Decided> = []
	let index = plan.before.length
	for (const position of plan.steps) {
		if (index >= until) {
			break
		}
		const answer = receivedAt(answers, index)
		if (answer._tag !== "result" && answer._tag !== "unreadable") {
			return Result.fail(failureAt(session, plan, position, index, answer))
		}
		decided.push(answer)
		index += 1
	}
	return Result.succeed(decided)
}

/**
 * Each statement's outcome from the answers `decided` from BEGIN on, which decided nothing (decide), or
 * UnreadableAnswer at the first statement that answered rows grizzle's SQL cannot deliver, with what the transaction
 * then did by its `answers`.
 */
const outcomesOf = <P, F>(
	plan: Plan<P, F>,
	answers: ReadonlyArray<Received>,
	decided: ReadonlyArray<Decided>
): Result.Result<ReadonlyArray<BatchOutcome>, UnreadableAnswer> => {
	const from = offsetOf(plan) - plan.before.length
	const outcomes: Array<BatchOutcome> = []
	for (const answer of decided.slice(from, from + plan.statements.length)) {
		if (answer._tag === "unreadable") {
			return Result.fail(
				new UnreadableAnswer({ index: outcomes.length, fate: transactionFate(plan, answers) })
			)
		}
		outcomes.push(answer.outcome)
	}
	return Result.succeed(outcomes)
}

/**
 * The whole flight once it has drained: the first deciding failure, else each statement's outcome or UnreadableAnswer.
 */
const flightOutcomes = <P, F>(
	session: Session,
	plan: Plan<P, F>,
	answers: ReadonlyArray<Received>
): Result.Result<ReadonlyArray<BatchOutcome>, BatchFailure | F> =>
	Result.flatMap(decide(session, plan, answers, plan.pipeline.length), (decided) =>
		outcomesOf(plan, answers, decided)
	)

const cancelGraceMs = 10
const cancelRetryMs = 50
const cancelRetryMaxMs = 1_000
const drainDeadlineMs = 5_000

/** Resolves after `millis` of the Clock's time, or once `done` is. */
const pause = (done: Deferred.Deferred<void>, millis: number): Effect.Effect<void> =>
	Effect.asVoid(Effect.timeoutOption(Deferred.await(done), Duration.millis(millis)))

/**
 * Cancels the statement the backend is running until the flight drains (`done`): the first CancelRequest after a short
 * grace, then again, backing off. Once the first request has been delivered, or has failed, the flight has the drain
 * deadline to drain, so a slow side connection does not lose the race to it; after the deadline its connection is
 * destroyed, which fails every query still in flight, and the flight drains. Every wait is on the Clock, so a TestClock
 * drives the deadlines.
 */
const cancelUntilDrained = (
	session: Session,
	done: Deferred.Deferred<void>
): Effect.Effect<void> => {
	const drained = (): boolean => Deferred.isDoneUnsafe(done) || session.lost()
	const cancelling = (millis: number): Effect.Effect<void> =>
		Effect.suspend(() =>
			drained()
				? Deferred.await(done)
				: session.cancel.pipe(
						Effect.andThen(pause(done, millis)),
						Effect.andThen(cancelling(Math.min(millis * 2, cancelRetryMaxMs)))
					)
		)
	const deadline = Effect.sleep(Duration.millis(drainDeadlineMs)).pipe(
		Effect.andThen(
			Effect.sync(() => {
				session.destroy()
			})
		),
		Effect.andThen(Deferred.await(done))
	)
	return Effect.andThen(
		pause(done, cancelGraceMs),
		Effect.suspend(() =>
			drained()
				? Deferred.await(done)
				: Effect.andThen(
						session.cancel,
						Effect.raceFirst(
							Effect.andThen(
								pause(done, cancelRetryMs),
								cancelling(Math.min(cancelRetryMs * 2, cancelRetryMaxMs))
							),
							deadline
						)
					)
		)
	)
}

/**
 * A flight as written: its answers by pipeline position as they arrive, and when its statements, and then every
 * query, have answered.
 */
interface Sent {
	readonly answers: ReadonlyArray<Received>
	/** The query at the awaited position has answered, or the connection ended first. */
	readonly statements: Deferred.Deferred<void>
	/** Every query has answered, and the ReadyForQuery after the last one has been read. */
	readonly drained: Deferred.Deferred<void>
}

/**
 * Writes `pipeline` behind the names to close, which the caller took before planning it: a name the flight's own
 * failure forgets may still be bound by an earlier statement of the flight, so its Close waits for the next one.
 * `statements` resolves once the query at `awaited` has answered.
 */
const send = (
	session: Session,
	closes: ReadonlyArray<string>,
	pipeline: ReadonlyArray<WireQuery>,
	awaited: number
): Sent => {
	const answers: Array<Received> = []
	for (let index = 0; index < pipeline.length; index++) {
		answers.push(unanswered)
	}
	const statements = Deferred.makeUnsafe<void>()
	const drained = Deferred.makeUnsafe<void>()
	session.send(
		closes,
		pipeline,
		(index, answer) => {
			answers[index] = answer
			if (index === awaited) {
				Deferred.doneUnsafe(statements, Effect.void)
			}
		},
		() => {
			Deferred.doneUnsafe(statements, Effect.void)
			Deferred.doneUnsafe(drained, Effect.void)
		}
	)
	return { answers, statements, drained }
}

/**
 * A flight that ended on a lost connection retires its session, whatever decided its outcome: a refusal the server
 * gave before the connection ended still decides the failure. Every path of a flight ends once it has drained, after
 * its own retirement.
 */
const retireLost = (session: Session): Effect.Effect<void> =>
	Effect.sync(() => {
		if (session.lost()) {
			session.retire()
		}
	})

/**
 * Runs `flight` on a session that can still send, uninterruptibly but for what it restores: a lost session fails at
 * once.
 */
const onSession = <A, E>(
	session: Session,
	flight: (
		restore: <X, Y, Z>(self: Effect.Effect<X, Y, Z>) => Effect.Effect<X, Y, Z>
	) => Effect.Effect<A, E>
): Effect.Effect<A, E | ConnectionLost> =>
	Effect.suspend((): Effect.Effect<A, E | ConnectionLost> => {
		if (!session.lost()) {
			return Effect.ensuring(Effect.uninterruptibleMask(flight), retireLost(session))
		}
		session.retire()
		return Effect.fail(new ConnectionLost({ operation: "query", ended: { by: "transport" } }))
	})

/**
 * Waits interruptibly for `answered`; an interruption retires the session, cancels the flight until it drains and ends
 * the flight with the interruption.
 */
const execute = (
	session: Session,
	restore: <X, Y, Z>(self: Effect.Effect<X, Y, Z>) => Effect.Effect<X, Y, Z>,
	sent: Sent,
	answered: Deferred.Deferred<void>
): Effect.Effect<void> =>
	Effect.flatMap(Effect.exit(restore(Deferred.await(answered))), (waited) =>
		Exit.isSuccess(waited)
			? Effect.void
			: Effect.sync(() => {
					session.retire()
				}).pipe(
					Effect.andThen(cancelUntilDrained(session, sent.drained)),
					Effect.andThen(Effect.failCause(waited.cause))
				)
	)

/** What one statement of a flight of statements apart answered: its outcome, or the server's refusal of it. */
export type ApartAnswer = Result.Result<BatchOutcome, ServerError>

/**
 * How a flight of statements apart fails as a whole: the session failed (ConnectionLost, DriverFailure), or a
 * statement answered rows grizzle's SQL cannot deliver; it ran, and committed at its own Sync.
 */
export type ApartFailure = ConnectionLost | DriverFailure | UnreadableAnswer

/**
 * Statement `index`'s answer in a flight of statements apart: a refusal is its answer, and forgets a name whose Parse
 * may not have run or that the server no longer honors; anything else fails the flight.
 */
const apartAnswer = (
	session: Session,
	planned: Planned,
	index: number,
	answer: Received
): Result.Result<ApartAnswer, ApartFailure> => {
	switch (answer._tag) {
		case "result":
			return Result.succeed(Result.succeed(answer.outcome))
		case "unreadable":
			return Result.fail(new UnreadableAnswer({ index, fate: "committed" }))
		case "refused":
			forget(session, planned)
			staleName(session, planned, answer.error)
			return Result.succeed(Result.fail(answer.error))
		case "terminated":
		case "failed":
		case "unanswered":
			return Result.fail(lost(session, answer))
	}
}

/**
 * Sends `statements`, each alone as its own implicit transaction, as one flight, and returns each one's answer, its
 * outcome or the server's refusal, in order. Every statement is written before any answer is read, so none waits on
 * another's answer, and a refusal reaches no other statement. A lost connection, an answer the pipeline cannot account
 * for, or an unreadable answer fails the flight, at the first in order. An interruption cancels and drains the flight
 * as every flight's does (runTransaction).
 */
export const runApart = (
	session: Session,
	statements: Arr.NonEmptyReadonlyArray<BatchStatement>
): Effect.Effect<ReadonlyArray<ApartAnswer>, ApartFailure> =>
	onSession(session, (restore) =>
		Effect.gen(function* () {
			const { planned, sent } = yield* Effect.sync(() => {
				const closes = session.statements.takeClosing()
				const plannedStatements = planAll(session, statements)
				return {
					planned: plannedStatements,
					sent: send(session, closes, queriesOf(plannedStatements), plannedStatements.length - 1)
				}
			})
			yield* execute(session, restore, sent, sent.drained)
			const answers: Array<ApartAnswer> = []
			for (const p of planned) {
				const index = answers.length
				const answer = apartAnswer(session, p, index, receivedAt(sent.answers, index))
				if (Result.isFailure(answer)) {
					return yield* answer.failure
				}
				answers.push(answer.success)
			}
			return answers
		})
	)

/**
 * The end of an interrupted path that cancels nothing (COMMIT awaited, or a drain the answers already decided): once
 * the flight has drained, the path's own settlement for its session effects, and then the interruption.
 */
const interruptedDrain = <A, E>(
	sent: Sent,
	settlement: Effect.Effect<A, E>,
	cause: Cause.Cause<never>
): Effect.Effect<never> =>
	Deferred.await(sent.drained).pipe(
		Effect.andThen(Effect.exit(settlement)),
		Effect.andThen(Effect.failCause(cause))
	)

/** The pipeline position of a transaction's last statement, BEGIN's when it has none. */
const lastStatement = <P, F>(plan: Plan<P, F>): number =>
	offsetOf(plan) + plan.statements.length - 1

/** Plans a transaction's flight and writes it (see `send`), its statements answered with its last one. */
const sendPlan = <P, F>(
	session: Session,
	alone: ReadonlyArray<FlightStatement>,
	principal: Principal<P, F>,
	statements: ReadonlyArray<FlightStatement>,
	transaction: Transaction
): { readonly plan: Plan<P, F>; readonly sent: Sent } => {
	const closes = session.statements.takeClosing()
	const plan = planOf(session, alone, principal, statements, transaction)
	return { plan, sent: send(session, closes, plan.pipeline, lastStatement(plan)) }
}

/**
 * Sends `statements`, run as `principal`, in one transaction behind its prologue, as one flight, and returns each
 * statement's outcome, in order.
 *
 * COMMIT committed: an unreadable answer is the flight's failure now.
 *
 * The wait is watched for an interruption, which cancels nothing: the wait goes on to COMMIT's answer, the
 * session keeps what that answer decides, and the interruption then takes effect.
 */
const runEntered = <P, F>(
	session: Session,
	principal: Principal<P, F>,
	statements: ReadonlyArray<FlightStatement>,
	transaction: Transaction
): Effect.Effect<ReadonlyArray<BatchOutcome>, BatchFailure | F> =>
	onSession(session, (restore) =>
		Effect.gen(function* () {
			const { plan, sent } = yield* Effect.sync(() =>
				sendPlan(session, [], principal, statements, transaction)
			)
			yield* execute(session, restore, sent, sent.statements)
			const early = decide(session, plan, sent.answers, lastStatement(plan) + 1)
			if (Result.isFailure(early) || transaction.end === "ROLLBACK") {
				/**
				 * The answers decided a failure, or a ROLLBACK frame awaits its end: the flight drains, and an
				 * interruption meanwhile cancels nothing and takes effect once it has drained.
				 * An early failure is settled already; a ROLLBACK frame settles once it has drained.
				 */
				const settled = Result.isFailure(early)
					? Effect.fail(early.failure)
					: Effect.suspend(() => Effect.fromResult(flightOutcomes(session, plan, sent.answers)))
				const waited = yield* Effect.exit(restore(Deferred.await(sent.drained)))
				if (Exit.isFailure(waited)) {
					return yield* interruptedDrain(sent, settled, waited.cause)
				}
				return yield* settled
			}
			/** Every statement answered: COMMIT's answer decides, and a refusal fails the flight as CommitRefused. */
			const decided = Effect.suspend(
				(): Effect.Effect<ReadonlyArray<Decided>, BatchFailure | F> => {
					const settled = decide(session, plan, sent.answers, plan.pipeline.length)
					if (Result.isFailure(settled)) {
						return Effect.fail(settled.failure)
					}
					/** COMMIT answers ROLLBACK only for a transaction an earlier refusal aborted, which none did. */
					const answer = receivedAt(sent.answers, plan.pipeline.length - 1)
					if (answer._tag === "result" && answer.outcome.command === "COMMIT") {
						return Effect.succeed(settled.success)
					}
					session.retire()
					return Effect.fail(new CommitLost())
				}
			)
			const answers = yield* Effect.flatMap(
				Effect.exit(restore(Deferred.await(sent.drained))),
				(waited) =>
					Exit.isSuccess(waited) ? decided : interruptedDrain(sent, decided, waited.cause)
			)
			return yield* Effect.fromResult(outcomesOf(plan, sent.answers, answers))
		})
	)

/**
 * One round trip: a flight of statements in pg's pipeline mode. Every public call sends one flight.
 *
 * In pipeline mode pg writes each query as Parse (when its name is not parsed yet), Bind, Describe, Execute and a Sync
 * of its own, without waiting for the answers. A flight writes all of its queries at once, corked into one write, and
 * reads every answer in that one round trip (session.ts sends it).
 *
 * - Framing. A Sync per statement would commit each statement on its own, so the statements of a transaction run
 *   between BEGIN ISOLATION LEVEL SERIALIZABLE and COMMIT or ROLLBACK, both simple Query messages in the pipeline. After
 *   a refused statement the server answers every later one 25P02 without running it, and COMMIT answers ROLLBACK, so
 *   the transaction is atomic. A lone statement runs as its own implicit transaction, which commits at its Sync, with
 *   neither (`runApart`).
 * - Roles. A transaction runs as the session's login itself (runTransaction, runAlongside: a migration's and
 *   admission's), or, framed for a Db (runFramed), as a role of the login behind the Db's prologue (Prologue), two
 *   statements right after BEGIN, both run as the login. The first is the fence's lock,
 *   `LOCK TABLE <ledger> IN ACCESS SHARE MODE NOWAIT`: a LOCK takes no snapshot, so it runs before the transaction's
 *   snapshot is taken, and a migration holding or awaiting the ledger refuses it at once, with no wait. The second,
 *   the first that takes the snapshot, calls the snapshot guard with the Db's snapshot fingerprint, then enters the role
 *   and sets the Db's claims, both local to the transaction (deploy/ledger/ledger.ts enter); every statement after it
 *   runs as the role. Both settings end with the transaction, so nothing of one Db's role or claims outlives its flight
 *   on a pooled session. A prologue the fence refuses (fenceReason) is StaleSnapshot, and one refused for any other
 *   reason PrologueRefused: nothing ran, and the statements after it were skipped; a transaction of the login has no
 *   prologue to refuse.
 * - Results. Each statement's positional rows, every cell the text the server sent, and its command tag, one outcome
 *   per statement in order.
 * - Failures. BatchRefused: the first statement the server refused, by its index; the statements before it rolled
 *   back and the ones after it never ran. StaleName: the same for a statement whose session name the server no
 *   longer honors. CommitRefused: a refusal at COMMIT once every statement ran (a deferred constraint, a residual law's
 *   function, a serialization failure); nothing committed. CommitLost: the connection failed after COMMIT was sent and
 *   before it answered, with no statement refused before it, so the transaction may have committed. ConnectionLost:
 *   the session failed with a flight in flight that carried no COMMIT, or the server ended it (FATAL, PANIC) before
 *   COMMIT ran; a refused BEGIN is one too, since the statements after it ran outside any transaction.
 *   DriverFailure: an answer that does not fit the pipeline, or a query pg would not send. UnreadableAnswer: a statement
 *   answered rows grizzle's SQL cannot deliver; it decides nothing, so a transaction's fate still comes from COMMIT, and
 *   it is the flight's failure only when nothing else decided. A statement alone meets no COMMIT, so it fails as neither
 *   CommitRefused nor CommitLost (`AloneFailure`).
 * - A flight ends when every query has been answered and the ReadyForQuery after the last one has been read, so a
 *   session is never handed on with an answer still to come.
 * - Names. A statement runs as PostgreSQL's unnamed statement, or as a server statement of the pool under the pool's
 *   name for it, which the session parses on its first use (session.ts SessionStatements): the Db's prologue, and the
 *   programs grizzle compiled ahead. Every name a failed flight was parsing at or after its first refusal is closed and
 *   forgotten, since its Parse may not have run, and the next flight that runs it parses it afresh. A name the server no
 *   longer honors (26000, or 0A000 for a cached plan whose result type changed) is forgotten too.
 * - Retirement. An interruption, a lost connection, a refused BEGIN and an answer that does not fit retire the session.
 *   A refused statement or COMMIT does not, nor does a transaction's or a lone statement's unreadable answer: the
 *   session is idle and healthy, unless the connection ended later in the flight, which retires it whatever decided.
 * - Interruption. A flight interrupted while its statements run sends CancelRequests until it drains, the first after
 *   a short grace, then backing off; one that has not drained 5 seconds after the first request was delivered destroys
 *   its connection. The interruption ends once the flight has drained. Once every statement of a flight that carries
 *   COMMIT has answered, the wait for COMMIT's answer cancels nothing and retires nothing: an interruption that arrives
 *   meanwhile takes effect once COMMIT has answered or the connection is known lost, which pg reports as the
 *   connection's error or close, so the wait ends however the server behaves. The drain after a failure the
 *   statements' answers already decided, and a ROLLBACK frame's wait for its end, cancel nothing either: an
 *   interruption meanwhile takes effect once the flight has drained. A flight that carries COMMIT sent it
 *   with its statements, so an interruption while they run races it: a statement the cancellation stops aborts the
 *   transaction and COMMIT answers ROLLBACK, but statements that had all finished let COMMIT commit before the
 *   cancellation arrives. The interrupted effect's exit is the interruption whatever the commit's fate, wherever the
 *   interruption came, so it never says that nothing committed.
 * - Alone before a transaction (`runAlongside`). A flight may run statements alone, each its own implicit transaction,
 *   in front of a transaction's BEGIN, so their answers come back whatever the transaction meets: a refusal there
 *   does not reach them, nor does theirs reach it. A flight of statements apart (`runApart`) is statements alone and
 *   nothing else: each answers its outcome or the server's refusal, which reaches no other statement.
 *
 * Sends `statements` in one transaction of the login as one flight and returns each statement's outcome, in order.
 */
export const runTransaction = (
	session: Session,
	statements: ReadonlyArray<FlightStatement>,
	transaction: Transaction
): Effect.Effect<ReadonlyArray<BatchOutcome>, BatchFailure> =>
	runEntered(session, asLogin, statements, transaction)

/**
 * What one flight of statements alone and a transaction returned (runAlongside): each statement alone's outcome or
 * the server's refusal of it, and the transaction's outcomes or its failure.
 */
export interface Alongside {
	readonly alone: ReadonlyArray<Result.Result<BatchOutcome, ServerError>>
	readonly framed: Result.Result<ReadonlyArray<BatchOutcome>, BatchFailure>
}

/**
 * Sends `alone`, each statement as its own implicit transaction, then `statements` in `transaction`, as one flight,
 * and returns both parts' answers. A lost connection or an answer the pipeline cannot account for fails the whole
 * flight, as runTransaction's would; so does an unreadable answer of a statement alone here, since the statements alone
 * sent through it read only texts: admission's minimal reads (format('%s')) and the ledger's reads (a count, and each
 * row's JSON text). An interruption cancels and drains the flight as runTransaction does.
 */
export const runAlongside = (
	session: Session,
	alone: ReadonlyArray<BatchStatement>,
	statements: ReadonlyArray<FlightStatement>,
	transaction: Transaction
): Effect.Effect<Alongside, ConnectionLost | DriverFailure> =>
	onSession(session, (restore) =>
		Effect.gen(function* () {
			const { plan, sent } = yield* Effect.sync(() =>
				sendPlan(session, alone, asLogin, statements, transaction)
			)
			yield* execute(session, restore, sent, sent.drained)
			const answers: Array<Result.Result<BatchOutcome, ServerError>> = []
			for (const planned of plan.before) {
				const answer = receivedAt(sent.answers, answers.length)
				switch (answer._tag) {
					case "result":
						answers.push(Result.succeed(answer.outcome))
						continue
					case "refused":
						forget(session, planned)
						answers.push(Result.fail(answer.error))
						continue
					case "unreadable":
						return yield* broken(session)
					case "terminated":
					case "failed":
					case "unanswered":
						return yield* lost(session, answer)
				}
			}
			const framed = flightOutcomes(session, plan, sent.answers)
			if (
				Result.isFailure(framed) &&
				(framed.failure._tag === "ConnectionLost" || framed.failure._tag === "DriverFailure")
			) {
				return yield* framed.failure
			}
			return { alone: answers, framed }
		})
	)

/** Every read of a Db: read-only, one snapshot for all its statements, behind the Db's prologue. */
export const readFrame = (prologue: Prologue): Frame => ({
	access: "readOnly",
	end: "COMMIT",
	prologue
})

/** Every write and refresh of a Db, behind its prologue. */
export const writeFrame = (prologue: Prologue): Frame => ({
	access: "readWrite",
	end: "COMMIT",
	prologue
})

/**
 * The length the Bind message of one execution of `statement` declares, its Int32 length word included and its type
 * byte not, as pg 8.23 writes it (pg-protocol 1.16 serializer.ts `bind`): the unnamed portal's empty name, the
 * statement's name (none, or its server statement's), the count of parameter format codes and one code per parameter,
 * the count of parameters and each as its length and its UTF-8 bytes, and the one result format code with its count.
 */
export const bindLength = (statement: FlightStatement): number => {
	const name = "server" in statement ? statement.server.name : ""
	let length = 4 + 1 + Buffer.byteLength(name, "utf8") + 1 + 2 + 2 + 2 + 2
	for (const param of statement.params) {
		length += 2 + 4 + Buffer.byteLength(param, "utf8")
	}
	return length
}

/**
 * The first of `statements` whose Bind message would be longer than `limit`, the longest message PostgreSQL reads from a
 * client in production (core/policy.ts messageMaxBytes), as the InputTooLarge of its position and length, or none.
 * PostgreSQL answers a longer message by ending the connection without an ErrorResponse ("invalid message length",
 * pqcomm.c pq_getmessage), which a flight carrying COMMIT would report as CommitLost though nothing ran; so it is
 * refused here, before anything is sent. The prologue's statements and the controls carry no parameter of the caller's.
 */
export const bindOverrun = (
	statements: ReadonlyArray<FlightStatement>,
	limit: number
): InputTooLarge | undefined => {
	let statement = 0
	for (const one of statements) {
		const bytes = bindLength(one)
		statement += 1
		if (bytes > limit) {
			return new InputTooLarge({
				bound: { kind: "message", statement: statement - 1, bytes, limit }
			})
		}
	}
	return undefined
}

/**
 * Sends a Db call's statements in `frame`, as one flight, and returns each statement's outcome, in order. Every call
 * sends its frame, a call of no statement included (an apply whose every member is empty): BEGIN, the prologue's
 * fence and snapshot check, and the frame's end, so a Db the database no longer holds the snapshot of fails with
 * StaleSnapshot whatever the call carries, and its outcome is released only once the end answered. A read of one
 * statement still runs framed: the prologue and its statement share one transaction, outside which the prologue's
 * settings would not hold. A statement whose Bind message PostgreSQL would not read fails the call with InputTooLarge
 * before anything is sent (bindOverrun).
 */
export const runFramed = (
	session: Session,
	frame: Frame,
	statements: ReadonlyArray<FlightStatement>
): Effect.Effect<ReadonlyArray<BatchOutcome>, FlightFailure> =>
	Effect.suspend((): Effect.Effect<ReadonlyArray<BatchOutcome>, FlightFailure> => {
		const overrun = bindOverrun(statements, messageMaxBytes)
		return overrun === undefined
			? runEntered(session, asDb(frame.prologue), statements, frame)
			: Effect.fail(overrun)
	})

/**
 * The answer of the statement a sender sent `index`th. The one site of the fact that a flight or a step apart answers
 * every statement it sends, one answer each, in order (runApart, runTransaction, a Flight's `read`): a sender reads an
 * answer by a position it counted while sending, a runtime index no TypeScript type ties to the answers' length, so a
 * miss is a defect.
 */
export const sentAnswer = <A>(answers: ReadonlyArray<A>, index: number): A => {
	const answer = answers[index]
	if (answer === undefined) {
		throw defect(`the answer of sent statement ${index} of ${answers.length}`)
	}
	return answer
}

/**
 * One call's flight as its sender sees it: its statements, and what their outcomes, one per statement in order, read
 * as.
 */
export interface Flight<A, E> {
	readonly statements: ReadonlyArray<FlightStatement>
	readonly read: (outcomes: ReadonlyArray<BatchOutcome>) => Effect.Effect<A, E>
}

/** The flights of `parts` as one: their statements in part order, each part reading its own statements' outcomes. */
export const joinFlights = <A, E>(
	parts: ReadonlyArray<Flight<A, E>>
): Flight<ReadonlyArray<A>, E> => {
	const statements: Array<FlightStatement> = []
	const spans: Array<{ readonly part: Flight<A, E>; readonly from: number }> = []
	for (const part of parts) {
		spans.push({ part, from: statements.length })
		for (const statement of part.statements) {
			statements.push(statement)
		}
	}
	return {
		statements,
		read: (outcomes) =>
			Effect.forEach(spans, ({ part, from }) =>
				part.read(outcomes.slice(from, from + part.statements.length))
			)
	}
}
