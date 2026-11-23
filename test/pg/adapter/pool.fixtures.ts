/** What the properties of pool.test.ts read: its spaces, models and helpers. */

import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { quoteIdent } from "#compiler/core/text.ts"

/**
 * How the wait for an idle session's close ends while its backend's exit is held: the hold is let go and the server
 * closes, or the release is interrupted first.
 */
type WaitEnd = "closed" | "interrupted"

/** Both ends of the wait. */
export const waitEnds: Gen<WaitEnd> = (source) =>
	source.draw(element<WaitEnd>(["closed", "interrupted"]))

export type WaitFeature = `released idle, ${WaitEnd}`

/**
 * The statement that holds an exiting backend in its drop of its temporary relations, run in an open transaction of the
 * bootstrap superuser's: COMMENT ON SCHEMA takes ShareUpdateExclusiveLock on the schema `schema` until that transaction
 * ends (REL_19_0 src/backend/commands/comment.c 81, src/backend/catalog/objectaddress.c 1188 LockDatabaseObject), and
 * the backend's drop of its temporary schema's contents at its exit asks AccessExclusiveLock on the schema first
 * (src/backend/catalog/namespace.c 4698 RemoveTempRelations, dependency.c 290 performDeletion's AcquireDeletionLock),
 * so the backend waits there, its connection open, until the transaction ends.
 */
export const holdSchemaSql = (schema: string): string =>
	`COMMENT ON SCHEMA ${quoteIdent(schema)} IS NULL`

/** The temporary schema of the session that reads it, which its first temporary table made. */
export const temporarySchemaSql = "SELECT pg_catalog.pg_my_temp_schema()::regnamespace::text"

/** One temporary table of the session's own, so its exit has a temporary schema to drop. */
export const oneTemporaryTableSql = "CREATE TEMPORARY TABLE pg_temp.held (k text NOT NULL)"

/**
 * The temporary tables one session of pantry's export suite held when its pool ended, each of two text columns, so each
 * has its TOAST table and index as a judge's delta does (edullm P5, 2026-11-21: 70 deltas of news, 78 of olds, a
 * sentinel and a carrier, 642 objects that its backend took 1.8 s to drop at its exit).
 *
 * @limitKind empirical
 * @owner edullm's pantry export suite on grizzle d81ee19dc
 * @unit temporary tables of one session
 * @scope each session of a case of the release's exit property
 * @constraint the workload measured
 * @source /Users/bjorn/Documents/edullm/out/grading-sql/p5/move/logs/light-run-temp-relations.txt
 * @verified 2026-11-21
 */
const exportSessionTables = 150

/**
 * One case of the release's exit property: how many sessions the pool holds idle when its layer is released, each
 * leased at once so each is its own, and how many temporary tables each made first.
 */
interface ExitCase {
	readonly sessions: number
	readonly tables: number
}

/** Every case: one to three idle sessions, holding no temporary table or as many as an export session did. */
export const exits: Gen<ExitCase> = (source) => ({
	sessions: source.draw(int(1, 3)),
	tables: source.draw(element([0, exportSessionTables]))
})

export type ExitFeature =
	| "one session"
	| "several sessions"
	| "no temporary table"
	| "temporary tables"

/** The DO block that makes `tables` temporary tables of two text columns in its session: pg_temp.t1, t2, and so on. */
export const temporaryTablesSql = (tables: number): string =>
	`DO $$BEGIN FOR i IN 1..${String(tables)} LOOP EXECUTE pg_catalog.format('CREATE TEMPORARY TABLE pg_temp.%I (k text NOT NULL, v text NOT NULL)', 't' || i); END LOOP; END$$`
