import { Buffer } from "node:buffer"
import { createServer, type Server, Socket } from "node:net"
import { TLSSocket } from "node:tls"
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	bytes,
	codePoint,
	element,
	type Gen,
	int,
	string,
	subset,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	Formatter,
	Option,
	type Scope,
	String as Str
} from "effect"
import pgDriver from "pg"
import { type BatchFailure, type ConnectRefusal, InputTooLarge } from "#adapter/errors/failures.ts"
import type { Transport } from "#adapter/types/layer.ts"
import {
	type ApartFailure,
	type BatchStatement,
	type FlightFailure,
	type FlightStatement,
	type NamedStatement,
	runAlongside,
	runApart,
	runFramed,
	runFramedTwice,
	runTransaction,
	type Transaction,
	writeFrame
} from "#adapter/wire/batch.ts"
import {
	connectSession,
	controlText,
	noPassword,
	type ServerStatement,
	type Session,
	serverStatement
} from "#adapter/wire/session.ts"
import type { Param } from "#compiler/core/wire.ts"
import { assert, defined } from "#test/support/assert.ts"
import { flightPrologue } from "#test/support/flight/model.ts"
import { caseHang, testConnectTimeout } from "#test/support/limits.ts"
import { tlsMaterial } from "#test/support/memory-tls.ts"
import { parsedConnection } from "#test/support/pg.ts"
import { testSql } from "#test/support/sql.ts"
import { paramBinary, paramText } from "#test/support/wire.ts"

/**
 * The flight bound (core/limits.ts flightMaxBytes, wire/batch.ts send): a flight whose bytes, as pg writes them in its
 * one corked write, pass what one write of the session carries is refused as InputTooLarge before any byte of it is
 * written, and leaves the session as it was; every other flight is written whole.
 *
 * Each case runs its call twice, on two sessions of the adapter's own wire, each over the same history: a first flight
 * that parses some of the case's server statements, of which some are then released, so the case's flight closes
 * names in front of it, parses some statements and binds others to their earlier Parse. The first session writes the
 * call under the production bound, and its server reads the bytes of every message: that is the oracle, the wire
 * itself, independent of grizzle's accounting. The second session writes the call under a test-sized bound drawn about
 * one of those flights' bytes, short of it, at it or past it, and must be refused exactly when the flight is longer
 * than its bound, with the flight's bytes and the bound, its server reading none of the flight; an admitted flight's
 * server reads exactly what the first one read. A refused call then runs again under the production bound and writes
 * exactly what the first session wrote, so the refusal changed nothing of the session's statements. A call of two
 * flights refused at its second rolls the first one's transaction back, and one refused at its first sends nothing at
 * all.
 *
 * A flight whose write fails before its last byte left the process (session.ts flightEnd) never carried its last
 * message, COMMIT where it ends a transaction, to the server: the call is ConnectionLost, never CommitLost. Each case
 * breaks the call's connection one way: the client's write side shut, so its write fails at once; the server's reset
 * right before the call, which may reach the client before its write or after; or the server's reset once it read the
 * call's COMMIT whole and ran it, so the call, whose COMMIT is never answered, is CommitLost. The fate is unknown only
 * where COMMIT could have run, as far as the client can tell.
 *
 * Every server is a TCP server on the loopback behind the SSLRequest and verify-full TLS every connection makes, whose
 * certificate authority is the test's own (test/support/memory-tls.ts tlsMaterial), and answers every query as
 * PostgreSQL answers one that returns no rows.
 */

const frame = (type: string, body: Uint8Array): Buffer => {
	const out = Buffer.alloc(5 + body.length)
	out.write(type, 0, "latin1")
	out.writeInt32BE(4 + body.length, 1)
	out.set(body, 5)
	return out
}

const int32 = (n: number): Buffer => {
	const out = Buffer.alloc(4)
	out.writeInt32BE(n)
	return out
}

const nothing = new Uint8Array(0)
const authenticationOk = frame("R", int32(0))
const backendKeyData = frame("K", Buffer.concat([int32(1), int32(7)]))
const parseComplete = frame("1", nothing)
const bindComplete = frame("2", nothing)
const closeComplete = frame("3", nothing)
const noData = frame("n", nothing)
const commandComplete = (tag: string): Buffer => frame("C", Buffer.from(`${tag}\0`, "latin1"))
const readyForQuery = (open: boolean): Buffer => frame("Z", Buffer.from(open ? "T" : "I", "latin1"))

