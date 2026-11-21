import { availableParallelism } from "node:os"
import { Array as Arr, Record as Rec } from "effect"

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

/** Whom a session outside every worker's budget connects as: the cluster's owner, or the bootstrap superuser. */
type OutsideRole = "owner" | "superuser"

/**
 * The sessions a member serves outside every worker's budget, by who holds them, each by the role it connects as, every
 * one its holder may hold at once: the doctor's (toolchain-pg doctor, one psql at a time, its owner checks and, between
 * them, its admin checks, which are the superuser's), the runner's collection (toolchain-test's, one session a member
 * before its workers start), and the sweep (shared.ts sweep, a bench's: its admin, and the bootstrap superuser's session
 * it drops an owner login on, substrate.ts dropRole).
 */
export const outsideSessions = {
	doctor: ["owner"],
	collection: ["owner"],
	sweep: ["owner", "superuser"]
} as const satisfies Readonly<Record<string, ReadonlyArray<OutsideRole>>>

/**
 * The connections outside every worker's budget that a member's sizing sets aside (pg.config.ts): the owner's sessions
 * of outsideSessions. The bootstrap superuser's sessions, the sweep's, an operator's `pnpm pg admin` and the doctor's
 * admin checks, take PostgreSQL's superuser_reserved_connections, which the sizing adds on top.
 *
 * @limitKind derived
 * @owner grizzle's network test tier (test/support/substrate/connections.ts)
 * @unit connections
 * @scope the owner's sessions one member serves outside every worker's budget at once
 * @derivation every holder of outsideSessions may hold its sessions at once (a doctor beside a run that collects beside
 *   a bench's sweep), so the member sets aside every one of them that is the owner's
 * @from {@link outsideSessions}
 */
export const outsideConnections = Arr.filter(
	Arr.flatten(Rec.values(outsideSessions)),
	(role) => role === "owner"
).length
