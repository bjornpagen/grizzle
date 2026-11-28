/**
 * Time's types (test/types/compute/time.ts): over every operand Time.wall, Time.epochDay and Time.dateOfEpochDay take
 * or refuse, a cell typechecks exactly where the rule admits it, and a refused one names the refusal its directive
 * states, or none where the types refuse it as no operand of the member. Each statement is a cell of the box; a batch's
 * cells are one program, checked disarmed. Oracle: the rule, stated per cell.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { timeBox } from "#test/types/compute/time.dictionary.ts"
import { timeProgram } from "#test/types/compute/time.ts"

/** Admits every operand of Time's members the rule admits, and refuses every other with the refusal its directive names. */
export const timeTypes = boxAgreement(finite(word(timeBox)), {
	box: "a zone's wall clock at a bigint, at a closed id of an ordered roster, at an integer, at an instant and at a literal; a date's epoch day and a bigint's; the date of an integer, a bigint and a date epoch day; and what each delivers, a bigint, a number and a CalendarDate",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: timeProgram,
	oracle: {
		kind: "specification",
		name: "Time.wall reads a bigint term, never an instant, and a zone roster's closed id; Time.epochDay a date; Time.dateOfEpochDay an integer or a bigint"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/compute/compute.ts",
			original: "\twall<A extends TermBase | FirstValue, X, PA, OA, Z extends Zoned, PZ, OZ>(",
			replacement: "\twall<A extends TermBase | FirstValue, X, PA, OA, Z, PZ, OZ>(",
			why: "Time.wall takes a closed id of any roster as its zone, so the cell reading an ordered roster's typechecks and its directive is unused; the program fails."
		},
		{
			file: "packages/engine/src/types/core/phantom.ts",
			original: "\t\t? Rostered<Name> & Unordered & Zoned\n",
			replacement: "\t\t? Rostered<Name> & Unordered\n",
			why: "A zone roster's closed id carries no Zoned, so the cells reading Zone's closed id as Time.wall's zone are refused; the program fails."
		}
	]
})
