/**
 * Which roster a roster continues, drafted with no database: generated histories of two rosters and a stored relation T
 * whose fields r and q hold closed ids and s a set, each over a roster or moved to smallint. A step is one change and
 * exactly the declarations it needs, as a person types them: a handle added, removed (`--drop R#h`) or renamed
 * (`--rename R#h=k`); a roster renamed (`--rename R=S`), renamed without the declaration, which is its drop and a new
 * roster (`--drop R`), respelled to an alike name (no declaration), renamed to the name of another it drops (`--rename
 * R=S --drop S`), or swapped with another; a new roster; or a field moved to another roster or to or from smallint.
 *
 * The oracle is a second implementation of a roster's history: each roster of the model keeps its own codes, a handle
 * its code across every rename of its own or of its roster, a removed one a hole, a new one the next code, and a roster
 * that does not continue another starts afresh; each field knows the roster its stored values are handles of. Each step
 * is drafted as `grizzle generate` drafts it (the kit's draftCodes, compile and generate) from the snapshot the step
 * before wrote, read back as snapshot.json is read, and holds:
 *
 * - the draft is admitted: every step declares exactly what it drops and renames, in its codes' order;
 * - every roster's drafted codes are the model's, so a stored code of a field whose roster continues reads as the
 *   handle it was written as, renamed or not, or is a hole the migration's validation refuses, and never as another
 *   handle;
 * - a field whose values the model moves to a roster its own does not continue as, or to or from smallint, is converted
 *   at its placeholder, by the reviewer, and no other field is: a code is never cast into another roster's meaning.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type Feature,
	featureNames,
	run,
	sketchGen
} from "#test/unit/deploy/continuity.fixtures.ts"

/** Roster continuity carries every roster's codes on through renames, respellings, takes and swaps, and converts a field whose values move to another roster's meaning at its placeholder. Its budget is its suite's before it was a property (test/unit/deploy/continuity.test.ts at 4ca3036a): 40 runs and 120 steered cases. */
export const rosterContinuityCarriesEveryRostersCodesOnThroughRenamesRespellingsTakesAndSwapsAndConvertsAFieldWhoseValuesMoveToAnotherRostersMeaningAtItsPlaceholder =
	property.explore(sketchGen, {
		needs: {},
		budget: { runs: 40, steered: 120 },
		situations: featureNames satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (sketch) => Effect.sync(() => run(sketch, c)),
		oracle: {
			kind: "second-implementation",
			name: "a model of each roster's code history and of the roster each field's values are handles of"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/codes.ts",
				original: "\t\tconst before = continued.get(roster.closed) ?? []",
				replacement: "\t\tconst before = continued.get(roster.closed) === undefined ? [] : []",
				why: "Every roster's codes are drafted afresh, none continued (ir/codes.ts draftCodebook); the draft is refused as a defect by generate's continuity check (deploy/render/generate.ts discontinuedRoster), so no step is admitted."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: "\t\t...rosters.flatMap(({ codec, fate }) => named(codec, fate))\n",
				replacement:
					'\t\t...rosters.flatMap(({ codec, fate }) => named(codec, fate)),\n\t\t...rosters.flatMap(({ codec, fate }) =>\n\t\t\tfate.kind === "continued" && fate.as !== codec.roster ? named({ ...codec, roster: fate.as }, fate) : []\n\t\t)\n',
				why: "A roster continued under another's name restates that roster's constants over its own (deploy/diff/diff.ts rosterConstantsOf, as a7da80408 wrote it): a take of a dropped roster's name, both of the same live codes, reads the dropped roster's aside domain as continued into the taker, so its field's codes are cast into the taker's meaning, no placeholder (trunk's floor case 6 at f6182478, KindA taken by TierB)."
			}
		]
	})
