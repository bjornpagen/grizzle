/**
 * The live registry (packages/grizzle/src/adapter/live/subscriptions.ts) over a change source and a read of the
 * test's own: a model table of rows keyed by id, each in a group, which reads registered on the registry watch whole
 * or by one group, and a drawn history of commits, each a batch of row changes applied to the model and delivered to
 * the registry as the keys a leader sends for it: the keyed key of each changed row's group before and after, or the
 * table's key where it fails closed. A read's run reads the model as it stands when it runs, and a run SERIALIZABLE
 * refuses is drawn in front of any pull.
 *
 * - Routing is exact: after each commit a subscription is marked exactly when some commit since its last run delivered
 *   a key that reaches it. Oracle: the keys' match over the subscription's own (unit/live/router's rule).
 * - Folding a subscription's events equals running its read: its initial events fold to the model's rows of its group,
 *   and each batch its changes send, pulled after any number of commits, folds onto the value it holds to the model's
 *   rows of its group then, ends with `ready`, removes only keys it held and upserts only rows that differ; no batch
 *   comes where the model's rows equal the value it holds. Oracle: the model, a second implementation.
 * - What a subscription holds is bounded by its value: after any number of commits, one pull answers one batch and
 *   leaves it clean, and every refused run is run again at once, so the runs queued in front of a pull are all taken;
 *   a turn of a subscription whose value the commits left as it was sends nothing and leaves it clean. Oracle: the
 *   count of the model's commits and refused runs.
 *
 * - A read ends at its token's expiry: under a test clock, a stream pulled before its Db's `exp` sends each change
 *   first, then, once the clock reaches the instant, the error `tokenExpired` and `end`, a run in flight then
 *   interrupted; one pulled at or past it ends at once. Oracle: the expiry instant.
 *
 * Features: a keyed subscription reached, a table-wide one reached, a commit reaching no subscription, a fail-closed
 * table key, a pull after several commits, a refused run run again, a batch removing a row, and a marked subscription
 * whose value the commits left as it was; for expiry, a change sent before it and none.
 *
 * Plants (~/.cache/grizzle-release/LIVE-SUBSCRIBE/plants): routing-key-ignored.patch (unit/live/router), and
 * coalesce-dropped.patch, a notification queued per commit in place of the mark bit, so a slow consumer's pending runs
 * grow with the write rate.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Clock,
	Duration,
	Effect,
	Fiber,
	Formatter,
	Option,
	Order,
	Stream
} from "effect"
import { TestClock } from "effect/testing"
import type { ChangeSink, ChangeSource } from "#adapter/live/source.ts"
import { type LiveAnswer, makeSubscriptions } from "#adapter/live/subscriptions.ts"
import {
	callError,
	diffSet,
	fold,
	formOf,
	type Keyed,
	opening,
	type SetEvent
} from "#compiler/live/index.ts"
import { admittedIdentifier, type RouteKey } from "#compiler/plan/runtime.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** A row of the model table: its key, its group, its payload. */
interface Row {
	readonly id: number
	readonly g: number
	readonly v: number
}

/** One change of a commit: a row put, inserted or updated in place, or the row of an id deleted. */
type Change =
	| { readonly kind: "put"; readonly row: Row }
	| { readonly kind: "delete"; readonly id: number }

/** One commit: its changes, and whether the leader fails closed, sending the table's key for it. */
interface Commit {
	readonly changes: ReadonlyArray<Change>
	readonly wide: boolean
}

/** A step of a history: a commit, then for each subscription whether its consumer pulls, and the runs refused first. */
interface Step {
	readonly commit: Commit
	readonly pulls: ReadonlyArray<{ readonly pull: boolean; readonly refused: number }>
}

const table = admittedIdentifier<"table">("t")
const column = admittedIdentifier<"column">("g")
const groups = [0, 1, 2] as const

/** A subscription's reach: one group's rows, or the whole table. */
type Reach = { readonly kind: "group"; readonly g: number } | { readonly kind: "whole" }

const reachGen: Gen<Reach> = (source) =>
	source.draw(int(0, 3)) === 0
		? { kind: "whole" }
		: { kind: "group", g: source.draw(element(groups)) }

