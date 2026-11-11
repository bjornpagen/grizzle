import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Option,
	Order,
	Ref,
	String as Str
} from "effect"
import {
	type Case,
	type CaseDiscarded,
	type CasePhase,
	drawn,
	type Exhaustion,
	type Exploration,
	exhaust,
	explore,
	isWitness,
	type Kept,
	noDeadline,
	type PropertyFalsified,
	Run,
	type Witnessed
} from "#explore.ts"
import {
	type Coverage,
	noCoverage,
	required,
	requiredInSpace,
	residualOf,
	tallyOf
} from "#features.ts"
import { array, boolean, constant, element, filter, type Gen, int } from "#gen.ts"
import { agree, by, equivalence, exact, multiset, ordered, set } from "#oracle.ts"
import { floorSeed } from "#random.ts"
import type { Replay, ReplayCase } from "#replay.ts"
import { notesOnly } from "#sense.ts"
import { boundedShrink, completeShrink } from "#shrink.ts"
import { forcedChooser, generate, recorder, sample } from "#source.ts"
import { tokenOf } from "#tape.ts"
import { searched } from "#vitest/searched.ts"

/** A run with a given seed, replaying what it is asked to. */
const runOf = (seed: number, replay: Option.Option<Replay>) =>
	Run.of({ seed, source: "environment", replay, fuzz: Option.none(), deadline: noDeadline })

const fullRun = runOf(7, Option.none())

