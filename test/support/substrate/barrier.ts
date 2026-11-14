import { Array as Arr, Effect, Option, String as Str } from "effect"
import { trusted } from "#compiler/core/trusted.ts"
import { defined } from "#test/support/assert.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"

/**
 * A backend's wait on other backends: on a heavyweight lock, or, a SERIALIZABLE READ ONLY DEFERRABLE transaction's
 * first snapshot, for a safe snapshot.
 */
export interface LockWait {
	readonly pid: number
	/**
	 * The ungranted pg_locks entry: lock type and requested mode, e.g. `transactionid` and `ShareLock`, the lock type also
	 * the wait event pg_stat_activity names for the wait; or `safe snapshot` and `deferrable` for a wait for a safe
	 * snapshot, which takes no lock.
	 */
	readonly locktype: string
	readonly mode: string
	/**
	 * The backends it waits on: pg_blocking_pids, those holding or queued ahead for the lock; or
	 * pg_safe_snapshot_blocking_pids, the SERIALIZABLE read-write transactions its safe snapshot waits for.
	 */
	readonly blockedBy: ReadonlyArray<number>
}

/**
 * The backends backend $1 waits on: pg_blocking_pids, those holding or queued ahead for the heavyweight lock it waits
 * for, and pg_safe_snapshot_blocking_pids, the SERIALIZABLE read-write transactions its safe snapshot waits for; each
 * empty when it waits for none. Every role sees both, so the barrier reads the wait of a backend of any login, an owner
 * login's (substrate.ts ownerLogin) included, whose pg_stat_activity wait columns no viewer without its privileges sees
 * and the owner never has. Neither reads the predicate-lock table: a poll of pg_locks, back to back from every file at
 * once, holds every predicate-lock partition through each scan (PostgreSQL's GetPredicateLockStatusData), and starves
 * each SERIALIZABLE transaction's release of its locks behind it.
 */
const blockersQuery = `SELECT array_to_string(pg_catalog.pg_blocking_pids($1::int4), ','),
	array_to_string(pg_catalog.pg_safe_snapshot_blocking_pids($1::int4), ',')`

/**
 * The lock type and requested mode of backend $1's ungranted heavyweight lock, which only pg_locks names: read once a
 * poll has found the backend blocked, never to find whether it is.
 */
const waitedLockQuery = `SELECT l.locktype::text, l.mode::text FROM pg_catalog.pg_locks AS l
WHERE l.pid = $1::int4 AND NOT l.granted`

/** A row of blockersQuery: the two lists of pids, comma-separated, each empty when the backend waits on none. */
type BlockersRow = readonly [onLock: string, onSnapshot: string]

/** A row of waitedLockQuery. */
type WaitedLockRow = readonly [locktype: string, mode: string]

/** The pids a comma-separated list names. */
const pidsOf = (list: string): ReadonlyArray<number> =>
	list.length === 0 ? [] : Arr.map(Str.split(list, ","), Number)

/**
 * The lock wait of backend `pid`, read on `observer`, or undefined when it waits on no heavyweight lock and for no
 * safe snapshot, or its lock wait ended between the two reads.
 */
export const lockWaitOf = (
	observer: PgConnection,
	pid: number
): Effect.Effect<LockWait | undefined, SqlError> =>
	Effect.gen(function* () {
		const [row] = yield* observer.queryValues(blockersQuery, [pid])
		const [lockBlockers, snapshotBlockers] = trusted<BlockersRow>(
			defined(row, "the blockers query's one row")
		)
		const onLock = pidsOf(lockBlockers)
		if (onLock.length > 0) {
			const [waited] = yield* observer.queryValues(waitedLockQuery, [pid])
			if (waited === undefined) {
				return undefined
			}
			const [locktype, mode] = trusted<WaitedLockRow>(waited)
			return { pid, locktype, mode, blockedBy: onLock }
		}
		const onSnapshot = pidsOf(snapshotBlockers)
		return onSnapshot.length > 0
			? { pid, locktype: "safe snapshot", mode: "deferrable", blockedBy: onSnapshot }
			: undefined
	})

/**
 * The lock-wait barrier: waits until a backend is observed blocked on a heavyweight lock.
 *
 * Tests never sleep to let a concurrent statement "probably" reach its lock; they poll the backend's blockers until it
 * is waiting (lockWaitOf). Each poll is one round trip on the observer session, issued back to back; nothing waits
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
			const wait = yield* lockWaitOf(observer, pid)
			if (
				wait !== undefined &&
				Option.match(blockedBy, {
					onNone: () => true,
					onSome: (holder) => wait.blockedBy.includes(holder)
				})
			) {
				return wait
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
				const wait = yield* lockWaitOf(observer, Number(only[0]))
				if (wait !== undefined) {
					return wait
				}
			}
			yield* Effect.yieldNow
		}
	})