const rowGen: Gen<Row> = (source) => ({
	id: source.draw(int(0, 5)),
	g: source.draw(element(groups)),
	v: source.draw(int(0, 2))
})

const changeGen: Gen<Change> = (source) =>
	source.draw(int(0, 3)) === 0
		? { kind: "delete", id: source.draw(int(0, 5)) }
		: { kind: "put", row: source.draw(rowGen) }

/** The keys a subscription of `reach` registers under. */
const keysOf = (reach: Reach): ReadonlyArray<RouteKey> =>
	reach.kind === "whole"
		? [{ kind: "table", table }]
		: [{ kind: "keyed", table, column, value: String(reach.g) }]

/** Whether a key sent reaches a key registered (unit/live/router's rule). */
const matches = (registered: RouteKey, sent: RouteKey): boolean =>
	registered.table === sent.table &&
	(registered.kind === "table" ||
		sent.kind === "table" ||
		(registered.column === sent.column && registered.value === sent.value))

/** The model's rows a subscription of `reach` reads, by id. */
const readOf = (model: ReadonlyMap<number, Row>, reach: Reach): ReadonlyArray<Row> =>
	Arr.sort(
		Arr.filter([...model.values()], (row) => reach.kind === "whole" || row.g === reach.g),
		Order.mapInput(Order.Number, (row: Row) => row.id)
	)

/** A value's rows, by id. */
const rowsOf = (value: Keyed<"set", Row>): ReadonlyArray<Row> =>
	Arr.sort(
		[...value],
		Order.mapInput(Order.Number, (row: Row) => row.id)
	)

/** `commit` applied to `model`, and the keys a leader sends for it. */
const applied = (model: Map<number, Row>, commit: Commit): ReadonlyArray<RouteKey> => {
	const keys: Array<RouteKey> = []
	const keyed = (g: number): RouteKey => ({ kind: "keyed", table, column, value: String(g) })
	for (const change of commit.changes) {
		const id = change.kind === "put" ? change.row.id : change.id
		const before = model.get(id)
		if (before !== undefined) {
			keys.push(keyed(before.g))
		}
		if (change.kind === "put") {
			keys.push(keyed(change.row.g))
			model.set(id, change.row)
		} else {
			model.delete(id)
		}
	}
	return commit.wide && commit.changes.length > 0 ? [{ kind: "table", table }] : keys
}

/** How a set read's answer is made, as db/handles.ts makes it over the test's rows. */
const answer: LiveAnswer<"set", Row, SetEvent<Row>> = {
	settle: (events) => fold(opening<"set", Row>("set"), events),
	diff: diffSet,
	ready: { kind: "ready" },
	error: (error) => ({ kind: "error", error }),
	end: { kind: "end" }
}

/** The features a case shows. */
type Feature =
	| "a keyed subscription reached"
	| "a table-wide subscription reached"
	| "a commit reaching no subscription"
	| "a fail-closed table key"
	| "a pull after several commits"
	| "a refused run run again"
	| "a batch removing a row"
	| "a marked subscription whose value stayed"

