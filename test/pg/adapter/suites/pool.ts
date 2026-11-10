import { layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Exit, Fiber, Formatter, Scope } from "effect"
import { type BatchStatement, runTransaction } from "#adapter/wire/batch.ts"
import type { Session } from "#adapter/wire/session.ts"
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
import { assert, lacks } from "#test/support/assert.ts"
import { caseHang, testIdleTimeout } from "#test/support/limits.ts"
import { runAlone } from "#test/support/pg.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { testSql } from "#test/support/sql.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { makeTap } from "#test/support/wire-tap.ts"
import { paramText } from "#test/support/wire.ts"

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

/** What an interrupted statement waits on: the server's clock, or an advisory lock another session holds. */
type LongStatement = "sleep" | "lock"

/** How the statement runs: alone, its own implicit transaction, or inside a transaction that ends with COMMIT. */
type FlightForm = "alone" | "transaction"

interface Interrupted {
	readonly max: number
	readonly statement: LongStatement
	readonly form: FlightForm
}

const interruptedCases: Gen<Interrupted> = (source) => ({
	max: source.draw(int(1, 3)),
	statement: source.draw(element<LongStatement>(["sleep", "lock"])),
	form: source.draw(element<FlightForm>(["alone", "transaction"]))
})

type InterruptedFeature = `${LongStatement} ${FlightForm}`

/**
 * The advisory lock key the lock cases hold, in a session of their own that the case's scope ends, which no other
 * test takes.
 */
const lockKey = "7366231908012114001"

/** The long statement of a case, which runs until a CancelRequest stops it. */
const longStatement = (statement: LongStatement): BatchStatement =>
	statement === "sleep"
		? { sql: testSql("SELECT pg_catalog.pg_sleep(600)::text"), params: [] }
		: {
				sql: testSql("SELECT pg_catalog.pg_advisory_lock($1::int8)::text"),
				params: [paramText(lockKey)]
			}

/** Runs `statement` on `session` in the form drawn: alone, or in a read-only transaction that ends with COMMIT. */
const runIn = (session: Session, form: FlightForm, statement: BatchStatement) =>
	form === "alone"
		? Effect.asVoid(runAlone(session, statement))
		: Effect.asVoid(
				runTransaction(session, [statement], {
					access: "readOnly",
					isolation: "serializable",
					end: "COMMIT"
				})
			)

/**
 * An interrupted statement stops on the server, and its session is gone for good, exhaustively over the pool's
 * maximum (1 to 3), the statement (a sleep, or a wait for an advisory lock another session holds) and its flight
 * (alone, or in a transaction ending with COMMIT): once the server runs the statement, interrupting the call
 * sends one CancelRequest and destroys the session, so its backend leaves pg_stat_activity, and the pool's next
 * leases, its maximum at once, are other sessions on other backends.
 */
