/**
 * A parameter takes any name its declaration gives it: no name is a slot source the runtime reads otherwise. A
 * relation parameter under a name drawn from the parameter-name dictionary (kernel/dict.ts parameterNames: a page's own
 * input names, spellings like a source the runtime might read or a page's reserved placeholder identity, then the
 * identifier dictionary's names) binds exactly as one named "items" does: every statement's placeholder texts, the
 * oracle being the program's invariance under renaming its parameter.
 *
 * Features: none required; the name is the whole draw.
 */

import { element } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { parameterNames } from "#test/support/kernel/dict.ts"
import { bound, itemsNeed } from "#test/unit/write/program/names.fixtures.ts"

/**
 * Parameter names bind a relation parameter under any dictionary name as one named items.
 *
 * Budget: 192 runs and 0 steered cases, what its suite stated before it became a property
 * (test/unit/write/program/names.test.ts:65 at 8cad5bce, its runs and its coverage's cases).
 */
export const parameterNamesBindARelationParameterUnderAnyDictionaryNameAsOneNamedItems =
	property.explore(
		(source) => source.draw(element(nonEmpty(parameterNames, "the parameter names"))),
		{
			needs: { itemsNeed },
			budget: { runs: 192, steered: 0 },
			situations: [],
			check:
				({ itemsNeed }) =>
				(name) =>
					Effect.gen(function* () {
						const items = yield* itemsNeed
						return yield* Effect.map(bound(name), (got) => {
							assert.deepEqual(got, items, name)
						})
					}),
			oracle: {
				kind: "universal",
				name: "renaming a relation parameter changes no placeholder text a statement binds"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/runtime/write/bind.ts",
					original: "\tconst paramValue = (name: string): unknown => inputs.params[name]",
					replacement:
						"\tconst paramValue = (name: string): unknown => inputs.params[name.toLowerCase()]",
					why: "A parameter's value read under its name lowercased (runtime/write/bind.ts)."
				}
			]
		}
	)
