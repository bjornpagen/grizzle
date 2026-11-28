/** What the properties of leading.test.ts read: its spaces, models and helpers. */

import { Deferred, Effect, Stream } from "effect"
import { type LeaderReason, ReplicationSilent } from "#adapter/live/leader.ts"
import { type LiveAnswer } from "#adapter/live/subscriptions.ts"
import { diffList, fold, type ListEvent, opening } from "#compiler/live/index.ts"

/** How a candidacy ends: with a failure of its own, with a defect, or interrupted. */
export type End = "failure" | "defect" | "interruption"

/** A row a read holds: its key alone. */
interface Row {
	readonly id: number
}

/** How a live read's answer is made, as db/handles.ts makes it over the test's rows. */
export const answer: LiveAnswer<Row, ListEvent<Row>> = {
	settle: (events) => fold(opening<Row>(), events),
	diff: diffList,
	ready: { _tag: "ready" },
	error: (error) => ({ _tag: "error", error }),
	end: { _tag: "end" }
}

/** A read of no rows, its one run's events. */
export const read: Stream.Stream<ListEvent<Row>> = Stream.fromIterable<ListEvent<Row>>([
	{ _tag: "reset", key: ["id"] },
	{ _tag: "ready" }
])

/** A candidacy's end as its fiber meets it. */
export const ended = (end: End): Effect.Effect<never, LeaderReason> => {
	switch (end) {
		case "failure":
			return Effect.fail(new ReplicationSilent({ millis: 1 }))
		case "defect":
			return Effect.die(new Error("a defect the test injects"))
		case "interruption":
			return Effect.interrupt
	}
}

/**
 * A candidacy as the test holds it: the end it is to meet, which the round decides, and the moment it has met it, its
 * fiber's exit, after which the leadership's own handling of that exit is all that stands between it and the read.
 */
export interface HeldCandidacy {
	readonly end: Deferred.Deferred<End>
	readonly exited: Deferred.Deferred<void>
}

/** The error kind a read waiting on a candidacy that ends as `end` ends with. */
export const expectedKind = {
	failure: "unavailable",
	defect: "failed",
	interruption: "failed"
} as const

export type LeadingFeature =
	| "a candidacy failing"
	| "a candidacy dying of a defect"
	| "a candidacy interrupted"
	| "a candidacy started after one died"

export const endNotes: { readonly [E in End]: LeadingFeature } = {
	failure: "a candidacy failing",
	defect: "a candidacy dying of a defect",
	interruption: "a candidacy interrupted"
}
