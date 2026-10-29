import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option, Ref, String as Str } from "effect"
import {
	type Case,
	type CaseDiscarded,
	drawn,
	type Exhaustion,
	type Exploration,
	exhaust,
	explore,
	Run
} from "#explore.ts"
import {
	type Features,
	features,
	noFeatures,
	residualOf,
	tallyOf,
	withReachMargin
} from "#features.ts"
import { array, boolean, constant, element, filter, type Gen, int } from "#gen.ts"
import { agree, by, equivalence, exact, multiset, ordered, set } from "#oracle.ts"
import type { Replay, ReplayCase } from "#replay.ts"
import { boundedShrink, completeShrink } from "#shrink.ts"
import { tokenOf } from "#tape.ts"
import { searched } from "#vitest/searched.ts"

/** A run with a given seed, replaying what it is asked to. */
const runOf = (seed: number, replay: Option.Option<Replay>) =>
	Run.of({ seed, source: "environment", replay, fuzz: Option.none() })

const fullRun = runOf(7, Option.none())

/** This suite's budget for a search: every field stated, as every suite states its own. */
const searchOf = <A, F extends string>(
	suite: string,
	generator: Gen<A>,
	required: Features<F>,
	runs: number,
	concurrency: number
): Exploration<A, A, F> => ({
	suite,
	draw: drawn(generator),
	literal: Formatter.format,
	features: required,
	kept: [],
	runs,
	shrink: boundedShrink(500),
	concurrency,
	steerEvery: 16,
	steering: { kind: "none" },
	caseHang: Duration.minutes(1)
})

type Size = "small" | "big"

/** Notes each value's size: big past a thousand, which `int(0, 9)` never draws. */
const noteSize = (value: number, c: Readonly<{ note: (feature: Size) => void }>) =>
	Effect.sync(() => c.note(value > 1000 ? "big" : "small"))

