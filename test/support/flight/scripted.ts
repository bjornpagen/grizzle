import { Array as Arr, Effect } from "effect"
import { Pool } from "pg"
import type { ServerError } from "#adapter/errors/failures.ts"
import type { BatchOutcome } from "#adapter/wire/batch.ts"
import {
	type Answer,
	controlText,
	type WireQuery,
	type Session,
	type SessionEvent,
	type SessionPool,
	type SessionState,
	SessionStatements,
	sessionTransitions,
	type TxControl
} from "#adapter/wire/session.ts"
import { appendAll } from "#compiler/core/array.ts"
import { nothingReported, serverError } from "#test/support/server-error.ts"
import { outputRows } from "#test/support/wire.ts"

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
	| { readonly _tag: "lose" }

export const rows = (cells: Rows): StatementAnswer => ({ _tag: "rows", rows: cells })

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
	/**
	 * How many of a flight's queries past the statement a CancelRequest stopped the server answers before the end of a
	 * connection the client destroys then reaches it. PostgreSQL runs a pipeline on in order after a cancelled statement
	 * and stops only once it notices the connection gone, and an interrupted call destroys its connection right after its
	 * one CancelRequest (README "No server-side timeouts"), so the server may run none of the rest, some or all of it: a
	 * race between the backend and the client. A connection the client keeps gets every answer.
	 */
	readonly afterCancel: number
}

/**
 * A session that answers every statement with one row of its SQL text, refuses no BEGIN and commits every COMMIT: a
 * scenario spreads it and overrides what it scripts.
 */
export const answeringScript: Script = {
	statement: (query) => rows([[query.sql]]),
	begin: () => undefined,
	commit: () => undefined
}

/** Answers handed over as they arrive, the server running a cancelled flight's rest before any end reaches it. */
export const immediateDelivery: ScriptedOptions = {
	delivery: "immediate",
	afterCancel: Number.MAX_SAFE_INTEGER
}

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
	/**
	 * The answers the server made, by pipeline position, delivered or not: once the client destroys the connection, the
	 * answers it never read are still what the server did. A query the server never ran has none.
	 */
	readonly made: ReadonlyArray<Answer | undefined>
}

export interface ScriptedSession extends Session {
	/** Every flight sent, in order. */
	readonly flights: () => ReadonlyArray<SentFlight>
	/** The SQL of every statement a committed transaction ran, or that committed alone, in commit order. */
	readonly committed: () => ReadonlyArray<string>
	/** The CancelRequests sent. */
	readonly cancels: () => number
	/** The server holds a transaction open. */
	readonly open: () => boolean
	/** The server owes the client an answer it has made. */
	readonly deliverable: () => boolean
	/** Hands the client the next answer (stepped delivery); a defect when none is owed. */
	readonly deliver: () => void
	/** The deliveries so far. */
	readonly deliveries: () => number
	/**
	 * A destroyed connection's end reached the server before it had run the queries past a cancelled statement
	 * (ScriptedOptions.afterCancel): a larger afterCancel would have run more of them.
	 */
	readonly cutShort: () => boolean
}