/** One frontend message the server read past the startup: its type, its bytes on the wire, and a Query's text. */
interface Read {
	readonly type: string
	readonly bytes: number
	readonly text: string
}

/** The SSLRequest message: its length, 8, and the request code 80877103. */
const sslRequest = Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f])

/** The server's yes to an SSLRequest. */
const sslAccepted = Buffer.from("S", "latin1")

/**
 * When the server resets the connection from its end: never, or once it has read a COMMIT whole, which it then runs and
 * never answers.
 */
type ResetAt = "never" | "commit"

/**
 * A PostgreSQL server on the loopback for one session, under trust authentication: it answers the SSLRequest with S and
 * terminates verify-full TLS, answers the startup ready with a cancellation key, then every message as PostgreSQL
 * answers a query that returns no rows. It records each message it reads, tracks whether a transaction is open, and
 * counts the COMMITs it read whole and ran. It closes with the scope it was opened in.
 */
class WireServer {
	readonly read: Array<Read> = []
	open = false
	committed = 0
	resetAt: ResetAt = "never"
	/** The transport that reaches the server: a TCP socket to its port, verified against its CA as `servername`. */
	readonly transport: Transport
	readonly #material = tlsMaterial("flight-bound.test")
	readonly #connections: Array<Socket> = []
	readonly #opened: Array<Socket> = []
	readonly #tcp: Server

	constructor(tcp: Server, port: number) {
		this.#tcp = tcp
		this.transport = {
			kind: "sslRequest",
			host: "127.0.0.1",
			port,
			open: () => {
				const socket = new Socket()
				this.#opened.push(socket)
				return socket
			},
			ca: this.#material.ca,
			servername: this.#material.servername
		}
		tcp.on("connection", (raw: Socket) => {
			this.#accept(raw)
		})
	}

	/** A server listening on the loopback, closed with the scope, its every connection destroyed. */
	static readonly opened: Effect.Effect<WireServer, never, Scope.Scope> = Effect.acquireRelease(
		Effect.callback<WireServer>((resume) => {
			const tcp = createServer()
			tcp.listen(0, "127.0.0.1", () => {
				const address = tcp.address()
				assert.ok(address !== null && typeof address === "object", "a TCP server listens at a port")
				resume(Effect.succeed(new WireServer(tcp, address.port)))
			})
		}),
		(server) =>
			Effect.sync(() => {
				server.#tcp.close()
				for (const raw of server.#connections) {
					raw.destroy()
				}
			})
	)

	/**
	 * Resets every connection from the server's end at once. The session's next write fails once the reset reaches it,
	 * which may be after the write went out.
	 */
	resetNow(): void {
		for (const raw of this.#connections) {
			raw.resetAndDestroy()
		}
	}

	/**
	 * Shuts the write side of every socket the transport opened, under its TLS, so the session's next write fails at
	 * once, before any byte of it leaves the process, with the session's stream standing.
	 */
	shutClients(): void {
		for (const socket of this.#opened) {
			socket.end()
		}
	}

	#accept(raw: Socket): void {
		this.#connections.push(raw)
		raw.on("error", () => undefined)
		raw.once("data", (first: Buffer) => {
			if (!first.equals(sslRequest)) {
				raw.destroy()
				return
			}
			raw.write(sslAccepted)
			this.#serve(
				raw,
				new TLSSocket(raw, { isServer: true, secureContext: this.#material.context })
			)
		})
	}

	#answer(raw: Socket, secure: TLSSocket, type: string, body: Buffer): void {
		switch (type) {
			case "P":
				secure.write(parseComplete)
				return
			case "B":
				secure.write(bindComplete)
				return
			case "D":
				secure.write(noData)
				return
			case "E":
				secure.write(commandComplete("SELECT 0"))
				return
			case "S":
				secure.write(readyForQuery(this.open))
				return
			case "C":
				secure.write(closeComplete)
				return
			case "Q": {
				const text = body.toString("utf8", 0, body.length - 1)
				const tag = Str.startsWith("BEGIN")(text)
					? "BEGIN"
					: Str.startsWith("COMMIT")(text)
						? "COMMIT"
						: "ROLLBACK"
				this.open = tag === "BEGIN"
				if (tag === "COMMIT") {
					this.committed += 1
					if (this.resetAt === "commit") {
						raw.resetAndDestroy()
						return
					}
				}
				secure.write(Buffer.concat([commandComplete(tag), readyForQuery(this.open)]))
				return
			}
			default:
				secure.end()
		}
	}

	#serve(raw: Socket, secure: TLSSocket): void {
		let pending = Buffer.alloc(0)
		let started = false
		secure.on("data", (chunk: Buffer) => {
			pending = Buffer.concat([pending, chunk])
			for (;;) {
				const header = started ? 5 : 4
				if (pending.length < header) {
					return
				}
				const length = started ? 1 + pending.readInt32BE(1) : pending.readInt32BE(0)
				if (pending.length < length) {
					return
				}
				const message = pending.subarray(0, length)
				pending = pending.subarray(length)
				if (!started) {
					started = true
					secure.write(Buffer.concat([authenticationOk, backendKeyData, readyForQuery(false)]))
					continue
				}
				const type = message.toString("latin1", 0, 1)
				const body = message.subarray(5)
				this.read.push({
					type,
					bytes: length,
					text: type === "Q" ? body.toString("utf8", 0, body.length - 1) : ""
				})
				this.#answer(raw, secure, type, body)
			}
		})
		secure.on("error", () => undefined)
	}
}

