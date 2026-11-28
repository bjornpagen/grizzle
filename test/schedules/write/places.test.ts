/**
 * Two writers stamp one group's place, each session nesting its marks, and the group's places run gapless from its head
 * in the order their calls commit, every mark carrying exactly its session's stamped place, two calls at one group
 * taking turns at its head, never meeting as a duplicate place or a key's refusal.
 *
 * Session(child, item, n, stage, marks) is keyed (child, item, n), its `n` a place by `stage` (ir/instant.ts PlaceHead)
 * whose group is (child, item), beside the key (child, item, stage) the place demands, and it owns Mark(child, item, n,
 * at, v), its ordered family at `marks`, each mark carrying its session's (child, item, n). Gate(n) is the relation a
 * held call inserts last. The role `writer` inserts all three, and its workload is `stamp`, an insertion of Session's
 * rows with their marks nested, reading back the sessions it added, and `held`, an insertion of Session's rows and then,
 * in a later stratum, of a Gate row. Each call states its rows as an array of `{ child, item, stage, marks }`, which
 * leaves `n` out, so every session is stamped with its group's next place, `coalesce(h + 1, 0)`, h the group's head,
 * which the place's stamp function advances, locking the group's head row until the call ends (physical/ddl/stamps.ts),
 * and its marks carry that one stamp, the session and its marks written by one family statement that stamps the head
 * once at each group and returns the sessions it inserted to the read-back riding it (write/family/additions.ts
 * stampedSources, write/program/compile.ts ridingFamily). The schema and its logins are installed and served as
 * `grizzle generate` drafts them, once per member, each case on its own clone of that installation
 * (support/schedules/rig.ts rigTemplate and rigIn): `writer` runs at the level generate certifies, READ COMMITTED.
 *
 * A case's stored state gives each of the items 1 and 2 of child 1 none, one or two places before the calls, nesting no
 * mark, each group's head filled from them as a migration fills it (schedules/rig.ts replace). Two writers A and B, two
 * Dbs of `writer` over DbLayers of their own, run one call each, A `held` and B `stamp`, each stating one row at each
 * item it names, at a stage of its own, nesting none, one or two marks, each retried after a TransientFailure until it
 * answers. In `concurrent`, the schema's owner holds Gate in SHARE mode while A runs: A's rows are stamped, its groups'
 * heads held and uncommitted, when its Gate insert waits on that lock, and B runs then. Where both stamp one item, B
 * waits for A at the group's head; the owner's COMMIT lets A commit first, and B stamps the place after A's. Otherwise B
 * commits while A waits. In `sequential`, A's call commits before B's begins.
 *
 * Properties, per case:
 * - each call is accepted at its first try, adding each of its rows, never refused at the key, no TransientFailure
 *   met, and B waits for A exactly where they stamp one item concurrently;
 * - at each item, the places the calls added are the group's head and those after it, one per call that stamps the
 *   item, in the order the calls commit: A then B;
 * - every session a call added holds exactly its call's marks at its own place, and no other mark stands;
 * - B reads back exactly the sessions it added, each at the place stamped.
 *
 * Oracle: the rule, stated over the case's stored heads and the commit order its moves give. Kills, each by hand, each
 * must turn it red: the place's head never advanced past its first stamp, so a group over a head is stamped at a place
 * it holds and the insert is refused at the key; the marks' additions a statement of their own after the session's
 * (write/frontend/compile.ts stampedTogether joining none), which stamps again over the session it now holds, so a mark
 * carries its session's place plus one and is refused at its owner; and no mark carrying its session's stamp
 * (write/family/nesting.ts carriedStamps pairing none).
 *
 * Features: each stored head, an item both calls stamp, concurrently and in turn, B waiting for A, two items in one
 * call, and a session nesting marks or none.
 */

