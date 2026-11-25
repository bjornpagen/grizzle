/**
 * The session pool's release against the cluster (adapter/wire/pool.ts makePool's end).
 *
 * - Wait: over both ends of the wait, an idle session whose backend's exit the bootstrap superuser holds (a lock on its
 *   temporary schema) is waited for: the release has not returned while the backend waits, then returns once the hold
 *   is let go and leaves no backend, or, interrupted, ends at once with the session destroyed.
 * - Exit: exhaustively over one to three idle sessions, each holding no temporary table or as many as a session of
 *   pantry's export suite did, once the layer's release returns no backend of them is left in pg_stat_activity, so a
 *   DROP DATABASE after it finds none.
 *
 * Features: a held exit let go and a wait interrupted; one session and several, with and without temporary tables.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Exit, Fiber, Scope } from "effect"
import {
	type ExitFeature,
	exits,
	holdSchemaSql,
	oneTemporaryTableSql,
	temporarySchemaSql,
	temporaryTablesSql,
	type WaitFeature,
	waitEnds
} from "#test/pg/adapter/pool.fixtures.ts"
import {
	backendPidOf,
	backendState,
	defaultPool,
	poolFor,
	roleDefaults,
	rowsOn,
	substrateLogin,
	until
} from "#test/pg/adapter/support.ts"
import { superuserClient } from "#test/support/substrate/shared.ts"
import { freshSchema, Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * Adapter session pool's release waits for an idle session's backend to exit, until the release is interrupted.
 */
export const adapterSessionPoolsReleaseWaitsForAnIdleSessionsBackendToExitUntilTheReleaseIsInterrupted =
	property.exhaust(finite(waitEnds), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: ["released idle, closed", "released idle, interrupted"] satisfies ReadonlyArray<
			Reached<WaitFeature>
		>,
		check:
			({ substrate }, c: Case<WaitFeature>) =>
			(end) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const schema = yield* s.schema(freshSchema)
						const login = yield* substrateLogin(schema, "server", roleDefaults)

						const scope = yield* Effect.scope
						const layerScope = yield* Scope.fork(scope)
						const pool = yield* Scope.provide(
							poolFor(login, {
								...defaultPool,
								pool: { max: 1 }
							}),
							layerScope
						)
						const leaseScope = yield* Scope.fork(scope)
						const session = yield* Scope.provide(pool.lease, leaseScope)
						const pid = yield* backendPidOf(session)
						yield* rowsOn(session, oneTemporaryTableSql, [])
						const [temporary] = yield* rowsOn(session, temporarySchemaSql, [])
						const held = String(temporary?.[0])
						yield* Scope.close(leaseScope, Exit.void)
						const holder = yield* superuserClient(s.cluster, s.database, "pool exit holder")
						yield* holder.query("BEGIN", [])
						yield* holder.query(holdSchemaSql(held), [])
						const releasing = yield* Effect.forkChild(Scope.close(layerScope, Exit.void), {
							startImmediately: true
						})
						yield* until(
							Effect.map(backendState(pid), (b) => b.state !== "gone" && b.waitEvent === "object")
						)
						assert.equal(
							releasing.pollUnsafe(),
							undefined,
							"the release waits while the backend's exit is held"
						)
						if (end === "closed") {
							yield* holder.query("COMMIT", [])
							const released = yield* Fiber.await(releasing)
							assert.ok(Exit.isSuccess(released), "the release returns once the server closes")
							const left = yield* backendState(pid)
							assert.equal(left.state, "gone", "no backend is left once the release returns")
						} else {
							const released = yield* Effect.andThen(
								Fiber.interrupt(releasing),
								Fiber.await(releasing)
							)
							assert.ok(Exit.hasInterrupts(released), "the release ends as its interruption")
							yield* holder.query("COMMIT", [])
							yield* until(Effect.map(backendState(pid), (b) => b.state === "gone"))
						}
						assert.equal(
							session.state(),
							"ended",
							"the layer's release has ended its session once it returns"
						)
						c.note(`released idle, ${end}`)
					}),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "PostgreSQL closes a backend's connection only once the backend has exited (REL_19_0 src/backend/libpq/pqcomm.c socket_close), and an interrupted release ends at once"
		},
		box: "an idle session holding a temporary table, its exit held then let go, or its release interrupted while held",
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/wire/pool.ts",
				original: "\t\t\t\t} else if (held.has(client)) {",
				replacement: "\t\t\t\t} else if (wires.has(client)) {",
				why: "The end destroys every wire, an idle session's among them, as it did before it waited (d81ee19dc): the release returns while the backend's exit is still held, where it waits for the server's close."
			}
		]
	})

/**
 * Adapter session pool's release returns once no backend of its idle sessions is left, their temporary tables dropped.
 */
export const adapterSessionPoolsReleaseReturnsOnceNoBackendOfItsIdleSessionsIsLeftTheirTemporaryTablesDropped =
	property.exhaust(finite(exits), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"one session",
			"several sessions",
			"no temporary table",
			"temporary tables"
		] satisfies ReadonlyArray<Reached<ExitFeature>>,
		check:
			({ substrate }, c: Case<ExitFeature>) =>
			(k) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const schema = yield* s.schema(freshSchema)
						const login = yield* substrateLogin(schema, "server", roleDefaults)

						const scope = yield* Effect.scope
						const layerScope = yield* Scope.fork(scope)
						const pool = yield* Scope.provide(
							poolFor(login, {
								...defaultPool,
								pool: { max: k.sessions }
							}),
							layerScope
						)
						const pids = yield* Effect.scoped(
							Effect.all(
								Array.from({ length: k.sessions }, () =>
									Effect.gen(function* () {
										const session = yield* pool.lease
										if (k.tables > 0) {
											yield* rowsOn(session, temporaryTablesSql(k.tables), [])
										}
										return yield* backendPidOf(session)
									})
								),
								{ concurrency: k.sessions }
							)
						)
						assert.equal(new Set(pids).size, k.sessions, "each session is its own backend")
						const { leased } = yield* pool.state
						assert.equal(leased, 0, "every session is idle when the layer is released")
						yield* Scope.close(layerScope, Exit.void)
						for (const pid of pids) {
							const left = yield* backendState(pid)
							assert.equal(
								left.state,
								"gone",
								"no backend of the pool is left once its release returns"
							)
						}
						c.note(k.sessions === 1 ? "one session" : "several sessions")
						c.note(k.tables === 0 ? "no temporary table" : "temporary tables")
					}),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "PostgreSQL closes a backend's connection only once the backend has exited, its temporary relations dropped and the backend out of the database's (REL_19_0 src/backend/libpq/pqcomm.c socket_close)"
		},
		box: "one to three idle sessions, each holding no temporary table or as many as a session of pantry's export suite did",
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/wire/pool.ts",
				original: "\t\t\treturn closedAll(closing)",
				replacement: "\t\t\treturn Effect.void",
				why: "The end writes each idle session's Terminate and returns without waiting for its close: the backends are still dropping their temporary tables when the release returns, so pg_stat_activity still holds them, as edullm's DROP DATABASE found one (P5)."
			}
		]
	})
