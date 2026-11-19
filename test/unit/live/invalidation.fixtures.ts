/** What the properties of invalidation.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { type Aimed, aimed, array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import { type SlotSeen } from "#adapter/live/listen.ts"
import { parseWalPosition, type WalPosition } from "#compiler/live/notify.ts"

/** One event of the protocol, its listener by its index among the case's listeners where it has one. */
type Step =
	| { readonly kind: "write" }
	| { readonly kind: "confirm" }
	| { readonly kind: "drop" }
	| { readonly kind: "lead" }
	| { readonly kind: "listen"; readonly listener: number }
	| { readonly kind: "check"; readonly listener: number }
	| { readonly kind: "hear"; readonly listener: number }

/** The listeners a case runs. */
export const listeners = 3

const stepGen: Gen<Step> = (source) => {
	const kind = source.draw(
		element(["write", "confirm", "drop", "lead", "listen", "check", "hear"] as const)
	)
	switch (kind) {
		case "write":
		case "confirm":
		case "drop":
		case "lead":
			return { kind }
		case "listen":
		case "check":
		case "hear":
			return { kind, listener: source.draw(int(0, listeners - 1)) }
	}
}

/** An invalidation as the model fans it out: the WAL position the leader read, and the incarnations made before it. */
export interface Invalidation {
	readonly before: WalPosition
	readonly madeBefore: number
}

/** A listener of the model: where it stands, the invalidations it is yet to hear, what it knows, and its incarnation. */
export type Listener =
	| { readonly kind: "idle" }
	| {
			readonly kind: "listening"
			readonly pending: ReadonlyArray<Invalidation>
			readonly seen: SlotSeen
			readonly heard: ReadonlyArray<Invalidation>
			readonly incarnation: Option.Option<number>
	  }
	| { readonly kind: "lost" }
	| { readonly kind: "refused" }

export type Feature =
	| "a stale invalidation heard before the check"
	| "a stale invalidation heard after the check"
	| "a real invalidation ending a source"
	| "a check finding no slot"

/** The WAL position `bytes` (live/notify.ts parseWalPosition of its decimal text). */
export const position = (bytes: bigint): WalPosition => {
	const read = parseWalPosition(String(bytes))
	assert.ok(read.ok, `${bytes} is a WAL position`)
	return read.value
}

/** Whether the model says a source standing on `incarnation` is lost by having heard `heard`. */
export const modelLost = (incarnation: number, heard: ReadonlyArray<Invalidation>): boolean =>
	Arr.some(heard, (invalidation) => incarnation <= invalidation.madeBefore)

/**
 * A history whose listener hears, before its check, the invalidation a leader fans out as it makes the first slot,
 * then checks that slot: the invalidation it heard is stale, fanned out before the slot it stands on was made.
 */
const staleBeforeCheckGen: Gen<ReadonlyArray<Step>> = (source) => {
	const listener = source.draw(int(0, listeners - 1))
	return [
		{ kind: "listen", listener },
		{ kind: "lead" },
		{ kind: "hear", listener },
		{ kind: "check", listener },
		...source.draw(array(stepGen, { min: 0, max: 20 }))
	]
}

/**
 * A history whose listener checks the first slot, then hears the invalidation the leader fanned out as it made it:
 * stale, heard after the check.
 */
const staleAfterCheckGen: Gen<ReadonlyArray<Step>> = (source) => {
	const listener = source.draw(int(0, listeners - 1))
	return [
		{ kind: "listen", listener },
		{ kind: "lead" },
		{ kind: "check", listener },
		{ kind: "hear", listener },
		...source.draw(array(stepGen, { min: 0, max: 20 }))
	]
}

/**
 * A history that ends a source on a real invalidation: a slot made, a listener's LISTEN and check on it, drawn steps,
 * then the slot dropped and made again, which fans out an invalidation of the slot the listener stands on, and the
 * listener hearing its first pending invalidation. Every invalidation pending for it then was fanned out after its
 * slot was made, so its source ends on one, in the drawn steps or at the last.
 */
const realInvalidationGen: Gen<ReadonlyArray<Step>> = (source) => {
	const listener = source.draw(int(0, listeners - 1))
	return [
		{ kind: "lead" },
		{ kind: "listen", listener },
		{ kind: "check", listener },
		...source.draw(array(stepGen, { min: 0, max: 18 })),
		{ kind: "drop" },
		{ kind: "lead" },
		{ kind: "hear", listener }
	]
}

/** Drawn interleavings of the protocol's events, aimed at each order of hearing and checking while it is pending. */
export const stepsSpace: Aimed<ReadonlyArray<Step>, Feature> = aimed(
	array(stepGen, { min: 1, max: 24 }),
	[
		["a stale invalidation heard before the check", staleBeforeCheckGen],
		["a stale invalidation heard after the check", staleAfterCheckGen],
		["a real invalidation ending a source", realInvalidationGen]
	]
)
