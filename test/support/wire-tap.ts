import { Buffer } from "node:buffer"
import { connect as netConnect } from "node:net"
import { type TLSSocket, connect as tlsConnect } from "node:tls"
import {
	Array as Arr,
	Deferred,
	Effect,
	Exit,
	Option,
	type Redacted,
	type Scope,
	String as Str
} from "effect"
import pgDriver from "pg"
import type { ConnectRefusal } from "#adapter/errors/failures.ts"
import type { Transport } from "#adapter/types/layer.ts"
import { connectSession, type Session } from "#adapter/wire/session.ts"
import { appendAll } from "#compiler/core/array.ts"
import { servedSession } from "#compiler/program/served.ts"
import type { InitializedClusterShape } from "#test/support/cluster.ts"
import { pgPin } from "#test/support/env.ts"
import { testConnectTimeout } from "#test/support/limits.ts"
import { memoryEndpoint, memoryTransport, tlsMaterial } from "#test/support/memory-tls.ts"
import { parsedConnection } from "#test/support/pg.ts"

/**
 * A protocol tap: a session's connection that a test reads every message of in both directions, counting round trips,
 * Syncs and ReadyForQuery messages on the wire, on grizzle's public path.
 *
 * The tap is an ordinary transport (Tap.transport), which grizzle reaches as it reaches any server: each connection's
 * socket is in memory (test/support/memory-tls.ts), whose server end answers grizzle's SSLRequest and terminates its
 * verify-full TLS with the tap's own CA, which the transport names as `ca`. Behind it the tap opens its own verified TLS
 * to the cluster, SSLRequest then verify-full against the cluster's CA, and carries the plaintext between the two. The
 * first connection whose first message is a startup packet is the session the tap records and gates; a connection whose
 * first message is a CancelRequest is counted, and goes to the server as any other; any later session passes straight,
 * recorded in a log of its own (Tap.sessions), so a test reads every session a layer opens, a listening one included.
 *
 * A round trip is a turn of the conversation: the client writes after it has read something since its last write.
 * Writes in a row with no read between them, a pipeline, count once. The tap records each write as it arrives and
 * hands it on to the server's TLS, so writes the driver makes in one turn reach the server, and the tap's record,
 * before any answer is read.
 *
 * The gate holds the server's bytes on their way to the session: once a given number of backend messages (of one type,
 * or any) have reached the driver, every later byte waits in the tap until the test releases it, the end of the
 * connection included. The server runs on meanwhile; only what the client has read stops. A message has reached the
 * driver once the tap's TLS write that ends it has completed: the socket is in memory, so a write reaches the driver
 * in the call that makes it, but a TLS socket writes one chunk at a time, and a write made while an earlier one is
 * unfinished waits for it (memory-tls.ts). So the gate counts a message, and holds, only then, and a test can interrupt
 * a call after exactly k answers it has read, with the server having done all it can, and then let the rest through.
 *
 * One frontend message: its type byte; the statement it names for Parse, Bind and Close ("" for the unnamed one and for
 * every other type); the SQL text of a Parse or a simple Query ("" for every other type); and the parameter values a
 * Bind carries, in order, each a text-format value's UTF-8 text, a binary-format value's bytes as `\x` and their hex,
 * or null for SQL NULL (none for every other type). The untyped startup packet is "startup".
 */
export interface FrontendMessage {
	readonly type: string
	readonly name: string
	readonly text: string
	readonly params: ReadonlyArray<string | null>
}

/** One backend message: its type byte, and the transaction status of a ReadyForQuery ("" for every other type). */
export interface BackendMessage {
	readonly type: string
	readonly status: string
}

/**
 * What the session connection carried, in order: each write the driver made, with the messages it held, and each
 * message the server sent.
 */
export type WireEvent =
	| { readonly side: "frontend"; readonly messages: ReadonlyArray<FrontendMessage> }
	| { readonly side: "backend"; readonly message: BackendMessage }

