import { Array as Arr, Brand, Effect } from "effect"
import { quoteIdent, quoteString } from "#compiler/sql/print.ts"
import type { Names } from "#test/support/kernel/naming.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { TransactionRolledBack } from "#test/support/substrate/errors.ts"

/**
 * How a reset empties its group: `whole`, every table truncated; or `occupied`, only the tables that hold a block and,
 * transitively, every table of the group whose foreign key references one of them, which TRUNCATE requires truncated
 * with it. A table of no block holds no version, live or dead, so a reset reads no version another transaction wrote
 * whether it truncates that table or not.
 */
type Emptying = "whole" | "occupied"

/**
 * The tables one reset empties together (schema-qualified, quoted), and how: a whole group, built only by
 * installationGroup, occupiedGroup, fixtureGroup or schemaGroup, and emptied only by one TRUNCATE of all of it or of
 * its occupied part (replaceRows, clearRows).
 */
export type ResetGroup = {
	readonly tables: ReadonlyArray<string>
	readonly emptying: Emptying
} & Brand.Brand<"ResetGroup">
const ResetGroup = Brand.nominal<ResetGroup>()

/**
 * Every stored relation's table of an installation, by its names (kernel/naming.ts namesOf, or installationNamesOf
 * for one installed from its compiled script): its rows are the state a case writes whole. An installation of closed
 * relations alone stores nothing, and its group truncates nothing.
 */
export const installationGroup = (names: Names): ResetGroup =>
	ResetGroup({ tables: names.storedTables, emptying: "whole" })

/**
 * Every stored relation's table of an installation, as installationGroup, emptied by its occupied part (Emptying): the
 * group of an installation of many tables whose cases each write a few, the write oracle's every group of a generated
 * schema, so a reset truncates the tables a case wrote and not every table of the schema.
 */
export const occupiedGroup = (names: Names): ResetGroup =>
	ResetGroup({ tables: names.storedTables, emptying: "occupied" })

/** Every table a fixture's own DDL creates, which a test builds by hand rather than installs. */
export const fixtureGroup = (tables: Arr.NonEmptyReadonlyArray<string>): ResetGroup =>
	ResetGroup({ tables, emptying: "whole" })

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
				tables: Arr.map(rows, ([table]) => `${quoteIdent(schema)}.${quoteIdent(String(table))}`),
				emptying: "whole"
			})
	)

/**
 * The one statement that truncates the occupied part of `tables` (Emptying): the tables of a block, closed over the
 * group's tables whose foreign keys reference one, by pg_constraint, then one TRUNCATE of them, none when none holds a
 * block. Its TRUNCATE names tables of the group alone, so a table outside the group that references one of them is
 * refused as TRUNCATE refuses it (0A000), never truncated.
 */
const occupiedTruncation = (tables: Arr.NonEmptyReadonlyArray<string>): string =>
	`DO $reset$
DECLARE
	occupied text;
BEGIN
	WITH RECURSIVE grouped(rel, name) AS (
		SELECT n::regclass, n FROM pg_catalog.unnest(ARRAY[${Arr.join(Arr.map(tables, quoteString), ", ")}]::text[]) AS n
	), reached(rel) AS (
		SELECT g.rel FROM grouped AS g WHERE pg_catalog.pg_relation_size(g.rel) > 0
		UNION
		SELECT c.conrelid FROM reached AS r JOIN pg_catalog.pg_constraint AS c ON c.contype = 'f' AND c.confrelid = r.rel
	)
	SELECT pg_catalog.string_agg(g.name, ', ') INTO occupied FROM grouped AS g WHERE g.rel IN (SELECT r.rel FROM reached AS r);
	IF occupied IS NOT NULL THEN
		EXECUTE 'TRUNCATE ' || occupied;
	END IF;
END
$reset$`

/** The one statement that empties `group` as its Emptying says; none when the group holds no table. */
const truncation = (group: ResetGroup): ReadonlyArray<ReplacedStatement> => {
	if (!Arr.isReadonlyArrayNonEmpty(group.tables)) {
		return []
	}
	switch (group.emptying) {
		case "whole":
			return [{ sql: `TRUNCATE ${Arr.join(group.tables, ", ")}`, params: [] }]
		case "occupied":
			return [{ sql: occupiedTruncation(group.tables), params: [] }]
	}
}

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
 * its group, every table or its occupied part (Emptying), then the inserts. TRUNCATE reads no row, and the inserts' own
 * checks (a foreign key's, a law's) read the rows the transaction itself inserted, since no row of the group outlives
 * the reset, a table either truncated or of no block, and a sequence's tuple is frozen: the transaction has no
 * rw-conflict out, so it is never a pivot and never fails with 40001. Neither a truncated table nor one of no block
 * holds a dead version, so the reads and writes of the case after it meet only the replacing transaction's live rows.
 *
 * The group is whole by construction (ResetGroup): every stored relation's table of an installation, migrated or
 * installed from its compiled script, or every table of a fixture a test creates by hand. A part of one is not
 * expressible: TRUNCATE refuses a table another references unless that one is truncated with it (0A000, "cannot
 * truncate a table referenced in a foreign key constraint"), and a table of a block the reset left alone would keep
 * rows an earlier transaction wrote for the inserts' checks to read. An occupied emptying leaves alone only tables of no
 * block, and closes what it truncates over the group's references, so no table it leaves holds a version and no
 * reference within the group refuses its TRUNCATE.
 *
 * Replaces the rows of every table of `group` with what `statements` insert, in one SERIALIZABLE transaction on one
 * backend of `connection`: one TRUNCATE of the group as its Emptying says, then the statements. A COMMIT that
 * PostgreSQL answers with ROLLBACK fails with TransactionRolledBack.
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
 * `connection` (a PgConnection, or a substrate proof's own RawSession): one TRUNCATE of the group as its Emptying says,
 * alone in its transaction, for replaceRows' reasons. It reads no row, so it has no rw-conflict for SSI to cancel it
 * by, where a DELETE reads every dead version an earlier case left; it takes the group's every table that references
 * one it truncates, so no foreign key among its tables refuses it; and the tables it leaves hold no version, live or
 * dead, for the next case to meet.
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
