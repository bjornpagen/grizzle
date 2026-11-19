/**
 * A predicate's canonical encoding is linear in its own terms, whatever the size of the rosters it reads: a closed id's
 * type names its roster by its name and its handles' digest (ir/scalar.ts Roster), taken once as the roster is made, so
 * no literal, column or closed read of a closed id carries the roster's handles.
 *
 * Each case draws a guard, the selection a key of T is over: up to three atoms joined by and or or, each a closed id
 * `kind` compared with a handle, held to an IN list of one, or read through a closed relation `Weight.at("weight",
 * kind)`, or an integer `n` compared with a number; and two sizes of the roster Kind, each drawn by stratum with
 * explicit weights (one handle; a few, up to 64; thousands, from 1,000 to 5,000), every handle's name four digits wide
 * so no name's own length tells two sizes apart, Weight holding a row for each.
 *
 * The oracle is universal, a metamorphic relation: the canonical text of every guard of T's guarded keys, the encoding
 * every digest, law identity and snapshot of the guard reads, holds the same characters at both sizes. Features: each
 * atom, a disjunction, a roster of one handle and one of thousands.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	caseGen,
	encodedAt,
	type EncodingFeature,
	featuresOf
} from "#test/unit/startup/roster-encoding.fixtures.ts"

/**
 * A predicate's canonical encoding holds the same characters whatever the size of the rosters it reads.
 *
 * Budget: its suite's count before the conversion (unit/startup/roster-encoding: 40 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const aPredicatesCanonicalEncodingHoldsTheSameCharactersWhateverTheSizeOfTheRostersItReads =
	property.explore(caseGen, {
		needs: {},
		situations: [
			"a handle compared",
			"an IN list",
			"a closed read",
			"an integer compared",
			"a disjunction",
			"a roster of one handle",
			"a roster of thousands"
		] satisfies ReadonlyArray<Reached<EncodingFeature>>,
		check: (_, k: Case<EncodingFeature>) => (c) =>
			Effect.sync(() => {
				const [small, large] = c.sizes
				const at = encodedAt(c.guard, small)
				assert.ok(at > 0, "a guard encodes")
				assert.equal(
					encodedAt(c.guard, large),
					at,
					`the guard's encoding at ${small} handles against ${large}`
				)
				k.noteAll(featuresOf(c))
			}),
		oracle: {
			kind: "universal",
			name: "a guard's canonical encoding is the same at two sizes of the roster it reads"
		},
		budget: { runs: 40, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/scalar.ts",
				original: `\t\treturn { tag: rosterTags[this.order], payload: \`\${this.closed}:\${this.digest}\` }`,
				replacement: `\t\treturn { tag: rosterTags[this.order], payload: \`\${this.closed}:\${this.handles.length}:\${this.digest}\` }`,
				why: "A roster's canonical form carries its handle count."
			}
		]
	})
