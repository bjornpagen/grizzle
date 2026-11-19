/**
 * A FieldId (core/ids.ts FieldId) is the injective spelling of a (relation, field) pair: each component's '%' and '.'
 * percent-escaped, the components joined at the one unescaped dot.
 *
 * - Injective: two pairs spell one FieldId exactly when they are one pair.
 * - Decodes back: the spelling split at its dots, each part's escapes read back, is the pair it spells.
 *
 * Oracle: the specification of the escape, as a decoder: a spelling's parts at each dot, "%2E" read as a dot and "%25"
 * as a percent sign, so a correct spelling has exactly two parts and they are the pair.
 *
 * Inputs: a component is built of tokens, each a printable character, a dot, a percent sign, or one of the escape's own
 * spellings, "%2E" and "%25", written literally; the pairs compared are two drawn apart, one drawn twice, or the
 * boundary attack, (r + ".", f) against (r, "." + f), which a spelling that escaped nothing would join as one.
 *
 * Features: which pair relation a case draws, and which tokens its components hold.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { FieldId } from "#compiler/core/ids.ts"
import {
	type Feature,
	noteTokens,
	sketch,
	spelledParts,
	textOf
} from "#test/unit/core/ids.fixtures.ts"

/** FieldId is injective in (relation, field) and decodes back. Its budget is its suite's before it was a property (test/unit/core/ids.test.ts at 4ca3036a): 1000 runs and 200 steered cases. */
export const fieldIdIsInjectiveInRelationFieldAndDecodesBack = property.explore(sketch, {
	needs: {},
	budget: { runs: 1000, steered: 200 },
	situations: [
		"pairs drawn apart",
		"one pair twice",
		"the boundary moved",
		"a dot in a component",
		"a percent sign in a component",
		"an escape's spelling written literally",
		"an empty component"
	] satisfies ReadonlyArray<Reached<Feature>>,
	check:
		(_, c: Case<Feature>) =>
		({ relation, first, second }) =>
			Effect.sync(() => {
				const [r1, f1] = [textOf(first[0]), textOf(first[1])]
				const [r2, f2] = [textOf(second[0]), textOf(second[1])]
				const a = FieldId(r1, f1)
				const b = FieldId(r2, f2)
				assert.equal(a === b, r1 === r2 && f1 === f2, "one spelling exactly for one pair")
				assert.deepEqual(spelledParts(a), [r1, f1])
				assert.deepEqual(spelledParts(b), [r2, f2])
				c.note(relation)
				for (const tokens of [...first, ...second]) {
					noteTokens(tokens, c)
				}
			}),
	oracle: { kind: "specification", name: "the escape's decoding at each unescaped dot" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/core/ids.ts",
			original: '\tcomponent.replaceAll("%", "%25").replaceAll(".", "%2E")',
			replacement: '\tcomponent.replaceAll(".", "%2E")',
			why: 'the percent sign left unescaped, so a literal "%2E" and a dot spell one component; the FieldId property (injective, decodes back) fails.'
		},
		{
			file: "packages/engine/src/core/ids.ts",
			original: '\tcomponent.replaceAll("%", "%25").replaceAll(".", "%2E")',
			replacement: '\tcomponent.replaceAll(".", "%2E").replaceAll("%", "%25")',
			why: 'the dot escaped before the percent sign, so a dot reads back as "%2E"; the FieldId property (injective, decodes back) fails.'
		}
	]
})
