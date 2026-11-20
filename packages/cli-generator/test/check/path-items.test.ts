/**
 * The entry document's walk (check/path-items.ts and check/structure.ts): the structure check refuses a Components
 * Object key exactly when the specification's component-name grammar refuses it, and the path items the checks walk are
 * the document's `paths` entries in order, each at its use site and standing for the object its references end at.
 *
 * Oracle: the OpenAPI specification's Components Object (its key grammar, `^[a-zA-Z0-9\.\-_]+$`, and each line's maps),
 * its Path Item Object and Reference Object, and RFC 6901's pointer escapes.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	expectedKeyDiagnostics,
	expectedWalked,
	type ItemFeature,
	itemFeaturesOf,
	itemsSpace,
	keyDiagnosticsOf,
	type KeyFeature,
	keyFeaturesOf,
	keysSpace,
	walkedOf
} from "#test/check/path-items.fixtures.ts"

/** Every key of a Components Object map is refused as CMP-13 exactly when the component-name grammar refuses it. */
export const componentKeys = property.explore(keysSpace, {
	needs: {},
	situations: [
		"a key the grammar admits",
		"a key the grammar refuses",
		"the empty key",
		"a refused key under pathItems",
		"a refused key under mediaTypes"
	],
	check: (_, k: Case<KeyFeature>) => (c) =>
		Effect.gen(function* () {
			k.noteAll(keyFeaturesOf(c))
			const diagnostics = yield* keyDiagnosticsOf(c)
			assert.deepEqual(
				diagnostics,
				expectedKeyDiagnostics(c),
				"each key outside the component-name grammar is refused at its pointer, and no other"
			)
		}),
	oracle: {
		kind: "specification",
		name: "the Components Object's key grammar ^[a-zA-Z0-9\\.\\-_]+$ over each line's maps"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/check/structure.ts",
			original: "([name]) => !isComponentName(name)",
			replacement: "([name]) => isComponentName(name)",
			why: "The structure check refuses every component key the grammar admits and admits every one it refuses; the property fails."
		},
		{
			file: "packages/cli-generator/src/model/brands.ts",
			original: 'regex("^[a-zA-Z0-9.\\\\-_]+$", "u")',
			replacement: 'regex("^[a-zA-Z0-9.\\\\-_]*$", "u")',
			why: "The component-name grammar admits the empty key, which the specification's `+` refuses; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/structure.ts",
			original: '"3.2": [...sections30, "pathItems", "mediaTypes"]',
			replacement: '"3.2": [...sections30, "pathItems"]',
			why: "On 3.2 the keys of components.mediaTypes go unchecked, so a media type component named outside the grammar is admitted; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/structure.ts",
			original: "A component key is outside ",
			replacement: "A component key is invalid, outside ",
			why: "CMP-13's message no longer states the grammar a key falls outside as the specification words it; the property fails."
		}
	]
})

/** The path items the checks walk are the `paths` entries in order, each standing for the end of its reference chain. */
export const entryPathItems = property.explore(itemsSpace, {
	needs: {},
	situations: [
		"an inline path item",
		"a referenced path item",
		"a chain of references",
		"a key a pointer escapes ~ in",
		"several path items"
	],
	check: (_, k: Case<ItemFeature>) => (c) =>
		Effect.gen(function* () {
			k.noteAll(itemFeaturesOf(c))
			const walked = yield* walkedOf(c)
			assert.deepEqual(
				walked,
				expectedWalked(c),
				"every entry in order, at its use site, standing for the object its references end at"
			)
		}),
	oracle: {
		kind: "specification",
		name: "the Paths Object's entries, the Reference Object's target and RFC 6901's escapes"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/resolve/index.ts",
			original: "sites.push({ base, kind: item.kind, member, node, pointer, ref })",
			replacement: "{}",
			why: "The resolver records no reference site, so a referenced path item stands for its own Reference Object rather than the item it names; the property fails (TESTPOLICY2's census, mutant 1e272f42af)."
		},
		{
			file: "packages/cli-generator/src/check/path-items.ts",
			original: "pointer: located.pointer",
			replacement: "pointer: use",
			why: "A referenced path item is walked at its use site, so the checks read its operations at a pointer that holds only a $ref; the property fails."
		},
		{
			file: "packages/cli-generator/src/check/path-items.ts",
			original: "located.document === resolution.document",
			replacement: "located.document !== resolution.document",
			why: "The walk keeps only the path items another document holds, so no entry of the entry document is checked; the property fails."
		}
	]
})
