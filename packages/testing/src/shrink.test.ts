/**
 * Shrinking (shrink.ts), held to what it promises over tapes of every shape: a failing case shrinks to one that still
 * fails, no larger, the same on a repeat, and to its space's least wherever its moves reach it; it never throws, and
 * proposes only its documented moves of the smallest failing case so far, returning one its own decisions replay; and
 * it spends at most its budget of candidates, saying so when the budget stopped it. Oracles are stated per search.
 *
 * Plants (~/.cache/grizzle-release/BR07/plants), one a property in this order: shrink-binary-short,
 * shrink-proposes-below-lo, shrink-budget-plus-one.
 */
import { describe, it } from "@effect/vitest"
import { assertTrue, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option } from "effect"
import { everyCase } from "#chance.fixtures.ts"
import { drawn, exhaust, explore } from "#explore.ts"
import { noCoverage, required } from "#features.ts"
import { array, boolean, element, type Gen, int, map, oneOf, span, weighted } from "#gen.ts"
import { notesOnly } from "#sense.ts"
import { boundedShrink, completeShrink, shrink, shrinkAttempt } from "#shrink.ts"
import {
	type Chooser,
	forcedChooser,
	type Generated,
	type Recorder,
	recorder,
	type Source
} from "#source.ts"
import { shortlex, type Tape, valuesOf } from "#tape.ts"
import { searched } from "#vitest/searched.ts"

/**
 * A generator shape the shrinker is tested on: its items as a flat list, the largest item it draws and the most items,
 * so a predicate's threshold is drawn where some case reaches it. Each space is small enough to enumerate whole.
 */
type Shape = Readonly<{ generator: Gen<ReadonlyArray<number>>; top: number; items: number }>

const SHAPE_NAMES = ["list", "nested", "weighted", "branchy"] as const

type ShapeName = (typeof SHAPE_NAMES)[number]

const SHAPES: Readonly<Record<ShapeName, Shape>> = {
	list: { generator: array(int(0, 5), { min: 0, max: 3 }), top: 5, items: 3 },
	nested: {
		generator: map(array(array(int(0, 2), { min: 0, max: 2 }), { min: 0, max: 2 }), Arr.flatten),
		top: 2,
		items: 4
	},
	weighted: {
		generator: weighted([
			[1, map(int(0, 9), (item) => [item])],
			[2, array(int(0, 3), { min: 0, max: 2 })]
		]),
		top: 9,
		items: 2
	},
	branchy: {
		generator: (source) =>
			source.draw(boolean)
				? [source.draw(int(0, 5))]
				: [source.draw(int(0, 2)), source.draw(int(0, 2)), source.draw(int(0, 2))],
		top: 5,
		items: 3
	}
}

/** The predicate families a failure is drawn from: the first three are monotone, the last a pair of items in order. */
const PREDICATES = [
	"an item at least k",
	"a sum at least k",
	"at least k items",
	"a descent"
] as const

type Predicate = (typeof PREDICATES)[number]

const failsBy = (predicate: Predicate, k: number) => (items: ReadonlyArray<number>) => {
	switch (predicate) {
		case "an item at least k":
			return Arr.some(items, (item) => item >= k)
		case "a sum at least k":
			return Arr.reduce(items, 0, (sum, item) => sum + item) >= k
		case "at least k items":
			return items.length >= k
		case "a descent":
			return Arr.some(items, (item, at) =>
				Arr.some(Arr.drop(items, at + 1), (later) => later < item)
			)
	}
}

/** The least of failing cases in shortlex order, fewest decisions first: the order shrinking descends. */
const leastOf = (
	failing: Arr.NonEmptyReadonlyArray<Generated<ReadonlyArray<number>>>
): Generated<ReadonlyArray<number>> =>
	Arr.reduce(failing, Arr.headNonEmpty(failing), (least, generated) =>
		shortlex(generated.tape.values, generated.tape.length, least.tape.values, least.tape.length) ===
		-1
			? generated
			: least
	)

