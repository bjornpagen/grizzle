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
 * the subscriptions run beside it.
 *
 * Property: after each commit, every subscription reaches a `ready` whose value is the fresh read's after that commit
 * (live/keyed.ts values compared by their decoded rows, test/support/live/values.ts), and every `ready` it ever sends
 * holds the fresh read's value at some commit prefix, at prefixes that never decrease; no subscription ends.
 *
 * The oracle is grizzle itself: a fresh `once` of the subscription's program and input after each commit, run before
 * the next commit, so it reads exactly that prefix.
 *
 * Plants (~/.cache/grizzle-release/LIVE-TESTS/plants): dropped-remove.patch (a diff sends no remove, so a row its value
 * lost stays folded in); source-missing-publication.patch and source-identity-too-narrow.patch (a footprint table left
 * out of the publication, or its replica identity too narrow for its routing column: a subscription waits on that
 * table's writes forever, which the hang guard reports; the routing suite fails it at once).
 *
 * Features: each commit situation of world.ts (a write outside its routing values and inside them, a delete of a row it
 * holds, a row removed from its value, a move in an ordered read, a write in a window's neighbourhood, a commit of no
 * relation it reads), each read shape, each writer, each surface.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { caseHang } from "#test/support/limits.ts"
import { commitLive, inputOf, worldSurfaces } from "#test/support/live/calls.ts"
import { installLive } from "#test/support/live/harness.ts"
import {
	Inexact,
	type LiveValue,
	reaches,
	type Surface,
	tracked
} from "#test/support/live/system.ts"
import {
	type CommitSituation,
	type LiveBounds,
	liveCaseGen,
	type ReadKind,
	readMember,
	situationsOf,
	statesOf
} from "#test/support/live/world.ts"
import { clusterPool } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

type Feature =
	| CommitSituation
	| `a ${ReadKind} read`
	| "a direct writer's commit"
	| "a grizzle call's commit"
	| `a subscription ${Surface}`

const bounds: LiveBounds = {
	groups: 3,
	orders: 4,
	values: 3,
	keys: 8,
	rows: 5,
	reads: 3,
	subscriptions: 4,
	commits: 5,
	writes: 3,
	window: 3
}

const cases = 24

layer(Substrate.layer)("a live subscription", (it) => {
	it.effect(
		`folds, at every ready, to a fresh read at some commit prefix, and to the last one's at quiescence, over ${cases} generated histories`,
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "a fresh once of the subscription's program after each commit"
						},
						suite: "pg/live/exactness",
						draw: drawn(liveCaseGen(bounds)),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
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
							],
							{ cases: 48, sense: notesOnly }
						),
						kept: [],
						runs: cases,
						shrink: { kind: "bounded", candidates: 60 },
						concurrency: 1,
						steerEvery: 8,
						caseHang
					},
					(c, notes) =>
						Effect.gen(function* () {
							const live = yield* installLive(c, "live_exactness", clusterPool)
							const overHttp = notes.draw(
								array(boolean, { min: c.subscriptions.length, max: c.subscriptions.length })
							)
							yield* Effect.gen(function* () {
								const surfaces = yield* worldSurfaces(live)
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
										commit.writer === "psql"
											? "a direct writer's commit"
											: "a grizzle call's commit"
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
						}).pipe(Effect.scoped)
				)
			)
	)
})
