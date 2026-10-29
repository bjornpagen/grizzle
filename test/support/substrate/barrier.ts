import { Array as Arr, Effect, Option, String as Str } from "effect"
import type { PgConnection, SqlError } from "#test/support/pg.ts"

export interface LockWait {
	readonly pid: number
	/** pg_stat_activity.wait_event for a Lock wait: the lock type, e.g. `transactionid` or `relation`. */
	readonly waitEvent: string
	/** The ungranted pg_locks entry: lock type and requested mode, e.g. `transactionid` and `ShareLock`. */
	readonly locktype: string
	readonly mode: string
	/** pg_blocking_pids: the backends holding or queued ahead for the lock. */
	readonly blockedBy: ReadonlyArray<number>
}

/**
 * pg_stat_activity's wait columns are visible only to a viewer with the privileges of the target's role; the
 * allocator grants each test role to the owner for this reason (see substrate.ts). pg_locks is visible to all.
 */
export const lockWaitQuery = `SELECT a.wait_event::text, l.locktype::text, l.mode::text, array_to_string(pg_catalog.pg_blocking_pids(a.pid), ',')
FROM pg_catalog.pg_stat_activity AS a
JOIN pg_catalog.pg_locks AS l ON l.pid = a.pid AND NOT l.granted
WHERE a.pid = $1::int4 AND a.wait_event_type = 'Lock'::text`

const parseWait = (pid: number, row: ReadonlyArray<unknown>): LockWait => {
	const [waitEvent, locktype, mode, blockers] = Arr.map(row, String)
	return {
		pid,
		waitEvent: waitEvent ?? "",
		locktype: locktype ?? "",
		mode: mode ?? "",
		blockedBy: (blockers ?? "").length === 0 ? [] : Arr.map(Str.split(blockers ?? "", ","), Number)
	}
}

/**
 * The lock-wait barrier: waits until a backend is observed blocked on a heavyweight lock.
 *
 * Tests never sleep to let a concurrent statement "probably" reach its lock; they poll pg_stat_activity and pg_locks
 * until the backend is waiting. Each poll is one round trip on the observer session, issued back to back; nothing waits
 * on a timer and nothing is judged by time. A wait that is never observed holds the test until Vitest's test timeout, the
 * runner's hang guard, reports it hung.
 *
 * Polls from `observer`, a connection that is not one of the sessions under test, until backend `pid` waits on a
 * lock (and, with `blockedBy`, until that backend blocks it). The observer's statements are not counted.
 */
export const awaitLockWait = (
	observer: PgConnection,
	pid: number,
	blockedBy: Option.Option<number>
): Effect.Effect<LockWait, SqlError> =>
	Effect.gen(function* () {
		for (;;) {
			const rows = yield* observer.queryValues(lockWaitQuery, [pid])
			const first = rows[0]
			if (first !== undefined) {
				const wait = parseWait(pid, first)
				if (
					Option.match(blockedBy, {
						onNone: () => true,
						onSome: (holder) => wait.blockedBy.includes(holder)
					})
				) {
					return wait
				}
			}
			yield* Effect.yieldNow
		}
	})

/**
 * The backends of a role that the holder blocks: pg_blocking_pids lists the backends holding or queued ahead for the
 * lock a backend waits on, so the waiter is found by its holder's pid and its own role, never by what it runs.
 */
const blockedByQuery = `SELECT a.pid FROM pg_catalog.pg_stat_activity AS a WHERE a.usename = $2::name AND $1::int4 = ANY (pg_catalog.pg_blocking_pids(a.pid)) ORDER BY a.pid`

/**
 * Polls from `observer` until exactly one backend of `role` (the login role of the waiter, never the holder's own) is
 * blocked by `holder`, and returns its lock wait. Several such backends make the barrier ambiguous, a defect of the
 * schedule.
 */
export const awaitBlockedBy = (
	observer: PgConnection,
	holder: number,
	role: string
): Effect.Effect<LockWait, SqlError> =>
	Effect.gen(function* () {
		for (;;) {
			const blocked = yield* observer.queryValues(blockedByQuery, [holder, role])
			const [only, ...more] = blocked
			if (only !== undefined && more.length > 0) {
				return yield* Effect.die(
					new Error(
						`${holder} blocks ${blocked.length} backends of ${role}: the barrier cannot tell which one the schedule waits for`
					)
				)
			}
			if (only !== undefined) {
				const waiter = Number(only[0])
				const [wait] = yield* observer.queryValues(lockWaitQuery, [waiter])
				if (wait !== undefined) {
					return parseWait(waiter, wait)
				}
			}
			yield* Effect.yieldNow
		}
	})
