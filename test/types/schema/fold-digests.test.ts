import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
/**
 * A fold's accumulators at the type level (test/types/schema/fold-digests.ts): a concat fold names each running text by
 * its accumulated field or by its SHA-256 digest, a generated field, which stands in a text's place (ir/family.ts
 * FoldCarrier), and a sum fold names no generated field as an accumulator or an end. Each cell is a program line of the
 * box; a batch's cells are one program, checked disarmed. Oracle: the engine's rule for a fold's accumulators, stated
 * apart from the types.
 */
import { foldDigestsBox } from "#test/types/schema/fold-digests.dictionary.ts"
import { foldDigestsProgram } from "#test/types/schema/fold-digests.ts"

/** A concat fold names its running texts or their digests, and a sum fold no generated accumulator. */
export const foldDigests = boxAgreement(finite(word(foldDigestsBox)), {
	box: "a concat fold naming its running texts or their digests, and a sum fold naming a generated before, after or end",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: foldDigestsProgram,
	oracle: {
		kind: "specification",
		name: "a text plane's running value is its accumulated field or its digest, a generated field; no other plane's accumulator is generated"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/schema/statements.ts",
			original:
				'\t\t\t? X extends readonly [unknown, "text"]\n\t\t\t\t? "held"\n\t\t\t\t: "absent"',
			replacement: '\t\t\t? "absent"',
			why: "A generated field is no accumulator at any plane: a concat fold naming its texts' digests is a type error; the program fails."
		},
		{
			file: "packages/engine/src/types/schema/statements.ts",
			original:
				'\t\t\t? X extends readonly [unknown, "text"]\n\t\t\t\t? "held"\n\t\t\t\t: "absent"',
			replacement: '\t\t\t? "held"',
			why: "A generated field stands at any plane's accumulator: a sum fold naming a generated before, after or end is admitted; the program fails."
		}
	]
})