/** The bytes of `messages`, as the server read them. */
const bytesOf = (messages: ReadonlyArray<Read>): number =>
	Arr.reduce(messages, 0, (sum, message) => sum + message.bytes)

/** The case's server statements: the same text under its own name on every session. */
const servers: ReadonlyArray<ServerStatement> = Arr.makeBy(4, (k) =>
	serverStatement(testSql(`SELECT $1::text AS s${k}`))
)

const serverAt = (k: number): ServerStatement => defined(servers[k], "a server statement")

/** A parameter of the case: a text, some of it beyond ASCII, or binary. */
const paramGen: Gen<Param> = weighted<Param>([
	[
		3,
		(source) =>
			paramText(
				source.draw(
					string(
						weighted([
							[3, codePoint(0x20, 0x7e)],
							[1, codePoint(0xa0, 0xd7_ff)],
							[1, codePoint(0x1_00_00, 0x10_ff_ff)]
						]),
						{ min: 0, max: 300 }
					)
				)
			)
	],
	[1, (source) => paramBinary(new Uint8Array(source.draw(bytes({ min: 0, max: 300 }))))]
])

/** A statement of the case: unnamed, or run as one of the case's server statements, with its parameters. */
type StatementSpec =
	| { readonly kind: "unnamed"; readonly params: ReadonlyArray<Param> }
	| { readonly kind: "named"; readonly server: number; readonly params: ReadonlyArray<Param> }

const statementGen: Gen<StatementSpec> = (source) => {
	const params = source.draw(array(paramGen, { min: 0, max: 4 }))
	return source.draw(boolean)
		? { kind: "named", server: source.draw(int(0, servers.length - 1)), params }
		: { kind: "unnamed", params }
}

/** How the case's call sends its statements (wire/batch.ts). */
type Runner = "apart" | "transaction" | "alongside" | "framed" | "framedTwice"

const runners: Arr.NonEmptyReadonlyArray<Runner> = [
	"apart",
	"transaction",
	"alongside",
	"framed",
	"framedTwice"
]

/** Where the bound falls about the flight it is drawn by: a drawn distance short of its bytes, at them, or past them. */
type LimitAt = "short of" | "at" | "past"

interface FlightCase {
	readonly runner: Runner
	/** The server statements the history's first flight parses. */
	readonly parsed: ReadonlyArray<number>
	/** Those of them released after it, so the case's flight closes their names in front of it. */
	readonly released: ReadonlyArray<number>
	/** The call's statements: alone for apart and alongside, and the first flight's for framedTwice. */
	readonly first: Arr.NonEmptyReadonlyArray<StatementSpec>
	/** The transaction's statements for alongside, and the second flight's for framedTwice. */
	readonly second: ReadonlyArray<StatementSpec>
	/** The flight of framedTwice the bound is drawn by. */
	readonly by: "first" | "second"
	readonly at: LimitAt
	readonly distance: number
}

const caseGen: Gen<FlightCase> = (source) => {
	const parsed = source.draw(
		subset(
			Arr.makeBy(servers.length, (k) => k),
			{ min: 0, max: servers.length }
		)
	)
	return {
		runner: source.draw(element(runners)),
		parsed,
		released: source.draw(subset(parsed, { min: 0, max: parsed.length })),
		first: [source.draw(statementGen), ...source.draw(array(statementGen, { min: 0, max: 3 }))],
		second: source.draw(array(statementGen, { min: 0, max: 3 })),
		by: source.draw(element<FlightCase["by"]>(["first", "second"])),
		at: source.draw(element<LimitAt>(["short of", "at", "past"])),
		distance: source.draw(int(1, 64))
	}
}

