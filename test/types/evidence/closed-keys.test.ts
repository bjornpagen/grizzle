/**
 * A closed relation's keys (test/types/evidence/closed-keys.ts): over a closed relation whose one key is its declared
 * key of two closed ids, pinned on each set of its columns, the types give each query the card the engine proves, at
 * most one row exactly where the pinned columns hold the key. Each pinning is a cell of the box; a batch's cells are one
 * program, checked disarmed. Oracle: the engine's verdict on each cell's query.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { closedKeysBox } from "#test/types/evidence/closed-keys.dictionary.ts"
import { closedKeysProgram } from "#test/types/evidence/closed-keys.ts"

/** Over a closed relation of a composite key pinned on each set of its columns, the types give the engine's card. */
export const closedKeys = boxAgreement(finite(word(closedKeysBox)), {
	box: "a closed relation keyed by two closed ids, neither distinct alone, pinned on each set of its three columns",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: closedKeysProgram,
	oracle: { kind: "second-implementation", name: "the engine's verdict on each cell's query" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/logical/props.ts",
			original:
				"\t\t\tif (rows.length > 1) {\n\t\t\t\tfor (const key of rowKeys(columns, rows.length)) {",
			replacement:
				"\t\t\tif (rows.length < 0) {\n\t\t\t\tfor (const key of rowKeys(columns, rows.length)) {",
			why: "The engine keys a closed relation by none of its columns (logical/props.ts Closed), so a match pinned on its declared key is many rows to it and at most one to the types; the program fails."
		},
		{
			file: "packages/engine/src/logical/props.ts",
			original: "\t\tlevel = open.flatMap((set) =>",
			replacement: "\t\tlevel = open.slice(0, 0).flatMap((set) =>",
			why: "The engine keys a closed relation by its single distinct columns alone (logical/props.ts rowKeys reads no set of two), so a match pinned on a declared key of two columns, neither distinct alone, is many rows to it and at most one to the types; the program fails."
		}
	]
})
