/**
 * The codebook (ir/codes.ts): every roster's codes as an installation holds them, drafted from the previous
 * installation's, against a naive history model that shares no code with ir/cells.ts rosterCodes.
 *
 * - The model: each roster is the list of its codes' holders, code c at position c, a hole none, replayed command by
 *   command: a growth appends a new handle, a removal leaves its code a hole, a re-add of a removed name appends it as
 *   a new handle, a rename gives a live code a new holder, and a reorder declares two neighbours swapped, which the draft
 *   refuses with that pair. A command touches one roster alone, and the other roster's codes stay as they were, so a
 *   rename reaches only the roster it is declared for.
 * - Universal oracles: each codec round-trips (handleAt ∘ codeOf is the identity on live handles, codeOf ∘ handleAt on
 *   live codes), names a hole exactly where the model holds none, counts every code minted, and drafting a codebook again
 *   from itself with no rename is the identity.
 *
 * The box, exhausted: two rosters over the names a to d, each first declared as `a`, then every history of up to five
 * commands.
 *
 * Features: a growth, a removal, a re-add, a rename, a reorder, a hole between live codes, both rosters changed.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { histories, replay, type Situation } from "#test/unit/ir/codes.fixtures.ts"

/** The codebook drafts each roster's codes from its own history alone, round-trips every live code, and refuses a reorder. */
export const theCodebookDraftsEachRostersCodesFromItsOwnHistoryAloneRoundTripsEveryLiveCodeAndRefusesAReorder =
	property.exhaust(finite(histories), {
		needs: {},
		situations: [
			"a growth",
			"a removal",
			"a re-add",
			"a rename",
			"a reorder",
			"a hole between live codes",
			"both rosters changed"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (value) => replay(value, c),
		oracle: { kind: "second-implementation", name: "a naive history model of each roster" },
		box: "two rosters over four names, every history of up to five commands",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/codes.ts",
				original: "\t\tsize: codes.length,",
				replacement: "\t\tsize: codeOf.size,",
				why: "A codec's size counts its live codes alone, not every code minted, holes included; the universal oracles' count of every code minted fails."
			}
		]
	})
