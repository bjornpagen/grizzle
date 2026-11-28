/**
 * The exact fields' types (test/types/schema/exact-fields.ts): over every way a caller declares, writes, reads and
 * compares an exactInteger or an exactMoney field, a cell typechecks exactly where the rule admits it, and a refused one
 * names the refusal its directive states, or none where the types refuse it as another host value. Each statement is a
 * cell of the box; a batch's cells are one program, checked disarmed. Oracle: the rule, stated per cell.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { exactFieldsBox } from "#test/types/schema/exact-fields.dictionary.ts"
import { exactFieldsProgram } from "#test/types/schema/exact-fields.ts"

/** Admits every declaration, write and read of an exact field the rule admits, and refuses every other as its directive names. */
export const exactFields = boxAgreement(finite(word(exactFieldsBox)), {
	box: "an exact field's descriptor type, an insert of host rows of its host value and of another, a query member's exact sums into it and into a plain field, its own arithmetic written back, a parameter and a literal compared with it, a generated field of it, and a contract over it",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: exactFieldsProgram,
	oracle: {
		kind: "specification",
		name: "an exact field holds its carrier's exact values as they are, its host bigint or Money, and no contract is over one"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/fields/field.ts",
			original: 'export type ExactIntegerField = Field<bigint, "exact integer">',
			replacement: 'export type ExactIntegerField = Field<bigint, "bigint">',
			why: "An exact integer field is typed a bigint's, so a query's exact sum is refused where it is written into it, as into a plain field, and its directive-free cell fails; the program fails."
		},
		{
			file: "packages/engine/src/types/fields/constructors.ts",
			original: '[Sql] extends ["exact integer" | "exact money"]',
			replacement: "[Sql] extends [never]",
			why: "A contract over an exact field typechecks, and its directive is unused; the program fails."
		}
	]
})
