/** What the properties of connection.test.ts read: its spaces, models and helpers. */

import { createServer, type Socket } from "node:net"
import { array, constant, element, type Gen, int, map, weighted } from "@bjornpagen/testing/gen"
import type { PgMember } from "@bjornpagen/testing/pg"
import { Deferred, Effect, Exit } from "effect"
import { ReadFailure } from "#adapter/errors/execution.ts"
import type { TlsFault } from "#adapter/errors/failures.ts"
import type { SessionPool } from "#adapter/wire/session.ts"
import { rowsOn } from "#test/pg/adapter/support.ts"
import { loginTemplate } from "#test/pg/adapter/support.ts"
import { pgPin } from "#test/support/env.ts"

export const currentUser =
	"SELECT current_user::text, (SELECT ssl::text FROM pg_catalog.pg_stat_ssl WHERE pid = pg_catalog.pg_backend_pid())"

/** A statement every session answers with one row. */
const okQuery = "SELECT 'ok'::text"

/** One lease of the pool: the session's rows for `sql`, or the lease's failure. */
export const leased = (pool: SessionPool, sql: string) =>
	Effect.scoped(Effect.flatMap(pool.lease, (session) => rowsOn(session, sql, [])))

/** A lease's refusal as a Db's call reports it: a ReadFailure at stage acquire, the refusal its reason. */
export const leaseRefused = (pool: SessionPool) =>
	Effect.mapError(pool.lease, (reason) => new ReadFailure({ reason }))

/** What refused a lease of the pool, which must fail: its reason's tag; a failure after the lease, by its own tag. */
export const refusedBy = (pool: SessionPool) =>
	Effect.map(
		Effect.flip(
			Effect.scoped(Effect.flatMap(leaseRefused(pool), (session) => rowsOn(session, okQuery, [])))
		),
		(failure) => (failure._tag === "ReadFailure" ? failure.reason._tag : failure._tag)
	)

/** The length of an SSLRequest: its length word and its request code. */
const sslRequestBytes = 8

/** A fatal TLS alert record, handshake_failure: what a server that said yes and then speaks no TLS ends with. */
const handshakeFailure = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28])

/** TLS's record type of a handshake message: the first byte of a ClientHello. */
export const handshakeRecord = 0x16

/** What the client sent the server after the server's answer, once the client's connection has closed. */
interface Answered {
	readonly port: number
	readonly after: Effect.Effect<Buffer>
}

/**
 * A server that answers a client's SSLRequest with `answer`, in one write, and records every byte the client sends
 * after its request. A client told yes in exactly one byte, `S`, starts its TLS handshake, which the server refuses with
 * a fatal alert, leaving the connection for the client to close. `after` waits for the client's connection to close, a
 * fact, and is what it sent.
 */
export const answeringServer = (answer: Buffer) =>
	Effect.acquireRelease(
		Effect.callback<Answered & { readonly close: () => void }>((resume) => {
			const sockets = new Set<Socket>()
			const sent: Array<Buffer> = []
			const closed = Deferred.makeUnsafe<void>()
			const server = createServer((socket) => {
				sockets.add(socket)
				let answered = false
				socket.on("data", (chunk: Buffer) => {
					if (answered) {
						sent.push(chunk)
						if (answer.equals(Buffer.from("S"))) {
							socket.write(handshakeFailure)
						}
						return
					}
					answered = true
					sent.push(chunk.subarray(sslRequestBytes))
					socket.write(answer)
				})
				socket.on("error", () => undefined)
				socket.on("close", () => {
					sockets.delete(socket)
					Deferred.doneUnsafe(closed, Exit.void)
				})
			})
			server.listen(0, pgPin.host, () => {
				const address = server.address()
				const port = address !== null && typeof address === "object" ? address.port : 0
				resume(
					Effect.succeed({
						port,
						after: Effect.map(Deferred.await(closed), () => Buffer.concat(sent)),
						close: () => {
							for (const socket of sockets) {
								socket.destroy()
							}
							server.close()
						}
					})
				)
			})
		}),
		(server) =>
			Effect.sync(() => {
				server.close()
			})
	)

/** The letters of PostgreSQL's answers to an SSLRequest that a client branches on: yes, no, and an ErrorResponse. */
const answerLetters = ["S", "N", "E"] as const

/** One byte of an answer: one of the protocol's letters, or any byte. */
const answerByte: Gen<number> = weighted<number>([
	[2, map(element(answerLetters), (letter) => Buffer.from(letter).readUInt8(0))],
	[1, int(0, 0xff)]
])

/** An answer to an SSLRequest: one byte, as PostgreSQL answers, or two or three. */
export const answerGen: Gen<ReadonlyArray<number>> = weighted<ReadonlyArray<number>>([
	[2, map(answerByte, (b) => [b])],
	[1, array(answerByte, { min: 2, max: 3 })]
])

export type AnswerFeature =
	| "answered yes"
	| "answered no"
	| "answered an ErrorResponse's letter"
	| "answered another byte"
	| "answered more than one byte"

/** What a client must make of an answer: TLS for exactly `S`, no TLS offered for exactly `N`, no answer otherwise. */
export const answerFault = (answer: Buffer): TlsFault["kind"] =>
	answer.equals(Buffer.from("S"))
		? "handshake"
		: answer.equals(Buffer.from("N"))
			? "notOffered"
			: "unanswered"

