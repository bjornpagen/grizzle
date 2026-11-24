import { temporarySchema } from "#compiler/core/temporary.ts"
import type { CteBody, SqlStatement, TableName } from "#compiler/sql/ast.ts"
import { type CarrierName, readerCarrier } from "#compiler/sql/naming.ts"
import { printTableName } from "#compiler/sql/print.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"

/** A table name with how often a statement names it in some role. */
interface Named {
	readonly table: TableName
	readonly count: number
}

const count = (counts: Map<string, Named>, table: TableName): void => {
	const key = printTableName(table)
	counts.set(key, { table, count: (counts.get(key)?.count ?? 0) + 1 })
}

/**
 * The carriers a write statement reads, by name: every carrier whose reader it calls (sql/naming.ts readerCarrier), the
 * way every statement reads a carrier, and every carrier it reads by its table (`carrierTableReads`).
 */
export const carrierReads = (statement: SqlStatement): ReadonlySet<CarrierName> => {
	const read = new Set<CarrierName>(carrierTableReads(statement))
	if (isDml(statement)) {
		transformStatement(statement, {
			...identityHooks,
			functionRef: (fn) => {
				const carrier = fn.schema === temporarySchema ? readerCarrier(fn.name) : undefined
				if (carrier !== undefined) {
					read.add(carrier)
				}
				return fn
			}
		})
	}
	return read
}

/** Whether `statement` is DML, the only statements that read a carrier's rows. */
const isDml = (
	statement: SqlStatement
): statement is Extract<
	SqlStatement,
	{ readonly kind: "select" | "insert" | "update" | "delete" | "merge" }
> =>
	statement.kind === "select" ||
	statement.kind === "insert" ||
	statement.kind === "update" ||
	statement.kind === "delete" ||
	statement.kind === "merge"

/**
 * The carriers a write statement reads by their table, by name: every carrier it names, a bare table name (sql/ast.ts
 * TableName), except where it is only an INSERT target, in the statement itself or in a data-modifying CTE of its WITH
 * (the only place a statement nests one); a DELETE, UPDATE or MERGE target is joined against the statement's input,
 * which is a read of it as much as a write. A statement that is no DML reads no carrier's rows. The transform's
 * objectName and carrier hooks see exactly the table references of a DML statement. None, where every statement reads
 * a carrier through its reader (write/carriers/carriers.ts carrierRead) and only a fill writes its table.
 */
export const carrierTableReads = (statement: SqlStatement): ReadonlySet<CarrierName> => {
	if (!isDml(statement)) {
		return new Set()
	}
	const named = new Map<string, Named>()
	transformStatement(statement, {
		...identityHooks,
		objectName: (name) => {
			count(named, name)
			return name
		},
		carrier: (name) => {
			count(named, name)
			return name
		}
	})
	const inserted = new Map<string, Named>()
	const target = (body: CteBody): void => {
		if (body.kind === "insert") {
			count(inserted, body.table)
		}
	}
	target(statement)
	for (const cte of statement.with?.ctes ?? []) {
		target(cte.query)
	}
	const reads = new Set<CarrierName>()
	for (const [key, { table, count: n }] of named) {
		if (typeof table === "string" && n > (inserted.get(key)?.count ?? 0)) {
			reads.add(table)
		}
	}
	return reads
}

/**
 * The carriers a write statement fills, by name: every carrier an INSERT of it targets, the statement itself or a
 * data-modifying CTE of its WITH, the only place a statement nests one (write/readback/deltas.ts carriedFill).
 */
export const carrierFills = (statement: SqlStatement): ReadonlySet<CarrierName> => {
	if (!isDml(statement)) {
		return new Set()
	}
	const filled = new Set<CarrierName>()
	const target = (body: CteBody): void => {
		if (body.kind === "insert" && typeof body.table === "string") {
			filled.add(body.table)
		}
	}
	target(statement)
	for (const cte of statement.with?.ctes ?? []) {
		target(cte.query)
	}
	return filled
}
