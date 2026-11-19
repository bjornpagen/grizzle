/**
 * Connections, TLS and credentials through the adapter.
 *
 * - verify-full TLS, exhaustively over the axes a deployment sets (CA bundle, host dialled, name verified): a session
 *   is accepted exactly when the CA is the server's and the verified name is one its certificate carries, and it logs
 *   in as the role it named, over TLS; there is no unverified mode. Oracle: the certificate's names (@bjornpagen/testing/pg)
 *   and its CA, as a checker.
 * - no plaintext fallback, over drawn answers of a server to the SSLRequest (the protocol's letters and any byte, one
 *   to three of them): exactly `S` starts a TLS handshake, which a server that speaks no TLS refuses with TlsRefused,
 *   and any other answer is refused with TlsRefused, `N` as no TLS offered and the rest as no answer, the client
 *   sending nothing after its request. Oracle: PostgreSQL's SSLRequest exchange.
 * - the password Effect, over drawn programs of leases, rotations of the role's password and a provider that follows
 *   the role's password, is pinned to one version of it, answers one it never had, or fails: a lease takes an idle
 *   session without asking for a password, and every other lease evaluates the Effect once, and opens a session, or is
 *   refused at stage acquire with the CredentialError as its reason or with the server's refusal, as the provider's
 *   answer meets the role's password then. Oracle: a model of the pool's idle sessions and the role's password.
 *
 * Db.open leases nothing: a lease's refusal is the refusal of a Db's call, at stage acquire. The logins a Db opens
 * through are the worlds model's (test/pg/world-model), and a Db's reads on databases with and without its schema are
 * test/pg/reads/open.test.ts's.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Redacted, Result } from "effect"
import { CredentialError } from "#adapter/errors/failures.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import {
	answerFault,
	type AnswerFeature,
	answerFeature,
	answerGen,
	answeringServer,
	attemptOf,
	caOf,
	certificateNames,
	type CredentialFeature,
	credentialProgramGen,
	currentUser,
	handshakeRecord,
	leased,
	leaseRefused,
	providerAt,
	refusedBy,
	serverLogin,
	tlsConfigs,
	type TlsFeature
} from "#test/pg/adapter/connection.fixtures.ts"
import {
	defaultPool,
	poolFor,
	roleDefaults,
	rowsOn,
	substrateLogin
} from "#test/pg/adapter/support.ts"
import { assert, assertVariant } from "#test/support/assert.ts"
import { testIdleTimeout } from "#test/support/limits.ts"
import { clusterTransport } from "#test/support/pg.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Adapter connections connects exactly when the CA is the server's and the verified name is one its certificate carries.
 */
export const adapterConnectionsConnectsExactlyWhenTheCAIsTheServersAndTheVerifiedNameIsOneItsCertificateCarries =
	property.exhaust(finite(tlsConfigs), {
		needs: { login: Substrate.seat(serverLogin) },
		situations: [
			"connected",
			"refused wrong ca",
			"refused host name",
			"refused override name",
			"connected through an override"
		] satisfies ReadonlyArray<Reached<TlsFeature>>,
		check:
			({ login }, c: Case<TlsFeature>) =>
			(config) =>
				Effect.flatMap(login, ({ substrate: seat, value: writer }) =>
					Effect.provideService(
						Effect.gen(function* () {
							const s = yield* Substrate

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
								c.note(`refused ${config.servername.kind === "host" ? "host" : "override"} name`)
							} else {
								const leasedRows = yield* leased(pool, currentUser)
								assert.deepEqual(leasedRows, [[writer.role, "true"]])
								c.note(
									config.servername.kind === "host" ? "connected" : "connected through an override"
								)
							}
						}).pipe(Effect.scoped),
						Substrate,
						seat
					)
				),
		oracle: {
			kind: "specification",
			name: "verify-full: the server's CA and a name its certificate carries"
		},
		box: "every CA bundle, dialled host and verified name a deployment sets",
		kept: [],
		kills: []
	})

/**
 * Adapter connections never falls back to plaintext: after its SSLRequest a client sends nothing but a TLS handshake, whatever the server answers.
 *
 * Its pre-conversion budget: runs 16, coverage cases 40 (test/pg/adapter/connection.test.ts at d8eed1786).
 */
export const adapterConnectionsNeverFallsBackToPlaintextAfterItsSSLRequestAClientSendsNothingButATLSHandshakeWhateverTheServerAnswers =
	property.explore(answerGen, {
		needs: { login: Substrate.seat(serverLogin) },
		situations: [
			"answered yes",
			"answered no",
			"answered an ErrorResponse's letter",
			"answered another byte",
			"answered more than one byte"
		] satisfies ReadonlyArray<Reached<AnswerFeature>>,
		check:
			({ login }, c: Case<AnswerFeature>) =>
			(bytes) =>
				Effect.flatMap(login, ({ substrate: seat, value: writer }) =>
					Effect.provideService(
						Effect.gen(function* () {
							const s = yield* Substrate

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
						}).pipe(Effect.scoped),
						Substrate,
						seat
					)
				),
		oracle: {
			kind: "specification",
			name: "PostgreSQL's SSLRequest exchange: TLS after exactly S, and the connection refused otherwise"
		},
		budget: { runs: 16, steered: 40 },
		kept: [],
		kills: []
	})

/**
 * Adapter connections evaluates the password Effect once per connection attempt and opens, or refuses at credential or authentication, as its answer meets the role's password.
 *
 * Its pre-conversion budget: runs 12, coverage cases 24 (test/pg/adapter/connection.test.ts at d8eed1786).
 */
export const adapterConnectionsEvaluatesThePasswordEffectOncePerConnectionAttemptAndOpensOrRefusesAtCredentialOrAuthenticationAsItsAnswerMeetsTheRolesPassword =
	property.explore(credentialProgramGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			"a session reused",
			"a session opened",
			"refused at credential",
			"refused at authentication",
			"opened after a rotation",
			"reused while no new session could open"
		] satisfies ReadonlyArray<Reached<CredentialFeature>>,
		check:
			({ substrate }, c: Case<CredentialFeature>) =>
			(program) =>
				Effect.provideServiceEffect(
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
							pool: { idleTimeoutMs: testIdleTimeout, min: 1, max: program.max }
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
													assertVariant(attempted, "_tag", "Success", "an idle session is reused")
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
														assertVariant(attempted, "_tag", "Failure", "a new session is refused")
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
					}).pipe(Effect.scoped),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "a model of the pool's sessions and its password: one evaluation per new connection, judged against the role's password"
		},
		budget: { runs: 12, steered: 24 },
		kept: [],
		kills: []
	})
