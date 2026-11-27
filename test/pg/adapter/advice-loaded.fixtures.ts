import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Predicate, Result } from "effect"
import { applyOnSession } from "#adapter/migrate/apply.ts"
import {
	excludesNothing,
	type Frame,
	oneShotStatement,
	readFrame,
	runFramed,
	writeFrame
} from "#adapter/wire/batch.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { kept, openMigrator, parsedTarget, reviewedSource } from "#test/pg/migrate/support.ts"
import { firstCodes } from "#test/support/compile.ts"
import { fenceSql, prologueIn } from "#test/support/flight/model.ts"
import { atName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { draftChain, fromEmpty, noDeclarations } from "#test/support/migrate/kit.ts"
import { testSql } from "#test/support/sql.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"
import { tappedSession } from "#test/support/wire-tap.ts"
import { shopV1 } from "#test/unit/deploy/schemas.ts"

/**
 * What a case runs on a session of its database: `grizzle migrate`'s first apply of a schema, which installs it; or a
 * Db's read or write, one framed flight behind the prologue that calls the snapshot guard.
 */
export const paths = ["migrate", "read", "write"] as const
export type AdvicePath = (typeof paths)[number]

/**
 * How the case's database leaves the libraries of the sessions it opens after: as the test cluster loads them, with
 * pg_plan_advice (`loaded`); with none, the database's session_preload_libraries PostgreSQL's empty list (`unloaded`),
 * a host that never configured it; with none and pg_plan_advice.feedback_warnings set for the database (`spoofed`), a
 * placeholder a setting-reading check would take for the library; or with none for the database but the migration
 * role's own session_preload_libraries in it naming the library (`ownSetting`), so its sessions load it where no
 * login's would.
 */
export const sessionStates = ["loaded", "unloaded", "spoofed", "ownSetting"] as const
export type SessionState = (typeof sessionStates)[number]

/** A case: what runs, and on what sessions. */
export interface AdviceCase {
	readonly path: AdvicePath
	readonly session: SessionState
}

/** Every path over every state, one case each. */
export const adviceCases: Gen<AdviceCase> = (source) => ({
	path: source.draw(element(paths)),
	session: source.draw(element(sessionStates))
})

/**
 * What a case ends in: what it ran, ran whole; or refused before anything ran, by the guard's or the survey's
 * AdviceUnloaded or the survey's MigratorPreloads. A run reads any other refusal by its tag, which no case expects.
 */
export type AdviceOutcome = "ran" | "AdviceUnloaded" | "MigratorPreloads"

/**
 * The specification: a session that did not load pg_plan_advice runs nothing, whatever its settings say; a session
 * that loaded it runs, but for the migration identity's own setting, which leaves the logins' sessions unknown, so
 * `grizzle migrate` refuses it while a flight, which reads its own session alone, runs.
 */
export const expectedOf = (x: AdviceCase): AdviceOutcome => {
	switch (x.session) {
		case "loaded":
			return "ran"
		case "unloaded":
		case "spoofed":
			return "AdviceUnloaded"
		case "ownSetting":
			return x.path === "migrate" ? "MigratorPreloads" : "ran"
	}
}

/**
 * The owner's statements that leave the case's database `database` in `state` for the sessions opened after them, the
 * migration identity `owner` (pg.config.ts grants it session_preload_libraries).
 */
const stateSql = (state: SessionState, database: string, owner: string): ReadonlyArray<string> => {
	const db = quoteIdent(database)
	const unloaded = `ALTER DATABASE ${db} SET session_preload_libraries = NULL`
	switch (state) {
		case "loaded":
			return []
		case "unloaded":
			return [unloaded]
		case "spoofed":
			return [unloaded, `ALTER DATABASE ${db} SET pg_plan_advice.feedback_warnings = 'off'`]
		case "ownSetting":
			return [
				unloaded,
				`ALTER ROLE ${quoteIdent(owner)} IN DATABASE ${db} SET session_preload_libraries = 'pg_plan_advice'`
			]
	}
}

/** The text cells of an owner read's rows, in order: a count as `count(*)::text` answers it. */
const texts = (rows: ReadonlyArray<ReadonlyArray<unknown>>): ReadonlyArray<string> =>
	Arr.flatMap(rows, (row) => Arr.filter(row, Predicate.isString))

/** What a case's run read back: its outcome, and what it left (leftOf). */
export interface Ran {
	readonly outcome: string
	readonly left: ReadonlyArray<string>
}

/**
 * The case's run on its substrate: the database left in its state, then a session opened after it runs the path, its
 * outcome read back with what it left: a migration that refused left no schema; a flight that refused left the table
 * it writes empty.
 */
export const runCase = (x: AdviceCase) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const owner = s.owner.role
		const leave = Effect.forEach(stateSql(x.session, s.database, owner), (sql) =>
			s.admin.query(sql, [])
		)
		switch (x.path) {
			case "migrate": {
				const allocated = yield* s.schema({ create: false, label: "advice" })
				const schema = identifierOf(identity.schema(parsedSchemaName(allocated)))
				const [folder] = draftChain(
					[
						{
							desc: shopV1,
							options: { schema: atName(allocated), extensions: [], codes: firstCodes },
							declared: noDeclarations
						}
					],
					fromEmpty
				)
				const drafted = defined(folder, "the drafted folder")
				yield* leave
				const m = yield* openMigrator(s, s.owner)
				const applied = yield* Effect.result(
					applyOnSession(m, [
						parsedTarget({ snapshot: drafted.snapshot, folders: [reviewedSource(drafted, kept)] })
					])
				)
				const schemas = yield* s.admin.queryValues(
					"SELECT count(*)::text FROM pg_catalog.pg_namespace WHERE nspname = $1",
					[schema]
				)
				const ran: Ran = {
					outcome: Result.isSuccess(applied) ? "ran" : applied.failure.reason._tag,
					left: texts(schemas)
				}
				return ran
			}
			case "read":
			case "write": {
				const raw = yield* s.schema(freshSchema)
				const table = `${quoteIdent(raw)}."p"`
				for (const { sql, params } of fenceSql(raw, owner)) {
					yield* s.admin.query(sql, params)
				}
				yield* s.admin.query(`CREATE TABLE ${table} ("k" int4 PRIMARY KEY)`, [])
				yield* leave
				const tapped = yield* tappedSession({
					cluster: s.cluster,
					database: s.database,
					role: owner,
					password: s.owner.password
				})
				const prologue = prologueIn(raw)
				const frame: Frame =
					x.path === "read"
						? readFrame(prologue)
						: writeFrame(prologue, "serializable", excludesNothing)
				const statement = oneShotStatement(
					testSql(
						x.path === "read"
							? `SELECT count(*)::text FROM ${table}`
							: `INSERT INTO ${table} ("k") VALUES (1)`
					),
					[]
				)
				const ran = yield* Effect.result(runFramed(tapped.session, frame, [statement]))
				const rows = yield* s.admin.queryValues(`SELECT count(*)::text FROM ${table}`, [])
				const read: Ran = {
					outcome: Result.isSuccess(ran) ? "ran" : ran.failure._tag,
					left: texts(rows)
				}
				return read
			}
		}
	})

/**
 * What a case leaves where it ran, by its path: a migration, its schema; a read, the table empty as it found it; a
 * write, its one row. A refusal leaves no schema and no row.
 */
export const leftOf = (x: AdviceCase): ReadonlyArray<string> =>
	expectedOf(x) === "ran" && x.path !== "read" ? ["1"] : ["0"]
