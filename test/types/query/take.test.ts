/**
 * A query's bound (test/types/query/take.ts): over Ordered.take(k) and a search's take by every spelling of the bound,
 * a call typechecks exactly when the engine admits its bound, and is refused under its site's refusal otherwise. Each
 * call is a cell of the box; a batch's cells are one program, checked disarmed. Oracle: the engine's build and compile
 * of each literal bound.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { takeBox } from "#test/types/query/take.dictionary.ts"
import { takeProgram } from "#test/types/query/take.ts"

/** Over Ordered.take and a search's take by every spelling of the bound, the types admit exactly what the engine admits. */
export const take = boxAgreement(finite(word(takeBox)), {
	box: "Ordered.take(k) and approximateNearest({ by, take }) by every spelling of the bound: number literals in range, at each range's edge and past it, zero, a negative, a fraction and an exponent's; a union of literals; a widened number; and for Ordered.take a parameter's declared name, a name of other characters, the empty name and a widened string",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: takeProgram,
	oracle: {
		kind: "second-implementation",
		name: "the engine's build and compile of each literal bound"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/query/query.ts",
			original: "\t\tk: K & TakeBound<K> & OneTakeOverGroups<Arms, Head, Hc>",
			replacement: "\t\tk: K & OneTakeOverGroups<Arms, Head, Hc>",
			why: "Ordered.take reads no bound (types/query/query.ts TakeBound), so every take the engine refuses typechecks and its directive is unused; the program fails."
		},
		{
			file: "packages/engine/src/types/query/query.ts",
			original: "\t\t? NumeralAbove<S, Max> extends true\n\t\t\t? false\n\t\t\t: true",
			replacement: "\t\t? true",
			why: "A bound past its range is admitted (types/query/query.ts PositiveAtMost reads no greatest value), so 2147483648 at a take and 9007199254740992 at a search typecheck and their directives are unused; the program fails."
		}
	]
})