/** The feature an answer reaches. */
export const answerFeature = (answer: Buffer): AnswerFeature =>
	answer.length > 1
		? "answered more than one byte"
		: answer.equals(Buffer.from("S"))
			? "answered yes"
			: answer.equals(Buffer.from("N"))
				? "answered no"
				: answer.equals(Buffer.from("E"))
					? "answered an ErrorResponse's letter"
					: "answered another byte"

/**
 * Where a pool's password Effect answers from: the role's password as it is now, the one it was when the mode was set,
 * one the role never had, or a failure.
 */
type ProviderMode = "follows" | "pinned" | "wrong" | "fails"

const providerModes = [
	"follows",
	"pinned",
	"wrong",
	"fails"
] as const satisfies ReadonlyArray<ProviderMode>

/**
 * A step of a credential program: lease `count` sessions one after another, each held until the step ends; rotate the
 * role's password; or set the provider's mode.
 */
type CredentialStep =
	| { readonly kind: "lease"; readonly count: number }
	| { readonly kind: "rotate" }
	| { readonly kind: "provider"; readonly mode: ProviderMode }

interface CredentialProgram {
	readonly max: number
	readonly provider: ProviderMode
	readonly steps: ReadonlyArray<CredentialStep>
}

export const credentialProgramGen: Gen<CredentialProgram> = (source) => {
	const max = source.draw(int(1, 3))
	const mode = element(providerModes)
	return {
		max,
		provider: source.draw(mode),
		steps: source.draw(
			array(
				weighted<CredentialStep>([
					[3, map(int(1, max), (count): CredentialStep => ({ kind: "lease", count }))],
					[1, constant({ kind: "rotate" })],
					[1, map(mode, (m): CredentialStep => ({ kind: "provider", mode: m }))]
				]),
				{ min: 1, max: 8 }
			)
		)
	}
}

/**
 * The provider as the model holds it: following the role's password, pinned to one of its versions, answering one it
 * never had, or failing.
 */
type Provider =
	| { readonly kind: "follows" }
	| { readonly kind: "pinned"; readonly version: number }
	| { readonly kind: "wrong" }
	| { readonly kind: "fails" }

export const providerAt = (mode: ProviderMode, version: number): Provider =>
	mode === "pinned" ? { kind: "pinned", version } : { kind: mode }

/**
 * What a lease that finds no idle session meets: one evaluation of the password Effect, which fails with the
 * CredentialError when the provider fails, with the server's refusal (authentication) when it answers a version of the
 * password the role no longer holds, and opens a session otherwise.
 */
type Attempt = "opened" | "credential" | "authentication"

export const attemptOf = (provider: Provider, version: number): Attempt => {
	switch (provider.kind) {
		case "fails":
			return "credential"
		case "pinned":
			return provider.version === version ? "opened" : "authentication"
		case "wrong":
			return "authentication"
		case "follows":
			return "opened"
	}
}

export type CredentialFeature =
	| "a session reused"
	| "a session opened"
	| "refused at credential"
	| "refused at authentication"
	| "opened after a rotation"
	| "reused while no new session could open"

/**
 * The names the local server's certificate carries (@bjornpagen/testing/pg: DNS:localhost, IP:127.0.0.1, IP:::1): verify-full
 * accepts a session exactly when the CA bundle is the local CA and the name it verifies is one of these.
 */
export const certificateNames: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1"])

type CaChoice = "local" | "wrong"

/**
 * The cluster's CA, and another CA, which the cluster holds too. There is no unverified mode: an empty bundle, nothing
 * to verify against, never reaches a pool, since the parse of the connection refuses it at stage config
 * (test/unit/adapter/layer.test.ts).
 */
export const caOf = (cluster: PgMember): { readonly [C in CaChoice]: string } => ({
	local: cluster.ca,
	wrong: cluster.wrongCa
})

/** The name a pool verifies: the very host it dials, or another (a tunnel's), each stated in full. */
type Servername =
	| { readonly kind: "host" }
	| { readonly kind: "given"; readonly servername: string }

interface TlsConfig {
	readonly ca: CaChoice
	readonly host: string
	readonly servername: Servername
}

export type TlsFeature =
	| "connected"
	| "connected through an override"
	| `refused ${Exclude<CaChoice, "local">} ca`
	| "refused host name"
	| "refused override name"

/**
 * Every TLS configuration of a pool over the axes a deployment sets: the CA bundle; the host it dials, by name, by the
 * address the certificate names, and by "127.1", which getaddrinfo reads as 127.0.0.1 but the certificate never names;
 * and the name verified, stated in full: the host itself or an override (a tunnel), a carried name or one no
 * certificate carries.
 */
export const tlsConfigs: Gen<TlsConfig> = (source) => ({
	ca: source.draw(element<CaChoice>(["local", "wrong"])),
	host: source.draw(element(["localhost", "127.0.0.1", "127.1"])),
	servername: source.draw(
		element<Servername>([
			{ kind: "host" },
			{ kind: "given", servername: "localhost" },
			{ kind: "given", servername: "127.0.0.1" },
			{ kind: "given", servername: "grizzle.invalid" }
		])
	)
})

/** The schema and login `server` the TLS and SSLRequest cases connect as, made once per member (support.ts loginTemplate). */
export const serverLogin = loginTemplate(import.meta, "connection server")
