import { Array as Arr, Data, Effect, Predicate } from "effect"
import type { PgConnection, SqlError } from "#test/support/pg.ts"

/**
 * One table of a fill: its name, as printed, and each column's SQL over the row's index `g`, by printed column name. No
 * column fills rows of defaults only.
 */
export interface VolumeTable {
	readonly table: string
	readonly columns: ReadonlyArray<readonly [column: string, sql: string]>
}

/**
 * A volume fill: its tables filled over one series of indices, 0 to `rows` − 1, in chunks, each chunk one transaction
 * that inserts the same slice of the series into every table, in order, so rows of the tables that belong together by
 * their index commit together. A row whose key another already holds is refused, or skipped where `conflicts` says so.
 */
export interface VolumeFill {
	readonly tables: Arr.NonEmptyReadonlyArray<VolumeTable>
	readonly rows: number
	readonly conflicts: "refused" | "skipped"
}

/**
 * A fill a chunking could split a law of: a table of it whose INSERT fires an enabled INITIALLY DEFERRED trigger that
 * is no foreign key's (a constraint trigger, as grizzle's family, fold and rule laws are, or a deferred unique check),
 * or that is the check of a deferred foreign key into a table a later fill fills, whose rows no chunk of this one could
 * meet. It names the table and the deferred object, by its constraint or its own name. Its rows are lawful only as a
 * whole, in one transaction.
 */
export class VolumeFillRefused extends Data.TaggedError("VolumeFillRefused")<{
	readonly table: string
	readonly deferred: string
}> {}

/**
 * The enabled INITIALLY DEFERRED triggers of the table $1 names that an INSERT fires (tgtype's TRIGGER_TYPE_INSERT bit,
 * 1 << 2, REL_19_0 src/include/catalog/pg_trigger.h), each by the constraint it implements where it implements one (a
 * foreign key's or a unique check's trigger, named by PostgreSQL after an OID), else by its own name, and the OID of the
 * table a foreign key's check references, or none. A fill only inserts, so a deferred trigger of another event, as the
 * referenced side of a deferred foreign key holds for UPDATE and DELETE, never judges its rows.
 */
const deferredTriggers = `SELECT coalesce(c.conname, t.tgname)::text, CASE WHEN c.contype = 'f' THEN c.confrelid::int8 END
FROM pg_catalog.pg_trigger AS t LEFT JOIN pg_catalog.pg_constraint AS c ON c.oid = t.tgconstraint
WHERE t.tgrelid = $1::pg_catalog.regclass AND t.tginitdeferred AND t.tgenabled <> 'D' AND (t.tgtype::int4 & 4) <> 0
ORDER BY 1`

/** The OID of the table $1 names. */
const tableOid = "SELECT $1::pg_catalog.regclass::oid::int8"

/** The cluster's WAL segment, in bytes. */
const segmentBytes =
	"SELECT pg_catalog.pg_size_bytes(pg_catalog.current_setting('wal_segment_size'))"

/**
 * The WAL this backend has written, in bytes, as its statistics stand at their last flush. A backend flushes its
 * statistics when a transaction ends, at most once a second, unless pg_stat_force_next_flush asked it to: then the
 * transaction that asked flushes at its own end. So a count read right after that call's transaction holds every
 * statement before it.
 */
const backendWal =
	"SELECT wal_bytes::int8 FROM pg_catalog.pg_stat_get_backend_wal(pg_catalog.pg_backend_pid())"

/** The one int8 cell a statement of one row and one column answers. */
const int8Cell = (
	session: PgConnection,
	sql: string,
	params: ReadonlyArray<unknown>
): Effect.Effect<bigint, SqlError> =>
	Effect.flatMap(session.queryValues(sql, params), (rows) => {
		const cell = rows[0]?.[0]
		return Predicate.isBigInt(cell) && rows.length === 1
			? Effect.succeed(cell)
			: Effect.die(new Error(`${sql} answered no one int8 cell`))
	})

/** This backend's WAL count, its statistics flushed first (backendWal). */
const flushedWal = (session: PgConnection): Effect.Effect<number, SqlError> =>
	Effect.andThen(
		session.query("SELECT pg_catalog.pg_stat_force_next_flush()", []),
		Effect.map(int8Cell(session, backendWal, []), Number)
	)

/** One table's rows from index `from` to `to`, both included, as one INSERT. */
export const insertOf = (
	table: VolumeTable,
	conflicts: VolumeFill["conflicts"],
	from: number,
	to: number
): string => {
	const columns = Arr.isReadonlyArrayNonEmpty(table.columns)
		? ` (${Arr.join(
				Arr.map(table.columns, ([column]) => column),
				", "
			)})`
		: ""
	const values = Arr.join(
		Arr.map(table.columns, ([, sql]) => sql),
		", "
	)
	const skipped = conflicts === "skipped" ? " ON CONFLICT DO NOTHING" : ""
	return `INSERT INTO ${table.table}${columns} SELECT ${values} FROM pg_catalog.generate_series(${from}, ${to}) AS s(g)${skipped}`
}

/**
 * One chunk a fill committed: the fill's place among the fills, the indices of its first and last rows, the rows it
 * inserted (fewer than its indices where keys already held skipped some), and the WAL its transaction wrote, none where
 * it inserted no row: such a transaction takes no XID and writes nothing.
 */
export interface VolumeChunk {
	readonly fill: number
	readonly from: number
	readonly to: number
	readonly inserted: number
	readonly wal: number
}

