import { Array as Arr, Effect } from "effect"
import { describe, expect, test } from "vitest"
import { type ErrorUnit, groupErrors } from "#validate/locations.ts"

const unit = (instanceLocation: string, keyword: string): ErrorUnit => ({
	absoluteKeywordLocation: `https://example.com/s#/${keyword}`,
	instanceLocation,
	keyword
})

const keywords = (units: readonly ErrorUnit[]): readonly string[] =>
	Arr.map(units, (found) => found.keyword)

describe("groupErrors", () => {
	test("new pin: a deepest pointer reported twice yields one group holding both units in input order", () => {
		const groups = Effect.runSync(
			groupErrors([unit("#/a", "first"), unit("#/b", "k"), unit("#/a", "second")])
		)

		expect(
			Arr.map(groups, (group) => ({
				deepest: keywords(group.deepest),
				pointer: String(group.pointer)
			}))
		).toEqual([
			{ deepest: ["first", "second"], pointer: "/a" },
			{ deepest: ["k"], pointer: "/b" }
		])
	})

	test("new pin: a context unit belongs to the first leaf in pointer order that contains it", () => {
		const groups = Effect.runSync(
			groupErrors([unit("#/b/c", "k"), unit("#", "root"), unit("#/a", "k")])
		)

		expect(
			Arr.map(groups, (group) => ({
				context: keywords(group.context),
				pointer: String(group.pointer)
			}))
		).toEqual([
			{ context: ["root"], pointer: "/a" },
			{ context: [], pointer: "/b/c" }
		])
	})

	test("new pin: leaves come out in pointer order", () => {
		const groups = Effect.runSync(
			groupErrors([unit("#/c", "k"), unit("#/a", "k"), unit("#/b", "k")])
		)

		expect(Arr.map(groups, (group) => String(group.pointer))).toEqual(["/a", "/b", "/c"])
	})
})