describe("explore", () => {
	it.effect(
		"runs the floor stream and the rotating stream, and estimates from the rotating one alone",
		() =>
			Effect.gen(function* () {
				const explored = yield* explore(
					searchOf("passes", int(0, 9), noFeatures, 40, 4),
					() => Effect.void
				)
				strictEqual(explored.cases, 50)
				strictEqual(explored.residual.cases, 40)
			}).pipe(Effect.provideService(Run, fullRun))
	)

	it.effect("finds and reports the same case however many cases run at once", () =>
		Effect.gen(function* () {
			const failing = (value: number) => (value % 97 === 13 ? Effect.die("rare") : Effect.void)
			const failures = yield* Effect.forEach([1, 4, 16, 64], (concurrency) =>
				Effect.flip(
					explore(searchOf("concurrent", int(0, 100_000), noFeatures, 300, concurrency), failing)
				)
			)
			const [first, ...rest] = failures
			for (const failure of rest) {
				deepStrictEqual(failure, first)
			}
		}).pipe(Effect.provideService(Run, fullRun))
	)

	it.effect("shrinks a failing case, and replaying it fails again as the same case", () =>
		Effect.gen(function* () {
			const spec = searchOf("threshold", int(0, 1000), noFeatures, 100, 4)
			const property = (value: number) => (value >= 300 ? Effect.die("too big") : Effect.void)
			const failed = yield* Effect.flip(explore(spec, property))
			const replayed = Option.getOrThrow(
				failed._tag === "PropertyFalsified" ? failed.replay : Option.none()
			)
			const again = yield* Effect.flip(
				explore(spec, property).pipe(
					Effect.provideService(Run, runOf(7, Option.some({ suite: "threshold", replayed })))
				)
			)
			deepStrictEqual(
				again._tag === "PropertyFalsified" ? again.replay : Option.none(),
				Option.some(replayed)
			)
		}).pipe(Effect.provideService(Run, fullRun))
	)

	it.effect("shrinks the property's own draws with the case", () =>
		Effect.gen(function* () {
			const failed = yield* Effect.flip(
				explore(searchOf("draws", constant("case"), noFeatures, 100, 4), (_value, c) =>
					c.draw(int(0, 1000)) >= 300 ? Effect.die("drew too much") : Effect.void
				)
			)
			deepStrictEqual(
				Option.map(
					failed._tag === "PropertyFalsified" ? failed.replay : Option.none(),
					(replayed) => replayed.values
				),
				Option.some([300])
			)
		}).pipe(Effect.provideService(Run, fullRun))
	)

	it.effect("replays a failure a steered case found under the steering it was drawn under", () =>
		Effect.gen(function* () {
			const spec = searchOf("steered failure", constant("case"), features<"rare">(["rare"]), 100, 4)
			const property = (_sketch: string, c: Case<"rare">) =>
				Option.exists(c.steering, (pending) => pending.has("rare")) && c.draw(int(0, 1000)) >= 300
					? Effect.die("aimed too high")
					: Effect.void
			const replayAs = (replayed: ReplayCase) =>
				Effect.flip(
					explore(spec, property).pipe(
						Effect.provideService(
							Run,
							runOf(7, Option.some({ suite: "steered failure", replayed }))
						)
					)
				)
			const failed = yield* Effect.flip(explore(spec, property))
			const replayed = Option.getOrThrow(
				failed._tag === "PropertyFalsified" ? failed.replay : Option.none()
			)
			const again = yield* replayAs(replayed)
			const unsteered = yield* replayAs({ drawn: { kind: "unsteered" }, values: replayed.values })
			deepStrictEqual(
				[
					replayed.drawn,
					again._tag === "PropertyFalsified" ? again.replay : Option.none(),
					unsteered._tag
				],
				[{ kind: "steered", pending: [0] }, Option.some(replayed), "ReplayStale"]
			)
		}).pipe(Effect.provideService(Run, fullRun))
	)

	it.effect("refuses a replay that no longer runs as its token says, and never passes it", () =>
		Effect.gen(function* () {
			const staleBy = (
				replayed: ReplayCase,
				property: (sketch: string, c: Case<"rare">) => Effect.Effect<void, CaseDiscarded>
			) =>
				Effect.flip(
					explore(
						searchOf("stale replay", constant("case"), features<"rare">(["rare"]), 10, 1),
						property
					).pipe(
						Effect.provideService(Run, runOf(7, Option.some({ suite: "stale replay", replayed })))
					)
				)
			const draws = (_sketch: string, c: Case<"rare">) =>
				Effect.sync(() => {
					c.draw(int(0, 9))
				})
			const undeclared = yield* staleBy(
				{ drawn: { kind: "steered", pending: [1] }, values: [3] },
				draws
			)
			const leftOver = yield* staleBy({ drawn: { kind: "unsteered" }, values: [3, 4] }, draws)
			const ranOut = yield* staleBy({ drawn: { kind: "unsteered" }, values: [] }, draws)
			const gaveUp = yield* staleBy({ drawn: { kind: "unsteered" }, values: [] }, (_sketch, c) =>
				c.assume(false)
			)
			deepStrictEqual(
				Arr.map([undeclared, leftOver, ranOut, gaveUp], (failure) => failure._tag),
				["ReplayStale", "ReplayStale", "ReplayStale", "ReplayStale"]
			)
		}).pipe(Effect.provideService(Run, fullRun))
	)

	it.effect("fails when no generated case reaches a required situation", () =>
		Effect.gen(function* () {
			const failed = yield* Effect.flip(
				explore(
					searchOf("unreached", int(0, 9), features<Size>(["small", "big"]), 100, 4),
					noteSize
				)
			)
			deepStrictEqual(failed._tag === "FeaturesUnreached" ? failed.missing : [], ["big"])
		}).pipe(Effect.provideService(Run, fullRun))
	)

	it.effect("never lets a kept case satisfy a required situation", () =>
		Effect.gen(function* () {
			const failed = yield* Effect.flip(
				explore(
					{
						...searchOf("kept-only", int(0, 9), features<Size>(["big"]), 100, 4),
						kept: [{ note: "the only big one", sketch: 5000, draws: "", reaches: ["big"] }]
					},
					noteSize
				)
			)
			deepStrictEqual(failed._tag === "FeaturesUnreached" ? failed.missing : [], ["big"])
		}).pipe(Effect.provideService(Run, fullRun))
	)

	it.effect("fails a kept case that no longer reaches what it names", () =>
		Effect.gen(function* () {
			const failed = yield* Effect.flip(
				explore(
					{
						...searchOf("drifted", int(0, 9), features<Size>([]), 100, 4),
						kept: [{ note: "once big", sketch: 3, draws: "", reaches: ["big"] }]
					},
					noteSize
				)
			)
			deepStrictEqual(failed._tag === "KeptUnreached" ? failed.missing : [], ["big"])
		}).pipe(Effect.provideService(Run, fullRun))
	)

	it.effect("stops a hanging case on the live clock, even under a TestClock", () =>
		Effect.gen(function* () {
			const failed = yield* Effect.flip(
				explore(
					{ ...searchOf("hangs", int(0, 9), noFeatures, 100, 4), caseHang: Duration.millis(20) },
					() => Effect.never
				)
			)
			strictEqual(failed._tag, "CaseHung")
		}).pipe(Effect.provideService(Run, fullRun))
	)

	it.effect(
		"runs a hung case's cleanup before it reports the hang, and never waits on cleanup that cannot end",
		() =>
			Effect.gen(function* () {
				const cleaned = yield* Ref.make(false)
				const released = yield* Effect.flip(
					explore(
						{
							...searchOf("cleanup ends", int(0, 9), noFeatures, 100, 4),
							caseHang: Duration.millis(20)
						},
						() =>
							Effect.andThen(
								Effect.addFinalizer(() => Effect.andThen(Effect.yieldNow, Ref.set(cleaned, true))),
								Effect.never
							)
					)
				)
				strictEqual(released._tag, "CaseHung")
				strictEqual(
					yield* Ref.get(cleaned),
					true,
					"the hung case's lease went back before the hang was reported"
				)
				const frozen = yield* Effect.flip(
					explore(
						{
							...searchOf("cleanup frozen", int(0, 9), noFeatures, 100, 4),
							caseHang: Duration.millis(20)
						},
						() =>
							Effect.andThen(
								Effect.addFinalizer(() => Effect.never),
								Effect.never
							)
					)
				)
				strictEqual(frozen._tag, "CaseHung")
			}).pipe(Effect.provideService(Run, fullRun))
	)

	it.effect("fails a case its property used after the case ended, by a note or a draw", () =>
		Effect.gen(function* () {
			const lateBy = (use: (earlier: Case<"late">) => void) =>
				Effect.suspend(() => {
					const ended: Array<Case<"late">> = []
					return Effect.flip(
						explore(searchOf("late use", int(0, 9), features<"late">([]), 40, 1), (_value, c) =>
							Effect.sync(() => {
								Arr.forEach(ended, use)
								ended.push(c)
							})
						)
					)
				})
			const noted = yield* lateBy((earlier) => earlier.note("late"))
			const drew = yield* lateBy((earlier) => {
				earlier.draw(int(0, 9))
			})
			deepStrictEqual([noted._tag, drew._tag], ["CaseMisused", "CaseMisused"])
		}).pipe(Effect.provideService(Run, fullRun))
	)

	it.effect("stalls when the generator rarely meets the property's precondition", () =>
		Effect.gen(function* () {
			const failed = yield* Effect.flip(
				explore(searchOf("stalls", int(0, 9), noFeatures, 100, 4), (_value, c) => c.assume(false))
			)
			strictEqual(failed._tag, "CasesStalled")
		}).pipe(Effect.provideService(Run, fullRun))
	)
})

