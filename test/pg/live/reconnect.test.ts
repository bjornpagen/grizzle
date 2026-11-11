/**
 * Reconnect: a subscription dropped at any point and called again folds to the same value as one never dropped. A
 * client that goes away and comes back holds nothing of the dropped call: the new call opens with its own reset, so its
 * fold owes nothing to the old one.
 *
 * Each case draws a live world (test/support/live/world.ts), installed as generate drafts it on a layer of one pooled
 * session (test/support/live/harness.ts), so the wire tap's gated session is the one every call runs on; one of its
 * subscriptions, in process or over HTTP, is dropped at a drawn point and called again:
 *
 * - in its first flight, after a drawn number of the server's answers have reached the driver (the tap's gate holds
 *   the rest), every point from before its first answer to after COMMIT's;
 * - right after a drawn commit returns, while its re-run may be in flight or its batch on its way;
 * - after a drawn commit has settled, its value whole.
 *
 * Properties: the dropped call sent no `ready` its flight's COMMIT had not answered; the call made again, and every
 * other subscription, sends at every `ready` the fresh read's value at some commit prefix, at prefixes that never
 * decrease, and settles at each commit after it on the fresh read's value there (test/support/live/system.ts reaches).
 *
 * The oracle is grizzle itself: a fresh `once` of the subscription's program and input after each commit.
 *
 * Plant: ready-before-commit.patch (a read's `ready` sent once its rows decode, before COMMIT's answer): a drop in the
 * first flight between its rows and COMMIT's answer finds the dropped call's `ready`.
 *
 * Features: each drop point, each surface, a drop before the first answer and one after COMMIT's, a drop with a re-run
 * in flight.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { awaitFact } from "@grizzle/testing/fact"
import { required } from "@grizzle/testing/features"
import { boolean, type Gen, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Ref } from "effect"
import { caseHang } from "#test/support/limits.ts"
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
import { type LiveBounds, liveCaseGen, readMember } from "#test/support/live/world.ts"
import { clusterPool } from "#test/support/pg.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** Where the dropped subscription is dropped: in its first flight, after a commit returns, or after one settled. */
type DropPoint = "in its first flight" | "right after a commit" | "after a commit settled"

type Feature =
	| `a drop ${DropPoint}`
	| `a subscription ${Surface} dropped`
	| "a drop before its first answer"
	| "a drop after COMMIT's answer"
	| "a drop part way through its first flight"

const bounds: LiveBounds = {
	groups: 3,
	orders: 4,
	values: 3,
	keys: 8,
	rows: 5,
	reads: 2,
	subscriptions: 3,
	commits: 4,
	writes: 2,
	window: 3
}

const cases = 24

/** A drop: its point, the subscription dropped by pick, its surface, and a pick of the answers or the commit it follows. */
interface Drop {
	readonly point: DropPoint
	readonly subscription: number
	readonly overHttp: boolean
	readonly at: number
}

const dropGen: Gen<Drop> = (source) => ({
	point: source.draw(
		weighted<DropPoint>([
			[2, () => "in its first flight"],
			[1, () => "right after a commit"],
			[1, () => "after a commit settled"]
		])
	),
	subscription: source.draw(pickGen),
	overHttp: source.draw(boolean),
	at: source.draw(pickGen)
})

/** A pool of one session: the tap gates its first session, which every call then runs on. */
const oneSession = Object.freeze({ ...clusterPool, min: 1, max: 1 })

layer(Substrate.layer)("a subscription dropped and called again", (it) => {
	it.effect(
		`folds to the value one never dropped holds, at every point it may be dropped, over ${cases} generated histories`,
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "a fresh once of the subscription's program after each commit"
						},
						suite: "pg/live/reconnect",
						draw: drawn(liveCaseGen(bounds)),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a drop in its first flight",
								"a drop right after a commit",
								"a drop after a commit settled",
								"a subscription in process dropped",
								"a subscription over HTTP dropped",
								"a drop before its first answer",
								"a drop after COMMIT's answer",
								"a drop part way through its first flight"
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
							const drop = notes.draw(dropGen)
							const live = yield* installLive(c, "live reconnect", oneSession)
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
								const mark = live.tap.mark()
								yield* surfaces.inProcess.once(readMember(s.read), inputOf(s))
								const answers = live.tap.since(mark).backend.length
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
									live.tap.gate.hold(admitted, { kind: "any" })
									const first = yield* tracked(
										dropped,
										calls.surface,
										calls.watch(readMember(s.read), inputOf(s))
									)
									if (admitted < answers) {
										yield* live.tap.gate.holding
									} else {
										yield* awaitFact(
											Effect.map(first.consumed.checkpoints, (values) =>
												Arr.isReadonlyArrayNonEmpty(values) ? Option.some(undefined) : Option.none()
											)
										)
									}
									yield* first.consumed.drop
									const sent = yield* first.consumed.checkpoints
									live.tap.gate.release()
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
						}).pipe(Effect.scoped)
				)
			)
	)
})
