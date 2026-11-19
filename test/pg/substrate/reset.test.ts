/**
 * A reset's work, proved against PostgreSQL: a group emptied by its rows (test/support/substrate/replace.ts rowsGroup,
 * the write oracle's) keeps every relation file of its tables and their indexes, the relfilenode pg_class names for
 * each, across a reset, where a TRUNCATE gives each a new one, and leaves exactly the rows the replacing transaction
 * inserts; its deletion fires no trigger, so a foreign key between two of its tables refuses no order of deletion.
 *
 * Each case draws a fixture of one to five tables, each with an index beside its key, each after the first referencing
 * the one before it, and two rounds of up to six rows a table, a row referencing the one before's of its key; it resets
 * the group to
 * the first round, reads every relation file, resets it to the second, and reads them again.
 *
 * Oracle: the specification, no relation file swapped and the second round's rows the only ones, read off pg_class and
 * the tables.
 *
 * Features: a reset that empties tables of rows, a foreign key between tables of the group, a table left empty.
 */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import type { Reached } from "@bjornpagen/testing/features"
import { type Gen, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { replaceRows, rowsGroup } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A drawn fixture: its tables, and how many rows each table holds in the first round and in the second. */
interface Fixture {
	readonly tables: number
	readonly first: number
	readonly second: number
}

const fixtureGen: Gen<Fixture> = (source) => ({
	tables: source.draw(int(1, 5)),
	first: source.draw(int(0, 6)),
	second: source.draw(int(0, 6))
})

type ResetFeature =
	| "a reset that empties tables of rows"
	| "a foreign key between tables"
	| "a table left empty"

export const aRowsResetKeepsEveryRelationFileAndLeavesExactlyTheRowsItInserts = property.explore(
	fixtureGen,
	{
		needs: { substrate: Substrate.fresh },
		situations: [
			"a reset that empties tables of rows",
			"a foreign key between tables",
			"a table left empty"
		] satisfies ReadonlyArray<Reached<ResetFeature>>,
		check:
			({ substrate }, c: Case<ResetFeature>) =>
			(fixture) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const tables = Arr.map(indices(fixture.tables), (i) => `public.reset_t${i}`)
						for (const [i, table] of tables.entries()) {
							const references =
								i === 0 ? "" : `, parent int NOT NULL REFERENCES public.reset_t${i - 1} (id)`
							yield* s.admin.query(
								`CREATE TABLE ${table} (id int PRIMARY KEY, a int${references})`,
								[]
							)
							yield* s.admin.query(`CREATE INDEX ON ${table} (a)`, [])
						}
						const group = rowsGroup(tables)
						const inserts = (rows: number) =>
							Arr.map(tables, (table, i) => ({
								sql:
									rows === 0
										? "SELECT 1"
										: i === 0
											? `INSERT INTO ${table} SELECT g, g FROM pg_catalog.generate_series(1, ${rows}) AS g`
											: `INSERT INTO ${table} SELECT g, g, g FROM pg_catalog.generate_series(1, ${rows}) AS g`,
								params: []
							}))
						const files = () =>
							s.admin.queryValues(
								"SELECT c.relname::text, c.relfilenode::text FROM pg_catalog.pg_class AS c WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'reset\\_t%' ORDER BY 1",
								[]
							)
						const { first, second } = fixture
						yield* replaceRows(s.admin, group, inserts(first))
						const before = yield* files()
						yield* replaceRows(s.admin, group, inserts(second))
						const after = yield* files()
						assert.deepEqual(after, before, "a rows reset swaps no relation file")
						for (const table of tables) {
							const rows = yield* s.admin.queryValues(
								`SELECT pg_catalog.count(*)::int FROM ${table}`,
								[]
							)
							assert.deepEqual(rows, [[second]], `${table} holds the second round's rows alone`)
						}
						if (first > 0) {
							c.note("a reset that empties tables of rows")
						}
						if (fixture.tables > 1 && first > 0) {
							c.note("a foreign key between tables")
						}
						if (second === 0) {
							c.note("a table left empty")
						}
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "no relation file swapped by a rows reset, and the second round's rows the only ones, read off pg_class and the tables"
		},
		kept: [],
		kills: [
			{
				file: "test/support/substrate/replace.ts",
				original: '\t\tcase "rows":\n\t\t\treturn []',
				replacement:
					'\t\tcase "rows":\n\t\t\treturn [{ sql: "TRUNCATE " + Arr.join(group.tables, ", "), params: [] }]',
				why: "A rows group is emptied by TRUNCATE in the replacing transaction, as the write oracle's reset was: every table and index of it gets a new relation file at every reset; the property fails."
			},
			{
				file: "test/support/substrate/replace.ts",
				original: '\t{ sql: "SET LOCAL session_replication_role = replica", params: [] },',
				replacement: '\t{ sql: "SET LOCAL session_replication_role = origin", params: [] },',
				why: "The deletion fires the foreign keys' triggers, so deleting a referenced table's rows before its referencing table's is refused (23503); the property fails on a fixture of two tables."
			}
		]
	}
)
