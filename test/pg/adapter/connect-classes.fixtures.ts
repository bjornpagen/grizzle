/** What the properties of connect-classes.test.ts read: the failures, their classes, attempts and both paths. */

import { createServer, type Socket } from "node:net"
import { inspect } from "node:util"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Redacted } from "effect"
import pgDriver from "pg"
import { ReadFailure } from "#adapter/errors/execution.ts"
import { type ConnectRefusal, CredentialError } from "#adapter/errors/failures.ts"
import { readCallError } from "#adapter/live/call-error.ts"
import { openMigrationSession } from "#adapter/migrate/session.ts"
import { makePool, type Password } from "#adapter/wire/session.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { CallError } from "#compiler/live/events.ts"
import { servedSession } from "#compiler/program/served.ts"
import { substrateLogin } from "#test/pg/adapter/support.ts"
import { pgPin } from "#test/support/env.ts"
import { clusterPool, clusterTransport, noPassword, parsedConnection } from "#test/support/pg.ts"
import type { SubstrateShape } from "#test/support/substrate/substrate.ts"

const failures = [
	"nothing listening",
	"a role over its connection limit",
	"a wrong password",
	"no such database",
	"a CA that is not the server's",
	"a server that offers no TLS",
	"a server that answers neither",
	"a server that closes at once",
	"a failing password Effect",
	"no password for a SCRAM role"
] as const
export type ConnectFailure = (typeof failures)[number]

export type Path = "grizzle migrate" | "a Db's call"

/** Every failure, once each. */
export const failureGen: Gen<ConnectFailure> = (source) => source.draw(element(failures))

/** Every two failures, the first before the second in failures' order, once each. */
export const failurePairs: Gen<readonly [ConnectFailure, ConnectFailure]> = (source) => {
	const first = source.draw(int(0, failures.length - 2))
	const second = source.draw(int(first + 1, failures.length - 1))
	return [Arr.getUnsafe(failures, first), Arr.getUnsafe(failures, second)] as const
}

/** Every failure through each path, the features a failure's case notes. */
export const failureSituations: ReadonlyArray<Reached<ConnectClassFeature>> = Arr.flatMap(
	failures,
	(p): ReadonlyArray<ConnectClassFeature> => [
		`${p} through grizzle migrate`,
		`${p} through a Db's call`
	]
)

/**
 * What a failure's class reads as: its tag's word and the fact that tells it apart. A TLS handshake's failure is told
 * by when it happened, whatever Node's code for it.
 */
export const classOf = (refusal: ConnectRefusal): string => {
	switch (refusal._tag) {
		case "SocketFailed":
			return `socket ${refusal.code}`
		case "StartupRefused":
			return `server ${refusal.error.sqlstate}`
		case "TlsRefused":
			return `tls ${refusal.fault.kind}`
		case "CredentialError":
			return "credential"
		case "ConnectionClosed":
			return "closed"
		case "DriverRefused":
			return "driver"
		case "NoCancelKey":
			return "no cancellation key"
	}
}

/**
 * What a call error states, as README "Errors and outcomes" names it: its kind, its reason (an unavailable reason's
 * kind, and the SQLSTATE or code an `other` one carries), and its retry.
 */
const statedOf = (error: CallError): ReadonlyArray<string> => {
	if (error.kind === "credentialRefused") {
		return [error.kind, error.reason, error.retry]
	}
	if (error.kind !== "unavailable") {
		return [error.kind, error.retry]
	}
	const reason = error.reason
	return reason.kind === "otherSqlstate"
		? [error.kind, reason.kind, reason.sqlstate, error.retry]
		: reason.kind === "otherSocketCode"
			? [error.kind, reason.kind, reason.code, error.retry]
			: [error.kind, reason.kind, error.retry]
}

/** Each failure's class (its fact) and the call error a Db's call reads it as (README "Errors and outcomes"). */
export const expectedClass: {
	readonly [P in ConnectFailure]: { readonly fact: string; readonly called: ReadonlyArray<string> }
} = {
	"nothing listening": {
		fact: "socket ECONNREFUSED",
		called: ["unavailable", "connectionRefused", "safe"]
	},
	"a role over its connection limit": {
		fact: "server 53300",
		called: ["unavailable", "tooManyConnections", "safe"]
	},
	"a wrong password": {
		fact: "server 28P01",
		called: ["credentialRefused", "passwordRefused", "never"]
	},
	"no such database": {
		fact: "server 3D000",
		called: ["unavailable", "otherSqlstate", "3D000", "safe"]
	},
	"a CA that is not the server's": {
		fact: "tls handshake",
		called: ["credentialRefused", "tlsUnverified", "never"]
	},
	"a server that offers no TLS": {
		fact: "tls notOffered",
		called: ["credentialRefused", "tlsUnverified", "never"]
	},
	"a server that answers neither": {
		fact: "tls unanswered",
		called: ["credentialRefused", "tlsUnverified", "never"]
	},
	"a server that closes at once": {
		fact: "closed",
		called: ["unavailable", "connectionClosed", "safe"]
	},
	"a failing password Effect": {
		fact: "credential",
		called: ["credentialRefused", "passwordFailed", "never"]
	},
	"no password for a SCRAM role": {
		fact: "driver",
		called: ["credentialRefused", "driverRefused", "never"]
	}
}

/**
 * A local server that is not PostgreSQL: one that answers the SSLRequest with N or with E (neither S nor N), or ends the
 * connection once the SSLRequest arrives.
 */
type Fake = "N" | "E" | "close"

