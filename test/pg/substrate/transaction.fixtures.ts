import { finite, int } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { quoteIdent } from "#compiler/sql/print.ts"
import { assert } from "#test/support/assert.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The name every planted object takes. */
const probe = "transaction_probe"

/**
 * What a case may do in its transaction that would outlive it on a committing session, and whether a connection holds
 * it after: a table, a temporary table, a database default and a session setting (each undone by the ROLLBACK), an
 * advisory lock and a prepared statement (each held by the session past a ROLLBACK, undone by DISCARD ALL).
 */
const outlived = {
	"a table": {
		plant: () => `CREATE TABLE public.${probe} (x integer)`,
		read: `SELECT 1 WHERE pg_catalog.to_regclass('public.${probe}') IS NOT NULL`
	},
	"a temporary table": {
		plant: () => `CREATE TEMPORARY TABLE ${probe} (x integer)`,
		read: `SELECT 1 WHERE pg_catalog.to_regclass('pg_temp.${probe}') IS NOT NULL`
	},
	"a database default": {
		plant: (database: string) => `ALTER DATABASE ${quoteIdent(database)} SET work_mem TO '7MB'`,
		read: "SELECT 1 FROM pg_catalog.pg_db_role_setting AS s JOIN pg_catalog.pg_database AS d ON d.oid = s.setdatabase WHERE d.datname = pg_catalog.current_database() AND 'work_mem=7MB' = ANY (s.setconfig)"
	},
	"a session setting": {
		plant: () => "SET work_mem TO '7MB'",
		read: "SELECT 1 WHERE pg_catalog.current_setting('work_mem') = '7MB'"
	},
	"an advisory lock": {
		plant: () => "SELECT pg_catalog.pg_advisory_lock(4242)",
		read: "SELECT 1 FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND pid = pg_catalog.pg_backend_pid()"
	},
	"a prepared statement": {
		plant: () => `PREPARE ${probe} AS SELECT 1`,
		read: "SELECT 1 FROM pg_catalog.pg_prepared_statements"
	}
} as const

type Outlived = keyof typeof outlived

/**
 * What a case plants: something that would outlive it on a committing session, which the next case must not find; or a
 * COMMIT sent as text, the one thing that ends the case's transaction, which must fail the case.
 */
export type Planting =
	| { readonly kind: "outlived"; readonly what: Outlived }
	| { readonly kind: "commit" }

/** Every planting: each thing that would outlive its case, by the record's own keys, then the commit. */
export const plantings: ReadonlyArray<Planting> = [
	...Arr.map(Rec.keys(outlived), (what): Planting => ({ kind: "outlived", what })),
	{ kind: "commit" }
]

/** A planting's name in a report and a feature. */
export const plantingName = (planting: Planting): string =>
	planting.kind === "commit" ? "a COMMIT sent as text" : planting.what

/** Whether `connection` holds what `what` planted. */
const holds = (connection: PgConnection, what: Outlived): Effect.Effect<boolean, SqlError> =>
	Effect.map(connection.queryValues(outlived[what].read, []), (rows) => rows.length > 0)

/**
 * Two cases in turn on one worker's held transaction session (Substrate.transaction): the first plants `planting` in its
 * transaction, the second reads that nothing planted is there, on the same held connection.
 */
export const plantedThenRead = (planting: Planting) =>
	property.exhaust(finite(int(0, 1)), {
		needs: { tx: Substrate.transaction },
		situations: [],
		check:
			({ tx }) =>
			(turn) =>
				Effect.gen(function* () {
					const { connection, database } = yield* tx
					if (turn === 0) {
						const sql =
							planting.kind === "commit" ? "COMMIT" : outlived[planting.what].plant(database)
						yield* Effect.exit(connection.query(sql, []))
						return
					}
					if (planting.kind === "outlived") {
						const held = yield* holds(connection, planting.what)
						assert.equal(held, false, `${planting.what}: none in the next case's transaction`)
					}
				}),
		oracle: { kind: "specification", name: "a case's transaction leaves nothing to the next case" },
		box: "a case that plants, then the next case on the same held connection",
		kept: [],
		kills: []
	})
