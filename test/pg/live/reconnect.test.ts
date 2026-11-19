/**
 * Reconnect: a subscription dropped at any point and called again folds to the same value as one never dropped. A
 * client that goes away and comes back holds nothing of the dropped call: the new call opens with its own reset, so its
 * fold owes nothing to the old one.
 *
 * Each case draws a live world (test/support/live/world.ts), installed as generate drafts it on a layer of one pooled
 * session (test/support/live/harness.ts), every session through one wire tap; one of its subscriptions, in process or
 * over HTTP, is dropped at a drawn point and called again:
 *
 * - in its first flight, after a drawn number of the server's answers have reached the driver: the tap gates the
 *   session that flight runs on, named by its first message (test/support/wire-tap.ts Tap.flight), a session of the
 *   login, never the listener's or the leader's nor the session that connected first, and holds the rest; every point
 *   from before its first answer to after COMMIT's. The drop reaches the call first, then the gate opens: an
 *   interrupted flight cancels and waits for the server's answer (test/pg/adapter/interrupt.test.ts), which the gate
 *   would hold for ever;
 * - right after a drawn commit returns, while its re-run may be in flight or its batch on its way;
 * - after a drawn commit has settled, its value whole.
 *
 * Properties: the gate held the dropped call's own flight, the session it named first sending what the read's steady
 * flight sends first, and no ready passing it; the dropped call sent no `ready` its flight's COMMIT had not answered;
 * the call made again, and every
 * other subscription, sends at every `ready` the fresh read's value at some commit prefix, at prefixes that never
 * decrease, and settles at each commit after it on the fresh read's value there (test/support/live/system.ts reaches).
 * A drop interrupts its call, which never fails it, so a `ready` sent on a COMMIT refused or lost is
 * test/unit/live/flights.test.ts's.
 *
 * The installation is fresh, so its live source stands only once the leader its first registration starts has made the
 * replication slot: a call made before then is refused `unavailable` (SlotAbsent) before any flight, and called again,
 * as a call's contract asks (test/support/live/system.ts consume), so the first flight a drop gates is the flight of
 * the call that registers.
 *
 * The oracle is grizzle itself: a fresh `once` of the subscription's program and input after each commit.
 *
 * Features: each drop point, each surface, a drop before the first answer and one after COMMIT's, a drop with a re-run
 * in flight, a call refused before the slot stood.
 */

import { awaitFact } from "@bjornpagen/testing/fact"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Fiber, Formatter, Option, Ref } from "effect"
import {
	bounds,
	cases,
	dropGen,
	type DropPoint,
	type Feature,
	type FirstFlight,
	oneSession,
	sameMessage
} from "#test/pg/live/reconnect.fixtures.ts"
import { commitLive, inputOf, worldSurfaces } from "#test/support/live/calls.ts"
import { installLive } from "#test/support/live/harness.ts"
import {
	Inexact,
	type LiveValue,
	reaches,
	type Surface,
	type Tracked,
	tracked
} from "#test/support/live/system.ts"
import { liveCaseGen, readMember } from "#test/support/live/world.ts"
import { pickIndex } from "#test/support/pick.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A subscription dropped and called again folds to the value one never dropped holds, at every point it may be dropped, over ${cases} generated histories.
 *
 * Its pre-conversion budget: runs cases, coverage cases 48 (test/pg/live/reconnect.test.ts at d8eed1786).
 */
