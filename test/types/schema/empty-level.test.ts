/**
 * The empty level's types (test/types/schema/empty-level.ts): a read of no relation over schema.empty, and what roles
 * that hold all, or nothing, of the base make of it, beside reads over levels holding relations the role does not hold;
 * a cell typechecks exactly where the rule admits it. Each statement is a cell of the box; a batch's cells are one
 * program, checked disarmed. Oracle: the rule, stated per cell.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/types/batch/agreement.ts"
import { emptyLevelBox } from "#test/types/schema/empty-level.dictionary.ts"
import { emptyLevelProgram } from "#test/types/schema/empty-level.ts"

/** Admits a read over the empty level on every role, and refuses a read over a level the role does not hold whole. */
export const emptyLevel = boxAgreement(finite(word(emptyLevelBox)), {
	box: "a read over the empty level served by a role holding nothing of the base and by one holding it whole, its rows committed by the first, one bound to a relation parameter of a read over the base and one a role's query entry, and reads of the base's relation over the base and over an extension of no relation of its own, served by the first",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: emptyLevelProgram,
	oracle: {
		kind: "specification",
		name: "the empty level is the level below every root, which every role holds whole, and no other level is held without its relations"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/schema/schema.ts",
			original: "\t\t? LevelBottom & Invariant<S>\n",
			replacement: "\t\t? Invariant<S>\n",
			why: "A program over the empty level carries its own Invariant alone, no least phantom beside it, so no level's reader admits it: the workloads, the commit, the bind and the query entry over the empty level are refused, and their directive-free cells fail (K3)."
		},
		{
			file: "packages/engine/src/types/query/query.ts",
			original: "\t\t? [SX] extends [EmptyLevel]\n\t\t\t? never\n\t\t\t: SX\n",
			replacement: "\t\t? SX\n",
			why: "A read over the empty level bound to a relation parameter raises the program it is bound in to the empty level, which is no level of the base nor the base of it, so the bind is refused (K4)."
		},
		{
			file: "packages/engine/src/types/schema/world.ts",
			original: "\t\t\t: IsLevelOfInvariant<Base, QueryLevelPhantom<V>> extends true\n",
			replacement:
				"\t\t\t: IsLevelOfInvariant<Base, Invariant<QueryLevelPhantom<V>>> extends true\n",
			why: "A role's query entry is held to the levels of its base by the Invariant of its phantom rather than the phantom, which only Invariant<L> of a level L matches, so the query entry over the empty level is refused (K5)."
		}
	]
})
