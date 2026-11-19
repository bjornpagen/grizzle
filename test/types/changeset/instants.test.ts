import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/types/batch/agreement.ts"
/**
 * An instant's types (test/types/changeset/instants.ts): over every way a caller may write, state or compare an
 * instant, a cell typechecks exactly where the rule admits it, an instant being the database's alone, and a refused one
 * names the refusal its directive states, or none where the types refuse it as no fact of its relation or no operand of
 * its comparison. Each statement is a cell of the box; a batch's cells are one program, checked disarmed. Oracle: the
 * rule, stated per cell.
 */
import { instantsBox } from "#test/types/changeset/instants.dictionary.ts"
import { instantsProgram } from "#test/types/changeset/instants.ts"

/** Admits every write of an instant the rule admits, and refuses every other with the refusal its directive names. */
export const instants = boxAgreement(finite(word(instantsBox)), {
	box: "an insert, a put and a delete of host rows and of a query's, an instant stated from a stored one, a parameter, a relation parameter's column, a literal, a typed constant and a cast of its type, a contract named instant or over one, a span of instants, and instants compared with a literal and with instants",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: instantsProgram,
	oracle: {
		kind: "specification",
		name: "an instant is the database's alone: no value a caller holds is one"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/fields/field.ts",
			original: "\t\t: [D] extends [InstantDomain]\n",
			replacement: "\t\t: [D] extends [never]\n",
			why: "No domain reads as an instant's, so a parameter, a typed constant, a cast, a contract and a span of instant's type typecheck and their directives are unused; the program fails."
		},
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original: "\t\t\t? Omit<F, InstantFieldsOf<R>>\n",
			replacement: "\t\t\t? F\n",
			why: "A host row may state an instant, so an insert of host rows stating the clock typechecks and its directive is unused; the program fails."
		}
	]
})
