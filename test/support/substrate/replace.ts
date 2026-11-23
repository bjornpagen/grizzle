import { Array as Arr, Brand, Effect } from "effect"
import type { Names } from "#test/support/kernel/naming.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { TransactionRolledBack } from "#test/support/substrate/errors.ts"

/**
 * The tables one reset empties together (schema-qualified, quoted): a whole group, built only by installationGroup or
 * tablesGroup, and emptied only by deleting every row of all of it (replaceRows, clearRows).
 */
export type ResetGroup = {
	readonly tables: ReadonlyArray<string>
	/**
	 * The materialized views over the tables (schema-qualified, quoted), lowest level first, each of which a seat's
	 * reset puts back as its case found it once the tables are empty (foundViews, viewsRestored): what a REFRESH writes
	 * there outlives every deletion of the rows it read.
	 */
	readonly views: ReadonlyArray<string>
} & Brand.Brand<"ResetGroup">
const ResetGroup = Brand.nominal<ResetGroup>()

/**
 * Every stored relation's table of an installation, by its names (kernel/naming.ts namesOf, or installationNamesOf
 * for one installed from its compiled script), and every materialized view of its derived relations: its rows are the
 * state a case writes whole, and what a refresh computes from them. An installation of closed relations alone stores
 * nothing, and its group empties nothing.
 */
export const installationGroup = (names: Names): ResetGroup =>
	ResetGroup({ tables: names.storedTables, views: names.materializedViews })

/**
 * Every table of `tables`, which a test creates by hand rather than installs, or an installation's stored tables
 * without its views (kernel/naming.ts Names storedTables): the write oracle's every group of a generated schema.
 */
export const tablesGroup = (tables: ReadonlyArray<string>): ResetGroup =>
	ResetGroup({ tables, views: [] })

/** No table: the group of a template whose cases write no table of its own (substrate.ts base). */
export const noTables: ResetGroup = tablesGroup([])

/**
 * The deletion of every row of `group`'s tables, a reset's one way, never a TRUNCATE: its own READ COMMITTED
 * transaction, under the replica role, so no trigger fires, neither a law's nor a foreign key's (each table of the
 * group is emptied, so no reference among them is left dangling), then one DO block deleting each table's rows; none
 * for a group of no table. A TRUNCATE gives each table and each of its indexes a new relation file, and its commit
 * drops the old files' pages by a scan of every shared buffer: 16 clients on one server reset 117 cases a second by
 * TRUNCATE, 2,662 by this deletion and 18,517 by a rollback (the factory, 2026-11-23, over the pg tier at f87b2aaab),
 * and a case that commits nothing takes a rollback (Substrate.rolledBack, Substrate.transaction). A READ COMMITTED
 * transaction takes no part in SSI: it holds no SIREAD lock, and a version it deleted is no serializable transaction's,
 * so no later SERIALIZABLE transaction that meets it counts a conflict with it (replaceRows), and its DELETE reads no
 * version another transaction wrote under SSI's eyes, the reason a SERIALIZABLE DELETE was refused here. The deleted
 * versions stay until a vacuum: the cases after meet them as no serializable transaction's, which changes what a plan
 * reads and never what a statement answers.
 */
