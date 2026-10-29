/**
 * Session acquisition budgets.
 *
 * Session acquisition has fixed internal budgets. Diagnostics distinguish connection establishment, provider
 * wake-up, acquisition wait, and request interruption. Repeated connection retries are never disguised as a fast
 * database operation, and there are no tuning settings. An acquisition's refusal (failures.ts AcquireRefusal) means no
 * session could be acquired within the fixed policy. The budgets are host-side bounds on getting a session; none of them is a server-side deadline, and none
 * interrupts SQL in flight:
 *
 * - Connection establishment: one connection attempt (the password Effect, TCP, TLS, startup and authentication) runs
 *   under pg's `connectionTimeoutMillis`, which every session client takes from `connectBudgetMs`
 *   (../wire/session.ts). An attempt that exceeds it is ConnectTimedOut, at stage `connect`. A provider
 *   waking a suspended database spends this budget; its time shows in the `grizzle.connect` span.
 * - Acquisition wait: a lease waits at most `waitMs` for a session from the pool, whether an idle one, one the pool is
 *   establishing, or one another lease returns. Exceeding it is AcquisitionBudgetExceeded, at stage `wait`, whose
 *   counts tell whether every session up to the maximum was leased (a saturated pool) or one was still being
 *   established.
 *   The wait itself is interruptible and holds nothing: a session the pool is establishing joins the pool for the next
 *   lease. A session found lost before anything ran on it is closed and another leased, within the same budget, at
 *   most `pool.max` times. A connection attempt that fails is never retried: its failure is the acquisition's.
 *
 * The values are placeholders, like the policy's: chosen to be safe and plausible, not measured.
 */
export interface AcquisitionBudgets {
	/** The longest one acquisition waits for pooled sessions, in milliseconds. */
	readonly waitMs: number
}

/** The fixed budgets every DbLayer's pools acquire under. */
export const acquisitionBudgets: AcquisitionBudgets = Object.freeze({ waitMs: 15_000 })

/** The connection establishment budget: pg's `connectionTimeoutMillis` of every session client. */
export const connectBudgetMs = 5_000