describe("exhaust", () => {
	const pairs: Exhaustion<readonly [number, number], never> = {
		suite: "pairs",
		generator: (source) => [source.draw(int(0, 2)), source.draw(int(0, 1))] as const,
		literal: Formatter.format,
		limit: 6,
		features: noFeatures,
		caseHang: Duration.seconds(10)
	}

	it.effect("checks every case of its space", () =>
		Effect.gen(function* () {
			strictEqual((yield* exhaust(pairs, () => Effect.void)).cases, 6)
		}).pipe(Effect.provideService(Run, fullRun))
	)

	it.effect("counts only the cases a filter keeps, so a space its limit holds runs whole", () =>
		Effect.gen(function* () {
			const kept = yield* exhaust(
				{
					suite: "filtered",
					generator: filter(int(0, 11), (n) => n < 10, 1),
					literal: String,
					limit: 10,
					features: noFeatures,
					caseHang: Duration.seconds(10)
				},
				() => Effect.void
			)
			strictEqual(kept.cases, 10)
		}).pipe(Effect.provideService(Run, fullRun))
	)

	it.effect("refuses a space beyond its limit before any case runs", () =>
		Effect.gen(function* () {
			let ran = 0
			const failed = yield* Effect.flip(
				exhaust({ ...pairs, limit: 5 }, () =>
					Effect.sync(() => {
						ran += 1
					})
				)
			)
			strictEqual(failed._tag, "SpaceBeyondLimit")
			strictEqual(ran, 0)
		}).pipe(Effect.provideService(Run, fullRun))
	)

	it.effect("enumerates the property's own draws too", () =>
		Effect.gen(function* () {
			const flags: Exhaustion<boolean, never> = {
				suite: "flags",
				generator: boolean,
				literal: Formatter.format,
				limit: 10,
				features: noFeatures,
				caseHang: Duration.seconds(10)
			}
			const exhausted = yield* exhaust(flags, (_flag, c) => Effect.sync(() => c.draw(int(0, 2))))
			strictEqual(exhausted.cases, 6)
		}).pipe(Effect.provideService(Run, fullRun))
	)

	it.effect("fails on the smallest failing case, with nothing to replay", () =>
		Effect.gen(function* () {
			const failed = yield* Effect.flip(
				exhaust(pairs, ([first, second]) => (first + second >= 2 ? Effect.die("sum") : Effect.void))
			)
			deepStrictEqual(
				[failed._tag, failed._tag === "PropertyFalsified" ? failed.replay : Option.none()],
				["PropertyFalsified", Option.none()]
			)
		}).pipe(Effect.provideService(Run, fullRun))
	)
})

