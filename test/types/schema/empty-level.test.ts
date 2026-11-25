/**
 * The empty level's types (test/types/schema/empty-level.ts): a read of no relation over schema.empty, and what roles
 * that hold all, or nothing, of the base make of it, beside reads over levels holding relations the role does not hold;
 * a cell typechecks exactly where the rule admits it. Each statement is a cell of the box; a batch's cells are one
 * program, checked disarmed. Oracle: the rule, stated per cell.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/types/batch/agreement.ts"
import { emptyLevelBox } from "#test/types/schema/empty-level.dictionary.ts"
import { emptyLevelProgram } from "#test/types/schema/empty-level.ts"

/** Admits a read over the empty level on every role, and refuses a read over a level the role does not hold whole. */
export const emptyLevel = boxAgreement(finite(word(emptyLevelBox)), {
	box: "a read over the empty level served by a role holding nothing of the base and by one holding it whole, its rows committed by the first, and reads of the base's relation over the base and over an extension of no relation of its own, served by the first",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: emptyLevelProgram,
	oracle: {
		kind: "specification",
		name: "the empty level is the level below every root, which every role holds whole, and no other level is held without its relations"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/schema/schema.ts",
			original: "type LevelsBelow<B> = [B] extends [never] ? EmptyLevel : LevelsOf<B>",
			replacement: "type LevelsBelow<B> = [B] extends [never] ? never : LevelsOf<B>",
			why: "No root has the empty level below it, so no role's levels hold it: the workloads and the commit of a read over the empty level are refused, and their directive-free cells fail (K3)."
		}
	]
})
