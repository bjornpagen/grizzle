import {
	type Expr,
	type FromItem,
	type FromSource,
	nameKey,
	type NameKey,
	type ObjectName,
	type OperandBody,
	type OperandSelect,
	selectColumns
} from "#compiler/sql/ast.ts"

/** A stored column as a statement reads it: by the table or view it is a column of, and its name there. */
export interface StoredColumn {
	readonly table: ObjectName
	readonly column: string
}

/**
 * A set of stored columns, by the table or plain view a statement reads each through: the columns a B-tree holds the
 * suffix key of, which a judged read's own seeks read through (sql/suffix.ts, physical/ddl/rules.ts).
 */
export interface StoredColumns {
	readonly has: (column: StoredColumn) => boolean
}

/** The stored columns `columns`, each by the table or plain view it is read through. */
export const storedColumns = (columns: Iterable<StoredColumn>): StoredColumns => {
	const byTable = new Map<NameKey, Set<string>>()
	for (const c of columns) {
		const key = nameKey(c.table)
		const held = byTable.get(key) ?? new Set<string>()
		held.add(c.column)
		byTable.set(key, held)
	}
	return { has: (c) => byTable.get(nameKey(c.table))?.has(c.column) === true }
}

/**
 * The stored column a column reference of a core reads, through the core's FROM: a table's column, or a derived table's
 * column whose query delivers it from a stored column, a plain core's target or a query's that reads one, under no
 * WITH; none for any other source, a CTE's, a function's or an input's, which an index of a table never serves.
 */
export const originIn = (from: ReadonlyArray<FromItem>, ref: Expr): StoredColumn | undefined => {
	if (ref.kind !== "column" || ref.table === undefined) {
		return undefined
	}
	const alias = ref.table
	const source = sourcesOf(from).find((s) => sourceAlias(s) === alias)
	if (source === undefined) {
		return undefined
	}
	switch (source.kind) {
		case "table":
		case "read":
			return typeof source.table === "string"
				? undefined
				: { table: source.table, column: ref.column }
		case "derived": {
			const at = selectColumns(source.query).indexOf(ref.column)
			return at < 0 ? undefined : deliveredAt(source.query, at)
		}
		case "probe":
		case "met":
		case "metRows":
		case "cte":
		case "transition":
		case "enclosing":
		case "function":
		case "arrays":
		case "values":
		case "context":
			return undefined
	}
}

/** The stored column a query delivers as its column `at`, when it delivers one (`originIn`). */
const deliveredAt = (query: OperandSelect, at: number): StoredColumn | undefined =>
	query.with === undefined ? bodyAt(query.body, at) : undefined

const bodyAt = (body: OperandBody, at: number): StoredColumn | undefined => {
	switch (body.kind) {
		case "core": {
			const target = body.targets[at]
			return target === undefined ? undefined : originIn(body.from, target.expr)
		}
		case "select":
			return deliveredAt(body, at)
		case "setOp":
			return undefined
	}
}

/** Every source of a FROM, a join chain's each. */
const sourcesOf = (from: ReadonlyArray<FromItem>): ReadonlyArray<FromSource> =>
	from.flatMap((item): ReadonlyArray<FromSource> =>
		item.kind === "joins" ? [item.first, ...item.steps.map((s) => s.source)] : [item]
	)

/** The name a source's columns are qualified by: its alias, or a CTE's own name where it has none. */
const sourceAlias = (source: FromSource): string =>
	source.kind === "cte" ? (source.alias ?? source.name) : source.alias