/** This suite's budget for a search: every field stated, as every suite states its own. */
const searchOf = <A, F extends string>(
	suite: string,
	generator: Gen<A>,
	coverage: Coverage<F>,
	runs: number,
	concurrency: number
): Exploration<A, A, F> => ({
	suite,
	draw: drawn(generator),
	literal: Formatter.format,
	coverage,
	kept: [],
	runs,
	shrink: boundedShrink(500),
	concurrency,
	steerEvery: 16,
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
					searchOf("passes", int(0, 9), noCoverage, 40, 4),
					() => Effect.void
				)
				strictEqual(explored.cases, 50)
				strictEqual(explored.residual.cases, 40)
			}).pipe(Effect.provideService(Run, fullRun))
	)

	it.effect("shrinks the property's own draws with the case", () =>
		Effect.gen(function* () {
			const failed = yield* Effect.flip(
				explore(searchOf("draws", constant("case"), noCoverage, 100, 4), (_value, c) =>
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

	it.effect("refuses a replay that no longer runs as its token says, and never passes it", () =>
		Effect.gen(function* () {
			const staleBy = (
				replayed: ReplayCase,
				property: (sketch: string, c: Case<"rare">) => Effect.Effect<void, CaseDiscarded>
			) =>
				Effect.flip(
					explore(
						searchOf(
							"stale replay",
							constant("case"),
							required<"rare">(["rare"], { cases: 0, sense: notesOnly }),
							10,
							1
						),
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

	it.effect("never lets a kept case satisfy a required situation", () =>
		Effect.gen(function* () {
			const failed = yield* Effect.flip(
				explore(
					{
						...searchOf(
							"kept-only",
							int(0, 9),
							required<Size>(["big"], { cases: 16, sense: notesOnly }),
							100,
							4
						),
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
						...searchOf("drifted", int(0, 9), noCoverage, 100, 4),
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
					{ ...searchOf("hangs", int(0, 9), noCoverage, 100, 4), caseHang: Duration.millis(20) },
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
							...searchOf("cleanup ends", int(0, 9), noCoverage, 100, 4),
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
				const returned = yield* Ref.get(cleaned)
				strictEqual(returned, true, "the hung case's lease went back before the hang was reported")
				const frozen = yield* Effect.flip(
					explore(
						{
							...searchOf("cleanup frozen", int(0, 9), noCoverage, 100, 4),
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
						explore(
							searchOf<number, "late">("late use", int(0, 9), noCoverage, 40, 1),
							(_value, c: Case<"late">) =>
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
})

describe("exhaust", () => {
	const pairs: Exhaustion<readonly [number, number], never> = {
		suite: "pairs",
		generator: (source) => [source.draw(int(0, 2)), source.draw(int(0, 1))] as const,
		literal: Formatter.format,
		limit: 6,
		coverage: noCoverage,
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
					coverage: noCoverage,
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
				coverage: noCoverage,
				caseHang: Duration.seconds(10)
			}
			const exhausted = yield* exhaust(flags, (_flag, c) => Effect.sync(() => c.draw(int(0, 2))))
			strictEqual(exhausted.cases, 6)
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
						coverage: noCoverage,
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 200,
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
						...searchOf("kept draws", int(0, 9), noCoverage, 10, 1),
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
								...searchOf("stale draws", int(0, 9), noCoverage, 10, 1),
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
					...searchOf<number, "observed">("kept observations", int(0, 9), noCoverage, 10, 1),
					kept: [{ note: "observes twice", sketch: 0, draws: "", reaches: ["observed"] }]
				},
				(_sketch, c: Case<"observed">) =>
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

describe("steering", () => {
	it.effect(
		"is offered to the floor stream's cases, and never to the rotating stream's or a kept case",
		() =>
			Effect.gen(function* () {
				const offered: Array<boolean> = []
				yield* explore(
					{
						...searchOf<number, Size>("steering phases", int(0, 9), noCoverage, 40, 4),
						kept: [{ note: "small", sketch: 1, draws: "", reaches: ["small"] }]
					},
					(value, c: Case<Size>) =>
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

/** The inner suites' labels: each fixes its own floor and steered streams, so the oracle covers several of each. */
const LABELS = [
	"inner a",
	"inner b",
	"inner c",
	"inner d",
	"inner e",
	"inner f",
	"inner g",
	"inner h"
] as const

type Label = (typeof LABELS)[number]

/** One run of an inner search: its seed, drawn over every 32-bit value, and how many cases it runs at once. */
type InnerRun = Readonly<{ seed: number; concurrency: 1 | 4 | 16 }>

const innerRuns: Gen<InnerRun> = (source) => ({
	seed: source.draw(int(0, 2 ** 32 - 1)),
	concurrency: source.draw(element([1, 4, 16] as const))
})

/** The rotating cases of every inner exploration: its floor stream runs a quarter as many. */
const INNER_RUNS = 40

/** The values an inner exploration draws. */
const innerValues = int(0, 999)

/**
 * How the inner property reaches "rare": never; only in a case drawn unsteered, which without kept cases is a case of
 * the rotating stream; in one value of fifty; in one of five; or in every case it does not give up.
 */
type RareReach = "never" | "unsteered" | "one in fifty" | "one in five" | "always"

/** Which values the inner property gives up on: none, a third, a half (the stall verdict's edge), or two thirds. */
type Discarding = "none" | "a third" | "a half" | "two thirds"

/** What the coverage oracle draws: an inner search, and the two runs that must agree on its verdict. */
type VerdictSketch = Readonly<{
	label: Label
	rare: RareReach
	discarding: Discarding
	budget: 0 | 16 | 64
	runs: readonly [first: InnerRun, second: InnerRun]
}>

const verdictSketches: Gen<VerdictSketch> = (source) => ({
	label: source.draw(element(LABELS)),
	rare: source.draw(
		element(["never", "unsteered", "one in fifty", "one in five", "always"] as const)
	),
	discarding: source.draw(element(["none", "a third", "a half", "two thirds"] as const)),
	budget: source.draw(element([0, 16, 64] as const)),
	runs: [source.draw(innerRuns), source.draw(innerRuns)]
})

const givesUp = (discarding: Discarding, value: number): boolean => {
	switch (discarding) {
		case "none":
			return false
		case "a third":
			return value % 3 === 0
		case "a half":
			return value % 2 === 0
		case "two thirds":
			return value % 3 !== 0
	}
}

const reachesRare = (rare: RareReach, value: number, steered: boolean): boolean => {
	switch (rare) {
		case "never":
			return false
		case "unsteered":
			return !steered
		case "one in fifty":
			return value % 50 === 1
		case "one in five":
			return value % 5 === 1
		case "always":
			return true
	}
}

type Inner = "common" | "rare"

/** An inner search's verdict, as the oracle compares it. */
type Outcome =
	| Readonly<{ kind: "explored"; steered: number }>
	| Readonly<{ kind: "unreached"; missing: ReadonlyArray<string>; witnessed: Witnessed }>
	| Readonly<{ kind: "stalled" }>

/** An inner run's verdict, and the values of every case it drew under steering (its witnesses), ascending. */
type Verdict = Readonly<{ outcome: Outcome; witnesses: ReadonlyArray<number> }>

const verdictOf = (sketch: VerdictSketch, run: InnerRun) =>
	Effect.suspend(() => {
		const witnesses: Array<number> = []
		return explore(
			{
				...searchOf(
					sketch.label,
					innerValues,
					required<Inner>(["common", "rare"], { cases: sketch.budget, sense: notesOnly }),
					INNER_RUNS,
					run.concurrency
				),
				shrink: boundedShrink(10)
			},
			(value, c: Case<Inner>) =>
				Effect.gen(function* () {
					yield* c.assume(!givesUp(sketch.discarding, value))
					c.note("common")
					if (reachesRare(sketch.rare, value, Option.isSome(c.steering))) {
						c.note("rare")
					}
					if (Option.isSome(c.steering)) {
						witnesses.push(value)
					}
				})
		).pipe(
			Effect.map((explored): Outcome => ({ kind: "explored", steered: explored.steered })),
			Effect.catchTags({
				FeaturesUnreached: (unreached) =>
					Effect.succeed<Outcome>({
						kind: "unreached",
						missing: unreached.missing,
						witnessed: unreached.witnessed
					}),
				CasesStalled: () => Effect.succeed<Outcome>({ kind: "stalled" })
			}),
			Effect.map((outcome): Verdict => ({ outcome, witnesses: Arr.sort(witnesses, Order.Number) })),
			Effect.provideService(Run, runOf(run.seed, Option.none()))
		)
	})

/**
 * What the floor stream alone decides of a verdict, from the floor's own cases (the label's first stream, drawn here
 * as `sample` draws it): a stall when more of them give up than run; a pass with no steered case when they reach both
 * situations; a failure naming "rare" when no witness can reach it; otherwise the steered phase decides.
 */
type FloorDecides =
	| Readonly<{ kind: "stalled" }>
	| Readonly<{ kind: "met" }>
	| Readonly<{ kind: "unreachable"; floor: number }>
	| Readonly<{ kind: "steered" }>

const floorDecides = (sketch: VerdictSketch): FloorDecides => {
	const floor = sample(innerValues, floorSeed(sketch.label), Math.ceil(INNER_RUNS / 4))
	const ran = Arr.filter(floor, (value) => !givesUp(sketch.discarding, value))
	if (floor.length - ran.length > ran.length) {
		return { kind: "stalled" }
	}
	if (sketch.rare === "never" || sketch.rare === "unsteered") {
		return { kind: "unreachable", floor: ran.length }
	}
	return Arr.some(ran, (value) => reachesRare(sketch.rare, value, true))
		? { kind: "met" }
		: { kind: "steered" }
}

/** A failure's missing situations and its floor count, when it failed to reach one in an exploration's streams. */
const unreachedInStreams = (
	outcome: Outcome
): Option.Option<readonly [missing: ReadonlyArray<string>, floor: number]> =>
	outcome.kind === "unreached" && outcome.witnessed.kind === "streams"
		? Option.some([outcome.missing, outcome.witnessed.floor])
		: Option.none()

/**
 * The outcome, when it is one a search the floor stream left to the steered phase may end in: a pass that ran at least
 * one steered case and no more than its budget, or a failure naming "rare" alone after no more than its budget.
 */
const leftToSteering = (outcome: Outcome, budget: number): Option.Option<Outcome> => {
	switch (outcome.kind) {
		case "explored":
			return outcome.steered >= 1 && outcome.steered <= budget
				? Option.some(outcome)
				: Option.none()
		case "unreached":
			return outcome.witnessed.kind === "streams" &&
				outcome.witnessed.steered <= budget &&
				Arr.length(outcome.missing) === 1 &&
				Arr.contains(outcome.missing, "rare")
				? Option.some(outcome)
				: Option.none()
		case "stalled":
			return Option.none()
	}
}

describe("the coverage verdict", () => {
	it.effect(
		"is a function of the suite's label: two run seeds, at any concurrency, give the same verdict, counts and witnesses",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "the coverage verdict",
						draw: drawn(verdictSketches),
						literal: Formatter.format,
						coverage: required<Outcome["kind"]>(["explored", "unreached", "stalled"], {
							cases: 60,
							sense: notesOnly
						}),
						kept: [],
						runs: 60,
						shrink: boundedShrink(100),
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(1)
					},
					(sketch, c) =>
						Effect.gen(function* () {
							const [first, second] = sketch.runs
							const verdict = yield* verdictOf(sketch, first)
							c.note(verdict.outcome.kind)
							const secondVerdict = yield* verdictOf(sketch, second)
							deepStrictEqual(secondVerdict, verdict)
							const decided = floorDecides(sketch)
							switch (decided.kind) {
								case "stalled":
									deepStrictEqual(verdict.outcome, { kind: "stalled" })
									break
								case "met":
									deepStrictEqual(verdict.outcome, { kind: "explored", steered: 0 })
									break
								case "unreachable":
									deepStrictEqual(
										unreachedInStreams(verdict.outcome),
										Option.some([["rare"], decided.floor])
									)
									break
								case "steered":
									deepStrictEqual(
										leftToSteering(verdict.outcome, sketch.budget),
										Option.some(verdict.outcome)
									)
									break
							}
						})
				)
			)
	)
})

/** How the replay oracle's inner property fails: on a seventh of its values; on a high draw it aimed at what is
 * pending; on a high draw from a case that reached "rare"; or on a third of the values of an unsteered case. */
type Failing = "often" | "aimed" | "rarely" | "unsteered"

/** What the replay oracle draws: an inner search of either kind, how it fails, and two runs: the first's seed runs at
 * both concurrencies, and a witness's failure is also sought on the second's seed. */
type FidelitySketch = Readonly<{
	search: "explore" | "exhaust"
	label: Label
	failing: Failing
	budget: 0 | 16 | 64
	runs: readonly [first: InnerRun, second: InnerRun]
}>

const fidelitySketches: Gen<FidelitySketch> = (source) => ({
	search: source.draw(element(["explore", "exhaust"] as const)),
	label: source.draw(element(LABELS)),
	failing: source.draw(element(["often", "aimed", "rarely", "unsteered"] as const)),
	budget: source.draw(element([0, 16, 64] as const)),
	runs: [source.draw(innerRuns), source.draw(innerRuns)]
})

/** The values an inner exhaustion enumerates. */
const spaceValues = int(0, 59)

/** What a case of the replay oracle's inner property saw: its value, its own draw, whether it aimed that draw at a
 * pending "rare", and whether it was steered at all. */
type Seen = Readonly<{ value: number; drew: number; aimed: boolean; steered: boolean }>

const failsOn = (failing: Failing, seen: Seen): boolean => {
	switch (failing) {
		case "often":
			return seen.value % 7 === 0
		case "aimed":
			return seen.aimed && seen.drew >= 90
		case "rarely":
			return seen.value % 50 === 1 && seen.drew >= 5
		case "unsteered":
			return !seen.steered && seen.value % 3 === 0
	}
}

/** The replay oracle's inner property: it aims its own draw wider while "rare" is pending, so its tape decodes
 * differently under different steering, and fails as its sketch says. */
const failingProperty =
	(failing: Failing) =>
	(value: number, c: Case<"rare">): Effect.Effect<void> =>
		Effect.gen(function* () {
			const aimed = Option.exists(c.steering, (pending) => pending.has("rare"))
			const drew = c.draw(int(0, aimed ? 99 : 9))
			if (value % 50 === 1) {
				c.note("rare")
			}
			if (failsOn(failing, { value, drew, aimed, steered: Option.isSome(c.steering) })) {
				return yield* Effect.die("falsified")
			}
		})

/** The inner search a fidelity sketch names, under a run, with a kept list for an exploration: its failure, if any. */
const fidelitySearch = (
	sketch: FidelitySketch,
	run: InnerRun,
	kept: ReadonlyArray<Kept<number, "rare">>,
	replay: Option.Option<ReplayCase>
) => {
	const search =
		sketch.search === "explore"
			? Effect.asVoid(
					explore(
						{
							...searchOf(
								sketch.label,
								innerValues,
								required<"rare">(["rare"], { cases: sketch.budget, sense: notesOnly }),
								INNER_RUNS,
								run.concurrency
							),
							kept,
							shrink: boundedShrink(200)
						},
						failingProperty(sketch.failing)
					)
				)
			: Effect.asVoid(
					exhaust(
						{
							suite: sketch.label,
							generator: spaceValues,
							literal: String,
							limit: 10_000,
							coverage: requiredInSpace<"rare">(["rare"]),
							caseHang: Duration.minutes(1)
						},
						failingProperty(sketch.failing)
					)
				)
	return search.pipe(
		Effect.as(Option.none<PropertyFalsified>()),
		Effect.catchTags({
			PropertyFalsified: (falsified) => Effect.succeedSome(falsified),
			FeaturesUnreached: () => Effect.succeed(Option.none<PropertyFalsified>())
		}),
		Effect.provideService(
			Run,
			runOf(
				run.seed,
				Option.map(replay, (replayed) => ({ suite: sketch.label, replayed }))
			)
		)
	)
}

/** What a failure is, as fidelity compares it: where it was drawn, and the case its token names. */
const caseOf = (
	failure: Option.Option<PropertyFalsified>
): Option.Option<readonly [phase: CasePhase, replay: Option.Option<ReplayCase>]> =>
	Option.map(failure, (falsified) => [falsified.phase, falsified.replay] as const)

/** The kept case a failure's token prints, its sketch and its property's draws read back from the token's tape. */
const keptOf = (replayed: ReplayCase): Kept<number, "rare"> => {
	const values = Float64Array.from(replayed.values)
	const generated = generate(recorder(), innerValues, forcedChooser(values, values.length))
	return {
		note: "the failure",
		sketch: generated.value,
		draws: tokenOf(values.subarray(generated.tape.length), values.length - generated.tape.length),
		reaches: ["rare"]
	}
}

describe("replay fidelity", () => {
	it.effect(
		"replays every failure alone from its token, as the same case under the same steering, finds it at any concurrency, and finds a witness's on every seed",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "replay fidelity",
						draw: drawn(fidelitySketches),
						literal: Formatter.format,
						coverage: required<CasePhase>(
							["floor", "steered", "independent", "exhaustive", "kept"],
							{
								cases: 200,
								sense: notesOnly
							}
						),
						kept: [],
						runs: 60,
						shrink: boundedShrink(100),
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(1)
					},
					(sketch, c) =>
						Effect.gen(function* () {
							const [first, second] = sketch.runs
							const failure = yield* fidelitySearch(sketch, first, [], Option.none())
							const swappedConcurrency = yield* fidelitySearch(
								sketch,
								{ seed: first.seed, concurrency: second.concurrency },
								[],
								Option.none()
							)
							deepStrictEqual(caseOf(swappedConcurrency), caseOf(failure))
							if (Option.isNone(failure)) {
								return
							}
							const failed = failure.value
							c.note(failed.phase)
							if (isWitness(failed.phase)) {
								const swappedSeed = yield* fidelitySearch(
									sketch,
									{ seed: second.seed, concurrency: first.concurrency },
									[],
									Option.none()
								)
								deepStrictEqual(caseOf(swappedSeed), caseOf(failure))
							}
							if (Option.isNone(failed.replay)) {
								return
							}
							const token = failed.replay.value
							const replayedSearch = yield* fidelitySearch(sketch, second, [], Option.some(token))
							deepStrictEqual(
								caseOf(replayedSearch),
								Option.some(["replayed", Option.some(token)] as const)
							)
							if (sketch.search === "explore" && token.drawn.kind === "unsteered") {
								const kept = yield* fidelitySearch(sketch, second, [keptOf(token)], Option.none())
								c.note("kept")
								deepStrictEqual(
									Option.map(kept, (falsified) => falsified.phase),
									Option.some("kept")
								)
							}
						})
				)
			)
	)
})
