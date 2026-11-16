/**
 * The recursion agreement (test/support/agreement/recursion.ts): over drawn recursions, the types admit exactly what the
 * engine compiles, name its refusal, and infer its records and parameters. Each recursion is a block of one program a
 * batch checks disarmed. Oracle: the engine's compile of each drawn recursion. The witnesses reach every fault, both
 * declared classes and every admitted shape.
 */
import {
	recursionCases,
	recursionProgram,
	recursionRequired
} from "#test/support/agreement/recursion.ts"
import { agreement } from "#test/types/batch/agreement.ts"

/**
 * Over drawn recursions, the types admit exactly what the engine compiles, name its refusal, and infer its records and
 * parameters.
 */
export const recursion = agreement(recursionCases, {
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
		}
	]
})
