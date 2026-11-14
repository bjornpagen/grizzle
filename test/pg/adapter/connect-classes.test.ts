/**
 * A connection that fails is classified, and every class states its own reason, the same through `grizzle migrate` and
 * through a Db's call, never with a password (packages/grizzle/src/adapter/errors/failures.ts ConnectRefusal).
 *
 * The property, exhausted over planted failures, each opened by the migration identity's session (MigrateError whose
 * reason, ConnectRefused, carries the refusal) and by a pool's lease as a Db's call takes one (ReadFailure at stage
 * acquire, its reason; Db.open leases nothing): no
 * answer within the attempt's connect timeout (a server that accepts and never answers), a refused socket (nothing listening), the server's
 * SQLSTATE (a role over its connection limit, 53300; a wrong password, 28P01; no such database, 3D000), TLS (a CA that
 * is not the server's; a server that answers the SSLRequest with N, or with neither S nor N), a server that closes the
 * connection at once, a failing password Effect, and no password for a role SCRAM authenticates. Each attempt's
 * connection is parsed as grizzle parses one (test/support/pg.ts parsedConnection), so an empty CA bundle never reaches
 * a connection: the parse refuses it at stage config (test/unit/adapter/layer.test.ts). The oracle is the class each plant is: its tag and the fact that tells it apart. Both
 * paths carry the same class; the migrate reason names the role, host and port and states the class's message; no
 * password, given or wrong, appears in a message or anywhere in either error; and the messages of the plants are all
 * distinct.
 *
 * A Db's call reads its class as the CallError README "Errors and outcomes" names (adapter/live/call-error.ts
 * readCallError): a wrong password `credentialRefused`, `passwordRefused`; nothing listening `unavailable`,
 * `connectionRefused`; a CA that is not the server's `credentialRefused`, `tlsUnverified`; and each other plant its own
 * kind and reason, `retry` `never` for `credentialRefused` and `safe` for `unavailable`. The wrong password is a real
 * login's, on the local cluster, in the substrate's own database: the login role it makes for this run.
 *
 * Features: every plant through each path, a wrong password, nothing listening and a CA that is not the server's among
 * them.
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): connect-classes-closed-as-socket.patch (pg's report of a connection
 * closed at once no longer recognized, so it is misclassified).
 */
import { createServer, type Socket } from "node:net"
import { inspect } from "node:util"
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Redacted, String as Str } from "effect"
import pgDriver from "pg"
import { ReadFailure } from "#adapter/errors/execution.ts"
import { type ConnectRefusal, CredentialError } from "#adapter/errors/failures.ts"
import { readCallError } from "#adapter/live/call-error.ts"
import { openMigrationSession } from "#adapter/migrate/session.ts"
import { makePool, type Password } from "#adapter/wire/session.ts"
import type { CallError } from "#compiler/live/events.ts"
import { servedSession } from "#compiler/program/served.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { substrateLogin } from "#test/pg/adapter/support.ts"
import { assert } from "#test/support/assert.ts"
import { pgPin } from "#test/support/env.ts"
import { caseHang, nodeTimerMin, testConnectTimeout } from "#test/support/limits.ts"
import { noPassword } from "#test/support/pg.ts"
import { clusterPool, clusterTransport, parsedConnection } from "#test/support/pg.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