import { assert, deepEquals } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Fiber, Formatter, Option, Order, Result } from "effect"
import { openServed } from "#adapter/db/served.ts"
import {
	addedTo,
	aims,
	type Answered,
	callRows,
	type Clearing,
	type ClearingFeature,
	cleared,
	clearedRig,
	clearingFeatures,
	clearingGen,
	clearingRows,
	departureAt,
	Gate,
	type Items,
	Mark,
	marksDeparture,
	Note,
	meets,
	type PlaceFeature,
	places,
	placesRig,
	placingGen,
	seededRows,
	Session,
	type Stored,
	type StoredMark,
	stampedDeparture,
	untilAnswered
} from "#test/schedules/write/places.fixtures.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { openActors } from "#test/support/schedules/actors.ts"
import { rigIn } from "#test/support/schedules/rig.ts"
import { lockWaitOf } from "#test/support/substrate/barrier.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Two writers stamping one group's place stamp its places gapless from its head in the order their calls commit, each mark carrying its session's place, taking turns at the group's head. */
export const twoWritersStampingOneGroupsPlaceStampItsPlacesGaplessFromItsHeadInTheOrderTheirCallsCommitEachMarkCarryingItsSessionsPlace =
	property.explore(aimed(placingGen, aims), {
		needs: { rigged: Substrate.fresh(placesRig) },
		situations: [
			"an item over no place",
			"an item over one place",
			"an item over two places",
			"an item both calls stamp, concurrently",
			"an item both calls stamp, in turn",
			"B waited for A at a group",
			"two items in one call",
			"a session nesting marks",
			"a session nesting none"
		] satisfies ReadonlyArray<Reached<PlaceFeature>>,
		check:
			({ rigged }, k: Case<PlaceFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(rigged, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const s = yield* Substrate
								const rig = yield* rigIn(taken, places)
								const names = namesOf(rig.installed)
								const table = names.table(Session)
								const gate = names.table(Gate)
								const column = (field: "child" | "item" | "n" | "stage" | "marks") =>
									names.column(Session, field)
								const markTable = names.table(Mark)
								const markColumn = (field: "item" | "n" | "at" | "v") => names.column(Mark, field)
								const marks = Effect.map(
									s.admin.queryValues(
										`SELECT ${markColumn("item")}::text, ${markColumn("n")}::text, ${markColumn("at")}::text, ${markColumn("v")}::text FROM ${markTable}`,
										[]
									),
									(rows) =>
										Arr.map(rows, (row): StoredMark => ({
											item: Number(row[0]),
											n: Number(row[1]),
											at: Number(row[2]),
											v: Number(row[3])
										}))
								)
								const open = (context: Parameters<Parameters<typeof rig.servedWriter>[1]>[0]) =>
									openServed(rig.served.roles.writer, {}).pipe(Effect.provideContext(context))
								const a = yield* rig.servedWriter("a", open, (db) =>
									writeAnswerOf(
										db.workload.stamp.once({ params: {}, facts: { insert: { Session: [] } } })
									)
								)
								const b = yield* rig.servedWriter("b", open, (db) =>
									writeAnswerOf(
										db.workload.stamp.once({ params: {}, facts: { insert: { Session: [] } } })
									)
								)
								const { holder } = yield* openActors(s, {
									holder: { kind: "raw", as: rig.installed.ambientOwner.credentials }
								})
								const holderPid = holder.pid
								const state = Effect.map(
									s.admin.queryValues(
										`SELECT ${column("item")}::text, ${column("n")}::text, ${column("stage")}::text FROM ${table} ORDER BY 1, 2`,
										[]
									),
									(rows) =>
										Arr.map(rows, (row): Stored => ({
											item: Number(row[0]),
											n: Number(row[1]),
											stage: Number(row[2])
										}))
								)
								/**
								 * Whether a call's backend `waiter` waited for `holding` before the call ended, polled from the admin
								 * session until its fiber ends or pg_locks shows it blocked by `holding`.
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
								const held = (items: Items) =>
									a.db.workload.held
										.once({
											params: {},
											facts: {
												insert: { Session: callRows("A", items, c.marks.A), Gate: [{ n: 0 }] }
											}
										})
										.pipe(writeAnswerOf, untilAnswered)
								const stamp = (items: Items) =>
									b.db.workload.stamp
										.once({
											params: {},
											facts: { insert: { Session: callRows("B", items, c.marks.B) } }
										})
										.pipe(writeAnswerOf, untilAnswered)

								const seeded = seededRows(c)
								yield* rig.replace(
									seeded.length === 0
										? []
										: [
												`INSERT INTO ${table} (${column("child")}, ${column("item")}, ${column("n")}, ${column("stage")}, ${column("marks")}) VALUES ${Arr.join(seeded, ", ")}`
											]
								)
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
								const finalMarks = yield* marks
								const order: ReadonlyArray<readonly ["A" | "B", Items]> =
									holding && observed === "ended"
										? [
												["B", c.b],
												["A", c.a]
											]
										: [
												["A", c.a],
												["B", c.b]
											]
								const accepted = (name: string, items: Items, x: Answered) =>
									Result.isSuccess(x.ran) &&
									addedTo(x.ran.success) === BigInt(items.length) &&
									x.tries === 1
										? undefined
										: `${name} is accepted at its first try, adding its ${items.length} rows, never refused at the key: ${x.tries} tries, ${Formatter.format(x.ran)}`
								const added = (item: 1 | 2) =>
									Arr.sort(
										Arr.filter(final, (r) => r.item === item && r.stage < 100),
										Order.mapInput(Order.Number, (r: Stored) => r.n)
									)
								const departures = Arr.filter(
									[
										together && !holding
											? "A ended before its Gate insert, where it stamps its rows and waits at Gate"
											: undefined,
										accepted("A", c.a, answeredA),
										accepted("B", c.b, answeredB),
										holding && (observed === "waited") !== meets(c)
											? `B ${meets(c) ? "ended without waiting for A, where they stamp one item" : "waited for A, where they stamp no item alike"}`
											: undefined,
										...Arr.map([1, 2] as const, (item) =>
											departureAt(item, c.heads[item], added(item), order)
										),
										marksDeparture(
											c,
											Arr.filter(final, (r) => r.stage < 100),
											finalMarks
										),
										stampedDeparture(
											answeredB,
											Arr.filter(final, (r) => r.stage >= 20 && r.stage < 100)
										)
									],
									(d) => d !== undefined
								)
								assert.deepEqual(
									departures,
									[],
									"each group's places run on from its head in commit order"
								)
								for (const item of [1, 2] as const) {
									const stamping = Arr.filter([c.a, c.b], (items) => Arr.contains(items, item))
									if (stamping.length === 0) {
										continue
									}
									k.note(
										c.heads[item] === 0
											? "an item over no place"
											: c.heads[item] === 1
												? "an item over one place"
												: "an item over two places"
									)
									if (stamping.length === 2) {
										k.note(
											together
												? "an item both calls stamp, concurrently"
												: "an item both calls stamp, in turn"
										)
									}
								}
								if (holding && observed === "waited") {
									k.note("B waited for A at a group")
								}
								for (const items of [c.a, c.b]) {
									if (items.length === 2) {
										k.note("two items in one call")
									}
								}
								k.note(
									c.marks.A + c.marks.B > 0 ? "a session nesting marks" : "a session nesting none"
								)
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "a group's places run on from its head, one per call, in commit order, two calls at one group taking turns at its head, none retried"
		},
		budget: { runs: 100, steered: 100 },
		kept: [],
		kills: []
	})

/** A delete of a place's whole groups deletes their heads with them, so each group it cleared stamps its first place, 0, again, and every other group goes on from its head. */
export const aDeleteOfAPlacesWholeGroupsDeletesTheirHeadsSoEachClearedGroupStampsItsFirstPlaceAgain =
	property.exhaust(finite(clearingGen), {
		needs: { rigged: Substrate.fresh(clearedRig) },
		situations: [
			"an owner's groups cleared",
			"a plain relation's groups cleared",
			"one item cleared",
			"both items cleared",
			"a cleared item over two places"
		] satisfies ReadonlyArray<Reached<ClearingFeature>>,
		check:
			({ rigged }, k: Case<ClearingFeature>) =>
			(c: Clearing) =>
				Effect.scoped(
					Effect.flatMap(rigged, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								k.noteAll(clearingFeatures(c))
								const s = yield* Substrate
								const rig = yield* rigIn(taken, cleared)
								const names = namesOf(rig.installed)
								const owner = c.relation === "Session"
								const table = owner ? names.table(Session) : names.table(Note)
								const column = (field: "child" | "item" | "n") =>
									owner ? names.column(Session, field) : names.column(Note, field)
								const columns = owner
									? `${column("child")}, ${column("item")}, ${column("n")}, ${names.column(Session, "stage")}, ${names.column(Session, "marks")}`
									: `${column("child")}, ${column("item")}, ${column("n")}, ${names.column(Note, "w")}`
								yield* rig.replace([
									`INSERT INTO ${table} (${columns}) VALUES ${Arr.join(clearingRows(c), ", ")}`
								])
								const clearer = yield* rig.servedWriter(
									"clearer",
									(context) =>
										openServed(rig.served.roles.clearer, {}).pipe(Effect.provideContext(context)),
									(db) =>
										writeAnswerOf(
											db.workload.clear.once({ params: { child: 1, item: 0 }, facts: {} })
										)
								)
								const writer = yield* rig.servedWriter(
									"writer",
									(context) =>
										openServed(rig.served.roles.writer, {}).pipe(Effect.provideContext(context)),
									(db) =>
										writeAnswerOf(
											db.workload.stamp.once({ params: {}, facts: { insert: { Session: [] } } })
										)
								)
								const clears = yield* Effect.forEach(c.cleared, (item) =>
									(owner
										? clearer.db.workload.clear.once({ params: { child: 1, item }, facts: {} })
										: clearer.db.workload.clearNotes.once({ params: { child: 1, item }, facts: {} })
									).pipe(writeAnswerOf, untilAnswered)
								)
								const items = [1, 2] as const
								const stamped = yield* (
									owner
										? writer.db.workload.stamp.once({
												params: {},
												facts: {
													insert: {
														Session: Arr.map(items, (item) => ({
															child: 1,
															item,
															stage: 30 + item,
															marks: []
														}))
													}
												}
											})
										: writer.db.workload.note.once({
												params: {},
												facts: {
													insert: {
														Note: Arr.map(items, (item) => ({ child: 1, item, w: 30 + item }))
													}
												}
											})
								).pipe(writeAnswerOf, untilAnswered)
								const placed = yield* Effect.map(
									s.admin.queryValues(
										`SELECT ${column("item")}::text, ${column("n")}::text FROM ${table} WHERE ${owner ? names.column(Session, "stage") : names.column(Note, "w")} < 100 ORDER BY 1`,
										[]
									),
									(rows) => Arr.map(rows, (row) => [Number(row[0]), Number(row[1])] as const)
								)
								const expected = Arr.map(
									items,
									(item) => [item, Arr.contains(c.cleared, item) ? 0 : c.heads[item]] as const
								)
								const added = (x: Answered): bigint =>
									Result.isSuccess(x.ran) && x.ran.success._tag === "accepted"
										? Arr.reduce(x.ran.success.counts, 0n, (n, count) => n + count.added)
										: 0n
								const departures = Arr.filter(
									[
										...Arr.map(clears, (x, at) =>
											Result.isSuccess(x.ran) && x.ran.success._tag === "accepted"
												? undefined
												: `the clear of item ${String(c.cleared[at])} is accepted: ${Formatter.format(x.ran)}`
										),
										added(stamped) === 2n
											? undefined
											: `the stamp after the clears adds its two rows: ${Formatter.format(stamped.ran)}`,
										deepEquals(placed, expected)
											? undefined
											: `each cleared item stamps 0 again and every other its head: ${Formatter.format(expected)}: ${Formatter.format(placed)}`
									],
									(d): d is string => d !== undefined
								)
								assert.deepEqual(departures, [], "a cleared group starts its places again at 0")
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: `docs/reads-and-writes.md "Places": a delete of a place's relation removes whole groups and their heads, so a cleared group's next place is 0, as a group never stamped's`
		},
		box: "Session, an owner of its marks, or Note, which owns no family: items 1 and 2 of child 1, each over one or two stored places, one or both cleared by deleteWhere at the place's group, then one row stamped at each",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/insert/stamp.ts",
				original: '\treturn [cte(supply.relation(internal("place release")), release)]\n',
				replacement: "\treturn []\n",
				why: "A delete of whole groups leaves their heads, so a cleared group's next insert stamps one past its old head, not 0, and the cleared item's place departs."
			}
		]
	})