describe("the live registry", () => {
	it.effect(
		"routing is exact, folding a subscription's events equals running its read, and what it holds is bounded by its value",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "second-implementation", name: "the model table and its reads" },
						suite: "unit/live/subscriptions",
						draw: drawn((s) => {
							const reaches = s.draw(array(reachGen, { min: 1, max: 4 }))
							return {
								start: s.draw(array(rowGen, { min: 0, max: 5 })),
								reaches,
								steps: s.draw(
									array(
										(t): Step => ({
											commit: {
												changes: t.draw(array(changeGen, { min: 0, max: 3 })),
												wide: t.draw(int(0, 4)) === 0
											},
											pulls: Arr.map(reaches, () => ({
												pull: t.draw(boolean),
												refused: t.draw(int(0, 4)) === 0 ? t.draw(int(1, 2)) : 0
											}))
										}),
										{ min: 1, max: 6 }
									)
								)
							}
						}),
						literal: Formatter.format,
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						coverage: required<Feature>(
							[
								"a keyed subscription reached",
								"a table-wide subscription reached",
								"a commit reaching no subscription",
								"a fail-closed table key",
								"a pull after several commits",
								"a refused run run again",
								"a batch removing a row",
								"a marked subscription whose value stayed"
							],
							{ cases: 300, sense: notesOnly }
						)
					},
					({ start, reaches, steps }, c) =>
						Effect.scoped(
							Effect.gen(function* () {
								const model = new Map<number, Row>()
								for (const row of start) {
									model.set(row.id, row)
								}
								const opened: { sink: ChangeSink | undefined } = { sink: undefined }
								const source: ChangeSource = {
									open: (sink) =>
										Effect.sync(() => {
											opened.sink = sink
										})
								}
								const registry = yield* makeSubscriptions(source)
								const subscriptions = yield* Effect.forEach(reaches, (reach) =>
									Effect.gen(function* () {
										const refusals = { queued: 0 }
										const read = Stream.suspend(() => {
											if (refusals.queued > 0) {
												refusals.queued -= 1
												return Stream.fromIterable<SetEvent<Row>>([
													{ kind: "reset", key: ["id"] },
													{
														kind: "error",
														error: callError("transient", {
															message: "40001",
															reason: "SerializationFailure"
														})
													}
												])
											}
											return Stream.fromIterable<SetEvent<Row>>([
												{ kind: "reset", key: ["id"] },
												...Arr.map(readOf(model, reach), (row): SetEvent<Row> => ({
													kind: "upsert",
													row
												})),
												{ kind: "ready" }
											])
										})
										const live = yield* registry.register({
											read,
											answer,
											keys: keysOf(reach),
											expiry: { kind: "never" }
										})
										const initialEvents = yield* Stream.runCollect(live.initial)
										const initial = answer.settle(initialEvents)
										assert.ok(initial.kind === "ready", "the initial run is ready")
										assert.deepEqual(
											rowsOf(initial.value),
											readOf(model, reach),
											"the initial events fold to the model's rows"
										)
										const pull = yield* Stream.toPull(live.changes)
										return {
											reach,
											live,
											pull,
											refusals,
											holding: { value: initial.value, marked: false, commits: 0 }
										}
									})
								)
								const sink = opened.sink
								assert.ok(sink !== undefined, "registering opened the source")
								for (const step of steps) {
									const keys = applied(model, step.commit)
									if (step.commit.wide && step.commit.changes.length > 0) {
										c.note("a fail-closed table key")
									}
									for (const key of keys) {
										sink.touched(key)
									}
									let reachedAny = false
									for (const [at, subscription] of subscriptions.entries()) {
										const own = keysOf(subscription.reach)
										const reached = Arr.some(keys, (key) => Arr.some(own, (o) => matches(o, key)))
										if (reached) {
											reachedAny = true
											c.note(
												subscription.reach.kind === "whole"
													? "a table-wide subscription reached"
													: "a keyed subscription reached"
											)
											subscription.holding.marked = true
											subscription.holding.commits += 1
										}
										const standing = yield* subscription.live.state
										assert.equal(
											standing,
											subscription.holding.marked ? "marked" : "clean",
											"a subscription is marked exactly when a key reached it since its last run"
										)
										const plan = step.pulls[at]
										const expected = readOf(model, subscription.reach)
										const holds = rowsOf(subscription.holding.value)
										const stays =
											holds.length === expected.length &&
											Arr.every(holds, (row, at) => {
												const other = expected[at]
												return (
													other !== undefined &&
													row.id === other.id &&
													row.g === other.g &&
													row.v === other.v
												)
											})
										if (plan === undefined || !plan.pull) {
											continue
										}
										if (stays) {
											const turned = yield* subscription.live.turn
											assert.ok(
												Option.isNone(turned),
												"a turn whose run reads the same value sends nothing"
											)
											const after = yield* subscription.live.state
											assert.equal(after, "clean", "a turn leaves the subscription clean")
											if (subscription.holding.marked) {
												c.note("a marked subscription whose value stayed")
											}
											subscription.holding.marked = false
											subscription.holding.commits = 0
											continue
										}
										if (subscription.holding.commits > 1) {
											c.note("a pull after several commits")
										}
										if (plan.refused > 0) {
											c.note("a refused run run again")
										}
										subscription.refusals.queued = plan.refused
										const batch = yield* subscription.pull
										assert.equal(Arr.lastNonEmpty(batch).kind, "ready", "a batch ends with ready")
										const before = subscription.holding.value
										for (const event of batch) {
											if (event.kind === "remove") {
												c.note("a batch removing a row")
												assert.ok(
													before.at(formOf(event.key)) !== undefined,
													"a batch removes only keys the value held"
												)
											}
										}
										const after = fold({ kind: "ready", value: before }, batch)
										assert.ok(after.kind === "ready", "a batch folds to a value")
										assert.deepEqual(
											rowsOf(after.value),
											expected,
											"a batch folds to the model's rows"
										)
										assert.equal(subscription.refusals.queued, 0, "every refused run is run again")
										const left = yield* subscription.live.state
										assert.equal(left, "clean", "one pull leaves the subscription clean")
										subscription.holding.value = after.value
										subscription.holding.marked = false
										subscription.holding.commits = 0
									}
									if (!reachedAny) {
										c.note("a commit reaching no subscription")
									}
								}
							})
						)
				)
			)
	)

	/** The features an expiry case shows. */
	type Expiring = "a change sent before the expiry" | "no change before the expiry"

	it.effect(
		"a live read ends with tokenExpired at its token's expiry, each change before it sent first",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "specification", name: "the Db's expiry instant" },
						suite: "unit/live/expiry",
						draw: drawn((s) => ({
							expiresIn: s.draw(int(1, 1000)),
							changed: s.draw(boolean),
							reach: s.draw(reachGen)
						})),
						literal: Formatter.format,
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						coverage: required<Expiring>(
							["a change sent before the expiry", "no change before the expiry"],
							{ cases: 100, sense: notesOnly }
						)
					},
					({ expiresIn, changed, reach }, c) =>
						Effect.scoped(
							Effect.gen(function* () {
								const clock = yield* TestClock.make()
								return yield* Effect.provideService(
									Effect.gen(function* () {
										const model = new Map<number, Row>([[0, { id: 0, g: 0, v: 0 }]])
										const opened: { sink: ChangeSink | undefined } = { sink: undefined }
										const source: ChangeSource = {
											open: (sink) =>
												Effect.sync(() => {
													opened.sink = sink
												})
										}
										const registry = yield* makeSubscriptions(source)
										yield* clock.setTime(0)
										const live = yield* registry.register({
											read: Stream.suspend(() =>
												Stream.fromIterable<SetEvent<Row>>([
													{ kind: "reset", key: ["id"] },
													...Arr.map(readOf(model, reach), (row): SetEvent<Row> => ({
														kind: "upsert",
														row
													})),
													{ kind: "ready" }
												])
											),
											answer,
											keys: keysOf(reach),
											expiry: { kind: "at", epochMillis: expiresIn }
										})
										yield* Stream.runCollect(live.initial)
										const pull = yield* Stream.toPull(live.changes)
										const sink = opened.sink
										assert.ok(sink !== undefined, "registering opened the source")
										if (changed) {
											c.note("a change sent before the expiry")
											const row: Row = { id: 1, g: reach.kind === "group" ? reach.g : 0, v: 1 }
											model.set(row.id, row)
											sink.touched({ kind: "keyed", table, column, value: String(row.g) })
											const batch = yield* pull
											assert.equal(
												Arr.lastNonEmpty(batch).kind,
												"ready",
												"the change comes before the expiry"
											)
										} else {
											c.note("no change before the expiry")
										}
										const waiting = yield* Effect.forkChild(pull)
										yield* clock.adjust(Duration.millis(expiresIn))
										const ending = yield* Fiber.join(waiting)
										assert.deepEqual(
											Arr.map(ending, (event) =>
												event.kind === "error" ? `error ${event.error.kind}` : event.kind
											),
											["error tokenExpired", "end"],
											"the stream ends with tokenExpired, then end, at the expiry"
										)
									}),
									Clock.Clock,
									clock
								)
							})
						)
				)
			)
	)
})
