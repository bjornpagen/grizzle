import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { boolean } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { attachDatabasePool } from "@vercel/functions/db-connections"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Layer,
	ManagedRuntime,
	Option,
	Redacted
} from "effect"
import { dbSessions } from "#adapter/pool/registry.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import type { ConnectionPool } from "#adapter/types/layer.ts"
import { poolBounds } from "#compiler/core/policy.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { uuid } from "#compiler/public/fields.ts"
import { login, relation, role, schema as schemaOf } from "#compiler/public/schema.ts"
import {
	defaultPool,
	poolFor,
	roleDefaults,
	rowsOn,
	substrateLogin,
	until
} from "#test/pg/adapter/support.ts"
import { backendPid, onVercel, roleBackends, vercelRuntime } from "#test/pg/serverless/support.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { pgPin } from "#test/support/env.ts"
import { atDeclaredName, installationOf } from "#test/support/kernel/naming.ts"
import { fromEmpty, generate } from "#test/support/migrate/kit.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

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
 * A login named `worker`, holding one role: the DbLayer a serverless function builds once is the layer of a login.
 */
/**
 * A shop under the schema `name`, its role `app` and the login `worker` that holds it: a layer of the login logs in as
 * `<name>__worker`, the role the substrate creates for the schema.
 */
