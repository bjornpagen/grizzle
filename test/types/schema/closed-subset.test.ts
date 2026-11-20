import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/types/batch/agreement.ts"
/**
 * A closed id of a subset of its roster (test/types/schema/closed-subset.ts): a field `closedId(C, { only })` or
 * `closedId(C, { except })` holds exactly the handles its subset states, so an addition at any other handle is refused
 * and a query's column of it is the subset's handles, while its domain is the roster's, so it meets the whole roster's
 * closed id in an equality and a containment. Each relation at each handle is a cell of the box; a batch's cells are
 * one program, checked disarmed. Oracle: the subset as the declaration states it, computed apart from the types.
 */
import { closedSubsetBox } from "#test/types/schema/closed-subset.dictionary.ts"
import { closedSubsetProgram } from "#test/types/schema/closed-subset.ts"

/** A closed id of a subset holds exactly its subset's handles and meets the whole roster's closed id. */
export const closedSubset = boxAgreement(finite(word(closedSubsetBox)), {
	box: "a relation keyed by a closed id of `only` a subset, one of every handle `except` one, and one of the whole roster, each written at every handle of the roster",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: closedSubsetProgram,
	oracle: {
		kind: "specification",
		name: "the subset as its declaration states it: only's handles, or every handle but except's"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/fields/field.ts",
			original: "\t? H\n\t: Subset extends { readonly except: ReadonlyArray<infer H> }",
			replacement:
				"\t? HandleOf<C>\n\t: Subset extends { readonly except: ReadonlyArray<infer H> }",
			why: "A closed id of `only` a subset typed by every handle of its roster: an addition at a handle outside the subset is admitted, and the query's column is the whole roster's; the program fails."
		},
		{
			file: "packages/engine/src/types/fields/field.ts",
			original: "\t\t? Exclude<HandleOf<C>, H>",
			replacement: "\t\t? HandleOf<C>",
			why: "A closed id of every handle `except` some typed by every handle: an addition at an excepted handle is admitted; the program fails."
		},
		{
			file: "packages/engine/src/types/fields/field.ts",
			original: '\tS,\n\t"code",\n\tHandleOf<C> & RosterBrands<RosterName<C>, OrderOf<C>>',
			replacement: '\tS,\n\t"code",\n\tS & RosterBrands<RosterName<C>, OrderOf<C>>',
			why: "A subset's domain narrowed to its handles: it no longer meets the whole roster's closed id, so the equality and the containment into the whole roster's key are refused; the program fails."
		}
	]
})
