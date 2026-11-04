import { Effect, Schema } from "effect"
import type { BenchSession } from "#bench/harness/session.ts"
import type { SqlError } from "#test/support/pg.ts"

import { regex } from "arkregex"
/**
 * WAL measurement for the performance gates.
 *
 * "Use WAL instrumentation for inserts, generated indexes, law-trigger work, and refreshes. A transaction carrier is a
 * temporary relation whose rows are not WAL-logged, but creating it writes catalog rows that are, and those count.
 * PG19 reports full-page-image bytes separately; checkpoint state can change that cost".
 *
 * EXPLAIN's WAL counters cover the statement's plan alone; a deferred law function fires at COMMIT and AFTER triggers
 * fire after the plan (explain.ts). A transaction's WAL is therefore read from the backend's own cumulative counters,
 * pg_stat_get_backend_wal(pid) (PostgreSQL 18 and later), before BEGIN and after COMMIT:
 * - a backend publishes its pending counters when it goes idle, at most once a second unless the next report is
 *   forced, so every reading first runs pg_stat_force_next_flush() in a statement of its own: the report at the end
 *   of that statement publishes everything the backend did before it, the transaction under measurement included;
 * - the reading then runs in a new transaction, whose statistics snapshot is fresh (stats_fetch_consistency = cache
 *   keeps one snapshot per transaction).
 * The two readings bracket the transaction, the force and read statements beside it, which write no WAL. The counters
 * are the backend's, so the session must stay on one backend for the whole measurement, as every session, a direct
 * one, does.
 *
 * The cluster's insert position before and after is recorded beside it as `clusterBytes`: every backend's WAL in that
 * window, the checkpointer's and autovacuum's included, which reads as the transaction's own only on a quiet
 * cluster. The two are never added together.
 *
 * Full-page images: PG19 reports their bytes separately (pg_stat_get_backend_wal's wal_fpi_bytes, beside the count
 * wal_fpi), and they are written for the first change to a page after a checkpoint's redo point, so the checkpoint
 * state is part of the reading: the redo point from pg_control_checkpoint() before and after (readable by every role),
 * and whether a checkpoint completed inside the window, which moves it. A sample whose window holds a checkpoint pays
 * full-page images a sample on the same pages outside one does not.
 *
 *  A backend's cumulative WAL counters, from pg_stat_get_backend_wal.
 */
export interface BackendWal {
	readonly records: number
	readonly fpi: number
	readonly bytes: number
	/** Bytes of the full-page images among `bytes` (PG19). */
	readonly fpiBytes: number
	readonly buffersFull: number
}

interface WalPosition {
	readonly backend: BackendWal
	/** pg_current_wal_insert_lsn(), as text (X/Y). */
	readonly lsn: string
	/** The redo point of the last completed checkpoint, as text (X/Y). */
	readonly redoLsn: string
}

export interface CheckpointState {
	readonly redoLsnBefore: string
	readonly redoLsnAfter: string
	/** Whether a checkpoint completed between the readings: the redo point moved. */
	readonly completed: boolean
	/**
	 * WAL bytes from the redo point to the insert position at the first reading: how far the window began from the last
	 * checkpoint.
	 */
	readonly bytesSinceRedo: number
}

export interface WalDelta {
	/** This backend's WAL between the readings. */
	readonly backend: BackendWal
	/** Every backend's WAL between the readings, from the insert position. */
	readonly clusterBytes: number
	readonly checkpoint: CheckpointState
}

/** An LSN's position in bytes: X/Y is the high and low 32 bits in hexadecimal. */
const lsnBytes = (lsn: string): bigint => {
	const match = regex("^([0-9A-Fa-f]{1,8})/([0-9A-Fa-f]{1,8})$").exec(lsn)
	if (match === null) {
		throw new RangeError(`not an LSN: ${lsn}`)
	}
	return (BigInt(`0x${match[1]}`) << 32n) + BigInt(`0x${match[2]}`)
}

const counter = (value: string, what: string): number => {
	const n = Number(value)
	if (!Number.isSafeInteger(n) || n < 0) {
		throw new RangeError(`${what}: ${value} is not a counter`)
	}
	return n
}

/**
 * Reads this backend's published WAL counters and the cluster's insert position. Never inside a transaction block: a
 * reading there would see the snapshot taken when the block began. The reading's one row of text cells, from
 * PostgreSQL: external input, decoded.
 */
const PositionRows = Schema.Tuple([
	Schema.Tuple([
		Schema.String,
		Schema.String,
		Schema.String,
		Schema.String,
		Schema.String,
		Schema.String,
		Schema.String
	])
])

const walPosition = Effect.fn("walPosition")(function* (
	session: BenchSession
): Effect.fn.Return<WalPosition, SqlError> {
	yield* session.values("SELECT pg_catalog.pg_stat_force_next_flush()", [])
	const rows = yield* session.values(
		"SELECT w.wal_records::text, w.wal_fpi::text, w.wal_bytes::text, w.wal_fpi_bytes::text, " +
			"w.wal_buffers_full::text, pg_catalog.pg_current_wal_insert_lsn()::text, c.redo_lsn::text " +
			"FROM pg_catalog.pg_stat_get_backend_wal(pg_catalog.pg_backend_pid()) AS w, " +
			"pg_catalog.pg_control_checkpoint() AS c",
		[]
	)
	const [[records, fpi, bytes, fpiBytes, buffersFull, lsn, redoLsn]] = yield* Effect.orDie(
		Schema.decodeUnknownEffect(PositionRows)(rows)
	)
	return {
		backend: {
			records: counter(records, "wal_records"),
			fpi: counter(fpi, "wal_fpi"),
			bytes: counter(bytes, "wal_bytes"),
			fpiBytes: counter(fpiBytes, "wal_fpi_bytes"),
			buffersFull: counter(buffersFull, "wal_buffers_full")
		},
		lsn,
		redoLsn
	}
})

const walDelta = (before: WalPosition, after: WalPosition): WalDelta => {
	const d = (key: keyof BackendWal): number => {
		const value = after.backend[key] - before.backend[key]
		if (value < 0) {
			throw new RangeError(
				`backend WAL ${key} decreased: the readings came from different backends`
			)
		}
		return value
	}
	const redoBefore = lsnBytes(before.redoLsn)
	const redoAfter = lsnBytes(after.redoLsn)
	if (redoAfter < redoBefore) {
		throw new RangeError("the checkpoint redo point moved back between the readings")
	}
	return {
		backend: {
			records: d("records"),
			fpi: d("fpi"),
			bytes: d("bytes"),
			fpiBytes: d("fpiBytes"),
			buffersFull: d("buffersFull")
		},
		clusterBytes: Number(lsnBytes(after.lsn) - lsnBytes(before.lsn)),
		checkpoint: {
			redoLsnBefore: before.redoLsn,
			redoLsnAfter: after.redoLsn,
			completed: redoAfter > redoBefore,
			bytesSinceRedo: Number(lsnBytes(before.lsn) - redoBefore)
		}
	}
}

/**
 * The WAL `effect` writes on `session`'s backend, beside its value. `effect` must leave the session outside a
 * transaction block, as a committed or rolled-back transaction does.
 */
export const measureWal = Effect.fn("measureWal")(function* <A, E, R>(
	session: BenchSession,
	effect: Effect.Effect<A, E, R>
): Effect.fn.Return<{ readonly value: A; readonly wal: WalDelta }, E | SqlError, R> {
	const before = yield* walPosition(session)
	const value = yield* effect
	const after = yield* walPosition(session)
	return { value, wal: walDelta(before, after) }
})
