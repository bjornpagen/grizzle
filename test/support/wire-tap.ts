import { Buffer } from "node:buffer"
import { connect as netConnect } from "node:net"
import { Duplex } from "node:stream"
import { type TLSSocket, connect as tlsConnect } from "node:tls"
import { Array as Arr, Deferred, Effect, Exit, type Redacted, type Scope } from "effect"
import type { ConnectRefusal } from "#adapter/errors/failures.ts"
import { connectSession, type Session } from "#adapter/wire/session.ts"
import type { InitializedClusterShape } from "#test/support/cluster.ts"
import { pgPin } from "#test/support/env.ts"

/**
 * A protocol tap: a driver session that runs over a plaintext view of its own TLS connection, so a test reads every
 * message in both directions and counts round trips, Syncs and ReadyForQuery messages on the wire.
 *
 * The tap sets the transport up as a driver does, SSLRequest then verify-full TLS against the cluster's CA, and hands
 * the driver the decrypted side as its stream, with TLS off in the driver, so the driver writes and reads plaintext
 * through it: the adapter's sessions take it as their `stream` transport (packages/grizzle/src/adapter/wire/session.ts Transport). Every
 * CancelRequest a session sends opens a connection of its own through the same factory; the tap counts those.
 *
 * A round trip is a turn of the conversation: the client writes after it has read something since its last write.
 * Writes in a row with no read between them, a pipeline, count once. The tap hands each write to TLS as it is made, as
 * a socket hands it to the kernel, so writes the driver makes in one turn reach the server, and the tap's record,
 * before any answer is read.
 *
 * The gate holds the server's bytes on their way to the session: once a given number of backend messages (of one type,
 * or any) have reached the driver, every later byte waits in the tap until the test releases it, the end of the
 * connection included. The server runs on meanwhile; only what the client has read stops. So a test can interrupt a
 * call after exactly k answers, with the server having done all it can, and then let the rest through.
 *
 * One frontend message: its type byte; the statement it names for Parse, Bind and Close ("" for the unnamed one and for
 * every other type); and the SQL text of a Parse or a simple Query ("" for every other type). The untyped startup
 * packet is "startup".
 */
export interface FrontendMessage {
	readonly type: string
	readonly name: string
	readonly text: string
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

export const frontendCount = (window: WireWindow, type: string): number =>
	Arr.filter(window.frontend, (message) => message.type === type).length

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
			frontend.push(...event.messages)
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
export const queryTexts = (window: WireWindow): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter(window.frontend, (message) => message.type === "Q"),
		(message) => message.text
	)

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
 * The plaintext side of a connection, shaped as pg expects the stream it is given to be: like a socket, with `connect`,
 * which pg calls once and which only reports the connection, since the tap connects when it is made.
 */
class TappedSocket extends Duplex {
	connect(): this {
		process.nextTick(() => this.emit("connect"))
		return this
	}
	setNoDelay(): this {
		return this
	}
	ref(): this {
		return this
	}
	unref(): this {
		return this
	}
}

/**
 * What carries the server's bytes to the driver: straight through, or through a gate. `push` hands the driver bytes,
 * or null for the end of the connection.
 */
interface Carrier {
	readonly data: (chunk: Buffer, push: (bytes: Buffer | null) => void) => void
	readonly end: (push: (bytes: Buffer | null) => void) => void
}

const straight: Carrier = {
	data: (chunk, push) => {
		push(chunk)
	},
	end: (push) => {
		push(null)
	}
}

/** The backend messages a gate counts: every one, or those of one type (its message code, such as "Z"). */
export type Counted = { readonly kind: "any" } | { readonly kind: "type"; readonly type: string }

