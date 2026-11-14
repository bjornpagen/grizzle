/**
 * The steered phase (explore.ts), against what it promises, over locks planted to open on five magic values that
 * random search meets once in 33 million cases:
 *
 * - It climbs, one new note at a time, to a situation an unsteered search never reaches: with no steered budget the
 *   requirement goes unreached, with one it is met.
 * - Its witnesses, floor and steered, are the suite label's alone: the same under every concurrency and every run
 *   seed. Oracle: universal, a metamorphic relation.
 * - It climbs through branches it perceives in V8's block coverage with no note on the way, where a blind search
 *   meets none.
 * - It takes turns: over drawn searches (1 to 12 requirements, windows of 1 to 8 cases, floors of 1 to 8 cases,
 *   steered budgets of 0 to 40, cases that never or sometimes reach a requirement), each window's cases see one
 *   snapshot of what is pending, each aims at one pending requirement, the window's aims are distinct while it holds no
 *   more cases than are pending, and with k pending and windows of w every requirement still pending is aimed at within
 *   ⌈k / w⌉ windows of its stream. Oracle: the specification, judged on what each case saw of Case.steering.
 *
 * Each lock is a planted capability problem, its verdict the specification's: a steered search reaches what it
 * requires within its budget.
 *
 * Plants (~/.cache/grizzle-release/BR07/plants): steer-fresh-only.patch (every steered case a fresh draw) turns the
 * first property red; coverage-verdict-run-seeded.patch (the steered stream drawn from the run's seed) the second;
 * sense-v8-blind.patch (block coverage perceiving nothing) the third. Plants
 * (~/.cache/grizzle-release/BACKFILLPROBE/plants): turns-first-pending.patch (every case of a window aimed at the
 * first pending requirement) and turns-restart-each-window.patch (each window's i-th case aimed at the i-th pending
 * requirement, its stream's last aim forgotten) turn the fourth red.
 */
import { describe, it } from "@effect/vitest"
import { assertTrue, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option, Order, String as Str } from "effect"
import type { TestContext } from "vitest"
import { type Case, drawn, type Exploration, explore, Run } from "#explore.ts"
import { type Coverage, required } from "#features.ts"
import { array, boolean, type Gen, int } from "#gen.ts"
import { floorSeed, rotatingSeed } from "#random.ts"
import { notesOnly, type Sense, v8Coverage } from "#sense.ts"
import { completeShrink } from "#shrink.ts"
import { runOfTest } from "#vitest/run.ts"
import { searched } from "#vitest/searched.ts"

const MAGIC = [13, 27, 4, 30, 9] as const

type Matched = `${0 | 1 | 2 | 3 | 4 | 5} matched`

const MATCHED: ReadonlyArray<Matched> = [
	"0 matched",
	"1 matched",
	"2 matched",
	"3 matched",
	"4 matched",
	"5 matched"
]

/** Six values of 0..31: drawn at random, they begin with all five magic values once in 33 million cases. */
const values: Gen<ReadonlyArray<number>> = array(int(0, 31), { min: 6, max: 6 })

/** How many magic values a case begins with. */
const matchedOf = (drawnValues: ReadonlyArray<number>): number => {
	let matched = 0
	while (matched < MAGIC.length && drawnValues[matched] === MAGIC[matched]) {
		matched += 1
	}
	return matched
}

/** The run of the test `ctx` runs, never replaying or fuzzing: the steered and unsteered searches draw from its seed. */
const runIn = (ctx: TestContext) =>
	Effect.map(runOfTest(ctx), (testRun) =>
		Run.of({ ...testRun, replay: Option.none(), fuzz: Option.none() })
	)

/** A search that must reach what its coverage requires, from six values of 0..31. */
const magicSearch = <F extends string>(
	suite: string,
	coverage: Coverage<F>,
	concurrency: number
): Exploration<ReadonlyArray<number>, ReadonlyArray<number>, F> => ({
	suite,
	oracle: { kind: "specification", name: "a lock planted so that only a steered search opens it" },
	draw: drawn(values),
	literal: Formatter.format,
	coverage,
	kept: [],
	runs: 100,
	shrink: completeShrink,
	concurrency,
	steerEvery: 16,
	caseHang: Duration.minutes(1)
})

/** Notes how many magic values the case begins with: each new count is a step a steered search climbs from. */
const noteMatched = (drawnValues: ReadonlyArray<number>, c: Case<Matched>) =>
	Effect.sync(() => c.note(Arr.getUnsafe(MATCHED, matchedOf(drawnValues))))

/**
 * Six values of 0..31 for a lock with five nested branches: drawn at random, they open it once in 33 million cases, so
 * a search that does not perceive the branches never opens it within its budget, whatever the run's seed.
 */
const lockValues: Gen<ReadonlyArray<number>> = array(int(0, 31), { min: 6, max: 6 })

