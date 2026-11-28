/**
 * The recursion agreement (test/support/agreement/recursion.ts): over drawn recursions, the types admit exactly what the
 * engine compiles, name its refusal, and infer its records, its parameters and its keys, its whole row. Each recursion is a block of one program a
 * batch checks disarmed. Oracle: the engine's compile of each drawn recursion. The witnesses reach every fault, both
 * declared classes and every admitted shape.
 */
import {
	recursionCases,
	recursionProgram,
	recursionRequired
} from "#test/support/agreement/recursion.ts"
import { agreement } from "#test/support/types/batch/agreement.ts"

/**
 * Over drawn recursions, the types admit exactly what the engine compiles, name its refusal, and infer its records and
 * parameters. Its budget, 80 runs and the runner's 200 steered cases, is the pre-conversion suite's rotating count
 * (80), restored because it costs no more: at TEST_SEED=777, run beside the runner's default of 150, the whole run's
 * process tree took 56.7 CPU-s against 58.5, every situation reached and every kill killed alike
 * (budgets/recursion.*.txt) (~/.cache/grizzle-release/TESTSYS/GZ-TYPES/measure/budgets, 2026-11-16, load 470 to 670).
 */
export const recursion = agreement(recursionCases, {
	budget: { runs: 80, steered: 200 },
	situations: recursionRequired,
	notes: (c) => c.notes,
	checking: "disarmed",
	program: recursionProgram,
	oracle: { kind: "second-implementation", name: "the engine's compile of each drawn recursion" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/query/query.ts",
			original: "\t\t} & NoInfer<SomeArm<Base, Rec>>",
			replacement: "\t\t}",
			why: "The types admit a recursion with no base arm (types/query/query.ts drops SomeArm on the base list); the agreement's program fails."
		},
		{
			file: "packages/engine/src/types/query/query.ts",
			original: "\tEvidence.Set<Row>,",
			replacement: "\tEvidence.Unknown,",
			why: "A recursion's evidence states no key where the engine keys it by its whole row, so a fold over it matched at every field is refused and a derived relation over it is keyed by nothing; the agreement's program fails."
		}
	]
})
