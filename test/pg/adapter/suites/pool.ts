import { layer } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Exit, Formatter, Scope } from "effect"
import type { Session } from "#adapter/wire/session.ts"
import {
	backendPidOf,
	backendState,
	defaultPool,
	poolFor,
	roleDefaults,
	substrateLogin,
	until
} from "#test/pg/adapter/support.ts"
import { assert, lacks } from "#test/support/assert.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

/** One step as drawn: what it does, and which leased session it picks. */
interface StepSketch {
	readonly kind: "lease" | "release" | "retire" | "lose"
	readonly pick: number
}

interface Sequence {
	readonly max: number
	readonly steps: ReadonlyArray<StepSketch>
}

const sequenceGen: Gen<Sequence> = (source) => ({
	max: source.draw(int(1, 3)),
	steps: source.draw(
		array<StepSketch>(
			(step) => ({
				kind: step.draw(element(["lease", "release", "retire", "lose"] as const)),
				pick: step.draw(pickGen)
			}),
			{ min: 1, max: 16 }
		)
	)
})

/**
 * Planted: one sequence on a pool of one, a session leased, released and leased idle again, then retired and its
 * connection lost, a new session leased after each, which the drawn sequences reach a few times a run.
 */
const step = (kind: StepSketch["kind"]): StepSketch => ({ kind, pick: 0 })
const poolKept: ReadonlyArray<Kept<Sequence, PoolFeature>> = [
	{
		note: "a retirement and a lost connection on a pool of one",
		sketch: {
			max: 1,
			steps: [
				step("lease"),
				step("release"),
				step("lease"),
				step("retire"),
				step("lease"),
				step("lose")
			]
		},
		draws: "",
		reaches: [
			"connection lost",
			"released",
			"leased after a retirement",
			"leased an idle session",
			"retired"
		]
	}
]

type PoolFeature =
	| "retired"
	| "connection lost"
	| "released"
	| "leased after a retirement"
	| "leased an idle session"
	| "leased a new session"

const situations: Arr.NonEmptyReadonlyArray<PoolFeature> = [
	"retired",
	"connection lost",
	"released",
	"leased after a retirement",
	"leased an idle session",
	"leased a new session"
]

/** A leased session in the model: the session, its backend and the scope its lease lives in. */
interface Held {
	readonly session: Session
	readonly pid: number
	readonly scope: Scope.Closeable
}

/**
 * The session pool's retirement of a session, over pg's own Pool (packages/grizzle/src/adapter/wire/session.ts): a session retired for
 * any reason (an interruption with a statement in flight, a lost connection, a transaction it could not end), or whose
 * connection was lost, is released with an error, so pg's Pool closes it instead of keeping it, and it is never handed
 * out again.
 *
 * A property over drawn lease sequences against a model of the pool: each step leases a session, releases one, retires
 * one and releases it, or ends one's connection and releases it, on a pool of a drawn maximum (1 to 3). The model holds
 * the leased sessions, the idle ones and the retired ones; after every step the pool's leased count is the model's, a
 * retired or lost session's release closes exactly that session (the pool's size falls by one) where any other release
 * keeps it, a leased session is never one the model retired, never retired and never lost, its backend is never a
 * retired one's, and every retired backend exits.
 */
export const poolSuite = (): void => {
	layer(Substrate.layer, { excludeTestServices: true })("adapter session pool", (it) => {
		it.effect(
			"never hands out a retired or lost session again, over drawn lease sequences",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const schema = yield* s.schema(freshSchema)
						const reader = yield* substrateLogin(schema, "server", roleDefaults)
						return yield* explore(
							{
								suite: `pg/adapter/pool/retired`,
								draw: drawn(sequenceGen),
								literal: Formatter.format,
								coverage: required<PoolFeature>(situations, { cases: 20, sense: notesOnly }),
								kept: poolKept,
								runs: 20,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								caseHang: Duration.minutes(2)
							},
							({ max, steps }, c) =>
								Effect.gen(function* () {
									const pool = yield* poolFor(reader, {
										...defaultPool,
										pool: { idleTimeoutMs: 60_000, min: 1, max }
									})
									const scope = yield* Effect.scope
									const held: Array<Held> = []
									const idle = new Set<Session>()
									const retired = new Set<Session>()
									const retiredPids = new Set<number>()
									const lease = Effect.gen(function* () {
										const leaseScope = yield* Scope.fork(scope)
										const before = yield* pool.size
										const session = yield* Scope.provide(pool.lease, leaseScope)
										lacks([...retired], session, "a retired session is never handed out again")
										assert.equal(session.retired(), false)
										assert.equal(session.lost(), false)
										const pid = yield* backendPidOf(session)
										lacks([...retiredPids], pid, "a retired backend is never reused")
										if (retired.size > 0) {
											c.note("leased after a retirement")
										}
										if (idle.has(session)) {
											idle.delete(session)
											c.note("leased an idle session")
										} else {
											assert.equal(
												yield* pool.size,
												before + 1,
												"a session not idle before is a new one"
											)
											c.note("leased a new session")
										}
										held.push({ session, pid, scope: leaseScope })
									})
									/** Releases the held session `h`; a retired or lost one is closed, any other kept idle. */
									const release = (h: Held, ends: boolean) =>
										Effect.gen(function* () {
											const before = yield* pool.size
											held.splice(held.indexOf(h), 1)
											yield* Scope.close(h.scope, Exit.void)
											if (ends) {
												retired.add(h.session)
												retiredPids.add(h.pid)
												assert.equal(
													yield* pool.size,
													before - 1,
													"a retired session's release closes it"
												)
											} else {
												idle.add(h.session)
												assert.equal(yield* pool.size, before, "a release keeps the session")
											}
										})
									for (const step of steps) {
										const [first, ...rest] = held
										if (first === undefined || (step.kind === "lease" && held.length < max)) {
											yield* lease
											continue
										}
										const h = pickFrom([first, ...rest], step.pick)
										switch (step.kind) {
											case "lease":
											case "release":
												yield* release(h, false)
												c.note("released")
												break
											case "retire":
												h.session.retire()
												yield* release(h, true)
												c.note("retired")
												break
											case "lose":
												h.session.destroy()
												yield* until(Effect.sync(() => h.session.lost()))
												yield* release(h, true)
												c.note("connection lost")
												break
										}
										assert.equal(yield* pool.leased, held.length)
										assert.ok((yield* pool.size) <= max)
									}
									for (const h of Arr.copy(held)) {
										yield* release(h, false)
									}
									assert.equal(yield* pool.leased, 0)
									for (const pid of retiredPids) {
										yield* until(Effect.map(backendState(pid), (b) => b.state === "gone"))
									}
								})
						)
					})
				)
		)
	})
}
