import { processors } from "@bjornpagen/testing/workers"

/**
 * The most sessions a test's pool holds at once (PoolBounds.max): one for each CPU the run may keep busy, its CPU
 * allowance (@bjornpagen/testing/workers processors), the one source of every width a run takes. The local cluster runs
 * on the same CPUs, so more statements at once than the run may keep busy only queue for them, and a call past the
 * pool's sessions waits for one.
 */
export const testPoolMax: number = processors

/**
 * The sessions a substrate holds for its life besides a test's pool: its database's owner's, and the observer's that
 * reads other backends' lock waits (substrate.ts build).
 */
const substrateSessions = ["owner", "observer"] as const

/**
 * The connections each substrate adds to its holder's budget for its life (substrate.ts substrateHeld): its own
 * sessions (substrateSessions), so a case that holds n substrates at once (lowering's five fresh databases, a
 * rule-seeding search's) is granted n substrates' sessions beside its one pool, whatever the run's width.
 *
 * @limitKind derived
 * @owner grizzle's network test tier (test/support/substrate/connections.ts)
 * @unit connections
 * @scope the client backends one substrate holds on its member at once, outside a test's pool
 * @derivation a substrate opens its owner's session as it builds and its observer's the first time a barrier polls,
 *   and no other session of its own for its life
 * @from substrateSessions
 */
export const substrateConnections = substrateSessions.length

/**
 * The sessions a worker holds on its member outside every substrate and pool: the toolchain resources' owner session,
 * held for the worker's life (its creates, clones and drops), and the one session a template's build or a clone's
 * replay holds beside it at once (test/support/runner.ts ownerSession, superuserSession).
 */
const holderSessions = ["resources owner", "a build's session"] as const

/**
 * The connections one test worker's budget grants on its member before any substrate (budget.ts ConnectionBudget,
 * test/support/runner.ts WorkerBudgets): one test's full pool (testPoolMax) and the sessions the worker holds outside
 * every substrate (holderSessions). Each substrate the worker's case holds widens it by its own sessions while it lives
 * (substrateConnections), so the budget is the case's real demand: its substrates' sessions and one pool, where it was
 * one pool and one substrate's whatever the case held, and a case of five fresh databases under a 16-CPU allowance
 * asked past it (lowering and rule-seeding under grizzle.slice's quota, 2026-11-24: ConnectionBudgetExhausted at 18,
 * their peak 21 connections). A substrate in a database of its own (substrate.ts isolatedLayer) holds as many.
 *
 * @limitKind derived
 * @owner grizzle's network test tier (test/support/substrate/connections.ts)
 * @unit connections
 * @scope the client backends one test worker, file or bench holds on its member at once outside its substrates
 * @derivation a worker runs one case at a time, whose pool holds testPoolMax sessions at most beside the worker's own
 *   (holderSessions); every opener of the worker draws from the one budget, so it holds no more
 * @from {@link testPoolMax}, holderSessions
 */
export const connectionsPerWorker = testPoolMax + holderSessions.length
