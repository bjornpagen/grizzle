import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
/**
 * A call of a declared function passes a closed id of its argument's own roster alone (test/types/compute/calls.ts):
 * over every form an argument of a closed id is passed by, a term, a handle, a name, a code or rows of a query, a cell
 * is admitted exactly where the value is of the argument's roster, and refused where it is another roster's, a name
 * no handle has or a code. Each form is a cell of the box; a batch's cells are one program, checked disarmed. Oracle:
 * the rule every term meets by, a closed id standing only where a value of its own roster does.
 */
import { boxAgreement } from "#test/types/batch/agreement.ts"
import { callsBox } from "#test/types/compute/calls.dictionary.ts"
import { callsProgram } from "#test/types/compute/calls.ts"

/** Over every form an argument of a closed id is passed by, admits exactly its own roster's values. */
export const calls = boxAgreement(finite(word(callsBox)), {
	box: "every form a call of a declared function passes an argument of a closed id by: a term, a handle, a name, a code and rows of a query, of its own roster and of another",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: callsProgram,
	oracle: {
		kind: "specification",
		name: "the rule every term meets by: a closed id stands only where a value of its own roster does"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/compute/call.ts",
			original: "\t\t\t? Meets<D, S> | LiteralOf<H>",
			replacement: "\t\t\t? Meets<unknown, S> | LiteralOf<H>",
			why: "An argument meets any term of its SQL type, whatever its domain, so a variable of another roster's ids typechecks and its directive is unused; the program fails."
		}
	]
})
