/**
 * The workload agreement (test/support/agreement/workloads.ts): over drawn workloads, the types admit exactly what the
 * engine builds, plans and compiles, and keep each program's type. Each workload is a block of one program a batch
 * checks disarmed. Oracle: the engine's build, plan and compile of each drawn workload. The witnesses reach every kind
 * of program under both verdicts and every shape of workload.
 */
import {
	workloadCases,
	workloadProgram,
	workloadRequired
} from "#test/support/agreement/workloads.ts"
import { agreement } from "#test/support/types/batch/agreement.ts"

/**
 * Over drawn workloads, the types admit exactly what the engine builds, plans and compiles, and keep each program's
 * type. It runs the runner's default budget, not the pre-conversion suite's rotating count (120): at TEST_SEED=777, run
 * beside it, the default's whole process tree took 64.4 CPU-s against the old count's 71.4, its floor of 30 needing 200
 * steered cases where the default's needed 150
 * (~/.cache/grizzle-release/TESTSYS/GZ-TYPES/measure/budgets/workload.*.txt, 2026-11-16, load 470 to 670).
 */
export const workload = agreement(workloadCases, {
	situations: workloadRequired,
	notes: (c) => c.notes,
	checking: "disarmed",
	program: workloadProgram,
	oracle: {
		kind: "second-implementation",
		name: "the engine's build, plan and compile of each drawn workload"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/db/workload.ts",
			original: '\t\t\t: Refusal<"a ChangeSet writes only relations its role\'s write list names">',
			replacement: "\t\t\t: unknown",
			why: "A workload over a role takes a ChangeSet writing a relation its role's write list does not name (types/db/workload.ts WritesWithin answers unknown for it); the agreement's program fails."
		}
	]
})