const interruptedStatement = Effect.gen(function* () {
	const s = yield* Substrate
	const schema = yield* s.schema(freshSchema)
	const login = yield* substrateLogin(schema, "server", roleDefaults)
	return yield* exhaust(
		{
			box: { kind: "unstated" },
			oracle: { kind: "unstated" },
			suite: "pg/adapter/pool/interrupted",
			generator: interruptedCases,
			literal: Formatter.format,
			limit: 12,
			coverage: requiredInSpace<InterruptedFeature>([
				"sleep alone",
				"sleep transaction",
				"lock alone",
				"lock transaction"
			]),
			caseHang
		},
		(k, c) =>
			Effect.gen(function* () {
				const pool = yield* poolFor(login, {
					...defaultPool,
					pool: { idleTimeoutMs: testIdleTimeout.value, min: 1, max: k.max }
				})
				if (k.statement === "lock") {
					const holder = yield* s.session({ ...ownerSession(), label: "lock holder" })
					yield* holder.query("SELECT pg_catalog.pg_advisory_lock($1::int8)", [lockKey])
				}
				const scope = yield* Effect.scope
				const leaseScope = yield* Scope.fork(scope)
				const session = yield* Scope.provide(pool.lease, leaseScope)
				const pid = yield* backendPidOf(session)
				const call = yield* Effect.forkChild(runIn(session, k.form, longStatement(k.statement)))
				yield* until(
					Effect.map(backendState(pid), (b) =>
						k.statement === "sleep"
							? b.state === "active" && b.waitEvent === "PgSleep"
							: b.state === "active" && b.waitEvent === "advisory"
					)
				)
				const exit = yield* Effect.andThen(Fiber.interrupt(call), Fiber.await(call))
				assert.ok(Exit.hasInterrupts(exit), "the call ends as its interruption")
				assert.equal(session.state(), "ended", "the interrupted session is destroyed")
				yield* until(Effect.map(backendState(pid), (b) => b.state === "gone"))
				yield* Scope.close(leaseScope, Exit.void)
				const leased = yield* pool.leased
				assert.equal(leased, 0)
				const again = yield* Effect.scoped(
					Effect.all(
						Array.from({ length: k.max }, () =>
							Effect.flatMap(pool.lease, (next) =>
								Effect.map(backendPidOf(next), (nextPid) => ({ next, nextPid }))
							)
						),
						{ concurrency: k.max }
					)
				)
				lacks(
					Arr.map(again, (a) => a.next),
					session,
					"the interrupted session is never handed out again"
				)
				lacks(
					Arr.map(again, (a) => a.nextPid),
					pid,
					"its backend is never reused"
				)
				c.note(`${k.statement} ${k.form}`)
			})
	)
}).pipe(Effect.scoped)

/**
 * Where the tap's session stands when its layer is released: idle in the pool, leased, or running a statement of `rows`
 * rows whose answer the gate cuts after `through` backend messages.
 */
type Standing =
	| { readonly kind: "idle" }
	| { readonly kind: "leased" }
	| { readonly kind: "running"; readonly rows: number; readonly through: number }

/** Every standing, a statement's answer cut at each of its first messages: a few rows, and a cut short of their end. */
const standings: Gen<Standing> = (source) => {
	const kind = source.draw(element<Standing["kind"]>(["idle", "leased", "running"]))
	if (kind !== "running") {
		return { kind }
	}
	const rows = source.draw(int(0, 3))
	return { kind, rows, through: source.draw(int(0, rows + 4)) }
}

type StalledFeature =
	| "released idle"
	| "released leased"
	| "released before any answer"
	| "released mid-answer"

/** The running statement: `rows` rows, one round trip of the extended protocol. */
const seriesSql = "SELECT pg_catalog.generate_series(1, $1::int4)::text"

/**
 * Releasing a layer never awaits the network, exhaustively over where its one session stands and where the stall cuts
 * the answer of a statement it runs: through the protocol tap, a pool of one opens its session, and then the tap's gate
 * stalls it, letting a drawn number of the server's messages through and holding every later byte, its end included,
 * while the session is idle in the pool, leased, or running a statement. Closing the pool's scope, the layer's,
 * completes all the same: it writes at most a Terminate and destroys the sockets, awaiting nothing. A statement in flight
 * then fails, or, had its whole answer passed the gate first, delivers every row: never a part of its answer. The
 * session's backend leaves pg_stat_activity once its connection is gone.
 */
