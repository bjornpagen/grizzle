/**
 * The library's oracles (oracle.ts): a set comparison agrees exactly when both sides hold the same items once each, and
 * finds every repeat, drop and addition, over every pair of permutations of up to 3 of 4 items (an exhaustion against
 * the definition); and it costs no more than grouping by key, its comparisons and key computations growing no faster
 * than linearly in its answers' size (over sizes 2h, 4h and 6h, the second step costs no more than the first).
 *
 * Plants (~/.cache/grizzle-release/BR07/plants): agree-set-repeats.patch (a repeat agreeing) turns the first property
 * red; set-compared-pairwise.patch (every item compared with every other) the second.
 */
import { describe, it } from "@effect/vitest"
import { assertTrue, deepStrictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Hash, Option, Order } from "effect"
import { drawn, exhaust, explore } from "#explore.ts"
import { required, requiredInSpace } from "#features.ts"
import { element, int, shuffled } from "#gen.ts"
import { type Equivalence, exact, set, structuralHash } from "#oracle.ts"
import { notesOnly } from "#sense.ts"
import { boundedShrink } from "#shrink.ts"
import { searched } from "#vitest/searched.ts"

/** The items a set comparison's sides draw from. */
const ITEMS = ["a", "b", "c", "d"] as const

type Item = (typeof ITEMS)[number]

/**
 * How the second answer differs from the first, a permutation of it: not at all; one item of either side repeated,
 * the duplicated row a set's answer must never hide; one item dropped; or one item added that the first lacks.
 */
const CHANGES = ["none", "repeat left", "repeat right", "drop", "add"] as const

type Change = (typeof CHANGES)[number]

/** The two answers a case compares: the first, and its permutation under `change` at `at`. */
const answersOf = (
	left: ReadonlyArray<Item>,
	right: ReadonlyArray<Item>,
	change: Change,
	at: number
): readonly [ReadonlyArray<Item>, ReadonlyArray<Item>] => {
	switch (change) {
		case "none":
			return [left, right]
		case "repeat left":
			return [[...left, ...Arr.take(Arr.drop(left, at), 1)], right]
		case "repeat right":
			return [left, [...right, ...Arr.take(Arr.drop(right, at), 1)]]
		case "drop":
			return [left, Arr.remove(right, at)]
		case "add":
			return [
				left,
				[
					...right,
					...Arr.take(
						Arr.filter(ITEMS, (item) => !Arr.contains(left, item)),
						1
					)
				]
			]
	}
}

/** Whether two sorted lists hold the same items, item by item. */
const sameItems = Arr.makeEquivalence<Item>((x, y) => x === y)

/** Whether a list holds no item twice. */
const distinct = (values: ReadonlyArray<Item>) => new Set(values).size === values.length

describe("a set comparison", () => {
	it.effect(
		"agrees exactly when both sides hold the same items once each, and finds every repeat, drop and addition, over every pair of permutations of up to 3 of 4 items",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "set comparison",
						box: "every list of up to 3 distinct items of 4, against each of its permutations, under no change and under each single repeat, drop and addition",
						oracle: {
							kind: "second-implementation",
							name: "both sides sorted and compared, and each side's items counted as a Set"
						},
						generator: (source) => {
							const left = source.draw(shuffled(ITEMS, { min: 0, max: 3 }))
							return {
								left,
								right: source.draw(shuffled(left, { min: left.length, max: left.length })),
								change: source.draw(element(CHANGES)),
								at: source.draw(int(0, Math.max(0, left.length - 1)))
							}
						},
						literal: Formatter.format,
						coverage: requiredInSpace<Change>(CHANGES),
						caseHang: Duration.minutes(1)
					},
					({ left, right, change, at }, c) =>
						Effect.sync(() => {
							c.note(change)
							const [first, second] = answersOf(left, right, change, at)
							deepStrictEqual(
								Option.isNone(set(structuralHash, exact)(first, second)),
								distinct(first) &&
									distinct(second) &&
									sameItems(Arr.sort(first, Order.String), Arr.sort(second, Order.String))
							)
						})
				)
			)
	)
})

/**
 * The item comparisons and key computations a set comparison makes over answers of `size` items, the second the first
 * rotated by `turn` places and changed by `change` at place `place`.
 */
const spentAt = (size: number, change: Change, place: number, turn: number): number => {
	const items = Array.from({ length: size }, (_, i) => i)
	const turned = [...Arr.drop(items, turn), ...Arr.take(items, turn)]
	const [first, second] = answersOfNumbers(items, turned, change, place)
	let spent = 0
	const counted: Equivalence<number> = (left, right) => {
		spent += 1
		return exact(left, right)
	}
	const keyed = (item: number) => {
		spent += 1
		return Hash.number(item)
	}
	set(keyed, counted)(first, second)
	return spent
}

describe("a set comparison's cost", () => {
	it.effect(
		"grows no faster than linearly in its answers' size, whatever change the second makes: grouping by key is all it costs",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "set comparison cost",
						oracle: {
							kind: "specification",
							name: "items compared only within their key's group: over sizes 2h, 4h and 6h, every place and turn scaled with the size, the second step costs no more than the first"
						},
						draw: drawn((source) => {
							const half = source.draw(int(1, 600))
							return {
								half,
								change: source.draw(element(CHANGES)),
								at: source.draw(int(0, 2 * half - 1)),
								rotate: source.draw(int(0, 2 * half - 1))
							}
						}),
						literal: Formatter.format,
						coverage: required<Change>(CHANGES, { cases: 40, sense: notesOnly }),
						kept: [],
						runs: 60,
						shrink: boundedShrink(40),
						concurrency: 1,
						steerEvery: 20,
						caseHang: Duration.minutes(1)
					},
					({ half, change, at, rotate }, c) =>
						Effect.sync(() => {
							c.note(change)
							const [first, second, third] = Arr.map([1, 2, 3], (k) =>
								spentAt(2 * k * half, change, k * at, k * rotate)
							)
							assertTrue(
								(third ?? 0) - (second ?? 0) <= (second ?? 0) - (first ?? 0),
								`${first}, ${second} and ${third} comparisons and keys at ${2 * half}, ${4 * half} and ${6 * half} items`
							)
						})
				)
			)
	)
})

/** Two answers of whole numbers: the first, and its permutation under `change` at `at`, as answersOf changes items. */
const answersOfNumbers = (
	left: ReadonlyArray<number>,
	right: ReadonlyArray<number>,
	change: Change,
	at: number
): readonly [ReadonlyArray<number>, ReadonlyArray<number>] => {
	switch (change) {
		case "none":
			return [left, right]
		case "repeat left":
			return [[...left, ...Arr.take(Arr.drop(left, at), 1)], right]
		case "repeat right":
			return [left, [...right, ...Arr.take(Arr.drop(right, at), 1)]]
		case "drop":
			return [left, Arr.remove(right, at)]
		case "add":
			return [left, [...right, left.length]]
	}
}