/** The situations a residual test's cases note. */
const SITUATIONS = ["a", "b", "c", "d", "e"] as const

describe("the residual", () => {
	it.effect(
		"counts each situation once per case that noted it, and estimates from those seen once and twice",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "the residual",
						draw: drawn(array(array(element(SITUATIONS), { min: 0, max: 3 }), { min: 0, max: 12 })),
						literal: Formatter.format,
						features: noFeatures,
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 200,
						steering: { kind: "none" },
						caseHang: Duration.seconds(30)
					},
					(cases) =>
						Effect.sync(() => {
							const tally = tallyOf("independent")
							for (const notes of cases) {
								tally.add(new Set(notes))
							}
							const counts = Arr.map(
								Arr.dedupe(Arr.flatten(cases)),
								(situation) => Arr.filter(cases, (notes) => Arr.contains(notes, situation)).length
							)
							const singletons = Arr.filter(counts, (count) => count === 1).length
							const doubletons = Arr.filter(counts, (count) => count === 2).length
							const n = cases.length
							deepStrictEqual(residualOf(tally.tally()), {
								cases: n,
								observed: counts.length,
								singletons,
								doubletons,
								risk: n === 0 ? Option.none() : Option.some(singletons / n),
								unseen:
									n === 0
										? Option.none()
										: Option.some(
												doubletons > 0
													? (singletons * singletons) / (2 * doubletons)
													: (singletons * (singletons - 1)) / 2
											)
							})
						})
				)
			)
	)
})

