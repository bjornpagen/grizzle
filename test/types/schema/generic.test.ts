/**
 * The generic-source agreement (test/support/agreement/generic-sources.ts): over every statement builder written generic
 * over each shape of its sources, the types admit exactly what the engine compiles over every relation a shared heading
 * may be, name its refusal, and refuse a source whose relations share no heading. Each helper is a cell of the box; a
 * batch's cells are one program, checked disarmed. Oracle: the engine's compile of the statement over each relation of
 * the shape.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { genericProgram } from "#test/support/agreement/generic-sources.ts"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { genericBox } from "#test/types/schema/generic.dictionary.ts"

/**
 * Over every statement builder written generic over each shape of its sources, the types admit exactly what the engine
 * compiles over every relation a shared heading may be, name its refusal, and refuse a source whose relations share no
 * heading.
 */
export const generic = boxAgreement(finite(word(genericBox)), {
	box: "every construct over each shape of its source family (members, indexed members, owners, trees), and every fault over each shape whose relations share one heading",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: genericProgram,
	oracle: {
		kind: "second-implementation",
		name: "the engine's compile of the statement over each relation of the shape"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/schema/statements.ts",
			original:
				'\t\t: Refusal<"the sides\' field types differ">\n\t: Refusal<"the sides\' field types differ">',
			replacement: "\t\t: unknown\n\t: unknown",
			why: "Two sides whose field types differ are admitted (types/schema/statements.ts SidesCompatible answers unknown); the agreement's program fails."
		}
	]
})