/** Opens only on all five magic values, one nested branch per value, and notes nothing on the way. */
const opens = (drawnValues: ReadonlyArray<number>): boolean => {
	if (drawnValues[0] === MAGIC[0]) {
		if (drawnValues[1] === MAGIC[1]) {
			if (drawnValues[2] === MAGIC[2]) {
				if (drawnValues[3] === MAGIC[3]) {
					if (drawnValues[4] === MAGIC[4]) {
						return true
					}
				}
			}
		}
	}
	return false
}

/** A search for the lock's opening, steered by `sense` for up to `cases` cases, one case at a time. */
const lockSearch = (
	suite: string,
	sense: Sense,
	cases: number
): Exploration<ReadonlyArray<number>, ReadonlyArray<number>, "opened"> => ({
	...magicSearch(suite, required<"opened">(["opened"], { cases, sense }), 1),
	draw: drawn(lockValues)
})

/** Notes only the opening. */
const noteOpened = (drawnValues: ReadonlyArray<number>, c: Case<"opened">) =>
	Effect.sync(() => {
		if (opens(drawnValues)) {
			c.note("opened")
		}
	})

/** Five magic values matched, the situation only a steered search reaches, with a steered budget of `cases`. */
const fiveMatched = (cases: number) => required<Matched>(["5 matched"], { cases, sense: notesOnly })

/** Orders witnesses' values lexicographically, so two runs' witnesses compare whatever order each run found them in. */
const byValues = Arr.makeOrder(Order.Number)

const REQUIREMENTS = [
	"r0",
	"r1",
	"r2",
	"r3",
	"r4",
	"r5",
	"r6",
	"r7",
	"r8",
	"r9",
	"r10",
	"r11"
] as const

type Requirement = (typeof REQUIREMENTS)[number]

/**
 * A drawn inner search: it requires the first `pending` requirements, steers every `window` cases, runs a floor of
 * `floor` cases and a steered budget of `budget`, and its cases reach a requirement sometimes or never.
 */
type TurnShape = Readonly<{
	pending: number
	window: number
	floor: number
	budget: number
	reaching: boolean
}>

const turnShapes: Gen<TurnShape> = (source) => ({
	pending: source.draw(int(1, REQUIREMENTS.length)),
	window: source.draw(int(1, 8)),
	floor: source.draw(int(1, 8)),
	budget: source.draw(int(0, 40)),
	reaching: source.draw(boolean)
})

/** What one steered case saw of Case.steering: the places of the requirements pending, and of the one it aims at. */
type Seen = Readonly<{ pending: ReadonlyArray<number>; aimed: ReadonlyArray<number> }>

type TurnFeature =
	| "more pending than a window holds"
	| "a window holding more cases than are pending"
	| "a requirement reached between windows"
	| "a steered phase of several windows"

/**
 * Checks one stream's windows of `width` cases against what the library promises, and returns the features they
 * reached: one snapshot per window, one aim per case among what is pending, distinct aims while there are as many
 * pending, and every requirement still pending aimed at within ⌈pending / width⌉ full windows.
 */
const turnsKept = (
	windows: ReadonlyArray<Arr.NonEmptyReadonlyArray<Seen>>,
	width: number
): ReadonlyArray<TurnFeature> =>
	Arr.flatMap(windows, (cases, at): ReadonlyArray<TurnFeature> => {
		const { pending } = Arr.headNonEmpty(cases)
		const aims = Arr.flatMap(cases, (seen) => seen.aimed)
		for (const seen of cases) {
			deepStrictEqual(seen.pending, pending)
			strictEqual(seen.aimed.length, Math.min(1, pending.length))
		}
		assertTrue(Arr.every(aims, (aim) => Arr.contains(pending, aim)))
		strictEqual(Arr.dedupe(aims).length, Math.min(pending.length, cases.length))
		const sweep = windows.slice(at, at + Math.ceil(pending.length / width))
		const swept =
			pending.length > 0 &&
			sweep.length === Math.ceil(pending.length / width) &&
			Arr.every(sweep, (window) => window.length === width)
		if (swept) {
			for (const place of pending) {
				const stillPending = Arr.every(sweep, (window) =>
					Arr.contains(Arr.headNonEmpty(window).pending, place)
				)
				assertTrue(
					!stillPending ||
						Arr.some(sweep, (window) =>
							Arr.some(window, (seen) => Arr.contains(seen.aimed, place))
						),
					`requirement ${place} pending through ${sweep.length} windows of ${width} and never aimed at`
				)
			}
		}
		const next = windows[at + 1]
		return [
			...(swept && pending.length > width ? ["more pending than a window holds" as const] : []),
			...(pending.length > 0 && cases.length > pending.length
				? ["a window holding more cases than are pending" as const]
				: []),
			...(next !== undefined &&
			Arr.headNonEmpty(next).pending.length > 0 &&
			Arr.headNonEmpty(next).pending.length < pending.length
				? ["a requirement reached between windows" as const]
				: [])
		]
	})

