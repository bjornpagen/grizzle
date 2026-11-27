/** What the properties of flight-bound.test.ts read: its spaces, models and helpers. */

import { Buffer } from "node:buffer"
import { createServer, type Server, Socket } from "node:net"
import { TLSSocket } from "node:tls"
import { assert, defined } from "@bjornpagen/testing/assert"
import {
	array,
	bytes,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	Option,
	Result,
	type Scope,
	String as Str
} from "effect"
import pgDriver from "pg"
import type { BatchFailure, ConnectRefusal, InputTooLarge } from "#adapter/errors/failures.ts"
import type { Transport } from "#adapter/types/layer.ts"
import {
	type ApartFailure,
	type BatchStatement,
	excludesNothing,
	type FlightFailure,
	oneShotStatement,
	type PreparedStatement,
	preparedStatement,
	runAlongside,
	runApart,
	runFramed,
	runTransaction,
	type Transaction,
	type Uncommitting,
	writeFrame
} from "#adapter/wire/batch.ts"
import { connectSession, type Session } from "#adapter/wire/session.ts"
import { prepared } from "#compiler/core/prepared.ts"
import type { Param } from "#compiler/core/wire.ts"
import { servedSession } from "#compiler/program/served.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import { flightPrologue } from "#test/support/flight/model.ts"
import { tlsMaterial } from "#test/support/memory-tls.ts"
import { noPassword } from "#test/support/pg.ts"
import { parsedConnection } from "#test/support/pg.ts"
import { testSql } from "#test/support/sql.ts"
import { paramBinary, paramText } from "#test/support/wire.ts"

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

const nothing = Object.freeze(new Uint8Array(0))
const authenticationOk = frame("R", int32(0))
const backendKeyData = frame("K", Buffer.concat([int32(1), int32(7)]))
const parseComplete = frame("1", nothing)
const bindComplete = frame("2", nothing)
const closeComplete = frame("3", nothing)
const noData = frame("n", nothing)
const commandComplete = (tag: string): Buffer => frame("C", Buffer.from(`${tag}\0`, "latin1"))
const readyForQuery = (open: boolean): Buffer => frame("Z", Buffer.from(open ? "T" : "I", "latin1"))

/**
 * One frontend message the server read past the startup: its type, its bytes on the wire, the text of a Query or of a
 * Parse, the statement's, and the name of the statement a Parse prepares or a Bind binds, empty for the unnamed one.
 */
interface Read {
	readonly type: string
	readonly bytes: number
	readonly text: string
	readonly name: string
}

/** The text a Query or a Parse carries, a Parse's after its statement's name; none for every other message. */
const messageText = (type: string, body: Buffer): string => {
	if (type === "Q") {
		return body.toString("utf8", 0, body.length - 1)
	}
	if (type !== "P") {
		return ""
	}
	const name = body.indexOf(0)
	return body.toString("utf8", name + 1, body.indexOf(0, name + 1))
}

/**
 * The name of the statement a Parse prepares, its first field, or a Bind binds, its second after the portal's; empty
 * for every other message.
 */
