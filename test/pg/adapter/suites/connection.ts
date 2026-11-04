import { createServer, type Socket } from "node:net"
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Duration, Effect, Formatter, Redacted, Schema } from "effect"
import { OpenError } from "#adapter/errors/execution.ts"
import { CredentialError } from "#adapter/errors/failures.ts"
import type { SessionPool } from "#adapter/wire/session.ts"
import { quoteIdent, quoteString } from "#compiler/sql/print.ts"
import {
	countingPassword,
	defaultPool,
	fakeServerPool,
	type PoolOptions,
	poolFor,
	roleDefaults,
	rowsOn,
	substrateLogin
} from "#test/pg/adapter/support.ts"
import { assert } from "#test/support/assert.ts"
import type { InitializedClusterShape } from "#test/support/cluster.ts"
import { pgPin } from "#test/support/env.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

const currentUser =
	"SELECT current_user::text, (SELECT ssl::text FROM pg_catalog.pg_stat_ssl WHERE pid = pg_catalog.pg_backend_pid())"

/** A statement every session answers with one row. */
const okQuery = "SELECT 'ok'::text"

/** One lease of the pool: the session's rows for `sql`, or the lease's failure. */
const leased = (pool: SessionPool, sql: string) =>
	Effect.scoped(Effect.flatMap(pool.lease, (session) => rowsOn(session, sql, [])))

/** A lease's refusal as Db.open reports it, at the stage it fails at. */
const leaseRefused = (pool: SessionPool) =>
	Effect.mapError(pool.lease, (reason) => OpenError.make({ reason }))

/** The stage a lease of the pool, which must fail, was refused at; a failure after the lease, by its tag. */
const refusedStage = (pool: SessionPool) =>
	Effect.map(
		Effect.flip(
			Effect.scoped(Effect.flatMap(leaseRefused(pool), (session) => rowsOn(session, okQuery, [])))
		),
		(failure) => (failure._tag === "OpenError" ? failure.stage : failure._tag)
	)

