/**
 * The query facade's surface (test/types/api/surface.ts): the function-valued keys of QueryBuilder, Rule, Finished, Query
 * and Ordered are exactly the methods their runtime values carry, so a method the types promise and the value lacks, and
 * one the value carries and the types hide, fail. Each kind is a cell of the box, its probe a line of the program a
 * batch checks. Oracle: the runtime values the builders make, their methods read off them.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { surfaceBox } from "#test/types/api/surface.dictionary.ts"
import { surfaceProgram } from "#test/types/api/surface.ts"

/** The methods of QueryBuilder, Rule, Finished, Query and Ordered are exactly the methods their runtime values carry. */
export const surface = boxAgreement(finite(word(surfaceBox)), {
	box: "every kind of the query facade's builders: QueryBuilder, Rule, Finished, Query and Ordered",
	situations: [],
	notes: () => [],
	checking: "armed",
	program: surfaceProgram,
	oracle: { kind: "second-implementation", name: "the methods the builders' runtime values carry" },
	kept: [],
	kills: []
})
