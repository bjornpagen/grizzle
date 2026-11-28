/**
 * A call's keys (test/types/evidence/call-keys.ts): over a row keyed by its id matched with the rows each call returns at
 * its fields, an arm of its variant cell, a split of its list, a series of its ends, a declared function's rows and the
 * rest, its id pinned or not and each call's place delivered, fixed or dropped, the types give each query the card the
 * engine proves, both reading one table of how the rows of one evaluation stand (ir/rel.ts callNumberings): at most one
 * row where the pinned id fixes what a call of one row or none reads, or what a numbered call reads and its place, and
 * many otherwise. metis's kept feedback is of the box: its snapshot's 'string' arm, its cell fixed by the snapshot's
 * key, which it attached as an array and took the head of, the types having refused it as an Option
 * (packages/delivery/src/reads.ts). Each cell is a cell of the box; a batch's cells are one program, checked disarmed.
 * Oracle: the engine's verdict on each cell's query.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { callKeysBox } from "#test/types/evidence/call-keys.dictionary.ts"
import { callKeysProgram } from "#test/types/evidence/call-keys.ts"

/** Over a row's calls matched at its fields, its id pinned or not, the types give the engine's card. */
export const callKeys = boxAgreement(finite(word(callKeysBox)), {
	box: "a row keyed by its id matched with each call at its fields (its cell's arm, its list's tokens, pieces, rest, path, target within its base and split at its last comma, a series of its ends, a declared function's rows and a field of a declared function's row), its id pinned by a parameter or not, and a numbered call's place delivered, fixed to a literal or dropped",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: callKeysProgram,
	oracle: { kind: "second-implementation", name: "the engine's verdict on each cell's query" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/compute/call.ts",
			original: '\t? { readonly keys: readonly [readonly []]; readonly card: "atMostOne" }\n',
			replacement: "\t? Evidence.Unknown\n",
			why: "The types key a call of one row or none by its heading alone (types/compute/call.ts CallEvidence), so an arm of the pinned row's cell, metis's kept feedback, is many rows to the types and at most one to the engine, and so are a rest, a path, a target and a split at the last separator; the program fails."
		},
		{
			file: "packages/engine/src/types/compute/call.ts",
			original: '\t\t? { readonly keys: readonly [readonly [O]]; readonly card: "many" }\n',
			replacement: "\t\t? Evidence.Unknown\n",
			why: "The types key a numbered call by its heading alone (types/compute/call.ts CallEvidence), so a split of the pinned row's list at a fixed place is many rows to the types and at most one to the engine; the program fails."
		}
	]
})
