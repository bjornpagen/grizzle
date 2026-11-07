/**
 * The work queue's races: two workers' claims and settlements, each one SERIALIZABLE ChangeSet, racing while a third
 * session holds a row they contend for.
 *
 * The queue is relations and laws only. A claim is one ChangeSet whose members read the claimable work and the free
 * seats and write the item's Work, Wanted and Leased facts; a settlement is one whose members are all described from
 * the lease (key, epoch) it settles. Each lease occupies one Seat fact, under a candidate key on (resource, seat), and
 * the alternatives law gives each item one standing. Under contention the laws, not locks the language exposes, keep
 * the queue sound: two claimers of one item or of one seat cannot both take it, and a late settlement of an expired
 * lease and a reclaim of its item cannot both land.
 *
 * Property: every run of a race, in every order of its moves, is explained by its serial reference
 * (test/support/schedules/serial.ts): the two workers' writes (each retried after each TransientFailure until it
 * answers), each run alone from the queue's golden state in an order that respects real time, answer what they
 * answered in the run, and leave its Work, Wanted, Leased and Done facts. A race draws the blocker, the enqueuer
 * holding one item's Work row FOR UPDATE or a worker holding gpu's free seat 3 with an uncommitted lease, each ended by
 * its ROLLBACK, so both writes are in flight together, blocked, and released at once; each worker's write, a claim
 * from a drawn digest and seat or the settlement of kB's expired lease; and the claims' time and lease length.
 *
 * The queue is the shared fixture with its facts (gpu seats 1-3, seat 1 held by kB's lease that expired at 50, seat 2
 * by kF's live lease, seat 3 free; kA and kG wanted and due). The kept races are the windows the races were first
 * planted for: two claimers of kG, two claimers of seat 3, and a late settlement of kB racing its reclaim.
 */

import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { constant, element, type Gen, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, type Scope, String as Str } from "effect"
import type { OpenError } from "#adapter/errors/execution.ts"
import type { ApplyOutcome } from "#adapter/public/db.ts"
import type { CompileError, TransientTag } from "#compiler/core/errors.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { type QueueInstalled, queueQueries } from "#test/pg/e2e-laws/queue-queries.ts"
import { openFixture } from "#test/pg/e2e-laws/support.ts"
import { Instant } from "#test/support/fixtures/api/contracts.ts"
import * as Q from "#test/support/fixtures/api/queue.ts"
import { kA, kB, kG, queueFacts } from "#test/support/fixtures/golden/queue.ts"
import { replaceMigrated } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import type { SqlError } from "#test/support/pg.ts"
import { grizzleActor, openActors, textOfValue } from "#test/support/schedules/actors.ts"
import { every, everyRelation, exploreEnv } from "#test/support/schedules/interleave.ts"
import {
	type Explained,
	type RaceTxn,
	runSerialRace,
	type SerialRaceFailed
} from "#test/support/schedules/serial.ts"
import type { PsqlProcessError, TransactionRolledBack } from "#test/support/substrate/errors.ts"
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
 * kC's (300), and before kF's live lease expires (500), so every claim meets the fixture's state as the race plants it.
 */
interface Time {
	readonly now: bigint
	readonly lease: bigint
}

const timeGen: Gen<Time> = (source) => ({
	now: source.draw(bigint(121n, 299n)),
	lease: source.draw(bigint(1n, 10_000n))
})

/** A worker's write: a claim from a digest and a seat, or the settlement of kB's expired epoch-1 lease. */
type QueueWrite =
	| { readonly kind: "claim"; readonly from: "1" | "3" | "5"; readonly fromSeat: 1 | 3 }
	| { readonly kind: "settle" }

/**
 * The session holding what the writes contend for, until its ROLLBACK: the enqueuer `e` holding an item's Work row FOR
 * UPDATE, or the worker `w` holding gpu's free seat 3 with an uncommitted lease.
 */
type Blocker =
	| { readonly kind: "locks"; readonly item: "kA" | "kB" | "kG" }
	| { readonly kind: "seat 3" }

/** A race: the claims' time, the blocker, and each worker's write. */
interface QueueRace {
	readonly time: Time
	readonly blocker: Blocker
	readonly g: QueueWrite
	readonly h: QueueWrite
}

const claimGen: Gen<QueueWrite> = (source) => ({
	kind: "claim",
	from: source.draw(element(["1", "3", "5"] as const)),
	fromSeat: source.draw(element([1, 3] as const))
})

/** A worker's write: a claim twice as often as the settlement. */
const writeGen: Gen<QueueWrite> = weighted<QueueWrite>([
	[2, claimGen],
	[1, constant({ kind: "settle" })]
])

