import { rowsEmptied } from "@bjornpagen/testing/resources"
import { Array as Arr, Brand, Effect } from "effect"
import { headsOf } from "#compiler/ir/instant.ts"
import { headFill } from "#compiler/physical/ddl/stamps.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { printStatement } from "#compiler/sql/print.ts"
import type { Names } from "#test/support/kernel/naming.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { TransactionRolledBack } from "#test/support/substrate/errors.ts"

/**
 * The tables one reset empties together (schema-qualified, quoted): a whole group, built only by installationGroup or
 * tablesGroup, and emptied only by deleting every row of all of it (replaceRows, clearRows); and the calls of the
 * stand-ups of the installation that holds them, which the reset's backend sends before its inserts, so an insert of a
 * table the rule judge holds is judged at its COMMIT (kernel/naming.ts Names standUps).
 */
export type ResetGroup = {
	readonly tables: ReadonlyArray<string>
	readonly standUps: ReadonlyArray<string>
} & Brand.Brand<"ResetGroup">
const ResetGroup = Brand.nominal<ResetGroup>()

/**
 * Every stored relation's table of an installation, by its names (kernel/naming.ts namesOf, or installationNamesOf
 * for one installed from its compiled script): its rows are the state a case writes whole. An installation of closed
 * relations alone stores nothing, and its group empties nothing.
 */
export const installationGroup = (names: Names): ResetGroup =>
	ResetGroup({ tables: names.storedTables, standUps: names.standUps })

/**
 * Every table of `tables`, which a test creates by hand rather than installs, or an installation's stored tables
 * (kernel/naming.ts Names storedTables): the write oracle's every group of a generated schema; and `standUps`, the calls
 * of the stand-ups of the installation that holds them (kernel/naming.ts Names standUps), none for tables made by hand.
 */
export const tablesGroup = (
	tables: ReadonlyArray<string>,
	standUps: ReadonlyArray<string>
): ResetGroup => ResetGroup({ tables, standUps })

/**
 * The fill of every head of `installation` from its relation as it stands (physical/ddl/stamps.ts headFill), each a
 * statement: what a seed that writes a stamped relation's rows as the owner runs after them, as a migration fills a
 * head it creates beside stored rows, so every stamp after it is above every row the seed wrote.
 */
export const headFills = (installation: Installation): ReadonlyArray<string> =>
	Arr.map(headsOf(installation.laws.theory.instants), (head) =>
		printStatement(headFill(installation.names, head))
	)

/**
 * `group` emptied on `connection`'s one backend by the testing library's one reset (resources rowsEmptied), never a
 * TRUNCATE: a READ COMMITTED transaction of its own under the replica role deleting every row of the group's tables,
 * so no trigger fires, neither a law's nor a foreign key's (each table of the group is emptied, so no reference among
 * them is left dangling), and no SERIALIZABLE transaction after it counts a conflict with what it deleted (replaceRows);
 * nothing for a group of no table. A case that commits nothing takes a rollback instead (Substrate.rolledBack,
 * Substrate.rolledBack).
 */
const emptied = (
	connection: Pick<PgConnection, "query">,
	group: ResetGroup
): Effect.Effect<void, SqlError> =>
	Effect.forEach(rowsEmptied(group.tables), (sql) => connection.query(sql, []), { discard: true })

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
 * the inserts, after the deletion that emptied the group (emptied), a READ COMMITTED transaction of its own,
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
 * over a clone of its own, whose tables hold what its template's do, is `inserted` alone.
 */
export const replaceRows = (
	connection: PgConnection,
	group: ResetGroup,
	statements: ReadonlyArray<ReplacedStatement>
): Effect.Effect<void, SqlError | TransactionRolledBack> =>
	Effect.scoped(
		Effect.flatMap(connection.pin, (pinned) =>
			Effect.andThen(
				emptied(pinned, group),
				Effect.andThen(
					Effect.forEach(group.standUps, (sql) => pinned.query(sql, []), { discard: true }),
					insertedOn(pinned, statements)
				)
			)
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
 * (emptied), for replaceRows' reasons.
 */
export const clearRows = (
	connection: Pick<PgConnection, "query">,
	group: ResetGroup
): Effect.Effect<void, SqlError> => emptied(connection, group)
