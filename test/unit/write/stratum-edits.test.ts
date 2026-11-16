/**
 * Each stratum's family statements are its own (write/frontend/compile.ts familyWritesOf, write/program/compile.ts
 * familyProgram): a stratum plans an additions or removals statement of a member relation for its own edits of it and
 * its own nested writes alone, and every member slot and nested rows a family statement reads are of its stratum. A
 * stratum that planned another stratum's edits again would change nothing a lawful ChangeSet stores: a family's members
 * are written in one stratum, so the edit planned again deletes nothing and its inserts meet exact repeats. No stored
 * state shows that doubled work (test/pg/write/strata-families), and the compiled program does.
 *
 * The box, constructed: a counted family of Members under Clubs and an ordered family of Lines under Docs, each owner
 * mutable, and Tags of no family. A case edits Members (inserts, deletes and puts, at least one), Lines (deletes and
 * puts, at least one: a Line is inserted only nested under its Doc), or both, in one stratum, as the front end
 * requires; inserts beside the edits in their stratum any of Docs, each nesting its Lines, Tags and Clubs; and puts up
 * to one stratum before it and one after it, each inserting at least one of them. Every member is an array a call
 * gives, so every edit is a slot. The box puts no owner and no family copies a value, so no stratum refills: the front
 * end's refills are held to none.
 *
 * - Property: the front end's family statements of each stratum, and the compiled program's placements, are exactly the
 *   model's, each once; every member slot and nested rows a family statement reads are its own stratum's; and each
 *   edit's slots and each stratum's nested rows are read by a family statement of their stratum, so each is read in its
 *   own stratum and in no other.
 * - Oracle: each stratum's own inputs restated (schedule.ts FamilyRemovals, FamilyAdditions), the front end's edits and
 *   nested writes of the stratum, each held first to the case's: a removals statement of each member relation its
 *   edits put or delete, an additions statement of each one its edits insert or put or its nested writes fill, and
 *   nothing else, so the program's total is the sum of its strata's. Never the statements' text.
 * - Features: a nested insert in a stratum before the edits, after them and beside them; the edits beside a stratum of
 *   no family statement; a put Line nested in another stratum; edits of two families.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property as propertyOf } from "@bjornpagen/testing/property"
import { type Feature, property, sketchGen } from "#test/unit/write/stratum-edits.fixtures.ts"

/** A ChangeSet's family statements plan each stratum's own edits and nested writes, in that stratum alone. */
export const aChangeSetsFamilyStatementsPlanEachStratumsOwnEditsAndNestedWritesInThatStratumAlone =
	propertyOf.explore(sketchGen, {
		needs: {},
		situations: [
			"a nested insert before the edits",
			"a nested insert after the edits",
			"a nested insert beside the edits",
			"the edits beside a stratum of no family statement",
			"a put Line nested in another stratum",
			"edits of two families"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (value) => property(value, c),
		oracle: {
			kind: "specification",
			name: "each stratum's own edits and nested writes restated: a removals statement of each member it puts or deletes, an additions statement of each it inserts, puts or nests"
		},
		kept: [],
		kills: []
	})
