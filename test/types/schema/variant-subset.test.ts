import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/types/batch/agreement.ts"
/**
 * A variant over a subset of its roster (test/types/schema/variant-subset.ts): `variant(name, roster, arms)` whose arms
 * name some of the roster's handles holds exactly those, so an addition and a make at any other handle are refused, a
 * query's column of it is the union of those arms alone, and its tag, a term and a field generated from it, is the
 * subset's handles. A variant of no arm, and one with an arm named by a handle off the roster, are refused. Each handle
 * of the roster is a cell of the box; a batch's cells are one program, checked disarmed. Oracle: the subset as the arms
 * name it, computed apart from the types.
 */
import { variantSubsetBox } from "#test/types/schema/variant-subset.dictionary.ts"
import { variantSubsetProgram } from "#test/types/schema/variant-subset.ts"

/** A variant over a subset of its roster holds exactly the arms it names, and its tag is the subset's handles. */
export const aVariantOverASubsetIsTheUnionOfItsArms = boxAgreement(finite(word(variantSubsetBox)), {
	box: "a variant whose arms name two of its roster's four handles, out of the roster's order, a value of it written and made at every handle of the roster",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: variantSubsetProgram,
	oracle: {
		kind: "specification",
		name: "the subset as the arms name it: an arm's handle is a value, every other handle none"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/fields/field.ts",
			original:
				"\treadonly [H in HandleOf<C> & string]?: Readonly<Record<string, FieldBase & NoWriting>>\n",
			replacement:
				"\treadonly [H in HandleOf<C> & string]: Readonly<Record<string, FieldBase & NoWriting>>\n",
			why: "A variant's arms are one per handle of its roster again: a variant over a subset is refused, so the program fails."
		},
		{
			file: "packages/engine/src/types/fields/field.ts",
			original: "\t\tArmHandles<C, Arms>,\n\t\tFacts,\n\t\tHandleOf<C>\n\t>",
			replacement: "\t\tHandleOf<C>,\n\t\tFacts,\n\t\tHandleOf<C>\n\t>",
			why: "A variant's tag typed by every handle of its roster: a query's tag column holds handles no arm names, so the program fails."
		},
		{
			file: "packages/engine/src/types/fields/constructors.ts",
			original:
				'export type ArmsAdmitted<C, Arms> = [keyof Arms] extends [never]\n\t? Refusal<"a variant holds at least one arm, each named by a handle of its roster">\n',
			replacement:
				"export type ArmsAdmitted<C, Arms> = [keyof Arms] extends [never]\n\t? unknown\n",
			why: "A variant of no arm is admitted by its type, whose values would be none, so the program fails."
		}
	]
})
