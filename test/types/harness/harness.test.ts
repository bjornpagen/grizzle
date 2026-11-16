/**
 * The testing library's type contracts, each a generated program a batch checks disarmed:
 *
 * - The vocabulary (harness/vocabulary.ts): a required situation, a note, a pair and a kept case's reaches typecheck
 *   exactly when every name they hold is a member of the suite's closed vocabulary, the situations are one at least, a
 *   kept case reaches one at least, and the vocabulary is a union of literals, never string. Oracle: membership in the
 *   drawn vocabulary.
 * - The assertion door (harness/door.ts): assert.equal and assert.deepEqual, each case through both, typecheck exactly
 *   when the expected value conforms to the actual's type, at any depth. Oracle: conformance of a value drawn of the
 *   type, with at most one fault planted, the type drawn where the fault stands.
 *
 * A refusal is stated as the contract states it, `refused`: the probe does not compile, whichever diagnostic the checker
 * elaborates it to. The witnesses reach every fault of both contracts, each at both depths, and their admitted cases.
 */
import { agreement } from "#test/types/batch/agreement.ts"
import { doorCases, doorNotes, doorProgram, doorRequired } from "#test/types/harness/door.ts"
import {
	vocabularyCases,
	vocabularyNotes,
	vocabularyProgram,
	vocabularyRequired
} from "#test/types/harness/vocabulary.ts"

/**
 * Over drawn vocabularies, a required situation, a note, a pair and a kept case's reaches typecheck exactly when every
 * name is of the closed vocabulary.
 */
export const vocabulary = agreement(vocabularyCases, {
	situations: vocabularyRequired,
	notes: vocabularyNotes,
	checking: "disarmed",
	program: vocabularyProgram,
	oracle: { kind: "specification", name: "membership in the drawn vocabulary" },
	kept: [],
	kills: []
})

/**
 * Over drawn types and values, assert.equal and assert.deepEqual typecheck exactly when the expected value conforms to
 * the actual's type.
 */
export const door = agreement(doorCases, {
	situations: doorRequired,
	notes: doorNotes,
	checking: "disarmed",
	program: doorProgram,
	oracle: { kind: "specification", name: "conformance of a value drawn of the actual's type" },
	kept: [],
	kills: []
})