/** A statement of a transaction: unnamed, with the first server statement's text, or run as its server statement. */
const named = (spec: StatementSpec): FlightStatement => {
	switch (spec.kind) {
		case "unnamed":
			return { sql: serverAt(0).sql, params: spec.params }
		case "named":
			return { server: serverAt(spec.server), params: spec.params }
	}
}

/** A statement alone, which runs unnamed: its server statement's text, or the first one's. */
const alone = (spec: StatementSpec): BatchStatement => ({
	sql: serverAt(spec.kind === "named" ? spec.server : 0).sql,
	params: spec.params
})

const write: Transaction = { access: "readWrite", end: "COMMIT" }

/** The transaction statements apart run in front of, read-only, as admission's fence is (admission/admit.ts). */
const readOnly: Transaction = { access: "readOnly", end: "COMMIT" }

/** The case's call on `session`. */
const callOf = (
	c: FlightCase,
	session: Session
): Effect.Effect<void, FlightFailure | ApartFailure> => {
	const second = Arr.map(c.second, named)
	switch (c.runner) {
		case "apart":
			return Effect.asVoid(runApart(session, Arr.map(c.first, alone)))
		case "transaction":
			return Effect.asVoid(runTransaction(session, Arr.map(c.first, named), write))
		case "alongside":
			return Effect.flatMap(
				runAlongside(session, Arr.map(c.first, alone), second, readOnly),
				(both) => Effect.asVoid(Effect.fromResult(both.framed))
			)
		case "framed":
			return Effect.asVoid(runFramed(session, writeFrame(flightPrologue), Arr.map(c.first, named)))
		case "framedTwice":
			return Effect.asVoid(
				runFramedTwice(session, writeFrame(flightPrologue), Arr.map(c.first, named), () =>
					Effect.succeed(second)
				)
			)
	}
}

/** The queries a framed flight opens with: BEGIN, then the prologue's fence and its entry. */
const opening: ReadonlyArray<"begin" | NamedStatement> = [
	"begin",
	flightPrologue.fence,
	flightPrologue.enter
]

/**
 * The messages of a framedTwice call's first flight, from the server's record of the whole call: its Closes, then its
 * opening and its statements, through the Sync of the last of them; each query ends with a Sync, or is one Query.
 */
const firstFlightOf = (c: FlightCase, read: ReadonlyArray<Read>): ReadonlyArray<Read> => {
	let ends = opening.length + c.first.length
	const out: Array<Read> = []
	for (const message of read) {
		if (ends === 0) {
			break
		}
		out.push(message)
		if (message.type === "S" || message.type === "Q") {
			ends -= 1
		}
	}
	return out
}

/** A session over a new server, in the case's scope, with the case's history written and its server's record marked. */
const historied = (
	c: FlightCase
): Effect.Effect<
	{ readonly session: Session; readonly server: WireServer; readonly mark: number },
	ConnectRefusal | BatchFailure | InputTooLarge,
	Scope.Scope
> =>
	Effect.gen(function* () {
		const server = yield* WireServer.opened
		const session = yield* connectSession(
			parsedConnection(
				{
					driver: pgDriver,
					transport: server.transport,
					database: "flight",
					password: noPassword,
					connectTimeoutMs: testConnectTimeout.value
				},
				"flight"
			)
		)
		if (Arr.isReadonlyArrayNonEmpty(c.parsed)) {
			yield* runTransaction(
				session,
				Arr.map(c.parsed, (k) => ({ server: serverAt(k), params: [] })),
				write
			)
		}
		session.statements.release(Arr.map(c.released, serverAt))
		return { session, server, mark: server.read.length }
	})

/** The typed failure of a call that failed, or none for one that succeeded; a defect or an interruption fails the case. */
const failureOf = (
	exit: Exit.Exit<void, FlightFailure | ApartFailure>
): Option.Option<FlightFailure | ApartFailure> => {
	if (Exit.isSuccess(exit)) {
		return Option.none()
	}
	const failure = Cause.findErrorOption(exit.cause)
	assert.ok(
		Option.isSome(failure),
		`the call fails with a typed error, not ${Cause.pretty(exit.cause)}`
	)
	return failure
}

type FlightFeature =
	| `${Runner}: refused`
	| `${Runner}: admitted`
	| "admitted at exactly the bound"
	| "refused at the second flight"
	| "Closes in front of the flight"
	| "a statement bound to its earlier Parse"

