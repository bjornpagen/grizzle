/**
 * Text at the host boundary and its orders (core/text.ts).
 *
 * - Validation: validateText admits exactly the well-formed, NUL-free strings, and refuses a planted NUL, a lone
 *   surrogate of either half or a reversed pair at any position, and every non-string, by its fault. Oracle: the
 *   boundary's specification, each plant's fault named by the plant.
 * - Code point order: compareCodePoints orders as the UTF-8 bytes of the texts do, PostgreSQL's C collation. Oracle: a
 *   second implementation, TextEncoder's bytes compared one by one.
 * - Tuple orders: a tuple of texts orders as a JSON array by code unit and by code point; and its key (core/text.ts
 *   textsKey), compared as a string, orders as its JSON array by code point, and is another tuple's key exactly when the
 *   tuples are one. Oracle: a second implementation, the tuples spelled and compared.
 *
 * Features: live text, a non-string and each plant at each position; equal tuples, a prefix, a difference past the
 * first text, of two lengths, and at an escaped unit.
 */

import { compareCodePoints } from "@bjornpagen/grizzle-text/text"
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { compareStrings } from "#compiler/core/order.ts"
import { compareQuotedTuples, isValidText, textsKey, validateText } from "#compiler/core/text.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { faulted, succeeded } from "#test/support/assert.ts"
import {
	plantedFault,
	type PlantedFeature,
	plantedFeature,
	plantedTextGen,
	plantedValue
} from "#test/unit/values/support.ts"
import {
	bytesNeed,
	type CodePointFeature,
	codePointFeatures,
	escaped,
	kinds,
	positions,
	signOf,
	text,
	tuple,
	type TupleFeature
} from "#test/unit/values/text.fixtures.ts"

/** Text validation admits exactly the well-formed NUL-free strings and refuses every planted NUL, lone surrogate and non-string by its fault. Its budget is its suite's before it was a property (test/unit/values/text.test.ts at 4ca3036a): 1000 runs and 1000 steered cases. */
export const textValidationAdmitsExactlyTheWellFormedNULFreeStringsAndRefusesEveryPlantedNULLoneSurrogateAndNonStringByItsFault =
	property.explore(plantedTextGen, {
		needs: {},
		budget: { runs: 1000, steered: 1000 },
		situations: [
			"live",
			"not a string",
			...Arr.flatMap(kinds, (kind) =>
				Arr.map(positions, (position): PlantedFeature => `${kind} ${position}`)
			)
		] satisfies ReadonlyArray<Reached<PlantedFeature>>,
		check: (_, c: Case<PlantedFeature>) => (planted) =>
			Effect.sync(() => {
				c.note(plantedFeature(planted))
				const fault = plantedFault(planted)
				const value = plantedValue(planted)
				const result = validateText(value)
				if (fault !== undefined) {
					faulted(result, fault)
				} else if (typeof value === "string") {
					const admitted: string = succeeded(result)
					assert.equal(admitted, value)
				} else {
					assert.fail("a live planted text is a string")
				}
				assert.equal(isValidText(value), fault === undefined)
			}),
		oracle: {
			kind: "specification",
			name: "the boundary's rule: well-formed NUL-free strings, each plant refused by its fault"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/text.ts",
				original:
					'\tif (!isWellFormedText(value)) {\n\t\treturn Result.err("textSurrogate")\n\t}\n',
				replacement: "",
				why: "validateText admits a lone surrogate; the validation property fails."
			}
		]
	})

/** Code point order matches UTF-8 byte order. Its budget is its suite's before it was a property (test/unit/values/text.test.ts at 4ca3036a): 5000 runs and 400 steered cases. */
export const codePointOrderMatchesUTF8ByteOrder = property.explore(
	(source) => [source.draw(text), source.draw(text)] as const,
	{
		needs: { bytesNeed },
		budget: { runs: 5000, steered: 400 },
		situations: [
			"a unit past the surrogates against an astral scalar",
			"one text the other's prefix",
			"equal texts"
		] satisfies ReadonlyArray<Reached<CodePointFeature>>,
		check:
			({ bytesNeed }, c: Case<CodePointFeature>) =>
			([a, b]) =>
				Effect.gen(function* () {
					const bytes = yield* bytesNeed
					return yield* Effect.sync(() => {
						c.noteAll(codePointFeatures(a, b))
						assert.equal(compareCodePoints(a, b), bytes(a, b))
					})
				}),
		oracle: {
			kind: "second-implementation",
			name: "TextEncoder's UTF-8 bytes compared one by one"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/text.ts",
				original: "\t\t\treturn codePointRank(x) < codePointRank(y) ? -1 : 1",
				replacement: "\t\t\treturn x < y ? -1 : 1",
				why: "compareCodePoints orders texts by code unit; the code point order property fails."
			}
		]
	}
)

