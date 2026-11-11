/**
 * The search itself (explore.ts), checked against what it promises:
 *
 * - Streams: over drawn searches (rotating runs of 0 to 48, 1 to 4 at once, a snapshot every 1 to 16), the floor runs
 *   max(1, ⌈runs / 4⌉) cases and the rotating stream runs, the residual counting the rotating cases alone; steering is
 *   offered to exactly the floor's cases, never to a kept case or the rotating stream's.
 * - Shrinking: a property failing at every draw of at least a drawn threshold shrinks to the threshold.
 * - Failures by kind: a replay that no longer runs as its token says is ReplayStale; a kept case never meets a
 *   requirement; a kept case that no longer reaches what it names is KeptUnreached; a hanging case is stopped on the
 *   live clock under a TestClock; a note or draw after its case ended is CaseMisused; a kept case replays its draws and
 *   prints them, is stale when they run out, are left over or it gives itself up, and records observations without
 *   counting them as draws. Each scenario is one named kind of the library's failure taxonomy, its verdict the tag the
 *   specification names.
 * - Exhaustion: over drawn spaces (a × b values, a property drawing one of c more), every case runs once, a space one
 *   past its limit runs none, and a filter's discarded values never count against the limit.
 * - The residual: an independent recount, the 95% bound by exact enumeration of every run over a box of
 *   distributions, and Good–Turing's identity by exact enumeration.
 * - agree: each comparison's definition, side by side.
 * - The coverage verdict and replay fidelity: metamorphic under another seed and concurrency, and a round trip.
 * - A synchronous case runs inline: twice the cases arm no more timers or event-loop hops than the runtime's own
 *   yields allow (SCHEDULED_PER_CASE). Its wall time is no verdict.
 *
 * Oracles are stated per search. Plants (~/.cache/grizzle-release/BR07/plants): explore-floor-rounded-down,
 * shrink-binary-short, replay-leftover-accepted, kept-requirement-counted, kept-unreached-unchecked,
 * hang-on-test-clock (red by the test's own timeout), misuse-unjudged, kept-draws-unprinted, kept-ran-out-filled,
 * observe-draws, exhaust-limit-exact-refused, exhaust-discards-counted, residual-doubletons-wide, residual-bound-halved,
 * residual-estimate-shifted, agree-set-repeats, steering-offered-rotating, coverage-verdict-run-seeded,
 * replay-unsteered, sync-case-forked: one a property, in this order.
 */
import { createHook } from "node:async_hooks"
import { describe, it } from "@effect/vitest"
import { assertTrue, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import {
	Array as Arr,
	Duration,
	Effect,
	Exit,
	Formatter,
	Option,
	Order,
	String as Str
} from "effect"
import { fraction, type Fraction, plus, times } from "#chance.fixtures.ts"
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
	RISK_BOUND_MISS,
	type Risk,
	required,
	requiredInSpace,
	residualOf,
	riskBoundOf,
	tallyOf
} from "#features.ts"
import { array, constant, element, filter, type Gen, int } from "#gen.ts"
import { agree, by, equivalence, exact, ordered, type Side, set, structuralHash } from "#oracle.ts"
import { floorSeed } from "#random.ts"
import type { Replay, ReplayCase } from "#replay.ts"
import { notesOnly } from "#sense.ts"
import { boundedShrink, completeShrink } from "#shrink.ts"
import { forcedChooser, generate, sample } from "#source.ts"
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
	oracle: { kind: "specification", name: "a property planted to exercise the search itself" },
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

/** The floor stream's cases of a search of `runs` rotating cases: a quarter as many, rounded up, and one at least. */
const floorCasesOf = (runs: number): number => Math.max(1, Math.ceil(runs / 4))

/** A search of this suite's own over a drawn space of inner searches, its oracle the library's specification. */
const outerOf = <A, F extends string>(
	suite: string,
	name: string,
	generator: Gen<A>,
	coverage: Coverage<F>
): Exploration<A, A, F> => ({
	suite,
	oracle: { kind: "specification", name },
	draw: drawn(generator),
	literal: Formatter.format,
	coverage,
	kept: [],
	runs: 40,
	shrink: completeShrink,
	concurrency: 1,
	steerEvery: 16,
	caseHang: Duration.minutes(1)
})

