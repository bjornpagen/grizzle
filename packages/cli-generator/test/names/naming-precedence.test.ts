/**
 * Design 4.4's naming precedence (names/plan.ts commandName, the names plan's groups): over operations drawn with every
 * naming source the plan reads, each operation's names from its own words so none collide, a primary command's group
 * comes from the author config, else `x-forge-group-name`, else `x-fern-sdk-group-name`, else the first tag, and its
 * name from the author config, else `x-forge-method-name`, else `x-fern-sdk-method-name`, else the operationId fold
 * with the group-word drop, else the route; an `x-forge-aliases` entry names itself from its own Forge, else Fern,
 * method and group, else the fold of its own operationId; an author-config alias list replaces the extension's, each
 * alias its own method (else the operation's default name) and group; a skipped operation plans nothing; and every
 * command carries the sources that named it.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualOf,
	expectedOf,
	type Feature,
	featuresOf,
	precedenceSpace
} from "#test/names/naming-precedence.fixtures.ts"

/**
 * Drawn operations are named as the precedence model says. Its budget replaces 29 example cases: 29 independent cases,
 * and up to 30 steered while one of its 15 situations is unreached, each reached by its own aimed arm.
 */
export const namingPrecedence = property.explore(precedenceSpace, {
	needs: {},
	situations: [
		"a command named by config",
		"a command named by x-forge",
		"a command named by x-fern",
		"a command named by operationId",
		"a command named by route",
		"a group named by config",
		"a group named by x-forge",
		"a group named by x-fern",
		"a group named by tag",
		"a group named by none",
		"a group word dropped",
		"an extension alias",
		"a config alias",
		"a skipped operation",
		"a nested extension group"
	],
	check: (_, k: Case<Feature>) => (c) =>
		Effect.gen(function* () {
			k.noteAll(featuresOf(c))
			const actual = yield* actualOf(c)
			assert.deepEqual(actual, expectedOf(c))
		}),
	oracle: {
		kind: "second-implementation",
		name: "design 4.4's precedence of naming sources for groups, commands and aliases, from commandName's stated rules"
	},
	kept: [],
	budget: { runs: 29, steered: 30 },
	kills: [
		{
			file: "packages/cli-generator/src/names/index.ts",
			original: "map.set(key, [value])",
			replacement: "{}",
			why: "Grouping by key never starts a key's list, so commands and groups are never gathered and the plan names nothing; the property fails (CATCH's evidence, mutant e77c4f92f1)."
		},
		{
			file: "packages/cli-generator/src/names/plan.ts",
			original:
				'if (naming?.forge?.method !== undefined) {\n\t\treturn sourced(foldKebab(naming.forge.method), "x-forge")\n\t}',
			replacement: "{}",
			why: "x-forge-method-name names no command, so an operation with one is named by Fern or its operationId instead; the property fails (CATCH's evidence, mutant 79ad791529)."
		}
	]
})