/**
 * The problems whose least failing case every failing case of the space reaches by the shrinker's moves alone:
 * deleting an item or a span, lowering a decision, setting a span simplest and swapping two items. Those moves never
 * raise a decision, so they cannot merge two items into one larger item (a sum, or a length across nested lists),
 * move a value from one item to another, or switch a weighted choice or a branch to an arm that draws fewer decisions
 * with larger values; from such a case the shrunk case is a local least, no larger than where it began.
 */
const reachesLeast = (shape: ShapeName, predicate: Predicate): boolean => {
	switch (shape) {
		case "list":
			return predicate !== "a sum at least k"
		case "nested":
			return predicate === "an item at least k"
		case "weighted":
			return predicate === "at least k items" || predicate === "a descent"
		case "branchy":
			return false
	}
}

/** A shrink problem: a shape, and a predicate with its threshold drawn where some case of the shape can reach it. */
type Problem = Readonly<{ shape: ShapeName; predicate: Predicate; k: number }>

const problems: Gen<Problem> = (source) => {
	const shape = source.draw(element(SHAPE_NAMES))
	const predicate = source.draw(element(PREDICATES))
	const { top, items } = SHAPES[shape]
	const k = source.draw(
		int(
			1,
			predicate === "at least k items"
				? items
				: predicate === "a sum at least k"
					? top * items
					: top
		)
	)
	return { shape, predicate, k }
}

/** The failing cases of a problem's space, in enumeration order, and the one a property draws to begin shrinking at. */
const failingOf = (
	problem: Problem
): Readonly<{
	fails: (items: ReadonlyArray<number>) => boolean
	failing: ReadonlyArray<Generated<ReadonlyArray<number>>>
}> => {
	const fails = failsBy(problem.predicate, problem.k)
	return {
		fails,
		failing: Arr.filter(everyCase(SHAPES[problem.shape].generator), (generated) =>
			fails(generated.value)
		)
	}
}

/**
 * A generator's form, drawn at random so the shrinker meets tapes of every shape: a leaf draws a whole number up to its
 * top; a list draws between its least and most items of its item's form, a size that may admit one length; a choice
 * draws one of its arms; a run draws its parts in turn, in a span of its own.
 */
type Form =
	| Readonly<{ kind: "leaf"; top: number }>
	| Readonly<{ kind: "list"; item: Form; min: number; max: number }>
	| Readonly<{ kind: "choice"; arms: Arr.NonEmptyReadonlyArray<Form> }>
	| Readonly<{ kind: "run"; parts: ReadonlyArray<Form> }>

const FORM_KINDS = ["leaf", "list", "choice", "run"] as const

const formOf =
	(depth: number): Gen<Form> =>
	(source) => {
		switch (depth === 0 ? "leaf" : source.draw(element(FORM_KINDS))) {
			case "leaf":
				return { kind: "leaf", top: source.draw(int(0, 9)) }
			case "list": {
				const min = source.draw(int(0, 3))
				return {
					kind: "list",
					item: source.draw(formOf(depth - 1)),
					min,
					max: source.draw(int(min, 4))
				}
			}
			case "choice":
				return {
					kind: "choice",
					arms: [
						source.draw(formOf(depth - 1)),
						...source.draw(array(formOf(depth - 1), { min: 0, max: 2 }))
					]
				}
			case "run":
				return { kind: "run", parts: source.draw(array(formOf(depth - 1), { min: 0, max: 3 })) }
		}
	}

/**
 * The generator a form describes, built of the library's own combinators, its leaves drawn onto `leaves` in order.
 * After each leaf `stops` is asserted not to hold of them, so a case it holds of fails right there, inside every draw
 * open at that leaf, as a property that fails inside a draw does.
 */