/** A server that answers every SSLRequest with N, recording what each client sends after that answer. */
const refusingServer = Effect.acquireRelease(
	Effect.callback<{
		readonly port: number
		readonly after: () => number
		readonly close: () => void
	}>((resume) => {
		const sockets = new Set<Socket>()
		let after = 0
		const server = createServer((socket) => {
			sockets.add(socket)
			let answered = false
			socket.on("data", (chunk) => {
				if (answered) {
					after += chunk.length
				} else {
					answered = true
					socket.write("N")
				}
			})
			socket.on("error", () => undefined)
			socket.on("close", () => sockets.delete(socket))
		})
		server.listen(0, pgPin.host, () => {
			const address = server.address()
			const port = address !== null && typeof address === "object" ? address.port : 0
			resume(
				Effect.succeed({
					port,
					after: () => after,
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

/**
 * The names the local server's certificate carries (scripts/pg/init.sh: DNS:localhost, IP:127.0.0.1, IP:::1): verify-full
 * accepts a session exactly when the CA bundle is the local CA and the name it verifies is one of these.
 */
const certificateNames: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1"])

type CaChoice = "local" | "wrong" | "empty"

/**
 * The cluster's CA, another CA, and an empty bundle (no unverified mode: nothing to verify against is a refusal); the
 * other CA is the cluster's too.
 */
const caOf = (
	cluster: InitializedClusterShape
): { readonly [C in CaChoice]: PoolOptions["ca"] } => ({
	local: { kind: "cluster" },
	wrong: { kind: "given", pem: cluster.wrongCaPem },
	empty: { kind: "given", pem: "" }
})

interface TlsConfig {
	readonly ca: CaChoice
	readonly host: string
	readonly servername: PoolOptions["servername"]
}

type TlsFeature =
	| "connected"
	| "connected through an override"
	| `refused ${Exclude<CaChoice, "local">} ca`
	| "refused host name"
	| "refused override name"

/**
 * Every TLS configuration of a pool over the axes a deployment sets: the CA bundle; the host it dials, by name, by the
 * address the certificate names, and by "127.1", which getaddrinfo reads as 127.0.0.1 but the certificate never names;
 * and the name verified, the host itself or an override (a tunnel), a carried name or one no certificate carries.
 */
const tlsConfigs: Gen<TlsConfig> = (source) => ({
	ca: source.draw(element<CaChoice>(["local", "wrong", "empty"])),
	host: source.draw(element(["localhost", "127.0.0.1", "127.1"])),
	servername: source.draw(
		element<PoolOptions["servername"]>([
			{ kind: "host" },
			{ kind: "given", servername: "localhost" },
			{ kind: "given", servername: "127.0.0.1" },
			{ kind: "given", servername: "grizzle.invalid" }
		])
	)
})

/**
 * Connections, TLS and credentials through the adapter.
 *
 * - verify-full TLS, exhaustively over the axes a deployment sets (CA bundle, host dialled, name verified): a session
 *   is accepted exactly when the CA is the server's and the verified name is one its certificate carries, and it logs
 *   in as the role it named, over TLS; there is no unverified mode and no plaintext fallback;
 * - a wrong password is refused at the authentication stage, the password Effect is evaluated per connection attempt,
 *   and a failing one is the CredentialError reason of OpenError, and a later lease's refusal.
 *
 * The logins a Db opens through, and the roles it may run as, are reads/suites/open.ts's open faults.
 */
export const connectionSuite = (): void => {
	layer(Substrate.layer)("adapter connections", (it) => {
		it.effect(
			"connects exactly when the CA is the server's and the verified name is one its certificate carries",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const schema = yield* s.schema(freshSchema)
						const writer = yield* substrateLogin(schema, "server", roleDefaults)
						return yield* exhaust(
							{
								suite: "adapter/tls",
								generator: tlsConfigs,
								literal: Formatter.format,
								limit: 64,
								coverage: requiredInSpace<TlsFeature>([
									"connected",
									"refused wrong ca",
									"refused empty ca",
									"refused host name",
									"refused override name",
									"connected through an override"
								]),
								caseHang: Duration.minutes(2)
							},
							(config, c) =>
								Effect.gen(function* () {
									const pool = yield* poolFor(writer, {
										...defaultPool,
										ca: caOf(s.cluster)[config.ca],
										host: config.host,
										servername: config.servername
									})
									const verified =
										config.servername.kind === "host" ? config.host : config.servername.servername
									if (config.ca !== "local") {
										const stage = yield* refusedStage(pool)
										assert.equal(stage, "tls")
										c.note(`refused ${config.ca} ca`)
									} else if (!certificateNames.has(verified)) {
										const stage = yield* refusedStage(pool)
										assert.equal(stage, "tls")
										c.note(
											`refused ${config.servername.kind === "host" ? "host" : "override"} name`
										)
									} else {
										const leasedRows = yield* leased(pool, currentUser)
										assert.deepEqual(leasedRows, [[writer.role, "true"]])
										c.note(
											config.servername.kind === "host"
												? "connected"
												: "connected through an override"
										)
									}
								})
						)
					}).pipe(Effect.scoped)
				)
		)

		it.effect(
			"never falls back to plaintext: a server that refuses TLS is refused, and is sent nothing",
			() =>
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema(freshSchema)
					const writer = yield* substrateLogin(schema, "server", roleDefaults)
					const server = yield* refusingServer
					const pool = yield* fakeServerPool(writer, server.port)
					const stage = yield* refusedStage(pool)
					assert.equal(stage, "tls")
					assert.equal(server.after(), 0)
				}).pipe(Effect.scoped)
		)

		it.effect("refuses a wrong password at the authentication stage", () =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const schema = yield* s.schema(freshSchema)
				const writer = yield* substrateLogin(schema, "server", roleDefaults)
				const pool = yield* poolFor(writer, {
					...defaultPool,
					password: { kind: "given", password: Redacted.make("not the password") }
				})
				const stage = yield* refusedStage(pool)
				assert.equal(stage, "authentication")
			}).pipe(Effect.scoped)
		)

		it.effect(
			"evaluates the password Effect for each connection attempt, so rotation needs no restart",
			() =>
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema(freshSchema)
					const writer = yield* substrateLogin(schema, "server", roleDefaults)
					const rotating = countingPassword(Redacted.value(writer.password))
					const pool = yield* poolFor(writer, {
						...defaultPool,
						password: { kind: "given", password: rotating.password },
						pool: { idleTimeoutMs: 60_000, min: 1, max: 4 }
					})
					yield* Effect.scoped(
						Effect.gen(function* () {
							for (let i = 0; i < 3; i++) {
								yield* Effect.flatMap(pool.lease, (session) =>
									rowsOn(session, "SELECT 1::text", [])
								)
							}
						})
					)
					const opened = yield* pool.size
					assert.equal(opened, 3)
					assert.equal(rotating.state.evaluations, opened)
					yield* s.admin.query(
						`ALTER ROLE ${quoteIdent(writer.role)} PASSWORD ${quoteString("rotated-secret")}`,
						[]
					)
					rotating.state.secret = "rotated-secret"
					yield* Effect.scoped(
						Effect.gen(function* () {
							for (let i = 0; i < 4; i++) {
								yield* Effect.flatMap(pool.lease, (session) =>
									rowsOn(session, "SELECT 1::text", [])
								)
							}
						})
					)
					const size = yield* pool.size
					assert.equal(size, 4)
					assert.equal(rotating.state.evaluations, 4)
				}).pipe(Effect.scoped)
		)

		it.effect(
			"makes CredentialError the reason of OpenError on opening and a later lease's refusal",
			() =>
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema(freshSchema)
					const writer = yield* substrateLogin(schema, "server", roleDefaults)
					const failing = Effect.fail(
						CredentialError.make({ cause: "the provider chain resolved nothing" })
					)
					const broken = yield* poolFor(writer, {
						...defaultPool,
						password: { kind: "given", password: failing }
					})
					const opened = yield* Effect.flip(Effect.scoped(leaseRefused(broken)))
					assert.ok(Schema.is(OpenError)(opened))
					assert.equal(opened.stage, "credential")
					assert.ok(Schema.is(CredentialError)(opened.reason))

					/**
					 * A provider that works at first and fails later: the first connection succeeds, a later attempt fails.
					 */
					const state = { ok: true }
					const flaky = Effect.suspend(() =>
						state.ok
							? Effect.succeed(writer.password)
							: Effect.fail(CredentialError.make({ cause: "the token could not be renewed" }))
					)
					const pool = yield* poolFor(writer, {
						...defaultPool,
						password: { kind: "given", password: flaky },
						pool: { idleTimeoutMs: 60_000, min: 1, max: 4 }
					})
					const leasedRows = yield* leased(pool, okQuery)
					assert.deepEqual(leasedRows, [["ok"]])
					state.ok = false
					const later = yield* Effect.scoped(
						Effect.gen(function* () {
							yield* pool.lease
							return yield* Effect.flip(pool.lease)
						})
					)
					assert.ok(Schema.is(CredentialError)(later))
					assert.equal(OpenError.make({ reason: later }).stage, "credential")
				}).pipe(Effect.scoped)
		)
	})
}
