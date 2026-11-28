/**
 * A family's owner written through a query entry (test/types/changeset/entry-owner.ts): over every declared case of the
 * entry-owner box (test/support/families/entry-owner.ts), a write through the entry is admitted exactly when its fact
 * states no family field, and refused otherwise with the refusal the engine names. Each case is a cell of the box; a
 * batch's cells are one program, checked disarmed. Oracle: the box's rule, which the engine meets
 * (test/unit/write/entry-owner.test.ts).
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { entryOwnerBox } from "#test/types/changeset/entry-owner.dictionary.ts"
import { entryOwnerProgram } from "#test/types/changeset/entry-owner.ts"

/**
 * Admits every write of a declared role whose fact states no family field, and refuses every other with the refusal its
 * directive names, as the engine does.
 */
export const entryOwner = boxAgreement(finite(word(entryOwnerBox)), {
	box: "every declared case of the entry-owner box: what the entry's head holds of the family, its filter, the op and the fact",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: entryOwnerProgram,
	oracle: {
		kind: "second-implementation",
		name: "the box's fact rule, which the engine meets at bind"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original: '\t\t: Refusal<"a member fact is not a fact of the relation">',
			replacement: "\t\t: unknown",
			why: "A member fact that is no fact of its relation is admitted (types/changeset/changeset.ts MemberFit); the program fails."
		}
	]
})
