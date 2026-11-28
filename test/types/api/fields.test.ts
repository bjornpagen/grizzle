/**
 * The term-is-no-field program (test/types/api/fields.ts): every public reader that takes a field, a relation's and a
 * generated relation's heading, accumulated's, generated's and a contract's type, and codecText's, lexicalForm's and
 * lexical's field, refuses a term in its place, as each builder refuses one at run time, a term being no descriptor the
 * field registry made. Each reader is a cell of the box; a batch's cells are one program, checked armed. Oracle: the
 * specification, a term is never a field.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { fieldsBox } from "#test/types/api/fields.dictionary.ts"
import { fieldsProgram } from "#test/types/api/fields.ts"

/** Every public reader that takes a field refuses a term in its place. */
export const fields = boxAgreement(finite(word(fieldsBox)), {
	box: "every public reader that takes a field: a relation's and a generated relation's heading, accumulated's, generated's and a contract's type, codecText's, lexicalForm's and lexical's field",
	situations: [],
	notes: () => [],
	checking: "armed",
	program: fieldsProgram,
	oracle: { kind: "specification", name: "a term is never a field" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/fields/field.ts",
			original:
				"export interface FieldBase extends Built, FieldMarked, Domained<unknown>, Languaged<unknown> {",
			replacement:
				"export interface FieldBase extends Built, Domained<unknown>, Languaged<unknown>, Partial<FieldMarked> {",
			why: "FieldBase does not require the field registry's mark, so a term, which carries a column and an SQL type as a descriptor does, is a field; every reader admits it and the program fails at each cell's directive."
		}
	]
})