const generatorOf = (
	form: Form,
	leaves: Array<number>,
	stops: (leaves: ReadonlyArray<number>) => boolean
): Gen<unknown> => {
	switch (form.kind) {
		case "leaf":
			return map(int(0, form.top), (leaf) => {
				leaves.push(leaf)
				assertTrue(!stops(leaves), "the case fails inside its draw")
			})
		case "list":
			return array(generatorOf(form.item, leaves, stops), { min: form.min, max: form.max })
		case "choice":
			return oneOf(Arr.map(form.arms, (arm) => generatorOf(arm, leaves, stops)))
		case "run": {
			const parts = Arr.map(form.parts, (part) => generatorOf(part, leaves, stops))
			return span("run", (source) => Arr.map(parts, (part) => source.draw(part)))
		}
	}
}

/** Where a case's failure is found: once it has drawn everything, or at the first leaf it fails by. */
const FOUND = ["at its end", "inside a draw"] as const

type Found = (typeof FOUND)[number]

/**
 * Draws a case of a form on `recorded` against `chooser`, its leaves onto `leaves`, as a search's case runner draws a
 * case on a recorder its pool reuses.
 */
const drawOn = (
	recorded: Recorder,
	form: Form,
	leaves: Array<number>,
	stops: (leaves: ReadonlyArray<number>) => boolean,
	chooser: Chooser
): void => {
	recorded.reset(chooser)
	generatorOf(form, leaves, stops)(recorded.source)
}

/** A case of a form as a shrink candidate runs: it fails by its leaves, with the tape it drew, or it holds. */
type Ran =
	| Readonly<{ kind: "fails"; tape: Tape; failure: ReadonlyArray<number> }>
	| Readonly<{ kind: "holds"; tape: Tape }>

/**
 * A shrink candidate of a form on `recorded`: its values drawn as a case's, and judged by `fails`. A draw that fails
 * ends the case there, and its tape is copied out with every span open at that leaf still open, as a search copies out
 * the tape of a property that failed inside a draw.
 */
const ranOn =
	(
		recorded: Recorder,
		form: Form,
		fails: (leaves: ReadonlyArray<number>) => boolean,
		stops: (leaves: ReadonlyArray<number>) => boolean
	) =>
	(values: Float64Array): Effect.Effect<Ran> => {
		const leaves: Array<number> = []
		return Effect.map(
			Effect.exit(
				Effect.sync(() =>
					drawOn(recorded, form, leaves, stops, forcedChooser(values, values.length))
				)
			),
			(): Ran => {
				const tape = recorded.tape()
				return fails(leaves) ? { kind: "fails", tape, failure: leaves } : { kind: "holds", tape }
			}
		)
	}

/** The decisions of another case's source, so a case drawn on them replays and shrinks with that case. */
const through = (source: Source): Chooser => ({
	exhausted: () => false,
	draw: (lo, hi, _at, spread) => {
		switch (spread) {
			case "leaning":
				return source.choose(lo, hi)
			case "uniform":
				return source.pick(lo, hi)
		}
	}
})

/** The largest threshold leaves fail by under a predicate that has one: their largest, their sum, or their count. */
const thresholdOf = (predicate: Predicate, leaves: ReadonlyArray<number>): number => {
	switch (predicate) {
		case "an item at least k":
			return Arr.reduce(leaves, 0, (most, leaf) => Math.max(most, leaf))
		case "a sum at least k":
			return Arr.reduce(leaves, 0, (sum, leaf) => sum + leaf)
		case "at least k items":
			return leaves.length
		case "a descent":
			return 1
	}
}

/** A run of a tape's decisions, `[start, end)`. */
type Run = Readonly<{ start: number; end: number }>

/** The runs a tape's spans label. */
const spanRunsOf = (tape: Tape): ReadonlyArray<Run> =>
	Arr.map(Arr.fromIterable(tape.spanLabel.keys()), (at) => ({
		start: tape.spanStart[at] ?? 0,
		end: tape.spanEnd[at] ?? 0
	}))

