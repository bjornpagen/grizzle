import { Buffer } from "node:buffer"
import type * as Arr from "effect/Array"
import type * as Brand from "effect/Brand"
import * as Cause from "effect/Cause"
import * as Data from "effect/Data"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Function from "effect/Function"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
/**
 * Flights, a hot path: every statement of every Db call is planned, written and answered here, so the per-statement
 * work is native loops with no Option, tuple or closure per statement, and Effect stays at the flight's boundary.
 */
import {
	defect,
	type ExplainText,
	type Prepared,
	sqlstates,
	type StatementName,
	statementNameBytes,
	textParam
} from "#compiler/plan/runtime.ts"

import {
	type ReadError,
	ReadFailure,
	serializationRefusal,
	StaleSnapshot
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
	type StaleReason,
	type TransactionFate,
	UnreadableAnswer
} from "#adapter/errors/failures.ts"

import {
	type Answer,
	type ControlTexts,
	controlText,
	type WireQuery,
	type Session
} from "#adapter/wire/session.ts"
import type { BindFrame } from "#compiler/plan/change.ts"
import type {
	EmittedText,
	Isolation,
	OutputRows,
	Param,
	SchemaFingerprint
} from "#compiler/plan/common.ts"

/** A statement of a reviewed migration file, minted where migrate/input.ts splits a file into its statements. */
export type MigrationText = string & Brand.Brand<"MigrationText">

/**
 * SQL grizzle sends: printed from an AST by the engine (sql/emit.ts), an emitted statement's EXPLAIN (runtime/explain.ts),
 * or a reviewed migration file's own statement. Hand-written SQL is no SentText, so it never reaches the wire.
 */
export type SentText = EmittedText | ExplainText | MigrationText

/**
 * One statement of a flight and its parameters, each a text or a binary value, in placeholder order: a statement of a
 * served login's programs, its prologue's two among them (PreparedStatement), or SQL grizzle sends beside them
 * (OneShotStatement). Each is sent one way only, by its kind, never by a choice of its sender's.
 */
export type BatchStatement = PreparedStatement | OneShotStatement

/**
 * A served statement: its text runs as its named prepared statement (core/prepared.ts), which pg parses on the
 * session's first use of its name and binds on every use after, so PostgreSQL parses and plans it once per session.
 * Its text is named where generate serves it, so nothing names it per call. Its rows go to its intake as they arrive
 * (RowIntake).
 */
export interface PreparedStatement {
	readonly _tag: "prepared"
	readonly text: Prepared<EmittedText>
	readonly params: ReadonlyArray<Param>
	readonly intake: RowIntake
}

/**
 * Where a served statement's rows go as the server sends them, each admitted as texts (wire/session.ts): kept for its
 * outcome, or each handed to `take` the moment it arrives and none kept, so a read's program decodes a row while the
 * rows after it are still on the wire (reader/run.ts readIntake). A taken statement's outcome holds no rows.
 */
export type RowIntake =
	| { readonly kind: "kept" }
	| { readonly kind: "taken"; readonly take: (row: OutputRows[number]) => void }

/** The intake of a statement whose rows its outcome holds. */
export const keptRows: RowIntake = { kind: "kept" }

/**
 * SQL grizzle sends beside the served programs, admission's, a migration's, the ledger's, a catalog read and an
 * EXPLAIN: PostgreSQL's unnamed statement, parsed, planned, bound and executed in its own execution. It has no name,
 * so no session keeps it.
 */
export interface OneShotStatement {
	readonly _tag: "oneShot"
	readonly sql: SentText
	readonly params: ReadonlyArray<Param>
}

/** The served statement of `text` over `params`, its rows kept for its outcome. */
export const preparedStatement = (
	text: Prepared<EmittedText>,
	params: ReadonlyArray<Param>
): PreparedStatement => ({ _tag: "prepared", text, params, intake: keptRows })

/** The one-shot statement of `sql` over `params`. */
export const oneShotStatement = (
	sql: SentText,
	params: ReadonlyArray<Param>
): OneShotStatement => ({ _tag: "oneShot", sql, params })

/**
 * What one statement of a flight returned: its command tag, and its rows, every cell the text the server sent
 * (session.ts admits no NULL).
 */
export interface BatchOutcome {
	readonly command: string
	readonly rows: OutputRows
}

/**
 * The transaction a flight runs its statements in: whether it writes, the isolation level it begins at, and how it ends.
 * A read-only transaction is SERIALIZABLE, one snapshot for all its statements; a read-write one begins at its role's
 * level.
 */
export type Transaction =
	| {
			readonly access: "readOnly"
			readonly isolation: "serializable"
			readonly end: "COMMIT" | "ROLLBACK"
	  }
	| {
			readonly access: "readWrite"
			readonly isolation: Isolation
			readonly end: "COMMIT" | "ROLLBACK"
	  }

/**
 * A transaction that commits nothing: read-only, or rolled back. Statements alone run in front of no other
 * (runAlongside), so a lost connection that fails their flight as a whole committed nothing of the transaction behind
 * them: admission's fence reads, and the drift check rolls back.
 */
