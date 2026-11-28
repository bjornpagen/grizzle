import { Array as Arr, Brand, Effect, Option } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { guardBracketTexts } from "#compiler/physical/ddl/immutable.ts"
import { headFill, headSources } from "#compiler/physical/ddl/stamps.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { ObjectName } from "#compiler/sql/ast.ts"
import { printStatement } from "#compiler/sql/print.ts"
import type { Names } from "#test/support/kernel/naming.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { TransactionRolledBack } from "#test/support/substrate/errors.ts"

/**
 * The tables one reset empties together (schema-qualified, quoted): a whole group, built only by installationGroup or
 * tablesGroup, and emptied only all of it at once, by the one reset (madeFresh: replaceRows, clearRows); an insert of a
 * table the rule judge holds is judged at its COMMIT.
 */
export type ResetGroup = {
	readonly tables: ReadonlyArray<string>
} & Brand.Brand<"ResetGroup">
const ResetGroup = Brand.nominal<ResetGroup>()

/**
 * Every stored relation's table of an installation, by its names (kernel/naming.ts namesOf, or installationNamesOf
 * for one installed from its compiled script): its rows are the state a case writes whole. An installation of closed
 * relations alone stores nothing, and its group empties nothing.
 */
export const installationGroup = (names: Names): ResetGroup =>
	ResetGroup({ tables: names.storedTables })

/**
 * Every table of `tables`, which a test creates by hand rather than installs, or an installation's stored tables
 * (kernel/naming.ts Names storedTables): the write oracle's every group of a generated schema.
 */
export const tablesGroup = (tables: ReadonlyArray<string>): ResetGroup => ResetGroup({ tables })

/**
 * The fill of every place's head of `installation` from its relation as it stands (physical/ddl/stamps.ts headFill),
 * each a statement: what a seed that writes a place's rows as the owner runs after them, as a migration fills a head it
 * creates beside stored rows, so every place after it is past every row the seed wrote. A clock's head needs none: the
 * seed stamps each clock it writes, as every writer of a clock's rows does (physical/ddl/clocked.ts), and its stamps
 * leave the head above every row it wrote.
 */
export const headFills = (installation: Installation): ReadonlyArray<string> => {
	const instants = installation.laws.theory.instants
	return Arr.flatMap([...instants.places.values()], (place) => {
		const sources = headSources(instants, place)
		return Arr.isReadonlyArrayNonEmpty(sources)
			? [printStatement(headFill(installation.names, place, sources))]
			: []
	})
}

/**
 * The tables one reset empties, by schema and name in oid order: the tables `seeds` selects, a query of one oid column,
 * and beside each every table a foreign key of which references it, directly or through such tables, which one
 * TRUNCATE must empty with it, so the list is every table the TRUNCATE empties (madeFresh): the one query of a reset's
 * tables, a group's (emptied) and a seat's fresh tables' (substrate.ts).
 */
export const emptiedQuery = (seeds: string): string => `WITH RECURSIVE emptied(oid) AS (
	${seeds}
	UNION SELECT k.conrelid FROM pg_catalog.pg_constraint AS k JOIN emptied AS e ON k.confrelid = e.oid WHERE k.contype = 'f'
)
SELECT n.nspname::text AS schema, c.relname::text AS name FROM emptied AS e JOIN pg_catalog.pg_class AS c ON c.oid = e.oid
	JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace ORDER BY c.oid`

/** The tables an answer of emptiedQuery names, its rows positional, none when it names none. */
export const emptiedTables = (
	rows: ReadonlyArray<ReadonlyArray<unknown>>
): Option.Option<Arr.NonEmptyReadonlyArray<ObjectName>> =>
	Arr.match(
		Arr.flatMap(rows, ([schema, name]) =>
			typeof schema === "string" && typeof name === "string" ? [{ schema, name }] : []
		),
		{ onEmpty: Option.none, onNonEmpty: Option.some }
	)

/**
 * The statements of one reset of `tables` (madeFresh), in order: BEGIN at SERIALIZABLE, the bracket's `before`, the
 * TRUNCATE of every table, the bracket's `after`, COMMIT. None takes a parameter, so a connection sends them in one
 * write, behind whatever else it sends there.
 */
const freshStatements = (
	tables: Arr.NonEmptyReadonlyArray<ObjectName>
): Arr.NonEmptyReadonlyArray<string> => {
	const bracket = guardBracketTexts({ kind: "tables", tables })
	return [
		"BEGIN ISOLATION LEVEL SERIALIZABLE",
		bracket.before,
		`TRUNCATE ${Arr.join(
			Arr.map(tables, (t) => `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`),
			", "
		)}`,
		bracket.after,
		"COMMIT"
	]
}

