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
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array, boolean, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Clock, Duration, Effect, Fiber, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { ChangeSink, ChangeSource } from "#adapter/live/source.ts"
import { makeSubscriptions } from "#adapter/live/subscriptions.ts"
import { callError, fold, formOf, type ListEvent } from "#compiler/live/index.ts"
import {
	answer,
	applied,
	changeGen,
	column,
	type Expiring,
	type Feature,
	keysOf,
	matches,
	reachGen,
	readOf,
	type Row,
	rowGen,
	rowsOf,
	type Step,
	table,
	upsertsOf
} from "#test/unit/live/subscriptions.fixtures.ts"

/**
 * The live registry's routing is exact, folding a subscription's events equals running its read, and what it holds is
 * bounded by its value.
 *
 * Budget: its suite's count before the conversion (unit/live/subscriptions: 300 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theLiveRegistryRoutingIsExactFoldingASubscriptionsEventsEqualsRunningItsReadAndWhatItHoldsIsBoundedByItsValue =
	property.explore(
		(s) => {
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
		},
		{
			needs: {},
			situations: [
				"a keyed subscription reached",
				"a table-wide subscription reached",
				"a commit reaching no subscription",
				"a fail-closed table key",
				"a pull after several commits",
				"a refused run run again",
				"a batch removing a row",
				"a marked subscription whose value stayed"
			] satisfies ReadonlyArray<Reached<Feature>>,
			check:
				(_, c: Case<Feature>) =>
				({ start, reaches, steps }) =>
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
											return Stream.fromIterable<ListEvent<Row>>([
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
										return Stream.fromIterable<ListEvent<Row>>([
											{ kind: "reset", key: ["id"] },
											...upsertsOf(readOf(model, reach)),
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
					),
			oracle: { kind: "second-implementation", name: "the model table and its reads" },
			budget: { runs: 300, steered: 0 },
			kept: [],
			kills: [
				{
					file: "packages/grizzle/src/adapter/live/router.ts",
					original: "\t}\n\tswitch (key.kind) {",
					replacement: '\t}\n\tswitch (key.kind === "keyed" ? "table" : key.kind) {',
					why: "route visits every subscription of the key's table whatever the key's column and value, so a subscription no delivered key reaches is marked; the routing property fails."
				}
			]
		}
	)

/**
 * A live read of the registry ends with tokenExpired at its token's expiry, each change before it sent first.
 *
 * Budget: its suite's count before the conversion (unit/live/expiry: 100 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const theLiveRegistryALiveReadEndsWithTokenExpiredAtItsTokensExpiryEachChangeBeforeItSentFirst =
	property.explore(
		(s) => ({
			expiresIn: s.draw(int(1, 1000)),
			changed: s.draw(boolean),
			reach: s.draw(reachGen)
		}),
		{
			needs: {},
			situations: [
				"a change sent before the expiry",
				"no change before the expiry"
			] satisfies ReadonlyArray<Reached<Expiring>>,
			check:
				(_, c: Case<Expiring>) =>
				({ expiresIn, changed, reach }) =>
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
											Stream.fromIterable<ListEvent<Row>>([
												{ kind: "reset", key: ["id"] },
												...upsertsOf(readOf(model, reach)),
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
					),
			oracle: { kind: "specification", name: "the Db's expiry instant" },
			budget: { runs: 100, steered: 0 },
			kept: [],
			kills: [
				{
					file: "packages/grizzle/src/adapter/live/subscriptions.ts",
					original: '\t\t\t\tif (Result.isFailure(opened) || standing.kind !== "open") {',
					replacement: '\t\t\t\tif (Result.isFailure(opened) || standing.kind === "open") {',
					why: "Operator mutant (comparison) at packages/grizzle/src/adapter/live/subscriptions.ts:340 in register: `!==` becomes `===`; the property fails (lane CATCH, grizzle 0baff5d6)."
				}
			]
		}
	)