const lockGen: Gen<Blocker> = (source) => ({
	kind: "locks",
	item: source.draw(element(["kA", "kB", "kG"] as const))
})

const raceGen: Gen<QueueRace> = (source) => ({
	time: source.draw(timeGen),
	blocker: source.draw(
		weighted<Blocker>([
			[1, lockGen],
			[1, constant({ kind: "seat 3" })]
		])
	),
	g: source.draw(writeGen),
	h: source.draw(writeGen)
})

const items: Readonly<Record<"kA" | "kB" | "kG", string>> = { kA, kB, kG }

/** What a race reached: a write waited, the two in flight together, a refusal and each reason, each write's answer. */
type QueueFeature =
	| "a write waited"
	| "two writes in flight together"
	| "a write refused"
	| `refused: ${TransientTag}`
	| `${QueueWrite["kind"]} ${ApplyOutcome<unknown>["kind"]}`

/** The features one explained run reached (see QueueFeature). */
const featuresOf =
	(race: QueueRace) =>
	(e: Explained<ApplyOutcome<unknown>>): ReadonlyArray<QueueFeature> => {
		const waited = Arr.some(
			e.run.moves,
			(m) => (m.session === "g" || m.session === "h") && m.observed._tag === "Waited"
		)
		const [g, h] = [e.run.spans["g"], e.run.spans["h"]]
		const together = g !== undefined && h !== undefined && g.start < h.end && h.start < g.end
		return [
			...(waited ? ["a write waited" as const] : []),
			...(together ? ["two writes in flight together" as const] : []),
			...Arr.flatMap(["g", "h"] as const, (session): ReadonlyArray<QueueFeature> => {
				const end = e.ends.get(session)
				if (end?.kind !== "answered") {
					return []
				}
				return [
					`${race[session].kind} ${end.retried.answered.kind}`,
					...(end.retried.refused.length > 0 ? ["a write refused" as const] : []),
					...Arr.map(end.retried.refused, (reason): QueueFeature => `refused: ${reason}`)
				]
			})
		]
	}

/**
 * Opens the queue at its golden state, two worker Dbs (each pool keeps one session of the login, whose backend the
 * driver watches) and the two blockers, and runs the race.
 */
const runRace = (
	race: QueueRace,
	c: Case<QueueFeature>
): Effect.Effect<
	void,
	CompileError | SqlError | TransactionRolledBack | OpenError | PsqlProcessError | SerialRaceFailed,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
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
		const worker = (name: string, beside: ReadonlyArray<number>) =>
			Effect.provideService(grizzleActor(name, login, beside), Substrate, s)
		const work = names.table(Q.QueueWork)
		const leased = names.table(Q.Leased)
		const workColumn = (field: "key" | "standing" | "epoch") => names.column(Q.QueueWork, field)
		const leasedColumn = (field: "key" | "resource" | "seat" | "epoch" | "expires") =>
			names.column(Q.Leased, field)
		const gpu = names.code(Q.Resource, "gpu")
		const blocker: RaceTxn<ApplyOutcome<unknown>> =
			race.blocker.kind === "locks"
				? {
						kind: "direct",
						session: "e",
						statements: [
							{
								sql: `SELECT 1 FROM ${work} WHERE ${workColumn("key")} = '${items[race.blocker.item]}' FOR UPDATE`,
								footprint: everyRelation
							}
						],
						end: "rollback"
					}
				: {
						kind: "direct",
						session: "w",
						statements: [
							{
								sql: `INSERT INTO ${leased} (${leasedColumn("key")}, ${leasedColumn("resource")}, ${leasedColumn("seat")}, ${leasedColumn("epoch")}, ${leasedColumn("expires")}) VALUES ('${digest("6")}', ${gpu}, 3, 1, 999)`,
								footprint: everyRelation
							}
						],
						end: "rollback"
					}
		const state = Arr.join(
			[
				`SELECT 'Work'::text, ${workColumn("key")}::text, ${workColumn("standing")}::text, ${workColumn("epoch")}::text, NULL::text, NULL::text FROM ${work}`,
				`SELECT 'Wanted'::text, ${names.column(Q.Wanted, "key")}::text, ${names.column(Q.Wanted, "due")}::text, ${names.column(Q.Wanted, "attempts")}::text, NULL::text, NULL::text FROM ${names.table(Q.Wanted)}`,
				`SELECT 'Leased'::text, ${leasedColumn("key")}::text, ${leasedColumn("resource")}::text, ${leasedColumn("seat")}::text, ${leasedColumn("epoch")}::text, ${leasedColumn("expires")}::text FROM ${leased}`,
				`SELECT 'Done'::text, ${names.column(Q.Done, "key")}::text, ${names.column(Q.Done, "outcome")}::text, NULL::text, NULL::text, NULL::text FROM ${names.table(Q.Done)}`
			],
			" UNION ALL "
		)
		yield* f.withDb(worlds.server.roles.worker, (one) =>
			Effect.gen(function* () {
				const g = yield* worker("g", [])
				yield* f.withDb(worlds.server.roles.worker, (two) =>
					Effect.gen(function* () {
						const h = yield* worker("h", [g.pid])
						const direct = yield* openActors(s, {
							e: { kind: "psql", as: f.installed.world(worlds.enqueuer) },
							w: { kind: "psql", as: f.installed.world(worlds.worker) }
						})
						const writeOf = (
							session: "g" | "h",
							db: typeof one
						): RaceTxn<ApplyOutcome<unknown>> => {
							const write = race[session]
							return {
								kind: "grizzle",
								session,
								label:
									write.kind === "claim"
										? `claim from ${write.from} at seat ${write.fromSeat}`
										: "settle kB epoch 1",
								call:
									write.kind === "claim"
										? db.apply(claimOf(queue), {
												kind: "render" as const,
												slot: Q.Slot(0),
												resource: "gpu" as const,
												from: digest(write.from),
												fromSeat: Q.SeatNo(write.fromSeat),
												now: Instant(race.time.now),
												expires: Instant(race.time.now + race.time.lease)
											})
										: db.apply(settleOf(queue), {
												key: Q.Digest(kB),
												epoch: 1n,
												outcome: "succeeded"
											}),
								footprint: everyRelation
							}
						}
						yield* runSerialRace(
							env,
							{ direct, grizzle: { g, h } },
							{
								name: "two workers' writes racing a held row",
								txns: [writeOf("g", one), writeOf("h", two), blocker],
								reset: Effect.provideService(
									replaceMigrated(f.installed, queueFacts),
									Substrate,
									s
								),
								state: Effect.map(env.observer.queryValues(state, []), (rows) =>
									Arr.map(rows, (row) => Arr.map(row, textOfValue))
								)
							},
							every,
							(e) => c.noteAll(featuresOf(race)(e))
						)
					})
				)
			})
		)
	})