export type Uncommitting =
	| {
			readonly access: "readOnly"
			readonly isolation: "serializable"
			readonly end: Transaction["end"]
	  }
	| { readonly access: "readWrite"; readonly isolation: "serializable"; readonly end: "ROLLBACK" }

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
	readonly fence: PreparedStatement
	readonly enter: PreparedStatement
}

/**
 * The prologue's two statements' texts, its schema's ledger statements (deploy/ledger/ledger.ts fence and enter), each
 * named where generate serves its login: every Db transaction sends both.
 */
export interface PrologueStatements {
	readonly fence: Prepared<EmittedText>
	readonly enter: Prepared<EmittedText>
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
	fence: preparedStatement(statements.fence, []),
	enter: preparedStatement(statements.enter, [
		textParam(snapshot),
		textParam(role),
		textParam(claims)
	])
})

/** A Db's transaction: framed as a transaction is, and begun by the Db's prologue (see the header). */
export type Frame = Transaction & { readonly prologue: Prologue }

/** The prologue was refused at the pipeline positions right after BEGIN, for no reason of the fence's: nothing ran. */
class PrologueRefused extends Data.TaggedError("PrologueRefused")<{
	readonly failure: ServerError
}> {}

/**
 * How a Db call's flight fails: as any flight, at its prologue, or at its fence; or, before anything is sent, with a
 * statement whose Bind message PostgreSQL would not read (bindOverrun), or with a flight longer than one write carries
 * (send).
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
 * How a read surfaces a flight's failure: the fence's refusal as itself, SERIALIZABLE's refusal as the TransientFailure
 * a write meets for it, any other refusal as the server's, and a session's failure as the session's.
 */