/** An inner search, run under this suite's fixed run, so its streams are its label's and the run's seed. */
const underFullRun = <A, E, R>(search: Effect.Effect<A, E, R>) =>
	search.pipe(Effect.provideService(Run, fullRun))

/** A drawn inner search: its rotating cases, how many run at once, and how many pass between steering snapshots. */
type InnerShape = Readonly<{ runs: number; concurrency: number; steerEvery: number }>

const innerShapes: Gen<InnerShape> = (source) => ({
	runs: source.draw(int(0, 48)),
	concurrency: source.draw(int(1, 4)),
	steerEvery: source.draw(int(1, 16))
})

type StreamFeature = "no rotating case" | "a quarter rounded up" | "several windows"

/** What a drawn inner search's shape reaches: none rotating, a floor rounded up, more cases than one window. */
const streamFeatures = ({ runs, steerEvery }: InnerShape): ReadonlyArray<StreamFeature> => [
	...(runs === 0 ? ["no rotating case" as const] : []),
	...(runs % 4 === 0 ? [] : ["a quarter rounded up" as const]),
	...(runs > steerEvery ? ["several windows" as const] : [])
]

describe("explore", () => {
	it.effect(
		"runs the floor stream, a quarter of the rotating stream's cases and one at least, then the rotating stream, and estimates from the rotating one alone",
		(ctx) =>
			searched(
				ctx,
				explore(
					outerOf(
						"floor and rotating streams",
						"the floor runs max(1, ⌈runs / 4⌉) cases and the rotating stream runs runs, which alone the residual counts",
						innerShapes,
						required<StreamFeature>(
							["no rotating case", "a quarter rounded up", "several windows"],
							{
								cases: 40,
								sense: notesOnly
							}
						)
					),
					(shape, c) =>
						Effect.gen(function* () {
							c.noteAll(streamFeatures(shape))
							const explored = yield* underFullRun(
								explore(
									{
										...searchOf("passes", int(0, 9), noCoverage, shape.runs, shape.concurrency),
										steerEvery: shape.steerEvery
									},
									() => Effect.void
								)
							)
							deepStrictEqual(
								{ cases: explored.cases, independent: explored.residual.cases },
								{ cases: shape.runs + floorCasesOf(shape.runs), independent: shape.runs }
							)
						})
				)
			)
	)

	it.effect("shrinks the property's own draws with the case, to the least draw that fails", (ctx) =>
		searched(
			ctx,
			explore(
				outerOf(
					"shrunk draws",
					"a failure at every draw of at least a threshold shrinks to the threshold itself",
					int(1, 500),
					noCoverage
				),
				(threshold) =>
					Effect.gen(function* () {
						const failed = yield* Effect.flip(
							underFullRun(
								explore(searchOf("draws", constant("case"), noCoverage, 100, 4), (_value, c) =>
									c.draw(int(0, 1000)) >= threshold ? Effect.die("drew too much") : Effect.void
								)
							)
						)
						deepStrictEqual(
							Option.map(
								failed._tag === "PropertyFalsified" ? failed.replay : Option.none(),
								(replayed) => replayed.values
							),
							Option.some([threshold])
						)
					})
			)
		)
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
		oracle: { kind: "specification", name: "a property planted to exercise the search itself" },
		box: "every pair of 0..2 and 0..1",
		generator: (source) => [source.draw(int(0, 2)), source.draw(int(0, 1))] as const,
		literal: Formatter.format,
		limit: 6,
		coverage: noCoverage,
		caseHang: Duration.seconds(10)
	}

	it.effect(
		"checks every case of its space, its own draws enumerated too, and refuses a space past its limit before any case runs",
		(ctx) =>
			searched(
				ctx,
				explore(
					outerOf(
						"exhaustive spaces",
						"a space of a × b values whose property draws one of c more holds a·b·c cases, each run once; one past its limit runs none when its generator alone passes the limit, and stops at the case that would pass it when its property's draws do",
						(source) => ({
							a: source.draw(int(1, 4)),
							b: source.draw(int(1, 4)),
							c: source.draw(int(1, 3)),
							short: source.draw(int(0, 1)) === 1
						}),
						required<"a space run whole" | "a space refused" | "property draws enumerated">(
							["a space run whole", "a space refused", "property draws enumerated"],
							{ cases: 40, sense: notesOnly }
						)
					),
					({ a, b, c, short }, k) =>
						Effect.gen(function* () {
							const space = a * b * c
							const seen = new Set<string>()
							let ran = 0
							const search = exhaust(
								{
									...pairs,
									suite: "a drawn space",
									generator: (source) =>
										[source.draw(int(0, a - 1)), source.draw(int(0, b - 1))] as const,
									limit: short ? space - 1 : space
								},
								([x, y], inner) =>
									Effect.sync(() => {
										ran += 1
										seen.add(`${x} ${y} ${inner.draw(int(0, c - 1))}`)
									})
							)
							if (c > 1) {
								k.note("property draws enumerated")
							}
							if (short) {
								k.note("a space refused")
								const failed = yield* Effect.flip(underFullRun(search))
								deepStrictEqual(
									{ failed: failed._tag, ran },
									{ failed: "SpaceBeyondLimit", ran: c === 1 ? 0 : space }
								)
								return
							}
							k.note("a space run whole")
							const exhausted = yield* underFullRun(search)
							deepStrictEqual(
								{ cases: exhausted.cases, ran, distinct: seen.size },
								{ cases: space, ran: space, distinct: space }
							)
						})
				)
			)
	)

	it.effect("counts only the cases a filter keeps, so a space its limit holds runs whole", (ctx) =>
		searched(
			ctx,
			explore(
				outerOf(
					"filtered spaces",
					"a filter keeping the values below k of 0..n runs exactly those k cases under a limit of k",
					(source) => {
						const n = source.draw(int(0, 15))
						return { n, k: source.draw(int(1, n + 1)) }
					},
					required<"some values filtered" | "none filtered">(
						["some values filtered", "none filtered"],
						{ cases: 40, sense: notesOnly }
					)
				),
				({ n, k }, c) =>
					Effect.gen(function* () {
						c.note(k <= n ? "some values filtered" : "none filtered")
						const kept = yield* underFullRun(
							exhaust(
								{
									suite: "filtered",
									oracle: {
										kind: "specification",
										name: "a property planted to exercise the search itself"
									},
									box: "every value of 0..n the filter keeps",
									generator: filter(int(0, n), (value) => value < k, 1),
									literal: String,
									limit: k,
									coverage: noCoverage,
									caseHang: Duration.seconds(10)
								},
								() => Effect.void
							)
						)
						strictEqual(kept.cases, k)
					})
			)
		)
	)
})