/**
 * On `connection`'s one backend, `tables` (emptiedTables) given relations of their own, each table, its indexes and its
 * TOAST a new file, empty, its sizes in pg_class those of a table never vacuumed (TRUNCATE), committed: one
 * SERIALIZABLE transaction, as every grizzle table's isolation guard requires of a TRUNCATE as of any write
 * (physical/ddl/isolation.ts), its TRUNCATE inside the bracket that lifts the guards of the closed relations' tables
 * among them and creates each again (physical/ddl/immutable.ts guardBracketTexts), the one removal path of a closed
 * relation's rows, whose TRUNCATE guard refuses a TRUNCATE outside it. The one reset of a test's tables: a group's
 * (emptied) and a seat's (substrate.ts). The TRUNCATE fires no row trigger, neither a law's nor a foreign key's, and the
 * list holds every table that references one of it, so no reference is left dangling. It reads nothing a serializable
 * transaction wrote, so it never fails as a pivot with 40001 (replaceRows). One write (freshStatements), one round
 * trip: a statement PostgreSQL refuses fails it, and the COMMIT the same write carries ends the transaction it aborted.
 */
export const madeFresh = (
	connection: Pick<PgConnection, "pipeline">,
	tables: Arr.NonEmptyReadonlyArray<ObjectName>
): Effect.Effect<void, SqlError> =>
	Effect.asVoid(
		Effect.mapError(connection.pipeline(freshStatements(tables)), (refused) => refused.error)
	)

/**
 * `group` emptied on `connection`'s one backend by the one reset (madeFresh) of the tables emptiedQuery reads of it:
 * each of the group's tables, and every table that references one; nothing for a group of no table. A case that
 * commits nothing takes a rollback instead (Substrate.rolledBack).
 */
const emptied = (
	connection: Pick<PgConnection, "query" | "pipeline">,
	group: ResetGroup
): Effect.Effect<void, SqlError> =>
	Arr.match(group.tables, {
		onEmpty: () => Effect.void,
		onNonEmpty: (tables) =>
			Effect.flatMap(
				connection.query(
					emptiedQuery(
						"SELECT t::pg_catalog.oid FROM pg_catalog.unnest($1::pg_catalog.text[]::pg_catalog.regclass[]) AS t"
					),
					[tables]
				),
				(answer) =>
					Option.match(emptiedTables(Arr.map(answer.rows, (row) => [row["schema"], row["name"]])), {
						onNone: () => Effect.void,
						onSome: (emptiedOf) => madeFresh(connection, emptiedOf)
					})
			)
	})

/**
 * One statement of a reset's replacing transaction after its emptying, an insert or a sequence's
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
 * checks no concurrency). A SERIALIZABLE reset DELETE would then read a dead row an earlier case left, written by a
 * summarized transaction, which gives it a conflict out, and delete rows an earlier read locked, which gives it a
 * conflict in: it fails with 40001, "Canceled on identification as a pivot, during write", though nothing ran beside
 * it. Run alone the suites pass; under a full parallel run, or two copies of one file, they fail.
 *
 * So a case's rows are written whole, in one transaction that reads no version another serializable transaction wrote:
 * the inserts, after the TRUNCATE that emptied the group (emptied, madeFresh), which reads no row and leaves none, dead
 * or live, for a later transaction to read. The inserts' own checks (a foreign key's, a law's) read the rows the
 * transaction itself inserted, since no row of the group outlives the TRUNCATE, and a sequence's tuple is frozen: the
 * transaction has no rw-conflict out, so it is never a pivot and never fails with 40001.
 *
 * The group is whole by construction (ResetGroup): every stored relation's table of an installation, migrated or
 * installed from its compiled script, or every table of a fixture a test creates by hand. A part of one is not
 * expressible: a table the reset left alone would keep rows an earlier transaction wrote for the inserts' checks to
 * read, and a reference into the emptied tables would dangle.
 *
 * Replaces the rows of every table of `group` with what `statements` insert: the reset that empties the group, then
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
			Effect.andThen(emptied(pinned, group), insertedOn(pinned, statements))
		)
	)

/**
 * `statements` in one SERIALIZABLE transaction on one backend of `connection`, for replaceRows' reasons: the rows a
 * case starts from, written over tables its form or a reset emptied, which hold no version a serializable
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
 * `connection`'s one backend (a PgConnection, or a substrate proof's own RawSession): the one reset of its tables
 * (emptied), for replaceRows' reasons.
 */
export const clearRows = (
	connection: Pick<PgConnection, "query" | "pipeline">,
	group: ResetGroup
): Effect.Effect<void, SqlError> => emptied(connection, group)
