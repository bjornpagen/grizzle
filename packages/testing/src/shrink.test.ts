import { describe, it } from "@effect/vitest"
import { assertTrue, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option } from "effect"
import { everyCase } from "#chance.fixtures.ts"
import { drawn, exhaust, explore } from "#explore.ts"
import { noCoverage, required } from "#features.ts"
import { array, boolean, element, type Gen, int, map, weighted } from "#gen.ts"
import { notesOnly } from "#sense.ts"
import { boundedShrink, completeShrink, shrink } from "#shrink.ts"
import type { Generated } from "#source.ts"
import { shortlex, valuesOf } from "#tape.ts"
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