/** The traffic between two marks. */
export interface WireWindow {
	readonly events: ReadonlyArray<WireEvent>
	/** The driver's writes. */
	readonly writes: number
	readonly roundTrips: number
	readonly frontend: ReadonlyArray<FrontendMessage>
	readonly backend: ReadonlyArray<BackendMessage>
}

export const backendCount = (window: WireWindow, type: string): number =>
	Arr.filter(window.backend, (message) => message.type === type).length

const windowOf = (events: ReadonlyArray<WireEvent>): WireWindow => {
	let roundTrips = 0
	let readSinceWrite = true
	const frontend: Array<FrontendMessage> = []
	const backend: Array<BackendMessage> = []
	for (const event of events) {
		if (event.side === "frontend") {
			if (readSinceWrite) {
				roundTrips++
			}
			readSinceWrite = false
			appendAll(frontend, event.messages)
		} else {
			readSinceWrite = true
			backend.push(event.message)
		}
	}
	return {
		events,
		writes: Arr.filter(events, (event) => event.side === "frontend").length,
		roundTrips,
		frontend,
		backend
	}
}

const sslRequest = Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f])

/** The C string at `offset` of `body`. */
const cString = (body: Buffer, offset: number): string => {
	const end = body.indexOf(0, offset)
	return body.toString("utf8", offset, end < 0 ? body.length : end)
}

/** The statement a frontend message names: Parse's own name, Bind's after its portal, Close's after its target byte. */
const statementName = (type: string, body: Buffer): string => {
	if (type === "P") {
		return cString(body, 0)
	}
	if (type === "B") {
		return cString(body, body.indexOf(0) + 1)
	}
	if (type === "C" && body[0] === 0x53) {
		return cString(body, 1)
	}
	return ""
}

/**
 * The parameter values a Bind carries (FrontendMessage params): after its portal and statement names, its format codes
 * (none for all text, one for all, or one for each), then each value's length, -1 for NULL, and its bytes.
 */
const bindParams = (type: string, body: Buffer): ReadonlyArray<string | null> => {
	if (type !== "B") {
		return []
	}
	let offset = body.indexOf(0, body.indexOf(0) + 1) + 1
	const formatCount = body.readInt16BE(offset)
	offset += 2
	const formats = Arr.map(Arr.range(0, formatCount - 1), (k) => body.readInt16BE(offset + 2 * k))
	offset += 2 * formatCount
	const count = body.readInt16BE(offset)
	offset += 2
	const values: Array<string | null> = []
	for (let k = 0; k < count; k++) {
		const length = body.readInt32BE(offset)
		offset += 4
		if (length < 0) {
			values.push(null)
			continue
		}
		const bytes = body.subarray(offset, offset + length)
		offset += length
		const format = formats.length === 1 ? formats[0] : formats[k]
		values.push(format === 1 ? `\\x${bytes.toString("hex")}` : bytes.toString("utf8"))
	}
	return values
}

/** The SQL a frontend message carries: a simple Query's text, or a Parse's after its name. */
const statementText = (type: string, body: Buffer): string => {
	if (type === "Q") {
		return cString(body, 0)
	}
	if (type === "P") {
		return cString(body, body.indexOf(0) + 1)
	}
	return ""
}

/** The simple Query texts of a window, in order: the BEGIN, COMMIT and ROLLBACK a flight frames its statements with. */
const queryTexts = (window: WireWindow): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter(window.frontend, (message) => message.type === "Q"),
		(message) => message.text
	)

/** The isolation levels a transaction's BEGIN may name, as its words spell them. */
const isolationLevels = [
	"SERIALIZABLE",
	"REPEATABLE READ",
	"READ COMMITTED",
	"READ UNCOMMITTED"
] as const

/**
 * A flight's transaction as its simple Query texts state it: the isolation level its BEGIN names, or none; whether it
 * is READ ONLY; and whether it ends with COMMIT or ROLLBACK. Two spellings of one transaction read as one frame
 * (BEGIN or START TRANSACTION, modes in any order, comma or space between them, COMMIT or END, ROLLBACK or ABORT), so a
 * property asserts the transaction a call runs in, never the text that opens it.
 */
