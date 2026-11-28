/** What the properties of unix-socket.test.ts read: its server, its box and its verdicts. */

import { Buffer } from "node:buffer"
import { createServer, type Server, type Socket } from "node:net"
import { assert } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, FileSystem, Option, type Scope, String as Str } from "effect"
import {
	authenticationOk,
	frame,
	int32,
	readyForQuery,
	reapWindowAnswer
} from "#test/unit/adapter/pool.fixtures.ts"

/**
 * How the server authenticates a startup that reaches it over its Unix socket: `peer`, by the account the kernel names,
 * which asks the client for nothing (as `trust` does), so it answers AuthenticationOk at once; or by a password, which
 * it asks for with the request PostgreSQL sends for the method pg_hba.conf names: AuthenticationCleartextPassword
 * (`cleartext`, pg_hba.conf's password), the salted hash's request, code 5 (`salted hash`, the method PostgreSQL still
 * names for it), or AuthenticationSASL offering SCRAM-SHA-256 (`scram`). The test computes no digest: it only asks.
 */
export type Authentication = "peer" | "cleartext" | "salted hash" | "scram"

/** The authentications pg_hba.conf may name for a `local` line, as the server's request for each branches the client. */
export const authentications: Arr.NonEmptyReadonlyArray<Authentication> = [
	"peer",
	"cleartext",
	"salted hash",
	"scram"
]

/** The request a password method sends: its authentication code and what follows it (a salt, SASL's mechanisms). */
const passwordRequest: { readonly [A in Exclude<Authentication, "peer">]: Buffer } = {
	cleartext: frame("R", int32(3)),
	"salted hash": frame("R", Buffer.concat([int32(5), Buffer.from([1, 2, 3, 4])])),
	scram: frame("R", Buffer.concat([int32(10), Buffer.from("SCRAM-SHA-256\0\0", "latin1")]))
}

/** The codes of the untyped first messages a client may send: SSLRequest, CancelRequest, protocol 3.0's startup. */
const sslRequestCode = 80877103
const cancelRequestCode = 80877102
const protocol30 = 196608

/** A FATAL invalid_password, which the server sends a password it refuses, and then closes the connection. */
const passwordRefused = frame(
	"E",
	Buffer.from("SFATAL\0VFATAL\0C28P01\0Mpassword authentication failed\0\0", "latin1")
)

/** The PasswordMessage's type, p, which carries a password, a salted hash or a SASL response alike. */
const passwordMessage = 0x70

/** The Terminate message's type, X. */
const terminate = 0x58

/** The Sync message's type, S, which ends each statement pg sends on the extended protocol. */
const sync = 0x53

/**
 * What a connection's first message was, as the server read it: an SSLRequest; a CancelRequest, with the key it carries
 * and the bytes the connection carried in all; or a startup packet, with the parameters it names.
 */
export type First =
	| { readonly kind: "sslRequest" }
	| {
			readonly kind: "cancel"
			readonly processId: number
			readonly secretKey: number
			readonly bytes: number
	  }
	| { readonly kind: "startup"; readonly parameters: ReadonlyMap<string, string> }

/** One connection the server accepted: its first message, whether a password message followed it, and its end. */
export interface Accepted {
	first: Option.Option<First>
	passwordSent: boolean
	closed: boolean
	/** The BackendKeyData the server sent it, where it answered its startup ready. */
	key: Option.Option<{ readonly processId: number; readonly secretKey: number }>
}

/** A startup packet's parameters: name and value pairs, each NUL-terminated, the list ending with an empty name. */
const parametersOf = (body: Buffer): ReadonlyMap<string, string> => {
	const texts = Str.split(body.toString("utf8"), "\0")
	const parameters = new Map<string, string>()
	for (let at = 0; at + 1 < texts.length; at += 2) {
		const name = texts[at]
		const value = texts[at + 1]
		if (name === undefined || name === "" || value === undefined) {
			return parameters
		}
		parameters.set(name, value)
	}
	return parameters
}

/**
 * A PostgreSQL server listening on a Unix socket of its own, the socket file `<directory>/.s.PGSQL.<port>` in a
 * directory made for it, which goes with the scope: it reads each connection's first message, untyped; answers a
 * startup by `authentication` (Authentication), ready with a cancellation key of its own for `peer`, or with the
 * password request of its method, after which it records a password message that arrives and refuses it, as
 * PostgreSQL refuses a wrong one (28P01); answers each
 * Sync as PostgreSQL answers the read of a session's reap window, which a pool's session sends first; reads a
 * CancelRequest whole and closes the connection, as PostgreSQL does once it has signalled the backend; and ends a
 * connection on Terminate. An SSLRequest it records and refuses by closing: no Unix socket offers TLS.
 */
export class UnixSocketServer {
	readonly accepted: Array<Accepted> = []
	readonly directory: string
	readonly port: number
	readonly #server: Server
	readonly #sockets: Array<Socket> = []
	readonly #closes = new Set<() => void>()
	#pid = 4100

