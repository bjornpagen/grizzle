/**
 * The text bound (core/lines.ts): every text grizzle builds as one string is measured before it is built, and refused as
 * ResourceBound (stringLength) past the limit. The limit is V8's longest string, which a Node upgrade can move, so it is
 * checked against the running V8, which builds a string of every length within eight of it up to it and refuses one
 * past it; the measure is checked against the text itself, at limits drawn around its length.
 */
import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import {
	array,
	characterOf,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	oneOf,
	string,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Result, String as Str } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { maxStringLength } from "#compiler/core/limits.ts"
import { enclosedWithin, type Lines, textOf } from "#compiler/core/lines.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type * as Engine from "#compiler/core/result.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

describe("the text bound", () => {
	type Longest = "within V8's longest string" | "V8's longest string" | "past V8's longest string"

	it.effect("is V8's longest string on the running Node", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/core/lines-v8-longest",
					generator: int(maxStringLength.value - 8, maxStringLength.value + 8),
					literal: Formatter.format,
					limit: 17,
					box: "every string length within eight code units of maxStringLength",
					oracle: {
						kind: "second-implementation",
						name: "the running V8, building a string of that many code units or throwing a RangeError"
					},
					coverage: requiredInSpace<Longest>([
						"within V8's longest string",
						"V8's longest string",
						"past V8's longest string"
					]),
					caseHang
				},
				(length, c) =>
					Effect.sync(() => {
						const built = Result.try(() => Str.repeat(length)("x").length)
						assert.equal(
							Result.isSuccess(built),
							length <= maxStringLength.value,
							`a string of ${length} code units`
						)
						if (Result.isFailure(built)) {
							assert.ok(built.failure instanceof RangeError, "V8 refuses the length")
						}
						c.note(
							length === maxStringLength.value
								? "V8's longest string"
								: length < maxStringLength.value
									? "within V8's longest string"
									: "past V8's longest string"
						)
					})
			)
		)
	)

	/** Where a drawn limit falls against the text's length: the situations the measure's arithmetic must get right. */
	type Bound = "far within" | "at the limit" | "one past" | "far past"

	/** One line a writer writes, `depth` views deep. */
	interface Written {
		readonly depth: number
		readonly text: string
	}

	/** A text's pieces: ASCII, a newline inside a line, and an astral character, two UTF-16 code units. */
	const piece: Gen<string> = weighted([
		[4, string(characterOf(["a", "b", " ", ","] as const), { min: 0, max: 6 })],
		[1, constant("\n")],
		[1, codePoint(0x1_0000, 0x1_0010)]
	])

	/** How far the limit sits from the text's length, by the situation it puts the measure in. */
	const offset: Gen<number> = weighted([
		[2, int(2, 40)],
		[3, constant(0)],
		[3, constant(-1)],
		[2, int(-40, -2)]
	])

	const boundOf = (length: number, limit: number): Bound =>
		limit === length
			? "at the limit"
			: limit === length - 1
				? "one past"
				: limit > length
					? "far within"
					: "far past"

	/** The limit drawn around `length`, never below zero. */
	const limitAround = (length: number, by: number): number => Math.max(length + by, 0)

	const at = SourceLoc("drawn text", [])

	/**
	 * Exactly the expected text when it fits, and otherwise ResourceBound (text) at `at` with the expected text's length
	 * as `needed`: the oracle is the text joined by hand.
	 */
	const agrees = (
		actual: Engine.Result<string, CompileError>,
		expected: string,
		limit: number
	): void => {
		if (expected.length <= limit) {
			assert.equal(succeeded(actual), expected)
			return
		}
		assert.deepEqual(refused(actual, "ResourceBound").reason, {
			_tag: "ResourceBound",
			at,
			bound: { kind: "stringLength", limit, needed: expected.length }
		})
	}

	const situations = required<Bound>(["far within", "at the limit", "one past", "far past"], {
		cases: 300,
		sense: notesOnly
	})

	it.effect(
		"a written text is exactly its lines joined when it fits, and refused with its length otherwise",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/core/lines-text",
						draw: drawn((s) => ({
							unit: s.draw(oneOf([constant("  "), constant("\t"), constant("")])),
							lines: s.draw(
								array((t): Written => ({ depth: t.draw(int(0, 3)), text: t.draw(piece) }), {
									min: 0,
									max: 8
								})
							),
							by: s.draw(offset)
						})),
						literal: Formatter.format,
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						coverage: situations
					},
					({ unit, lines, by }, c) =>
						Effect.sync(() => {
							const expected = Arr.join(
								Arr.map(lines, (l) => `${Str.repeat(l.depth)(unit)}${l.text}`),
								"\n"
							)
							const limit = limitAround(expected.length, by)
							const write = (out: Lines): void => {
								for (const l of lines) {
									let view = out
									for (let d = 0; d < l.depth; d++) {
										view = view.nested()
									}
									view.line(l.text)
								}
							}
							agrees(textOf(limit, unit, at, write), expected, limit)
							c.note(boundOf(expected.length, limit))
						})
				)
			)
	)

	/** How a text past JavaScript's longest string is made of lines: the fewest that pass it, or more. */
	type Past = "the fewest lines past" | "more lines past"

	it.effect(
		"a text past JavaScript's longest string is refused with its length before it is built",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/core/lines-longest",
						draw: drawn((s) => ({
							width: s.draw(element([2 ** 20, 2 ** 22, 2 ** 24] as const)),
							extra: s.draw(
								weighted([
									[1, constant(0)],
									[1, int(1, 3)]
								])
							)
						})),
						literal: Formatter.format,
						kept: [],
						runs: 8,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						coverage: required<Past>(["the fewest lines past", "more lines past"], {
							cases: 8,
							sense: notesOnly
						})
					},
					({ width, extra }, c) =>
						Effect.sync(() => {
							const line = Str.repeat(width)("x")
							const count = Math.floor(maxStringLength.value / (width + 1)) + 1 + extra
							const write = (out: Lines): void => {
								for (let i = 0; i < count; i++) {
									out.line(line)
								}
							}
							const needed = count * width + count - 1
							assert.ok(needed > maxStringLength.value)
							assert.deepEqual(
								refused(textOf(maxStringLength.value, "  ", at, write), "ResourceBound").reason,
								{
									_tag: "ResourceBound",
									at,
									bound: { kind: "stringLength", limit: maxStringLength.value, needed }
								}
							)
							c.note(extra === 0 ? "the fewest lines past" : "more lines past")
						})
				)
			)
	)

	it.effect(
		"an enclosure is exactly its frame around its parts when it fits, and refused with its length otherwise",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/core/lines-enclosed",
						draw: drawn((s) => ({
							open: s.draw(oneOf([constant(""), constant("["), constant("{"), piece])),
							close: s.draw(oneOf([constant(""), constant("]"), constant("}"), piece])),
							separator: s.draw(oneOf([constant(""), constant(","), constant(", "), piece])),
							parts: s.draw(array(piece, { min: 0, max: 8 })),
							by: s.draw(offset)
						})),
						literal: Formatter.format,
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						coverage: situations
					},
					({ open, close, separator, parts, by }, c) =>
						Effect.sync(() => {
							const expected = `${open}${Arr.join(parts, separator)}${close}`
							const limit = limitAround(expected.length, by)
							agrees(enclosedWithin(limit, at, open, parts, separator, close), expected, limit)
							c.note(boundOf(expected.length, limit))
						})
				)
			)
	)
})
