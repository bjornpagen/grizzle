/**
 * YAML loads strictly. A drawn document written in block YAML loads as the JSON value it was written from: its plain
 * words that YAML 1.1 read as booleans, dates or numbers stay strings, its plain keys stay the text written (a merge key
 * is an ordinary key, `__proto__` an own key), a flow sequence hundreds deep loads whole, a byte order mark changes
 * nothing, and every alias of an anchored collection is that collection itself, never a copy. A planted hazard is
 * refused with its code: a repeated key at its line, column and byte offset (a byte order mark and wide characters
 * counted in bytes), a second document, an alias inside its own anchor, a key that is no scalar, a tag JSON has no value
 * for at the tagged value's line, a non-finite number at its pointer and position, and a flow left open, a nesting
 * thousands deep left open (refused, never a crash) and an empty stream as invalid YAML.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Option } from "effect"
import {
	actualRefusal,
	aliasesShared,
	bytesOf,
	documents,
	expectedRefusal,
	expectedValue,
	type HazardFeature,
	hazardFeatures,
	loaded,
	planted,
	plantedText,
	type ValueFeature,
	valueFeatures,
	yamlOf
} from "#test/load/yaml.fixtures.ts"

/**
 * A YAML document loads as the value it was written from, every alias sharing its anchor's value. It replaces eight
 * example cases, so its rotating stream is eight drawn documents; its steered phase reaches each situation.
 */
export const yamlValue = property.explore(documents, {
	needs: {},
	situations: [
		"a plain word YAML 1.1 reads as another type",
		"a plain key YAML reads as another type",
		"the merge key over a mapping",
		"a __proto__ key",
		"an alias of a collection",
		"a flow sequence hundreds deep",
		"a block sequence",
		"a nested mapping",
		"a byte order mark"
	] satisfies ReadonlyArray<Reached<ValueFeature>>,
	check: (_, c: Case<ValueFeature>) => (doc) =>
		Effect.gen(function* () {
			c.noteAll(valueFeatures(doc))
			const value = yield* loaded(bytesOf(doc, yamlOf(doc)))
			assert.deepEqual(value, Option.some(expectedValue(doc)))
			assert.deepEqual(
				Option.map(value, (got) => aliasesShared(doc, got)),
				Option.some(true)
			)
		}),
	oracle: {
		kind: "universal",
		name: "the YAML rendering of a drawn value loads as that value, aliases as their anchors' own values"
	},
	kept: [],
	budget: { runs: 8, steered: 32 },
	kills: [
		{
			file: "packages/cli-generator/src/load/yaml.ts",
			original: "walk.memo.set(node, built)",
			replacement: "{}",
			why: "An anchored node's value is never kept, so every alias of it is refused as invalid instead of sharing it; the property fails (CATCH's evidence, mutant 9532850800)."
		},
		{
			file: "packages/cli-generator/src/load/yaml.ts",
			original: "stringKeys: true,",
			replacement: "stringKeys: false,",
			why: "Plain keys load as the type YAML reads them as (a number, null, a boolean), which strict loading refuses as a key that is no string; the property fails."
		},
		{
			file: "packages/cli-generator/src/load/yaml.ts",
			original: 'schema: "core",',
			replacement: 'schema: "yaml-1.1",',
			why: "Plain words load under YAML 1.1, so `yes`, `on` and a plain date become a boolean and a date instead of the strings written; the property fails."
		}
	]
})

/**
 * A planted hazard is refused with its code, and at its place where the planter knows it. It replaces fourteen example
 * cases, so its rotating stream is fourteen drawn plants; its steered phase reaches each hazard by an aimed plant.
 */
export const yamlHazard = property.explore(planted, {
	needs: {},
	situations: [
		"a duplicate key",
		"a second document",
		"an alias cycle",
		"a sequence as a key",
		"a mapping as a key",
		"a timestamp tag",
		"a binary tag",
		"a custom tag",
		"an infinity",
		"a NaN",
		"an unclosed flow",
		"an unclosed nesting thousands deep",
		"an empty stream",
		"a byte order mark before the hazard",
		"a wide character before the hazard"
	] satisfies ReadonlyArray<Reached<HazardFeature>>,
	check: (_, c: Case<HazardFeature>) => (plant) =>
		Effect.gen(function* () {
			const text = plantedText(plant)
			const expected = expectedRefusal(plant, text)
			c.noteAll(hazardFeatures(plant, text))
			const refused = yield* actualRefusal(bytesOf(plant.doc, text), expected)
			assert.deepEqual(refused, Option.some(expected))
		}),
	oracle: {
		kind: "specification",
		name: "each planted hazard's refusal code, and its pointer, line, column and byte offset where the plant fixes them"
	},
	kept: [],
	budget: { runs: 14, steered: 30 },
	kills: [
		{
			file: "packages/cli-generator/src/model/diagnostic.ts",
			original: "\t\t\trow: rowOfCode(input.code),",
			replacement: "\t\t\trow: Option.none(),",
			why: "The factory finds no row in any code, so every diagnostic is malformed and no refusal can be made; the property fails (CATCH's evidence, mutant 327a1669df, on makeDiagnostic)."
		},
		{
			file: "packages/cli-generator/src/load/yaml.ts",
			original: "uniqueKeys: true,",
			replacement: "uniqueKeys: false,",
			why: "A repeated key is accepted, the later value winning; the property fails."
		},
		{
			file: "packages/cli-generator/src/load/yaml.ts",
			original: "} else if (Predicate.isNumber(value) && !isFinite(value)) {",
			replacement: "} else if (false && Predicate.isNumber(value) && !isFinite(value)) {",
			why: "A non-finite number loads as a JSON value JSON cannot hold instead of being refused; the property fails."
		},
		{
			file: "packages/cli-generator/src/load/offset.ts",
			original: "byteBase + encoder.encode(Str.slice(0, index)(text)).length",
			replacement: "encoder.encode(Str.slice(0, index)(text)).length",
			why: "A refusal's byte offset leaves out the byte order mark before the text; the property fails."
		}
	]
})