export type TransactionFrame =
	| {
			readonly kind: "framed"
			readonly isolation: (typeof isolationLevels)[number] | "unstated"
			readonly access: "read only" | "read write"
			readonly end: "commit" | "rollback"
	  }
	| { readonly kind: "unframed"; readonly texts: ReadonlyArray<string> }

/** A text's words, upper case, with no punctuation between them. */
const wordsOf = (text: string): ReadonlyArray<string> =>
	Arr.filter(
		Str.split(Str.toUpperCase(Str.replaceAll(";", " ")(Str.replaceAll(",", " ")(text))), " "),
		Str.isNonEmpty
	)

/** Whether `words` hold `phrase` as consecutive words. */
const holds = (words: ReadonlyArray<string>, phrase: string): boolean => {
	const wanted = Str.split(phrase, " ")
	return Arr.some(Arr.range(0, words.length - 1), (start) =>
		Arr.every(wanted, (word, k) => words[start + k] === word)
	)
}

/**
 * The frame of a window's flight, the structural reader of a flight's transaction: its BEGIN's modes and its end, or
 * `unframed` with its texts when the window holds no BEGIN and end alone.
 */
export const frameOf = (window: WireWindow): TransactionFrame => {
	const texts = queryTexts(window)
	const unframed: TransactionFrame = { kind: "unframed", texts }
	if (texts.length !== 2) {
		return unframed
	}
	const begin = wordsOf(texts[0] ?? "")
	const ending = wordsOf(texts[1] ?? "")[0]
	const opens = begin[0] === "BEGIN" || (begin[0] === "START" && begin[1] === "TRANSACTION")
	const end =
		ending === "COMMIT" || ending === "END"
			? "commit"
			: ending === "ROLLBACK" || ending === "ABORT"
				? "rollback"
				: undefined
	if (!opens || end === undefined) {
		return unframed
	}
	return {
		kind: "framed",
		isolation: Option.getOrElse(
			Arr.findFirst(isolationLevels, (level) => holds(begin, `ISOLATION LEVEL ${level}`)),
			(): "unstated" => "unstated"
		),
		access: holds(begin, "READ ONLY") ? "read only" : "read write",
		end
	}
}

/**
 * Splits a byte stream into protocol messages: `untyped` length-prefixed ones first (the startup packet), then typed
 * ones. A message split across chunks completes with the chunk that ends it.
 */
const framer = (untyped: boolean, onMessage: (type: string, body: Buffer) => void) => {
	let pending = Buffer.alloc(0)
	let first = untyped
	return (chunk: Uint8Array): void => {
		pending = Buffer.concat([pending, chunk])
		for (;;) {
			const header = first ? 4 : 5
			if (pending.length < header) {
				return
			}
			const length = pending.readInt32BE(first ? 0 : 1)
			const total = first ? length : length + 1
			if (pending.length < total) {
				return
			}
			const type = first ? "startup" : String.fromCharCode(pending[0] ?? 0)
			onMessage(type, pending.subarray(header, total))
			pending = pending.subarray(total)
			first = false
		}
	}
}

/**
 * Hands the driver `bytes`, or null for the end of the connection, and calls `written` once bytes have reached it:
 * when the TLS write carrying them has completed. Bytes the connection's end overtakes never reach it, and `written`
 * is never called for them.
 */
type Push = (bytes: Buffer | null, written: () => void) => void

/** What carries the server's bytes to the driver: straight through, or through a gate. */
interface Carrier {
	readonly data: (chunk: Buffer, push: Push) => void
	readonly end: (push: Push) => void
}

const nothingWaits = (): void => undefined

const straight: Carrier = {
	data: (chunk, push) => {
		push(chunk, nothingWaits)
	},
	end: (push) => {
		push(null, nothingWaits)
	}
}

/** The backend messages a gate counts: every one, or those of one type (its message code, such as "Z"). */
type Counted = { readonly kind: "any" } | { readonly kind: "type"; readonly type: string }

