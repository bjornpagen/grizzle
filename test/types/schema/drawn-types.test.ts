import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/types/batch/agreement.ts"
/**
 * A drawn field of each type (test/types/schema/drawn-types.ts): `drawn(c)` takes natural or a contract over an integer,
 * smallint, integer or bigint, and refuses a contract over a numeric or a text and a plain integer; an ordered family's
 * index is of its count's type, a family whose index and count are of two types refused; and a field of the index's
 * contract is contained in the family's indexes and they in it, the containment's one base carrier rule pairing a
 * drawn field of a contract with any field of it, as metis's test number is. Each index type with each count type is a cell
 * of the box; a batch's cells are one program, checked disarmed. Oracle: the engine's rules for a drawn field and an
 * ordered family, stated apart from the types.
 */
import { drawnTypesBox } from "#test/types/schema/drawn-types.dictionary.ts"
import { drawnTypesProgram } from "#test/types/schema/drawn-types.ts"

/**
 * A drawn field is natural or a contract over an integer, an ordered family's index of its count's type, and a field of
 * its contract is contained in its indexes and they in it.
 */
export const drawnTypes = boxAgreement(finite(word(drawnTypesBox)), {
	box: "every index type with every count type of an ordered family: natural, a contract over smallint, integer and bigint, a contract over a numeric and over a text, and a plain integer, each with a field of the index's type contained in the indexes and they in it",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: drawnTypesProgram,
	oracle: {
		kind: "specification",
		name: "drawn(type) takes natural or a contract whose base is an integer; an ordered family's index is of its count's type; a containment pairs fields of one base carrier"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/fields/field.ts",
			original: '\t\t\t\t\treadonly sql: "smallint" | "integer" | "bigint"',
			replacement: '\t\t\t\t\treadonly sql: "bigint"',
			why: "drawn takes a contract over bigint alone: a family indexed by a contract over smallint or integer, metis's int4 test number among them, is refused at its drawn field; the program fails."
		},
		{
			file: "packages/engine/src/types/schema/statements.ts",
			original: "\t? IndexOfCountField<C, T, OC, N>",
			replacement: "\t? unknown",
			why: "An ordered family's index is never held to its count's type: a family indexed by one contract and counted by another, or by natural, is admitted; the program fails."
		},
		{
			file: "packages/engine/src/types/schema/statements.ts",
			original: "\t? [N] extends [DrawnNaturalIn<OC>]",
			replacement: "\t? [N] extends [DrawnIn<OC>]",
			why: "A counted family counts by any drawn field: one counted by a contract over an integer is admitted beside its natural hidden index; the program fails."
		},
		{
			file: "packages/engine/src/types/fields/field.ts",
			original:
				'\t\tUnwrittenField,\n\t\tDomained<DomainOf<F>>,\n\t\tProving<FactsOf<F>>,\n\t\tLanguaged<LanguageOf<F>> {\n\treadonly writing: "drawn"',
			replacement:
				'\t\tUnwrittenField,\n\t\tDomained<DomainOf<NaturalField>>,\n\t\tProving<FactsOf<F>>,\n\t\tLanguaged<LanguageOf<F>> {\n\treadonly writing: "drawn"',
			why: "A drawn field of a contract is of natural's domain, as every drawn field was: a field of a contract over smallint or integer is refused in a containment with it, natural's base carrier int8 against the contract's, the sides' field types differing; the program fails."
		}
	]
})