/** The situations a residual test's cases note. */
const SITUATIONS = ["a", "b", "c", "d", "e"] as const

/** The situations of the Good–Turing identity's space, each noted by a case with the chance its weight gives. */
const NOTED = ["x", "y", "z"] as const

/** What a residual's risk can be, as the residual test notes it. */
const RISK_SHAPES = ["no cases", "nothing noted", "saturated", "seen once"] as const

type RiskShape = (typeof RISK_SHAPES)[number]

/** How many cases the bound's box runs to. */
const BOUND_RUNS = 10

/**
 * For each run of 1 to `most` cases, each noting one situation drawn with the chance its weight gives, the chance that
 * the next case reaches a situation none reached with a chance above the residual's bound: the bound's miss. It is
 * computed exactly over the distribution of each run's seen situations, as a bit mask, and its last new case, which
 * are all the bound and the missing mass depend on.
 */
const missesOf = (weights: ReadonlyArray<number>, most: number): ReadonlyArray<number> => {
	const total = Arr.reduce(weights, 0, (sum, weight) => sum + weight)
	const missingOf = (seen: number) =>
		Arr.reduce(weights, 0, (mass, weight, situation) =>
			(seen & (1 << situation)) === 0 ? mass + weight / total : mass
		)
	let runs = new Map<string, Readonly<{ seen: number; lastNew: number; chance: number }>>([
		["0:0", { seen: 0, lastNew: 0, chance: 1 }]
	])
	const misses: Array<number> = []
	for (let cases = 1; cases <= most; cases += 1) {
		const next = new Map<string, Readonly<{ seen: number; lastNew: number; chance: number }>>()
		for (const run of runs.values()) {
			for (const [situation, weight] of weights.entries()) {
				const bit = 1 << situation
				const seen = run.seen | bit
				const lastNew = (run.seen & bit) === 0 ? cases : run.lastNew
				const key = `${seen}:${lastNew}`
				next.set(key, {
					seen,
					lastNew,
					chance: (next.get(key)?.chance ?? 0) + (run.chance * weight) / total
				})
			}
		}
		runs = next
		misses.push(
			Arr.reduce(Arr.fromIterable(runs.values()), 0, (missed, run) =>
				missingOf(run.seen) > riskBoundOf(cases, cases - run.lastNew) ? missed + run.chance : missed
			)
		)
	}
	return misses
}