/** The gate on the server's bytes to one session (see the header). */
export interface Gate {
	/**
	 * Lets `count` more backend messages reach the driver, of any type or of the one type given, and holds every byte
	 * after the last of them until `release`. A count of 0 holds at once.
	 */
	readonly hold: (count: number, of: Counted) => void
	/** Resolves once the gate holds and every byte it let through has reached the driver. */
	readonly holding: Effect.Effect<void>
	/** Resolves once every byte the gate has let through has reached the driver, at once when nothing is on its way. */
	readonly settled: Effect.Effect<void>
	/** Hands the driver every byte held, and every later one as it arrives. */
	readonly release: () => void
	/**
	 * How many backend messages of a type (its message code, such as "Z") have reached the driver whole, each counted
	 * once the write that ends it has completed: the driver reads a write's bytes in the call that hands them over, so it
	 * has read every one counted.
	 */
	readonly delivered: (type: string) => number
}

class MessageGate implements Carrier, Gate {
	/** The bytes of a message not yet complete, carried to the next chunk to find where messages end. */
	#partial: Buffer = Buffer.alloc(0)
	#armed: { remaining: number; readonly of: Counted } | undefined = undefined
	/** What the gate holds, null for the end of the connection; undefined while it lets everything through. */
	#held: Array<Buffer | null> | undefined = undefined
	#reached = Deferred.makeUnsafe<void>()
	/** The gate holds, and `reached` waits for every write it let through to complete. */
	#settling = false
	/** The writes the gate let through that have not completed. */
	#unwritten = 0
	/** Who waits for every write the gate let through to complete (settled). */
	readonly #waiting = new Set<() => void>()
	#push: Push = () => undefined
	readonly #delivered = new Map<string, number>()

	readonly delivered = (type: string): number => this.#delivered.get(type) ?? 0

	readonly hold = (count: number, of: Counted): void => {
		this.#reached = Deferred.makeUnsafe<void>()
		this.#settling = false
		if (count > 0) {
			this.#armed = { remaining: count, of }
			return
		}
		this.#armed = undefined
		this.#held ??= []
		this.#settle()
	}

