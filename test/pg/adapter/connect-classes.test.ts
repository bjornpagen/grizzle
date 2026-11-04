import { createServer, type Socket } from "node:net"
import { inspect } from "node:util"
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Redacted, String as Str } from "effect"
import { OpenError, type OpenStage } from "#adapter/errors/execution.ts"
import { type ConnectRefusal, CredentialError } from "#adapter/errors/failures.ts"
import { openMigrationSession } from "#adapter/migrate/session.ts"
import { acquisitionBudgets, connectBudgetMs } from "#adapter/pool/budgets.ts"
import { isTlsCode, makePool, noPassword, type Password } from "#adapter/wire/session.ts"
import { poolBounds } from "#compiler/core/policy.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { substrateLogin } from "#test/pg/adapter/support.ts"
import { assert } from "#test/support/assert.ts"
import { pgPin } from "#test/support/env.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A connection that fails is classified, and every class states its own reason, the same through `grizzle migrate` and
 * through Db.open, never with a password (packages/grizzle/src/adapter/errors/failures.ts ConnectRefusal).
 *
 * The property, exhausted over planted failures, each opened by the migration identity's session (MigrateError whose
 * reason, ConnectRefused, carries the refusal) and by a pool's lease as Db.open opens one (OpenError, its reason): no answer within the
 * connect budget (a server that accepts and never answers), a refused socket (nothing listening), the server's
 * SQLSTATE (a role over its connection limit, 53300; a wrong password, 28P01; no such database, 3D000), TLS (a CA that
 * is not the server's; a server that answers the SSLRequest with N, or with neither S nor N; an empty CA bundle), a
 * server that closes the connection at once, a failing password Effect, and no password for a role SCRAM
 * authenticates. The oracle is the class each plant is: its tag, the fact that tells it apart, and its stage. Both
 * paths carry the same class; the migrate reason names the role, host and port and states the class's message; no
 * password, given or wrong, appears in a message or anywhere in either error; and the messages of the plants are all
 * distinct.
 */
const plants = [
	"a server that never answers",
	"nothing listening",
	"a role over its connection limit",
	"a wrong password",
	"no such database",
	"a CA that is not the server's",
	"a server that offers no TLS",
	"a server that answers neither",
	"an empty CA bundle",
	"a server that closes at once",
	"a failing password Effect",
	"no password for a SCRAM role"
] as const
type Plant = (typeof plants)[number]

type Path = "grizzle migrate" | "Db.open"

/** Every plant through each path. */
const plantPaths: Gen<readonly [Plant, Path]> = (source) =>
	[
		source.draw(element(plants)),
		source.draw(element<Path>(["grizzle migrate", "Db.open"]))
	] as const

/**
 * What a failure's class reads as: its tag's word and the fact that tells it apart. A TLS handshake's code is Node's,
 * whichever one the TLS check recognizes.
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
			return refusal.fault.kind === "handshake"
				? `tls handshake ${isTlsCode(refusal.fault.code) ? "verification" : refusal.fault.code}`
				: `tls ${refusal.fault.kind}`
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

const plantedClass: {
	readonly [P in Plant]: { readonly fact: string; readonly stage: OpenStage }
} = {
	"a server that never answers": { fact: `timed out after ${connectBudgetMs}`, stage: "connect" },
	"nothing listening": { fact: "socket ECONNREFUSED", stage: "connect" },
	"a role over its connection limit": { fact: "server 53300", stage: "connect" },
	"a wrong password": { fact: "server 28P01", stage: "authentication" },
	"no such database": { fact: "server 3D000", stage: "connect" },
	"a CA that is not the server's": { fact: "tls handshake verification", stage: "tls" },
	"a server that offers no TLS": { fact: "tls notOffered", stage: "tls" },
	"a server that answers neither": { fact: "tls unanswered", stage: "tls" },
	"an empty CA bundle": { fact: "tls noAuthority", stage: "tls" },
	"a server that closes at once": { fact: "closed", stage: "connect" },
	"a failing password Effect": { fact: "credential", stage: "credential" },
	"no password for a SCRAM role": { fact: "driver", stage: "connect" }
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
	/** The password texts no report may hold. */
	readonly secrets: ReadonlyArray<string>
}

