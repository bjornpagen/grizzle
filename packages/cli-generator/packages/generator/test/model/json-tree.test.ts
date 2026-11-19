/**
 * The JSON tree readers (model/json-tree.ts): over drawn trees whose objects hold their keys in any order, `isObject`
 * and `isArray` tell an object from an array, null and the scalars; `stringMember` reads an own string member and
 * nothing else (no prototype member, no member of another type, nothing of a non-object); and `foldJson` folds bottom
 * up, items by index and members in insertion order, each node beneath its parent's tokens from the tokens it starts
 * at, as a reference walk does.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualOf,
	expectedOf,
	type Feature,
	featuresOf,
	treeSpace
} from "#test/model/json-tree.fixtures.ts"

/**
 * A drawn tree reads and folds as the reference walk says. Its budget replaces 6 example cases: 6 independent cases,
 * and up to 20 steered while one of its 10 situations is unreached, each reached by its own aimed arm.
 */
export const jsonTree = property.explore(treeSpace, {
	needs: {},
	situations: [
		"an object",
		"an array",
		"null",
		"a string",
		"a number or a boolean",
		"an own string member read",
		"a member that is no string",
		"a prototype name",
		"keys out of sorted order",
		"a fold from a nonempty start"
	],
	check: (_, k: Case<Feature>) => (c) =>
		Effect.sync(() => {
			k.noteAll(featuresOf(c))
			assert.deepEqual(actualOf(c), expectedOf(c))
		}),
	oracle: {
		kind: "second-implementation",
		name: "a reference walk: kinds by JSON's own types, own members alone, children first in insertion order"
	},
	kept: [],
	budget: { runs: 6, steered: 20 },
	kills: [
		{
			file: "packages/generator/src/model/json-tree.ts",
			original: "Predicate.isObject(value)",
			replacement: "true",
			why: "isObject answers true for every value, so an array, null or a scalar reads as an object; the property fails (CATCH's evidence, mutant 2595d7d4f3)."
		},
		{
			file: "packages/generator/src/model/json-tree.ts",
			original: "Predicate.isObject(value)",
			replacement: "false",
			why: "isObject answers false for every value, so an object's members are never read and it folds as a leaf; the property fails (CATCH's evidence, mutant 704166ffff)."
		}
	]
})
