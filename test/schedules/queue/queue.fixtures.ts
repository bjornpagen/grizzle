/** What the properties of queue.test.ts read: its spaces, models and helpers. */

import { type Reached } from "@bjornpagen/testing/features"
import { constant, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { bigint } from "@bjornpagen/testing/values"
import { Array as Arr, Effect, Layer, type Scope, String as Str } from "effect"
import { openServed } from "#adapter/db/served.ts"
import type { OpenError } from "#adapter/errors/execution.ts"
import type { ServedRefusal } from "#adapter/public/compile.ts"
import type { CompileError, TransientTag } from "#compiler/core/errors.ts"
import type { WriteOutcome } from "#compiler/live/index.ts"
import { writeAnswerOf, type WriteAnswer } from "#test/support/calls.ts"
import { toInstant } from "#test/support/fixtures/api/contracts.ts"
import * as Q from "#test/support/fixtures/api/queue.ts"
import { kA, kB, kG, queueFacts } from "#test/support/fixtures/golden/queue.ts"
import { replaceMigrated } from "#test/support/install-migrate.ts"
import { rebuild } from "#test/support/installed.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { openFixture } from "#test/support/open-fixture.ts"
import type { SqlError } from "#test/support/pg.ts"
import {
	grizzleActor,
	openActors,
	standUpActor,
	textOfValue
} from "#test/support/schedules/actors.ts"
import { every, everyRelation, exploreEnv } from "#test/support/schedules/interleave.ts"
import {
	type Explained,
	type RaceTxn,
	runSerialRace,
	type SerialRaceFailed
} from "#test/support/schedules/serial.ts"
import { beginSerializableAction } from "#test/support/schedules/types.ts"
import type { PsqlProcessError, TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const digest = (hex: string) => Q.toDigest(Str.repeat(64)(hex))

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

export const raceGen: Gen<QueueRace> = (source) => ({
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
export type QueueFeature =
	| "a write waited"
	| "two writes in flight together"
	| "a write refused"
	| `refused: ${TransientTag}`
	| `${QueueWrite["kind"]} ${WriteAnswer<WriteOutcome<unknown>>["kind"]}`

/** The features one explained run reached (see QueueFeature). */
const featuresOf =
	(race: QueueRace) =>
	(e: Explained<WriteAnswer<WriteOutcome<unknown>>>): ReadonlyArray<QueueFeature> => {
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
export const runRace = (
	race: QueueRace,
	c: Case<QueueFeature>
): Effect.Effect<
	void,
	| CompileError
	| SqlError
	| TransactionRolledBack
	| OpenError
	| PsqlProcessError
	| SerialRaceFailed
	| ServedRefusal,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const f = yield* openFixture(
			(name) => {
				const named = rebuild(Q.Queue, name)
				return { schema: named, logins: [Q.queueWorlds(named).server] }
			},
			{ facts: queueFacts, after: [] }
		)
		const queue = f.rebuilt(Q.Queue)
		const worlds = Q.queueWorlds(queue)
		const served = yield* f.served(worlds.server)
		/**
		 * A worker's Db, opened through a DbLayer of its own over the served login, and the context it reads: its pool keeps
		 * one session.
		 */
		const workerDb = Effect.flatMap(Layer.build(served.layer), (context) =>
			Effect.provideContext(openServed(served.login.roles.worker, {}), context)
		)
		const withWorker = <A, E, R>(
			body: (opened: Effect.Success<typeof workerDb>) => Effect.Effect<A, E, R>
		) => Effect.scoped(Effect.flatMap(workerDb, body))
		const env = yield* exploreEnv(s)
		const names = namesOf(f.installed)
		/** A worker's actor, named after its Db's first call: the backend its calls hold (grizzleActor). */
		const worker = (name: string, opened: Effect.Success<typeof workerDb>) =>
			Effect.andThen(
				Effect.orDie(writeAnswerOf(opened.db.workload.noop.once({ params: {}, facts: {} }))),
				grizzleActor(name, opened.ctx.pool)
			)
		const work = names.table(Q.QueueWork)
		const leased = names.table(Q.Leased)
		const workColumn = (field: "key" | "standing" | "epoch") => names.column(Q.QueueWork, field)
		const leasedColumn = (field: "key" | "resource" | "seat" | "epoch" | "expires") =>
			names.column(Q.Leased, field)
		const gpu = names.code(Q.Resource, "gpu")
		const blocker: RaceTxn<WriteAnswer<WriteOutcome<unknown>>> =
			race.blocker.kind === "locks"
				? {
						kind: "direct",
						begin: beginSerializableAction,
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
						begin: beginSerializableAction,
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
		yield* withWorker((first) =>
			Effect.gen(function* () {
				const g = yield* worker("g", first)
				yield* withWorker((second) =>
					Effect.gen(function* () {
						const h = yield* worker("h", second)
						const direct = yield* openActors(s, {
							e: { kind: "psql", as: f.installed.world(worlds.enqueuer) },
							w: { kind: "psql", as: f.installed.world(worlds.worker) }
						})
						yield* standUpActor(direct.e, names.standUps)
						yield* standUpActor(direct.w, names.standUps)
						const writeOf = (
							session: "g" | "h",
							db: typeof first.db
						): RaceTxn<WriteAnswer<WriteOutcome<unknown>>> => {
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
										? writeAnswerOf(
												db.workload.claim.once({
													params: {
														kind: "render" as const,
														slot: Q.toSlot(0),
														resource: "gpu" as const,
														from: digest(write.from),
														fromSeat: Q.toSeatNo(write.fromSeat),
														now: toInstant(race.time.now),
														expires: toInstant(race.time.now + race.time.lease)
													},
													facts: {}
												})
											)
										: writeAnswerOf(
												db.workload.settle.once({
													params: {
														key: Q.toDigest(kB),
														epoch: 1n,
														outcome: "succeeded"
													},
													facts: {}
												})
											),
								footprint: everyRelation
							}
						}
						yield* runSerialRace(
							env,
							{ direct, grizzle: { g, h } },
							{
								name: "two workers' writes racing a held row",
								txns: [writeOf("g", first.db), writeOf("h", second.db), blocker],
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
export const runs = 8

const time: Time = { now: 200n, lease: 100n }

/**
 * The cases the search kept by value, which reached their situations on every run: each is the aim of the situations
 * it reaches (aimed), so a case whose turn aims at one draws it. None ever caught a bug (git log -S on the module).
 */
const raceCases: ReadonlyArray<{
	readonly why: string
	readonly value: QueueRace
	readonly reaches: ReadonlyArray<QueueFeature>
}> = [
	{
		why: "two claimers of one item: from 55...5 both pick kG, wanted and due, with gpu's free seat 3, while the enqueuer holds kG's row; one leases it and the other's retry leases nothing twice",
		value: {
			time,
			blocker: { kind: "locks", item: "kG" },
			g: { kind: "claim", from: "5", fromSeat: 1 },
			h: { kind: "claim", from: "5", fromSeat: 1 }
		},
		reaches: ["two writes in flight together", "a write refused", "claim accepted"]
	},
	{
		why: "two claimers of one seat: g picks kG and h picks kA, both with gpu's one free seat 3, which a worker holds; one takes it and the other's retry finds no free seat, so its item stays wanted",
		value: {
			time,
			blocker: { kind: "seat 3" },
			g: { kind: "claim", from: "5", fromSeat: 3 },
			h: { kind: "claim", from: "1", fromSeat: 3 }
		},
		reaches: ["two writes in flight together", "a write refused", "claim unchanged"]
	},
	{
		why: "a late settlement racing a reclaim: the worker of kB's expired epoch-1 lease settles it while a claimer from 33...3 reclaims kB, and the enqueuer holds kB's row; exactly one of them lands",
		value: {
			time,
			blocker: { kind: "locks", item: "kB" },
			g: { kind: "settle" },
			h: { kind: "claim", from: "3", fromSeat: 3 }
		},
		reaches: ["two writes in flight together", "a write refused"]
	}
]

/** The property's aims (race): each kept case's value at every situation it reaches. */
export const raceAims: ReadonlyArray<readonly [Reached<QueueFeature>, Gen<QueueRace>]> =
	Arr.flatMap(raceCases, (c) =>
		Arr.map(c.reaches, (situation) => [situation, constant(c.value)] as const)
	)
