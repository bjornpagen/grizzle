import { Array as Arr, Effect } from "effect"
import { Pool } from "pg"
import type { ServerError } from "#adapter/errors/failures.ts"
import type { BatchOutcome } from "#adapter/wire/batch.ts"
import {
	type Answer,
	controlText,
	type WireQuery,
	type Session,
	type SessionPool,
	SessionStatements,
	type TxControl
} from "#adapter/wire/session.ts"
import { nothingReported, serverError } from "#test/support/server-error.ts"

export type Rows = ReadonlyArray<ReadonlyArray<string>>

/** The login role a scripted session logged in as. */
const scriptedRole = "scripted_login"

/** What a statement answers when it runs (see the header). */
export type StatementAnswer =
	| { readonly _tag: "rows"; readonly rows: Rows }
	| { readonly _tag: "doomed"; readonly rows: Rows }
	| { readonly _tag: "nullCell" }
	| { readonly _tag: "refused"; readonly error: ServerError }
	| { readonly _tag: "fatal"; readonly error: ServerError }
	| { readonly _tag: "hold" }
	| { readonly _tag: "late" }
	| { readonly _tag: "stuck" }
	| { readonly _tag: "wedged" }
	| { readonly _tag: "lose" }

export const rows = (...cells: Rows): StatementAnswer => ({ _tag: "rows", rows: cells })

export const refusedAnswer = (sqlstate: string): StatementAnswer => ({
	_tag: "refused",
	error: serverError({ ...nothingReported, sqlstate })
})

export type StatementQuery = Extract<WireQuery, { readonly _tag: "statement" }>

export interface Script {
	/** The answer of a statement that runs. */
	readonly statement: (query: StatementQuery) => StatementAnswer
	/** A refusal of BEGIN, which the server gives only for an isolation it cannot give, or none. */
	readonly begin: () => ServerError | undefined
	/**
	 * What COMMIT of a transaction no statement aborted or doomed answers: a refusal (a deferred law, 40001), no answer
	 * because the connection is lost before it runs, or none (it commits).
	 */
	readonly commit: () => ServerError | "lose" | undefined
}

/** How the session hands its answers to the client. */
export type Delivery = "immediate" | "stepped"

export interface ScriptedOptions {
	readonly delivery: Delivery
}

/**
 * A session that answers every statement with one row of its SQL text, refuses no BEGIN and commits every COMMIT: a
 * scenario spreads it and overrides what it scripts.
 */
export const answeringScript: Script = {
	statement: (query) => rows([query.sql]),
	begin: () => undefined,
	commit: () => undefined
}

/** Answers handed over as they arrive. */
export const immediateDelivery: ScriptedOptions = { delivery: "immediate" }

/** One answer as the client was given it: by the delivery with this ordinal, counted from 1 over the session's life. */
export interface Delivered {
	readonly answer: Answer
	readonly ordinal: number
}

export interface SentFlight {
	readonly closes: ReadonlyArray<string>
	readonly pipeline: ReadonlyArray<WireQuery>
	/** The answers delivered so far, by pipeline position. */
	readonly delivered: ReadonlyArray<Delivered | undefined>
}

export interface ScriptedSession extends Session {
	/** Every flight sent, in order. */
	readonly flights: () => ReadonlyArray<SentFlight>
	/** The SQL of every statement a committed transaction ran, or that committed alone, in commit order. */
	readonly committed: () => ReadonlyArray<string>
	/** The CancelRequests sent. */
	readonly cancels: () => number
	/**
	 * The CancelRequest connections open now: each a request a wedged backend left unanswered, until its sender gives
	 * up on it.
	 */
	readonly openCancels: () => number
	/** The connection was destroyed while a CancelRequest connection was open. */
	readonly destroyedDuringCancel: () => boolean
	/** The server holds a transaction open. */
	readonly open: () => boolean
	/** The server owes the client an answer it has made. */
	readonly deliverable: () => boolean
	/** Hands the client the next answer (stepped delivery); a defect when none is owed. */
	readonly deliver: () => void
	/** The deliveries so far. */
	readonly deliveries: () => number
}

const result = (command: string, cells: Rows): Answer => ({
	_tag: "result",
	outcome: { command, rows: cells }
})

/** A command that returns no rows. */
const completed = (command: string): Answer => result(command, [])

const refusal = (error: ServerError): Answer => ({ _tag: "refused", error })

/** The ErrorResponse after which the server ends the session. */
const termination = (error: ServerError): Answer => ({ _tag: "terminated", error })

const deferredViolation: Readonly<ServerError> = serverError({
	...nothingReported,
	sqlstate: "23503"
})
const aborted: Readonly<ServerError> = serverError({ ...nothingReported, sqlstate: "25P02" })
const cancelled: Readonly<ServerError> = serverError({ ...nothingReported, sqlstate: "57014" })

