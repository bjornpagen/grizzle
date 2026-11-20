/**
 * Normalization across a document set (design 3.7, 5): a schema, a parameter and a response read from a second
 * document normalize to the same model as when written in place; the schema store holds every schema root a use
 * reaches under its canonical key (a component of the entry by its name, a site of the entry by its pointer, a node
 * of another document by its URI and pointer); the model lists the set's documents, entry first; a diagnostic inside
 * another document names that document and the pointer of its node there; and nodeOption reads a node of the set,
 * none for a document outside it or a pointer to nothing.
 *
 * Oracle: the inlined twin of each drawn set (metamorphic), and the canonical keys and sites design 5 states for it.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	expectedOf,
	inlinedOf,
	readingOf,
	type SetFeature,
	setFeatures,
	setSpace
} from "#test/normalize/document-set.fixtures.ts"

/**
 * Shared elements normalize alike wherever they are written, under canonical keys, with their diagnostics in place.
 * Its budget replaces the five example cases of the suite it converts, each over every placement it drew, three times.
 */
export const documentSet = property.explore(setSpace, {
	needs: {},
	situations: [
		"schema in a second document",
		"parameter in a second document",
		"response in a second document",
		"schema among the entry's components",
		"schema inline",
		"diagnostic inside a second document",
		"single document"
	] satisfies ReadonlyArray<Reached<SetFeature>>,
	check: (_, c: Case<SetFeature>) => (sketch) =>
		Effect.gen(function* () {
			c.noteAll(setFeatures(sketch))
			const across = yield* readingOf(sketch)
			const inline = yield* readingOf(inlinedOf(sketch))
			assert.deepEqual(across.meaning, inline.meaning, "the set normalizes as its inlined twin")
			assert.deepEqual(
				{ keys: across.keys, documents: across.documents, diagnostics: across.diagnostics },
				expectedOf(sketch)
			)
			assert.deepEqual(across.unread, [], "every diagnostic names a node of its document")
			assert.ok(
				across.absent[0] === true && across.absent[1] === true && across.absent[2] === true,
				"nodeOption reads the set"
			)
		}),
	oracle: {
		kind: "specification",
		name: "the inlined twin of the drawn set, and design 5's canonical keys and sites"
	},
	kept: [],
	budget: { runs: 16, steered: 128 },
	kills: [
		{
			file: "packages/cli-generator/src/resolve/index.ts",
			original: "\treturn tokens === undefined ? undefined : formatPointer(tokens)",
			replacement: "\treturn tokens !== undefined ? undefined : formatPointer(tokens)",
			why: "A reference's fragment is read as no pointer whenever it holds one, so no reference into another document resolves; the property fails (CATCH's evidence, mutant 0b47ff02a3)."
		},
		{
			file: "packages/cli-generator/src/normalize/parameters.ts",
			original: "node.schema !== undefined && node.content !== undefined",
			replacement: "node.schema !== undefined",
			why: "A parameter with a schema is read as carrying both schema and content, so it is unreadable and normalization fails; the property fails (CATCH's evidence, mutant 82b625ad9d)."
		},
		{
			file: "packages/cli-generator/src/normalize/schemas.ts",
			original: 'key !== "$id"',
			replacement: "false",
			why: "The store drops every member of every stored schema, so a schema's pattern is never seen and its not-asserted notice is lost; the property fails (CATCH's evidence, mutant 8f8a5cd8d6)."
		}
	]
})
