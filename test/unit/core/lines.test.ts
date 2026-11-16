/**
 * The text bound (core/lines.ts): every text grizzle builds as one string is measured before it is built, and refused as
 * ResourceBound (stringLength) past the limit. The limit is V8's longest string, which a Node upgrade can move, so it is
 * checked against the running V8, which builds a string of every length within eight of it up to it and refuses one
 * past it; the measure is checked against the text itself, at limits drawn around its length.
 *
 * - V8's longest string: every length within eight of maxStringLength is built exactly when it is at most it, and
 *   refused with a RangeError otherwise. Oracle: the running V8.
 * - A written text (textOf) and an enclosure (enclosedWithin) are exactly the text joined by hand when it fits, and are
 *   otherwise refused as ResourceBound (stringLength) with that text's length as `needed`. Oracle: the text joined by
 *   hand, a second implementation.
 * - A text past JavaScript's longest string is refused with its length, measured, never built.
 *
 * Features: the limit far within, at, one past and far past the text's length; the fewest lines past V8's longest
 * string, and more.
 */

import { maxStringLength } from "@bjornpagen/grizzle-engine/core/canonical"
import { type Reached } from "@bjornpagen/testing/features"
import { array, constant, element, finite, int, weighted } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Result, String as Str } from "effect"
import { enclosedWithin, type Lines, textOf } from "#compiler/core/lines.ts"
import { assert, refused } from "#test/support/assert.ts"
import {
	agrees,
	at,
	type Bound,
	boundOf,
	frame,
	limitAround,
	type Longest,
	offset,
	type Past,
	piece,
	type Written
} from "#test/unit/core/lines.fixtures.ts"

/** The text bound is V8's longest string on the running Node. */
export const theTextBoundIsV8sLongestStringOnTheRunningNode = property.exhaust(
	finite(int(maxStringLength - 8, maxStringLength + 8)),
	{
		needs: {},
		situations: [
			"within V8's longest string",
			"V8's longest string",
			"past V8's longest string"
		] satisfies ReadonlyArray<Reached<Longest>>,
		check: (_, c: Case<Longest>) => (length) =>
			Effect.sync(() => {
				const built = Result.try(() => Str.repeat(length)("x").length)
				assert.equal(
					Result.isSuccess(built),
					length <= maxStringLength,
					`a string of ${length} code units`
				)
				if (Result.isFailure(built)) {
					assert.ok(built.failure instanceof RangeError, "V8 refuses the length")
				}
				c.note(
					length === maxStringLength
						? "V8's longest string"
						: length < maxStringLength
							? "within V8's longest string"
							: "past V8's longest string"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the running V8, building a string of that many code units or throwing a RangeError"
		},
		box: "every string length within eight code units of maxStringLength",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/canonical.ts",
				original: "maxStringLength = 2 ** 29 - 24",
				replacement: "maxStringLength = 2 ** 29 - 23",
				why: "maxStringLength one past V8's longest string; the V8 property fails."
			}
		]
	}
)