const rowsDeletion = (group: ResetGroup): ReadonlyArray<ReplacedStatement> =>
	Arr.match(group.tables, {
		onEmpty: () => [],
		onNonEmpty: (tables) => [
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
	})

/** `group` emptied (rowsDeletion) on `connection`'s one backend. */
const emptied = (
	connection: Pick<PgConnection, "query">,
	group: ResetGroup
): Effect.Effect<void, SqlError> =>
	Effect.forEach(
		rowsDeletion(group),
		(statement) => connection.query(statement.sql, statement.params),
		{
			discard: true
		}
	)

/**
 * One statement of a reset: the deletion's, or one of the replacing transaction's after it, an insert or a sequence's
 * setting (one set where the case's identities start, or advanced past what the inserts stored): its text and its
 * parameters, as the connection sends them.
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
 * checks no concurrency). A SERIALIZABLE reset DELETE then reads a dead row an earlier case left, written by a
 * summarized transaction, which gives it a conflict out, and deletes rows an earlier read locked, which gives it a
 * conflict in: it fails with 40001, "Canceled on identification as a pivot, during write", though nothing ran beside
 * it. Run alone the suites pass; under a full parallel run, or two copies of one file, they fail.
 *
 * So a case's rows are written whole, in one transaction that reads no version another serializable transaction wrote:
 * the inserts, after the deletion that emptied the group (rowsDeletion), a READ COMMITTED transaction of its own,
 * whose versions no serializable transaction counts a conflict with. The inserts' own checks (a foreign key's, a law's)
 * read the rows the transaction itself inserted, since no live row of the group outlives the deletion, and the
 * versions it deleted, which are no serializable transaction's, and a sequence's tuple is frozen: the transaction has
 * no rw-conflict out, so it is never a pivot and never fails with 40001.
 *
 * The group is whole by construction (ResetGroup): every stored relation's table of an installation, migrated or
 * installed from its compiled script, or every table of a fixture a test creates by hand. A part of one is not
 * expressible: a table the reset left alone would keep rows an earlier transaction wrote for the inserts' checks to
 * read, and a reference into the emptied tables would dangle.
 *
 * Replaces the rows of every table of `group` with what `statements` insert: the deletion that empties the group, then
 * the statements' transaction (inserted), on one backend of `connection`. A reload inside a case; a case's first load
 * over a seat or a fresh clone, whose tables its form already emptied, is `inserted` alone.
 */
export const replaceRows = (
	connection: PgConnection,
	group: ResetGroup,
	statements: ReadonlyArray<ReplacedStatement>
): Effect.Effect<void, SqlError | TransactionRolledBack> =>
	Effect.scoped(
		Effect.flatMap(connection.pin, (pinned) =>
			Effect.andThen(emptied(pinned, group), insertedOn(pinned, statements))
		)
	)

/**
 * `statements` in one SERIALIZABLE transaction on one backend of `connection`, for replaceRows' reasons: the rows a
 * case starts from, written over tables its form or a deletion emptied, which hold no version a serializable
 * transaction wrote.
 */
export const inserted = (
	connection: PgConnection,
	statements: ReadonlyArray<ReplacedStatement>
): Effect.Effect<void, SqlError | TransactionRolledBack> =>
	Effect.scoped(Effect.flatMap(connection.pin, (pinned) => insertedOn(pinned, statements)))

/**
 * `statements` between BEGIN ISOLATION LEVEL SERIALIZABLE and COMMIT on `pinned`, rolled back when one fails. A COMMIT
 * that PostgreSQL answers with ROLLBACK fails with TransactionRolledBack.
 */
const insertedOn = (
	pinned: PgConnection,
	statements: ReadonlyArray<ReplacedStatement>
): Effect.Effect<void, SqlError | TransactionRolledBack> =>
	Effect.gen(function* () {
		yield* pinned.query("BEGIN ISOLATION LEVEL SERIALIZABLE", [])
		yield* Effect.onError(
			Effect.forEach(statements, (statement) => pinned.query(statement.sql, statement.params), {
				discard: true
			}),
			() => Effect.ignore(pinned.query("ROLLBACK", []))
		)
		const committed = yield* pinned.query("COMMIT", [])
		if (committed.command !== "COMMIT") {
			return yield* new TransactionRolledBack({ label: "replace", command: committed.command })
		}
	})

/**
 * Empties every table of `group` between the cases of a suite that clears its state rather than replacing it, on
 * `connection`'s one backend (a PgConnection, or a substrate proof's own RawSession): the deletion of its rows
 * (rowsDeletion), for replaceRows' reasons.
 */
export const clearRows = (
	connection: Pick<PgConnection, "query">,
	group: ResetGroup
): Effect.Effect<void, SqlError> => emptied(connection, group)

/** A materialized view of a reset group as a case found it: whether PostgreSQL holds it populated (relispopulated). */
export interface FoundView {
	readonly view: string
	readonly populated: boolean
}

/**
 * Each view of `group` as it stands now, read as a seat's case takes its clone, which the seat holds as its template
 * (Substrate.seat): populated, as the migration that creates a materialized view populates it (deploy/diff/diff.ts), or
 * not, as an installation from its compiled script leaves it WITH NO DATA. One catalog read, none for a group of no view.
 */
export const foundViews = (
	connection: Pick<PgConnection, "queryValues">,
	group: ResetGroup
): Effect.Effect<ReadonlyArray<FoundView>, SqlError> =>
	Arr.isReadonlyArrayNonEmpty(group.views)
		? Effect.map(
				connection.queryValues(
					"SELECT v.view, c.relispopulated FROM pg_catalog.unnest($1::text[]) WITH ORDINALITY AS v(view, n) JOIN pg_catalog.pg_class AS c ON c.oid = v.view::regclass ORDER BY v.n",
					[group.views]
				),
				(rows) =>
					Arr.map(rows, ([view, populated]) => ({
						view: String(view),
						populated: populated === true
					}))
			)
		: Effect.succeed([])

/**
 * The views a case found (foundViews) put back as it found them, lowest level first, over tables a reset has emptied:
 * a populated one refreshed, so it holds what its definition reads there, the rows its installation populated it with
 * over the same empty tables; one found unpopulated refreshed WITH NO DATA. Each is the view's owner's to refresh, the
 * reset's own role.
 */
export const viewsRestored = (
	connection: Pick<PgConnection, "query">,
	found: ReadonlyArray<FoundView>
): Effect.Effect<void, SqlError> =>
	Effect.forEach(
		found,
		(v) =>
			connection.query(
				`REFRESH MATERIALIZED VIEW ${v.view}${v.populated ? "" : " WITH NO DATA"}`,
				[]
			),
		{ discard: true }
	)