const features: Arr.NonEmptyReadonlyArray<FlightFeature> = [
	"admitted at exactly the bound",
	"refused at the second flight",
	"Closes in front of the flight",
	"a statement bound to its earlier Parse",
	...Arr.flatMap(runners, (r): ReadonlyArray<FlightFeature> => [`${r}: refused`, `${r}: admitted`])
]

describe("the flight bound", () => {
	it.effect(
		"refuses a flight longer than one write carries before any byte of it is written, and writes every other whole",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/adapter/flight-bound",
						draw: drawn(caseGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "the wire: every message a twin session's server reads of the same call under the production bound"
						},
						coverage: required<FlightFeature>(features, { cases: 160, sense: notesOnly }),
						kept: [],
						runs: 160,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.scoped(
							Effect.gen(function* () {
								const twin = yield* historied(c)
								yield* callOf(c, twin.session)
								const wire = twin.server.read.slice(twin.mark)
								const flights =
									c.runner === "framedTwice"
										? [firstFlightOf(c, wire), wire.slice(firstFlightOf(c, wire).length)]
										: [wire]
								const drawnBy = defined(
									flights[c.by === "second" && c.runner === "framedTwice" ? 1 : 0],
									"the flight the bound is drawn by"
								)
								const measured = bytesOf(drawnBy)
								const limit =
									c.at === "short of"
										? Math.max(0, measured - c.distance)
										: c.at === "at"
											? measured
											: measured + c.distance
								if (wire[0]?.type === "C") {
									k.note("Closes in front of the flight")
								}
								if (Arr.some(wire, (m, i) => m.type === "B" && wire[i - 1]?.type !== "P")) {
									k.note("a statement bound to its earlier Parse")
								}

								const subject = yield* historied(c)
								const bounded: Session = { ...subject.session, flightMaxBytes: limit }
								const exit = yield* Effect.exit(callOf(c, bounded))
								const failure = failureOf(exit)
								const read = subject.server.read.slice(subject.mark)
								const refusedAt = Arr.findFirstIndex(flights, (flight) => bytesOf(flight) > limit)
								if (Option.isNone(refusedAt)) {
									assert.ok(
										Option.isNone(failure),
										`a call whose every flight fits ${limit} bytes is admitted`
									)
									assert.deepEqual(read, wire, "an admitted call is written whole, as the twin's")
									k.note(`${c.runner}: admitted`)
									if (Arr.some(flights, (flight) => bytesOf(flight) === limit)) {
										k.note("admitted at exactly the bound")
									}
									return
								}
								const refused = defined(flights[refusedAt.value], "the refused flight")
								assert.ok(
									Option.isSome(failure) && failure.value instanceof InputTooLarge,
									"a flight past its bound is refused as InputTooLarge"
								)
								if (Option.isSome(failure) && failure.value instanceof InputTooLarge) {
									assert.deepEqual(failure.value.bound, {
										kind: "flight",
										bytes: bytesOf(refused),
										limit
									})
								}
								k.note(`${c.runner}: refused`)
								if (refusedAt.value === 0) {
									assert.deepEqual(
										read,
										[],
										"a refused flight writes nothing, and no ROLLBACK follows it"
									)
									yield* callOf(c, subject.session)
									assert.deepEqual(
										subject.server.read.slice(subject.mark),
										wire,
										"the refusal left the session's statements as they were"
									)
									return
								}
								k.note("refused at the second flight")
								const opened = defined(flights[0], "the first flight")
								assert.deepEqual(
									read.slice(0, opened.length),
									[...opened],
									"the first flight is written whole"
								)
								assert.deepEqual(
									Arr.map(read.slice(opened.length), (m) => [m.type, m.text]),
									[["Q", controlText({ kind: "end", end: "ROLLBACK" })]],
									"the refused second flight writes nothing, and its transaction is rolled back"
								)
								assert.ok(!subject.server.open, "no transaction is left open")
							})
						)
				)
			)
	)
})

/**
 * Where the server resets the connection from its end: before the call's flight is written, so its write fails before
 * any byte of it left the process, or once it has read the call's COMMIT whole and run it, before answering it.
 */
type ResetCase = {
	readonly flight: FlightCase
	readonly reset: Reset
}

/**
 * How the call's connection breaks: the client's write side shut, so its write fails before any byte of it leaves; the
 * server's reset right before the call, which reaches the client before its write or after it; or the server's reset
 * once it read the call's COMMIT whole and ran it, which it never answers.
 */
