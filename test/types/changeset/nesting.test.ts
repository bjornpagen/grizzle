/**
 * Tree inserts typed by member types of any depth (test/types/changeset/nesting.ts): over the exhaustive box of forms,
 * chains of member types, back edges and excess fields, an insert is admitted exactly when no type it declares states a
 * field beyond its nesting's, at whatever depth its types recur, and refused otherwise. Each case is a cell of the box;
 * a batch's cells are one program, checked disarmed. Oracle: the box's rule over the types each case declares.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { nestingBox } from "#test/types/changeset/nesting.dictionary.ts"
import { nestingProgram } from "#test/types/changeset/nesting.ts"

/**
 * Admits every case whose types state no field beyond their nesting's, at whatever depth they recur, and refuses every
 * other with the refusal its directive names.
 */
export const nesting = boxAgreement(finite(word(nestingBox)), {
	box: "every form of member type (interface, alias, intersection) by every chain of one to three node member types, every back edge of the last, and every field a type states beyond its nesting's, or none",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: nestingProgram,
	oracle: { kind: "specification", name: "the box's rule over the types each case declares" },
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