/** The gate on the server's bytes to one session (see the header). */
export interface Gate {
	/**
	 * Lets `count` more backend messages reach the driver, of any type or of the one type given, and holds every byte
	 * after the last of them until `release`. A count of 0 holds at once.
	 */
	readonly hold: (count: number, of: Counted) => void
	/** Resolves once the gate holds. */
	readonly holding: Effect.Effect<void>
	/** Hands the driver every byte held, and every later one as it arrives. */
	readonly release: () => void
	/**
	 * How many backend messages of a type (its message code, such as "Z") have reached the driver whole. The driver
	 * reads each as it arrives, so it has read every one counted.
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
	#push: (bytes: Buffer | null) => void = () => undefined
	readonly #delivered = new Map<string, number>()

	readonly delivered = (type: string): number => this.#delivered.get(type) ?? 0

	readonly hold = (count: number, of: Counted): void => {
		this.#reached = Deferred.makeUnsafe<void>()
		if (count > 0) {
			this.#armed = { remaining: count, of }
			return
		}
		this.#armed = undefined
		this.#held ??= []
		Deferred.doneUnsafe(this.#reached, Exit.void)
	}

	readonly holding: Effect.Effect<void> = Effect.suspend(() => Deferred.await(this.#reached))

	readonly release = (): void => {
		const held = this.#held ?? []
		this.#held = undefined
		this.#armed = undefined
		for (const piece of held) {
			if (piece === null) {
				this.#push(null)
			} else {
				this.data(piece, this.#push)
			}
		}
	}

	readonly data = (chunk: Buffer, push: (bytes: Buffer | null) => void): void => {
		this.#push = push
		if (this.#held !== undefined) {
			this.#held.push(chunk)
			return
		}
		const carried = this.#partial.length
		const bytes = Buffer.concat([this.#partial, chunk])
		let offset = 0
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
			this.#delivered.set(type, this.delivered(type) + 1)
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
			push(chunk)
			return
		}
		this.#partial = Buffer.alloc(0)
		this.#armed = undefined
		const rest = chunk.subarray(split - carried)
		this.#held = rest.length === 0 ? [] : [rest]
		push(chunk.subarray(0, split - carried))
		Deferred.doneUnsafe(this.#reached, Exit.void)
	}

	readonly end = (push: (bytes: Buffer | null) => void): void => {
		this.#push = push
		if (this.#held === undefined) {
			push(null)
		} else {
			this.#held.push(null)
		}
	}
}

/**
 * The plaintext side of one TLS connection to `port`. Writes wait until the TLS session is up; `onWrite` and `onRead`
 * see every chunk in each direction, and `carrier` hands the read ones to the driver.
 */
const tlsStream = (
	port: number,
	ca: string,
	onWrite: (chunk: Uint8Array) => void,
	onRead: (chunk: Uint8Array) => void,
	carrier: Carrier
): TappedSocket => {
	let secure: TLSSocket | undefined
	const queued: Array<Uint8Array> = []
	const raw = netConnect({ host: pgPin.host, port, noDelay: true })
	const stream: TappedSocket = new TappedSocket({
		read() {},
		write(chunk: Uint8Array, ...[, callback]) {
			onWrite(chunk)
			if (secure === undefined) {
				queued.push(chunk)
			} else {
				secure.write(chunk)
			}
			callback()
		},
		final(callback) {
			if (secure === undefined) {
				raw.end()
			} else {
				secure.end()
			}
			callback()
		},
		destroy(error, callback) {
			secure?.destroy()
			raw.destroy()
			callback(error)
		}
	})
	raw.on("error", (error) => stream.destroy(error))
	raw.once("connect", () => raw.write(sslRequest))
	raw.once("data", (answer: Buffer) => {
		if (answer.length !== 1 || answer[0] !== 0x53) {
			stream.destroy(new Error("the server refused TLS"))
			return
		}
		const socket = tlsConnect({ socket: raw, ca, servername: pgPin.host, rejectUnauthorized: true })
		const push = (bytes: Buffer | null): void => {
			stream.push(bytes)
		}
		socket.on("data", (chunk: Buffer) => {
			onRead(chunk)
			carrier.data(chunk, push)
		})
		socket.on("end", () => {
			carrier.end(push)
		})
		socket.on("close", () => stream.destroy())
		socket.on("error", (error: Error) => stream.destroy(error))
		socket.once("secureConnect", () => {
			secure = socket
			for (const chunk of queued.splice(0)) {
				socket.write(chunk)
			}
		})
	})
	return stream
}

/** The recorder of one session's traffic to the cluster. */
export interface Tap {
	/**
	 * A new connection: the first is the session, whose traffic the tap records; every later one is a
	 * CancelRequest's, which the tap counts.
	 */
	readonly open: () => TappedSocket
	/** A mark at the end of the traffic so far. */
	readonly mark: () => number
	/** The traffic since `mark`. */
	readonly since: (mark: number) => WireWindow
	/** The connections opened for CancelRequests. */
	readonly cancels: () => number
	/** The CancelRequest connections that have ended: the server read each request and closed it, or it failed. */
	readonly cancelsEnded: () => number
	/** The gate on the server's bytes to the session. */
	readonly gate: Gate
}

export const makeTap = (cluster: InitializedClusterShape): Tap => {
	const port = pgPin.port
	const ca = cluster.caPem
	const events: Array<WireEvent> = []
	const gate = new MessageGate()
	let opened = 0
	let ended = 0
	const open = (): TappedSocket => {
		opened++
		if (opened > 1) {
			const cancelling = tlsStream(
				port,
				ca,
				() => undefined,
				() => undefined,
				straight
			)
			cancelling.once("close", () => {
				ended++
			})
			return cancelling
		}
		let written: Array<FrontendMessage> = []
		const frontend = framer(true, (type, body) =>
			written.push({ type, name: statementName(type, body), text: statementText(type, body) })
		)
		const backend = framer(false, (type, body) =>
			events.push({
				side: "backend",
				message: { type, status: type === "Z" ? cString(body, 0) : "" }
			})
		)
		return tlsStream(
			port,
			ca,
			(chunk) => {
				written = []
				frontend(chunk)
				events.push({ side: "frontend", messages: written })
			},
			backend,
			gate
		)
	}
	return {
		open,
		mark: () => events.length,
		since: (mark) => windowOf(events.slice(mark)),
		cancels: () => Math.max(0, opened - 1),
		cancelsEnded: () => ended,
		gate
	}
}

export interface TapOptions {
	/** The cluster the session reaches, whose CA the tap's TLS verifies. */
	readonly cluster: InitializedClusterShape
	readonly database: string
	readonly role: string
	readonly password: Redacted.Redacted
	readonly applicationName: string
}

export interface Tapped extends Omit<Tap, "open"> {
	readonly session: Session
}

/** An adapter session to the cluster whose traffic the tap records, closed with the scope. */
export const tappedSession = (
	options: TapOptions
): Effect.Effect<Tapped, ConnectRefusal, Scope.Scope> =>
	Effect.suspend(() => {
		const tap = makeTap(options.cluster)
		return Effect.map(
			connectSession({
				host: pgPin.host,
				port: pgPin.port,
				database: options.database,
				role: options.role,
				password: options.password,
				transport: { _tag: "stream", open: tap.open },
				applicationName: options.applicationName
			}),
			(session) => ({
				session,
				mark: tap.mark,
				since: tap.since,
				cancels: tap.cancels,
				cancelsEnded: tap.cancelsEnded,
				gate: tap.gate
			})
		)
	})
