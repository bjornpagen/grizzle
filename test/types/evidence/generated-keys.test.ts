/**
 * Keys over generated fields (test/types/evidence/generated-keys.ts): over a relation keyed by the digests of its
 * texts and by a float's negation, matched binding every column or its written ones alone, pinned on each set of the
 * columns it binds, the types give
 * each query the card the engine proves: at most one row where the pinned columns, each generated field taken as
 * determined by what its generation reads but for one reading a float, hold a key. Each pinning is a cell of the box; a
 * batch's cells are one program, checked disarmed. Oracle: the engine's verdict on each cell's query.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { generatedKeysBox } from "#test/types/evidence/generated-keys.dictionary.ts"
import { generatedKeysProgram } from "#test/types/evidence/generated-keys.ts"

/** Over a relation keyed by generated digests pinned on each set of its columns, the types give the engine's card. */
export const generatedKeys = boxAgreement(finite(word(generatedKeysBox)), {
	box: "a relation of two unbounded texts and a float keyed by the digests of the first text and of both and by the float's negation, matched binding every column and pinned on each set of its texts, its float and its three generated fields, or binding its written columns and pinned on each set of its texts and its float",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: generatedKeysProgram,
	oracle: { kind: "second-implementation", name: "the engine's verdict on each cell's query" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/logical/props.ts",
			original: "\t\t\t\t\t\t\t\t\t\t...reading.generated.map(generationDetermines)\n",
			replacement: "",
			why: "The engine states no generated field's dependency (logical/props.ts logicalPropsOf, Base), so the texts pinned are many rows to it and at most one to the types; the program fails."
		},
		{
			file: "packages/engine/src/types/evidence/evidence.ts",
			original: "\t\t? ReadNeeds<Reads, B, FixedFields>\n\t\t: Lost\n",
			replacement: "\t\t? Lost\n\t\t: Lost\n",
			why: "The types take no unbound key field as known by its generation's reads (types/evidence/evidence.ts GeneratedNeeds), so the texts pinned are at most one row to the engine and many to the types; the program fails."
		},
		{
			file: "packages/engine/src/types/evidence/evidence.ts",
			original: "\t: true extends ReadsFloat<Reads, H>\n",
			replacement: "\t: false extends ReadsFloat<Reads, H>\n",
			why: "The types take a generation reading a float as determined by it (types/evidence/evidence.ts GenerationOver), so the float pinned is at most one row to the types and many to the engine; the program fails."
		}
	]
})
