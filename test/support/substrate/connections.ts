import { availableParallelism } from "node:os"

/**
 * The most sessions a test's pool holds at once (PoolBounds.max): one per core of the machine, the owner's all-cores
 * default, read from the machine itself. The local cluster runs on the same cores, so more statements at once than the
 * machine has cores only queue for them, and a call past the pool's sessions waits for one.
 */
export const testPoolMax: number = availableParallelism()

/**
 * The sessions a substrate holds for its life besides a test's pool: its database's owner's, and the observer's that
 * reads other backends' lock waits (substrate.ts build).
 */
const substrateSessions = ["owner", "observer"] as const

/**
 * The connections one test worker holds on its member at most, the width of the budget every connection it opens there
 * draws from (budget.ts ConnectionBudget, test/support/runner.ts WorkerBudgets): a test's full pool (testPoolMax, one
 * session per core) and the sessions its substrate holds besides it. A Vitest file's or a bench's substrate in a
 * database of its own holds as many (substrate.ts isolatedLayer).
 *
 * @limitKind derived
 * @owner grizzle's network test tier (test/support/substrate/connections.ts)
 * @unit connections
 * @scope the client backends one test worker, file or bench holds on its member at once
 * @derivation a worker runs one case at a time, whose pool holds testPoolMax sessions at most beside its substrate's
 *   own sessions; every opener of the worker draws from the one budget, so it holds no more
 * @from {@link testPoolMax}
 */
export const connectionsPerWorker = testPoolMax + substrateSessions.length