export const aSubscriptionDroppedAndCalledAgainFoldsToTheValueOneNeverDroppedHoldsAtEveryPointItMayBeDroppedOverCasesGeneratedHistories =
	property.explore(liveCaseGen(bounds), {
		needs: { substrate: Substrate.installing },
		situations: [
			"a drop in its first flight",
			"a drop right after a commit",
			"a drop after a commit settled",
			"a subscription in process dropped",
			"a subscription over HTTP dropped",
			"a drop before its first answer",
			"a drop after COMMIT's answer",
			"a drop part way through its first flight",
			"a call refused before the slot stood"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate }, notes: Case<Feature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const drop = notes.draw(dropGen)
						const live = yield* installLive(c, "live_reconnect", oneSession)
						/** The login's role, whose pooled session runs every flight a drop gates. */
						const login = live.installed.as(live.world.server).role
						yield* Effect.gen(function* () {
							const surfaces = yield* worldSurfaces(live)
							const dropped = pickIndex(drop.subscription, c.subscriptions.length)
							const s = Arr.getUnsafe(c.subscriptions, dropped)
							const calls = drop.overHttp ? surfaces.http : surfaces.inProcess
							notes.note(`a subscription ${calls.surface} dropped`)
							const fresh: Array<ReadonlyArray<LiveValue>> = []
							const freshAt = () =>
								Effect.forEach(c.subscriptions, (sub) =>
									surfaces.inProcess.once(readMember(sub.read), inputOf(sub))
								)
							const values = yield* freshAt()
							fresh.push(values)
							/** The answers a steady first flight of the dropped read gets: its second's, its statement parsed. */
							const steady = live.tap.flight(login, { kind: "through" })
							yield* surfaces.inProcess.once(readMember(s.read), inputOf(s))
							const steadyFlight = yield* steady.window
							const answers = steadyFlight.backend.length
							const running = yield* Ref.make<ReadonlyArray<Tracked>>([])
							const track = (place: number, surface: Surface) =>
								Effect.gen(function* () {
									const sub = Arr.getUnsafe(c.subscriptions, place)
									const next = yield* tracked(
										place,
										surface,
										(surface === "over HTTP" ? surfaces.http : surfaces.inProcess).watch(
											readMember(sub.read),
											inputOf(sub)
										)
									)
									yield* Ref.update(running, (all) => [...all, next])
								})
							if (drop.point === "in its first flight") {
								notes.note("a drop in its first flight")
								const admitted = pickIndex(drop.at, answers + 1)
								notes.note(
									admitted === 0
										? "a drop before its first answer"
										: admitted === answers
											? "a drop after COMMIT's answer"
											: "a drop part way through its first flight"
								)
								const flight = live.tap.flight(login, {
									kind: "after",
									count: admitted,
									of: { kind: "any" }
								})
								const first = yield* tracked(
									dropped,
									calls.surface,
									calls.watch(readMember(s.read), inputOf(s))
								)
								/** The call's first ready, or its end: what it comes to unless the gate holds it first. */
								const answered = awaitFact(
									Effect.gen(function* () {
										const standing = yield* first.consumed.standing
										if (standing.kind === "ended") {
											return Option.some<FirstFlight>({ kind: "ended", error: standing.error })
										}
										const values = yield* first.consumed.checkpoints
										return Arr.isReadonlyArrayNonEmpty(values)
											? Option.some<FirstFlight>({ kind: "readied" })
											: Option.none()
									})
								)
								const stopped =
									admitted < answers
										? yield* Effect.raceFirst(
												Effect.as(flight.holding, { kind: "held" } as const),
												answered
											)
										: yield* answered
								if (stopped.kind === "ended") {
									flight.release()
									return yield* new Inexact({
										report: `the dropped call ended before its first flight: ${Formatter.format(stopped.error)}`
									})
								}
								const gated = yield* flight.window
								/**
								 * The drop reaches the call before the gate lets anything more through: the fork starts at once. An
								 * interrupted flight cancels and waits for the server's answer (interrupt.test.ts), which the gate
								 * holds, so the gate opens while the drop waits, as a client that goes away leaves the server's
								 * answers to arrive behind it.
								 */
								const dropping = yield* Effect.forkChild(first.consumed.drop, {
									startImmediately: true
								})
								flight.release()
								yield* Fiber.join(dropping)
								if (
									(admitted < answers && stopped.kind === "readied") ||
									!sameMessage(gated.frontend[0], steadyFlight.frontend[0])
								) {
									return yield* new Inexact({
										report: `the gate held no flight of the dropped call: ${stopped.kind} after ${admitted} of ${answers} answers, the gated session's first message ${Formatter.format(gated.frontend[0])}, the read's flight's ${Formatter.format(steadyFlight.frontend[0])}`
									})
								}
								const sent = yield* first.consumed.checkpoints
								if ((yield* first.consumed.refused) > 0) {
									notes.note("a call refused before the slot stood")
								}
								if (admitted < answers && Arr.isReadonlyArrayNonEmpty(sent)) {
									return yield* new Inexact({
										report: `the dropped call sent a ready its flight's COMMIT had not answered: ${admitted} of ${answers} answers had reached the driver`
									})
								}
							}
							for (const [place] of c.subscriptions.entries()) {
								yield* track(place, place === dropped ? calls.surface : "in process")
							}
							const dropAt = pickIndex(drop.at, Math.max(1, c.history.length))
							const settle = (prefix: number) =>
								Effect.gen(function* () {
									for (const r of yield* Ref.get(running)) {
										yield* reaches(
											r,
											Arr.map(fresh, (values) => Arr.getUnsafe(values, r.place)),
											Arr.getUnsafe(Arr.getUnsafe(fresh, prefix), r.place),
											`subscription ${r.place} (${r.surface}) at prefix ${prefix}`
										)
									}
								})
							yield* settle(0)
							for (const r of yield* Ref.get(running)) {
								if ((yield* r.consumed.refused) > 0) {
									notes.note("a call refused before the slot stood")
								}
							}
							for (const [k, commit] of c.history.entries()) {
								yield* commitLive(live, surfaces.inProcess, commit)
								const dropNow = (point: DropPoint) =>
									drop.point === point && dropAt === k
										? Effect.gen(function* () {
												notes.note(`a drop ${point}`)
												const all = yield* Ref.get(running)
												const target = Arr.findFirst(all, (r) => r.place === dropped)
												if (Option.isSome(target)) {
													yield* target.value.consumed.drop
													yield* Ref.set(
														running,
														Arr.filter(all, (r) => r !== target.value)
													)
												}
												yield* track(dropped, calls.surface)
											})
										: Effect.void
								yield* dropNow("right after a commit")
								const values = yield* freshAt()
								fresh.push(values)
								yield* settle(k + 1)
								yield* dropNow("after a commit settled")
							}
						}).pipe(
							withLayer(live.layer),
							Effect.mapError(
								(e) =>
									new Inexact({
										report: `${e instanceof Inexact ? e.report : Formatter.format(e)}\n${Formatter.format(c)}\n${Formatter.format(drop)}`
									})
							)
						)
					}).pipe(Effect.scoped),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "a fresh once of the subscription's program after each commit"
		},
		budget: { runs: cases, steered: 48 },
		kept: [],
		kills: []
	})