/** Every sequence of `length` situations of NOTED, each with its chance under `weights`. */
const sequencesOf = (
	length: number,
	weights: ReadonlyArray<number>
): ReadonlyArray<readonly [ReadonlyArray<number>, Fraction]> => {
	const total = BigInt(Arr.reduce(weights, 0, (sum, weight) => sum + weight))
	let sequences: ReadonlyArray<readonly [ReadonlyArray<number>, Fraction]> = [
		[[], fraction(1n, 1n)]
	]
	for (let step = 0; step < length; step += 1) {
		sequences = Arr.flatMap(sequences, ([sequence, chance]) =>
			Arr.map(
				weights,
				(weight, situation) =>
					[Arr.append(sequence, situation), times(chance, fraction(BigInt(weight), total))] as const
			)
		)
	}
	return sequences
}

describe("the residual", () => {
	it.effect(
		"counts each situation once per case that noted it, those seen once and twice, and the cases since the last new one, and knows no risk when nothing was noted",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "the residual",
						oracle: {
							kind: "second-implementation",
							name: "an independent recount of the cases that noted each situation, in order"
						},
						draw: drawn(array(array(element(SITUATIONS), { min: 0, max: 3 }), { min: 0, max: 12 })),
						literal: Formatter.format,
						coverage: required<RiskShape>(RISK_SHAPES, { cases: 400, sense: notesOnly }),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 200,
						caseHang: Duration.seconds(30)
					},
					(cases, c) =>
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
							const lastNew = Arr.reduce(cases, 0, (last, notes, at) =>
								Arr.some(notes, (situation) =>
									Arr.every(Arr.take(cases, at), (earlier) => !Arr.contains(earlier, situation))
								)
									? at + 1
									: last
							)
							const risk: Risk =
								cases.length === 0
									? { kind: "unknown", why: "no-cases" }
									: counts.length === 0
										? { kind: "unknown", why: "nothing-noted" }
										: {
												kind: "estimated",
												estimate: singletons / cases.length,
												bound: riskBoundOf(cases.length, cases.length - lastNew)
											}
							c.note(
								risk.kind === "unknown"
									? risk.why === "no-cases"
										? "no cases"
										: "nothing noted"
									: singletons === 0
										? "saturated"
										: "seen once"
							)
							const residual = residualOf(tally.tally())
							deepStrictEqual(
								{
									cases: residual.cases,
									observed: residual.observed,
									singletons: residual.singletons,
									doubletons: residual.doubletons,
									sinceNew: residual.sinceNew,
									risk: residual.risk,
									estimated: Option.isSome(residual.unseen)
								},
								{
									cases: cases.length,
									observed: counts.length,
									singletons,
									doubletons: Arr.filter(counts, (count) => count === 2).length,
									sinceNew: cases.length - lastNew,
									risk,
									estimated: risk.kind === "estimated"
								}
							)
						})
				)
			)
	)

	it.effect(
		"bounds the risk at 95%: after every run of 1 to 10 cases, over every distribution in the box, the next case's chance of a situation none reached exceeds the bound with chance at most 5%",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "the residual's bound",
						box: "every distribution of one situation a case over 1 to 4 situations, each weighted 1 to 4, after each of 1 to 10 cases",
						oracle: {
							kind: "specification",
							name: "the chance the bound is exceeded, by the exact distribution of each run's seen situations and its last new case"
						},
						generator: (source) => Arr.makeBy(source.draw(int(1, 4)), () => source.draw(int(1, 4))),
						literal: Formatter.format,
						limit: 400,
						coverage: noCoverage,
						caseHang: Duration.minutes(1)
					},
					(weights) =>
						Effect.sync(() => {
							for (const [at, missed] of missesOf(weights, BOUND_RUNS).entries()) {
								assertTrue(
									missed <= RISK_BOUND_MISS,
									`after ${at + 1} cases the bound is exceeded with chance ${missed}`
								)
							}
						})
				)
			)
	)

	it.effect(
		"reports a risk whose expectation is exactly the missing mass one case earlier, over every sequence of up to 5 cases",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "the residual's identity",
						box: "every sequence of up to 5 cases over 3 situations, under every weighting by 1 to 3",
						oracle: {
							kind: "universal",
							name: "Good–Turing: E[singletons(n)]/n equals E[missing mass(n − 1)], by exact enumeration"
						},
						generator: (source) => ({
							n: source.draw(int(1, 5)),
							weights: Arr.map(NOTED, () => source.draw(int(1, 3)))
						}),
						literal: Formatter.format,
						limit: 200,
						coverage: noCoverage,
						caseHang: Duration.minutes(1)
					},
					({ n, weights }) =>
						Effect.sync(() => {
							const total = BigInt(Arr.reduce(weights, 0, (sum, weight) => sum + weight))
							const expectedRisk = Arr.reduce(
								sequencesOf(n, weights),
								fraction(0n, 1n),
								(sum, [sequence, chance]) => {
									const tally = tallyOf("independent")
									for (const situation of sequence) {
										tally.add(new Set([Arr.getUnsafe(NOTED, situation)]))
									}
									const { risk } = residualOf(tally.tally())
									strictEqual(risk.kind, "estimated", "every case notes a situation")
									const estimate = risk.kind === "estimated" ? risk.estimate : Number.NaN
									return plus(
										sum,
										times(chance, fraction(BigInt(Math.round(estimate * n)), BigInt(n)))
									)
								}
							)
							const missingMass = Arr.reduce(
								sequencesOf(n - 1, weights),
								fraction(0n, 1n),
								(sum, [sequence, chance]) =>
									plus(
										sum,
										times(
											chance,
											fraction(
												BigInt(
													Arr.reduce(weights, 0, (mass, weight, situation) =>
														Arr.contains(sequence, situation) ? mass : mass + weight
													)
												),
												total
											)
										)
									)
							)
							deepStrictEqual(expectedRisk, missingMass)
						})
				)
			)
	)
})

