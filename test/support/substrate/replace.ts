import { Array as Arr, Brand, Effect } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import type { Names } from "#test/support/kernel/naming.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { TransactionRolledBack } from "#test/support/substrate/errors.ts"

/**
 * How a reset empties its group: `whole`, every table truncated, so no table holds a version, live or dead, a fresh
 * relation file each, for the suites that read a table's pages or plans; or `rows`, every row deleted, its table's
 * files kept, in a READ COMMITTED transaction of its own with no trigger firing (rowsDeletion), for a group of many
 * tables whose cases each write a few and read only their rows: TRUNCATE gives each table it empties and each of its
 * indexes a new relation file, so its cost grows with the group's relations, where a DELETE's grows with the rows.
 */
type Emptying = "whole" | "rows"

/**
 * The tables one reset empties together (schema-qualified, quoted), and how: a whole group, built only by
 * installationGroup, rowsGroup, fixtureGroup or schemaGroup, and emptied only by one TRUNCATE of all of it or by
 * deleting all its rows (replaceRows, clearRows).
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
 * Every table of `tables`, an installation's stored relations' (kernel/naming.ts Names storedTables) or a fixture's,
 * emptied by deleting its rows (Emptying): the group of an installation of many tables whose cases each write a few, the
 * write oracle's every group of a generated schema, so a reset swaps no relation file and costs the rows the cases
 * before it wrote.
 */
export const rowsGroup = (tables: ReadonlyArray<string>): ResetGroup =>
	ResetGroup({ tables, emptying: "rows" })

/** No table: the group of a template whose cases write no table of its own (substrate.ts base). */
export const noTables: ResetGroup = ResetGroup({ tables: [], emptying: "whole" })

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
 * The deletion of every row of `tables` (Emptying rows): its own READ COMMITTED transaction, under the replica role, so
 * no trigger fires, neither a law's nor a foreign key's (each table of the group is emptied, so no reference among them
 * is left dangling), then one DO block deleting each table's rows. A READ COMMITTED transaction takes no part in SSI:
 * it holds no SIREAD lock, and a version it deleted is no serializable transaction's, so no later SERIALIZABLE
 * transaction that meets it counts a conflict with it (replaceRows), and its DELETE reads no version another
 * transaction wrote under SSI's eyes, the reason a SERIALIZABLE DELETE was refused here.
 */
const rowsDeletion = (
	tables: Arr.NonEmptyReadonlyArray<string>
): ReadonlyArray<ReplacedStatement> => [
	{ sql: "BEGIN ISOLATION LEVEL READ COMMITTED", params: [] },
	{ sql: "SET LOCAL session_replication_role = replica", params: [] },
	{
		sql: `DO $reset$\nBEGIN\n${Arr.join(
			Arr.map(tables, (t) => `\tDELETE FROM ${t};`),
			"\n"
		)}\nEND\n$reset$`,
		params: []
	},
	{ sql: "COMMIT", params: [] }
]

/** The statements before the replacing transaction that empty `group` as its Emptying says: a deletion's, or none. */
const deletion = (group: ResetGroup): ReadonlyArray<ReplacedStatement> =>
	group.emptying === "rows" && Arr.isReadonlyArrayNonEmpty(group.tables)
		? rowsDeletion(group.tables)
		: []

/** `group` emptied by its rows on `connection`'s one backend, as its Emptying says (rowsDeletion); a whole one untouched. */
const emptied = (
	connection: Pick<PgConnection, "query">,
	group: ResetGroup
): Effect.Effect<void, SqlError> =>
	Effect.forEach(
		deletion(group),
		(statement) => connection.query(statement.sql, statement.params),
		{
			discard: true
		}
	)

/** The one statement of the replacing transaction that empties `group` as its Emptying says: a whole one's TRUNCATE. */
const truncation = (group: ResetGroup): ReadonlyArray<ReplacedStatement> => {
	if (!Arr.isReadonlyArrayNonEmpty(group.tables)) {
		return []
	}
	switch (group.emptying) {
		case "whole":
			return [{ sql: `TRUNCATE ${Arr.join(group.tables, ", ")}`, params: [] }]
		case "rows":
			return []
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
 * So a case's rows are written whole, in one transaction that reads no version another serializable transaction wrote:
 * a whole group's TRUNCATE, then the inserts; or, for a group emptied by its rows, the inserts after the deletion that
 * emptied it (rowsDeletion), a READ COMMITTED transaction of its own, whose versions no serializable transaction counts
 * a conflict with. TRUNCATE reads no row, and the inserts' own checks (a foreign key's, a law's) read the rows the
 * transaction itself inserted, since no live row of the group outlives the reset, and a sequence's tuple is frozen: the
 * transaction has no rw-conflict out, so it is never a pivot and never fails with 40001. A truncated table holds no
 * dead version; a table emptied by its rows holds the deleted versions until a vacuum, which the case's reads and
 * writes meet as no serializable transaction's, so they change what a plan reads and never what a statement answers.
 *
 * The group is whole by construction (ResetGroup): every stored relation's table of an installation, migrated or
 * installed from its compiled script, or every table of a fixture a test creates by hand. A part of one is not
 * expressible: TRUNCATE refuses a table another references unless that one is truncated with it (0A000, "cannot
 * truncate a table referenced in a foreign key constraint"), and a table the reset left alone would keep rows an
 * earlier transaction wrote for the inserts' checks to read; a deletion of the rows empties every table of the group,
 * so no reference among them is left dangling.
 *
 * Replaces the rows of every table of `group` with what `statements` insert: the deletion that empties a group by its
 * rows, then one SERIALIZABLE transaction on one backend of `connection`, a whole group's TRUNCATE, then the
 * statements. A COMMIT that PostgreSQL answers with ROLLBACK fails with TransactionRolledBack.
 */
export const replaceRows = (
	connection: PgConnection,
	group: ResetGroup,
	statements: ReadonlyArray<ReplacedStatement>
): Effect.Effect<void, SqlError | TransactionRolledBack> =>
	Effect.scoped(
		Effect.gen(function* () {
			const pinned = yield* connection.pin
			yield* emptied(pinned, group)
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
 * `connection`'s one backend (a PgConnection, or a substrate proof's own RawSession), as its Emptying says, for
 * replaceRows' reasons: a whole group's one TRUNCATE, alone in its transaction, which reads no row, so it has no
 * rw-conflict for SSI to cancel it by, takes the group's every table, so no foreign key among them refuses it, and
 * leaves no version, live or dead, for the next case to meet; or a group's deletion of its rows (rowsDeletion).
 */
export const clearRows = (
	connection: Pick<PgConnection, "query">,
	group: ResetGroup
): Effect.Effect<void, SqlError> =>
	Effect.andThen(
		emptied(connection, group),
		Effect.forEach(
			truncation(group),
			(statement) => connection.query(statement.sql, statement.params),
			{
				discard: true
			}
		)
	)