	constructor(server: Server, directory: string, port: number, authentication: Authentication) {
		this.#server = server
		this.directory = directory
		this.port = port
		server.on("connection", (socket: Socket) => {
			this.#accept(socket, authentication)
		})
	}

	/** A server answering by `authentication`, listening until the scope closes, its directory removed with it. */
	static readonly opened = (
		authentication: Authentication,
		port: number
	): Effect.Effect<UnixSocketServer, never, Scope.Scope | FileSystem.FileSystem> =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* Effect.orDie(fs.makeTempDirectoryScoped({ prefix: "gz-sock-" }))
			return yield* Effect.acquireRelease(
				Effect.callback<UnixSocketServer>((resume) => {
					const server = createServer()
					server.listen(`${directory}/.s.PGSQL.${port}`, () => {
						resume(Effect.succeed(new UnixSocketServer(server, directory, port, authentication)))
					})
				}),
				(opened) =>
					Effect.sync(() => {
						opened.#server.close()
						for (const socket of opened.#sockets) {
							socket.destroy()
						}
					})
			)
		})

	/** Returns once every connection the server accepted has closed: a fact the server observes, with no deadline. */
	readonly allClosed: Effect.Effect<void> = Effect.callback<void>((resume) => {
		const check = (): void => {
			if (Arr.every(this.accepted, (a) => a.closed)) {
				this.#closes.delete(check)
				resume(Effect.void)
			}
		}
		this.#closes.add(check)
		check()
		return Effect.sync(() => {
			this.#closes.delete(check)
		})
	})

	#accept(socket: Socket, authentication: Authentication): void {
		this.#sockets.push(socket)
		const accepted: Accepted = {
			first: Option.none(),
			passwordSent: false,
			closed: false,
			key: Option.none()
		}
		this.accepted.push(accepted)
		let read = Buffer.alloc(0)
		let total = 0
		const take = (): void => {
			for (;;) {
				const first = accepted.first
				if (Option.isSome(first) && first.value.kind === "cancel") {
					accepted.first = Option.some({ ...first.value, bytes: total })
					return
				}
				const started = Option.isSome(first)
				const header = started ? 5 : 8
				if (read.length < header) {
					return
				}
				const length = started ? 1 + read.readInt32BE(1) : read.readInt32BE(0)
				if (read.length < length) {
					return
				}
				const message = read.subarray(0, length)
				read = read.subarray(length)
				if (started) {
					this.#typed(socket, accepted, message[0] ?? 0)
				} else {
					this.#first(socket, accepted, message, authentication)
				}
			}
		}
		socket.on("data", (chunk: Buffer) => {
			total += chunk.length
			read = Buffer.concat([read, chunk])
			take()
		})
		socket.on("error", () => undefined)
		socket.once("close", () => {
			accepted.closed = true
			for (const check of this.#closes) {
				check()
			}
		})
	}

	#first(
		socket: Socket,
		accepted: Accepted,
		message: Buffer,
		authentication: Authentication
	): void {
		const code = message.readInt32BE(4)
		switch (code) {
			case sslRequestCode:
				accepted.first = Option.some({ kind: "sslRequest" })
				socket.destroy()
				return
			case cancelRequestCode:
				accepted.first = Option.some({
					kind: "cancel",
					processId: message.readInt32BE(8),
					secretKey: message.readInt32BE(12),
					bytes: message.length
				})
				socket.end()
				return
			case protocol30: {
				accepted.first = Option.some({
					kind: "startup",
					parameters: parametersOf(message.subarray(8))
				})
				if (authentication !== "peer") {
					socket.write(passwordRequest[authentication])
					return
				}
				const key = { processId: this.#pid, secretKey: this.#pid * 7919 }
				this.#pid += 1
				accepted.key = Option.some(key)
				socket.write(
					Buffer.concat([
						authenticationOk,
						frame("K", Buffer.concat([int32(key.processId), int32(key.secretKey)])),
						readyForQuery
					])
				)
				return
			}
			default:
				socket.destroy()
		}
	}

	#typed(socket: Socket, accepted: Accepted, type: number): void {
		if (type === passwordMessage) {
			accepted.passwordSent = true
			socket.end(passwordRefused)
		} else if (type === terminate) {
			socket.end()
		} else if (type === sync) {
			socket.write(reapWindowAnswer)
		}
	}
}

/** The parameters of the startup packet `accepted` began with: a connection's first message, never an SSLRequest. */
export const startupOf = (accepted: Accepted): ReadonlyMap<string, string> => {
	const first = accepted.first
	assert.ok(Option.isSome(first), "the connection sent a first message")
	if (first.value.kind !== "startup") {
		return assert.fail(
			`the connection's first message is a ${first.value.kind}, never a startup packet`
		)
	}
	return first.value.parameters
}