/** The comparisons an oracle's sides are judged by: in order, as sets, through a projection, or within a tolerance. */
const COMPARISONS = ["ordered", "set", "by first item", "within one"] as const

type Comparison = (typeof COMPARISONS)[number]

/** A side's answer: a few small whole numbers. */
type Answer = ReadonlyArray<number>

const answerGen: Gen<Answer> = array(int(0, 3), { min: 0, max: 3 })

/** Each comparison as the library spells it. */
const equivalenceOf = (comparison: Comparison) => {
	switch (comparison) {
		case "ordered":
			return ordered<number>(exact)
		case "set":
			return set<number>(structuralHash, exact)
		case "by first item":
			return by((answer: Answer) => Option.fromUndefinedOr(answer[0]), exact)
		case "within one":
			return by(
				(answer: Answer) => Arr.reduce(answer, 0, (sum, item) => sum + item),
				equivalence((left: number, right: number) => Math.abs(left - right) <= 1, String)
			)
	}
}

/**
 * Whether two answers agree under a comparison, from its definition: the same items in the same order; the same items
 * in any order, neither side repeating one; the same first item, or none on both; sums at most one apart.
 */
const agreesOf = (comparison: Comparison, left: Answer, right: Answer): boolean => {
	const distinct = (answer: Answer) => new Set(answer).size === answer.length
	const sum = (answer: Answer) => Arr.reduce(answer, 0, (total, item) => total + item)
	switch (comparison) {
		case "ordered":
			return left.length === right.length && Arr.every(left, (item, at) => item === right[at])
		case "set":
			return (
				distinct(left) &&
				distinct(right) &&
				Arr.every(left, (item) => Arr.contains(right, item)) &&
				Arr.every(right, (item) => Arr.contains(left, item))
			)
		case "by first item":
			return left[0] === right[0]
		case "within one":
			return Math.abs(sum(left) - sum(right)) <= 1
	}
}

