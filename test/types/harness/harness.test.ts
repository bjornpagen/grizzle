/**
 * The testing library's type contracts, each a generated program a batch checks disarmed:
 *
 * - The vocabulary (harness/vocabulary.ts): a required situation, a note and a pair typecheck exactly when every name
 *   they hold is a member of the property's closed vocabulary. Oracle: membership in the drawn vocabulary.
 * - The assertion door (harness/door.ts): assert.equal and assert.deepEqual, each case through both, typecheck exactly
 *   when the expected value conforms to the actual's type, at any depth. Oracle: conformance of a value drawn of the
 *   type, with at most one fault planted, the type drawn where the fault stands.
 *
 * A refusal is stated as the contract states it, `refused`: the probe does not compile, whichever diagnostic the checker
 * elaborates it to. The witnesses reach every fault of both contracts, each at both depths, and their admitted cases.
 */
import { agreement } from "#test/support/types/batch/agreement.ts"
import { doorCases, doorNotes, doorProgram, doorRequired } from "#test/types/harness/door.ts"
import {
	vocabularyCases,
	vocabularyNotes,
	vocabularyProgram,
	vocabularyRequired
} from "#test/types/harness/vocabulary.ts"

/**
 * Over drawn vocabularies, a required situation, a note and a pair typecheck exactly when every name is of the closed
 * vocabulary. It runs the runner's default budget, not the pre-conversion suite's rotating count
 * (60): at TEST_SEED=777, run beside it, the default's whole process tree took 11.3 CPU-s against the old count's 12.9,
 * since its floor of 15 left a situation to a steered window of 150 cases
 * (~/.cache/grizzle-release/TESTSYS/GZ-TYPES/measure/budgets/vocabulary.*.txt, 2026-11-16, load 470 to 670).
 */
export const vocabulary = agreement(vocabularyCases, {
	situations: vocabularyRequired,
	notes: vocabularyNotes,
	checking: "disarmed",
	program: vocabularyProgram,
	oracle: { kind: "specification", name: "membership in the drawn vocabulary" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/scalar/compute/typing.ts",
			original:
				"exact === undefined\n\t\t\t\t? operands\n\t\t\t\t: operands.map((a) => this.widenTo(a, meetingType(a.nominal, exact.nominal), at))",
			replacement:
				"exact === undefined ? operands.map((a) => this.widenTo(a, meetingType(a.nominal, exact.nominal), at)) : operands",
			why: "Operator mutant 61b29d26cb at packages/engine/src/scalar/compute/typing.ts:3252 in <module>: `exact === undefined     ? operands     : operands.map((a) => this.widenTo(a, meetingType(a.nominal, exact.nominal), at))` becomes `exact === undefined ? operands.map((a) => this.widenTo(a, meetingType(a.nominal, exact.nominal), at)) : operands`; the property fails (the census, lane TESTPOLICY2)."
		}
	]
})

/**
 * Over drawn types and values, assert.equal and assert.deepEqual typecheck exactly when the expected value conforms to
 * the actual's type. Its budget, 120 runs and the runner's 200 steered cases, is the pre-conversion suite's rotating
 * count (120), restored because it costs no more: at TEST_SEED=777, run beside the runner's default of 150, the whole
 * run's process tree took 11.2 CPU-s against 11.2, every situation reached and every kill killed alike, the two within
 * 0.4% (budgets/door.*.txt) (~/.cache/grizzle-release/TESTSYS/GZ-TYPES/measure/budgets, 2026-11-16, load 470 to 670).
 */
export const door = agreement(doorCases, {
	budget: { runs: 120, steered: 200 },
	situations: doorRequired,
	notes: doorNotes,
	checking: "disarmed",
	program: doorProgram,
	oracle: { kind: "specification", name: "conformance of a value drawn of the actual's type" },
	kept: [],
	kills: [
		{
			file: "packages/text/src/regex/ir.ts",
			original: "table.set(node, compute(node, of))",
			replacement: "{}",
			why: "Operator mutant 9b37c8e915 at packages/text/src/regex/ir.ts:305 in folded: `table.set(node, compute(node, of))` becomes `{}`; the property fails (the census, lane TESTPOLICY2)."
		}
	]
})
