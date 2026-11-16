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
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { element, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import {
	Cause,
	Effect,
	Exit,
	Fiber,
	Formatter,
	Option,
	Queue,
	Ref,
	Stream,
	String as Str
} from "effect"
import type { ChangeSink, ChangeSource } from "#adapter/live/source.ts"
import { type LiveAnswer, makeSubscriptions } from "#adapter/live/subscriptions.ts"
import { diffSet, fold, opening, type SetEvent } from "#compiler/live/index.ts"
import { admittedIdentifier, type RouteKey } from "#compiler/plan/runtime.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** Where the second take comes: while the first consumer waits for a mark, or after it stopped. */
type Second = "waiting" | "stopped"

interface Taking {
	/** The changes the first consumer heard before the second take. */
	readonly heardBefore: number
	readonly second: Second
}

interface Row {
	readonly id: number
	readonly v: number
}

type Feature =
	| "a second take while the first consumer waits"
	| "a second take after the first consumer stopped"
	| "a second take after the first consumer heard a change"

const features: { readonly [S in Second]: Feature } = {
	waiting: "a second take while the first consumer waits",
	stopped: "a second take after the first consumer stopped"
}

/** How a set read's answer is made, as db/handles.ts makes it over the test's rows. */
const answer: LiveAnswer<"set", Row, SetEvent<Row>> = {
	settle: (events) => fold(opening<"set", Row>("set"), events),
	diff: diffSet,
	ready: { kind: "ready" },
	error: (error) => ({ kind: "error", error }),
	end: { kind: "end" }
}

/** The one key the read registers under, and the one the change routes. */
const key: RouteKey = { kind: "table", table: admittedIdentifier<"table">("item") }

/** The defect a second take of a registration's changes dies with. */
const takenTwice = "a live read's changes are taken once"

/** Whether `exit` is a defect whose text names the taken-once rule. */
const diedTakenTwice = (exit: Exit.Exit<unknown>): boolean =>
	Exit.isFailure(exit) &&
	Cause.hasDies(exit.cause) &&
	Str.includes(takenTwice)(Formatter.format(Cause.squash(exit.cause)))

describe("a registered live read's changes", () => {
	it.effect(
		"are taken once: a second take dies wherever it comes, and the first consumer hears every change",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the drawn point of the second take and the row written"
						},
						suite: "unit/live/changes-once",
						draw: drawn((source) => ({
							heardBefore: source.draw(int(0, 2)),
							second: source.draw(element<Second>(["waiting", "stopped"]))
						})),
						literal: Formatter.format,
						kept: [],
						runs: 48,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						coverage: required<Feature>(
							[
								"a second take while the first consumer waits",
								"a second take after the first consumer stopped",
								"a second take after the first consumer heard a change"
							],
							{ cases: 48, sense: notesOnly }
						)
					},
					(taking: Taking, c) =>
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
										Stream.fromIterable<SetEvent<Row>>([
											{ kind: "reset", key: ["id"] },
											{ kind: "upsert", row },
											{ kind: "ready" }
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
								assert.ok(initial.kind === "ready", "the read registers and reads its row")
								const sink = opened.sink
								assert.ok(sink !== undefined, "registering opened the source")
								const secondTake = Effect.exit(Stream.runCollect(Stream.take(live.changes, 1)))
								const heard = yield* Queue.unbounded<SetEvent<Row>>()
								const first = (taken: Stream.Stream<SetEvent<Row>>) =>
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
											[{ kind: "upsert", row: { id: 1, v: n } }, { kind: "ready" }],
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
						)
				)
			)
	)
})
