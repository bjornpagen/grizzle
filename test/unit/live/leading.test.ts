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
 *   and the failure's own classification, `unavailable`, for a failure of the candidacy's. The bound is the round's
 *   own: once its candidacy has met its end and the fiber its open forked has ended (the round's scope closed), the
 *   read's subscription stands ended, so a read left waiting fails there, never by a wait.
 * - Every end gives the leadership back: the next round's registration starts a new candidacy, so the candidacies
 *   started are exactly the rounds.
 *
 * Features: a candidacy failing, one dying of a defect, one interrupted, and a candidacy started after one died.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array, element } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Deferred, Effect, Exit, Formatter, Queue, Scope, Stream } from "effect"
import { type LeaderReason } from "#adapter/live/leader.ts"
import { type Leadership, leading } from "#adapter/live/listen.ts"
import type { ChangeSource } from "#adapter/live/source.ts"
import { makeSubscriptions } from "#adapter/live/subscriptions.ts"
import {
	answer,
	type HeldCandidacy,
	type End,
	ended,
	endNotes,
	expectedKind,
	type LeadingFeature,
	read
} from "#test/support/unit/live/leading.fixtures.ts"

/**
 * The live leadership ends every waiting read with a typed error at any end of its candidacy, a defect's and an
 * interruption's too, and starts a new candidacy at the next open.
 *
 * Budget: its suite's count before the conversion (unit/live/leading: 64 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const theLiveLeadershipEndsEveryWaitingReadWithATypedErrorAtAnyEndOfItsCandidacyADefectsAndAnInterruptionsTooAndStartsANewCandidacyAtTheNextOpen =
	property.explore(array(element<End>(["failure", "defect", "interruption"]), { min: 1, max: 4 }), {
		needs: {},
		situations: [
			"a candidacy failing",
			"a candidacy dying of a defect",
			"a candidacy interrupted",
			"a candidacy started after one died"
		] satisfies ReadonlyArray<Reached<LeadingFeature>>,
		check: (_, c: Case<LeadingFeature>) => (ends) =>
			Effect.scoped(
				Effect.gen(function* () {
					const scope = yield* Effect.scope
					const leadership: Leadership = { running: false, sink: undefined }
					const started = yield* Queue.unbounded<HeldCandidacy>()
					const count = { started: 0 }
					/** The scope the current round's open forks its candidacy in, the round's own. */
					const forking: { scope: Scope.Scope } = { scope }
					const candidacy: Effect.Effect<never, LeaderReason> = Effect.suspend(() => {
						const held: HeldCandidacy = {
							end: Deferred.makeUnsafe<End>(),
							exited: Deferred.makeUnsafe<void>()
						}
						count.started += 1
						return Effect.andThen(
							Queue.offer(started, held),
							Effect.onExit(Effect.flatMap(Deferred.await(held.end), ended), () =>
								Deferred.done(held.exited, Exit.void)
							)
						)
					})
					const source: ChangeSource = {
						open: (sink) =>
							Effect.suspend(() => {
								leadership.sink = sink
								return leading(leadership, candidacy, forking.scope)
							})
					}
					const registry = yield* makeSubscriptions(source)
					for (const [round, end] of ends.entries()) {
						/**
						 * The round's scope: closed once its candidacy has met its end, which awaits the fiber the
						 * open forked, so the leadership's handling of that end has run, whatever it did.
						 */
						const roundScope = yield* Scope.fork(scope)
						forking.scope = roundScope
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
						yield* Deferred.succeed(current.end, end)
						c.note(endNotes[end])
						yield* Deferred.await(current.exited)
						yield* Scope.close(roundScope, Exit.void)
						const state = yield* live.state
						assert.equal(
							state,
							"ended",
							`once a candidacy ending by ${end} and the fiber running it have ended, the read waiting on it has ended, never left waiting`
						)
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
			),
		oracle: { kind: "specification", name: "the drawn ends of the candidacies" },
		budget: { runs: 64, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/live/listen.ts",
				original:
					"\t\t\t\tEffect.exit(\n\t\t\t\t\tEffect.onExit(run, (exit) =>\n\t\t\t\t\t\tEffect.sync(() => {\n\t\t\t\t\t\t\tleadership.running = false\n\t\t\t\t\t\t\tleadership.sink?.lost(new LeaderFailed({ reason: endedBy(exit) }))\n\t\t\t\t\t\t})\n\t\t\t\t\t)",
				replacement:
					"\t\t\t\tEffect.catch(run, (reason) =>\n\t\t\t\t\tEffect.sync(() => {\n\t\t\t\t\t\tleadership.running = false\n\t\t\t\t\t\tleadership.sink?.lost(new LeaderFailed({ reason }))\n\t\t\t\t\t})",
				why: "The leadership is given back on a failure alone, as listen.ts did, so a defect leaves the read waiting and no candidacy starts again."
			}
		]
	})