const stalledRelease = Effect.gen(function* () {
	const s = yield* Substrate
	const schema = yield* s.schema(freshSchema)
	const login = yield* substrateLogin(schema, "server", roleDefaults)
	return yield* exhaust(
		{
			suite: "pg/adapter/pool/stalled release",
			generator: standings,
			literal: Formatter.format,
			limit: 32,
			coverage: requiredInSpace<StalledFeature>([
				"released idle",
				"released leased",
				"released before any answer",
				"released mid-answer"
			]),
			caseHang,
			box: "a session idle, leased, or running a statement of up to three rows cut after each of its answer's first messages",
			oracle: {
				kind: "specification",
				name: "a layer's release awaits nothing, and a statement it cuts fails or delivers its whole answer"
			}
		},
		(standing, c) =>
			Effect.gen(function* () {
				const tap = makeTap(s.cluster)
				const scope = yield* Effect.scope
				const layerScope = yield* Scope.fork(scope)
				const pool = yield* Scope.provide(
					poolFor(login, {
						...defaultPool,
						transport: { kind: "given", transport: tap.transport },
						pool: { idleTimeoutMs: testIdleTimeout.value, min: 1, max: 1 }
					}),
					layerScope
				)
				const leaseScope = yield* Scope.fork(scope)
				const session = yield* Scope.provide(pool.lease, leaseScope)
				const pid = yield* backendPidOf(session)
				switch (standing.kind) {
					case "idle":
					case "leased": {
						if (standing.kind === "idle") {
							yield* Scope.close(leaseScope, Exit.void)
						}
						tap.gate.hold(0, { kind: "any" })
						yield* Scope.close(layerScope, Exit.void)
						c.note(`released ${standing.kind}`)
						break
					}
					case "running": {
						tap.gate.hold(standing.through, { kind: "any" })
						const call = yield* Effect.forkChild(
							rowsOn(session, seriesSql, [String(standing.rows)]),
							{ startImmediately: true }
						)
						yield* Effect.raceFirst(tap.gate.holding, Effect.asVoid(Fiber.await(call)))
						yield* Scope.close(layerScope, Exit.void)
						const exit = yield* Fiber.await(call)
						if (Exit.isSuccess(exit)) {
							assert.deepEqual(
								exit.value,
								Array.from({ length: standing.rows }, (_, k) => [String(k + 1)]),
								"a statement that ends before the release delivers its whole answer"
							)
						} else {
							c.note(standing.through === 0 ? "released before any answer" : "released mid-answer")
						}
						break
					}
				}
				yield* Scope.close(leaseScope, Exit.void)
				yield* until(Effect.map(backendState(pid), (b) => b.state === "gone"))
			})
	)
}).pipe(Effect.scoped)

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
								oracle: { kind: "unstated" },
								suite: `pg/adapter/pool/retired`,
								draw: drawn(sequenceGen),
								literal: Formatter.format,
								coverage: required<PoolFeature>(situations, { cases: 20, sense: notesOnly }),
								kept: [],
								runs: 20,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								caseHang
							},
							({ max, steps }, c) =>
								Effect.gen(function* () {
									const pool = yield* poolFor(reader, {
										...defaultPool,
										pool: { idleTimeoutMs: testIdleTimeout.value, min: 1, max }
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
										assert.equal(session.state(), "open", "a leased session is open")
										const pid = yield* backendPidOf(session)
										lacks([...retiredPids], pid, "a retired backend is never reused")
										if (retired.size > 0) {
											c.note("leased after a retirement")
										}
										if (idle.has(session)) {
											idle.delete(session)
											c.note("leased an idle session")
										} else {
											const size = yield* pool.size
											assert.equal(size, before + 1, "a session not idle before is a new one")
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
												const size = yield* pool.size
												assert.equal(size, before - 1, "a retired session's release closes it")
											} else {
												idle.add(h.session)
												const size = yield* pool.size
												assert.equal(size, before, "a release keeps the session")
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
												assert.equal(
													h.session.state(),
													"ended",
													"a destroyed session is ended at once"
												)
												yield* release(h, true)
												c.note("connection lost")
												break
										}
										const leased = yield* pool.leased
										assert.equal(leased, held.length)
										const size = yield* pool.size
										assert.ok(size <= max)
									}
									for (const h of Arr.copy(held)) {
										yield* release(h, false)
									}
									const leased = yield* pool.leased
									assert.equal(leased, 0)
									for (const pid of retiredPids) {
										yield* until(Effect.map(backendState(pid), (b) => b.state === "gone"))
									}
								})
						)
					})
				)
		)

		it.effect(
			"stops an interrupted statement's backend and never hands its session out again",
			(ctx) => searched(ctx, interruptedStatement)
		)

		it.effect("releases a layer whose transport stalls, awaiting nothing from it", (ctx) =>
			searched(ctx, stalledRelease)
		)
	})
}
