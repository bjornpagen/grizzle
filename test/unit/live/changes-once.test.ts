/**
 * A registered live read's `changes` is taken once (packages/grizzle/src/adapter/live/subscriptions.ts register): its
 * consumer's waits are the subscription's one waiter (settled), and a second consumer would take the first's place, so
 * a mark would wake the second alone and leave the first waiting for good, a ready never emitted while every session
 * sits idle (main's pass on live/exactness's lost ready).
 *
 * A case registers one read of one row on a registry (live/subscriptions.ts makeSubscriptions) over a change source of
 * the test's own and starts the first consumer of its `changes`, which hears a drawn number of changes, each the row
 * written anew and its key routed; then `changes` is taken a second time, while the first consumer waits for a mark or
 * after it stopped, and the row changes once more. Each second take runs in a fiber of its own and is judged once that
 * change was routed, so a take that does not die is caught, never waited on.
 *
 * Properties, each against the drawn point and the rows the case wrote:
 * - the second take dies with the taken-once defect, wherever it comes;
 * - the first consumer hears every change routed while it consumes, in order, each the row's new value then `ready`,
 *   the one routed after a second take among them; one stopped hears nothing more.
 *
 * Features: a second take while the first consumer waits, one after it stopped, one after it heard a change.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Exit, Fiber, Formatter, Option, Queue, Ref, Stream } from "effect"
import type { ChangeSink, ChangeSource } from "#adapter/live/source.ts"
import { makeSubscriptions } from "#adapter/live/subscriptions.ts"
import { type ListEvent } from "#compiler/live/index.ts"
import { type RouteKey } from "#compiler/plan/runtime.ts"
import {
	answer,
	diedTakenTwice,
	type Feature,
	features,
	key,
	type Row,
	type Second,
	type Taking
} from "#test/unit/live/changes-once.fixtures.ts"

/**
 * A registered live read's changes are taken once: a second take dies wherever it comes, and the first consumer hears
 * every change.
 *
 * Budget: its suite's count before the conversion (unit/live/changes-once: 48 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const aRegisteredLiveReadsChangesAreTakenOnceASecondTakeDiesWhereverItComesAndTheFirstConsumerHearsEveryChange =
	property.explore(
		(source) => ({
			heardBefore: source.draw(int(0, 2)),
			second: source.draw(element<Second>(["waiting", "stopped"]))
		}),
		{
			needs: {},
			situations: [
				"a second take while the first consumer waits",
				"a second take after the first consumer stopped",
				"a second take after the first consumer heard a change"
			] satisfies ReadonlyArray<Reached<Feature>>,
			check: (_, c: Case<Feature>) => (taking: Taking) =>
				Effect.scoped(
					Effect.gen(function* () {
						c.note(features[taking.second])
						const opened: { sink: ChangeSink | undefined } = { sink: undefined }
						const source: ChangeSource = {
							open: (sink) =>
								Effect.sync(() => {
									opened.sink = sink
								})
						}
						const registry = yield* makeSubscriptions(source)
						const stored = yield* Ref.make<Row>({ id: 1, v: 0 })
						const read = Stream.unwrap(
							Effect.map(Ref.get(stored), (row) =>
								Stream.fromIterable<ListEvent<Row>>([
									{ _tag: "reset", key: ["id"] },
									{ _tag: "upsert", row, after: null },
									{ _tag: "ready" }
								])
							)
						)
						const keys: ReadonlyArray<RouteKey> = [key]
						const live = yield* registry.register({
							read,
							answer,
							keys,
							expiry: { kind: "never" }
						})
						const initialEvents = yield* Stream.runCollect(live.initial)
						const initial = answer.settle(initialEvents)
						assert.ok(initial._tag === "ready", "the read registers and reads its row")
						const sink = opened.sink
						assert.ok(sink !== undefined, "registering opened the source")
						const secondTake = Effect.exit(Stream.runCollect(Stream.take(live.changes, 1)))
						const heard = yield* Queue.unbounded<ListEvent<Row>>()
						const first = (taken: Stream.Stream<ListEvent<Row>>) =>
							Effect.forkScoped(
								Stream.runForEach(taken, (event) => Queue.offer(heard, event)),
								{ startImmediately: true }
							)
						/** The row's value the case writes `n`th, its key then routed. */
						const write = (n: number) =>
							Effect.andThen(
								Ref.set(stored, { id: 1, v: n }),
								Effect.sync(() => {
									sink.touched(key)
								})
							)
						/** The first consumer hears the change to `n`, then its ready. */
						const hears = (n: number) =>
							Effect.gen(function* () {
								const change = yield* Queue.take(heard)
								const ready = yield* Queue.take(heard)
								assert.deepEqual(
									[change, ready],
									[{ _tag: "upsert", row: { id: 1, v: n }, after: null }, { _tag: "ready" }],
									`the first consumer hears the change to ${n}, then its ready`
								)
							})
						const consumer = yield* first(live.changes)
						for (let n = 1; n <= taking.heardBefore; n++) {
							yield* write(n)
							yield* hears(n)
						}
						if (taking.heardBefore > 0) {
							c.note("a second take after the first consumer heard a change")
						}
						if (taking.second === "stopped") {
							yield* Fiber.interrupt(consumer)
						}
						const outcome = yield* Ref.make<Option.Option<Exit.Exit<unknown>>>(Option.none())
						yield* Effect.forkScoped(
							Effect.flatMap(secondTake, (exit) => Ref.set(outcome, Option.some(exit))),
							{ startImmediately: true }
						)
						const last = taking.heardBefore + 1
						yield* write(last)
						const secondExit = yield* Ref.get(outcome)
						assert.ok(
							Option.exists(secondExit, diedTakenTwice),
							`the second take, ${taking.second === "waiting" ? "while the first consumer waits" : "after it stopped"}, died: ${Formatter.format(secondExit)}`
						)
						if (taking.second === "waiting") {
							yield* hears(last)
							yield* Fiber.interrupt(consumer)
						} else {
							const nothing = yield* Queue.poll(heard)
							assert.ok(Option.isNone(nothing), "the stopped consumer heard nothing more")
						}
					})
				),
			oracle: {
				kind: "specification",
				name: "the drawn point of the second take and the row written"
			},
			budget: { runs: 48, steered: 0 },
			kept: [],
			kills: [
				{
					file: "packages/grizzle/src/adapter/live/subscriptions.ts",
					original: "\t\t\t\t\t\tif (handout.taken) {",
					replacement: "\t\t\t\t\t\tif (handout.taken && !handout.taken) {",
					why: "A registration's changes run again for every consumer, as before, so a second consumer taking it while the first waits takes the first's wait, the first never hears the change, and the second take does not die."
				}
			]
		}
	)