const messageName = (type: string, body: Buffer): string => {
	if (type === "P") {
		return body.toString("latin1", 0, body.indexOf(0))
	}
	if (type !== "B") {
		return ""
	}
	const portal = body.indexOf(0)
	return body.toString("latin1", portal + 1, body.indexOf(0, portal + 1))
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
					text: messageText(type, body),
					name: messageName(type, body)
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

/**
 * The bytes of `flight` as pg writes it on a new connection, from `wire`, the server's record of the whole call the
 * flight is part of: the flight's own messages, and the Parse `wire` carries of each statement name the flight binds
 * but does not parse, its connection having parsed the name in an earlier flight, since pg sends that Parse at the
 * name's first statement on a connection that has not.
 */
export const newConnectionBytesOf = (
	flight: ReadonlyArray<Read>,
	wire: ReadonlyArray<Read>
): number => {
	const parses = new Map(
		Arr.map(
			Arr.filter(wire, (m) => m.type === "P"),
			(m): readonly [string, number] => [m.name, m.bytes]
		)
	)
	const parsed = new Set(
		Arr.map(
			Arr.filter(flight, (m) => m.type === "P"),
			(m) => m.name
		)
	)
	const unparsed = new Set(
		Arr.map(
			Arr.filter(flight, (m) => m.type === "B" && !parsed.has(m.name)),
			(m) => m.name
		)
	)
	return Arr.reduce(
		Arr.fromIterable(unparsed),
		bytesOf(flight),
		(sum, name) =>
			sum +
			defined(parses.get(name), "the Parse an earlier flight carried of a name the flight binds")
	)
}

/**
 * The flight of a call the bound is drawn by, from `wire`, the server's record of the whole call: every runner's one
 * flight, or for statements alone in front of a transaction (runAlongside) its first, every message but the second's,
 * the transaction's end alone, one simple Query, which the first, the longer, never outweighs.
 */
export const boundFlightOf = (c: FlightCase, wire: ReadonlyArray<Read>): ReadonlyArray<Read> =>
	c.runner === "alongside" ? wire.slice(0, -1) : wire

/** The case's statement text, padded with a trailing comment of `pad`. */
const textOf = (pad: string): string => `SELECT $1::text AS s -- ${pad}`

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

/** A statement of the case: the case's text padded with `pad`, and its parameters. */
interface StatementSpec {
	readonly pad: string
	readonly params: ReadonlyArray<Param>
}

/** A statement of padding `pads` and parameters `params`. */
const statementOf =
	(pads: Gen<string>, params: Gen<ReadonlyArray<Param>>): Gen<StatementSpec> =>
	(source) => ({ pad: source.draw(pads), params: source.draw(params) })

/** A statement of the bound's cases: unpadded, with drawn parameters. */
const statementGen: Gen<StatementSpec> = statementOf(
	constant(""),
	array(paramGen, { min: 0, max: 4 })
)

/** How the case's call sends its statements (wire/batch.ts). */
type Runner = "apart" | "transaction" | "alongside" | "framed"

const runners: Arr.NonEmptyReadonlyArray<Runner> = ["apart", "transaction", "alongside", "framed"]

/** Where the bound falls about the flight it is drawn by: a drawn distance short of its bytes, at them, or past them. */
type LimitAt = "short of" | "at" | "past"

interface FlightCase {
	readonly runner: Runner
	/** The call's statements: alone for apart and alongside. */
	readonly first: Arr.NonEmptyReadonlyArray<StatementSpec>
	/** The transaction's statements for alongside. */
	readonly second: ReadonlyArray<StatementSpec>
	readonly at: LimitAt
	readonly distance: number
}

export const caseGen: Gen<FlightCase> = (source) => ({
	runner: source.draw(element(runners)),
	first: [source.draw(statementGen), ...source.draw(array(statementGen, { min: 0, max: 3 }))],
	second: source.draw(array(statementGen, { min: 0, max: 3 })),
	at: source.draw(element<LimitAt>(["short of", "at", "past"])),
	distance: source.draw(int(1, 64))
})

/** A statement of the case as a login's own flight sends it, one-shot. */
const statementOfSpec = (spec: StatementSpec): BatchStatement =>
	oneShotStatement(testSql(textOf(spec.pad)), spec.params)

/** A statement of the case as a Db call's flight sends it, a served one: its text named, parsed once per flight. */
const servedOfSpec = (spec: StatementSpec): PreparedStatement =>
	preparedStatement(prepared(testSql(textOf(spec.pad))), spec.params)

const write: Transaction = { access: "readWrite", isolation: "serializable", end: "COMMIT" }

/** The transaction statements apart run in front of, read-only, as admission's fence is (admission/admit.ts). */
const readOnly: Uncommitting = { access: "readOnly", end: "COMMIT" }

/** The case's call on `session`. */
export const boundCallOf = (
	c: FlightCase,
	session: Session
): Effect.Effect<void, FlightFailure | ApartFailure> => {
	switch (c.runner) {
		case "apart":
			return Effect.asVoid(runApart(session, Arr.map(c.first, statementOfSpec)))
		case "transaction":
			return Effect.asVoid(runTransaction(session, Arr.map(c.first, statementOfSpec), write))
		case "alongside":
			return Effect.flatMap(
				runAlongside(
					session,
					Arr.map(c.first, statementOfSpec),
					Arr.map(c.second, statementOfSpec),
					() => Result.succeed({ statements: [], value: undefined }),
					readOnly
				),
				(both) =>
					Effect.asVoid(
						Effect.fromResult(
							Result.flatMap(both.framed, (opened) =>
								Result.flatMap(opened.made, (made) => made.second)
							)
						)
					)
			)
		case "framed":
			return Effect.asVoid(
				runFramed(
					session,
					writeFrame(flightPrologue, "serializable", excludesNothing, noAdvice),
					Arr.map(c.first, servedOfSpec)
				)
			)
	}
}

/** A session over a new server, in the case's scope, its server's record marked. */
export const historied: Effect.Effect<
	{ readonly session: Session; readonly server: WireServer; readonly mark: number },
	ConnectRefusal | BatchFailure | InputTooLarge,
	Scope.Scope
> = Effect.gen(function* () {
	const server = yield* WireServer.opened
	const session = yield* connectSession({
		...parsedConnection(
			{
				driver: pgDriver,
				transport: server.transport,
				database: "flight",
				password: noPassword
			},
			"flight"
		),
		controls: servedSession
	})
	return { session, server, mark: server.read.length }
})

/** The typed failure of a call that failed, or none for one that succeeded; a defect or an interruption fails the case. */
export const typedFailureOf = (
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

export type BoundFeature =
	| `${Runner}: refused`
	| `${Runner}: admitted`
	| "admitted at exactly the bound"
	| "refused one byte past the bound"

export const features: Arr.NonEmptyReadonlyArray<BoundFeature> = [
	"admitted at exactly the bound",
	"refused one byte past the bound",
	...Arr.flatMap(runners, (r): ReadonlyArray<BoundFeature> => [`${r}: refused`, `${r}: admitted`])
]

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

export const resetGen: Gen<ResetCase> = (source) => ({
	flight: source.draw(caseGen),
	reset: source.draw(element(resets))
})

/** A call's outcome as the search reads it: answered whole, or the tag of its failure. */
export type Outcome = "answered" | "ConnectionLost" | "CommitLost"

/**
 * The outcomes each break may leave each call, the oracle's: a write that failed before any byte of it left is a lost
 * connection, since nothing ran; a reset before the flight is that, or, when the write went out before the reset reached
 * the client, a commit of unknown fate wherever the call carries COMMIT, though the server read nothing; and a COMMIT
 * that ran unanswered is a commit of unknown fate, but for statements apart, which meet none and are answered whole,
 * and statements apart in front of a read-only transaction, which fail as a lost connection when the reset reached the
 * client before their answers did.
 */
export const outcomes: {
	readonly [B in Reset]: { readonly [R in Runner]: ReadonlyArray<Outcome> }
} = {
	"write side shut": {
		apart: ["ConnectionLost"],
		alongside: ["ConnectionLost"],
		transaction: ["ConnectionLost"],
		framed: ["ConnectionLost"]
	},
	"reset before the flight": {
		apart: ["ConnectionLost"],
		alongside: ["ConnectionLost"],
		transaction: ["ConnectionLost", "CommitLost"],
		framed: ["ConnectionLost", "CommitLost"]
	},
	"reset after COMMIT ran": {
		apart: ["answered"],
		alongside: ["ConnectionLost", "CommitLost"],
		transaction: ["CommitLost"],
		framed: ["CommitLost"]
	}
}

export type ResetFeature = `${Runner}: ${Reset}`

export const resetFeatures: Arr.NonEmptyReadonlyArray<ResetFeature> = Arr.flatMap(resets, (b) =>
	Arr.map(runners, (r): ResetFeature => `${r}: ${b}`)
)

/**
 * A call whose statements' texts are padded about a test-sized message bound: the bound's case, its statements
 * parameterless, so every Bind is shorter than every Parse, and no history, so every statement parses.
 */
export const parseCaseGen: Gen<FlightCase> = (source) => {
	const padded = statementOf(
		string(
			weighted([
				[3, codePoint(0x20, 0x7e)],
				[1, codePoint(0xa0, 0xd7_ff)],
				[1, codePoint(0x1_00_00, 0x10_ff_ff)]
			]),
			{ min: 150, max: 400 }
		),
		constant([])
	)
	return {
		runner: source.draw(element(runners)),
		first: [source.draw(padded), ...source.draw(array(padded, { min: 0, max: 3 }))],
		second: source.draw(array(padded, { min: 0, max: 3 })),
		at: source.draw(element<LimitAt>(["short of", "at", "past"])),
		distance: source.draw(int(1, 64))
	}
}

/** A Parse's length as its length word counts it, from the bytes the server read of it, its type byte among them. */
export const lengthOf = (message: Read): number => message.bytes - 1

export type ParseFeature =
	| `${Runner}: Parse refused`
	| `${Runner}: Parse admitted`
	| "refused within the Parse's fields"
	| "admitted at exactly the bound"

export const parseFeatures: Arr.NonEmptyReadonlyArray<ParseFeature> = [
	"refused within the Parse's fields",
	"admitted at exactly the bound",
	...Arr.flatMap(runners, (r): ReadonlyArray<ParseFeature> => [
		`${r}: Parse refused`,
		`${r}: Parse admitted`
	])
]
