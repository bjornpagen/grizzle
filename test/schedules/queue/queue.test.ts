/**
 * The work queue's races: two claimers of one item, two claimers of one seat, and a late settlement racing a reclaim.
 *
 * The queue is relations and laws only. A claim is one SERIALIZABLE ChangeSet whose members read the claimable work
 * and the free seats and write the item's Work, Wanted and Leased facts; a settlement is one whose members are all
 * described from the lease (key, epoch) it settles. Each lease occupies one Seat fact, under a candidate key on
 * (resource, seat), and the alternatives law gives each item one standing. Under contention the laws, not locks the
 * language exposes, keep the queue sound:
 *
 * - two claimers that pick one item cannot both lease it: one commits and the other fails with 40001, a
 *   TransientFailure, and its caller's retry runs against the new state;
 * - two claimers that pick one free seat for different items cannot both take it: one commits, the other retries and
 *   finds no free seat, so its wanted item stays wanted;
 * - a late worker's settlement of an expired lease and a reclaim of the same item cannot both happen: either the
 *   settlement lands and the reclaim takes other work, or the reclaim lands with a higher epoch and the settlement,
 *   finding its (key, epoch) lease gone, is no-change.
 *
 * Each schedule holds the contested row with an open transaction of the role `enqueuer`, so both grizzle writers are in
 * flight together, blocked, and releases them at once by rolling back. Two Dbs of the role `worker` run the writers;
 * each pool keeps one session of the login, whose backend the schedule watches. The queue is the shared fixture with
 * its facts (gpu seats 1-3, seat 1 held by kB's lease that expired at 50, seat 2 by kF's live lease, seat 3 free; kA
 * and kG wanted and due). The claims' time and lease length are drawn.
 */

import { layer } from "@effect/vitest"
import { type Gen } from "@grizzle/testing/gen"
import { bigint } from "@grizzle/testing/values"
import { type Brand, Effect, String as Str } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { type QueueInstalled, queueQueries } from "#test/pg/e2e-laws/queue-queries.ts"
import { openFixture } from "#test/pg/e2e-laws/support.ts"
import { Instant } from "#test/support/fixtures/api/contracts.ts"
import * as Q from "#test/support/fixtures/api/queue.ts"
import { kA, kB, kG, queueFacts } from "#test/support/fixtures/golden/queue.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { grizzleActor, openActors } from "#test/support/schedules/actors.ts"
import {
	awaits,
	begin,
	blocksAny,
	blocksOn,
	check,
	complete,
	mayWait,
	rollback,
	schedule,
	sql
} from "#test/support/schedules/build.ts"
import {
	anyRetried,
	applied,
	exactly,
	refusals,
	retriedOp,
	within
} from "#test/support/schedules/grizzle.ts"
import { exploreEnv } from "#test/support/schedules/interleave.ts"
import { anyOf, ok, rows } from "#test/support/schedules/match.ts"
import { planted } from "#test/support/schedules/planted.ts"
import { runSchedule } from "#test/support/schedules/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const claimOf = (s: QueueInstalled) => {
	const m = queueQueries(s)
	return ChangeSet.empty(s)
		.put(Q.QueueWork, m.claimWorkPut)
		.delete(Q.Wanted, m.claimWantedDelete)
		.put(Q.Leased, m.claimLeasedPut)
}

const settleOf = (s: QueueInstalled) => {
	const m = queueQueries(s)
	return ChangeSet.empty(s)
		.delete(Q.Leased, m.settleLeasedDelete)
		.insert(Q.Done, m.settleDoneInsert)
		.put(Q.QueueWork, m.settleWorkPut)
}

const digest = (hex: string) => Q.Digest(Str.repeat(64)(hex))
/**
 * When the claims run, and how long a lease lasts: after kG's due time (120), the last of the wanted items due before
 * kC's (300), and before kF's live lease expires (500), so every claim meets the fixture's state the schedule plants.
 */
interface Time {
	readonly now: bigint
	readonly lease: bigint
}

