/**
 * A source generic over a closed id's roster (test/types/query/roster-generic.ts): one helper written over closed
 * relations whose headings differ only in a closed id's roster, ordered or unordered, is admitted, and at each
 * instantiation reads exactly what the join written by hand over that relation reads, its code of that relation's own
 * roster. Each relation is a cell of the box; a batch's cells are one program, checked disarmed. Oracle: the join
 * written by hand over each relation.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { rosterGenericBox } from "#test/types/query/roster-generic.dictionary.ts"
import { rosterGenericProgram } from "#test/types/query/roster-generic.ts"

/** One helper over closed relations whose closed ids differ in roster is typed per instantiation, as each hand-written join. */
export const rosterGeneric = boxAgreement(finite(word(rosterGenericBox)), {
	box: "a helper generic over closed relations whose headings differ only in a closed id's roster, instantiated at each: over an ordered roster, an unordered one and another ordered one",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: rosterGenericProgram,
	oracle: { kind: "second-implementation", name: "the join written by hand over each relation" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/query/query.ts",
			original: ") => ShownVars<HeadingIn<R>, F, RN, ShownOrigins<R, N, RN, F>>",
			replacement: ") => ShownVars<F, F, RN, ShownOrigins<R, N, RN, F>>",
			why: "v mints a generic source's closed id over the heading its constraint shows, the first relation's, not off the source itself (types/query/terms.ts ShownHeadingOf), so the helper's code is that roster's at every instantiation and no binding of it meets the source's own field; the program fails."
		}
	]
})