/**
 * What the server owes the client: one answer, or the connection's end, which fails every query from `from` on, after
 * an ErrorResponse at `from` when the server ended the session with one.
 */
type Owed =
	| { readonly _tag: "answer"; readonly index: number; readonly answer: Answer }
	| { readonly _tag: "end"; readonly from: number; readonly fatal: ServerError | undefined }

/**
 * How a statement waits: for a CancelRequest, which stops it or which it finishes just before, or for the connection
 * to be destroyed (a wedged backend leaving the flight's later CancelRequests open besides).
 */
type Waiting = "hold" | "late" | "stuck" | "wedged"

/**
 * What the server makes of one query: its answer; the end of the connection, after a FATAL ErrorResponse or none; or
 * a wait.
 */
type Made =
	| { readonly _tag: "answer"; readonly answer: Answer }
	| { readonly _tag: "end"; readonly fatal: ServerError | undefined }
	| { readonly _tag: "wait"; readonly waiting: Waiting }

/**
 * One flight on the server: the answers it made and not yet delivered, the next query it runs, the statement it is
 * running until a CancelRequest arrives, and the CancelRequests sent while it ran.
 */
interface Running {
	readonly pipeline: ReadonlyArray<WireQuery>
	readonly delivered: Array<Delivered | undefined>
	readonly owed: Array<Owed>
	next: number
	waiting: { readonly index: number; readonly waiting: Waiting } | undefined
	cancels: number
	readonly onAnswer: (index: number, answer: Answer) => void
	readonly onEnd: () => void
}

/**
 * A scripted session: the adapter's Session (packages/grizzle/src/adapter/wire/session.ts) answered as PostgreSQL answers a pipeline
 * with a Sync after every query, for the tests that drive flights without a server.
 *
 * The server runs ahead of the client. Once a flight is written, the server answers its queries in order as fast as it
 * can, and its answers wait in the connection until the client reads them; it stops only at a statement that runs until
 * a CancelRequest arrives. So a CancelRequest finds the server either idle, a no-op, or at that one statement. What the
 * server answers:
 *
 * - BEGIN opens a transaction, unless the script refuses it (an isolation the server cannot give), after which the
 *   statements run outside any transaction, each committing at its own Sync, and COMMIT answers COMMIT.
 * - A statement answers its script. `rows` answers its rows. `doomed` answers its rows and breaks a deferred
 *   constraint: its transaction's COMMIT is refused 23503, and alone, its own Sync is. `nullCell` runs and answers a
 *   row with a NULL cell, a result the client cannot read. `refused` answers an ErrorResponse and aborts the open
 *   transaction, after which every statement answers 25P02 without running and COMMIT answers ROLLBACK. `fatal` answers
 *   a FATAL ErrorResponse and ends the session; `lose` ends the connection with no answer. `hold` runs until a
 *   CancelRequest and is refused 57014 then; `late` finishes just as the CancelRequest arrives, too late to stop it, and
 *   answers its rows; `stuck` runs until the connection is destroyed, which no CancelRequest makes it notice; `wedged`
 *   is stuck too, and its backend also leaves every CancelRequest of the flight after the first open and unanswered, so
 *   that request's connection stays open until the client gives up on it.
 * - COMMIT commits what the transaction ran, unless the transaction was aborted (ROLLBACK), a doomed statement ran in
 *   it (23503), or the script refuses it or loses the connection before it runs. ROLLBACK ends the transaction.
 *
 * A session delivers its answers either as the server makes them (`immediate`), or one at a time when the test says
 * (`stepped`): `deliver` hands the client the next answer, and an ended connection hands it every answer still owed at
 * once, each a failure, as pg fails every query in flight when the connection ends. Every flight is recorded with the
 * names it closed and the answers it was given, each with the ordinal of the delivery that carried it, and so is every
 * statement a committed transaction ran, or that committed alone, and every CancelRequest connection still open.
 *
 * A session that answers as the script says (see the header).
 */
