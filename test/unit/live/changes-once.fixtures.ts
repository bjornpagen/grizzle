/** What the properties of changes-once.test.ts read: its spaces, models and helpers. */

import { Cause, Exit, Formatter, String as Str } from "effect"
import { type LiveAnswer } from "#adapter/live/subscriptions.ts"
import { diffList, fold, type ListEvent, opening } from "#compiler/live/index.ts"
import { admittedIdentifier, type RouteKey } from "#compiler/plan/runtime.ts"

/** Where the second take comes: while the first consumer waits for a mark, or after it stopped. */
export type Second = "waiting" | "stopped"

export interface Taking {
	/** The changes the first consumer heard before the second take. */
	readonly heardBefore: number
	readonly second: Second
}

export interface Row {
	readonly id: number
	readonly v: number
}

export type Feature =
	| "a second take while the first consumer waits"
	| "a second take after the first consumer stopped"
	| "a second take after the first consumer heard a change"

export const features: { readonly [S in Second]: Feature } = {
	waiting: "a second take while the first consumer waits",
	stopped: "a second take after the first consumer stopped"
}

/** How a live read's answer is made, as db/handles.ts makes it over the test's rows. */
export const answer: LiveAnswer<Row, ListEvent<Row>> = {
	settle: (events) => fold(opening<Row>(), events),
	diff: diffList,
	ready: { _tag: "ready" },
	error: (error) => ({ _tag: "error", error }),
	end: { _tag: "end" }
}

/** The one key the read registers under, and the one the change routes. */
export const key: RouteKey = { kind: "table", table: admittedIdentifier<"table">("item") }

/** The defect a second take of a registration's changes dies with. */
const takenTwice = "a live read's changes are taken once"

/** Whether `exit` is a defect whose text names the taken-once rule. */
export const diedTakenTwice = (exit: Exit.Exit<unknown>): boolean =>
	Exit.isFailure(exit) &&
	Cause.hasDies(exit.cause) &&
	Str.includes(takenTwice)(Formatter.format(Cause.squash(exit.cause)))