/** Text tuple orders order as their texts' spellings do, each text after its length, and as JSON arrays by code unit and by code point. Its budget is its suite's before it was a property (test/unit/values/text.test.ts at 4ca3036a): 2000 runs and 2000 steered cases. */
export const textTupleOrdersOrderAsTheirTextsSpellingsDoEachTextAfterItsLengthAndAsJSONArraysByCodeUnitAndByCodePoint =
	property.explore((source) => [source.draw(tuple), source.draw(tuple)] as const, {
		needs: {},
		budget: { runs: 2000, steered: 2000 },
		situations: [
			"equal tuples",
			"one tuple the other's prefix",
			"differing first past the first text",
			"texts of two lengths where they differ",
			"an escaped unit where they differ",
			"a unit past the surrogates against an astral scalar where they differ"
		] satisfies ReadonlyArray<Reached<TupleFeature>>,
		check:
			(_, c: Case<TupleFeature>) =>
			([a, b]) =>
				Effect.sync(() => {
					const differs = Arr.findFirstIndex(a, (x, i) => x !== b[i])
					const at = differs._tag === "Some" ? differs.value : a.length
					const x = a[at]
					const y = b[at]
					if (x === undefined || y === undefined) {
						c.note(a.length === b.length ? "equal tuples" : "one tuple the other's prefix")
					} else {
						if (at > 0) {
							c.note("differing first past the first text")
						}
						if (x.length !== y.length) {
							c.note("texts of two lengths where they differ")
						}
						let unit = 0
						while (unit < x.length && unit < y.length && x[unit] === y[unit]) {
							unit += 1
						}
						if (
							Option.exists(Str.charCodeAt(x, unit), escaped) ||
							Option.exists(Str.charCodeAt(y, unit), escaped)
						) {
							c.note("an escaped unit where they differ")
						}
						if (
							Arr.contains(
								codePointFeatures(x, y),
								"a unit past the surrogates against an astral scalar"
							)
						) {
							c.note("a unit past the surrogates against an astral scalar where they differ")
						}
					}
					assert.equal(
						signOf(compareQuotedTuples(compareStrings)(a, b)),
						signOf(compareStrings(jsonText(a), jsonText(b))),
						"code unit order is the JSON array's"
					)
					assert.equal(
						signOf(compareQuotedTuples(compareCodePoints)(a, b)),
						compareCodePoints(jsonText(a), jsonText(b)),
						"code point order is the JSON array's"
					)
					const keyA = textsKey(a)
					const keyB = textsKey(b)
					assert.equal(
						signOf(compareStrings(keyA, keyB)),
						compareCodePoints(jsonText(a), jsonText(b)),
						"a tuple's key, compared as a string, orders as its JSON array by code point"
					)
					assert.equal(
						keyA === keyB,
						jsonText(a) === jsonText(b),
						"two tuples have one key exactly when they are one"
					)
				}),
		oracle: {
			kind: "second-implementation",
			name: "the tuples spelled by JSON.stringify, then compared"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/text.ts",
				original: "\t\t\t\treturn y === undefined ? -1 : 1",
				replacement: "\t\t\t\treturn 1",
				why: "compareQuotedTuples orders a tuple after its own prefix, where a JSON array that goes on (`,`) is below one that ends (`]`); the tuple orders property fails."
			},
			{
				file: "packages/engine/src/core/text.ts",
				original: "\t\t\treturn mintTextsKey(inCodePointOrder(json, at))",
				replacement: "\t\t\treturn mintTextsKey(json)",
				why: "A key is its JSON text as it is, ordered by code unit: a scalar past U+FFFF, spelled by a surrogate pair, orders below a unit from U+E000, where code point order puts it above."
			}
		]
	})
