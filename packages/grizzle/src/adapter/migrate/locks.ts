import { Array as Arr, Option } from "effect"
import { C } from "#compiler/plan/catalog.ts"

/**
 * The server's lock table, as `grizzle migrate` holds its transactions to it: its capacity read from the server's own
 * settings in the survey, never a number of grizzle's.
 *
 * PostgreSQL 19 sizes its shared lock table at startup, by the hash of one LOCK per locked object, to NLOCKENTS:
 *
 * - lock.c#L59-L60, `#define NLOCKENTS() mul_size(max_locks_per_xact, add_size(MaxBackends, max_prepared_xacts))`,
 *   which LockManagerShmemRequest requests as the LOCK hash's elements (lock.c#L458-L471);
 * - postinit.c#L571-L572, InitializeMaxBackends: `MaxBackends = MaxConnections + autovacuum_worker_slots +
 *   max_worker_processes + max_wal_senders + NUM_SPECIAL_WORKER_PROCS`;
 * - proc.h#L520, `#define NUM_SPECIAL_WORKER_PROCS 2`, the autovacuum launcher and the slotsync worker
 *   (specialWorkerProcesses).
 * - shmem_hash.c#L154-L163, shmem_hash_create: a hash in shared memory is HASH_FIXED_SIZE, every element allocated
 *   up front, so the LOCK hash holds NLOCKENTS objects and not one more, whatever shared memory is left.
 *
 * All at https://github.com/postgres/postgres/blob/REL_19_0/src/, verified 2026-11-21. So the capacity is
 * max_locks_per_transaction × (max_connections + autovacuum_worker_slots + max_worker_processes + max_wal_senders + 2 +
 * max_prepared_transactions) objects, every transaction of the server sharing it. A migration's transaction that locks
 * an object past what is left is refused with 53200 and rolls back (LockTableExhausted); so migrate reads the six
 * settings in its survey, before anything runs, and refuses an apply whose largest transaction, its lock demand as its
 * folders' meta.json state it or as the drift check's replay counts it (deploy/locks/demand.ts), the table cannot hold
 * even alone (LockTableShort).
 */

/**
 * The server processes PostgreSQL counts in its backends beside the ones its settings name, the autovacuum launcher and
 * the slot sync worker, each a backend that can lock (postinit.c InitializeMaxBackends adds them to MaxBackends).
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit server processes
 * @scope the backends PostgreSQL adds to max_connections, autovacuum_worker_slots, max_worker_processes and
 *   max_wal_senders in MaxBackends, which sizes the shared lock table (lock.c NLOCKENTS)
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/storage/proc.h#L520
 * @quote #define NUM_SPECIAL_WORKER_PROCS	2
 * @verified 2026-11-21
 */
export const specialWorkerProcesses = 2

/** The six settings that size a server's lock table, as integers (lockTableOf). */
export interface LockTableSettings {
	readonly maxLocksPerTransaction: number
	readonly maxConnections: number
	readonly autovacuumWorkerSlots: number
	readonly maxWorkerProcesses: number
	readonly maxWalSenders: number
	readonly maxPreparedTransactions: number
}

/** The settings, in the order the survey reads them (lockTableColumns) and a refusal states them. */
const lockTableSettings = [
	"max_locks_per_transaction",
	"max_connections",
	"autovacuum_worker_slots",
	"max_worker_processes",
	"max_wal_senders",
	"max_prepared_transactions"
] as const

const serverSettings = C.from("pg_settings", "s")

/** Each of the six settings as pg_settings reports it, a column each, in lockTableSettings order. */
export const lockTableColumns: Arr.NonEmptyReadonlyArray<C.CatalogExpr> = Arr.map(
	lockTableSettings,
	(name) =>
		C.asText(
			C.scalar(
				C.query(
					[serverSettings.col("setting")],
					[serverSettings.item],
					C.eq(serverSettings.col("name"), C.text(name))
				)
			)
		)
)

/** A setting's integer as pg_settings reports it, none for a text that is no non-negative integer: digits alone. */
const count = (text: string | undefined): Option.Option<number> => {
	if (text === undefined || text.length === 0) {
		return Option.none()
	}
	for (const ch of text) {
		if (ch < "0" || ch > "9") {
			return Option.none()
		}
	}
	const n = Number(text)
	return Number.isSafeInteger(n) ? Option.some(n) : Option.none()
}

/** The six settings of a row read by lockTableColumns, from its first cell on; none where one is no integer. */
export const lockTableOf = (cells: ReadonlyArray<string>): Option.Option<LockTableSettings> =>
	Option.all({
		maxLocksPerTransaction: count(cells[0]),
		maxConnections: count(cells[1]),
		autovacuumWorkerSlots: count(cells[2]),
		maxWorkerProcesses: count(cells[3]),
		maxWalSenders: count(cells[4]),
		maxPreparedTransactions: count(cells[5])
	})

/** The lock entries each slot of max_locks_per_transaction buys: MaxBackends plus max_prepared_transactions. */
const lockedBackends = (t: LockTableSettings): number =>
	t.maxConnections +
	t.autovacuumWorkerSlots +
	t.maxWorkerProcesses +
	t.maxWalSenders +
	specialWorkerProcesses +
	t.maxPreparedTransactions

/** The objects a server's lock table holds locked at once, for every transaction (lock.c NLOCKENTS). */
export const lockTableCapacity = (t: LockTableSettings): number =>
	t.maxLocksPerTransaction * lockedBackends(t)

/** The capacity's formula with the server's settings in it, and its product, as a refusal states it. */
export const lockTableText = (t: LockTableSettings): string =>
	`max_locks_per_transaction × (max_connections + autovacuum_worker_slots + max_worker_processes + max_wal_senders + ${specialWorkerProcesses} + max_prepared_transactions) = ${t.maxLocksPerTransaction} × (${t.maxConnections} + ${t.autovacuumWorkerSlots} + ${t.maxWorkerProcesses} + ${t.maxWalSenders} + ${specialWorkerProcesses} + ${t.maxPreparedTransactions}) = ${lockTableCapacity(t)} locks`

/**
 * The least max_locks_per_transaction at which a server of `t`'s other settings holds `locks` objects locked at once:
 * the capacity's slot count, rounded up. The function a test cluster's specification sizes its members by (the testing
 * library's localCluster): `locks` the largest transaction its installations' meta.json files state, times the
 * transactions that run at once, each on its own member's share.
 */
export const maxLocksPerTransactionFor = (
	locks: number,
	t: Omit<LockTableSettings, "maxLocksPerTransaction">
): number => Math.ceil(locks / lockedBackends({ ...t, maxLocksPerTransaction: 0 }))

/** The least max_connections at which a server of `t`'s other settings holds `locks` objects locked at once. */
export const maxConnectionsFor = (locks: number, t: LockTableSettings): number =>
	Math.max(
		t.maxConnections,
		Math.ceil(locks / t.maxLocksPerTransaction) - (lockedBackends(t) - t.maxConnections)
	)