/** Whether every span of a tape lies within its decisions. */
const spansWithin = (tape: Tape): boolean =>
	Arr.every(spanRunsOf(tape), ({ start, end }) => start >= 0 && start <= end && end <= tape.length)

/**
 * The collections of a tape as `array` draws them: each `array` span, the decisions from its start to its first item
 * that count it, and its items, the `element` spans directly inside it.
 */
const arraysOf = (tape: Tape): ReadonlyArray<Readonly<{ count: Run; items: ReadonlyArray<Run> }>> =>
	Arr.flatMap(Arr.fromIterable(tape.spanLabel.entries()), ([held, label]) => {
		if (label !== "array") {
			return []
		}
		const depth = tape.spanDepth[held] ?? 0
		const inside = Arr.takeWhile(
			Arr.drop(Arr.fromIterable(tape.spanLabel.keys()), held + 1),
			(at) => (tape.spanDepth[at] ?? 0) > depth
		)
		const items = Arr.map(
			Arr.filter(
				inside,
				(at) => tape.spanLabel[at] === "element" && tape.spanDepth[at] === depth + 1
			),
			(at) => ({ start: tape.spanStart[at] ?? 0, end: tape.spanEnd[at] ?? 0 })
		)
		const count = {
			start: tape.spanStart[held] ?? 0,
			end: Option.match(Arr.head(items), {
				onNone: () => tape.spanEnd[held] ?? 0,
				onSome: (first) => first.start
			})
		}
		return [{ count, items }]
	})

/** Values with the run removed. */
const cut = (values: ReadonlyArray<number>, run: Run): ReadonlyArray<number> => [
	...values.slice(0, run.start),
	...values.slice(run.end)
]

/**
 * Every candidate the shrinker's passes may build from a tape, as its documentation states them, by a second
 * implementation over the tape's spans: a span deleted or set to its simplest, an item of a collection deleted with each
 * decision that counts the collection one lower, and two items of a collection exchanged. Lowering one decision is
 * judged by `lowered`.
 */
const movesOf = (tape: Tape): ReadonlyArray<ReadonlyArray<number>> => {
	const values = valuesOf(tape)
	const lows = Arr.fromIterable(tape.lo)
	const spans = Arr.flatMap(spanRunsOf(tape), (run) => [
		cut(values, run),
		[...values.slice(0, run.start), ...lows.slice(run.start, run.end), ...values.slice(run.end)]
	])
	const items = Arr.flatMap(arraysOf(tape), ({ count, items: runs }) =>
		Arr.flatMap(runs, (item, at) => [
			Arr.map(cut(values, item), (value, position) =>
				position >= count.start && position < count.end ? value - 1 : value
			),
			...Arr.map(Arr.drop(runs, at + 1), (later) => [
				...values.slice(0, item.start),
				...values.slice(later.start, later.end),
				...values.slice(item.end, later.start),
				...values.slice(item.start, item.end),
				...values.slice(later.end)
			])
		])
	)
	return [...spans, ...items]
}

/** Whether a candidate is a tape with one decision lowered toward its simplest. */
const lowered = (tape: Tape, candidate: ReadonlyArray<number>): boolean => {
	const differing = Arr.filter(
		Arr.fromIterable(tape.values.keys()),
		(at) => candidate[at] !== tape.values[at]
	)
	return (
		candidate.length === tape.length &&
		differing.length === 1 &&
		Arr.every(
			differing,
			(at) =>
				(candidate[at] ?? 0) >= (tape.lo[at] ?? 0) && (candidate[at] ?? 0) < (tape.values[at] ?? 0)
		)
	)
}

/** Whether two runs of values are the same values. */
const sameValues = (left: ReadonlyArray<number>, right: ReadonlyArray<number>): boolean =>
	left.length === right.length && Arr.every(left, (value, at) => value === right[at])