type Reset = "write side shut" | "reset before the flight" | "reset after COMMIT ran"

const resets: Arr.NonEmptyReadonlyArray<Reset> = [
	"write side shut",
	"reset before the flight",
	"reset after COMMIT ran"
]

const resetGen: Gen<ResetCase> = (source) => ({
	flight: source.draw(caseGen),
	reset: source.draw(element(resets))
})

/** A call's outcome as the search reads it: answered whole, or the tag of its failure. */
type Outcome = "answered" | "ConnectionLost" | "CommitLost"

/**
 * The outcomes each break may leave each call, the oracle's: a write that failed before any byte of it left is a lost
 * connection, since nothing ran; a reset before the flight is that, or, when the write went out before the reset reached
 * the client, a commit of unknown fate wherever the call carries COMMIT, though the server read nothing; and a COMMIT
 * that ran unanswered is a commit of unknown fate, but for statements apart, which meet none and are answered whole,
 * and statements apart in front of a read-only transaction, which fail as a lost connection when the reset reached the
 * client before their answers did.
 */
const outcomes: { readonly [B in Reset]: { readonly [R in Runner]: ReadonlyArray<Outcome> } } = {
	"write side shut": {
		apart: ["ConnectionLost"],
		alongside: ["ConnectionLost"],
		transaction: ["ConnectionLost"],
		framed: ["ConnectionLost"],
		framedTwice: ["ConnectionLost"]
	},
	"reset before the flight": {
		apart: ["ConnectionLost"],
		alongside: ["ConnectionLost"],
		transaction: ["ConnectionLost", "CommitLost"],
		framed: ["ConnectionLost", "CommitLost"],
		framedTwice: ["ConnectionLost"]
	},
	"reset after COMMIT ran": {
		apart: ["answered"],
		alongside: ["ConnectionLost", "CommitLost"],
		transaction: ["CommitLost"],
		framed: ["CommitLost"],
		framedTwice: ["CommitLost"]
	}
}

type ResetFeature = `${Runner}: ${Reset}`

const resetFeatures: Arr.NonEmptyReadonlyArray<ResetFeature> = Arr.flatMap(resets, (b) =>
	Arr.map(runners, (r): ResetFeature => `${r}: ${b}`)
)

describe("a flight whose connection is reset", () => {
	it.effect(
		"is a lost connection when its write failed before its last byte left, and a commit of unknown fate only once COMMIT could have run",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/adapter/flight-reset",
						draw: drawn(resetGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "the wire: whether the server read the call's COMMIT whole and ran it"
						},
						coverage: required<ResetFeature>(resetFeatures, { cases: 120, sense: notesOnly }),
						kept: [],
						runs: 120,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ flight: c, reset }, k) =>
						Effect.scoped(
							Effect.gen(function* () {
								const subject = yield* historied(c)
								const committed = subject.server.committed
								const exit = yield* Effect.exit(
									Effect.suspend(() => {
										switch (reset) {
											case "write side shut":
												subject.server.shutClients()
												break
											case "reset before the flight":
												subject.server.resetNow()
												break
											case "reset after COMMIT ran":
												subject.server.resetAt = "commit"
												break
										}
										return callOf(c, subject.session)
									})
								)
								const failure = failureOf(exit)
								const outcome: Outcome = Option.match(failure, {
									onNone: (): Outcome => "answered",
									onSome: (f): Outcome => {
										assert.ok(
											f._tag === "ConnectionLost" || f._tag === "CommitLost",
											`a broken connection is lost, or a commit of unknown fate: ${f._tag}`
										)
										return f._tag
									}
								})
								const ran = subject.server.committed - committed
								const read = subject.server.read.slice(subject.mark)
								k.note(`${c.runner}: ${reset}`)
								assert.ok(
									Arr.contains(outcomes[reset][c.runner], outcome),
									`${reset}, ${c.runner} may end ${Arr.join(outcomes[reset][c.runner], " or ")}, not ${outcome}`
								)
								switch (reset) {
									case "write side shut":
									case "reset before the flight":
										assert.deepEqual(read, [], "the server read nothing of the call")
										assert.equal(ran, 0, "nothing of the call ran")
										return
									case "reset after COMMIT ran":
										assert.equal(
											ran,
											outcome === "answered" ? 0 : 1,
											"the server read the call's COMMIT whole and ran it"
										)
										return
								}
							})
						)
				)
			)
	)
})
