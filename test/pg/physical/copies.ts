/**
 * Copies of an installation's tables, as the plan-shape law's states read them (test/pg/physical/serving.ts judgeServing,
 * plan-shape.fixtures.ts): a copy holds the table's columns, defaults, constraints and indexes, and its declared
 * statistics as the installation's migration declares them, so PostgreSQL plans a statement over the copy as it plans
 * it over the table at the copy's size. PostgreSQL reads a relation's size off its blocks (tableam.c
 * table_block_relation_estimate_size, plancat.c get_relation_info), so a state holds its rows, and the table itself is
 * never grown.
 */
import { Array as Arr, Effect, Option } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { printCommands } from "#compiler/sql/print.ts"
import type { SqlError } from "#test/support/pg.ts"
import { insertOf } from "#test/support/substrate/fill.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A table a copy is made of: its schema, its name, and both quoted and qualified. */
export interface CopiedTable {
	readonly schema: string
	readonly name: string
	readonly quoted: string
}

/** A copy of a table (standCopy): its quoted name, and its own name, as EXPLAIN reports its scans. */
export interface Copy {
	readonly quoted: string
	readonly name: string
}

/** The name every copy takes, in its table's schema: one copy of a table stands at a time. */
const copyName = "__judged_copy"

/** The rows of a one-column answer, each as text. */
const textsOf = (
	rows: ReadonlyArray<ReadonlyArray<unknown>>
): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.map(rows, (row) => Arr.map(row, (cell) => (typeof cell === "string" ? cell : String(cell))))

/**
 * Stands up a copy of `table` on the admin session: its columns, defaults, constraints and indexes (CREATE TABLE ...
 * (LIKE ... INCLUDING ALL EXCLUDING STATISTICS), each index in its table's order, so ties PostgreSQL breaks by the
 * latest index fall alike), then the table's declared statistics, the installation's own declaration
 * (physical/statistics/statistics.ts) printed over the copy, each declared dependency a statistics object of the copy's
 * own, none where the installation declares none. In a transaction the caller rolls back, the copy goes with
 * it; outside one, the caller drops it (dropCopy).
 */
export const standCopy = (
	installation: Installation,
	table: CopiedTable
): Effect.Effect<Copy, SqlError, Substrate> =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const copy = { quoted: `${quoteIdent(table.schema)}.${quoteIdent(copyName)}`, name: copyName }
		yield* admin.query(
			`CREATE TABLE ${copy.quoted} (LIKE ${table.quoted} INCLUDING ALL EXCLUDING STATISTICS)`,
			[]
		)
		const declarations = Arr.flatMap(installation.manifest.objects, (o) =>
			o.kind === "statistics"
				? Arr.flatMap(o.ddl, (s) =>
						s.kind === "declareStatistics" &&
						s.table.schema === table.schema &&
						s.table.name === table.name
							? [
									{
										...s,
										table: { schema: table.schema, name: copyName },
										dependencies: Arr.map(s.dependencies, (d, at) => ({
											...d,
											name: { schema: table.schema, name: `${copyName}_dependency_${at}` }
										}))
									}
								]
							: []
					)
				: []
		)
		for (const declared of declarations) {
			for (const command of printCommands(declared)) {
				yield* admin.query(command, [])
			}
		}
		return copy
	})

/** Drops a copy standCopy made outside a transaction. */
export const dropCopy = (copy: Copy): Effect.Effect<void, never, Substrate> =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		yield* Effect.ignore(admin.query(`DROP TABLE IF EXISTS ${copy.quoted}`, []))
	})

/**
 * Fills a copy with the rows `from` to `to`, both included, of its table's load (`columns`, each column's SQL over the
 * series `g`, fill.ts VolumeTable), each a key already holds skipped; and the rows the copy then holds.
 */
export const fillCopy = (
	copy: Copy,
	columns: ReadonlyArray<readonly [column: string, sql: string]>,
	from: number,
	to: number
): Effect.Effect<number, SqlError, Substrate> =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		if (to >= from) {
			yield* admin.query(insertOf({ table: copy.quoted, columns }, "skipped", from, to), [])
		}
		const counted = yield* admin.queryValues(`SELECT count(*)::text FROM ${copy.quoted}`, [])
		const [row] = textsOf(counted)
		return Number(row?.[0] ?? "0")
	})

/**
 * Each index of `copy` by name, with its table's index of the same definition (its keys, method, uniqueness and
 * predicate, pg_get_indexdef past its name and table) and its own pages now.
 */
export const copyIndexes = (
	table: CopiedTable,
	copy: Copy
): Effect.Effect<
	ReadonlyMap<string, { readonly original: string; readonly pages: number }>,
	SqlError,
	Substrate
> =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const answered = yield* admin.queryValues(
			"SELECT c.relname::text, o.relname::text, " +
				"(pg_catalog.pg_relation_size(c.oid) / pg_catalog.current_setting('block_size')::bigint)::text " +
				"FROM pg_catalog.pg_index AS xc JOIN pg_catalog.pg_class AS c ON c.oid = xc.indexrelid " +
				"JOIN pg_catalog.pg_index AS xo ON xo.indrelid = $1::text::pg_catalog.regclass " +
				"JOIN pg_catalog.pg_class AS o ON o.oid = xo.indexrelid " +
				"WHERE xc.indrelid = $2::text::pg_catalog.regclass " +
				"AND pg_catalog.substring(pg_catalog.pg_get_indexdef(xc.indexrelid), ' USING .*$') = " +
				"pg_catalog.substring(pg_catalog.pg_get_indexdef(xo.indexrelid), ' USING .*$') ORDER BY 1, 2",
			[table.quoted, copy.quoted]
		)
		const mapped = textsOf(answered)
		const indexes = new Map<string, { readonly original: string; readonly pages: number }>()
		for (const [name, original, pages] of mapped) {
			if (name !== undefined && original !== undefined && !indexes.has(name)) {
				indexes.set(name, { original, pages: Number(pages) })
			}
		}
		return indexes
	})

/** The table's index of the same definition as the copy's `index`, from copyIndexes. */
export const originalOf =
	(indexes: ReadonlyMap<string, { readonly original: string; readonly pages: number }>) =>
	(index: string): Option.Option<string> =>
		Option.fromUndefinedOr(indexes.get(index)?.original)