export const scriptedSession = (script: Script, options: ScriptedOptions): ScriptedSession => {
	const delivery = options.delivery
	const statements = new SessionStatements()
	const flights: Array<SentFlight> = []
	const committed: Array<string> = []
	let retired = false
	/** The client saw the connection end. */
	let lost = false
	/** The server ended the connection; what it had sent before still reaches the client. */
	let ended = false
	let cancels = 0
	let openCancels = 0
	let destroyedDuringCancel = false
	let deliveries = 0
	let tx: "idle" | "open" | "aborted" = "idle"
	let doomed = false
	/** The statements the open transaction ran. */
	let pending: Array<string> = []
	let running: Running | undefined
	const statementAnswer = script.statement

	const close = (): void => {
		ended = true
		tx = "idle"
		doomed = false
		pending = []
	}

	const ran = (sql: string): void => {
		if (tx === "open") {
			pending.push(sql)
		} else {
			committed.push(sql)
		}
	}

	const control = (c: TxControl): Made => {
		if (c.kind === "begin") {
			const refusedBegin = script.begin()
			if (refusedBegin !== undefined) {
				return { _tag: "answer", answer: refusal(refusedBegin) }
			}
			tx = "open"
			doomed = false
			pending = []
			return { _tag: "answer", answer: completed("BEGIN") }
		}
		if (c.end === "COMMIT") {
			if (tx === "aborted") {
				tx = "idle"
				pending = []
				return { _tag: "answer", answer: completed("ROLLBACK") }
			}
			if (tx === "open" && doomed) {
				tx = "idle"
				doomed = false
				pending = []
				return { _tag: "answer", answer: refusal(deferredViolation) }
			}
			const answer = script.commit()
			if (answer === "lose") {
				return { _tag: "end", fatal: undefined }
			}
			tx = "idle"
			if (answer !== undefined) {
				pending = []
				return { _tag: "answer", answer: refusal(answer) }
			}
			committed.push(...pending)
			pending = []
			return { _tag: "answer", answer: completed("COMMIT") }
		}
		tx = "idle"
		doomed = false
		pending = []
		return { _tag: "answer", answer: completed("ROLLBACK") }
	}

	const statement = (query: StatementQuery): Made => {
		const answer = statementAnswer(query)
		if (tx === "aborted") {
			return answer._tag === "lose"
				? { _tag: "end", fatal: undefined }
				: { _tag: "answer", answer: refusal(aborted) }
		}
		switch (answer._tag) {
			case "rows":
				ran(query.sql)
				return { _tag: "answer", answer: result("SELECT", answer.rows) }
			case "doomed":
				if (tx !== "open") {
					return { _tag: "answer", answer: refusal(deferredViolation) }
				}
				doomed = true
				ran(query.sql)
				return { _tag: "answer", answer: result("SELECT", answer.rows) }
			case "nullCell":
				ran(query.sql)
				return { _tag: "answer", answer: { _tag: "unreadable", command: "SELECT" } }
			case "refused":
				if (tx === "open") {
					tx = "aborted"
				}
				return { _tag: "answer", answer: refusal(answer.error) }
			case "fatal":
				return { _tag: "end", fatal: answer.error }
			case "lose":
				return { _tag: "end", fatal: undefined }
			case "hold":
			case "late":
			case "stuck":
			case "wedged":
				return { _tag: "wait", waiting: answer._tag }
		}
	}

	/** Whether the server can answer the flight's next query: the session lives, nothing waits, and a query is left. */
	const answerable = (flight: Running): boolean =>
		!ended && flight.waiting === undefined && flight.next < flight.pipeline.length

	/** Runs the server ahead: answers every query it can, up to a statement that waits for a CancelRequest. */
	const advance = (flight: Running): void => {
		while (answerable(flight)) {
			const index = flight.next
			const query = flight.pipeline[index]
			if (query === undefined) {
				return
			}
			const made = query._tag === "control" ? control(query.control) : statement(query)
			switch (made._tag) {
				case "answer":
					flight.next = index + 1
					flight.owed.push({ _tag: "answer", index, answer: made.answer })
					break
				case "end":
					close()
					flight.owed.push({ _tag: "end", from: index, fatal: made.fatal })
					break
				case "wait":
					flight.waiting = { index, waiting: made.waiting }
					break
			}
		}
	}

	const record = (flight: Running, index: number, answer: Answer): void => {
		flight.delivered[index] = { answer, ordinal: deliveries }
		flight.onAnswer(index, answer)
	}

	const deliverOne = (): void => {
		const flight = running
		const owed = flight?.owed.shift()
		if (flight === undefined || owed === undefined) {
			throw new Error("scripted: no answer is owed")
		}
		deliveries++
		if (owed._tag === "answer") {
			record(flight, owed.index, owed.answer)
			if (owed.index === flight.pipeline.length - 1) {
				running = undefined
				flight.onEnd()
			}
			return
		}
		lost = true
		for (let index = owed.from; index < flight.pipeline.length; index++) {
			record(
				flight,
				index,
				index === owed.from && owed.fatal !== undefined
					? termination(owed.fatal)
					: { _tag: "failed" }
			)
		}
		running = undefined
		flight.onEnd()
	}

	/** Whether the running flight is owed an answer the client has not been delivered yet. */
	const owesAnswers = (): boolean => running !== undefined && running.owed.length > 0

	const deliverAll = (): void => {
		while (owesAnswers()) {
			deliverOne()
		}
	}

	const send: Session["send"] = (closes, pipeline, onAnswer, onEnd) => {
		const flight: Running = {
			pipeline,
			delivered: Array.from({ length: pipeline.length }, (): Delivered | undefined => undefined),
			owed: [],
			next: 0,
			waiting: undefined,
			cancels: 0,
			onAnswer,
			onEnd
		}
		flights.push({ closes, pipeline, delivered: flight.delivered })
		running = flight
		if (pipeline.length === 0) {
			running = undefined
			onEnd()
			return
		}
		if (ended || lost) {
			flight.owed.push({ _tag: "end", from: 0, fatal: undefined })
		} else {
			advance(flight)
		}
		if (delivery === "immediate") {
			deliverAll()
		}
	}

	/**
	 * A CancelRequest connection a wedged backend never answers: it stays open until its sender gives up on it, which
	 * closes it, as session.ts's cancelRequest does when interrupted.
	 */
	const unanswered: Effect.Effect<void> = Effect.callback<void>(() => {
		openCancels++
		return Effect.sync(() => {
			openCancels--
		})
	})

	/**
	 * A CancelRequest stops the statement the server is running; when it is running none, or one that does not notice,
	 * it does nothing, and a wedged backend leaves every request of the flight after the first unanswered.
	 */
	const cancel: Effect.Effect<void> = Effect.suspend(() => {
		cancels++
		const flight = running
		const waiting = flight?.waiting
		if (flight === undefined) {
			return Effect.void
		}
		flight.cancels++
		if (waiting === undefined || waiting.waiting === "stuck") {
			return Effect.void
		}
		if (waiting.waiting === "wedged") {
			return flight.cancels > 1 ? unanswered : Effect.void
		}
		const query = flight.pipeline[waiting.index]
		flight.waiting = undefined
		flight.next = waiting.index + 1
		if (waiting.waiting === "late" && query?._tag === "statement") {
			ran(query.sql)
			flight.owed.push({
				_tag: "answer",
				index: waiting.index,
				answer: result("SELECT", [[query.sql]])
			})
		} else {
			if (tx === "open") {
				tx = "aborted"
			}
			flight.owed.push({ _tag: "answer", index: waiting.index, answer: refusal(cancelled) })
		}
		advance(flight)
		if (delivery === "immediate") {
			deliverAll()
		}
		return Effect.void
	})

	/** Destroying the connection loses every answer the client has not read: pg fails each query still in flight. */
	const destroy = (): void => {
		if (openCancels > 0) {
			destroyedDuringCancel = true
		}
		const flight = running
		if (flight === undefined) {
			lost = true
			return
		}
		const from = flight.delivered.indexOf(undefined)
		flight.owed.length = 0
		flight.waiting = undefined
		close()
		flight.owed.push({
			_tag: "end",
			from: from < 0 ? flight.pipeline.length : from,
			fatal: undefined
		})
		if (delivery === "immediate") {
			deliverAll()
		}
	}

	return {
		role: scriptedRole,
		statements,
		cancel,
		retired: () => retired,
		retire: () => {
			retired = true
		},
		lost: () => lost,
		destroy,
		send,
		flights: () => flights,
		committed: () => committed,
		cancels: () => cancels,
		openCancels: () => openCancels,
		destroyedDuringCancel: () => destroyedDuringCancel,
		open: () => tx !== "idle",
		deliverable: () => running !== undefined && running.owed.length > 0,
		deliver: deliverOne,
		deliveries: () => deliveries
	}
}

