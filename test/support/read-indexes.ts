/**
 * The indexes a workload's access builds and the indexes its reads' plans read: the law that every index the index
 * engine creates for a drawn workload is read by some statement of it (physical/access/extract.ts extractAccess asks a
 * path of no chain no plan prints), so no write pays a B-tree insert for an index nothing reads.
 */

import { Array as Arr, Option, Order } from "effect"
import { type PlanNode, planNodes } from "#bench/harness/explain.ts"
import type { PgConnection } from "#test/support/pg.ts"

/** An index no key's unique constraint installs: its name, and its table's with its columns, `table(a, b)`. */
export interface PlainIndex {
	readonly name: string
	readonly spelled: string
}

/**
 * The indexes of `tables`, each quoted, that key nothing (a key's unique index aside): what the workload's access built
 * over them, and the laws' where an installation holds laws.
 */
export const plainIndexesOf = (connection: PgConnection, tables: ReadonlyArray<string>) =>
	connection.queryValues(
		"SELECT i.relname::text, t.relname::text || '(' || pg_catalog.string_agg(a.attname::text, ', ' ORDER BY k.n) || ')' " +
			"FROM pg_catalog.pg_index AS x JOIN pg_catalog.pg_class AS i ON i.oid = x.indexrelid " +
			"JOIN pg_catalog.pg_class AS t ON t.oid = x.indrelid " +
			"CROSS JOIN LATERAL pg_catalog.unnest(x.indkey::pg_catalog.int2[]) WITH ORDINALITY AS k(attnum, n) " +
			"JOIN pg_catalog.pg_attribute AS a ON a.attrelid = x.indrelid AND a.attnum = k.attnum " +
			`WHERE NOT x.indisunique AND x.indrelid IN (${Arr.join(
				Arr.map(tables, (t) => `'${t}'::pg_catalog.regclass`),
				", "
			)}) GROUP BY i.relname, t.relname ORDER BY 1`,
		[]
	)

/** The rows `plainIndexesOf` reads, each its index. */
export const plainIndexes = (
	rows: ReadonlyArray<ReadonlyArray<unknown>>
): ReadonlyArray<PlainIndex> =>
	Arr.map(rows, (row) => ({ name: String(row[0]), spelled: String(row[1]) }))

/** The indexes a plan's scans read. */
export const indexesRead = (plan: PlanNode): ReadonlyArray<string> =>
	Arr.flatMap([...planNodes(plan)], (n) => (Option.isSome(n.index) ? [n.index.value] : []))

/** The indexes of `built` no plan of `plans` reads, each spelled `table(a, b)`, in order. */
export const unreadIndexes = (
	built: ReadonlyArray<PlainIndex>,
	plans: ReadonlyArray<PlanNode>
): ReadonlyArray<string> => {
	const read = new Set(Arr.flatMap(plans, indexesRead))
	return Arr.sort(
		Arr.flatMap(built, (i) => (read.has(i.name) ? [] : [i.spelled])),
		Order.String
	)
}
