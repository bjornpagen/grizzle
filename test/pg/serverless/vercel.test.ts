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
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): vercel-attach-per-lease.patch (the pool hook called on every lease),
 * vercel-unattached.patch (the pool never handed to the hook).
 */
import { layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, boolean, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { attachDatabasePool } from "@vercel/functions/db-connections"
import { Array as Arr, Effect, Formatter, Layer, ManagedRuntime, Option, Redacted } from "effect"
import { openServed } from "#adapter/db/served.ts"
import { compileServed } from "#adapter/public/compile.ts"
import { DbLayer, served } from "#adapter/public/layer.ts"
import type { ConnectionPool } from "#adapter/types/layer.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { uuid } from "#compiler/public/fields.ts"
import {
	login,
	relation,
	role,
	schema as schemaOf,
	wholeEntriesOf
} from "#compiler/public/schema.ts"
import {
	defaultPool,
	poolFor,
	roleDefaults,
	rowsOn,
	substrateLogin,
	until
} from "#test/pg/adapter/support.ts"
import { backendPid, onVercel, roleBackends, vercelRuntime } from "#test/pg/serverless/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { atDeclaredName, installationOf } from "#test/support/kernel/naming.ts"
import { caseHang, nodeTimerMin } from "#test/support/limits.ts"
import { fromEmpty, generate, noDeclarations } from "#test/support/migrate/kit.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"
import { isNativePool } from "#test/support/worlds/execute/pool.ts"

/**
 * A shop under the schema `name`, its role `app` and the login `worker` that holds it, and the shop's snapshot.json: a
 * layer of the login logs in as `<name>__worker`, the role the substrate creates for the schema.
 */
const shopUnder = (name: string) => {
	const shop = schemaOf(name, { Item: relation("Item", { id: uuid }, ["id"]) }, [])
	const app = role(shop, "app", wholeEntriesOf(shop))
	/** The shop's snapshot.json, as an import of it yields: what its login's served file is compiled under. */
	const snapshot = snapshotJson(
		succeeded(
			generate({
				declared: noDeclarations,
				installation: installationOf(shop, atDeclaredName),
				name: "shop",
				timestamp: "20261024000000",
				previous: fromEmpty,
				workload: noWorkload
			}),
			"the shop's first migration"
		).snapshotFiles.snapshot
	)
	return { app, worker: login(shop, "worker", [app]), snapshot }
}

/**
 * The real attachDatabasePool behind a hook that records every pool it is handed, in order, as an application passes
 * it: each test records its own.
 */
const recordedAttach = () => {
	const attached: Array<ConnectionPool> = []
	const attach = (pool: ConnectionPool): void => {
		attached.push(pool)
		attachDatabasePool(pool)
	}
	return { attached, attach, onVercelPool: { ...defaultPool, attachPool: attach } }
}

type VercelEnvFeature = "url and region" | "url only" | "region only" | "neither"

/** A pool on Vercel: its floor and maximum, and the bursts of leases held at once, each released whole. */
interface PoolCase {
	readonly min: number
	readonly max: number
	readonly bursts: Arr.NonEmptyReadonlyArray<number>
}

const poolCaseGen: Gen<PoolCase> = (source) => {
	const max = source.draw(int(1, 3))
	const burst = int(1, max)
	return {
		min: source.draw(int(0, max)),
		max,
		bursts: [source.draw(burst), ...source.draw(array(burst, { min: 0, max: 2 }))]
	}
}

type VercelPoolFeature =
	| "a burst the pool holds at once"
	| "several bursts"
	| "sessions above the floor closed"
	| "a floor of none"
	| "a burst within the floor"

layer(Substrate.layer, { excludeTestServices: true })("the session pool on Vercel", (it) => {
	it.effect(
		"hands Vercel a release's idle wait exactly when both VERCEL_URL and VERCEL_REGION are set",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema(freshSchema)
					const reader = yield* substrateLogin(schema, "server", roleDefaults)
					const { onVercelPool } = recordedAttach()
					const pool = yield* poolFor(reader, onVercelPool)
					let released = 0
					pool.native.on("release", () => {
						released += 1
					})
					const exhausted = yield* exhaust(
						{
							box: "VERCEL_URL and VERCEL_REGION, each set or unset",
							oracle: {
								kind: "specification",
								name: "attachDatabasePool's keep-alive: a release's wait exactly when both variables are set"
							},
							/**
							 * Vercel warns ("Pool release event triggered outside of request scope") only where both variables are set and the
							 * request context offers no waitUntil; the runtime played here always offers one, so the one wait handed over
							 * where both are set is also the proof that no release warned.
							 */
							suite: "serverless/vercel-env",
							generator: (source) => [source.draw(boolean), source.draw(boolean)] as const,
							literal: Formatter.format,
							coverage: requiredInSpace<VercelEnvFeature>([
								"url and region",
								"url only",
								"region only",
								"neither"
							]),
							caseHang
						},
						([url, region], c) =>
							Effect.gen(function* () {
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
							})
					)
					assert.equal(released, exhausted.cases)
					return exhausted
				}).pipe(Effect.scoped)
			)
	)

	it.effect(
		"attaches pg's own Pool once, when the pool is constructed, and keeps the instance alive past the idle timeout after each release, so the pool closes its idle sessions above the floor within it",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema(freshSchema)
					const reader = yield* substrateLogin(schema, "server", roleDefaults)
					return yield* explore(
						{
							suite: "serverless/vercel-pool",
							draw: drawn(poolCaseGen),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "attachDatabasePool's contract: one pg Pool attached at construction, one wait per release, each past the idle timeout pg's Pool carries"
							},
							coverage: required<VercelPoolFeature>(
								[
									"a burst the pool holds at once",
									"several bursts",
									"sessions above the floor closed",
									"a floor of none",
									"a burst within the floor"
								],
								{ cases: 30, sense: notesOnly }
							),
							kept: [],
							runs: 12,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(c, k) =>
							Effect.scoped(
								Effect.gen(function* () {
									/**
									 * The least delay a Node timer waits: the sessions are counted while their leases hold them, so the
									 * pool's idle timer only has to close those above the floor before Vercel's keep-alive after the last
									 * release ends.
									 */
									const idleTimeoutMs = nodeTimerMin.value
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
									assert.equal(
										handed.listenerCount("release"),
										1,
										"Vercel's release listener alone"
									)
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
									assert.equal(
										heldAtEnd.length,
										releases,
										"every wait is watched from its hand-over"
									)
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
								})
							)
					)
				}).pipe(Effect.scoped)
			)
	)

	it.effect(
		"reuses one module-scope pool across warm invocations, attached once and never on globalThis",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "serverless/vercel-instance",
						draw: drawn(int(1, 6)),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "one layer per instance: every invocation leases the one pool, attached once, its floor session reused"
						},
						coverage: required<"one invocation" | "warm invocations">(
							["one invocation", "warm invocations"],
							{ cases: 12, sense: notesOnly }
						),
						kept: [],
						runs: 4,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(invocations, k) =>
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
							const instance = ManagedRuntime.make(
								Layer.fresh(
									DbLayer.make({
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
						}).pipe(Effect.scoped)
				)
			)
	)
})