const fakeServer = (fake: Fake) =>
	Effect.acquireRelease(
		Effect.callback<{ readonly port: number; readonly close: () => void }>((resume) => {
			const sockets = new Set<Socket>()
			const server = createServer((socket) => {
				sockets.add(socket)
				socket.on("error", () => undefined)
				socket.on("close", () => sockets.delete(socket))
				socket.once("data", () => {
					if (fake === "close") {
						socket.end()
					} else {
						socket.write(fake)
					}
				})
			})
			server.listen(0, pgPin.host, () => {
				const address = server.address()
				resume(
					Effect.succeed({
						port: address !== null && typeof address === "object" ? address.port : 0,
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

/** A port nothing listens on: one a server held and has let go. */
const freedPort = Effect.callback<number>((resume) => {
	const server = createServer()
	server.listen(0, pgPin.host, () => {
		const address = server.address()
		const port = address !== null && typeof address === "object" ? address.port : 0
		server.close(() => {
			resume(Effect.succeed(port))
		})
	})
})

/** Where one attempt connects, and as whom. */
interface Attempt {
	readonly port: number
	readonly database: string
	readonly role: string
	readonly password: Password
	readonly ca: string
	/** The password texts no report may hold. */
	readonly secrets: ReadonlyArray<string>
}

export type ConnectClassFeature = `${ConnectFailure} through ${Path}`

/** The failure's attempt, its precondition set up in the case's scope: a login of its own in `schema`, dropped with it. */
export const attemptOf = (s: SubstrateShape, schema: string, condition: ConnectFailure) =>
	Effect.gen(function* () {
		const writer = yield* substrateLogin(schema, "server", [])
		const own = Redacted.value(writer.password)
		const direct: Attempt = {
			port: s.cluster.port,
			database: s.database,
			role: writer.role,
			password: writer.password,
			ca: s.cluster.tls.ca,
			secrets: [own]
		}
		switch (condition) {
			case "nothing listening":
				return { ...direct, port: yield* freedPort }
			case "a role over its connection limit":
				yield* s.admin.query(`ALTER ROLE ${quoteIdent(writer.role)} CONNECTION LIMIT 0`, [])
				return direct
			case "a wrong password": {
				const wrong = `not ${own}`
				return { ...direct, password: Redacted.make(wrong), secrets: [own, wrong] }
			}
			case "no such database":
				return { ...direct, database: `${s.database}_absent` }
			case "a CA that is not the server's":
				return { ...direct, ca: s.cluster.tls.wrongCa }
			case "a server that offers no TLS":
				return { ...direct, port: (yield* fakeServer("N")).port }
			case "a server that answers neither":
				return { ...direct, port: (yield* fakeServer("E")).port }
			case "a server that closes at once":
				return { ...direct, port: (yield* fakeServer("close")).port }
			case "a failing password Effect":
				return {
					...direct,
					password: Effect.fail(
						new CredentialError({ cause: "the provider chain resolved nothing" })
					)
				}
			case "no password for a SCRAM role":
				return { ...direct, password: noPassword }
		}
	})

/**
 * The connection an attempt makes, parsed as grizzle parses one: the cluster's transport, at its port, with
 * its CA.
 */
const connectionOf = (s: SubstrateShape, attempt: Attempt) =>
	parsedConnection(
		{
			driver: pgDriver,
			transport: { ...clusterTransport(s.cluster), port: attempt.port, ca: attempt.ca },
			database: attempt.database,
			password: attempt.password
		},
		attempt.role
	)

/**
 * The attempt's failure through `grizzle migrate`: its class, its reason's statement of the class after the role,
 * host and port it names, and the whole error as text.
 */
export const throughMigrate = (s: SubstrateShape, attempt: Attempt) =>
	Effect.gen(function* () {
		const failure = yield* Effect.flip(
			Effect.scoped(openMigrationSession(connectionOf(s, attempt)))
		)
		const reason = failure.reason
		assert.ok(reason._tag === "ConnectRefused", `a connect refusal, not ${reason._tag}`)
		assert.deepEqual(
			{ role: reason.role, host: reason.host, port: reason.port },
			{ role: attempt.role, host: pgPin.host, port: attempt.port },
			"the migrate reason names the role, host and port"
		)
		return {
			refusal: reason.refusal,
			stated: reason.refusal.message,
			text: inspect(failure, { depth: 12 })
		}
	})

/**
 * The attempt's failure through a pool's lease, as a Db's call takes one: a ReadFailure at stage acquire, whose
 * reason is the class, and which the call reads as the failure's CallError.
 */
export const throughCall = (s: SubstrateShape, attempt: Attempt, condition: ConnectFailure) =>
	Effect.gen(function* () {
		const pool = yield* makePool({
			connection: connectionOf(s, attempt),
			session: servedSession,
			bounds: clusterPool,
			attachPool: () => undefined
		})
		const refusal = yield* Effect.flip(Effect.scoped(pool.lease))
		assert.ok(
			refusal._tag !== "LayerReleased",
			`the reason ${refusal._tag} is a connection attempt's class`
		)
		const failure = new ReadFailure({ reason: refusal })
		assert.equal(failure.stage, "acquire")
		const called = readCallError(failure)
		assert.deepEqual(
			statedOf(called),
			expectedClass[condition].called,
			`${condition} through a Db's call: its CallError, ${called.message}`
		)
		return {
			refusal,
			stated: refusal.message,
			text: `${failure.message}\n${inspect(failure, { depth: 12 })}\n${inspect(called, { depth: 12 })}`
		}
	})
