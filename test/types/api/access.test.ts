/**
 * The access agreement (test/support/agreement/access.ts): over drawn logins, Db.open needs a token, DbLayer.make a
 * verify, a workload over a role its contexts, and a refresh member its refresh list, exactly where the engine's
 * reading of the role needs them. Each login is a block of one program a batch checks disarmed. Oracle: the engine's
 * reading of each drawn role. The witnesses reach every place a role reads a context and every probe under both
 * verdicts.
 */
import { accessCases, accessProgram, accessRequired } from "#test/support/agreement/access.ts"
import { agreement } from "#test/types/batch/agreement.ts"

/**
 * Over drawn logins, Db.open needs a token, DbLayer.make a verify, a workload over a role its contexts and its refresh
 * member its refresh list exactly as the engine reads the role. Its budget, 60 runs and the runner's 200 steered cases,
 * is the pre-conversion suite's rotating count (60), restored because it costs no more: at TEST_SEED=777, run beside
 * the runner's default of 150, the whole run's process tree took 74.9 CPU-s against 131.4, every situation reached and
 * every kill killed alike (budgets/access.*.txt) (~/.cache/grizzle-release/TESTSYS/GZ-TYPES/measure/budgets,
 * 2026-11-16, load 470 to 670).
 */
export const access = agreement(accessCases, {
	budget: { runs: 60, steered: 200 },
	situations: accessRequired,
	notes: (c) => c.notes,
	checking: "disarmed",
	program: accessProgram,
	oracle: { kind: "second-implementation", name: "the engine's reading of each drawn role" },
	kept: [],
	kills: [
		{
			file: "packages/grizzle/src/adapter/types/db.ts",
			original: "\tReadsContext<R> extends true ? TokenOptions : TokenOptions | NoTokenOptions",
			replacement:
				"\tReadsContext<R> extends true ? TokenOptions | NoTokenOptions : TokenOptions | NoTokenOptions",
			why: "Db.open takes no token for a role that reads a context (adapter/types/db.ts OpenOptions); the agreement's program fails."
		}
	]
})