describe("agree", () => {
	it.effect("agrees on what the equivalence promises, and names the difference otherwise", () =>
		Effect.gen(function* () {
			yield* agree(
				[
					["model", [1, 2, 2]],
					["system", [2, 1, 2]]
				],
				multiset(exact)
			)
			yield* agree(
				[
					["model", [1, 2]],
					["system", [2, 2, 1]]
				],
				set(exact)
			)
			yield* agree(
				[
					["model", { id: 1, at: "now" }],
					["system", { id: 1, at: "later" }]
				],
				by((row: { id: number; at: string }) => row.id, exact)
			)
			yield* agree(
				[
					["model", 4],
					["system", 4.000_000_1]
				],
				equivalence((left: number, right: number) => Math.abs(left - right) < 1e-3, String)
			)
			const ordering = yield* Effect.flip(
				agree(
					[
						["model", [1, 2]],
						["system", [2, 1]]
					],
					ordered(exact)
				)
			)
			deepStrictEqual([ordering.first, ordering.second], ["model", "system"])
		})
	)
})

/** Fails when the property's own draw is 990 or more, whatever the sketch: a failure only the draw explains. */
const rareDraw = (_sketch: number, c: Case<"drew">) =>
	Effect.gen(function* () {
		c.note("drew")
		if (c.draw(int(0, 1000)) >= 990) {
			return yield* Effect.die("a rare draw")
		}
	})

describe("a kept case", () => {
	it.effect("replays the draws its property made, and prints them with the failure", () =>
		Effect.gen(function* () {
			const draws = tokenOf(Float64Array.of(990), 1)
			const failed = yield* Effect.flip(
				explore(
					{
						...searchOf("kept draws", int(0, 9), features<"drew">([]), 10, 1),
						kept: [{ note: "a rare draw", sketch: 0, draws, reaches: ["drew"] }]
					},
					rareDraw
				)
			)
			deepStrictEqual(
				[
					failed._tag,
					failed._tag === "PropertyFalsified" && Str.includes(`draws: "${draws}"`)(failed.message)
				],
				["PropertyFalsified", true]
			)
		}).pipe(Effect.provideService(Run, fullRun))
	)

	it.effect(
		"fails as stale when its draws run out or are left over, or it gives itself up, never filling them in",
		() =>
			Effect.gen(function* () {
				const staleWith = (
					draws: string,
					property: (sketch: number, c: Case<"drew">) => Effect.Effect<void, CaseDiscarded>
				) =>
					Effect.flip(
						explore(
							{
								...searchOf("stale draws", int(0, 9), features<"drew">([]), 10, 1),
								kept: [{ note: "drifted", sketch: 0, draws, reaches: ["drew"] }]
							},
							property
						)
					)
				const ranOut = yield* staleWith("", rareDraw)
				const leftOver = yield* staleWith(tokenOf(Float64Array.of(3, 4), 2), rareDraw)
				const gaveUp = yield* staleWith("", (_sketch, c) =>
					Effect.andThen(
						Effect.sync(() => c.note("drew")),
						c.assume(false)
					)
				)
				deepStrictEqual(
					[ranOut._tag, leftOver._tag, gaveUp._tag],
					["KeptStale", "KeptStale", "KeptStale"]
				)
			}).pipe(Effect.provideService(Run, fullRun))
	)

	it.effect("records what the system decided without counting it as a draw", () =>
		Effect.gen(function* () {
			const explored = yield* explore(
				{
					...searchOf("kept observations", int(0, 9), features<"observed">([]), 10, 1),
					kept: [{ note: "observes twice", sketch: 0, draws: "", reaches: ["observed"] }]
				},
				(_sketch, c) =>
					Effect.sync(() => {
						c.observe("a lock was granted")
						c.observe("the other session waited")
						c.note("observed")
					})
			)
			strictEqual(explored.kind, "explored")
		}).pipe(Effect.provideService(Run, fullRun))
	)
})