	/** The gate holds: `reached` resolves once every write it let through has completed, at once when none is pending. */
	readonly #settle = (): void => {
		this.#settling = true
		this.#check()
	}

	readonly #check = (): void => {
		if (this.#unwritten > 0) {
			return
		}
		if (this.#settling) {
			this.#settling = false
			Deferred.doneUnsafe(this.#reached, Exit.void)
		}
		const waiting = [...this.#waiting]
		this.#waiting.clear()
		for (const resume of waiting) {
			resume()
		}
	}

	readonly settled: Effect.Effect<void> = Effect.callback<void>((resume) => {
		if (this.#unwritten === 0) {
			resume(Effect.void)
			return
		}
		const done = (): void => {
			resume(Effect.void)
		}
		this.#waiting.add(done)
		return Effect.sync(() => {
			this.#waiting.delete(done)
		})
	})

	/** Lets `bytes` through, counting the messages of `types`, the ones they end, once their write has completed. */
	readonly #send = (bytes: Buffer, types: ReadonlyArray<string>): void => {
		this.#unwritten += 1
		this.#push(bytes, () => {
			this.#unwritten -= 1
			for (const type of types) {
				this.#delivered.set(type, this.delivered(type) + 1)
			}
			this.#check()
		})
	}

	readonly holding: Effect.Effect<void> = Effect.suspend(() => Deferred.await(this.#reached))

	readonly release = (): void => {
		const held = this.#held ?? []
		this.#held = undefined
		this.#armed = undefined
		for (const piece of held) {
			if (piece === null) {
				this.#push(null, nothingWaits)
			} else {
				this.data(piece, this.#push)
			}
		}
	}

	readonly data = (chunk: Buffer, push: Push): void => {
		this.#push = push
		if (this.#held !== undefined) {
			this.#held.push(chunk)
			return
		}
		const carried = this.#partial.length
		const bytes = Buffer.concat([this.#partial, chunk])
		let offset = 0
		/** The type of every whole message the bytes let through end. */
		const ended: Array<string> = []
		/**
		 * Every whole message up to the split, or in the chunk when the gate does not hold, reaches the driver.
		 */
		let split: number | undefined
		while (split === undefined && bytes.length - offset >= 5) {
			const total = bytes.readInt32BE(offset + 1) + 1
			if (bytes.length - offset < total) {
				break
			}
			const type = String.fromCharCode(bytes[offset] ?? 0)
			offset += total
			ended.push(type)
			const armed = this.#armed
			if (armed !== undefined && (armed.of.kind === "any" || armed.of.type === type)) {
				armed.remaining -= 1
				if (armed.remaining === 0) {
					split = offset
				}
			}
		}
		if (split === undefined) {
			this.#partial = bytes.subarray(offset)
			this.#send(chunk, ended)
			return
		}
		this.#partial = Buffer.alloc(0)
		this.#armed = undefined
		const rest = chunk.subarray(split - carried)
		this.#held = rest.length === 0 ? [] : [rest]
		this.#send(chunk.subarray(0, split - carried), ended)
		this.#settle()
	}

	readonly end = (push: Push): void => {
		this.#push = push
		if (this.#held === undefined) {
			push(null, nothingWaits)
		} else {
			this.#held.push(null)
		}
	}
}

/** The tap's own connection to the cluster: what it writes the client's plaintext to, and its end. */
interface Upstream {
	readonly write: (chunk: Uint8Array) => void
	readonly destroy: () => void
}

/**
 * The plaintext of one verified TLS connection to the cluster: SSLRequest, then verify-full against the cluster's CA
 * naming the pin's host. Writes made before TLS is up wait for it; `onData` sees every chunk the server sends, `onEnd`
 * its end, and `onClose` the connection's close or failure, after which nothing more arrives.
 */
const upstream = (
	ca: string,
	onData: (chunk: Buffer) => void,
	onEnd: () => void,
	onClose: () => void
): Upstream => {
	let secure: TLSSocket | undefined
	const queued: Array<Uint8Array> = []
	const raw = netConnect({ host: pgPin.host, port: pgPin.port, noDelay: true })
	raw.on("error", onClose)
	raw.once("close", onClose)
	raw.once("connect", () => raw.write(sslRequest))
	raw.once("data", (answer: Buffer) => {
		if (answer.length !== 1 || answer[0] !== 0x53) {
			raw.destroy()
			return
		}
		const socket = tlsConnect({ socket: raw, ca, servername: pgPin.host, rejectUnauthorized: true })
		socket.on("data", onData)
		socket.once("end", onEnd)
		socket.once("close", onClose)
		socket.on("error", onClose)
		socket.once("secureConnect", () => {
			secure = socket
			for (const chunk of queued.splice(0)) {
				socket.write(chunk)
			}
		})
	})
	return {
		write: (chunk) => {
			if (secure === undefined) {
				queued.push(chunk)
			} else {
				secure.write(chunk)
			}
		},
		destroy: () => {
			secure?.destroy()
			raw.destroy()
		}
	}
}

/** The code of a CancelRequest, read from the first message of a connection: its length is 16 and its code 80877102. */
const isCancelRequest = (first: Buffer): boolean =>
	first.length >= 8 && first.readInt32BE(0) === 16 && first.readInt32BE(4) === 80877102

/** The name the tap's server certificate carries, and the transport verifies. */
const tapServername = "grizzle-tap.test"

/** The recorder of one session's traffic to the cluster. */
export interface Tap {
	/**
	 * The transport through the tap: its sockets in memory, its CA the tap's own, verified as any server's. The first
	 * session through it is recorded and gated; every CancelRequest through it is counted.
	 */
	readonly transport: Transport
	/** A mark at the end of the traffic so far. */
	readonly mark: () => number
	/** The traffic since `mark`. */
	readonly since: (mark: number) => WireWindow
	/**
	 * Every session's whole traffic so far, in the order the sessions connected: the gated session first, then each
	 * later session through the transport, which passes straight and is recorded all the same. A CancelRequest's
	 * connection is no session.
	 */
	readonly sessions: () => ReadonlyArray<WireWindow>
	/** The connections opened for CancelRequests. */
	readonly cancels: () => number
	/** The CancelRequest connections that have ended: the server read each request and closed it, or it failed. */
	readonly cancelsEnded: () => number
	/** The gate on the server's bytes to the session. */
	readonly gate: Gate
}

export const makeTap = (cluster: InitializedClusterShape): Tap => {
	const material = tlsMaterial(tapServername)
	const events: Array<WireEvent> = []
	/** Every session's traffic, in the order the sessions connected, the gated one's `events` first. */
	const logs: Array<Array<WireEvent>> = []
	const gate = new MessageGate()
	let recording = false
	let cancels = 0
	let ended = 0
	/**
	 * One connection, its TLS terminated: once its first message says what it is, its plaintext goes to the cluster,
	 * the first session's recorded and gated, and the server's back to it; either side's end ends the other.
	 */
	const serve = (secure: TLSSocket): void => {
		secure.once("data", (first: Buffer) => {
			const cancel = isCancelRequest(first)
			const recorded = !cancel && !recording
			if (recorded) {
				recording = true
			}
			/** Where this connection's traffic is recorded: the gated session's events, a later session's own, or none. */
			const log: Array<WireEvent> | undefined = cancel ? undefined : recorded ? events : []
			if (log !== undefined) {
				logs.push(log)
			}
			if (cancel) {
				cancels++
				secure.once("close", () => {
					ended++
				})
			}
			let closed = false
			const push: Push = (bytes, written) => {
				if (closed || !secure.writable) {
					return
				}
				if (bytes === null) {
					closed = true
					secure.end()
					return
				}
				secure.write(bytes, (error) => {
					if (error === undefined || error === null) {
						written()
					}
				})
			}
			const carrier: Carrier = recorded ? gate : straight
			let written: Array<FrontendMessage> = []
			const frontend = framer(true, (type, body) =>
				written.push({
					type,
					name: statementName(type, body),
					text: statementText(type, body),
					params: bindParams(type, body)
				})
			)
			const backend = framer(false, (type, body) =>
				log?.push({
					side: "backend",
					message: { type, status: type === "Z" ? cString(body, 0) : "" }
				})
			)
			const server = upstream(
				cluster.caPem,
				(chunk) => {
					backend(chunk)
					carrier.data(chunk, push)
				},
				() => {
					carrier.end(push)
				},
				() => {
					carrier.end(push)
				}
			)
			const forward = (chunk: Buffer): void => {
				if (log !== undefined) {
					written = []
					frontend(chunk)
					log.push({ side: "frontend", messages: written })
				}
				server.write(chunk)
			}
			forward(first)
			secure.on("data", forward)
			secure.once("close", server.destroy)
			secure.on("error", server.destroy)
		})
	}
	return {
		transport: memoryTransport(material, memoryEndpoint(material, serve)),
		mark: () => events.length,
		since: (mark) => windowOf(events.slice(mark)),
		sessions: () => Arr.map(logs, (log) => windowOf(log)),
		cancels: () => cancels,
		cancelsEnded: () => ended,
		gate
	}
}

export interface TapOptions {
	/** The cluster the session reaches, whose CA the tap's own TLS to it verifies. */
	readonly cluster: InitializedClusterShape
	readonly database: string
	readonly role: string
	readonly password: Redacted.Redacted
}

export interface Tapped extends Omit<Tap, "transport"> {
	readonly session: Session
}

/** An adapter session to the cluster through a tap that records its traffic, closed with the scope. */
export const tappedSession = (
	options: TapOptions
): Effect.Effect<Tapped, ConnectRefusal, Scope.Scope> =>
	Effect.suspend(() => {
		const tap = makeTap(options.cluster)
		return Effect.map(
			connectSession({
				...parsedConnection(
					{
						driver: pgDriver,
						transport: tap.transport,
						database: options.database,
						password: options.password,
						connectTimeoutMs: testConnectTimeout.value
					},
					options.role
				),
				controls: servedSession
			}),
			(session) => ({
				session,
				mark: tap.mark,
				since: tap.since,
				sessions: tap.sessions,
				cancels: tap.cancels,
				cancelsEnded: tap.cancelsEnded,
				gate: tap.gate
			})
		)
	})
