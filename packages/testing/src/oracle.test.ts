import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option, Order } from "effect"
import { exhaust } from "#explore.ts"
import { requiredInSpace } from "#features.ts"
import { element, int, shuffled } from "#gen.ts"
import { exact, set } from "#oracle.ts"
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
						limit: 4000,
						coverage: requiredInSpace<Change>(CHANGES),
						caseHang: Duration.minutes(1)
					},
					({ left, right, change, at }, c) =>
						Effect.sync(() => {
							c.note(change)
							const [first, second] = answersOf(left, right, change, at)
							deepStrictEqual(
								Option.isNone(set(exact)(first, second)),
								distinct(first) &&
									distinct(second) &&
									sameItems(Arr.sort(first, Order.String), Arr.sort(second, Order.String))
							)
						})
				)
			)
	)
})