/** A requirement every case reaches, one only rotating cases reach now and then, and one only steered cases reach. */
type Reaching = "every case" | "rotating, rarely" | "steered only"

/** Notes what each requirement of Reaching says of a case: the rotating stream's cases alone are unsteered here. */
const noteReaching = (value: number, c: Case<Reaching>) =>
	Effect.sync(() => {
		c.note("every case")
		if (Option.isNone(c.steering) && value < 10) {
			c.note("rotating, rarely")
		}
		if (Option.isSome(c.steering)) {
			c.note("steered only")
		}
	})

describe("reach", () => {
	it.effect(
		"reports each requirement's floor, steered and independent reach, and a fresh seed's estimated miss",
		() =>
			Effect.gen(function* () {
				let rarely = 0
				const explored = yield* explore(
					searchOf(
						"reach",
						int(0, 99),
						features<Reaching>(["every case", "rotating, rarely", "steered only"]),
						200,
						1
					),
					(value, c) =>
						Effect.andThen(
							noteReaching(value, c),
							Effect.sync(() => {
								rarely += Option.isNone(c.steering) && value < 10 ? 1 : 0
							})
						)
				)
				deepStrictEqual(explored.reach, [
					{ requirement: "every case", floor: 50, steered: 0, independent: 200, miss: 0 },
					{
						requirement: "rotating, rarely",
						floor: 0,
						steered: 0,
						independent: rarely,
						miss: (1 - rarely / 200) ** 200
					},
					{ requirement: "steered only", floor: 50, steered: 0, independent: 0, miss: 0 }
				])
			}).pipe(Effect.provideService(Run, fullRun))
	)

	it.effect(
		"fails a requirement fewer independent cases reached than its margin, though a steered case reached it",
		() =>
			Effect.gen(function* () {
				const searchWith = (margin: number) =>
					searchOf(
						"margin",
						int(0, 99),
						withReachMargin(features<Reaching>(["every case", "steered only"]), margin),
						40,
						4
					)
				const met = yield* explore(searchWith(0), noteReaching)
				const short = yield* Effect.flip(explore(searchWith(40), noteReaching))
				const beyond = yield* Effect.flip(explore(searchWith(41), noteReaching))
				deepStrictEqual(
					[
						met.kind,
						short._tag === "ReachBelowMargin" ? short.short : [],
						beyond._tag === "ReachBelowMargin" ? beyond.short : []
					],
					[
						"explored",
						[{ requirement: "steered only", reached: 0 }],
						[
							{ requirement: "every case", reached: 40 },
							{ requirement: "steered only", reached: 0 }
						]
					]
				)
			}).pipe(Effect.provideService(Run, fullRun))
	)
})

describe("steering", () => {
	it.effect(
		"is offered to the floor stream's cases, and never to the rotating stream's or a kept case",
		() =>
			Effect.gen(function* () {
				const offered: Array<boolean> = []
				yield* explore(
					{
						...searchOf("steering phases", int(0, 9), features<Size>([]), 40, 4),
						kept: [{ note: "small", sketch: 1, draws: "", reaches: ["small"] }]
					},
					(value, c) =>
						Effect.andThen(
							Effect.sync(() => offered.push(Option.isSome(c.steering))),
							noteSize(value, c)
						)
				)
				deepStrictEqual(
					[offered[0], Arr.filter(offered, (steers) => steers).length, offered.length],
					[false, 10, 51]
				)
			}).pipe(Effect.provideService(Run, fullRun))
	)
})
