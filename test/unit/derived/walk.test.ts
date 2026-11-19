/**
 * What a definition reads and what inputs it needs (schema/walk.ts queryUses) through an import: the import's bound
 * parameters are the binding's, so an importer needs exactly its own parameters, the import's parameters its binding
 * leaves open (every one, when it matches the import itself), and the parameters its binding expressions use; it
 * reads its own relations and the import's.
 *
 * Property: over drawn imports and importers (a schema of two relations of three uuid fields; an import over one of
 * them whose second and third fields are each left free, bound to a variable or to a parameter named from a pool of
 * three; an importer over one of them that matches the import itself or binds each of the import's parameters to a
 * variable, a parameter of its own from the same pool, a literal, or nothing, and perhaps a parameter of its own in
 * a condition), queryUses' inputs and relations are exactly the rule's, each compared as a set.
 *
 * Oracle: the rule above, stated over the sketch (expectedInputs).
 *
 * Features: an input bound to a variable, to an importer's parameter, to a literal, or left open; the import matched
 * itself; an importer's parameter named as an import's; a parameterless importer of a parameterized import.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { queryUses } from "#compiler/schema/walk.ts"
import { assert, defined } from "#test/support/assert.ts"
import {
	expectedInputs,
	featuresOf,
	importCaseGen,
	importerOf,
	type ImportFeature
} from "#test/unit/derived/walk.fixtures.ts"

/**
 * QueryUses over imports needs exactly the parameters an import's binding leaves open or uses, beside its own, and
 * reads the import's relations.
 *
 * Budget: 200 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/derived/walk.test.ts:195 at 8cad5bce, its runs and its coverage's cases).
 */
export const queryUsesOverImportsNeedsExactlyTheParametersAnImportsBindingLeavesOpenOrUsesBesideItsOwnAndReadsTheImportsRelations =
	property.explore(importCaseGen, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: [
			"an input bound to a variable",
			"an input bound to an importer's parameter",
			"an input bound to a literal",
			"an input the binding leaves open",
			"the import matched itself",
			"an importer's parameter named as an import's",
			"a parameterless importer of a parameterized import"
		] satisfies ReadonlyArray<Reached<ImportFeature>>,
		check: (_, k: Case<ImportFeature>) => (c) =>
			Effect.sync(() => {
				const desc = defined(queryValueDesc(importerOf(c)), "a query value the builder made")
				const uses = queryUses(desc)
				const inputs = Arr.sort([...uses.inputs], Order.String)
				assert.deepEqual<ReadonlyArray<string>>(inputs, expectedInputs(c))
				assert.deepEqual<ReadonlyArray<string>>(
					Arr.sort([...uses.relations], Order.String),
					Arr.sort(Arr.dedupe([`R${c.imported}`, `R${c.importer}`]), Order.String)
				)
				k.noteAll(featuresOf(c, inputs))
			}),
		oracle: {
			kind: "specification",
			name: "an importer's inputs are its own, the import's its binding leaves open, and those its binding expressions use"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/walk.ts",
				original:
					'\t\t\tconst name = input.startsWith("parameter ")\n\t\t\t\t? input.slice("parameter ".length)\n\t\t\t\t: input.startsWith("relation parameter ")\n\t\t\t\t\t? input.slice("relation parameter ".length)\n\t\t\t\t\t: undefined\n\t\t\tif (name === undefined || !bound.has(name)) {\n\t\t\t\tthis.inputs.add(input)\n\t\t\t}\n\t\t}',
				replacement: "\t\t\tthis.inputs.add(input)\n\t\t}\n",
				why: "queryUses keeps every input of a bound import, its bound parameters included."
			}
		]
	})
