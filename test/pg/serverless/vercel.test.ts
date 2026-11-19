/**
 * The session pool on Vercel Fluid compute.
 *
 * A Vercel application passes attachDatabasePool from @vercel/functions/db-connections as DbConfig.attachPool; grizzle
 * depends on no Vercel package. Here it is the real @vercel/functions function, behind a hook that records each pool it
 * is handed and calls through, so the pool grizzle hands it, pg's own Pool, is checked by the integration itself (it
 * throws "Unsupported database pool type" for a pool it does not recognize). The Vercel runtime is played by
 * VERCEL_URL, VERCEL_REGION and the request context Vercel's runtime installs (support.ts).
 *
 * No verdict rests on how long anything took. Vercel's keep-alive is judged by what the pool holds when it ends: the
 * idle sessions above the floor already closed, so the instance outlived the pool's idle timeout; and by the idle
 * timeout pg's Pool carries, the one value Vercel derives its wait from.
 *
 * Three searches: the environment that turns the keep-alive on, the box of the two variables; drawn pools on Vercel,
 * each hands Vercel pg's own Pool once, when it is constructed, and every release a wait that outlasts the pool's idle
 * timeout, over drawn bounds and bursts of leases held at once; and a serverless function's module, its layer built once
 * per instance, over a drawn number of warm invocations that reuse one pool, attached once and never put on globalThis.
 *
 * A login named `worker`, holding one role: the DbLayer a serverless function builds once is the layer of the login's
 * served file.
 */
import { timerMinMs } from "@bjornpagen/grizzle/runtime"
import type { Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Layer, ManagedRuntime, Option, Redacted } from "effect"
import { openServed } from "#adapter/db/served.ts"
import { compileServed } from "#adapter/public/compile.ts"
import { served } from "#adapter/public/layer.ts"
import { poolFor, roleDefaults, rowsOn, substrateLogin, until } from "#test/pg/adapter/support.ts"
import { backendPid, onVercel, roleBackends, vercelRuntime } from "#test/pg/serverless/support.ts"
import {
	envGen,
	poolCaseGen,
	recordedAttach,
	shopUnder,
	type VercelEnvFeature,
	vercelLogin,
	type VercelPoolFeature
} from "#test/pg/serverless/vercel.fixtures.ts"
import { assert, defined } from "#test/support/assert.ts"
import { decodersIn, servedSourcedLayer } from "#test/support/live-layer.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"
import { isNativePool } from "#test/support/worlds/execute/pool.ts"

/**
 * The pool hands Vercel a release's idle wait exactly when both VERCEL_URL and VERCEL_REGION are set: a case's own pool
 * on Vercel, its one lease's one release, where the search counted every case's release on one pool after its box.
 *
 * Vercel warns ("Pool release event triggered outside of request scope") only where both variables are set and the
 * request context offers no waitUntil; the runtime played here always offers one, so the one wait handed over where
 * both are set is also the proof that no release warned.
 *
 * Its pre-conversion budget: the box, 4 cases (test/pg/serverless/vercel.test.ts at a236c166f).
 */
