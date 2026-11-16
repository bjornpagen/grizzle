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
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { checkedSlot, heardInvalidation } from "#adapter/live/listen.ts"
import { assert } from "#test/support/assert.ts"
import {
	type Feature,
	type Invalidation,
	type Listener,
	listeners,
	modelLost,
	position,
	stepsSpace
} from "#test/unit/live/invalidation.fixtures.ts"

/**
 * A live source's invalidation ends exactly the sources standing on a slot made before it, whenever it is heard, and
 * no source of a slot made since.
 *
 * Budget: its suite's count before the conversion (unit/live/invalidation: 400 independent cases and 96 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const aLiveSourcesInvalidationEndsExactlyTheSourcesStandingOnASlotMadeBeforeItWheneverItIsHeardAndNoSourceOfASlotMadeSince =
	property.explore(stepsSpace, {
		needs: {},
		situations: [
			"a stale invalidation heard before the check",
			"a stale invalidation heard after the check",
			"a real invalidation ending a source",
			"a check finding no slot"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (steps) =>
			Effect.sync(() => {
				const world: {
					wal: bigint
					made: number
					slot: Option.Option<{ readonly incarnation: number; confirmed: bigint }>
				} = { wal: 0n, made: 0, slot: Option.none() }
				const all: Array<Listener> = Array.from({ length: listeners }, (): Listener => ({
					kind: "idle"
				}))
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
			}),
		oracle: {
			kind: "specification",
			name: "the model's record of which slot was made when"
		},
		budget: { runs: 400, steered: 96 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/live/listen.ts",
				original:
					"const invalidates = (before: WalPosition, at: WalPosition): boolean => at <= before",
				replacement:
					"const invalidates = (_before: WalPosition, _at: WalPosition): boolean => true",
				why: "Every invalidation names every slot, as before invalidations carried a position, so a stale invalidation ends a newer slot's source."
			}
		]
	})