const timeGen: Gen<Time> = (source) => ({
	now: source.draw(bigint(121n, 299n)),
	lease: source.draw(bigint(1n, 10_000n))
})

const claimParams = (from: string & Brand.Brand<"Digest">, fromSeat: number, time: Time) => ({
	kind: "render" as const,
	slot: Q.Slot(0),
	resource: "gpu" as const,
	from,
	fromSeat: Q.SeatNo(fromSeat),
	now: Instant(time.now),
	expires: Instant(time.now + time.lease)
})

/** A claim of a wanted item in a free seat: its Work fact put leased, its Wanted fact deleted, its lease put. */
const freshClaim = {
	[Q.QueueWork.name]: { added: 0n, deleted: 0n, put: 1n },
	[Q.Wanted.name]: { added: 0n, deleted: 1n, put: 0n },
	[Q.Leased.name]: { added: 0n, deleted: 0n, put: 1n }
}

layer(Substrate.layer, { excludeTestServices: true })("the work queue's races", (it) => {
	const setup = Effect.gen(function* () {
		const s = yield* Substrate
		const f = yield* openFixture(Q.Queue, [Q.queueWorlds(Q.Queue).server], {
			facts: queueFacts,
			after: []
		})
		const queue = f.rebuilt(Q.Queue)
		const worlds = Q.queueWorlds(queue)
		const env = yield* exploreEnv(s)
		const login = f.installed.as(worlds.server).role
		const names = namesOf(f.installed)
		/** A worker Db's grizzle actor: the one client backend of the login beside the other worker Db's. */
		const worker = (name: string, beside: ReadonlyArray<number>) =>
			Effect.provideService(grizzleActor(name, login, beside), Substrate, s)
		const work = names.table(Q.QueueWork)
		const leased = names.table(Q.Leased)
		/** The blockers, opened once both worker Dbs hold their sessions: `e` as the enqueuer, `w` as a worker. */
		const blockers = openActors(s, {
			e: { kind: "psql", as: f.installed.world(worlds.enqueuer) },
			w: { kind: "psql", as: f.installed.world(worlds.worker) }
		})
		return { f, queue, worlds, env, names, worker, blockers, work, leased }
	})

	it.effect(
		"two claimers of one item: one leases it, the other's retry leases nothing twice",
		planted("queue/two claimers of one item", timeGen, ["two claimers of kG"], (time) =>
			Effect.gen(function* () {
				const x = yield* setup
				const workColumn = (field: "key" | "standing" | "epoch") =>
					x.names.column(Q.QueueWork, field)
				const leasedColumn = (field: "key" | "seat" | "epoch") => x.names.column(Q.Leased, field)
				const trace = yield* x.f.withDb(x.worlds.server.roles.worker, (one) =>
					Effect.gen(function* () {
						const g = yield* x.worker("g", [])
						return yield* x.f.withDb(x.worlds.server.roles.worker, (two) =>
							Effect.gen(function* () {
								const h = yield* x.worker("h", [g.pid])
								const actors = { direct: yield* x.blockers, grizzle: { g, h } }
								/** From 55...5 both pick kG, wanted and due, with gpu's free seat 3. */
								const claim = (db: typeof one) =>
									db.apply(claimOf(x.queue), claimParams(digest("5"), 1, time))
								const item = anyRetried(
									applied({ kind: "accepted", calls: exactly(), counts: freshClaim }),
									applied({ kind: "no-change", calls: refusals(1) })
								)
								return yield* runSchedule(
									x.env,
									schedule("two claimers of kG", [
										begin("e"),
										sql(
											"e",
											`SELECT 1 FROM ${x.work} WHERE ${workColumn("key")} = '${kG}' FOR UPDATE`,
											ok(),
											complete
										),
										retriedOp("g", "claim", claim(one), item, blocksOn("e")),
										retriedOp("h", "claim", claim(two), item, blocksAny),
										rollback("e"),
										awaits("g", mayWait),
										awaits("h", mayWait),
										check(
											`SELECT pg_catalog.string_agg(l.${leasedColumn("key")} || ':' || l.${leasedColumn("seat")}::text || ':' || l.${leasedColumn("epoch")}::text || ':' || w.${workColumn("standing")}::text || ':' || w.${workColumn("epoch")}::text, ',' ORDER BY l.${leasedColumn("key")}) FROM ${x.leased} AS l JOIN ${x.work} AS w ON w.${workColumn("key")} = l.${leasedColumn("key")} WHERE l.${leasedColumn("key")} IN ('${kG}', '${kB}')`,
											rows([`${kB}:1:1:leased:1,${kG}:3:1:leased:1`])
										)
									]),
									actors
								)
							})
						)
					})
				)
				return [trace]
			})
		)
	)

	it.effect(
		"two claimers of one seat: one takes it, the other retries and its item stays wanted",
		planted("queue/two claimers of one seat", timeGen, ["two claimers of gpu seat 3"], (time) =>
			Effect.gen(function* () {
				const x = yield* setup
				const workColumn = (field: "key" | "standing" | "epoch") =>
					x.names.column(Q.QueueWork, field)
				const leasedColumn = (field: "key" | "resource" | "seat" | "epoch" | "expires") =>
					x.names.column(Q.Leased, field)
				const trace = yield* x.f.withDb(x.worlds.server.roles.worker, (one) =>
					Effect.gen(function* () {
						const g = yield* x.worker("g", [])
						return yield* x.f.withDb(x.worlds.server.roles.worker, (two) =>
							Effect.gen(function* () {
								const h = yield* x.worker("h", [g.pid])
								const actors = { direct: yield* x.blockers, grizzle: { g, h } }
								/** g picks kG and h picks kA, both with gpu's one free seat 3. */
								const claimKG = one.apply(claimOf(x.queue), claimParams(digest("5"), 3, time))
								const claimKA = two.apply(claimOf(x.queue), claimParams(digest("1"), 3, time))
								/**
								 * The loser meets the winner's lease at seat 3's candidate key, as a serialization
								 * failure or as an occupant its snapshot did not see, once or twice, and its retry
								 * finds no free seat.
								 */
								const settled = anyRetried(
									applied({ kind: "accepted", calls: exactly(), counts: freshClaim }),
									applied({
										kind: "no-change",
										calls: within(1, 2, ["SerializationFailure", "UnseenOccupant"])
									})
								)
								return yield* runSchedule(
									x.env,
									schedule("two claimers of gpu seat 3", [
										begin("w"),
										sql(
											"w",
											`INSERT INTO ${x.leased} (${leasedColumn("key")}, ${leasedColumn("resource")}, ${leasedColumn("seat")}, ${leasedColumn("epoch")}, ${leasedColumn("expires")}) VALUES ('${digest("6")}', 'gpu', 3, 1, 999)`,
											ok(),
											complete
										),
										retriedOp("g", "claim kG", claimKG, settled, blocksOn("w")),
										retriedOp("h", "claim kA", claimKA, settled, blocksAny),
										rollback("w"),
										awaits("g", mayWait),
										awaits("h", mayWait),
										check(
											`SELECT pg_catalog.string_agg(w.${workColumn("key")} || ':' || w.${workColumn("standing")}::text || ':' || w.${workColumn("epoch")}::text || ':' || (SELECT pg_catalog.count(*) FROM ${x.names.table(Q.Wanted)} AS d WHERE d.${x.names.column(Q.Wanted, "key")} = w.${workColumn("key")})::text, ',' ORDER BY w.${workColumn("key")}) FROM ${x.work} AS w WHERE w.${workColumn("key")} IN ('${kA}', '${kG}')`,
											anyOf(
												rows([`${kA}:leased:1:0,${kG}:wanted:0:1`]),
												rows([`${kA}:wanted:0:1,${kG}:leased:1:0`])
											)
										),
										check(
											`SELECT pg_catalog.count(*)::text FROM ${x.leased} WHERE ${leasedColumn("resource")} = 'gpu' AND ${leasedColumn("seat")} = 3`,
											rows(["1"])
										)
									]),
									actors
								)
							})
						)
					})
				)
				return [trace]
			})
		)
	)

	it.effect(
		"a late settlement racing a reclaim: exactly one of them lands",
		planted(
			"queue/a settlement and a reclaim",
			timeGen,
			["a settlement and a reclaim of kB"],
			(time) =>
				Effect.gen(function* () {
					const x = yield* setup
					const workColumn = (field: "key" | "standing" | "epoch") =>
						x.names.column(Q.QueueWork, field)
					const leasedColumn = (field: "key" | "seat" | "epoch") => x.names.column(Q.Leased, field)
					const trace = yield* x.f.withDb(x.worlds.server.roles.worker, (one) =>
						Effect.gen(function* () {
							const g = yield* x.worker("g", [])
							return yield* x.f.withDb(x.worlds.server.roles.worker, (two) =>
								Effect.gen(function* () {
									const h = yield* x.worker("h", [g.pid])
									const actors = { direct: yield* x.blockers, grizzle: { g, h } }
									/**
									 * The worker of kB's expired epoch-1 lease settles it; a claimer from 33...3 reclaims
									 * it in its own seat 1 with epoch 2.
									 */
									const settle = one.apply(settleOf(x.queue), {
										key: Q.Digest(kB),
										epoch: 1n,
										outcome: "succeeded"
									})
									const reclaim = two.apply(claimOf(x.queue), claimParams(digest("3"), 3, time))
									return yield* runSchedule(
										x.env,
										schedule("a settlement and a reclaim of kB", [
											begin("e"),
											sql(
												"e",
												`SELECT 1 FROM ${x.work} WHERE ${workColumn("key")} = '${kB}' FOR UPDATE`,
												ok(),
												complete
											),
											retriedOp(
												"g",
												"settle kB epoch 1",
												settle,
												anyRetried(
													applied({
														kind: "accepted",
														calls: exactly(),
														counts: {
															[Q.Leased.name]: { added: 0n, deleted: 1n, put: 0n },
															[Q.Done.name]: { added: 1n, deleted: 0n, put: 0n },
															[Q.QueueWork.name]: { added: 0n, deleted: 0n, put: 1n }
														}
													}),
													applied({ kind: "no-change", calls: refusals(1) })
												),
												blocksOn("e")
											),
											retriedOp(
												"h",
												"reclaim",
												reclaim,
												anyRetried(
													applied({
														kind: "accepted",
														calls: exactly(),
														counts: {
															[Q.QueueWork.name]: { added: 0n, deleted: 0n, put: 1n },
															[Q.Wanted.name]: { added: 0n, deleted: 0n, put: 0n },
															[Q.Leased.name]: { added: 0n, deleted: 0n, put: 1n }
														}
													}),
													applied({ kind: "accepted", calls: refusals(1), counts: freshClaim })
												),
												blocksAny
											),
											rollback("e"),
											awaits("g", mayWait),
											awaits("h", mayWait),
											check(
												`SELECT pg_catalog.string_agg(w.${workColumn("key")} || ':' || w.${workColumn("standing")}::text || ':' || w.${workColumn("epoch")}::text || ':' || coalesce((SELECT l.${leasedColumn("seat")}::text || '@' || l.${leasedColumn("epoch")}::text FROM ${x.leased} AS l WHERE l.${leasedColumn("key")} = w.${workColumn("key")}), '-'), ',' ORDER BY w.${workColumn("key")}) FROM ${x.work} AS w WHERE w.${workColumn("key")} IN ('${kB}', '${kG}')`,
												anyOf(
													rows([`${kB}:done:1:-,${kG}:leased:1:3@1`]),
													rows([`${kB}:leased:2:1@2,${kG}:wanted:0:-`])
												)
											)
										]),
										actors
									)
								})
							)
						})
					)
					return [trace]
				})
		)
	)
})
