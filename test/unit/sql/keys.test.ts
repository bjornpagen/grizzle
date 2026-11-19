/**
 * The keys of schema objects and their columns (sql/ast.ts nameKey, storedColumnKey), by which every map of objects by
 * name is keyed: two names share a key only where they are one name, two columns only where they are one column of
 * one relation, whatever characters their identifiers hold. A key spelled `<schema>.<name>` was shared by `"p"."q.r"`
 * and `"p.q"."r"`, since a quoted identifier holds a dot.
 *
 * A case draws two names over identifiers of letters, an underscore, a dot, a control character and a letter outside
 * ASCII, each with a column: two names apart, one name twice, two names one dotted text spells, or two columns whose
 * names and their relations' names, joined with nothing between, spell one text.
 *
 * Oracle: the definition, two names alike where their schemas' identifiers and their own are, a specification.
 *
 * Features: one name twice, two names apart, two names one dotted text spells, one column of two names, two columns one
 * joined text spells.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { nameKey, storedColumnKey } from "#compiler/sql/ast.ts"
import { assert } from "#test/support/assert.ts"
import {
	type KeyFeature,
	keyAims,
	keyFeatures,
	pairGen,
	sameName
} from "#test/unit/sql/keys.fixtures.ts"

/** Two names share a key exactly where they are one name, and two columns exactly where they are one column of one name. */
export const twoNamesShareAKeyExactlyWhereTheyAreOneNameAndTwoColumnsExactlyWhereTheyAreOneColumnOfOneName =
	property.explore(aimed(pairGen, keyAims), {
		needs: {},
		situations: [
			"one name twice",
			"two names apart",
			"two names one dotted text spells",
			"one column of two names",
			"two columns one joined text spells"
		] satisfies ReadonlyArray<Reached<KeyFeature>>,
		check: (_, c: Case<KeyFeature>) => (pair) =>
			Effect.sync(() => {
				for (const feature of keyFeatures(pair)) {
					c.note(feature)
				}
				const one = sameName(pair.first, pair.second)
				assert.equal(
					nameKey(pair.first) === nameKey(pair.second),
					one,
					"the two names share a key exactly where they are one name"
				)
				assert.equal(
					storedColumnKey(nameKey(pair.first), pair.firstColumn) ===
						storedColumnKey(nameKey(pair.second), pair.secondColumn),
					one && pair.firstColumn === pair.secondColumn,
					"the two columns share a key exactly where they are one column of one name"
				)
			}),
		oracle: {
			kind: "specification",
			name: "two names alike where their schemas' identifiers and their own are, two columns where their names and their own are"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/ast.ts",
				original: `\tmintNameKey(\`\${name.schema}\\u0000\${name.name}\`)`,
				replacement: `\tmintNameKey(\`\${name.schema}.\${name.name}\`)`,
				why: 'A name\'s key spelled `<schema>.<name>`, as deploy/snapshot/objects.ts nameKey spelled it: "p"."q.r" and "p.q"."r" share one, so a map of objects by name holds one where it holds two; the property fails.'
			},
			{
				file: "packages/engine/src/sql/ast.ts",
				original: `\tmintStoredColumnKey(\`\${table}\\u0000\${column}\`)`,
				replacement: `\tmintStoredColumnKey(\`\${table}\${column}\`)`,
				why: 'A column\'s key with nothing between its relation\'s key and its name: the column "b" of "p"."qa" and the column "ab" of "p"."q" share one; the property fails.'
			}
		]
	})
