import { createServer, type Socket } from "node:net"
import { layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, constant, element, type Gen, int, map, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Deferred, Effect, Exit, Formatter, Redacted, Result } from "effect"
import { ReadFailure } from "#adapter/errors/execution.ts"
import { CredentialError, type TlsFault } from "#adapter/errors/failures.ts"
import type { SessionPool } from "#adapter/wire/session.ts"
import { quoteIdent, quoteString } from "#compiler/sql/print.ts"
import {
	defaultPool,
	poolFor,
	roleDefaults,
	rowsOn,
	substrateLogin
} from "#test/pg/adapter/support.ts"
import { assert, assertVariant } from "#test/support/assert.ts"
import type { InitializedClusterShape } from "#test/support/cluster.ts"
import { pgPin } from "#test/support/env.ts"
import { caseHang, testIdleTimeout } from "#test/support/limits.ts"
import { clusterTransport } from "#test/support/pg.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

const currentUser =
	"SELECT current_user::text, (SELECT ssl::text FROM pg_catalog.pg_stat_ssl WHERE pid = pg_catalog.pg_backend_pid())"

/** A statement every session answers with one row. */
const okQuery = "SELECT 'ok'::text"

/** One lease of the pool: the session's rows for `sql`, or the lease's failure. */
const leased = (pool: SessionPool, sql: string) =>
	Effect.scoped(Effect.flatMap(pool.lease, (session) => rowsOn(session, sql, [])))

/** A lease's refusal as a Db's call reports it: a ReadFailure at stage acquire, the refusal its reason. */
const leaseRefused = (pool: SessionPool) =>
	Effect.mapError(pool.lease, (reason) => new ReadFailure({ reason }))

/** What refused a lease of the pool, which must fail: its reason's tag; a failure after the lease, by its own tag. */
const refusedBy = (pool: SessionPool) =>
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
const handshakeRecord = 0x16

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
const answeringServer = (answer: Buffer) =>
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
const answerGen: Gen<ReadonlyArray<number>> = weighted<ReadonlyArray<number>>([
	[2, map(answerByte, (b) => [b])],
	[1, array(answerByte, { min: 2, max: 3 })]
])

type AnswerFeature =
	| "answered yes"
	| "answered no"
	| "answered an ErrorResponse's letter"
	| "answered another byte"
	| "answered more than one byte"

/** What a client must make of an answer: TLS for exactly `S`, no TLS offered for exactly `N`, no answer otherwise. */
const answerFault = (answer: Buffer): TlsFault["kind"] =>
	answer.equals(Buffer.from("S"))
		? "handshake"
		: answer.equals(Buffer.from("N"))
			? "notOffered"
			: "unanswered"

/** The feature an answer reaches. */
const answerFeature = (answer: Buffer): AnswerFeature =>
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

