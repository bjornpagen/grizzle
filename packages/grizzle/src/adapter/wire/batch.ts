/**
 * Flights, a hot path: every statement of every Db call is planned, written and answered here, so the per-statement
 * work is native loops with no Option, tuple or closure per statement, and Effect stays at the flight's boundary.
 */
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
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
import {
	defect,
	type ExplainText,
	type Prepared,
	sqlstates,
	type StatementName,
	statementNameBytes,
	textParam,
	type WriteText
} from "#compiler/plan/runtime.ts"

import {
	serializationRefusal,
	type ReadError,
	ReadFailure,
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
	type TxControl,
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
 * SQL grizzle sends: printed from an AST by the engine (sql/emit.ts), a single statement's assembled of the units the
 * engine printed (runtime/write/parted.ts), a statement's EXPLAIN (runtime/explain.ts), or a reviewed migration file's
 * own statement. Hand-written SQL is no SentText, so it never reaches the wire.
 */
export type SentText = WriteText | ExplainText | MigrationText

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
	readonly text: Prepared<WriteText>
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

/** The intake of a statement each of whose rows `take` takes as it arrives. */
export const takenRows = (take: (row: OutputRows[number]) => void): RowIntake => ({
	kind: "taken",
	take
})

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
	text: Prepared<WriteText>,
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
 * The transaction a flight runs its statements in: whether it writes, how it begins, and how it ends. A read-only
 * transaction is SERIALIZABLE READ ONLY and runs one statement (FramedStatements): it reads at once, tracked by SSI
 * while a SERIALIZABLE writer runs on the cluster. A read-write one begins at its role's level.
 */
export type Transaction =
	| {
			readonly access: "readOnly"
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
	| { readonly access: "readOnly"; readonly end: Transaction["end"] }
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

/**
 * What a Db transaction locks between its prologue's fence and the statement that takes its snapshot, as the login:
 * nothing, or a fenced write's LOCK TABLE ... IN EXCLUSIVE MODE of the relations its login fences that it writes, its
 * text named where generate served it (engine runtime/write/flight.ts WriteExclusion). A LOCK takes no snapshot, so its
 * transaction's snapshot follows the lock.
 */
export type Exclusion =
	| { readonly kind: "none" }
	| { readonly kind: "lock"; readonly statement: PreparedStatement }

/** A transaction that locks nothing before its snapshot: every read's, and an unfenced write's. */
export const excludesNothing: Exclusion = { kind: "none" }

/** A Db's transaction: framed as a transaction is, and begun by the Db's prologue (see the header). */
export type Frame = Transaction & { readonly prologue: Prologue; readonly exclusion: Exclusion }

/** A Db's read frame (readFrame): READ ONLY, its flight one statement (FramedStatements). */
export type ReadFrame = Extract<Frame, { readonly access: "readOnly" }>

/**
 * The statements a flight in a frame of kind `F` sends: exactly one in a read frame (engine served/read.ts
 * ServedProgram: a read sends one statement), and any number in a write's.
 */
export type FramedStatements<F extends Frame> = F extends ReadFrame
	? readonly [BatchStatement]
	: ReadonlyArray<BatchStatement>

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

/** The prologue's steps: the ledger's lock NOWAIT, a fenced write's lock (Exclusion), and the guard's call. */
export type FenceStep = "lock" | "exclude" | "guard"

/**
 * Why the fence refused, from the server's refusal of its `step`, or none for any other refusal: the lock refused at once
 * (55P03) while a migration holds or awaits it; the guard's 55Z02, a folder unfinished, and 55Z01, another latest
 * target. The one reading of a fence's refusal: every Db transaction's (failureAt) and admission's.
 */
export const fenceReason = (step: FenceStep, failure: ServerError): Option.Option<StaleReason> => {
	switch (step) {
		case "exclude":
			return Option.none()
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

/** The BEGIN control of `transaction`: a read's, or a write's at its level. */
const beginOf = (transaction: Transaction): TxControl =>
	transaction.access === "readOnly"
		? { kind: "begin", access: "readOnly" }
		: { kind: "begin", access: "readWrite", isolation: transaction.isolation }

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
 * A Db's role, entered by its prologue's two statements, both run as the login, the fence's lock and the statement
 * that calls the guard and enters the role, with the frame's exclusion, a fenced write's lock, between them, run as the
 * login too, before the snapshot. A refusal the fence explains (fenceReason) is StaleSnapshot, any other
 * PrologueRefused.
 */
const asDb = (frame: Frame): Principal<FenceStep, PrologueRefused | StaleSnapshot> => ({
	prologue: [
		{ statement: frame.prologue.fence, step: "lock" },
		...exclusionSteps(frame.exclusion),
		{ statement: frame.prologue.enter, step: "guard" }
	],
	refused: (step, failure) =>
		Option.getOrElse(
			Option.map(
				fenceReason(step, failure),
				(reason): PrologueRefused | StaleSnapshot =>
					new StaleSnapshot({ reason, snapshot: frame.prologue.snapshot, error: failure })
			),
			() => new PrologueRefused({ failure })
		)
})

/** The prologue step an exclusion sends: its lock, none for an exclusion of nothing. */
const exclusionSteps = (
	exclusion: Exclusion
): ReadonlyArray<{ readonly statement: BatchStatement; readonly step: FenceStep }> =>
	exclusion.kind === "lock" ? [{ statement: exclusion.statement, step: "exclude" }] : []

/**
 * What of its transaction a flight carries: all of it, from BEGIN to its end (`whole`), every Db call's and every
 * migration file's; or one of several flights of one transaction (runAlongside, runFramedFlights): BEGIN and its first
 * statements, the transaction left open (`opening`), statements alone with the transaction left open before and after
 * them (`middle`), then its last statements and its end (`closing`).
 */
type Carried = "whole" | "opening" | "middle" | "closing"

/** Whether a flight carrying `carried` begins its transaction: BEGIN and the prologue lead it. */
const begins = (carried: Carried): boolean => carried === "whole" || carried === "opening"

/** Whether a flight carrying `carried` ends its transaction: the end closes it. */
const ends = (carried: Carried): boolean => carried === "whole" || carried === "closing"

/**
 * A transaction's flight as planned: the statements alone in front of it (runAlongside) at the first pipeline
 * positions, then, as far as it carries them (Carried), BEGIN and the prologue of its principal (none for the login),
 * its statements and its end, each a position of `steps`.
 */
interface Plan<P, F> {
	readonly pipeline: ReadonlyArray<WireQuery>
	readonly before: ReadonlyArray<Planned>
	readonly prologue: ReadonlyArray<Planned>
	readonly statements: ReadonlyArray<PlannedStatement>
	readonly steps: ReadonlyArray<Position<P>>
	readonly refused: Principal<P, F>["refused"]
	readonly transaction: Transaction
	readonly carried: Carried
}

const planOf = <P, F>(
	alone: ReadonlyArray<BatchStatement>,
	principal: Principal<P, F>,
	statements: ReadonlyArray<BatchStatement>,
	transaction: Transaction,
	carried: Carried
): Plan<P, F> => {
	const before = planAll(alone)
	const pipeline = queriesOf(before)
	const steps: Array<Position<P>> = []
	const prologue: Array<Planned> = []
	const framed: Array<PlannedStatement> = []
	if (begins(carried)) {
		steps.push(beginStep)
		pipeline.push({
			_tag: "control",
			control: beginOf(transaction)
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
	if (ends(carried)) {
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
		carried
	}
}

/**
 * The pipeline position of a transaction's first statement of a flight: behind the statements alone, BEGIN and the
 * prologue where the flight carries them.
 */
const offsetOf = <P, F>(plan: Plan<P, F>): number =>
	plan.before.length + (begins(plan.carried) ? 1 + plan.prologue.length : 0)

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
	/** A flight that opens a transaction carries no end, so nothing of it commits. */
	const commits = plan.transaction.end === "COMMIT" && ends(plan.carried)
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
				return index === plan.before.length && begins(plan.carried) ? "noTransaction" : "aborted"
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
 * Where an abandoned flight stands (abandon). Each state says what the server may still run, and every move is the
 * server's own answer, never a clock's:
 *
 * - `draining`: nothing of the flight runs on the server any more, or nothing more can be done to stop it. It drained,
 *   every query answered and the ReadyForQuery after the last one read, or its connection ended, which fails every
 *   query still in flight. Nothing is sent; the drain is awaited.
 * - `cancelling`: the server may still run a query of the flight. A round sends one CancelRequest (Session.cancel) and,
 *   once it was sent, waits for the server to answer a query of the flight past the `answered` that had answered when
 *   the round began, which starts the next round: the server ignores a request that reaches the backend while it reads
 *   a command (REL_19_0 src/backend/tcop/postgres.c 3536-3546, `if (!DoingCommandRead)`, and 4813-4823, which drops a
 *   cancel that arrived while it was idle), a statement not read yet among them, and an answer is the moment the
 *   backend has moved on to the next one. The flight's drain ends a round wherever it is.
 * - `severed`: a round's request never reached the server (CancelEnd `unreached`): the operating system or the
 *   server's TLS reports the server unreachable, so no request can stop the flight. The connection is destroyed, and
 *   what the server ran of the flight is unknown.
 *
 * A request the backend ignored while reading a command leaves the statement it then reads to run to its own end:
 * that statement's answer starts the next round, which stops the one after it.
 */
type Abandoning =
	| { readonly _tag: "draining" }
	| { readonly _tag: "cancelling"; readonly answered: number }
	| { readonly _tag: "severed" }

/**
 * How a round of `cancelling` ended: the flight drained; its CancelRequest never reached the server; or the request was
 * sent and the server has answered another query of the flight since the round began.
 */
type RoundEnd =
	| { readonly _tag: "drained" }
	| { readonly _tag: "unreached" }
	| { readonly _tag: "answered" }

const draining: Abandoning = { _tag: "draining" }

const severed: Abandoning = { _tag: "severed" }

const drainedRound: RoundEnd = { _tag: "drained" }

const unreachedRound: RoundEnd = { _tag: "unreached" }

const answeredRound: RoundEnd = { _tag: "answered" }

/** How many queries of a flight have answered so far, by its answers as they arrive. */
const answeredIn = (sent: Sent): number => {
	let answered = 0
	for (const answer of sent.answers) {
		if (answer._tag !== "unanswered") {
			answered += 1
		}
	}
	return answered
}

/** Waits until more than `answered` queries of the flight have answered: at once if they have, else at the next answer. */
const answeredPast = (sent: Sent, answered: number): Effect.Effect<void> =>
	Effect.suspend(() =>
		answeredIn(sent) > answered
			? Effect.void
			: Effect.flatMap(Deferred.await(sent.answer()), () => answeredPast(sent, answered))
	)

/**
 * One round: a CancelRequest for the statement the backend runs (Session.cancel), then, once it was sent, the wait for
 * the server's next answer past `answered`, the whole raced by the flight's drain, which ends the round whenever it
 * comes.
 */
const round = (session: Session, sent: Sent, answered: number): Effect.Effect<RoundEnd> =>
	Effect.raceFirst(
		Effect.as(Deferred.await(sent.drained), drainedRound),
		Effect.flatMap(session.cancel, (end): Effect.Effect<RoundEnd> => {
			switch (end) {
				case "sent":
					return Effect.as(answeredPast(sent, answered), answeredRound)
				case "unreached":
					return Effect.succeed(unreachedRound)
			}
		})
	)

/** The state after a round: drained; the next round, past every answer so far; or severed, the server unreachable. */
const afterRound = (sent: Sent, end: RoundEnd): Abandoning => {
	switch (end._tag) {
		case "drained":
			return draining
		case "answered":
			return { _tag: "cancelling", answered: answeredIn(sent) }
		case "unreached":
			return severed
	}
}

/**
 * An interrupted flight's end (execute), run from where it stands (Abandoning) until it drained or was severed: a
 * flight that drained already, or whose session ended, sends nothing; any other is cancelled round after round until
 * the server has ended it, so the interruption ends only once the server runs nothing of the flight, or once a
 * CancelRequest could not reach the server, when the connection is destroyed, which fails every query still in flight.
 * No clock bounds it: it waits for the server's own answers, or for the operating system's report that the server
 * cannot be reached, and a caller that answers by a deadline states it on its own call.
 */
const abandon = (session: Session, sent: Sent): Effect.Effect<void> => {
	const from = (state: Abandoning): Effect.Effect<void> => {
		switch (state._tag) {
			case "draining":
				return Deferred.await(sent.drained)
			case "cancelling":
				return Effect.flatMap(round(session, sent, state.answered), (end) =>
					from(afterRound(sent, end))
				)
			case "severed":
				return Effect.sync(() => {
					session.destroy()
				}).pipe(Effect.andThen(Deferred.await(sent.drained)))
		}
	}
	return Effect.suspend(() =>
		from(
			Deferred.isDoneUnsafe(sent.drained) || session.state() === "ended"
				? draining
				: { _tag: "cancelling", answered: answeredIn(sent) }
		)
	)
}

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
	/**
	 * Resolves at the flight's next answer: each answer resolves the one it finds and puts a fresh one in its place, so
	 * a wait taken now ends at the first answer after it (abandon's rounds).
	 */
	readonly answer: () => Deferred.Deferred<void>
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
	let next = Deferred.makeUnsafe<void>()
	session.send(
		pipeline,
		(index, answer) => {
			answers[index] = answer
			if (index === awaited) {
				Deferred.doneUnsafe(statements, Effect.void)
			}
			const reached = next
			next = Deferred.makeUnsafe<void>()
			Deferred.doneUnsafe(reached, Effect.void)
		},
		() => {
			Deferred.doneUnsafe(statements, Effect.void)
			Deferred.doneUnsafe(drained, Effect.void)
		},
		() => {
			Deferred.doneUnsafe(cut, Effect.void)
		}
	)
	return Result.succeed({ answers, statements, drained, cut, answer: () => next })
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
 * Waits interruptibly for `answered`; an interruption retires the session, abandons the flight (abandon) and ends the
 * flight with the interruption once abandon has.
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
					Effect.andThen(abandon(session, sent)),
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
 * as every flight's does (runTransaction): a CancelRequest stops only the statement running when it arrives, so the
 * statements after it run on, each stopped in turn by a later round's.
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
	carried: Carried
): Effect.Effect<{ readonly plan: Plan<P, F>; readonly sent: Sent }, InputTooLarge> =>
	Effect.suspend(() => {
		const plan = planOf(alone, principal, statements, transaction, carried)
		return Effect.fromResult(
			Result.map(send(session, plan.pipeline, lastStatement(plan)), (sent) => ({
				plan,
				sent
			}))
		)
	})

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
	statements: ReadonlyArray<BatchStatement>,
	transaction: Transaction
): Effect.Effect<ReadonlyArray<BatchOutcome>, BatchFailure | F | InputTooLarge> =>
	onSession(session, (restore) =>
		Effect.gen(function* () {
			const { plan, sent } = yield* sendPlan(
				session,
				[],
				principal,
				statements,
				transaction,
				"whole"
			)
			yield* execute(session, restore, sent, sent.statements)
			const early = decide(session, plan, sent, lastStatement(plan) + 1)
			if (Result.isFailure(early) || transaction.end === "ROLLBACK") {
				/**
				 * The answers decided a failure, or a ROLLBACK frame awaits its end: the flight drains, and an
				 * interruption meanwhile cancels nothing and takes effect once it has drained. An early failure is
				 * settled already; a ROLLBACK frame settles once it has drained.
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
 * flightMaxBytes, so a longer flight is refused before any byte of it is written, as InputTooLarge
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
 * - Interruption. A flight interrupted while its statements run is abandoned (abandon): it sends a CancelRequest, and
 *   waits on its own connection for the flight to drain, the stopped statement's 57014 and every answer after it;
 *   each time the server answers another query of the flight while it has not drained, it sends another, since the
 *   server ignores a CancelRequest that reaches the backend before it has read the statement. So the interruption ends
 *   only once the server has stopped the statement and runs nothing of the flight: its locks and its snapshot are
 *   released, and a COMMIT it sent has committed or not. The session is retired, never reused, and released closed,
 *   which counts it out of the pool before its permit admits another lease. No clock paces or ends it: a request the
 *   backend ignored leaves the statement it then reads to run to its own end, whose answer sends the next request.
 *   Only a connection whose CancelRequest could not reach the server, refused, timed out or reset as the operating
 *   system reports it, is destroyed, and what the server runs of the flight then is unknown. Once every statement of a
 *   flight that carries COMMIT has answered, the wait for COMMIT's answer cancels nothing and retires nothing: an
 *   interruption that arrives meanwhile takes effect once COMMIT has answered or the connection is known lost, which pg
 *   reports as the connection's error or close, so the wait ends however the server behaves. The drain after a failure the
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
	runEntered(session, asLogin, statements, transaction)

/**
 * What a transaction behind statements alone returned, over its two flights (runAlongside): each statement alone's
 * outcome or the server's refusal of it, and what the transaction's first flight met: its failure, or its outcomes, one
 * per statement in order, with what `then` made of them (Continued).
 */
export interface Alongside<A, E> {
	readonly alone: ReadonlyArray<ApartAnswer>
	readonly framed: Result.Result<Continued<A, E>, BatchFailure>
}

/**
 * A transaction's first flight's outcomes, and what `then` made of them (runAlongside): its refusal of them, `E`, after
 * which the second flight carried the end alone; or the value it made beside the second flight's statements, with the
 * second flight's outcomes or its failure, its statements numbered from its first, as its own.
 */
export interface Continued<A, E> {
	readonly first: ReadonlyArray<BatchOutcome>
	readonly made: Result.Result<
		{
			readonly value: A
			readonly second: Result.Result<ReadonlyArray<BatchOutcome>, BatchFailure>
		},
		E
	>
}

/** What `then` makes of a transaction's first flight's answers (runAlongside): its second flight's statements, and a
 * value its caller reads beside the transaction's outcomes. */
export interface SecondFlight<A> {
	readonly statements: ReadonlyArray<BatchStatement>
	readonly value: A
}

/** How a call of runAlongside fails whole: its session failed, or its second flight is longer than one write carries. */
type AlongsideFailure = ConnectionLost | DriverFailure | InputTooLarge

/**
 * What a transaction's first flight decided once it drained (runAlongside), and so what its second flight is for, the
 * two flights' answers read in pipeline order:
 *
 * - `decided`: the call's answer, `answer`, was settled before the second flight, by the first flight's interruption, a
 *   lost connection or an answer the pipeline cannot account for, a statement's refusal, `then`'s refusal of the
 *   outcomes, or a second flight longer than one write carries. The second flight carries the end alone, its drain
 *   cancelling nothing and its answer read by no one, since what came first decided.
 * - `unreadable`: a statement answered rows grizzle's SQL cannot deliver, which decided nothing: the second flight
 *   carries the end alone, whose answer decides, its failure first, then the transaction's fate.
 * - `continued`: the second flight carries the statements `then` made of the first's outcomes, and the end, and the
 *   call reads their outcomes, or its failure.
 */
type Next<A, E> =
	| {
			readonly kind: "decided"
			readonly answer: Effect.Effect<Alongside<A, E>, AlongsideFailure>
	  }
	| {
			readonly kind: "unreadable"
			readonly alone: ReadonlyArray<ApartAnswer>
			readonly failure: UnreadableAnswer
	  }
	| {
			readonly kind: "continued"
			readonly alone: ReadonlyArray<ApartAnswer>
			readonly outcomes: ReadonlyArray<BatchOutcome>
			readonly second: SecondFlight<A>
	  }

/** A call whose answer its first flight settled (Next `decided`). */
const decided = <A, E>(answer: Effect.Effect<Alongside<A, E>, AlongsideFailure>): Next<A, E> => ({
	kind: "decided",
	answer
})

/** What the first flight, `opening`, decided, from how it ran and every answer it got (Next). */
const nextOf = <A, E>(
	session: Session,
	opening: { readonly plan: Plan<never, never>; readonly sent: Sent },
	ran: Exit.Exit<void>,
	then: (
		alone: ReadonlyArray<ApartAnswer>,
		first: ReadonlyArray<BatchOutcome>
	) => Result.Result<SecondFlight<A>, E>
): Next<A, E> => {
	if (Exit.isFailure(ran)) {
		return ran.cause.pipe(Effect.failCause, decided<A, E>)
	}
	/** An answer alone grizzle cannot read: its failure read once the end has drained, whose lost connection it names. */
	const unreadableAlone = Effect.failSync(() => broken(session))
	const alone: Array<ApartAnswer> = []
	for (let index = 0; index < opening.plan.before.length; index++) {
		const answer = receivedAt(opening.sent.answers, index)
		switch (answer._tag) {
			case "result":
				alone.push(Result.succeed(answer.outcome))
				continue
			case "refused":
				alone.push(Result.fail(answer.error))
				continue
			case "unreadable":
				return decided(unreadableAlone)
			case "terminated":
			case "failed":
			case "unanswered":
				return lost(session, answer).pipe(Effect.fail, decided<A, E>)
		}
	}
	const opened = flightOutcomes(session, opening.plan, opening.sent)
	if (Result.isFailure(opened)) {
		const failure = opened.failure
		switch (failure._tag) {
			case "ConnectionLost":
			case "DriverFailure":
				return failure.pipe(Effect.fail, decided<A, E>)
			case "UnreadableAnswer":
				return { kind: "unreadable", alone, failure }
			case "BatchRefused":
			case "CommitRefused":
			case "CommitLost":
				return decided(Effect.succeed({ alone, framed: Result.fail(failure) }))
		}
	}
	const outcomes = opened.success
	const made = then(alone, outcomes)
	return Result.isSuccess(made)
		? { kind: "continued", alone, outcomes, second: made.success }
		: decided(
				Effect.succeed({
					alone,
					framed: Result.succeed({ first: outcomes, made: Result.fail(made.failure) })
				})
			)
}

/**
 * Sends `alone`, each statement as its own implicit transaction, then BEGIN of `transaction` and `first`, as one flight;
 * then, in that transaction, the statements `then` makes of both parts' answers, and the transaction's end, as a second
 * flight; and returns the answers of all of them (Alongside), read in pipeline order (Next): a first flight that decided
 * the call, or whose answers `then` refused, sends the end alone, its wait cancelling nothing, and a refusal it met
 * stands whatever the end meets, as runTransaction's drain after a failure its answers decided. The second flight is sent wherever the transaction stands open, BEGIN having run and the
 * connection standing, so the transaction ends in every case; where it does not, the server holds no transaction of the
 * session, and an ended session sends nothing (onSession). A second flight longer than one write carries ends the
 * transaction alone, then fails as InputTooLarge. `then` runs on the host between the flights, uninterruptibly, so the
 * transaction is open only while a flight is in flight, whose interruption abandons it as every flight's (execute): the
 * session is retired, and its connection's close ends the transaction. A lost connection or an answer the pipeline
 * cannot account for that decides fails the whole call, as runTransaction's would; so does an unreadable answer of a
 * statement alone here, since the statements alone sent through it read only texts: the ledger's and the proofs' reads
 * (a count, and each row's texts). The transaction commits nothing (Uncommitting), so a lost connection that fails the
 * whole call is never a commit of unknown fate.
 */
export const runAlongside = <A, E>(
	session: Session,
	alone: ReadonlyArray<BatchStatement>,
	first: ReadonlyArray<BatchStatement>,
	then: (
		alone: ReadonlyArray<ApartAnswer>,
		first: ReadonlyArray<BatchOutcome>
	) => Result.Result<SecondFlight<A>, E>,
	transaction: Uncommitting
): Effect.Effect<Alongside<A, E>, AlongsideFailure> =>
	onSession(session, (restore) =>
		Effect.gen(function* () {
			const opening = yield* sendPlan(session, alone, asLogin, first, transaction, "opening")
			/** The first flight's run: an abandoned one has drained, and its interruption takes effect once its end has. */
			const ran = yield* Effect.exit(execute(session, restore, opening.sent, opening.sent.drained))
			const next = nextOf(session, opening, ran, then)
			/** The second flight, `statements` and the end, written unless the session has ended (onSession). */
			const closing = (statements: ReadonlyArray<BatchStatement>) =>
				onSession(session, () => sendPlan(session, [], asLogin, statements, transaction, "closing"))
			/**
			 * A decided call's end, then its answer: the end alone where BEGIN ran, drained, its wait cancelling nothing, so
			 * the server holds no transaction of the session; none where the session has ended, whose connection's end ended
			 * the transaction. The end alone is shorter than the BEGIN the first flight carried, so it fits one write
			 * wherever that flight did.
			 */
			const ended = <X, Y>(answer: Effect.Effect<X, Y>): Effect.Effect<X, Y> =>
				Effect.gen(function* () {
					const begun = receivedAt(opening.sent.answers, opening.plan.before.length)
					if (begun._tag === "result" || begun._tag === "unreadable") {
						const ending = yield* Effect.result(closing([]))
						if (Result.isSuccess(ending)) {
							yield* Deferred.await(ending.success.sent.drained)
						}
					}
					return yield* answer
				})
			if (next.kind === "decided") {
				return yield* ended(next.answer)
			}
			const { plan, sent } = yield* Effect.catchTag(
				closing(next.kind === "continued" ? next.second.statements : []),
				"InputTooLarge",
				(tooLarge) => tooLarge.pipe(Effect.fail, ended)
			)
			yield* execute(session, restore, sent, sent.drained)
			const closed = flightOutcomes(session, plan, sent)
			if (
				Result.isFailure(closed) &&
				(closed.failure._tag === "ConnectionLost" || closed.failure._tag === "DriverFailure")
			) {
				return yield* closed.failure
			}
			switch (next.kind) {
				case "unreadable":
					return {
						alone: next.alone,
						framed: Result.fail(
							Result.isFailure(closed)
								? closed.failure
								: new UnreadableAnswer({
										index: next.failure.index,
										fate: transactionFate(plan, sent.answers)
									})
						)
					}
				case "continued":
					return {
						alone: next.alone,
						framed: Result.succeed({
							first: next.outcomes,
							made: Result.succeed({ value: next.second.value, second: closed })
						})
					}
			}
		})
	)

/**
 * A read of a Db: SERIALIZABLE READ ONLY, behind the Db's prologue, its one statement (FramedStatements).
 */
export const readFrame = (prologue: Prologue): ReadFrame => ({
	access: "readOnly",
	end: "COMMIT",
	prologue,
	exclusion: excludesNothing
})

/**
 * A write of a Db at `isolation`, behind its prologue and `exclusion`: a change at its role's level, locking what its
 * login fences of what it writes.
 */
export const writeFrame = (
	prologue: Prologue,
	isolation: Isolation,
	exclusion: Exclusion
): Frame => ({
	access: "readWrite",
	isolation,
	end: "COMMIT",
	prologue,
	exclusion
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
 * The bytes of a Bind message beside its parameters' texts, as the engine measures the statements it cuts by
 * (runtime/write/transport.ts inForce, BindFrame): `statement`, its fields of fixed size (bindFields) and a served
 * statement's name (core/prepared.ts statementNameBytes), since every statement it cuts is one;
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
			(typeof param === "string" ? utf8Length(param) : param.byteLength)
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
	messageHead + utf8Length(text) + messageFields.end

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
const parseLength = (statement: BatchStatement): number =>
	messageFields.length +
	nameBytes(statement) +
	messageFields.end +
	utf8Length(parsedText(statement)) +
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
 * StaleSnapshot whatever the call carries, and its outcome is released only once the end answered. A read sends one
 * statement (FramedStatements) and still runs framed: the prologue and its statement share one transaction, outside
 * which the prologue's settings would not hold. A statement whose Bind message PostgreSQL would not read fails the call with InputTooLarge
 * before anything is sent (bindOverrun).
 */
export const runFramed = <F extends Frame>(
	session: Session,
	frame: F,
	statements: FramedStatements<F>
): Effect.Effect<ReadonlyArray<BatchOutcome>, FlightFailure> =>
	Effect.suspend((): Effect.Effect<ReadonlyArray<BatchOutcome>, FlightFailure> => {
		const overrun = bindOverrun(statements, session.messageMaxBytes)
		return overrun === undefined
			? runEntered(session, asDb(frame), statements, frame)
			: Effect.fail(overrun)
	})

/**
 * What a Db transaction sent as several flights answered (runFramedFlights): every flight ran and its end committed,
 * with the closing flight's statements' outcomes; or the flight that failed, by the batch it carried (`at`, none for
 * the opening's prologue or the closing flight's own statements and end), with its failure, its statements numbered
 * from that flight's first.
 */
export type FlightsAnswer<A> =
	| { readonly kind: "committed"; readonly closing: ReadonlyArray<BatchOutcome> }
	| { readonly kind: "failed"; readonly at: A | undefined; readonly failure: FlightFailure }

/** A batch of a Db transaction's statements, one flight's, and what its sender reads its outcomes as. */
export interface FlightBatch<A> {
	readonly statements: ReadonlyArray<BatchStatement>
	readonly batch: A
}

/**
 * A Db's transaction sent as several flights, so its statements need not all be built before the first is sent:
 * BEGIN, the frame's prologue and the first batch `next` makes, the transaction left open; then each next batch, a
 * flight of its own, the transaction open before and after it; then `closing` and the frame's end, once `next` makes
 * none. Each batch's outcomes are handed to `read` as its flight drains, before `next` makes the batch after it, so a
 * sender holds one batch's statements and outcomes at a time. A flight that fails is answered at its batch, and the
 * transaction is rolled back alone behind it, a ROLLBACK drained, so the server holds no transaction of the session and
 * commits none of it; a COMMIT the closing flight sent is decided as runFramed decides it. A failure of `next` itself
 * rolls the transaction back alone, then fails the call with it: every flight it sent before commits nothing.
 */
export const runFramedFlights = <A, E>(
	session: Session,
	frame: Frame,
	next: () => Effect.Effect<FlightBatch<A> | undefined, E>,
	read: (batch: A, outcomes: ReadonlyArray<BatchOutcome>) => void,
	closing: ReadonlyArray<BatchStatement>
): Effect.Effect<FlightsAnswer<A>, E | ConnectionLost> =>
	onSession(session, (restore) =>
		Effect.gen(function* () {
			const principal = asDb(frame)
			/**
			 * The transaction rolled back alone and drained, its answer read by no one: a failure decided the call, so nothing
			 * of its flights commits, whichever failed, the server's refusal of a flight or `next`'s own, which the server never
			 * saw, where its frame's end, COMMIT, would commit every flight sent before.
			 */
			const endAlone = Effect.gen(function* () {
				const ending = yield* Effect.result(
					onSession(session, () =>
						sendPlan(session, [], principal, [], { ...frame, end: "ROLLBACK" }, "closing")
					)
				)
				if (Result.isSuccess(ending)) {
					yield* Deferred.await(ending.success.sent.drained)
				}
			})
			const failedAt = (at: A | undefined, failure: FlightFailure, begun: boolean) =>
				Effect.as(begun ? endAlone : Effect.void, {
					kind: "failed",
					at,
					failure
				} satisfies FlightsAnswer<A>)
			const first = yield* Effect.onError(restore(next()), () => Effect.void)
			if (first === undefined) {
				return yield* Effect.die(new Error("a transaction of several flights opens on a batch"))
			}
			const opening = yield* Effect.result(
				sendPlan(session, [], principal, first.statements, frame, "opening")
			)
			if (Result.isFailure(opening)) {
				return {
					kind: "failed",
					at: first.batch,
					failure: opening.failure
				} satisfies FlightsAnswer<A>
			}
			yield* execute(session, restore, opening.success.sent, opening.success.sent.drained)
			const opened = flightOutcomes(session, opening.success.plan, opening.success.sent)
			if (Result.isFailure(opened)) {
				const begun = receivedAt(opening.success.sent.answers, 0)
				const prologue =
					opened.failure._tag === "PrologueRefused" || opened.failure._tag === "StaleSnapshot"
				return yield* failedAt(
					prologue ? undefined : first.batch,
					opened.failure,
					begun._tag === "result" || begun._tag === "unreadable"
				)
			}
			read(first.batch, opened.success)
			for (;;) {
				const made = yield* Effect.result(restore(next()))
				if (Result.isFailure(made)) {
					yield* endAlone
					return yield* Effect.fail(made.failure)
				}
				const batch = made.success
				if (batch === undefined) {
					break
				}
				const middle = yield* Effect.result(
					sendPlan(session, [], principal, batch.statements, frame, "middle")
				)
				if (Result.isFailure(middle)) {
					return yield* failedAt(batch.batch, middle.failure, true)
				}
				yield* execute(session, restore, middle.success.sent, middle.success.sent.drained)
				const ran = flightOutcomes(session, middle.success.plan, middle.success.sent)
				if (Result.isFailure(ran)) {
					return yield* failedAt(batch.batch, ran.failure, true)
				}
				read(batch.batch, ran.success)
			}
			const last = yield* Effect.result(sendPlan(session, [], principal, closing, frame, "closing"))
			if (Result.isFailure(last)) {
				return yield* failedAt(undefined, last.failure, true)
			}
			const { plan, sent } = last.success
			/** The end awaited: an interruption cancels nothing, and takes effect once COMMIT's answer decided. */
			const settledEnd = Effect.suspend(
				(): Effect.Effect<ReadonlyArray<BatchOutcome>, FlightFailure> => {
					const settled = decide(session, plan, sent, plan.pipeline.length)
					if (Result.isFailure(settled)) {
						return Effect.fail(settled.failure)
					}
					const answer = receivedAt(sent.answers, plan.pipeline.length - 1)
					if (
						frame.end === "COMMIT" &&
						!(answer._tag === "result" && answer.outcome.command === "COMMIT")
					) {
						session.retire()
						return Effect.fail(new CommitLost())
					}
					return Effect.fromResult(outcomesOf(plan, sent.answers, settled.success))
				}
			)
			const waited = yield* Effect.exit(restore(Deferred.await(sent.drained)))
			if (Exit.isFailure(waited)) {
				return yield* interruptedDrain(sent, settledEnd, waited.cause)
			}
			const outcomes = yield* Effect.result(settledEnd)
			return Result.isSuccess(outcomes)
				? ({ kind: "committed", closing: outcomes.success } satisfies FlightsAnswer<A>)
				: ({ kind: "failed", at: undefined, failure: outcomes.failure } satisfies FlightsAnswer<A>)
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
		defect(`the answer of sent statement ${index} of ${answers.length}`)
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

/** A flight of one statement, a program's (reader/run.ts programFlight): what a read frame sends (FramedStatements). */
export interface StatementFlight<A, E> extends Flight<A, E> {
	readonly statements: readonly [BatchStatement]
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