/** A shrink of a drawn form: its form, the predicate its case fails by, and where the failure is found. */
type Formed = Readonly<{ form: Form; predicate: Predicate; found: Found }>

const formedProblems: Gen<Formed> = (source) => ({
	form: source.draw(formOf(3)),
	predicate: source.draw(element(PREDICATES)),
	found: source.draw(element(FOUND))
})

describe("shrinking", () => {
	it.effect(
		"shrinks a failing case to one that still fails, no larger and the same on a repeat, and to its space's least wherever its moves reach it, as an exhaustion's failure does",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "shrink to the least",
						oracle: {
							kind: "second-implementation",
							name: "the space enumerated whole, its least failing case in shortlex order"
						},
						draw: drawn(problems),
						literal: Formatter.format,
						coverage: required<ShapeName | Predicate>([...SHAPE_NAMES, ...PREDICATES], {
							cases: 200,
							sense: notesOnly
						}),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(1)
					},
					(problem, c) =>
						Effect.gen(function* () {
							const { shape, predicate } = problem
							const { generator } = SHAPES[shape]
							const { fails, failing } = failingOf(problem)
							if (!Arr.isReadonlyArrayNonEmpty(failing)) {
								return yield* c.assume(false)
							}
							c.note(shape)
							c.note(predicate)
							const begun = Arr.getUnsafe(failing, c.draw(int(0, failing.length - 1)))
							const check = (items: ReadonlyArray<number>) => Effect.succeed(fails(items))
							const shrunk = yield* shrink(generator, begun, check, completeShrink)
							const again = yield* shrink(generator, begun, check, completeShrink)
							const least = leastOf(failing)
							const reported = yield* Effect.flip(
								exhaust(
									{
										suite: `the least of ${shape} by ${predicate}`,
										oracle: {
											kind: "specification",
											name: "the predicate the outer property drew"
										},
										box: "the shape's whole space",
										generator,
										literal: Formatter.format,
										limit: 1000,
										coverage: noCoverage,
										caseHang: Duration.minutes(1)
									},
									(items) => Effect.sync(() => assertTrue(!fails(items), "the case holds"))
								)
							)
							deepStrictEqual(
								{
									fails: fails(shrunk.best.failure),
									noLarger:
										shortlex(
											shrunk.best.tape.values,
											shrunk.best.tape.length,
											begun.tape.values,
											begun.tape.length
										) <= 0,
									repeat: valuesOf(again.best.tape),
									ended: shrunk.ended
								},
								{
									fails: true,
									noLarger: true,
									repeat: valuesOf(shrunk.best.tape),
									ended: "minimal"
								}
							)
							const exhausted =
								reported._tag === "PropertyFalsified"
									? Option.map(reported.replay, (replayed) => replayed.values)
									: Option.none()
							if (reachesLeast(shape, predicate)) {
								deepStrictEqual(
									[valuesOf(shrunk.best.tape), exhausted],
									[valuesOf(least.tape), Option.some(valuesOf(least.tape))]
								)
							}
						})
				)
			)
	)

	it.effect(
		"never throws and proposes only its documented moves of the smallest failing case so far, over tapes of every shape failing at their end or inside a draw on a reused recorder, and returns a failing case no larger than where it began, which its own decisions replay",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "shrink any tape",
						oracle: {
							kind: "second-implementation",
							name: "the shrinker's documented moves built again from each tape's spans: a span deleted or simplest, an array's item deleted with its count lowered, two of its items exchanged, one decision lowered"
						},
						draw: drawn(formedProblems),
						literal: Formatter.format,
						coverage: required<Found | Predicate>([...FOUND, ...PREDICATES], {
							cases: 200,
							sense: notesOnly
						}),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(1)
					},
					({ form, predicate, found }, c) =>
						Effect.gen(function* () {
							const recorded = recorder()
							const whole = c.draw((source) => {
								const leaves: Array<number> = []
								drawOn(recorded, form, leaves, () => false, through(source))
								return { tape: recorded.tape(), leaves }
							})
							const fails = failsBy(
								predicate,
								c.draw(int(1, Math.max(1, thresholdOf(predicate, whole.leaves))))
							)
							const attempt = ranOn(
								recorded,
								form,
								fails,
								found === "inside a draw" ? fails : () => false
							)
							const begun = yield* attempt(whole.tape.values)
							if (begun.kind === "holds") {
								return yield* c.assume(false)
							}
							c.note(found)
							c.note(predicate)
							let smallest = begun.tape
							let moves = movesOf(smallest)
							const strays: Array<ReadonlyArray<number>> = []
							const watched = (values: Float64Array) => {
								const candidate = Arr.fromIterable(values)
								if (
									!lowered(smallest, candidate) &&
									!Arr.some(moves, (move) => sameValues(move, candidate))
								) {
									strays.push(candidate)
								}
								return Effect.map(attempt(values), (ran) => {
									if (
										ran.kind === "fails" &&
										shortlex(ran.tape.values, ran.tape.length, smallest.values, smallest.length) ===
											-1
									) {
										smallest = ran.tape
										moves = movesOf(smallest)
									}
									return ran
								})
							}
							const shrunk = yield* shrinkAttempt(begun, watched, completeShrink)
							const replayed = yield* attempt(shrunk.best.tape.values)
							deepStrictEqual(
								{
									fails: fails(shrunk.best.failure),
									noLarger:
										shortlex(
											shrunk.best.tape.values,
											shrunk.best.tape.length,
											begun.tape.values,
											begun.tape.length
										) <= 0,
									replayed: { kind: replayed.kind, values: valuesOf(replayed.tape) },
									ended: shrunk.ended,
									spansWithin: [spansWithin(begun.tape), spansWithin(shrunk.best.tape)],
									strays: Arr.take(strays, 1)
								},
								{
									fails: true,
									noLarger: true,
									replayed: { kind: "fails", values: valuesOf(shrunk.best.tape) },
									ended: "minimal",
									spansWithin: [true, true],
									strays: []
								}
							)
						})
				)
			)
	)

	it.effect(
		"spends at most its budget of candidates, and says so when the budget stopped it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "shrink budget",
						oracle: {
							kind: "specification",
							name: "a bounded shrink spends at most its candidates and says when it stopped short"
						},
						draw: drawn((source) => ({
							problem: source.draw(problems),
							budget: source.draw(int(0, 40))
						})),
						literal: Formatter.format,
						coverage: required<"stopped by its budget" | "minimal within its budget">(
							["stopped by its budget", "minimal within its budget"],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(1)
					},
					({ problem, budget }, c) =>
						Effect.gen(function* () {
							const { generator } = SHAPES[problem.shape]
							const { fails, failing } = failingOf(problem)
							if (!Arr.isReadonlyArrayNonEmpty(failing)) {
								return yield* c.assume(false)
							}
							const begun = Arr.getUnsafe(failing, c.draw(int(0, failing.length - 1)))
							const check = (items: ReadonlyArray<number>) => Effect.succeed(fails(items))
							const bounded = yield* shrink(generator, begun, check, boundedShrink(budget))
							const complete = yield* shrink(generator, begun, check, completeShrink)
							assertTrue(
								bounded.candidates <= budget,
								`${bounded.candidates} candidates within ${budget}`
							)
							const ended = bounded.ended
							assertTrue(ended !== "deadline", "no deadline cuts a shrink of plain values")
							switch (ended) {
								case "budget":
									c.note("stopped by its budget")
									strictEqual(bounded.candidates, budget)
									break
								case "minimal":
									c.note("minimal within its budget")
									deepStrictEqual(valuesOf(bounded.best.tape), valuesOf(complete.best.tape))
									break
							}
						})
				)
			)
	)
})