const result = (command: string, cells: Rows): Answer => ({
	_tag: "result",
	outcome: { command, rows: outputRows(cells) }
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
 * to be destroyed.
 */
type Waiting = "hold" | "late" | "stuck"

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
	readonly made: Array<Answer | undefined>
	readonly owed: Array<Owed>
	next: number
	waiting: { readonly index: number; readonly waiting: Waiting } | undefined
	cancels: number
	/**
	 * The server stopped a statement for a CancelRequest and has run `afterCancel` queries past it: it runs the rest
	 * once the client reads on without ending the connection, and never once the client destroys it.
	 */
	racing: boolean
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
 *   answers its rows; `stuck` runs until the connection is destroyed, which no CancelRequest makes it notice. Past a
 *   statement a CancelRequest stopped, the server answers `afterCancel` more queries before a destroyed connection's
 *   end reaches it, and the rest only for a client that keeps the connection (ScriptedOptions.afterCancel).
 * - COMMIT commits what the transaction ran, unless the transaction was aborted (ROLLBACK), a doomed statement ran in
 *   it (23503), or the script refuses it or loses the connection before it runs. ROLLBACK ends the transaction.
 *
 * A session delivers its answers either as the server makes them (`immediate`), or one at a time when the test says
 * (`stepped`): `deliver` hands the client the next answer, and an ended connection hands it every answer still owed at
 * once, each a failure, as pg fails every query in flight when the connection ends. Every flight is recorded with the
 * names it closed, the answers the server made and the answers it was given, each with the ordinal of the delivery that
 * carried it, and so is every statement a committed transaction ran, or that committed alone.
 *
 * A session that answers as the script says (see the header).
 */
export const scriptedSession = (script: Script, options: ScriptedOptions): ScriptedSession => {
	const delivery = options.delivery
	const statements = new SessionStatements()
	const flights: Array<SentFlight> = []
	const committed: Array<string> = []
	/**
	 * Where the session stands as its client sees it (session.ts SessionState), moved only as sessionTransitions says:
	 * ended once the client read the connection's end, or destroyed it.
	 */
	let state: SessionState = "open"
	const move = (event: SessionEvent): void => {
		state = sessionTransitions[state][event]
	}
	/** The server ended the connection; what it had sent before still reaches the client. */
	let serverEnded = false
	let cancels = 0
	let deliveries = 0
	let cutShort = false
	let tx: "idle" | "open" | "aborted" = "idle"
	let doomed = false
	/** The statements the open transaction ran. */
	let pending: Array<string> = []
	let running: Running | undefined
	const statementAnswer = script.statement

	const close = (): void => {
		serverEnded = true
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
			appendAll(committed, pending)
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
				return { _tag: "wait", waiting: answer._tag }
		}
	}

	/** Whether the server can answer the flight's next query: the session lives, nothing waits, and a query is left. */
	const answerable = (flight: Running): boolean =>
		!serverEnded && flight.waiting === undefined && flight.next < flight.pipeline.length

	/**
	 * Runs the server ahead: answers every query it can, up to a statement that waits for a CancelRequest, or `limit`
	 * queries.
	 */
	const advanceUpTo = (flight: Running, limit: number): void => {
		for (let answered = 0; answered < limit && answerable(flight); answered++) {
			const index = flight.next
			const query = flight.pipeline[index]
			if (query === undefined) {
				return
			}
			const made = query._tag === "control" ? control(query.control) : statement(query)
			switch (made._tag) {
				case "answer":
					flight.next = index + 1
					flight.made[index] = made.answer
					flight.owed.push({ _tag: "answer", index, answer: made.answer })
					break
				case "end":
					close()
					for (let at = index; at < flight.pipeline.length; at++) {
						flight.made[at] =
							at === index && made.fatal !== undefined
								? termination(made.fatal)
								: { _tag: "failed" }
					}
					flight.owed.push({ _tag: "end", from: index, fatal: made.fatal })
					break
				case "wait":
					flight.waiting = { index, waiting: made.waiting }
					break
			}
		}
	}

	/** Runs the server ahead as far as it can. */
	const advance = (flight: Running): void => {
		advanceUpTo(flight, flight.pipeline.length)
	}

	const record = (flight: Running, index: number, answer: Answer): void => {
		flight.delivered[index] = { answer, ordinal: deliveries }
		flight.onAnswer(index, answer)
	}

	const deliverOne = (): void => {
		const flight = running
		if (flight !== undefined) {
			runOn(flight)
		}
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
		move("end")
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

	/**
	 * A racing flight whose client reads on without ending the connection: the server runs its rest, the end never
	 * having reached it.
	 */
	const runOn = (flight: Running): void => {
		if (flight.racing && flight.owed.length === 0) {
			flight.racing = false
			advance(flight)
		}
	}

	/**
	 * Whether the running flight is owed an answer the client has not been delivered yet: a racing flight's server runs
	 * on first, as it does for a client that reads on without ending the connection.
	 */
	const owesAnswers = (): boolean => {
		if (running === undefined) {
			return false
		}
		runOn(running)
		return running.owed.length > 0
	}

	const deliverAll = (): void => {
		while (owesAnswers()) {
			deliverOne()
		}
	}

	const send: Session["send"] = (closes, pipeline, onAnswer, onEnd) => {
		const flight: Running = {
			pipeline,
			delivered: Array.from({ length: pipeline.length }, (): Delivered | undefined => undefined),
			made: Array.from({ length: pipeline.length }, (): Answer | undefined => undefined),
			owed: [],
			next: 0,
			waiting: undefined,
			cancels: 0,
			racing: false,
			onAnswer,
			onEnd
		}
		flights.push({ closes, pipeline, delivered: flight.delivered, made: flight.made })
		running = flight
		if (pipeline.length === 0) {
			running = undefined
			onEnd()
			return
		}
		if (serverEnded || state === "ended") {
			flight.owed.push({ _tag: "end", from: 0, fatal: undefined })
		} else {
			advance(flight)
		}
		if (delivery === "immediate") {
			deliverAll()
		}
	}

	/**
	 * A CancelRequest stops the statement the server is running; when it is running none, or one that does not notice,
	 * it does nothing. Past the statement it stopped, the server answers `afterCancel` queries at once, and races the
	 * connection's end for the rest.
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
		const query = flight.pipeline[waiting.index]
		flight.waiting = undefined
		flight.next = waiting.index + 1
		const answer =
			waiting.waiting === "late" && query?._tag === "statement"
				? result("SELECT", [[query.sql]])
				: refusal(cancelled)
		if (answer._tag === "result" && query?._tag === "statement") {
			ran(query.sql)
		} else if (tx === "open") {
			tx = "aborted"
		}
		flight.made[waiting.index] = answer
		flight.owed.push({ _tag: "answer", index: waiting.index, answer })
		advanceUpTo(flight, options.afterCancel)
		flight.racing = answerable(flight)
		if (delivery === "immediate") {
			deliverAll()
		}
		return Effect.void
	})

	/**
	 * Destroying the connection ends the session at once and loses every answer the client has not read: pg fails each
	 * query still in flight.
	 */
	const destroy = (): void => {
		move("end")
		const flight = running
		if (flight === undefined) {
			return
		}
		const from = flight.delivered.indexOf(undefined)
		if (flight.racing && answerable(flight)) {
			cutShort = true
		}
		flight.racing = false
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
		state: () => state,
		retire: () => {
			move("retire")
		},
		destroy,
		send,
		flights: () => flights,
		committed: () => committed,
		cancels: () => cancels,
		open: () => tx !== "idle",
		deliverable: owesAnswers,
		deliver: deliverOne,
		deliveries: () => deliveries,
		cutShort: () => cutShort
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
	lease: unused("lease"),
	size: Effect.succeed(0),
	leased: Effect.succeed(0),
	live: Effect.succeed(0),
	release: unusedCall("release"),
	...overrides
})