const credentialProgramGen: Gen<CredentialProgram> = (source) => {
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

const providerAt = (mode: ProviderMode, version: number): Provider =>
	mode === "pinned" ? { kind: "pinned", version } : { kind: mode }

/**
 * What a lease that finds no idle session meets: one evaluation of the password Effect, which fails with the
 * CredentialError when the provider fails, with the server's refusal (authentication) when it answers a version of the
 * password the role no longer holds, and opens a session otherwise.
 */
type Attempt = "opened" | "credential" | "authentication"

const attemptOf = (provider: Provider, version: number): Attempt => {
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

type CredentialFeature =
	| "a session reused"
	| "a session opened"
	| "refused at credential"
	| "refused at authentication"
	| "opened after a rotation"
	| "reused while no new session could open"

/**
 * The names the local server's certificate carries (scripts/pg/init.sh: DNS:localhost, IP:127.0.0.1, IP:::1): verify-full
 * accepts a session exactly when the CA bundle is the local CA and the name it verifies is one of these.
 */
const certificateNames: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1"])

type CaChoice = "local" | "wrong"

/**
 * The cluster's CA, and another CA, which the cluster holds too. There is no unverified mode: an empty bundle, nothing
 * to verify against, never reaches a pool, since the parse of the connection refuses it at stage config
 * (test/unit/adapter/layer.test.ts).
 */
const caOf = (cluster: InitializedClusterShape): { readonly [C in CaChoice]: string } => ({
	local: cluster.caPem,
	wrong: cluster.wrongCaPem
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

type TlsFeature =
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
const tlsConfigs: Gen<TlsConfig> = (source) => ({
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

/**
 * Connections, TLS and credentials through the adapter.
 *
 * - verify-full TLS, exhaustively over the axes a deployment sets (CA bundle, host dialled, name verified): a session
 *   is accepted exactly when the CA is the server's and the verified name is one its certificate carries, and it logs
 *   in as the role it named, over TLS; there is no unverified mode;
 * - no plaintext fallback, over drawn answers of a server to the SSLRequest (the protocol's letters and any byte, one
 *   to three of them): exactly `S` starts a TLS handshake, which a server that speaks no TLS refuses with TlsRefused,
 *   and any other answer is refused with TlsRefused, `N` as no TLS offered and the rest as no answer, the client
 *   sending nothing after its request;
 * - the password Effect, over drawn programs of leases, rotations of the role's password and a provider that follows
 *   the role's password, is pinned to one version of it, answers one it never had, or fails: a lease takes an idle
 *   session without asking for a password, and every other lease evaluates the Effect once, and opens a session, or is
 *   refused at stage acquire with the CredentialError as its reason or with the server's refusal, as the provider's
 *   answer meets the role's password then, a model of the pool's idle sessions judging each.
 *
 * Db.open leases nothing: a lease's refusal is the refusal of a Db's call, a ReadFailure or a TransportFailure at stage
 * acquire, its reason telling a credential, a TLS and a server's refusal apart.
 *
 * The logins a Db opens through and the roles it may run as are the worlds model's (test/pg/world-model), and what a
 * Db's reads meet on databases with and without its schema is reads/suites/open.ts's.
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
								box: { kind: "unstated" },
								oracle: { kind: "unstated" },
								suite: "adapter/tls",
								generator: tlsConfigs,
								literal: Formatter.format,
								limit: 64,
								coverage: requiredInSpace<TlsFeature>([
									"connected",
									"refused wrong ca",
									"refused host name",
									"refused override name",
									"connected through an override"
								]),
								caseHang
							},
							(config, c) =>
								Effect.gen(function* () {
									const verified =
										config.servername.kind === "host" ? config.host : config.servername.servername
									const pool = yield* poolFor(writer, {
										...defaultPool,
										transport: {
											kind: "given",
											transport: {
												...clusterTransport(s.cluster),
												host: config.host,
												ca: caOf(s.cluster)[config.ca],
												servername: verified
											}
										}
									})
									if (config.ca !== "local") {
										const refusal = yield* refusedBy(pool)
										assert.equal(refusal, "TlsRefused")
										c.note(`refused ${config.ca} ca`)
									} else if (!certificateNames.has(verified)) {
										const refusal = yield* refusedBy(pool)
										assert.equal(refusal, "TlsRefused")
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
			"never falls back to plaintext: after its SSLRequest a client sends nothing but a TLS handshake, whatever the server answers",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const schema = yield* s.schema(freshSchema)
						const writer = yield* substrateLogin(schema, "server", roleDefaults)
						return yield* explore(
							{
								suite: "adapter/tls answers",
								draw: drawn(answerGen),
								literal: Formatter.format,
								kept: [],
								runs: 16,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								coverage: required<AnswerFeature>(
									[
										"answered yes",
										"answered no",
										"answered an ErrorResponse's letter",
										"answered another byte",
										"answered more than one byte"
									],
									{ cases: 40, sense: notesOnly }
								),
								caseHang,
								oracle: {
									kind: "specification",
									name: "PostgreSQL's SSLRequest exchange: TLS after exactly S, and the connection refused otherwise"
								}
							},
							(bytes, c) =>
								Effect.gen(function* () {
									const answer = Buffer.from(bytes)
									const server = yield* answeringServer(answer)
									const pool = yield* poolFor(writer, {
										...defaultPool,
										transport: {
											kind: "given",
											transport: { ...clusterTransport(s.cluster), port: server.port }
										}
									})
									const refused = yield* Effect.flip(Effect.scoped(leaseRefused(pool)))
									const after = yield* server.after
									assert.equal(refused.stage, "acquire")
									assertVariant(refused.reason, "_tag", "TlsRefused")
									const fault = answerFault(answer)
									assert.equal(refused.reason.fault.kind, fault)
									if (fault === "handshake") {
										assert.equal(after[0], handshakeRecord, "what follows yes is a TLS handshake")
									} else {
										assert.equal(after.length, 0, "a client told anything but yes sends nothing")
									}
									c.note(answerFeature(answer))
								})
						)
					}).pipe(Effect.scoped)
				)
		)

		it.effect(
			"evaluates the password Effect once per connection attempt and opens, or refuses at credential or authentication, as its answer meets the role's password",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const schema = yield* s.schema(freshSchema)
						const writer = yield* substrateLogin(schema, "server", roleDefaults)
						const base = Redacted.value(writer.password)
						/** The role's password at a version: the one it was created with, then each rotation's. */
						const secretAt = (version: number): string =>
							version === 0 ? base : `${base}-${version}`
						const setPassword = (version: number) =>
							s.admin.query(
								`ALTER ROLE ${quoteIdent(writer.role)} PASSWORD ${quoteString(secretAt(version))}`,
								[]
							)
						return yield* explore(
							{
								suite: "adapter/credentials",
								draw: drawn(credentialProgramGen),
								literal: Formatter.format,
								kept: [],
								runs: 12,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								coverage: required<CredentialFeature>(
									[
										"a session reused",
										"a session opened",
										"refused at credential",
										"refused at authentication",
										"opened after a rotation",
										"reused while no new session could open"
									],
									{ cases: 24, sense: notesOnly }
								),
								caseHang,
								oracle: {
									kind: "specification",
									name: "a model of the pool's sessions and its password: one evaluation per new connection, judged against the role's password"
								}
							},
							(program, c) =>
								Effect.gen(function* () {
									yield* setPassword(0)
									/** The model: the pool's idle sessions, the role's password version, the provider, its evaluations. */
									let idle = 0
									let version = 0
									let provider = providerAt(program.provider, 0)
									let evaluations = 0
									/** The password Effect: it answers as the model's provider does, counting each evaluation. */
									const live = { provider, version, evaluations: 0 }
									const password = Effect.suspend(() => {
										live.evaluations += 1
										const answering = live.provider
										switch (answering.kind) {
											case "fails":
												return Effect.fail(
													new CredentialError({ cause: "the provider chain resolved nothing" })
												)
											case "pinned":
												return Effect.succeed(Redacted.make(secretAt(answering.version)))
											case "wrong":
												return Effect.succeed(Redacted.make(`${base}-wrong`))
											case "follows":
												return Effect.succeed(Redacted.make(secretAt(live.version)))
										}
									})
									const pool = yield* poolFor(writer, {
										...defaultPool,
										password: { kind: "given", password },
										pool: { idleTimeoutMs: testIdleTimeout.value, min: 1, max: program.max }
									})
									for (const step of program.steps) {
										switch (step.kind) {
											case "rotate": {
												version += 1
												yield* setPassword(version)
												live.version = version
												break
											}
											case "provider": {
												provider = providerAt(step.mode, version)
												live.provider = provider
												break
											}
											case "lease": {
												let held = 0
												yield* Effect.scoped(
													Effect.gen(function* () {
														for (let k = 0; k < step.count; k++) {
															const attempted = yield* Effect.result(leaseRefused(pool))
															if (idle > 0) {
																assertVariant(
																	attempted,
																	"_tag",
																	"Success",
																	"an idle session is reused"
																)
																idle -= 1
																c.note("a session reused")
																if (attemptOf(provider, version) !== "opened") {
																	c.note("reused while no new session could open")
																}
															} else {
																const attempt = attemptOf(provider, version)
																evaluations += 1
																if (attempt === "opened") {
																	assertVariant(attempted, "_tag", "Success", "a new session opens")
																	c.note("a session opened")
																	if (version > 0) {
																		c.note("opened after a rotation")
																	}
																} else {
																	assertVariant(
																		attempted,
																		"_tag",
																		"Failure",
																		"a new session is refused"
																	)
																	assert.equal(attempted.failure.stage, "acquire")
																	assert.equal(
																		attempted.failure.reason._tag,
																		attempt === "credential" ? "CredentialError" : "StartupRefused"
																	)
																	c.note(`refused at ${attempt}`)
																}
															}
															if (Result.isSuccess(attempted)) {
																held += 1
																const rows = yield* rowsOn(attempted.success, currentUser, [])
																assert.deepEqual(rows, [[writer.role, "true"]])
															}
														}
													})
												)
												idle += held
												break
											}
										}
										assert.equal(live.evaluations, evaluations, "one evaluation per attempt")
										const size = yield* pool.size
										assert.equal(size, idle, "every session opened is idle in the pool")
									}
								})
						)
					}).pipe(Effect.scoped)
				)
		)
	})
}