type ConnectClassFeature = `${Plant} through ${Path}`

layer(Substrate.layer)("a connection failure states its class", (it) => {
	it.effect(
		"every class of connection failure yields its own reason, alike through migrate and Db.open",
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
								secrets: [own]
							}
							switch (plant) {
								case "a server that never answers":
									return { ...direct, port: (yield* fakeServer("silent")).port }
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
								case "an empty CA bundle":
									return { ...direct, ca: "" }
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
					 * The attempt's failure through `grizzle migrate`: its class, its stage, its reason's statement of the class
					 * after the role, host and port it names, and the whole error as text.
					 */
					const throughMigrate = (attempt: Attempt) =>
						Effect.gen(function* () {
							const failure = yield* Effect.flip(
								Effect.scoped(
									openMigrationSession({
										host: pgPin.host,
										port: attempt.port,
										database: attempt.database,
										role: attempt.role,
										password: attempt.password,
										tls: { ca: attempt.ca, servername: pgPin.host }
									})
								)
							)
							const reason = failure.reason
							assert.ok(reason._tag === "ConnectRefused", `a connect refusal, not ${failure.stage}`)
							assert.deepEqual(
								{ role: reason.role, host: reason.host, port: reason.port },
								{ role: attempt.role, host: pgPin.host, port: attempt.port },
								"the migrate reason names the role, host and port"
							)
							return {
								refusal: reason.refusal,
								stage: new OpenError({ reason: reason.refusal }).stage,
								stated: reason.refusal.message,
								text: inspect(failure, { depth: 12 })
							}
						})

					/**
					 * The attempt's failure through a pool's lease, as Db.open opens one: OpenError, whose reason is the class.
					 */
					const throughOpen = (attempt: Attempt) =>
						Effect.gen(function* () {
							const pool = yield* makePool({
								connection: {
									host: pgPin.host,
									port: attempt.port,
									database: attempt.database,
									role: attempt.role,
									password: attempt.password
								},
								transport: { _tag: "tls", tls: { ca: attempt.ca, servername: pgPin.host } },
								pool: poolBounds,
								budgets: acquisitionBudgets,
								attachPool: () => undefined
							})
							const refusal = yield* Effect.flip(Effect.scoped(pool.lease))
							const failure = new OpenError({ reason: refusal })
							assert.ok(
								refusal._tag !== "AcquisitionBudgetExceeded" && refusal._tag !== "LayerReleased",
								`the reason of OpenError at stage ${failure.stage} is a connection attempt's class`
							)
							return {
								refusal,
								stage: failure.stage,
								stated: refusal.message,
								text: `${failure.message}\n${inspect(failure, { depth: 12 })}`
							}
						})

					/** What each path stated for each plant. */
					const stated: { readonly [P in Path]: Map<Plant, string> } = {
						"grizzle migrate": new Map(),
						"Db.open": new Map()
					}

					const exhausted = yield* exhaust(
						{
							suite: "adapter/connect-classes",
							generator: plantPaths,
							literal: ([plant, path]) => `${plant} through ${path}`,
							limit: plants.length * 2,
							coverage: requiredInSpace<ConnectClassFeature>(
								Arr.flatMap(plants, (p): Arr.NonEmptyReadonlyArray<ConnectClassFeature> => [
									`${p} through grizzle migrate`,
									`${p} through Db.open`
								])
							),
							caseHang: Duration.minutes(2)
						},
						([plant, path], c) =>
							Effect.gen(function* () {
								const attempt = yield* attemptOf(plant)
								const reported =
									path === "grizzle migrate"
										? yield* throughMigrate(attempt)
										: yield* throughOpen(attempt)
								const planted = plantedClass[plant]
								assert.equal(
									classOf(reported.refusal),
									planted.fact,
									`${plant} through ${path}: its class`
								)
								assert.equal(reported.stage, planted.stage, `${plant} through ${path}: its stage`)
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
						Arr.map(plants, (plant) => stated["Db.open"].get(plant)),
						Arr.map(plants, (plant) => stated["grizzle migrate"].get(plant)),
						"each plant's reason, alike through both paths"
					)
					return exhausted
				}).pipe(Effect.scoped)
			)
	)
})