const shopUnder = (name: string) => {
	const shop = schemaOf(name, { Item: relation("Item", { id: uuid }, ["id"]) }, [])
	const app = role(shop, "app", shop.relations)
	/** The shop's snapshot.json, as an import of it yields: what its login's layer is given. */
	const snapshot = snapshotJson(
		succeeded(
			generate({
				installation: installationOf(shop, atDeclaredName),
				name: "shop",
				timestamp: "20261024000000",
				previous: fromEmpty,
				workload: noWorkload
			}),
			"the shop's first migration"
		).snapshotText
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

layer(Substrate.layer, { excludeTestServices: true })("the session pool on Vercel", (it) => {
	it.effect("attaches pg's own Pool once, when the pool is constructed", () =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const schema = yield* s.schema(freshSchema)
			const reader = yield* substrateLogin(schema, "server", roleDefaults)
			const { attached, onVercelPool } = recordedAttach()
			const pool = yield* poolFor(reader, onVercelPool)
			assert.equal(attached.length, 1)
			assert.equal(attached[0], pool.native)
			assert.equal(pool.native.options.idleTimeoutMillis, poolBounds.idleTimeoutMs)
			assert.equal(pool.native.options.idleTimeoutMillis, pool.idleTimeoutMillis)
			assert.equal(pool.native.listenerCount("release"), 1)
			for (let i = 0; i < 3; i++) {
				yield* Effect.scoped(Effect.flatMap(pool.lease, (x) => rowsOn(x, backendPid, [])))
			}
			yield* Effect.scoped(pool.lease)
			assert.equal(attached.length, 1)
		}).pipe(Effect.scoped)
	)

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
							/**
							 * Vercel warns ("Pool release event triggered outside of request scope") only where both variables are set and the
							 * request context offers no waitUntil; the runtime played here always offers one, so the one wait handed over
							 * where both are set is also the proof that no release warned.
							 */
							suite: "serverless/vercel-env",
							generator: (source) => [source.draw(boolean), source.draw(boolean)] as const,
							literal: Formatter.format,
							limit: 4,
							features: features<VercelEnvFeature>([
								"url and region",
								"url only",
								"region only",
								"neither"
							]),
							caseHang: Duration.minutes(2)
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
		"keeps the instance alive for the idle timeout after each release, and the pool closes idle sessions within it",
		() =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const schema = yield* s.schema(freshSchema)
				const reader = yield* substrateLogin(schema, "server", roleDefaults)
				const idleTimeoutMs = 300
				/**
				 * Each wait is watched from the moment Vercel takes it: the test's release listener runs after Vercel's, which
				 * grizzle attached when it built the pool, so the wait a release hands over is already the context's newest. When a
				 * wait ends, the sessions the pool still holds are taken at once. Vercel's keep-alive outlasts the pool's idle
				 * timeout exactly when the last wait ends with the idle sessions above the floor already closed; were it shorter,
				 * the pool would still hold all three.
				 */
				const { onVercelPool } = recordedAttach()
				const pool = yield* poolFor(reader, {
					...onVercelPool,
					pool: { idleTimeoutMs, min: 1, max: 3 }
				})
				assert.equal(
					pool.native.options.idleTimeoutMillis,
					idleTimeoutMs,
					"pg's Pool carries the idle timeout Vercel derives its wait from"
				)
				const context = yield* vercelRuntime(onVercel, Option.none())
				const heldAtEnd: Array<Promise<number>> = []
				pool.native.on("release", () => {
					const handed = context.waits[heldAtEnd.length]
					if (handed !== undefined) {
						heldAtEnd.push(handed.then(() => pool.native.totalCount))
					}
				})
				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* Effect.all(
							Array.from({ length: 3 }, () =>
								Effect.flatMap(pool.lease, (x) => rowsOn(x, backendPid, []))
							),
							{ concurrency: 3 }
						)
						assert.equal(yield* pool.size, 3)
						assert.equal(yield* roleBackends(reader.role), 3)
					})
				)
				assert.equal(context.waits.length, 3)
				assert.equal(heldAtEnd.length, 3, "every wait is watched from its hand-over")
				const held = yield* Effect.promise(() => Promise.all(heldAtEnd))
				assert.equal(
					held[2],
					1,
					"when the last keep-alive ends, the pool holds only its floor: the instance outlived the idle sessions"
				)
				assert.equal(yield* pool.size, 1)
				yield* until(Effect.map(roleBackends(reader.role), (n) => n === 1))
			}).pipe(Effect.scoped)
	)

	it.effect(
		"reuses one module-scope pool across warm invocations, attached once and never on globalThis",
		() =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const schema = yield* s.schema(freshSchema)
				const worker = yield* substrateLogin(schema, "worker", roleDefaults)
				const shop = shopUnder(schema)
				const globalsBefore = new Set(Reflect.ownKeys(globalThis))
				const { attached, attach } = recordedAttach()
				/**
				 * The module of a serverless function: the layer is built once per instance, here into a
				 * ManagedRuntime, and every invocation runs on it.
				 */
				const instance = ManagedRuntime.make(
					Layer.fresh(
						DbLayer.make({
							login: shop.worker,
							snapshot: shop.snapshot,
							host: pgPin.host,
							port: pgPin.port,
							database: s.database,
							password: Redacted.make(Redacted.value(worker.password)),
							tls: { ca: s.cluster.caPem },
							attachPool: attach
						})
					)
				)
				yield* Effect.addFinalizer(() => Effect.promise(() => instance.dispose()))
				const invocation = Effect.scoped(
					Effect.gen(function* () {
						const sessions = yield* dbSessions<typeof shop.app>(shop.worker, shop.app.name)
						/** The pool logs in as the substrate's worker, whose name the layer derived when it was built. */
						const pool = sessions.pool
						const session = yield* pool.lease
						const pid = (yield* rowsOn(session, backendPid, []))[0]?.[0]
						return { sessions, pool, pid }
					})
				)
				const runs = []
				for (let i = 0; i < 4; i++) {
					runs.push(yield* Effect.promise(() => instance.runPromise(invocation)))
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
				assert.equal(yield* roleBackends(worker.role), 1)
				/**
				 * Nothing was added to globalThis, and nothing on it, or one level below it, is the pool, pg's Pool or the
				 * layer's service (a pool shared through a global can cross bundle copies of effect).
				 */
				const added = Arr.filter(Reflect.ownKeys(globalThis), (key) => !globalsBefore.has(key))
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
			}).pipe(Effect.scoped)
	)
})
