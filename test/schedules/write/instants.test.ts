/**
 * Two writers stamp one clock at its children, and each child's instants increase in the order its calls commit.
 *
 * Log(child, at, note) is keyed (child, at, note): its `at` is an instant no containment carries, so it is a clock
 * whose child is `child`, the key's field before it (ir/instant.ts). Gate(n) is the relation a held call inserts last.
 * The role `writer` inserts both, and its workload is `stamp`, an insertion of Log's rows, and `held`, an insertion of
 * Log's rows and then, in a later stratum, of a Gate row. Each call states its rows as an array of `{ child, note }`,
 * which leaves `at` out, so every row is stamped with the call's instant at its child, `greatest(c, h + 1)`, c the
 * call's reading of the database's clock in microseconds and h the child's head, which the clock's stamp function
 * advances in the statement that stamps, locking the child's head row until the call ends (physical/ddl/stamps.ts,
 * write/insert/stamp.ts). The schema and its logins are installed and served as `grizzle generate` drafts them
 * (schedules/rig.ts openRig): `writer` runs at the level generate certifies, READ COMMITTED, read off each writer's
 * served Db.
 *
 * A case's stored state gives each of the children 1 and 2 no row, a row at instant 1, below every reading of the
 * clock, or a row at instant F, a microsecond in 2100, above every reading: a clock that stepped back, simulated by the
 * row the test writes as the schema's owner, each child's head filled from the rows as a migration fills it
 * (schedules/rig.ts replace), never by the server's clock. Two writers A and B, two Dbs of `writer` over DbLayers of
 * their own, run one call each, A `held` and B `stamp`, each retried after a TransientFailure until it answers. In
 * `concurrent`, the schema's owner holds Gate in SHARE mode while A runs: A's rows are stamped, its children's heads
 * held and uncommitted, when its Gate insert waits on that lock, and B runs then. B waits for A wherever they share a
 * child, at its head; the owner's COMMIT lets A commit first, and B stamps after it. Otherwise B commits while A waits.
 * In `sequential`, A's call commits before B's begins.
 *
 * Properties, per case:
 * - each call is accepted at its first try, adding each of its rows, no TransientFailure met, and B waits for A
 *   exactly where they share a child;
 * - at each child, the rows the calls added hold one instant per call that stamps the child, its every row there at
 *   it, and the instants increase in the order the calls commit: A then B, unless B committed while A waited;
 * - each instant is above the head the child held before the call; at a child over F, the k-th call to commit stamps
 *   F + k, and at any other, the first stamps at least the clock's reading before the calls began.
 *
 * Oracle: the rule, stated over the case's stored heads and the commit order its moves give. Kills, by hand: a head's
 * advance the call's clock alone, the head unread, which stamps a child over F below F and two concurrent calls in the
 * order they began; and a head row per clock, not per child, where B waits for A at a child they do not share.
 *
 * Features: each stored head, a child both calls stamp, concurrently and in turn, B waiting for A, a call's two rows
 * at one child, and two children in one call.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Fiber, Formatter, Option, Result } from "effect"
import { openServed } from "#adapter/db/served.ts"
import {
	addedTo,
	aims,
	type Answered,
	byStored,
	childrenOf,
	clocks,
	departureAt,
	Gate,
	headAt,
	Log,
	shares,
	type Row,
	callRows,
	type StampFeature,
	stampingGen,
	type Stored,
	untilAnswered,
	clocksRig
} from "#test/schedules/write/instants.fixtures.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { openActors } from "#test/support/schedules/actors.ts"
import { rigIn } from "#test/support/schedules/rig.ts"
import { lockWaitOf } from "#test/support/substrate/barrier.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Two writers stamping one clock stamp each child's instants in the order its calls commit.
 *
 * Its pre-conversion budget: runs 200, coverage cases 200 (test/schedules/write/instants.test.ts at 8cd874bb0).
 */