export const handsVercelAReleasesIdleWaitExactlyWhenBothVercelUrlAndVercelRegionAreSet =
	property.exhaust(finite(envGen), {
		needs: { login: Substrate.seat(vercelLogin) },
		situations: ["url and region", "url only", "region only", "neither"] satisfies ReadonlyArray<
			Reached<VercelEnvFeature>
		>,
		check:
			({ login }, c: Case<VercelEnvFeature>) =>
			([url, region]) =>
				Effect.scoped(
					Effect.flatMap(login, ({ substrate: seat, value: reader }) =>
						Effect.provideService(
							Effect.gen(function* () {
								const { onVercelPool } = recordedAttach()
								const pool = yield* poolFor(reader, onVercelPool)
								let released = 0
								pool.native.on("release", () => {
									released += 1
								})
								const context = yield* vercelRuntime(
									{
										VERCEL_URL: url ? onVercel.VERCEL_URL : Option.none(),
										VERCEL_REGION: region ? onVercel.VERCEL_REGION : Option.none()
									},
									Option.none()
								)
								yield* Effect.scoped(Effect.flatMap(pool.lease, (x) => rowsOn(x, backendPid, [])))
								assert.equal(context.waits.length, url && region ? 1 : 0)
								c.note(
									url
										? region
											? "url and region"
											: "url only"
										: region
											? "region only"
											: "neither"
								)
								assert.equal(released, 1, "the lease's one release")
							}),
							Substrate,
							seat
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "attachDatabasePool's keep-alive: a release's wait exactly when both variables are set"
		},
		box: "VERCEL_URL and VERCEL_REGION, each set or unset",
		show: Formatter.format,
		kept: [],
		kills: []
	})

/**
 * The pool attaches pg's own Pool once, when it is constructed, and keeps the instance alive past the idle timeout after
 * each release, so the pool closes its idle sessions above the floor within it.
 *
 * Its pre-conversion budget: runs 12, coverage cases 30 (test/pg/serverless/vercel.test.ts at a236c166f).
 */
export const attachesPgsOwnPoolOnceAndKeepsTheInstanceAlivePastTheIdleTimeoutAfterEachRelease =
	property.explore(poolCaseGen, {
		needs: { login: Substrate.seat(vercelLogin) },
		situations: [
			"a burst the pool holds at once",
			"several bursts",
			"sessions above the floor closed",
			"a floor of none",
			"a burst within the floor"
		] satisfies ReadonlyArray<Reached<VercelPoolFeature>>,
		check:
			({ login }, k: Case<VercelPoolFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(login, ({ substrate: seat, value: reader }) =>
						Effect.provideService(
							Effect.gen(function* () {
								/**
								 * The least delay a Node timer waits: the sessions are counted while their leases hold them, so the
								 * pool's idle timer only has to close those above the floor before Vercel's keep-alive after the last
								 * release ends.
								 */
								const idleTimeoutMs = timerMinMs
								const { attached, onVercelPool } = recordedAttach()
								const pool = yield* poolFor(reader, {
									...onVercelPool,
									pool: { idleTimeoutMs, min: c.min, max: c.max }
								})
								assert.equal(attached.length, 1, "attached once, when the pool is constructed")
								const [handed] = attached
								assert.ok(handed === pool.native, "the pool handed over is the pool's own")
								assert.ok(isNativePool(handed), "the pool handed over is pg's own Pool")
								assert.equal(
									pool.native.options.idleTimeoutMillis,
									idleTimeoutMs,
									"pg's Pool carries the idle timeout Vercel derives its wait from"
								)
								assert.equal(handed.listenerCount("release"), 1, "Vercel's release listener alone")
								const context = yield* vercelRuntime(onVercel, Option.none())
								/**
								 * Each wait is watched from the moment Vercel takes it: the test's release listener runs after Vercel's,
								 * which grizzle attached when it built the pool, so the wait a release hands over is already the
								 * context's newest. When a wait ends, the sessions the pool still holds are taken at once.
								 */
								const heldAtEnd: Array<Promise<number>> = []
								pool.native.on("release", () => {
									const wait = context.waits[heldAtEnd.length]
									if (wait !== undefined) {
										heldAtEnd.push(wait.then(() => pool.native.totalCount))
									}
								})
								for (const burst of c.bursts) {
									yield* Effect.scoped(
										Effect.gen(function* () {
											yield* Effect.all(
												Array.from({ length: burst }, () =>
													Effect.flatMap(pool.lease, (x) => rowsOn(x, backendPid, []))
												),
												{ concurrency: "unbounded" }
											)
											const size = yield* pool.size
											assert.ok(
												size >= burst && size <= c.max,
												"the burst's sessions, within the maximum"
											)
										})
									)
								}
								const releases = Arr.reduce(c.bursts, 0, (sum, burst) => sum + burst)
								assert.equal(context.waits.length, releases, "one wait per release")
								assert.equal(heldAtEnd.length, releases, "every wait is watched from its hand-over")
								assert.equal(attached.length, 1, "attached once, whatever the leases")
								const held = yield* Effect.promise(() => Promise.all(heldAtEnd))
								const last = defined(held.at(-1), "the last release's wait")
								const lastBurst = defined(c.bursts.at(-1), "the last burst")
								assert.ok(
									last <= c.min && last >= Math.min(lastBurst, c.min),
									`when the last keep-alive ends, the pool holds ${last}: only its floor of ${c.min}`
								)
								yield* until(Effect.map(roleBackends(reader.role), (n) => n <= c.min))
								if (lastBurst > c.min) {
									k.note("sessions above the floor closed")
								} else {
									k.note("a burst within the floor")
								}
								if (c.min === 0) {
									k.note("a floor of none")
								}
								if (Arr.some(c.bursts, (burst) => burst === c.max)) {
									k.note("a burst the pool holds at once")
								}
								if (c.bursts.length > 1) {
									k.note("several bursts")
								}
							}),
							Substrate,
							seat
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "attachDatabasePool's contract: one pg Pool attached at construction, one wait per release, each past the idle timeout pg's Pool carries"
		},
		show: Formatter.format,
		budget: { runs: 12, steered: 30 },
		kept: [],
		kills: []
	})

/**
 * A serverless function's module reuses one module-scope pool across warm invocations, attached once and never on
 * globalThis: each case its own schema and login, as each case of the search made them.
 *
 * Its pre-conversion budget: runs 4, coverage cases 12 (test/pg/serverless/vercel.test.ts at a236c166f).
 */
export const reusesOneModuleScopePoolAcrossWarmInvocationsAttachedOnceAndNeverOnGlobalThis =
	property.explore(int(1, 6), {
		needs: { substrate: Substrate.installing },
		situations: ["one invocation", "warm invocations"] satisfies ReadonlyArray<
			Reached<"one invocation" | "warm invocations">
		>,
		check:
			({ substrate }, k: Case<"one invocation" | "warm invocations">) =>
			(invocations) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const s = yield* Substrate
							const schema = yield* s.schema(freshSchema)
							const worker = yield* substrateLogin(schema, "worker", roleDefaults)
							const shop = shopUnder(schema)
							/** The login's served file, as `grizzle generate` compiles it under the shop's snapshot.json. */
							const json = yield* compileServed(shop.worker, shop.snapshot, shop.worker.workload)
							const file = served<typeof shop.worker>(json, "worker")
							const globalsBefore = new Set(Reflect.ownKeys(globalThis))
							const { attached, attach } = recordedAttach()
							/**
							 * The module of a serverless function: the layer is built once per instance, here into a
							 * ManagedRuntime, and every invocation runs on it.
							 */
							const scope = yield* Effect.scope
							const decoderOf = yield* decodersIn(s, scope)
							const instance = ManagedRuntime.make(
								Layer.fresh(
									servedSourcedLayer(decoderOf, {
										...clusterConnection(
											s.cluster,
											s.database,
											Redacted.make(Redacted.value(worker.password))
										),
										pool: clusterPool,
										login: file,
										attachPool: attach
									})
								)
							)
							yield* Effect.addFinalizer(() => Effect.promise(() => instance.dispose()))
							const invocation = Effect.scoped(
								Effect.gen(function* () {
									const { sessions } = yield* openServed(file.roles.app, {})
									/** The pool logs in as the substrate's worker, whose name the layer derived when it was built. */
									const pool = sessions.pool
									const session = yield* pool.lease
									const pid = (yield* rowsOn(session, backendPid, []))[0]?.[0]
									return { sessions, pool, pid }
								})
							)
							const runs = []
							for (let i = 0; i < invocations; i++) {
								const run = yield* Effect.promise(() => instance.runPromise(invocation))
								runs.push(run)
							}
							/** The floor session is reused: a warm invocation does not reconnect. */
							const [first] = runs
							if (first === undefined) {
								throw new Error("no invocation ran")
							}
							assert.deepEqual(
								Arr.map(runs, (run) => [run.sessions, run.pool, run.pid] as const),
								Arr.map(runs, () => [first.sessions, first.pool, first.pid] as const)
							)
							assert.equal(attached.length, 1)
							assert.equal(attached[0], first.pool.native)
							const backends = yield* roleBackends(worker.role)
							const opened = yield* first.pool.size
							assert.equal(
								backends,
								opened,
								"the login's backends are the one pool's sessions alone"
							)
							/**
							 * Nothing was added to globalThis, and nothing on it, or one level below it, is the pool, pg's Pool or the
							 * layer's service (a pool shared through a global can cross bundle copies of effect).
							 */
							const added = Arr.filter(
								Reflect.ownKeys(globalThis),
								(key) => !globalsBefore.has(key)
							)
							assert.deepEqual(added, [])
							/** Data properties only: reading an accessor (Node's localStorage) has side effects of its own. */
							const dataValues = (target: object): Array<unknown> =>
								Arr.flatMap(Reflect.ownKeys(target), (key) => {
									const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
									if (descriptor === undefined || !("value" in descriptor)) {
										return []
									}
									const value: unknown = descriptor.value
									return [value]
								})
							const forbidden = new Set<unknown>([first.pool, first.pool.native, first.sessions])
							for (const value of dataValues(globalThis)) {
								assert.equal(forbidden.has(value), false)
								if (typeof value !== "object" || value === null) {
									continue
								}
								for (const nested of dataValues(value)) {
									assert.equal(forbidden.has(nested), false)
								}
							}
							k.note(invocations === 1 ? "one invocation" : "warm invocations")
						})
					),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "one layer per instance: every invocation leases the one pool, attached once, its floor session reused"
		},
		show: Formatter.format,
		budget: { runs: 4, steered: 12 },
		kept: [],
		kills: []
	})