/** What the fills have committed so far: their chunks in order, and this backend's WAL count after the last. */
interface Filled {
	readonly chunks: ReadonlyArray<VolumeChunk>
	readonly written: number
}

/**
 * The slice `from` to `to` of every table of `fill`, in one transaction, and the rows its INSERTs inserted. Its COMMIT
 * judges every deferred law the slice touches, as the whole fill's would, so a chunk that would split one fails there,
 * typed, and commits nothing.
 */
const chunk = (
	session: PgConnection,
	fill: VolumeFill,
	from: number,
	to: number
): Effect.Effect<number, SqlError> =>
	Effect.gen(function* () {
		yield* session.query("BEGIN", [])
		const [inserted, committed] = yield* Effect.onError(
			Effect.all([
				Effect.map(
					Effect.forEach(fill.tables, (table) =>
						session.query(insertOf(table, fill.conflicts, from, to), [])
					),
					(results) => Arr.reduce(results, 0, (rows, result) => rows + result.rowCount)
				),
				session.query("COMMIT", [])
			]),
			() => Effect.ignore(session.query("ROLLBACK", []))
		)
		if (committed.command !== "COMMIT") {
			return yield* Effect.die(
				new Error(
					`a chunk's COMMIT answered ${committed.command}, though none of its statements failed`
				)
			)
		}
		return inserted
	})

/**
 * Fills fill `at` of the fills from index `from` in chunks, after `filled`. A chunk of `size` indices runs, and the
 * next one's size is the indices the cluster's WAL segment holds at the WAL each index of it wrote: `segment` × `size`
 * over the bytes the chunk wrote, this backend's own as its statistics count them once flushed (flushedWal), and never
 * less than one index. So no chunk's transaction holds its XID past about one segment of WAL, whatever the other files
 * of the cluster write meanwhile, and no number of rows is anyone's choice: the first chunk is one index, and each later
 * one is sized by the last chunk that wrote. A chunk whose INSERTs inserted no row, every key of its slice already held,
 * wrote nothing and measures nothing, so the size it ran at stands. One that inserted rows and counted no WAL is a defect
 * of the count, and dies.
 */
const fillFrom = (
	session: PgConnection,
	segment: number,
	fill: VolumeFill,
	at: number,
	from: number,
	size: number,
	filled: Filled
): Effect.Effect<Filled, SqlError> =>
	from >= fill.rows
		? Effect.succeed(filled)
		: Effect.gen(function* () {
				const rows = Math.min(size, fill.rows - from)
				const inserted = yield* chunk(session, fill, from, from + rows - 1)
				const written = yield* flushedWal(session)
				const wal = written - filled.written
				if (wal < 0 || (wal === 0 && inserted > 0)) {
					return yield* Effect.die(
						new Error(
							`a chunk of ${rows} indices of fill ${at} inserted ${inserted} rows and counted ${wal} bytes of WAL`
						)
					)
				}
				return yield* fillFrom(
					session,
					segment,
					fill,
					at,
					from + rows,
					wal === 0 ? size : Math.max(1, Math.floor((segment * rows) / wal)),
					{
						chunks: [...filled.chunks, { fill: at, from, to: from + rows - 1, inserted, wal }],
						written
					}
				)
			})

/**
 * The first refusal the fills' tables meet, in order (VolumeFillRefused): a deferred trigger an INSERT fires that is no
 * foreign key's, or a deferred foreign key into a table a later fill fills. A deferred foreign key into a table already
 * complete, or into a table of its own fill, is admitted: each chunk's COMMIT judges it over rows that are all there.
 */
const admission = (
	session: PgConnection,
	fills: Arr.NonEmptyReadonlyArray<VolumeFill>
): Effect.Effect<void, SqlError | VolumeFillRefused> =>
	Effect.gen(function* () {
		const oids = yield* Effect.forEach(fills, (f) =>
			Effect.forEach(f.tables, (t) => int8Cell(session, tableOid, [t.table]))
		)
		for (const [at, f] of fills.entries()) {
			const later = Arr.flatten(Arr.drop(oids, at + 1))
			for (const t of f.tables) {
				const deferred = yield* session.queryValues(deferredTriggers, [t.table])
				for (const [name, referenced] of deferred) {
					if (!Predicate.isBigInt(referenced) || Arr.contains(later, referenced)) {
						return yield* new VolumeFillRefused({ table: t.table, deferred: String(name) })
					}
				}
			}
		}
	})

/**
 * Fills `fills` in order, each a volume fixture whose every chunk boundary is a lawful state, so no fill holds a
 * transaction across more than one chunk of it. The fills are admitted first, against the catalog, before any row is
 * written (admission). Then each fill's rows commit chunk by chunk (fillFrom) on one pinned session of `connection`, a
 * fill's rows after every row of the fills before it. It answers every chunk it committed, in order.
 */
export const volumeFill = (
	connection: PgConnection,
	fills: Arr.NonEmptyReadonlyArray<VolumeFill>
): Effect.Effect<ReadonlyArray<VolumeChunk>, SqlError | VolumeFillRefused> =>
	Effect.scoped(
		Effect.gen(function* () {
			const session = yield* connection.pin
			yield* admission(session, fills)
			const segment = yield* Effect.map(int8Cell(session, segmentBytes, []), Number)
			const written = yield* flushedWal(session)
			const filled = yield* Effect.reduce(
				Arr.map(fills, (f, at) => [at, f] as const),
				(): Filled => ({ chunks: [], written }),
				(done, [at, f]) => fillFrom(session, segment, f, at, 0, 1, done)
			)
			return filled.chunks
		})
	)