describe("agree", () => {
	it.effect(
		"passes exactly when every side agrees with the first under its comparison, and names the first side that does not",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						...searchOf(
							"agree",
							(source) => ({
								comparison: source.draw(element(COMPARISONS)),
								first: source.draw(answerGen),
								rest: source.draw(array(answerGen, { min: 0, max: 3 }))
							}),
							required<Comparison | "agreed" | "disagreed" | "a later side disagreed">(
								[...COMPARISONS, "agreed", "disagreed", "a later side disagreed"],
								{ cases: 400, sense: notesOnly }
							),
							300,
							1
						),
						oracle: {
							kind: "second-implementation",
							name: "each comparison's definition, side by side against the first"
						}
					},
					({ comparison, first, rest }, c) =>
						Effect.gen(function* () {
							c.note(comparison)
							const head: Side<Answer> = ["side 0", first]
							const sides = Arr.prepend(
								Arr.map(rest, (answer, at): Side<Answer> => [`side ${at + 1}`, answer]),
								head
							)
							const dissenting = Arr.findFirstIndex(
								rest,
								(answer) => !agreesOf(comparison, first, answer)
							)
							c.note(Option.isSome(dissenting) ? "disagreed" : "agreed")
							if (Option.exists(dissenting, (at) => at > 0)) {
								c.note("a later side disagreed")
							}
							const judged = yield* Effect.exit(agree(sides, equivalenceOf(comparison)))
							deepStrictEqual(
								Option.map(Exit.findErrorOption(judged), (disagreement) => [
									disagreement.first,
									disagreement.second
								]),
								Option.map(dissenting, (at) => ["side 0", `side ${at + 1}`])
							)
						})
				)
			)
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
		(ctx) =>
			searched(
				ctx,
				explore(
					outerOf(
						"steering phases",
						"steering is offered to the floor's max(1, ⌈runs / 4⌉) cases alone, after the kept case and before the rotating runs",
						innerShapes,
						required<StreamFeature>(
							["no rotating case", "a quarter rounded up", "several windows"],
							{
								cases: 40,
								sense: notesOnly
							}
						)
					),
					(shape, c) =>
						Effect.gen(function* () {
							c.noteAll(streamFeatures(shape))
							const offered: Array<boolean> = []
							yield* underFullRun(
								explore(
									{
										...searchOf<number, Size>(
											"steering phases",
											int(0, 9),
											noCoverage,
											shape.runs,
											shape.concurrency
										),
										steerEvery: shape.steerEvery,
										kept: [{ note: "small", sketch: 1, draws: "", reaches: ["small"] }]
									},
									(value, inner: Case<Size>) =>
										Effect.andThen(
											Effect.sync(() => offered.push(Option.isSome(inner.steering))),
											noteSize(value, inner)
										)
								)
							)
							const floor = floorCasesOf(shape.runs)
							deepStrictEqual(offered, [
								false,
								...Arr.replicate(true, floor),
								...Arr.replicate(false, shape.runs)
							])
						})
				)
			)
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
						oracle: {
							kind: "universal",
							name: "metamorphic: the coverage verdict is unchanged under another run seed and another concurrency"
						},
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
							oracle: {
								kind: "specification",
								name: "a property planted to fail as its sketch says"
							},
							box: "every value of 0..59, with the draw its property makes",
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
	const generated = generate(innerValues, forcedChooser(values, values.length))
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
						oracle: {
							kind: "universal",
							name: "round trip: a failure's replay token reruns the same case under the same steering"
						},
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

