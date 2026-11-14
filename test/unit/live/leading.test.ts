/**
 * The process's leadership of an installation (packages/grizzle/src/adapter/live/listen.ts leading) over candidacies of
 * the test's own, each ending as a case draws it: with a failure of its own (ReplicationSilent), with a defect, or
 * interrupted. A registry (live/subscriptions.ts) over a change source whose open starts the candidacy where none runs,
 * as the fan-out's does, holds one read per round: the round registers it, which opens a source and starts a
 * candidacy, then ends that candidacy as drawn.
 *
 * Properties, each against the model of the drawn ends:
 * - Every end, a defect's and an interruption's included, ends the read waiting on the source with a typed error and
 *   `end`, never a wait: `failed` for a defect or an interruption (LeaderDied, which the same candidacy meets again),
 *   and the failure's own classification, `unavailable`, for a failure of the candidacy's.
 * - Every end gives the leadership back: the next round's registration starts a new candidacy, so the candidacies
 *   started are exactly the rounds.
 *
 * Features: a candidacy failing, one dying of a defect, one interrupted, and a candidacy started after one died.
 *
 * Plant (~/.cache/grizzle-release/DENAPI/plants): leading-catches-failures-only.patch (the leadership given back on a
 * failure alone, as listen.ts did), under which a defect leaves the read waiting and no candidacy starts again.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, element } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Deferred, Effect, Formatter, Queue, Stream } from "effect"
import { type LeaderReason, ReplicationSilent } from "#adapter/live/leader.ts"
import { type Leadership, leading } from "#adapter/live/listen.ts"
import type { ChangeSource } from "#adapter/live/source.ts"
import { type LiveAnswer, makeSubscriptions } from "#adapter/live/subscriptions.ts"
import { diffSet, fold, opening, type SetEvent } from "#compiler/live/index.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** How a candidacy ends: with a failure of its own, with a defect, or interrupted. */
type End = "failure" | "defect" | "interruption"

/** A row a read holds: its key alone. */
interface Row {
	readonly id: number
}

/** How a set read's answer is made, as db/handles.ts makes it over the test's rows. */
const answer: LiveAnswer<"set", Row, SetEvent<Row>> = {
	settle: (events) => fold(opening<"set", Row>("set"), events),
	diff: diffSet,
	ready: { kind: "ready" },
	error: (error) => ({ kind: "error", error }),
	end: { kind: "end" }
}

/** A read of no rows, its one run's events. */
const read: Stream.Stream<SetEvent<Row>> = Stream.fromIterable<SetEvent<Row>>([
	{ kind: "reset", key: ["id"] },
	{ kind: "ready" }
])

/** A candidacy's end as its fiber meets it. */
const ended = (end: End): Effect.Effect<never, LeaderReason> => {
	switch (end) {
		case "failure":
			return Effect.fail(new ReplicationSilent({ millis: 1 }))
		case "defect":
			return Effect.die(new Error("a defect the test injects"))
		case "interruption":
			return Effect.interrupt
	}
}

/** The error kind a read waiting on a candidacy that ends as `end` ends with. */
const expectedKind = { failure: "unavailable", defect: "failed", interruption: "failed" } as const

type Feature =
	| "a candidacy failing"
	| "a candidacy dying of a defect"
	| "a candidacy interrupted"
	| "a candidacy started after one died"

const endNotes: { readonly [E in End]: Feature } = {
	failure: "a candidacy failing",
	defect: "a candidacy dying of a defect",
	interruption: "a candidacy interrupted"
}

describe("the live leadership", () => {
	it.effect(
		"ends every waiting read with a typed error at any end of its candidacy, a defect's and an interruption's too, and starts a new candidacy at the next open",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "specification", name: "the drawn ends of the candidacies" },
						suite: "unit/live/leading",
						draw: drawn(
							array(element<End>(["failure", "defect", "interruption"]), { min: 1, max: 4 })
						),
						literal: Formatter.format,
						kept: [],
						runs: 64,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						coverage: required<Feature>(
							[
								"a candidacy failing",
								"a candidacy dying of a defect",
								"a candidacy interrupted",
								"a candidacy started after one died"
							],
							{ cases: 64, sense: notesOnly }
						)
					},
					(ends, c) =>
						Effect.scoped(
							Effect.gen(function* () {
								const scope = yield* Effect.scope
								const leadership: Leadership = { running: false, sink: undefined }
								const started = yield* Queue.unbounded<Deferred.Deferred<End>>()
								const count = { started: 0 }
								const candidacy: Effect.Effect<never, LeaderReason> = Effect.suspend(() => {
									const end = Deferred.makeUnsafe<End>()
									count.started += 1
									return Effect.andThen(
										Queue.offer(started, end),
										Effect.flatMap(Deferred.await(end), ended)
									)
								})
								const source: ChangeSource = {
									open: (sink) =>
										Effect.suspend(() => {
											leadership.sink = sink
											return leading(leadership, candidacy, scope)
										})
								}
								const registry = yield* makeSubscriptions(source)
								for (const [round, end] of ends.entries()) {
									const live = yield* registry.register({
										read,
										answer,
										keys: [],
										expiry: { kind: "never" }
									})
									const initialEvents = yield* Stream.runCollect(live.initial)
									const initial = answer.settle(initialEvents)
									assert.equal(initial.kind, "ready", "the read registers on the open source")
									const current = yield* Queue.take(started)
									assert.equal(
										count.started,
										round + 1,
										"each round's open starts one candidacy, the one before it having ended"
									)
									if (round > 0 && ends[round - 1] !== "failure") {
										c.note("a candidacy started after one died")
									}
									yield* Deferred.succeed(current, end)
									c.note(endNotes[end])
									const changed = yield* Stream.runCollect(live.changes)
									const after = Arr.fromIterable(changed)
									const [error, last] = after
									assert.ok(
										after.length === 2 && error?.kind === "error" && last?.kind === "end",
										`the waiting read ends with its error and end: ${Formatter.format(after)}`
									)
									assert.equal(
										error.error.kind,
										expectedKind[end],
										`a candidacy ending by ${end} ends the read ${expectedKind[end]}`
									)
									assert.equal(leadership.running, false, "the leadership is given back")
								}
							})
						)
				)
			)
	)
})