/** The text bound a written text is exactly its lines joined when it fits, and refused with its length otherwise. Its budget is its suite's before it was a property (test/unit/core/lines.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const theTextBoundAWrittenTextIsExactlyItsLinesJoinedWhenItFitsAndRefusedWithItsLengthOtherwise =
	property.explore(
		(s) => ({
			unit: s.draw(
				weighted([
					[1, constant("  ")],
					[1, constant("\t")],
					[1, constant("")]
				])
			),
			lines: s.draw(
				array((t): Written => ({ depth: t.draw(int(0, 3)), text: t.draw(piece) }), {
					min: 0,
					max: 8
				})
			),
			by: s.draw(offset)
		}),
		{
			needs: {},
			budget: { runs: 300, steered: 300 },
			situations: ["far within", "at the limit", "one past", "far past"] satisfies ReadonlyArray<
				Reached<Bound>
			>,
			check:
				(_, c: Case<Bound>) =>
				({ unit, lines, by }) =>
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
					}),
			oracle: { kind: "second-implementation", name: "the lines joined by hand" },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/core/lines.ts",
					original: "\treturn needed > limit",
					replacement: "\treturn needed >= limit",
					why: "a text exactly at the limit refused; the written text's and the enclosure's properties fail."
				},
				{
					file: "packages/engine/src/core/lines.ts",
					original: `\t\treturn new BlockLines(this.#out, this.#unit, \`\${this.#indent}\${this.#unit}\`)`,
					replacement: "\t\treturn new BlockLines(this.#out, this.#unit, this.#unit)",
					why: "a nested view indented one unit whatever its depth; the written text property fails."
				}
			]
		}
	)

/** The text bound a text past JavaScript's longest string is refused with its length before it is built. Its budget is its suite's before it was a property (test/unit/core/lines.test.ts at 4ca3036a): 8 runs and 8 steered cases. */
export const theTextBoundATextPastJavaScriptsLongestStringIsRefusedWithItsLengthBeforeItIsBuilt =
	property.explore(
		(s) => ({
			width: s.draw(element([2 ** 20, 2 ** 22, 2 ** 24] as const)),
			extra: s.draw(
				weighted([
					[1, constant(0)],
					[1, int(1, 3)]
				])
			)
		}),
		{
			needs: {},
			budget: { runs: 8, steered: 8 },
			situations: ["the fewest lines past", "more lines past"] satisfies ReadonlyArray<
				Reached<Past>
			>,
			check:
				(_, c: Case<Past>) =>
				({ width, extra }) =>
					Effect.sync(() => {
						const line = Str.repeat(width)("x")
						const count = Math.floor(maxStringLength / (width + 1)) + 1 + extra
						const write = (out: Lines): void => {
							for (let i = 0; i < count; i++) {
								out.line(line)
							}
						}
						const needed = count * width + count - 1
						assert.ok(needed > maxStringLength)
						assert.deepEqual(
							refused(textOf(maxStringLength, "  ", at, write), "ResourceBound").reason,
							{
								_tag: "ResourceBound",
								at,
								bound: { kind: "stringLength", limit: maxStringLength, needed }
							}
						)
						c.note(extra === 0 ? "the fewest lines past" : "more lines past")
					}),
			oracle: {
				kind: "specification",
				name: "the text's length, counted, past maxStringLength"
			},
			kept: [],
			kills: []
		}
	)

/** The text bound an enclosure is exactly its frame around its parts when it fits, and refused with its length otherwise. Its budget is its suite's before it was a property (test/unit/core/lines.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const theTextBoundAnEnclosureIsExactlyItsFrameAroundItsPartsWhenItFitsAndRefusedWithItsLengthOtherwise =
	property.explore(
		(s) => ({
			open: s.draw(frame("[", "{")),
			close: s.draw(frame("]", "}")),
			separator: s.draw(frame(",", ", ")),
			parts: s.draw(array(piece, { min: 0, max: 8 })),
			by: s.draw(offset)
		}),
		{
			needs: {},
			budget: { runs: 300, steered: 300 },
			situations: ["far within", "at the limit", "one past", "far past"] satisfies ReadonlyArray<
				Reached<Bound>
			>,
			check:
				(_, c: Case<Bound>) =>
				({ open, close, separator, parts, by }) =>
					Effect.sync(() => {
						const expected = `${open}${Arr.join(parts, separator)}${close}`
						const limit = limitAround(expected.length, by)
						agrees(enclosedWithin(limit, at, open, parts, separator, close), expected, limit)
						c.note(boundOf(expected.length, limit))
					}),
			oracle: { kind: "second-implementation", name: "the enclosure joined by hand" },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/core/lines.ts",
					original: "\treturn needed > limit",
					replacement: "\treturn needed >= limit",
					why: "a text exactly at the limit refused; the written text's and the enclosure's properties fail."
				},
				{
					file: "packages/engine/src/core/lines.ts",
					original:
						"\tlet needed = open.length + close.length + Math.max(parts.length - 1, 0) * separator.length",
					replacement: "\tlet needed = open.length + close.length + Math.max(parts.length - 1, 0)",
					why: "every separator measured as one code unit, whatever its length; the enclosure property fails."
				}
			]
		}
	)
