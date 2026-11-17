/**
 * An SSE response's event contract is read from its media type's `itemSchema` as the event lifecycle states it: each
 * branch of its `oneOf` or `anyOf` union, or the schema itself, names an event by its `event` property's one value; its
 * data is JSON when its `data` property's `contentMediaType` is; its `x-stream` gives its role, a ready role perhaps
 * with the one event that follows it (`next`). A union whose every branch names its event is closed; otherwise the
 * branches that name no event say how other events' data prints. A malformed `x-stream`, one on an unnamed branch, a
 * `retryWhen` on text data, one event named twice with different rows and a `next` naming no event of the contract are
 * refused at operation scope, so a lifecycle is never guessed.
 *
 * Generated item schemas: unions of up to four branches, each written inline, behind a `$ref` or through `allOf`, its
 * event named by `const` or a one-member `enum` or not at all, its data JSON (with a `contentSchema` or none, the
 * row then naming that schema by its store key: inline, a bare `$ref` to a component, or a `$ref` beside an asserting
 * keyword), text or undeclared, its `x-stream` absent,
 * one of its forms (a ready role with a `next` among them), or malformed. Oracle: the reading's specification, applied
 * to the generated branches; and every key a row names for its data's schema is one the document's schema store
 * (normalizeSchemas) holds, so the emitter finds the schema the data is checked against.
 *
 * Features: each placement, each union form, each finding, a contract with a retry rule, JSON data for other events,
 * the open contract, a closed contract, a ready role with its next event, a name repeated with the same row.
 */

import { deepStrictEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualOf,
	expectedOf,
	itemSpace,
	type ReadingFeature,
	readingFeatures,
	unstoredKeys
} from "#test/normalize/event-stream.fixtures.ts"

/**
 * An SSE response's event contract is read from its itemSchema's branches as the lifecycle states it, or refused
 * at operation scope. Its budget is the count its suite stated
 * before the conversion: 500 independent cases, and up to 2000 steered while a situation is unreached.
 */
export const eventContract = property.explore(itemSpace, {
	needs: {},
	situations: [
		"inline branch",
		"branch behind a reference",
		"branch through allOf",
		"anyOf union",
		"schema alone",
		"role refused as malformed",
		"role on an unnamed branch",
		"retry rule on text data",
		"event named twice",
		"event named twice alike",
		"retry rule read",
		"JSON data for other events",
		"open contract",
		"closed contract",
		"ready role with its next event",
		"next naming no event",
		"data its contentSchema checks",
		"data a bare $ref checks",
		"data a $ref beside an asserting keyword checks"
	] satisfies ReadonlyArray<Reached<ReadingFeature>>,
	check: (_, c: Case<ReadingFeature>) => (schema) =>
		Effect.gen(function* () {
			const expected = expectedOf(schema)
			const actual = yield* actualOf(schema)
			c.noteAll(readingFeatures(schema, expected))
			deepStrictEqual(actual, expected)
			const unstored = yield* unstoredKeys(schema, actual)
			deepStrictEqual(unstored, [], "every data schema a row names is stored")
		}),
	oracle: {
		kind: "specification",
		name: "the event lifecycle's reading, applied to the generated branches"
	},
	kept: [],
	budget: { runs: 500, steered: 2000 },
	kills: [
		{
			file: "packages/generator/src/normalize/event-stream.ts",
			original:
				'([, row]) => "next" in row && !Arr.some(events, (event) => event.name === row.next)',
			replacement:
				'([, row]) => "next" in row && !Arr.some(events, (event) => event.name === row.next) && false',
			why: "A ready role's `next` that names no event of the contract is accepted, so the lifecycle waits for an event that never comes; the property fails."
		},
		{
			file: "packages/generator/src/normalize/event-stream.ts",
			original:
				"if (Arr.isReadonlyArrayNonEmpty(events) && !Arr.isReadonlyArrayNonEmpty(unnamed)) {",
			replacement:
				"if (Arr.isReadonlyArrayNonEmpty(events) && !Arr.isReadonlyArrayNonEmpty(unnamed) && false) {",
			why: "A union whose every branch names its event is read as an open contract, so an event of any other type passes as text; the property fails."
		},
		{
			file: "packages/generator/src/normalize/event-stream.ts",
			original: "(media) => ({ at: data.at, schema: media.contentSchema !== undefined })",
			replacement:
				"(media) => ({ at: data.at, schema: false && media.contentSchema !== undefined })",
			why: "dataOf ignores a branch's `contentSchema`, so JSON data its schema checks is read as JSON no schema checks; the property fails."
		},
		{
			file: "packages/generator/src/normalize/schemas.ts",
			original: "if (schemaKeyAt(resolution, site) === key) {",
			replacement:
				'if (schemaKeyAt(resolution, site) === key && !Option.exists(nodeOption(resolution, site), (schema) => isObject(schema) && "$ref" in schema)) {',
			why: "sitesOf stores only a contentSchema that holds no `$ref`, so a `$ref` beside an asserting keyword, whose own key its row names, is never stored; the property fails."
		},
		{
			file: "packages/generator/src/normalize/schemas.ts",
			original: "[key, name]",
			replacement: "[key]",
			why: "A schema under a name map (`properties`, `$defs`) is transformed at its map's path, not its own name's, so every site beneath a named schema is misplaced; the property fails (CATCH's evidence, mutant e2f8c785cb)."
		}
	]
})