const plants = [
	"a server that never answers",
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
type Plant = (typeof plants)[number]

type Path = "grizzle migrate" | "a Db's call"

/** Every plant through each path. */
const plantPaths: Gen<readonly [Plant, Path]> = (source) =>
	[
		source.draw(element(plants)),
		source.draw(element<Path>(["grizzle migrate", "a Db's call"]))
	] as const

/**
 * What a failure's class reads as: its tag's word and the fact that tells it apart. A TLS handshake's failure is told
 * by when it happened, whatever Node's code for it.
 */
const classOf = (refusal: ConnectRefusal): string => {
	switch (refusal._tag) {
		case "ConnectTimedOut":
			return `timed out after ${refusal.millis}`
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
 * The connect timeout of the attempts to a server that never answers: the least delay a Node timer waits, since nothing
 * will answer it, so any delay times the attempt out and the case spends none of the run waiting longer.
 */
const silentTimeout = nodeTimerMin.value

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

/** Each plant's class (its fact) and the call error a Db's call reads it as (README "Errors and outcomes"). */
const plantedClass: {
	readonly [P in Plant]: { readonly fact: string; readonly called: ReadonlyArray<string> }
} = {
	"a server that never answers": {
		fact: `timed out after ${silentTimeout}`,
		called: ["unavailable", "timedOut", "safe"]
	},
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
 * A local server that is not PostgreSQL: one that reads and never answers, answers the SSLRequest with N or with E
 * (neither S nor N), or ends the connection once the SSLRequest arrives.
 */
type Fake = "silent" | "N" | "E" | "close"

const fakeServer = (fake: Fake) =>
	Effect.acquireRelease(
		Effect.callback<{ readonly port: number; readonly close: () => void }>((resume) => {
			const sockets = new Set<Socket>()
			const server = createServer((socket) => {
				sockets.add(socket)
				socket.on("error", () => undefined)
				socket.on("close", () => sockets.delete(socket))
				socket.once("data", () => {
					if (fake === "N" || fake === "E") {
						socket.write(fake)
					} else if (fake === "close") {
						socket.end()
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
	readonly connectTimeoutMs: number
	/** The password texts no report may hold. */
	readonly secrets: ReadonlyArray<string>
}

type ConnectClassFeature = `${Plant} through ${Path}`

layer(Substrate.layer)("a connection failure states its class", (it) => {
	it.effect(
		"every class of connection failure yields its own reason, alike through migrate and a Db's call",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema(freshSchema)

					/** The plant's attempt, its precondition set up in the case's scope. */
					const attemptOf = (plant: Plant) =>
						Effect.gen(function* () {
							const writer = yield* substrateLogin(schema, "server", [])
							const own = Redacted.value(writer.password)
							const direct: Attempt = {
								port: pgPin.port,
								database: s.database,
								role: writer.role,
								password: writer.password,
								ca: s.cluster.caPem,
								connectTimeoutMs: testConnectTimeout.value,
								secrets: [own]
							}
							switch (plant) {
								case "a server that never answers":
									return {
										...direct,
										port: (yield* fakeServer("silent")).port,
										connectTimeoutMs: silentTimeout
									}
								case "nothing listening":
									return { ...direct, port: yield* freedPort }
								case "a role over its connection limit":
									yield* s.admin.query(
										`ALTER ROLE ${quoteIdent(writer.role)} CONNECTION LIMIT 0`,
										[]
									)
									return direct
								case "a wrong password": {
									const wrong = `not ${own}`
									return { ...direct, password: Redacted.make(wrong), secrets: [own, wrong] }
								}
								case "no such database":
									return { ...direct, database: `${s.database}_absent` }
								case "a CA that is not the server's":
									return { ...direct, ca: s.cluster.wrongCaPem }
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
					const connectionOf = (attempt: Attempt) =>
						parsedConnection(
							{
								driver: pgDriver,
								transport: { ...clusterTransport(s.cluster), port: attempt.port, ca: attempt.ca },
								database: attempt.database,
								password: attempt.password,
								connectTimeoutMs: attempt.connectTimeoutMs
							},
							attempt.role
						)

					/**
					 * The attempt's failure through `grizzle migrate`: its class, its reason's statement of the class
					 * after the role, host and port it names, and the whole error as text.
					 */
					const throughMigrate = (attempt: Attempt) =>
						Effect.gen(function* () {
							const failure = yield* Effect.flip(
								Effect.scoped(openMigrationSession(connectionOf(attempt)))
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
					 * The attempt's failure through a pool's lease, as a Db's call takes one: a ReadFailure at stage acquire,
					 * whose reason is the class, and which the call reads as the plant's CallError.
					 */
					const throughCall = (attempt: Attempt, plant: Plant) =>
						Effect.gen(function* () {
							const pool = yield* makePool({
								connection: connectionOf(attempt),
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
								plantedClass[plant].called,
								`${plant} through a Db's call: its CallError, ${called.message}`
							)
							return {
								refusal,
								stated: refusal.message,
								text: `${failure.message}\n${inspect(failure, { depth: 12 })}\n${inspect(called, { depth: 12 })}`
							}
						})

					/** What each path stated for each plant. */
					const stated: { readonly [P in Path]: Map<Plant, string> } = {
						"grizzle migrate": new Map(),
						"a Db's call": new Map()
					}

					const exhausted = yield* exhaust(
						{
							box: "every planted class of connection failure, through migrate and through a Db's call",
							oracle: {
								kind: "specification",
								name: "ConnectRefusal: the class each plant is, told by its tag and its distinguishing fact"
							},
							suite: "adapter/connect-classes",
							generator: plantPaths,
							literal: ([plant, path]) => `${plant} through ${path}`,
							coverage: requiredInSpace<ConnectClassFeature>(
								Arr.flatMap(plants, (p): Arr.NonEmptyReadonlyArray<ConnectClassFeature> => [
									`${p} through grizzle migrate`,
									`${p} through a Db's call`
								])
							),
							caseHang,
							concurrency: 1
						},
						([plant, path], c) =>
							Effect.gen(function* () {
								const attempt = yield* attemptOf(plant)
								const reported =
									path === "grizzle migrate"
										? yield* throughMigrate(attempt)
										: yield* throughCall(attempt, plant)
								const planted = plantedClass[plant]
								assert.equal(
									classOf(reported.refusal),
									planted.fact,
									`${plant} through ${path}: its class`
								)
								for (const secret of attempt.secrets) {
									assert.ok(
										!Str.includes(secret)(reported.text),
										`${plant} through ${path} holds a password`
									)
								}
								stated[path].set(plant, reported.stated)
								c.note(`${plant} through ${path}`)
							})
					)
					/** Every class states its own reason, and both paths state each plant's alike. */
					const byMigrate = [...stated["grizzle migrate"].values()]
					assert.equal(
						new Set(byMigrate).size,
						plants.length,
						`distinct reasons: ${Arr.join(byMigrate, " | ")}`
					)
					assert.deepEqual(
						Arr.map(plants, (plant) => stated["a Db's call"].get(plant)),
						Arr.map(plants, (plant) => stated["grizzle migrate"].get(plant)),
						"each plant's reason, alike through both paths"
					)
					return exhausted
				}).pipe(Effect.scoped)
			)
	)
})