export const asReadFailure = (failure: FlightFailure): ReadError => {
	switch (failure._tag) {
		case "StaleSnapshot":
			return failure
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

/** A statement of a flight as planned: its query in the pipeline, the statement itself. */
interface Planned {
	readonly query: BatchStatement
}

const plannedOf = (statement: BatchStatement): Planned => ({ query: statement })

/** Plans each of `statements`. */
const planAll = (statements: ReadonlyArray<BatchStatement>): ReadonlyArray<Planned> =>
	statements.map(plannedOf)

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
	readonly prologue: ReadonlyArray<{ readonly statement: BatchStatement; readonly step: P }>
	readonly refused: (step: P, failure: ServerError) => F
}

const asLogin: Principal<never, never> = { prologue: [], refused: Function.absurd }

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
 * How much of its transaction a flight carries: all of it, from BEGIN through its prologue and statements to its end;
 * its opening, BEGIN, the prologue and the statements, leaving the transaction open for the flight that closes it; or
 * that closing, the statements and the end (runFramedTwice).
 */
type Span = "whole" | "opening" | "closing"

/** Whether a flight of `span` begins its transaction, with BEGIN and its principal's prologue. */
const spanOpens = (span: Span): boolean => span !== "closing"

/** Whether a flight of `span` ends its transaction. */
const spanCloses = (span: Span): boolean => span !== "opening"

/**
 * A transaction's flight as planned: the statements alone in front of it (runAlongside) at the first pipeline
 * positions, then, as its span carries them, BEGIN and the prologue of its principal (none for the login), its
 * statements and its end, each a position of `steps`.
 */
interface Plan<P, F> {
	readonly pipeline: ReadonlyArray<WireQuery>
	readonly before: ReadonlyArray<Planned>
	readonly prologue: ReadonlyArray<Planned>
	readonly statements: ReadonlyArray<PlannedStatement>
	readonly steps: ReadonlyArray<Position<P>>
	readonly refused: Principal<P, F>["refused"]
	readonly transaction: Transaction
	readonly span: Span
}

const planOf = <P, F>(
	alone: ReadonlyArray<BatchStatement>,
	principal: Principal<P, F>,
	statements: ReadonlyArray<BatchStatement>,
	transaction: Transaction,
	span: Span
): Plan<P, F> => {
	const before = planAll(alone)
	const pipeline = queriesOf(before)
	const steps: Array<Position<P>> = []
	const prologue: Array<Planned> = []
	const framed: Array<PlannedStatement> = []
	if (spanOpens(span)) {
		steps.push(beginStep)
		pipeline.push({
			_tag: "control",
			control: { kind: "begin", access: transaction.access, isolation: transaction.isolation }
		})
		for (const { statement, step } of principal.prologue) {
			const planned = plannedOf(statement)
			prologue.push(planned)
			steps.push({ kind: "prologue", planned, step })
			pipeline.push(planned.query)
		}
	}
	for (const statement of statements) {
		const planned: PlannedStatement = {
			kind: "statement",
			at: framed.length,
			query: statement
		}
		framed.push(planned)
		steps.push(planned)
		pipeline.push(planned.query)
	}
	if (spanCloses(span)) {
		steps.push(endStep)
		pipeline.push({ _tag: "control", control: { kind: "end", end: transaction.end } })
	}
	return {
		pipeline,
		before,
		prologue,
		statements: framed,
		steps,
		refused: principal.refused,
		transaction,
		span
	}
}

/**
 * The pipeline position of a transaction's first statement: behind the statements alone, and BEGIN and the prologue
 * where its flight opens the transaction.
 */
const offsetOf = <P, F>(plan: Plan<P, F>): number =>
	plan.before.length + (spanOpens(plan.span) ? 1 + plan.prologue.length : 0)

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
 * The failure of a query no ErrorResponse explains, the session retired, or ended already: the connection was lost,
 * or pg would not send the query or answered what the pipeline cannot account for.
 */
const broken = (session: Session): ConnectionLost | DriverFailure => {
	session.retire()
	return session.state() === "ended"
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

/** The failure of statement `index` from its answer, with no COMMIT at stake. */
const statementFailure = (session: Session, index: number, answer: Unanswered): AloneFailure =>
	answer._tag === "refused"
		? new BatchRefused({ index, failure: answer.error })
		: lost(session, answer)

/**
 * The flight's failure, from the first query of its transaction the server answered neither with a result nor with an
 * unreadable one: `answer` at `position`. A flight whose write was `cut` (Sent.cut) never carried COMMIT to the server,
 * so a connection lost under it committed nothing.
 */
const failureAt = <P, F>(
	session: Session,
	plan: Plan<P, F>,
	position: Position<P>,
	answer: Unanswered,
	cut: boolean
): BatchFailure | F => {
	const commits = spanCloses(plan.span) && plan.transaction.end === "COMMIT"
	if (
		commits &&
		!cut &&
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
			return plan.refused(position.step, answer.error)
		case "statement":
			return statementFailure(session, position.at, answer)
	}
}

/**
 * The fate of a transaction's flight from every answer it got (TransactionFate), in pipeline order: BEGIN's, its
 * statements', then its end's. An opening leaves its end to the flight that closes it, and its runner rolls the
 * transaction back whenever the opening fails (runFramedTwice), so nothing it ran commits.
 *
 * The connection broke: COMMIT may have run, as failureAt's CommitLost says.
 */
const transactionFate = <P, F>(
	plan: Plan<P, F>,
	answers: ReadonlyArray<Received>
): TransactionFate => {
	if (!spanCloses(plan.span)) {
		return "rolledBack"
	}
	const endAt = plan.pipeline.length - 1
	for (let index = plan.before.length; index < endAt; index++) {
		const answer = receivedAt(answers, index)
		switch (answer._tag) {
			case "result":
			case "unreadable":
				continue
			case "refused":
			case "terminated":
				return index === plan.before.length && spanOpens(plan.span) ? "noTransaction" : "aborted"
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
	sent: Sent,
	until: number
): Result.Result<ReadonlyArray<Decided>, BatchFailure | F> => {
	const decided: Array<Decided> = []
	let index = plan.before.length
	for (const position of plan.steps) {
		if (index >= until) {
			break
		}
		const answer = receivedAt(sent.answers, index)
		if (answer._tag !== "result" && answer._tag !== "unreadable") {
			return Result.fail(
				failureAt(session, plan, position, answer, Deferred.isDoneUnsafe(sent.cut))
			)
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
	sent: Sent
): Result.Result<ReadonlyArray<BatchOutcome>, BatchFailure | F> =>
	Result.flatMap(decide(session, plan, sent, plan.pipeline.length), (decided) =>
		outcomesOf(plan, sent.answers, decided)
	)

/**
 * An interrupted flight's end (execute): one CancelRequest for the statement the backend runs, unless the flight has
 * drained or the session has ended, so nothing runs; then the session's connection destroyed at once, which fails
 * every query still in flight, so the flight drains without waiting on the server. The request is bounded by the
 * connection's connect timeout (session.ts Session.cancel), and the destroyed session, ended, never runs again.
 */
const abandon = (session: Session, drained: Deferred.Deferred<void>): Effect.Effect<void> =>
	Effect.suspend(() =>
		Deferred.isDoneUnsafe(drained) || session.state() === "ended" ? Effect.void : session.cancel
	).pipe(
		Effect.andThen(
			Effect.sync(() => {
				session.destroy()
			})
		),
		Effect.andThen(Deferred.await(drained))
	)

/**
 * A flight as written: its answers by pipeline position as they arrive, when its statements, and then every query,
 * have answered, and whether its write was cut.
 */
interface Sent {
	readonly answers: ReadonlyArray<Received>
	/** The query at the awaited position has answered, or the connection ended first. */
	readonly statements: Deferred.Deferred<void>
	/** Every query has answered, and the ReadyForQuery after the last one has been read. */
	readonly drained: Deferred.Deferred<void>
	/**
	 * The write failed while its stream stood (session.ts flightEnd), before any query failed for it: its last
	 * message, the transaction's end where it carries one, never reached the server.
	 */
	readonly cut: Deferred.Deferred<void>
}

/**
 * Writes `pipeline`, unless a Parse of it is longer than the session's server reads (Session.messageMaxBytes) or its
 * bytes as pg writes them pass what one write of the session's connection carries (Session.flightMaxBytes), both
 * counted by accountFlight: then nothing is written, and the flight is refused as InputTooLarge, so no flight is ever
 * cut short by its own length, nor ends its connection at a message the server cannot read. `statements` resolves once
 * the query at `awaited` has answered.
 */
const send = (
	session: Session,
	pipeline: ReadonlyArray<WireQuery>,
	awaited: number
): Result.Result<Sent, InputTooLarge> => {
	const accounted = accountFlight(pipeline, session.messageMaxBytes, session.controls)
	if (Result.isFailure(accounted)) {
		return Result.fail(accounted.failure)
	}
	const bytes = accounted.success
	if (bytes > session.flightMaxBytes) {
		return Result.fail(
			new InputTooLarge({ bound: { kind: "flight", bytes, limit: session.flightMaxBytes } })
		)
	}
	const answers: Array<Received> = []
	for (let index = 0; index < pipeline.length; index++) {
		answers.push(unanswered)
	}
	const statements = Deferred.makeUnsafe<void>()
	const drained = Deferred.makeUnsafe<void>()
	const cut = Deferred.makeUnsafe<void>()
	session.send(
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
		},
		() => {
			Deferred.doneUnsafe(cut, Effect.void)
		}
	)
	return Result.succeed({ answers, statements, drained, cut })
}

/**
 * Runs `flight` on a session that can still send, uninterruptibly but for what it restores: an ended session fails at
 * once. A flight whose connection ends while it runs leaves its session ended (session.ts SessionState), whatever
 * decided its outcome: a refusal the server gave before the connection ended still decides the failure, and the ended
 * session is never reused.
 */
const onSession = <A, E>(
	session: Session,
	flight: (
		restore: <X, Y, Z>(self: Effect.Effect<X, Y, Z>) => Effect.Effect<X, Y, Z>
	) => Effect.Effect<A, E>
): Effect.Effect<A, E | ConnectionLost> =>
	Effect.suspend((): Effect.Effect<A, E | ConnectionLost> =>
		session.state() === "ended"
			? Effect.fail(new ConnectionLost({ operation: "query", ended: { by: "transport" } }))
			: Effect.uninterruptibleMask(flight)
	)

/**
 * Waits interruptibly for `answered`; an interruption retires the session, abandons the flight (one CancelRequest, then
 * the connection destroyed) and ends the flight with the interruption once it has drained.
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
					Effect.andThen(abandon(session, sent.drained)),
					Effect.andThen(Effect.failCause(waited.cause))
				)
	)

/** What one statement of a flight of statements apart answered: its outcome, or the server's refusal of it. */
export type ApartAnswer = Result.Result<BatchOutcome, ServerError>

/**
 * How a flight of statements apart fails as a whole: the session failed (ConnectionLost, DriverFailure), or a
 * statement answered rows grizzle's SQL cannot deliver, which ran and committed at its own Sync; or, before anything is
 * written, the flight is longer than one write carries (InputTooLarge, send).
 */
export type ApartFailure = ConnectionLost | DriverFailure | UnreadableAnswer | InputTooLarge

/** Statement `index`'s answer in a flight of statements apart: a refusal is its answer; anything else fails the flight. */
const apartAnswer = (
	session: Session,
	index: number,
	answer: Received
): Result.Result<ApartAnswer, ApartFailure> => {
	switch (answer._tag) {
		case "result":
			return Result.succeed(Result.succeed(answer.outcome))
		case "unreadable":
			return Result.fail(new UnreadableAnswer({ index, fate: "committed" }))
		case "refused":
			return answer.error.pipe(Result.fail, Result.succeed)
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
 * for, or an unreadable answer fails the flight, at the first in order. An interruption abandons the flight
 * as every flight's does (runTransaction).
 */
export const runApart = (
	session: Session,
	statements: Arr.NonEmptyReadonlyArray<BatchStatement>
): Effect.Effect<ReadonlyArray<ApartAnswer>, ApartFailure> =>
	onSession(session, (restore) =>
		Effect.gen(function* () {
			const sent = yield* Effect.suspend(() =>
				Effect.fromResult(send(session, queriesOf(planAll(statements)), statements.length - 1))
			)
			yield* execute(session, restore, sent, sent.drained)
			const answers: Array<ApartAnswer> = []
			for (let index = 0; index < statements.length; index++) {
				const answer = apartAnswer(session, index, receivedAt(sent.answers, index))
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

/** Plans a transaction's flight and writes it (see `send`), its statements answered with its last one, or refuses it unwritten. */
const sendPlan = <P, F>(
	session: Session,
	alone: ReadonlyArray<BatchStatement>,
	principal: Principal<P, F>,
	statements: ReadonlyArray<BatchStatement>,
	transaction: Transaction,
	span: Span
): Effect.Effect<{ readonly plan: Plan<P, F>; readonly sent: Sent }, InputTooLarge> =>
	Effect.suspend(() => {
		const plan = planOf(alone, principal, statements, transaction, span)
		return Effect.fromResult(
			Result.map(send(session, plan.pipeline, lastStatement(plan)), (sent) => ({
				plan,
				sent
			}))
		)
	})

/**
 * Sends `statements`, run as `principal`, in one transaction behind its prologue, as one flight, and returns each
 * statement's outcome, in order: the whole transaction, its opening, or its closing, as `span` says. An opening has
 * no end to await: it drains, and leaves the transaction open on the session.
 *
 * COMMIT committed: an unreadable answer is the flight's failure now.
 *
 * The wait is watched for an interruption, which cancels nothing: the wait goes on to COMMIT's answer, the
 * session keeps what that answer decides, and the interruption then takes effect.
 */
const runEntered = <P, F>(
	session: Session,
	principal: Principal<P, F>,
	statements: ReadonlyArray<BatchStatement>,
	transaction: Transaction,
	span: Span
): Effect.Effect<ReadonlyArray<BatchOutcome>, BatchFailure | F | InputTooLarge> =>
	onSession(session, (restore) =>
		Effect.gen(function* () {
			const { plan, sent } = yield* sendPlan(session, [], principal, statements, transaction, span)
			yield* execute(session, restore, sent, sent.statements)
			const early = decide(session, plan, sent, lastStatement(plan) + 1)
			if (Result.isFailure(early) || transaction.end === "ROLLBACK" || !spanCloses(span)) {
				/**
				 * The answers decided a failure, a ROLLBACK frame awaits its end, or an opening has none: the flight
				 * drains, and an interruption meanwhile cancels nothing and takes effect once it has drained.
				 * An early failure is settled already; a ROLLBACK frame and an opening settle once they have drained.
				 */
				const settled = Result.isFailure(early)
					? Effect.fail(early.failure)
					: Effect.suspend(() => Effect.fromResult(flightOutcomes(session, plan, sent)))
				const waited = yield* Effect.exit(restore(Deferred.await(sent.drained)))
				if (Exit.isFailure(waited)) {
					return yield* interruptedDrain(sent, settled, waited.cause)
				}
				return yield* settled
			}
			/** Every statement answered: COMMIT's answer decides, and a refusal fails the flight as CommitRefused. */
			const decided = Effect.suspend(
				(): Effect.Effect<ReadonlyArray<Decided>, BatchFailure | F> => {
					const settled = decide(session, plan, sent, plan.pipeline.length)
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
 * reads every answer in that one round trip (session.ts sends it). One write carries at most the session's
 * flightMaxBytes (core/limits.ts), so a longer flight is refused before any byte of it is written, as InputTooLarge
 * (`send`): it ran nothing, and the session is as it was.
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
 *   back and the ones after it never ran. CommitRefused: a refusal at COMMIT once every statement ran (a deferred constraint, a serialization
 *   failure); nothing committed. CommitLost: the connection failed after COMMIT was written whole and
 *   before it answered, with no statement refused before it, so the transaction may have committed. ConnectionLost:
 *   the session failed with a flight in flight that carried no COMMIT, or one whose write failed before COMMIT left
 *   the process (Sent.cut), or the server ended it (FATAL, PANIC) before COMMIT ran; a refused BEGIN is one too, since
 *   the statements after it ran outside any transaction.
 *   DriverFailure: an answer that does not fit the pipeline, or a query pg would not send. UnreadableAnswer: a statement
 *   answered rows grizzle's SQL cannot deliver; it decides nothing, so a transaction's fate still comes from COMMIT, and
 *   it is the flight's failure only when nothing else decided. A statement alone meets no COMMIT, so it fails as neither
 *   CommitRefused nor CommitLost (`AloneFailure`).
 * - A flight ends when every query has been answered and the ReadyForQuery after the last one has been read, so a
 *   session is never handed on with an answer still to come.
 * - Statements. A served statement runs as its named prepared statement (PreparedStatement): pg sends its Parse,
 *   inside the flight's one write, right before its Bind, only where its connection has not parsed the name yet, and
 *   pg's own record of each connection's names (parsedStatements, set at ParseComplete, and submittedNamedStatements,
 *   dropped with an ErrorResponse to the query that sent its Parse) decides it, so a new or recycled connection parses
 *   each name again on its first use and nothing outlives its connection. A name used twice in one flight is parsed
 *   once; where that Parse is refused, the transaction failed there already (decide reads the first refusal). grizzle
 *   never closes a name: the server keeps every name pg holds parsed. Every other statement (OneShotStatement) runs
 *   as PostgreSQL's unnamed statement, parsed, bound and executed in its own execution.
 * - State. A refused BEGIN, an answer that does not fit and an interruption retire the session, and a lost connection
 *   ends it (session.ts SessionState): either way it is never reused. A refused statement or COMMIT does not, nor does
 *   a transaction's or a lone statement's unreadable answer: the session stays open and idle, unless the connection
 *   ended later in the flight, which ends it whatever decided.
 * - Interruption. A flight interrupted while its statements run sends one CancelRequest, bounded by the connection's
 *   connect timeout, so the backend stops the statement it runs, and then destroys its connection at once: the session
 *   is ended, never reused, and released closed, which counts it out of the pool before its permit admits another
 *   lease. The interruption ends once the flight has drained, which the destroyed connection makes immediate: nothing
 *   waits on the server or the transport. Once every statement of a flight that carries
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
	statements: ReadonlyArray<BatchStatement>,
	transaction: Transaction
): Effect.Effect<ReadonlyArray<BatchOutcome>, BatchFailure | InputTooLarge> =>
	runEntered(session, asLogin, statements, transaction, "whole")

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
 * row's JSON text). An interruption abandons the flight as runTransaction's does (execute). The transaction commits
 * nothing (Uncommitting), so a lost connection that fails the whole flight is never a commit of unknown fate.
 */
export const runAlongside = (
	session: Session,
	alone: ReadonlyArray<BatchStatement>,
	statements: ReadonlyArray<BatchStatement>,
	transaction: Uncommitting
): Effect.Effect<Alongside, ConnectionLost | DriverFailure | InputTooLarge> =>
	onSession(session, (restore) =>
		Effect.gen(function* () {
			const { plan, sent } = yield* sendPlan(
				session,
				alone,
				asLogin,
				statements,
				transaction,
				"whole"
			)
			yield* execute(session, restore, sent, sent.drained)
			const answers: Array<Result.Result<BatchOutcome, ServerError>> = []
			for (let index = 0; index < plan.before.length; index++) {
				const answer = receivedAt(sent.answers, index)
				switch (answer._tag) {
					case "result":
						answers.push(Result.succeed(answer.outcome))
						continue
					case "refused":
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
			const framed = flightOutcomes(session, plan, sent)
			if (
				Result.isFailure(framed) &&
				(framed.failure._tag === "ConnectionLost" || framed.failure._tag === "DriverFailure")
			) {
				return yield* framed.failure
			}
			return { alone: answers, framed }
		})
	)

/** Every read of a Db: read-only and SERIALIZABLE, one snapshot for all its statements, behind the Db's prologue. */
export const readFrame = (prologue: Prologue): Frame => ({
	access: "readOnly",
	isolation: "serializable",
	end: "COMMIT",
	prologue
})

/** A write of a Db at `isolation`, behind its prologue: a change at its role's level, a refresh at SERIALIZABLE. */
export const writeFrame = (prologue: Prologue, isolation: Isolation): Frame => ({
	access: "readWrite",
	isolation,
	end: "COMMIT",
	prologue
})

/**
 * The bytes of the fields of fixed size one Bind message holds, as pg 8.23 writes it (pg-protocol 1.16 serializer.ts
 * `bind`): its Int32 length word, the NUL ending the unnamed portal's empty name and the NUL ending the statement's
 * name, the Int16 count of parameter format codes, the Int16 count of parameters, and the Int16 count of result format
 * codes with its one Int16 code.
 *
 * @formatConstant a Bind message's Int32 length word, the NULs ending its two names, and its Int16 counts and code
 */
const bindFields = {
	length: 4,
	portalEnd: 1,
	nameEnd: 1,
	formats: 2,
	params: 2,
	results: 2,
	result: 2
} as const

/**
 * The bytes of the fields of fixed size a Bind message holds for each parameter, as pg-protocol 1.16's serializer
 * writes them: its Int16 format code and its Int32 length.
 *
 * @formatConstant a Bind message parameter's Int16 format code and Int32 length
 */
const bindParamFields = { format: 2, length: 4 } as const

/**
 * The bytes of a Bind message beside its parameters' texts, as the engine's family planner measures its statements by
 * (write/family/order.ts inForce, BindFrame): `statement`, its fields of fixed size (bindFields) and a served
 * statement's name (core/prepared.ts statementNameBytes), since every statement the planner cuts is one;
 * `parameter`, each parameter's fields of fixed size (bindParamFields). A Bind message bindLength measures is never
 * longer than the frame and its texts.
 */
export const bindFrame: BindFrame = {
	statement:
		bindFields.length +
		bindFields.portalEnd +
		statementNameBytes +
		bindFields.nameEnd +
		bindFields.formats +
		bindFields.params +
		bindFields.results +
		bindFields.result,
	parameter: bindParamFields.format + bindParamFields.length
}

/**
 * The bytes of the name `statement` runs under, as its Parse and Bind carry it: a served statement's, ASCII, and none
 * for PostgreSQL's unnamed statement.
 */
const nameBytes = (statement: BatchStatement): number =>
	statement._tag === "prepared" ? statement.text.name.length : 0

/**
 * The length the Bind message of one execution of `statement` declares, its Int32 length word included and its type
 * byte not, as pg 8.23 writes it (pg-protocol 1.16 serializer.ts `bind`): its fields of fixed size (bindFields), the
 * name of the statement it binds (nameBytes), and each parameter's fields of fixed size (bindParamFields) and bytes: a
 * text's UTF-8 bytes, a binary value's own.
 */
export const bindLength = (statement: BatchStatement): number => {
	let length =
		bindFields.length +
		bindFields.portalEnd +
		nameBytes(statement) +
		bindFields.nameEnd +
		bindFields.formats +
		bindFields.params +
		bindFields.results +
		bindFields.result
	for (const param of statement.params) {
		length +=
			bindParamFields.format +
			bindParamFields.length +
			(typeof param === "string" ? Buffer.byteLength(param, "utf8") : param.byteLength)
	}
	return length
}

/**
 * The bytes of the fields of fixed size of a flight's other messages, as pg 8.23 writes them (pg-protocol 1.16
 * serializer.ts): every message's type byte and Int32 length word; the NUL ending a name or a text; a Parse's Int16
 * count of parameter types, none; the kind byte of a Describe and of a Close; and an Execute's Int32 row limit.
 *
 * @formatConstant a frontend message's type byte, Int32 length word, NUL, Int16 type count, kind byte and Int32 row limit
 */
const messageFields = { type: 1, length: 4, end: 1, typeCount: 2, kind: 1, rowLimit: 4 } as const

/** Every message's type byte and length word. */
const messageHead = messageFields.type + messageFields.length

/** A message holding one NUL-ended text, `text`: a simple Query of it. */
const textMessageBytes = (text: string): number =>
	messageHead + Buffer.byteLength(text, "utf8") + messageFields.end

/** What pg writes after every Bind: the unnamed portal's Describe, its Execute of every row, and a Sync. */
const portalBytes =
	messageHead +
	messageFields.kind +
	messageFields.end +
	(messageHead + messageFields.end + messageFields.rowLimit) +
	messageHead

/** The text a statement's Parse carries. */
const parsedText = (statement: BatchStatement): string =>
	statement._tag === "prepared" ? statement.text.sql : statement.sql

/**
 * The length the Parse of `statement`, with no parameter types, declares: its length word, the name it runs under
 * (nameBytes) and its text each ended by a NUL, and its count of parameter types, its type byte not.
 */
export const parseLength = (statement: BatchStatement): number =>
	messageFields.length +
	nameBytes(statement) +
	messageFields.end +
	Buffer.byteLength(parsedText(statement), "utf8") +
	messageFields.end +
	messageFields.typeCount

/** A statement's Bind, then its Describe, Execute and Sync. */
const executionBytes = (statement: BatchStatement): number =>
	messageFields.type + bindLength(statement) + portalBytes

/**
 * The bytes of a flight as pg writes it in its one corked write (session.ts send), or its refusal: every query of
 * `pipeline`, a control's simple Query, or a statement's Parse, then its Bind, Describe, Execute and Sync. A Parse longer than `messageLimit`, the longest message the session's server reads, as its length word counts
 * it, is refused as InputTooLarge (parse): PostgreSQL ends the connection at it instead of answering, so the bound is
 * on the message, its statement's text with its name and fields, never on the text alone. A served statement's Parse
 * is counted at the first statement of the flight under its name, where pg sends it on a new connection: the count is
 * the flight's bytes on a new connection, the most it writes on any, since a connection that parsed the name already
 * sends none, so whether a flight is refused never depends on the connection it was given.
 */
const accountFlight = (
	pipeline: ReadonlyArray<WireQuery>,
	messageLimit: number,
	controls: ControlTexts
): Result.Result<number, InputTooLarge> => {
	let bytes = 0
	const named = new Set<StatementName>()
	for (const query of pipeline) {
		if (query._tag === "control") {
			bytes += textMessageBytes(controlText(controls, query.control))
			continue
		}
		bytes += executionBytes(query)
		if (query._tag === "prepared") {
			if (named.has(query.text.name)) {
				continue
			}
			named.add(query.text.name)
		}
		const parse = parseLength(query)
		if (parse > messageLimit) {
			return Result.fail(
				new InputTooLarge({ bound: { kind: "parse", bytes: parse, limit: messageLimit } })
			)
		}
		bytes += messageFields.type + parse
	}
	return Result.succeed(bytes)
}

/**
 * The first of `statements` whose Bind message would be longer than `limit`, the longest message the session's server
 * reads (Session.messageMaxBytes), as the InputTooLarge of its position and length, or none.
 * PostgreSQL answers a longer message by ending the connection without an ErrorResponse ("invalid message length",
 * pqcomm.c pq_getmessage), which a flight carrying COMMIT would report as CommitLost though nothing ran; so it is
 * refused here, before anything is sent. The prologue's statements and the controls carry no parameter of the caller's.
 */
export const bindOverrun = (
	statements: ReadonlyArray<BatchStatement>,
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
	statements: ReadonlyArray<BatchStatement>
): Effect.Effect<ReadonlyArray<BatchOutcome>, FlightFailure> =>
	Effect.suspend((): Effect.Effect<ReadonlyArray<BatchOutcome>, FlightFailure> => {
		const overrun = bindOverrun(statements, session.messageMaxBytes)
		return overrun === undefined
			? runEntered(session, asDb(frame.prologue), statements, frame, "whole")
			: Effect.fail(overrun)
	})

/**
 * A failure of a call's second flight as the call counts its statements: each statement's index past the first
 * flight's `by` statements, so one index space spans both (runFramedTwice).
 */
const shifted = (failure: FlightFailure, by: number): FlightFailure => {
	switch (failure._tag) {
		case "BatchRefused":
			return new BatchRefused({ index: failure.index + by, failure: failure.failure })
		case "UnreadableAnswer":
			return new UnreadableAnswer({ index: failure.index + by, fate: failure.fate })
		case "InputTooLarge":
			return failure.bound.kind === "message"
				? new InputTooLarge({
						bound: { ...failure.bound, statement: failure.bound.statement + by }
					})
				: failure
		case "CommitRefused":
		case "CommitLost":
		case "ConnectionLost":
		case "DriverFailure":
		case "PrologueRefused":
		case "StaleSnapshot":
			return failure
	}
}

/**
 * Whether a transaction flight failed with its refusal before any byte of it was written (send), so it ran nothing and
 * an opening opened no transaction: the one InputTooLarge a flight meets once its statements' Binds were admitted.
 */
const unwritten = (failure: FlightFailure): boolean => failure._tag === "InputTooLarge"

/** `transaction` ended by ROLLBACK: the same access and level. */
const rolledBack = (transaction: Transaction): Transaction =>
	transaction.access === "readOnly"
		? { access: "readOnly", isolation: "serializable", end: "ROLLBACK" }
		: { access: "readWrite", isolation: transaction.isolation, end: "ROLLBACK" }

/**
 * Ends the transaction an opening left open on `session`, for a call that will not close it: a flight of ROLLBACK
 * alone. A session already retired or ended needs none, since its connection, and the transaction with it, ends when
 * it is released; a ROLLBACK that fails retires it the same way. It never fails.
 */
const rollbackOpening = (session: Session, frame: Frame): Effect.Effect<void> =>
	session.state() === "open"
		? Effect.catch(
				Effect.asVoid(runEntered(session, asLogin, [], rolledBack(frame), "closing")),
				() =>
					Effect.sync(() => {
						session.retire()
					})
			)
		: Effect.void

/**
 * A Db call's two flights in one transaction of `frame`: `first` behind BEGIN and the prologue, then the statements
 * `second` makes from `first`'s outcomes, and the frame's end. A write whose plan reads before it writes runs so: the
 * reads and the writes see one snapshot, and under SERIALIZABLE a concurrent writer of what the reads read meets
 * 40001 at a statement or at COMMIT, which the call reports and never retries.
 *
 * The outcomes are both flights', `first`'s then `second`'s, and a failure counts statements across both: a statement
 * of the second flight is numbered after every statement of the first (`shifted`), as the call sent them. Whatever
 * ends the call between the flights ends the transaction: `second`'s failure, a Bind message of its statements
 * PostgreSQL would not read, and a second flight longer than one write carries, refused unwritten (send), roll it back
 * (rollbackOpening) and fail the call with it; an interruption retires the session, so the transaction ends with its
 * connection. A failed first flight rolls back the same way, unless it was refused unwritten and opened nothing, and the
 * second flight's other failures are runFramed's.
 */
export const runFramedTwice = <E>(
	session: Session,
	frame: Frame,
	first: ReadonlyArray<BatchStatement>,
	second: (outcomes: ReadonlyArray<BatchOutcome>) => Effect.Effect<ReadonlyArray<BatchStatement>, E>
): Effect.Effect<ReadonlyArray<BatchOutcome>, FlightFailure | E> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const overrun = bindOverrun(first, session.messageMaxBytes)
			if (overrun !== undefined) {
				return yield* overrun
			}
			const read = yield* Effect.exit(
				restore(runEntered(session, asDb(frame.prologue), first, frame, "opening"))
			)
			if (Exit.isFailure(read)) {
				if (!Option.exists(Cause.findErrorOption(read.cause), unwritten)) {
					yield* rollbackOpening(session, frame)
				}
				return yield* Effect.failCause(read.cause)
			}
			const made = yield* Effect.exit(restore(second(read.value)))
			if (Exit.isFailure(made)) {
				if (Cause.hasInterrupts(made.cause)) {
					session.retire()
				} else {
					yield* rollbackOpening(session, frame)
				}
				return yield* Effect.failCause(made.cause)
			}
			const statements = made.value
			const tooLarge = bindOverrun(statements, session.messageMaxBytes)
			if (tooLarge !== undefined) {
				yield* rollbackOpening(session, frame)
				return yield* shifted(tooLarge, first.length)
			}
			const written = yield* Effect.mapError(
				restore(runEntered(session, asDb(frame.prologue), statements, frame, "closing")).pipe(
					Effect.tapError((failure) =>
						unwritten(failure) ? rollbackOpening(session, frame) : Effect.void
					)
				),
				(failure) => shifted(failure, first.length)
			)
			return [...read.value, ...written]
		})
	)

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
	readonly statements: ReadonlyArray<BatchStatement>
	readonly read: (outcomes: ReadonlyArray<BatchOutcome>) => Effect.Effect<A, E>
}

/**
 * The flights of `parts` as one: their statements in part order, each part reading its own statements' outcomes. A
 * part's UnreadableAnswer names a statement by its index among the part's own, so it is moved to the index of that
 * statement among the joined flight's.
 */
export const joinFlights = <A>(
	parts: ReadonlyArray<Flight<A, UnreadableAnswer>>
): Flight<ReadonlyArray<A>, UnreadableAnswer> => {
	const statements: Array<BatchStatement> = []
	const spans: Array<{ readonly part: Flight<A, UnreadableAnswer>; readonly from: number }> = []
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
				Effect.mapError(
					part.read(outcomes.slice(from, from + part.statements.length)),
					(unreadable) =>
						new UnreadableAnswer({ index: from + unreadable.index, fate: unreadable.fate })
				)
			)
	}
}
