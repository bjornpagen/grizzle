/**
 * Which invalidations end a live source (packages/grizzle/src/adapter/live/listen.ts heardInvalidation, checkedSlot),
 * over drawn interleavings of the protocol's events in a model of one installation: a WAL whose position advances with
 * each write, slot incarnations, each made by the leader where none stands, its position its confirmed_flush_lsn, which
 * advances as the leader confirms; a leader that, finding no slot standing, fans out an invalidation of the WAL position
 * it read, then makes the slot, which writes WAL first, as making a logical slot does; and listeners that LISTEN, check
 * the slot, and hear each notification fanned out after their LISTEN at a drawn time, before their check or after it.
 *
 * Property, against the model's own record of incarnations, never positions: a listener's source is lost exactly when
 * it heard an invalidation that the leader fanned out after the incarnation it stands on was made. So an invalidation
 * fanned out for an earlier slot ends no source of a slot made since, whether it is heard before the source's check or
 * after it, and an invalidation of the slot a source stands on ends it. A listener whose check finds no slot standing is
 * refused.
 *
 * Features: a stale invalidation heard before the check, one heard after it, a real invalidation ending a source, a
 * check finding no slot.
 *
 * Plant (~/.cache/grizzle-release/DENAPI/plants): invalidation-ignores-position.patch (every invalidation names every
 * slot, as before invalidations carried a position), under which a stale invalidation ends a newer slot's source.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { checkedSlot, heardInvalidation, type SlotSeen } from "#adapter/live/listen.ts"
import { parseWalPosition, type WalPosition } from "#compiler/live/notify.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

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
const listeners = 3

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
interface Invalidation {
	readonly before: WalPosition
	readonly madeBefore: number
}

/** A listener of the model: where it stands, the invalidations it is yet to hear, what it knows, and its incarnation. */
type Listener =
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

type Feature =
	| "a stale invalidation heard before the check"
	| "a stale invalidation heard after the check"
	| "a real invalidation ending a source"
	| "a check finding no slot"

/** The WAL position `bytes` (live/notify.ts parseWalPosition of its decimal text). */
const position = (bytes: bigint): WalPosition => {
	const read = parseWalPosition(String(bytes))
	assert.ok(read.ok, `${bytes} is a WAL position`)
	return read.value
}

/** Whether the model says a source standing on `incarnation` is lost by having heard `heard`. */
const modelLost = (incarnation: number, heard: ReadonlyArray<Invalidation>): boolean =>
	Arr.some(heard, (invalidation) => incarnation <= invalidation.madeBefore)

describe("a live source's invalidation", () => {
	it.effect(
		"ends exactly the sources standing on a slot made before it, whenever it is heard, and no source of a slot made since",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the model's record of which slot was made when"
						},
						suite: "unit/live/invalidation",
						draw: drawn(array(stepGen, { min: 1, max: 24 })),
						literal: Formatter.format,
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						coverage: required<Feature>(
							[
								"a stale invalidation heard before the check",
								"a stale invalidation heard after the check",
								"a real invalidation ending a source",
								"a check finding no slot"
							],
							{ cases: 400, sense: notesOnly }
						)
					},
					(steps, c) =>
						Effect.sync(() => {
							const world: {
								wal: bigint
								made: number
								slot: Option.Option<{ readonly incarnation: number; confirmed: bigint }>
							} = { wal: 0n, made: 0, slot: Option.none() }
							const all: Array<Listener> = Arr.makeBy(listeners, () => ({ kind: "idle" }))
							for (const step of steps) {
								switch (step.kind) {
									case "write":
										world.wal += 1n
										break
									case "confirm":
										if (Option.isSome(world.slot)) {
											world.slot.value.confirmed = world.wal
										}
										break
									case "drop":
										world.slot = Option.none()
										break
									case "lead": {
										if (Option.isSome(world.slot)) {
											break
										}
										const invalidation: Invalidation = {
											before: position(world.wal),
											madeBefore: world.made
										}
										for (const [at, listener] of all.entries()) {
											if (listener.kind === "listening") {
												all[at] = { ...listener, pending: [...listener.pending, invalidation] }
											}
										}
										world.wal += 1n
										world.made += 1
										world.slot = Option.some({ incarnation: world.made, confirmed: world.wal })
										break
									}
									case "listen":
										if (all[step.listener]?.kind === "idle") {
											all[step.listener] = {
												kind: "listening",
												pending: [],
												seen: { kind: "unchecked", heard: Option.none() },
												heard: [],
												incarnation: Option.none()
											}
										}
										break
									case "check": {
										const listener = all[step.listener]
										if (listener?.kind !== "listening" || listener.seen.kind !== "unchecked") {
											break
										}
										if (Option.isNone(world.slot)) {
											c.note("a check finding no slot")
											all[step.listener] = { kind: "refused" }
											break
										}
										const { incarnation, confirmed } = world.slot.value
										const turn = checkedSlot(listener.seen, position(confirmed))
										if (Arr.some(listener.heard, (h) => incarnation > h.madeBefore)) {
											c.note("a stale invalidation heard before the check")
										}
										assert.equal(
											turn.lost,
											modelLost(incarnation, listener.heard),
											`a source checked on slot ${incarnation} is lost exactly by an invalidation fanned out after it was made, of those it heard: ${Formatter.format(listener.heard)}`
										)
										all[step.listener] = turn.lost
											? { kind: "lost" }
											: { ...listener, seen: turn.seen, incarnation: Option.some(incarnation) }
										break
									}
									case "hear": {
										const listener = all[step.listener]
										if (listener?.kind !== "listening") {
											break
										}
										const [next, ...rest] = listener.pending
										if (next === undefined) {
											break
										}
										const turn = heardInvalidation(listener.seen, next.before)
										const heard = [...listener.heard, next]
										if (Option.isSome(listener.incarnation)) {
											const incarnation = listener.incarnation.value
											const expected = modelLost(incarnation, [next])
											c.note(
												expected
													? "a real invalidation ending a source"
													: "a stale invalidation heard after the check"
											)
											assert.equal(
												turn.lost,
												expected,
												`a source on slot ${incarnation} hearing an invalidation fanned out with ${next.madeBefore} slots made is lost exactly when its slot was among them`
											)
										} else {
											assert.equal(
												turn.lost,
												false,
												"an invalidation heard before the check waits for it"
											)
										}
										all[step.listener] = turn.lost
											? { kind: "lost" }
											: { ...listener, pending: rest, seen: turn.seen, heard }
										break
									}
								}
							}
						})
				)
			)
	)
})