export const twoWritersStampingOneClockStampEachChildsInstantsInTheOrderItsCallsCommit =
	property.explore(aimed(stampingGen, aims), {
		needs: { rigged: Substrate.fresh(clocksRig) },
		situations: [
			"a child over no head",
			"a child over a past head",
			"a child over a future head: the clock stepped back",
			"a child both calls stamp, concurrently",
			"a child both calls stamp, in turn",
			"B waited for A at a child",
			"two rows of one child in one call",
			"two children in one call"
		] satisfies ReadonlyArray<Reached<StampFeature>>,
		check:
			({ rigged }, k: Case<StampFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(rigged, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const s = yield* Substrate
								const rig = yield* rigIn(taken, clocks)
								const names = namesOf(rig.installed)
								const log = names.table(Log)
								const gate = names.table(Gate)
								const column = (field: "child" | "at" | "note") => names.column(Log, field)
								const open = (context: Parameters<Parameters<typeof rig.servedWriter>[1]>[0]) =>
									openServed(rig.served.roles.writer, {}).pipe(Effect.provideContext(context))
								const a = yield* rig.servedWriter("a", open, (db) =>
									writeAnswerOf(
										db.workload.stamp.once({ params: {}, facts: { insert: { Log: [] } } })
									)
								)
								const b = yield* rig.servedWriter("b", open, (db) =>
									writeAnswerOf(
										db.workload.stamp.once({ params: {}, facts: { insert: { Log: [] } } })
									)
								)
								const { holder } = yield* openActors(s, {
									holder: { kind: "raw", as: rig.installed.ambientOwner.credentials }
								})
								const holderPid = holder.pid
								const state = Effect.map(
									s.admin.queryValues(
										`SELECT ${column("child")}::text, ${column("at")}::text, ${column("note")}::text FROM ${log} ORDER BY 1, 2, 3`,
										[]
									),
									(rows) =>
										Arr.map(rows, (row): Stored => ({
											child: Number(row[0]),
											at: BigInt(String(row[1])),
											note: Number(row[2])
										}))
								)
								const clockReading = Effect.map(
									s.admin.queryValues(
										"SELECT (pg_catalog.extract('epoch', pg_catalog.clock_timestamp()) * 1000000)::bigint::text",
										[]
									),
									(rows) => BigInt(String(rows[0]?.[0]))
								)
								/**
								 * Whether a call's backend `waiter` waited for `holding` before the call ended, polled from the admin session
								 * until its fiber ends or pg_locks shows it blocked by `holding`.
								 */
								const waitedOrEnded = (
									fiber: Fiber.Fiber<Answered>,
									waiter: Effect.Effect<Option.Option<number>>,
									holding: Effect.Effect<Option.Option<number>>
								) =>
									Effect.gen(function* () {
										for (;;) {
											if (fiber.pollUnsafe() !== undefined) {
												return "ended" as const
											}
											const backends = Option.all([yield* waiter, yield* holding])
											if (Option.isSome(backends)) {
												const [waiting, held] = backends.value
												const wait = yield* lockWaitOf(s.admin, waiting)
												if (wait?.blockedBy.includes(held) === true) {
													return "waited" as const
												}
											}
											yield* Effect.yieldNow
										}
									})
								const held = (rows: ReadonlyArray<Row>) =>
									a.db.workload.held
										.once({
											params: {},
											facts: { insert: { Log: callRows(rows), Gate: [{ n: 0 }] } }
										})
										.pipe(writeAnswerOf, untilAnswered)
								const stamp = (rows: ReadonlyArray<Row>) =>
									b.db.workload.stamp
										.once({ params: {}, facts: { insert: { Log: callRows(rows) } } })
										.pipe(writeAnswerOf, untilAnswered)

								/** Each seeded child's stored sign-in, stamped at its head's instant first, as every writer of Log
								 * stamps its clock (physical/ddl/clocked.ts). */
								const seeded = Arr.flatMap([1, 2] as const, (child) => {
									const head = c.heads[child]
									return head === "none"
										? []
										: [
												`SELECT FROM ${names.stampCall(Log, "at", [`${child}`], `${headAt(head)}`)}`,
												`INSERT INTO ${log} (${column("child")}, ${column("at")}, ${column("note")}) VALUES (${child}, ${headAt(head)}, 9)`
											]
								})
								yield* rig.replace(seeded)
								const before = yield* clockReading
								const together = c.mode === "concurrent"
								if (together) {
									yield* holder.perform({ _tag: "Begin" })
									yield* holder.perform({ _tag: "Sql", sql: `LOCK TABLE ${gate} IN SHARE MODE` })
								}
								const fiberA = yield* Effect.forkChild(held(c.a), { startImmediately: true })
								const atGate = together
									? yield* waitedOrEnded(fiberA, a.actor.backend, Effect.succeedSome(holderPid))
									: "ended"
								const ranA = atGate === "ended" ? yield* Fiber.join(fiberA) : undefined
								const holding = together && atGate === "waited"
								const fiberB = yield* Effect.forkChild(stamp(c.b), { startImmediately: true })
								const observed = holding
									? yield* waitedOrEnded(fiberB, b.actor.backend, a.actor.backend)
									: "ended"
								if (together) {
									yield* holder.perform({ _tag: "Commit" })
								}
								const answeredA = ranA ?? (yield* Fiber.join(fiberA))
								const answeredB = yield* Fiber.join(fiberB)
								const final = yield* state
								const order: ReadonlyArray<readonly [string, ReadonlyArray<Row>]> =
									holding && observed === "ended"
										? [
												["B", c.b],
												["A", c.a]
											]
										: [
												["A", c.a],
												["B", c.b]
											]
								const accepted = (name: string, rows: ReadonlyArray<Row>, x: Answered) =>
									Result.isSuccess(x.ran) &&
									addedTo(x.ran.success) === BigInt(rows.length) &&
									x.tries === 1
										? undefined
										: `${name} is accepted at its first try, adding its ${rows.length} rows: ${x.tries} tries, ${Formatter.format(x.ran)}`
								const added = (child: 1 | 2) =>
									Arr.sort(
										Arr.filter(final, (r) => r.child === child && r.note !== 9),
										byStored
									)
								const departures = Arr.filter(
									[
										together && !holding
											? "A ended before its Gate insert, where it stamps its rows and waits at Gate"
											: undefined,
										accepted("A", c.a, answeredA),
										accepted("B", c.b, answeredB),
										holding && (observed === "waited") !== shares(c)
											? `B ${shares(c) ? "ended without waiting for A, where they share a child" : "waited for A, where they share no child"}`
											: undefined,
										...Arr.map([1, 2] as const, (child) =>
											departureAt(child, c.heads[child], added(child), order, before)
										)
									],
									(d) => d !== undefined
								)
								assert.deepEqual(
									departures,
									[],
									"each child's instants are its calls' in commit order"
								)
								for (const child of [1, 2] as const) {
									const stamping = Arr.filter([c.a, c.b], (rows) =>
										Arr.some(rows, (r) => r.child === child)
									)
									if (stamping.length === 0) {
										continue
									}
									k.note(
										c.heads[child] === "none"
											? "a child over no head"
											: c.heads[child] === "past"
												? "a child over a past head"
												: "a child over a future head: the clock stepped back"
									)
									if (stamping.length === 2) {
										k.note(
											together
												? "a child both calls stamp, concurrently"
												: "a child both calls stamp, in turn"
										)
									}
								}
								if (holding && observed === "waited") {
									k.note("B waited for A at a child")
								}
								for (const rows of [c.a, c.b]) {
									if (childrenOf(rows).length === 2) {
										k.note("two children in one call")
									}
									if (childrenOf(rows).length < rows.length) {
										k.note("two rows of one child in one call")
									}
								}
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "a child's instants increase in commit order, one per call, above its head, F + k over a future head"
		},
		budget: { runs: 200, steered: 200 },
		kept: [],
		kills: []
	})
