/** What the properties of pool.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Scope } from "effect"
import { type BatchStatement, oneShotStatement, runTransaction } from "#adapter/wire/batch.ts"
import type { Session } from "#adapter/wire/session.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { runAlone } from "#test/support/pg.ts"
import { pickGen } from "#test/support/pick.ts"
import { testSql } from "#test/support/sql.ts"
import { paramText } from "#test/support/wire.ts"

/** One step as drawn: what it does, and which leased session it picks. */
interface StepSketch {
	readonly kind: "lease" | "release" | "retire" | "lose"
	readonly pick: number
}

interface Sequence {
	readonly max: number
	readonly steps: ReadonlyArray<StepSketch>
}

export const sequenceGen: Gen<Sequence> = (source) => ({
	max: source.draw(int(1, 3)),
	steps: source.draw(
		array<StepSketch>(
			(step) => ({
				kind: step.draw(element(["lease", "release", "retire", "lose"] as const)),
				pick: step.draw(pickGen)
			}),
			{ min: 1, max: 16 }
		)
	)
})

export type PoolFeature =
	| "retired"
	| "connection lost"
	| "released"
	| "leased after a retirement"
	| "leased an idle session"
	| "leased a new session"

export const situations: Arr.NonEmptyReadonlyArray<PoolFeature> = [
	"retired",
	"connection lost",
	"released",
	"leased after a retirement",
	"leased an idle session",
	"leased a new session"
]

/** A leased session in the model: the session, its backend and the scope its lease lives in. */
export interface Held {
	readonly session: Session
	readonly pid: number
	readonly scope: Scope.Closeable
}

/** What an interrupted statement waits on: the server's clock, or an advisory lock another session holds. */
type LongStatement = "sleep" | "lock"

/** How the statement runs: alone, its own implicit transaction, or inside a transaction that ends with COMMIT. */
type FlightForm = "alone" | "transaction"

interface Interrupted {
	readonly max: number
	readonly statement: LongStatement
	readonly form: FlightForm
}

export const interruptedCases: Gen<Interrupted> = (source) => ({
	max: source.draw(int(1, 3)),
	statement: source.draw(element<LongStatement>(["sleep", "lock"])),
	form: source.draw(element<FlightForm>(["alone", "transaction"]))
})

export type InterruptedFeature = `${LongStatement} ${FlightForm}`

/**
 * The advisory lock key the lock cases hold, in a session of their own that the case's scope ends, which no other
 * test takes.
 */
export const lockKey = "7366231908012114001"

/** The long statement of a case, which runs until a CancelRequest stops it. */
export const longStatement = (statement: LongStatement): BatchStatement =>
	statement === "sleep"
		? oneShotStatement(testSql("SELECT pg_catalog.pg_sleep(600)::text"), [])
		: oneShotStatement(testSql("SELECT pg_catalog.pg_advisory_lock($1::int8)::text"), [
				paramText(lockKey)
			])

/** Runs `statement` on `session` in the form drawn: alone, or in a read-only transaction that ends with COMMIT. */
export const runIn = (session: Session, form: FlightForm, statement: BatchStatement) =>
	form === "alone"
		? Effect.asVoid(runAlone(session, statement))
		: Effect.asVoid(
				runTransaction(session, [statement], {
					access: "readOnly",
					deferrable: false,
					end: "COMMIT"
				})
			)

/**
 * Where the tap's session stands when its layer is released: idle in the pool, leased, or running a statement of `rows`
 * rows whose answer the gate cuts after `through` backend messages.
 */
type Standing =
	| { readonly kind: "idle" }
	| { readonly kind: "leased" }
	| { readonly kind: "running"; readonly rows: number; readonly through: number }

/** Every standing, a statement's answer cut at each of its first messages: a few rows, and a cut short of their end. */
export const standings: Gen<Standing> = (source) => {
	const kind = source.draw(element<Standing["kind"]>(["idle", "leased", "running"]))
	if (kind !== "running") {
		return { kind }
	}
	const rows = source.draw(int(0, 3))
	return { kind, rows, through: source.draw(int(0, rows + 4)) }
}

export type StalledFeature =
	| "released idle"
	| "released leased"
	| "released before any answer"
	| "released mid-answer"

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

/** The running statement: `rows` rows, one round trip of the extended protocol. */
export const seriesSql = "SELECT pg_catalog.generate_series(1, $1::int4)::text"

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
