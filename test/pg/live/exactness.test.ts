/**
 * Live exactness, the end-to-end property the live machinery exists for: over generated write histories, a
 * subscription's folded value equals a fresh read of its program at the commit prefix it stands at, at every `ready`
 * it sends, and once the history ends and it quiesces, the fresh read after the last commit.
 *
 * Each case draws a live world (test/support/live/world.ts): two relations, mutable or not, reads of every shape the
 * live machinery routes and diffs differently (a keyed set, a wide one, a count, an ordered list, a take's window, a
 * page's window from each anchor, a join), subscriptions to them, each in process (a Db's watch) or over HTTP (the
 * handler through the client and its fold), and a history of commits, each a grizzle call of one write member or a
 * SERIALIZABLE transaction of a direct SQL writer of several writes. It is installed as generate drafts it, its live
 * source among its objects (test/support/live/harness.ts), and every commit runs after the last one returned, while
 * the subscriptions run beside it. Its live source is made to stand first: the first subscription's watch answers once
 * the leader has made the slot (test/support/live/standing.ts standingOn).
 *
 * Property: after each commit, every subscription reaches a `ready` whose value is the fresh read's after that commit
 * (live/keyed.ts values compared by their decoded rows, test/support/live/values.ts), and every `ready` it ever sends
 * holds the fresh read's value at some commit prefix, at prefixes that never decrease; no subscription ends.
 *
 * The oracle is grizzle itself: a fresh `once` of the subscription's program and input after each commit, run before
 * the next commit, so it reads exactly that prefix.
 *
 * A footprint table the publication leaves out, or whose replica identity cannot carry its routing column, leaves a
 * subscription here waiting for ever; test/pg/live/source.test.ts and routing.test.ts hold the live source to its
 * tables, and fail at once. So does a diff that drops a change, a stale value never reaching the fresh read's;
 * test/unit/live/values.test.ts holds the diff to the least changes that carry one value to the other.
 *
 * Features: each commit situation of world.ts (a write outside its routing values and inside them, a delete of a row it
 * holds, a row removed from its value, a move in an ordered read, a write in a window's neighbourhood, a commit of no
 * relation it reads), each read shape, each writer, each surface.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { array, boolean } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { bounds, cases, type Feature } from "#test/pg/live/exactness.fixtures.ts"
import { commitLive, inputOf, worldSurfaces } from "#test/support/live/calls.ts"
import { installLive } from "#test/support/live/harness.ts"
import { standingOn } from "#test/support/live/standing.ts"
import { Inexact, type LiveValue, reaches, tracked } from "#test/support/live/system.ts"
import { liveCaseGen, readMember, situationsOf, statesOf } from "#test/support/live/world.ts"
import { clusterPool } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A live subscription folds, at every ready, to a fresh read at some commit prefix, and to the last one's at quiescence, over ${cases} generated histories.
 *
 * Its pre-conversion budget: runs cases, coverage cases 48 (test/pg/live/exactness.test.ts at d8eed1786).
 */
export const aLiveSubscriptionFoldsAtEveryReadyToAFreshReadAtSomeCommitPrefixAndToTheLastOnesAtQuiescenceOverCasesGeneratedHistories =
	property.explore(liveCaseGen(bounds), {
		needs: { substrate: Substrate.installing },
		situations: [
			"a write outside its routing values",
			"a write inside its routing values",
			"a delete of a row it holds",
			"a row removed from its value",
			"a move in an ordered read",
			"a write in a window's neighbourhood",
			"a direct writer's commit",
			"a grizzle call's commit",
			"a subscription in process",
			"a subscription over HTTP"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate }, notes: Case<Feature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const live = yield* installLive(c, "live_exactness", clusterPool)
						const overHttp = notes.draw(
							array(boolean, { min: c.subscriptions.length, max: c.subscriptions.length })
						)
						yield* Effect.gen(function* () {
							const surfaces = yield* worldSurfaces(live)
							for (const s of Arr.take(c.subscriptions, 1)) {
								yield* standingOn(surfaces.inProcess, readMember(s.read), inputOf(s))
							}
							const states = statesOf(c)
							const freshAt = () =>
								Effect.forEach(c.subscriptions, (s) =>
									surfaces.inProcess.once(readMember(s.read), inputOf(s))
								)
							const first = yield* freshAt()
							const fresh: Array<ReadonlyArray<LiveValue>> = [first]
							const running = yield* Effect.forEach(c.subscriptions, (s, place) =>
								Effect.gen(function* () {
									const calls = overHttp[place] === true ? surfaces.http : surfaces.inProcess
									notes.note(`a subscription ${calls.surface}`)
									notes.note(`a ${Arr.getUnsafe(c.reads, s.read).kind} read`)
									return yield* tracked(
										place,
										calls.surface,
										calls.watch(readMember(s.read), inputOf(s))
									)
								})
							)
							const settle = (prefix: number) =>
								Effect.forEach(running, (r) =>
									reaches(
										r,
										Arr.map(fresh, (values) => Arr.getUnsafe(values, r.place)),
										Arr.getUnsafe(Arr.getUnsafe(fresh, prefix), r.place),
										`subscription ${r.place} (${r.surface}, ${Formatter.format(Arr.getUnsafe(c.subscriptions, r.place))}) at prefix ${prefix}`
									)
								)
							yield* settle(0)
							for (const [k, commit] of c.history.entries()) {
								notes.note(
									commit.writer === "psql" ? "a direct writer's commit" : "a grizzle call's commit"
								)
								yield* commitLive(live, surfaces.inProcess, commit)
								const values = yield* freshAt()
								fresh.push(values)
								for (const s of c.subscriptions) {
									notes.noteAll(
										situationsOf(
											c,
											s,
											commit,
											Arr.getUnsafe(states, k),
											Arr.getUnsafe(states, k + 1)
										)
									)
								}
								yield* settle(k + 1)
							}
						}).pipe(
							withLayer(live.layer),
							Effect.mapError(
								(e) =>
									new Inexact({
										report: `${e instanceof Inexact ? e.report : Formatter.format(e)}\n${Formatter.format(c)}`
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
