import { Array as Arr, Brand, Effect } from "effect"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { Names } from "#test/support/kernel/naming.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { TransactionRolledBack } from "#test/support/substrate/errors.ts"

/**
 * The tables one reset truncates together (schema-qualified, quoted): a whole group, built only by installationGroup,
 * fixtureGroup or schemaGroup, and emptied only by a TRUNCATE of all of it (replaceRows, clearRows).
 */
export type ResetGroup = { readonly tables: ReadonlyArray<string> } & Brand.Brand<"ResetGroup">
const ResetGroup = Brand.nominal<ResetGroup>()

/**
 * Every stored relation's table of an installation, by its names (kernel/naming.ts namesOf, or installationNamesOf
 * for one installed from its compiled script): its rows are the state a case writes whole. An installation of closed
 * relations alone stores nothing, and its group truncates nothing.
 */
export const installationGroup = (names: Names): ResetGroup =>
	ResetGroup({ tables: names.storedTables })

/** Every table a fixture's own DDL creates, which a test builds by hand rather than installs. */
export const fixtureGroup = (tables: Arr.NonEmptyReadonlyArray<string>): ResetGroup =>
	ResetGroup({ tables })

/**
 * Every table of a schema a test owns whole, read off the catalog once the schema's hand-written DDL is installed: the
 * group of a substrate proof's seat (test/pg/substrate), whose schema holds no table but the proof's, so no table its
 * DDL creates is left out. A partitioned table is one, beside each of its partitions; a view, a sequence or any other
 * relation is none. A schema that does not exist is refused (3F000).
 */
export const schemaGroup = (
	admin: PgConnection,
	schema: string
): Effect.Effect<ResetGroup, SqlError> =>
	Effect.map(
		admin.queryValues(
			"SELECT c.relname::text FROM pg_catalog.pg_class AS c WHERE c.relnamespace = $1::text::regnamespace AND c.relkind IN ('r', 'p') ORDER BY 1",
			[quoteIdent(schema)]
		),
		(rows) =>
			ResetGroup({
				tables: Arr.map(rows, ([table]) => `${quoteIdent(schema)}.${quoteIdent(String(table))}`)
			})
	)

/** The TRUNCATE of every table of `group`, in one statement; none when the group holds no table. */
const truncation = (group: ResetGroup): ReadonlyArray<ReplacedStatement> =>
	Arr.isReadonlyArrayNonEmpty(group.tables)
		? [{ sql: `TRUNCATE ${Arr.join(group.tables, ", ")}`, params: [] }]
		: []

/**
 * One statement of the replacing transaction after its TRUNCATE, an insert or a sequence's setting (one set where the
 * case's identities start, or advanced past what the inserts stored): its text and its parameters, as the connection
 * sends them.
 */
export interface ReplacedStatement {
	readonly sql: string
	readonly params: ReadonlyArray<unknown>
}

/**
 * Replacing a fixture's rows between the cases of a suite that reads them, as a direct writer at SERIALIZABLE.
 *
 * Every transaction is SERIALIZABLE, and PostgreSQL's SSI is conservative once the cluster is loaded. A long
 * transaction anywhere in the cluster holds the xmin horizon back, so a read that committed before a writer began still
 * counts as concurrent with it, and its SIREAD locks stay; and once the finished transactions outnumber SSI's table,
 * PostgreSQL summarizes the oldest, after which a version a summarized transaction wrote counts as a concurrent write
 * to whoever reads it, whatever their snapshot (predicate.c CheckForSerializableConflictOut, the summarized path,
 * checks no concurrency). A reset DELETE then reads a dead row an earlier case left, written by a summarized
 * transaction, which gives it a conflict out, and deletes rows an earlier read locked, which gives it a conflict in: it
 * fails with 40001, "Canceled on identification as a pivot, during write", though nothing ran beside it. Run alone the
 * suites pass; under a full parallel run, or two copies of one file, they fail.
 *
 * So a case's rows are written whole, in one transaction that reads no version another transaction wrote: TRUNCATE of
 * every table of its group, then the inserts. TRUNCATE reads no row, and the inserts' own checks (a foreign key's, a
 * law's) read the rows the transaction itself inserted, since no row of the group outlives the TRUNCATE, and a
 * sequence's tuple is frozen: the transaction has no rw-conflict out, so it is never a pivot and never fails with
 * 40001. A truncated table holds no dead version either, so the reads and writes of the case after it meet only the
 * replacing transaction's live rows.
 *
 * The group is whole by construction (ResetGroup): every stored relation's table of an installation, migrated or
 * installed from its compiled script, or every table of a fixture a test creates by hand. A part of one is not
 * expressible: TRUNCATE refuses a table another references unless that one is truncated with it (0A000, "cannot
 * truncate a table referenced in a foreign key constraint"), and a table the reset left alone would keep rows an
 * earlier transaction wrote for the inserts' checks to read.
 *
 * Replaces the rows of every table of `group` with what `statements` insert, in one SERIALIZABLE transaction on one
 * backend of `connection`: one TRUNCATE of the whole group, then the statements. A COMMIT that PostgreSQL answers with
 * ROLLBACK fails with TransactionRolledBack.
 */
export const replaceRows = (
	connection: PgConnection,
	group: ResetGroup,
	statements: ReadonlyArray<ReplacedStatement>
): Effect.Effect<void, SqlError | TransactionRolledBack> =>
	Effect.scoped(
		Effect.gen(function* () {
			const pinned = yield* connection.pin
			yield* pinned.query("BEGIN ISOLATION LEVEL SERIALIZABLE", [])
			yield* Effect.onError(
				Effect.forEach(
					[...truncation(group), ...statements],
					(statement) => pinned.query(statement.sql, statement.params),
					{ discard: true }
				),
				() => Effect.ignore(pinned.query("ROLLBACK", []))
			)
			const committed = yield* pinned.query("COMMIT", [])
			if (committed.command !== "COMMIT") {
				return yield* new TransactionRolledBack({ label: "replace", command: committed.command })
			}
		})
	)

/**
 * Empties every table of `group` between the cases of a suite that clears its state rather than replacing it, on
 * `connection` (a PgConnection, or a substrate proof's own RawSession): one TRUNCATE of the whole group, alone in its
 * transaction, for replaceRows' reasons. It reads no row, so it has no rw-conflict for SSI to cancel it by, where a
 * DELETE reads every dead version an earlier case left; it takes the whole group, so no foreign key among its tables
 * refuses it; and the tables it leaves hold no version, live or dead, for the next case to meet.
 */
export const clearRows = (
	connection: Pick<PgConnection, "query">,
	group: ResetGroup
): Effect.Effect<void, SqlError> =>
	Effect.forEach(
		truncation(group),
		(statement) => connection.query(statement.sql, statement.params),
		{
			discard: true
		}
	)