/** The kinds of synchronous property the inline gate runs: none of them ever yields to the event loop. */
const SYNC_PROPERTIES = ["void", "sync", "steps"] as const

type SyncProperty = (typeof SYNC_PROPERTIES)[number]

/** A property of each kind, every one synchronous. */
const syncProperty = (kind: SyncProperty) => (value: number) => {
	switch (kind) {
		case "void":
			return Effect.void
		case "sync":
			return Effect.sync(() => value * 2)
		case "steps":
			return Effect.gen(function* () {
				const doubled = yield* Effect.succeed(value * 2)
				yield* Effect.sync(() => doubled + 1)
			})
	}
}

/**
 * The timers and the event-loop hops a run of `effect` makes: the Timeout and Immediate resources Node creates while it
 * runs, read through an async hook, which sees every one whatever schedules it.
 */
const scheduledBy = <A, E>(effect: Effect.Effect<A, E>) =>
	Effect.gen(function* () {
		const made = { timers: 0, hops: 0 }
		const hook = createHook({
			init: (_id, type) => {
				if (type === "Timeout") {
					made.timers += 1
				}
				if (type === "Immediate") {
					made.hops += 1
				}
			}
		})
		yield* Effect.acquireUseRelease(
			Effect.sync(() => hook.enable()),
			() => effect,
			() => Effect.sync(() => hook.disable())
		)
		return made
	})

/** 2100-01-01T00:00:00Z, in milliseconds since the epoch: a deadline no run reaches. */
const YEAR_2100 = 4_102_444_800_000

/** An exhaustion of `cases` values whose property is synchronous, under a deadline an hour away, so its cut is armed. */
const syncExhaustion = (kind: SyncProperty, cases: number, seed: number) =>
	exhaust(
		{
			suite: `inline ${kind}`,
			oracle: {
				kind: "specification",
				name: "a synchronous property, for counting what its run schedules"
			},
			box: "every value below the drawn count",
			generator: int(0, cases - 1),
			literal: Formatter.format,
			limit: cases,
			coverage: noCoverage,
			caseHang: Duration.minutes(1)
		},
		syncProperty(kind)
	).pipe(
		Effect.provideService(
			Run,
			Run.of({
				seed,
				source: "environment",
				replay: Option.none(),
				fuzz: Option.none(),
				deadline: { kind: "at", millis: YEAR_2100 }
			})
		)
	)

/**
 * The timers and event-loop hops a synchronous case may make, at most, beside the search's own: one in four cases. The
 * runtime yields to other fibers every 2,048 operations, which a case's run takes a few hundred of, and the test
 * process arms a timer of its own now and then; a case run in a fiber of its own hops once and arms two timers.
 */
const SCHEDULED_PER_CASE = 0.25

describe("a synchronous case", () => {
	it.effect(
		"runs inline: a search of twice the cases arms no timer per case, and hops to the event loop only for the runtime's own yields",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						...searchOf(
							"inline cases",
							(source) => ({
								kind: source.draw(element(SYNC_PROPERTIES)),
								cases: source.draw(int(128, 512))
							}),
							required<SyncProperty>(SYNC_PROPERTIES, { cases: 12, sense: notesOnly }),
							6,
							1
						),
						oracle: {
							kind: "specification",
							name: "a case that runs to its end synchronously forks no fiber the event loop must run and arms no timer"
						}
					},
					({ kind, cases }, c) =>
						Effect.gen(function* () {
							c.note(kind)
							const { seed } = yield* Run
							const once = yield* scheduledBy(syncExhaustion(kind, cases, seed))
							const twice = yield* scheduledBy(syncExhaustion(kind, 2 * cases, seed))
							deepStrictEqual(
								{
									timersWithin: twice.timers - once.timers <= SCHEDULED_PER_CASE * cases,
									hopsWithin: twice.hops - once.hops <= SCHEDULED_PER_CASE * cases
								},
								{ timersWithin: true, hopsWithin: true }
							)
						})
				)
			)
	)
})