describe("a steered search", () => {
	it.effect("climbs to a situation random search never reaches, one new note at a time", (ctx) =>
		Effect.gen(function* () {
			const unsteered = yield* Effect.flip(
				explore(magicSearch("unsteered", fiveMatched(0), 4), noteMatched)
			)
			strictEqual(unsteered._tag, "FeaturesUnreached")
			yield* explore(magicSearch("steered", fiveMatched(50_000), 4), noteMatched)
		}).pipe(Effect.provideServiceEffect(Run, runIn(ctx)))
	)

	it.effect(
		"finds the same witnesses, floor and steered, however many run at once and whatever the run's seed",
		(ctx) =>
			Effect.gen(function* () {
				const processRun = yield* runIn(ctx)
				const seeds = [processRun.seed, rotatingSeed(processRun.seed, floorSeed("another run"))]
				const searches = yield* Effect.forEach(
					Arr.flatMap(seeds, (seed) =>
						Arr.map([1, 4, 16], (concurrency) => [seed, concurrency] as const)
					),
					([seed, concurrency]) =>
						Effect.suspend(() => {
							const witnesses: Array<ReadonlyArray<number>> = []
							return explore(
								magicSearch("steered at any concurrency", fiveMatched(50_000), concurrency),
								(drawnValues, c) =>
									Effect.andThen(
										Effect.sync(() => {
											if (Option.isSome(c.steering)) {
												witnesses.push(drawnValues)
											}
										}),
										noteMatched(drawnValues, c)
									)
							).pipe(
								Effect.map(
									(explored) => [explored.steered, Arr.sort(witnesses, byValues)] as const
								),
								Effect.provideService(Run, Run.of({ ...processRun, seed }))
							)
						})
				)
				const [first, ...rest] = searches
				for (const search of rest) {
					deepStrictEqual(search, first)
				}
			}).pipe(Effect.provideServiceEffect(Run, runIn(ctx)))
	)

	it.effect(
		"aims a window's cases at distinct pending requirements, each within ⌈pending / window⌉ windows",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "turns",
						oracle: {
							kind: "specification",
							name: "a window's cases aim at distinct pending requirements, every one within ⌈pending / window⌉ windows"
						},
						draw: drawn(turnShapes),
						literal: Formatter.format,
						coverage: required<TurnFeature>(
							[
								"more pending than a window holds",
								"a window holding more cases than are pending",
								"a requirement reached between windows",
								"a steered phase of several windows"
							],
							{ cases: 40, sense: notesOnly }
						),
						kept: [],
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(1)
					},
					(shape, c) =>
						Effect.gen(function* () {
							const [first, ...rest] = REQUIREMENTS
							const seen: Array<Seen> = []
							const places = Array.from({ length: shape.pending }, (_, place) => place)
							yield* explore(
								{
									suite: "turns, inner",
									oracle: { kind: "specification", name: "what each case saw of its steering" },
									draw: drawn(int(0, 3)),
									literal: Formatter.format,
									coverage: required<Requirement>([first, ...Arr.take(rest, shape.pending - 1)], {
										cases: shape.budget,
										sense: notesOnly
									}),
									kept: [],
									runs: 4 * shape.floor,
									shrink: completeShrink,
									concurrency: 1,
									steerEvery: shape.window,
									caseHang: Duration.minutes(1)
								},
								(value, inner: Case<Requirement>) =>
									Effect.sync(() => {
										if (Option.isNone(inner.steering)) {
											return
										}
										const pending = inner.steering.value
										const requirementAt = (place: number) => Arr.getUnsafe(REQUIREMENTS, place)
										const saw: Seen = {
											pending: Arr.filter(places, (place) => pending.has(requirementAt(place))),
											aimed: Arr.filter(places, (place) => pending.aimed(requirementAt(place)))
										}
										seen.push(saw)
										if (shape.reaching && value === 0) {
											inner.noteAll(Arr.map(saw.aimed, requirementAt))
										}
										if (shape.reaching && value === 1) {
											inner.noteAll(Arr.map(Arr.take(saw.pending, 1), requirementAt))
										}
									})
							).pipe(Effect.catchTag("FeaturesUnreached", () => Effect.void))
							const steered = Arr.chunksOf(seen.slice(shape.floor), shape.window)
							c.noteAll([
								...turnsKept(Arr.chunksOf(seen.slice(0, shape.floor), shape.window), shape.window),
								...turnsKept(steered, shape.window),
								...(steered.length > 1 ? ["a steered phase of several windows" as const] : [])
							])
						})
				)
			)
	)

	it.effect(
		"climbs through branches it perceives in V8's block coverage, with no note on the way",
		(ctx) =>
			Effect.scoped(
				Effect.gen(function* () {
					const sense = yield* v8Coverage(Str.endsWith("/steer.test.ts"))
					const blind = yield* Effect.flip(
						explore(lockSearch("blind", notesOnly, 1000), noteOpened)
					)
					strictEqual(blind._tag, "FeaturesUnreached")
					yield* explore(lockSearch("coverage", sense, 100_000), noteOpened)
				}).pipe(Effect.provideServiceEffect(Run, runIn(ctx)))
			),
		0
	)
})