/** The SQL of each query of a flight, BEGIN, COMMIT and ROLLBACK among them. */
export const texts = (flight: SentFlight | undefined): ReadonlyArray<string> =>
	Arr.map(flight?.pipeline ?? [], (q) => (q._tag === "control" ? controlText(q.control) : q.sql))

/** The rows of every outcome, as their first cells. */
export const firstCells = (outcomes: ReadonlyArray<BatchOutcome>): ReadonlyArray<unknown> =>
	Arr.map(outcomes, (o) => o.rows[0]?.[0])

/** The defect of a member the scenario does not use. */
const unused = (member: string): Effect.Effect<never> =>
	Effect.die(new Error(`scripted: ${member} is unused`))

/** The defect of a function member the scenario does not use. */
const unusedCall = (member: string) => (): never => {
	throw new Error(`scripted: ${member} is unused`)
}

/** A session pool whose members are the overrides, every other one dying when used. */
export const scriptedPool = (overrides: Partial<SessionPool>): SessionPool => ({
	role: "main",
	native: new Pool({ max: 1 }),
	idleTimeoutMillis: 0,
	maxSessions: 1,
	lease: unused("lease"),
	size: Effect.succeed(0),
	leased: Effect.succeed(0),
	live: Effect.succeed(0),
	release: unusedCall("release"),
	...overrides
})