/** The cases of the rotating stream; its floor runs a quarter of them. */
const runs = 8

const time: Time = { now: 200n, lease: 100n }

layer(Substrate.layer, { excludeTestServices: true })("the work queue's races", (it) => {
	it.effect("every race of two workers' claims and settlements is serializable", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "schedules/queue/queue",
					draw: drawn(raceGen),
					literal: Formatter.format,
					coverage: required<QueueFeature>(["a write waited", "a write refused"], {
						cases: runs,
						sense: notesOnly
					}),
					kept: [
						{
							note: "two claimers of one item: from 55...5 both pick kG, wanted and due, with gpu's free seat 3, while the enqueuer holds kG's row; one leases it and the other's retry leases nothing twice",
							sketch: {
								time,
								blocker: { kind: "locks", item: "kG" },
								g: { kind: "claim", from: "5", fromSeat: 1 },
								h: { kind: "claim", from: "5", fromSeat: 1 }
							},
							draws: "",
							reaches: ["two writes in flight together", "a write refused", "claim accepted"]
						},
						{
							note: "two claimers of one seat: g picks kG and h picks kA, both with gpu's one free seat 3, which a worker holds; one takes it and the other's retry finds no free seat, so its item stays wanted",
							sketch: {
								time,
								blocker: { kind: "seat 3" },
								g: { kind: "claim", from: "5", fromSeat: 3 },
								h: { kind: "claim", from: "1", fromSeat: 3 }
							},
							draws: "",
							reaches: ["two writes in flight together", "a write refused", "claim no-change"]
						},
						{
							note: "a late settlement racing a reclaim: the worker of kB's expired epoch-1 lease settles it while a claimer from 33...3 reclaims kB, and the enqueuer holds kB's row; exactly one of them lands",
							sketch: {
								time,
								blocker: { kind: "locks", item: "kB" },
								g: { kind: "settle" },
								h: { kind: "claim", from: "3", fromSeat: 3 }
							},
							draws: "",
							reaches: ["two writes in flight together", "a write refused"]
						}
					],
					runs,
					shrink: { kind: "bounded", candidates: 40 },
					concurrency: 1,
					steerEvery: runs,
					caseHang
				},
				(race, c) => Effect.scoped(runRace(race, c))
			)
		)
	)
})
