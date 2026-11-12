import type { CteBody, Dml, SqlStatement, TableName } from "#compiler/sql/ast.ts"
import type { CarrierName } from "#compiler/sql/naming.ts"
import { printTableName } from "#compiler/sql/print.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"

interface RelationAccess {
	readonly reads: ReadonlySet<CarrierName>
	/** The carriers it writes or creates. */
	readonly writes: ReadonlySet<CarrierName>
	/** Whether it reads a stored relation. */
	readonly stored: boolean
}

const none: RelationAccess = { reads: new Set(), writes: new Set(), stored: false }

/** A table name with how often a statement names it in some role. */
interface Named {
	readonly table: TableName
	readonly count: number
}

const count = (counts: Map<string, Named>, table: TableName): void => {
	const key = printTableName(table)
	counts.set(key, { table, count: (counts.get(key)?.count ?? 0) + 1 })
}

const dmlAccess = (statement: Dml): RelationAccess => {
	/**
	 * Every table the statement names, with how often it occurs; the transform's objectName and carrier hooks see
	 * exactly the table references of a DML statement.
	 */
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
	const writes = new Set<CarrierName>()
	const target = (body: CteBody): void => {
		if (body.kind === "select") {
			return
		}
		if (body.kind === "insert") {
			count(inserted, body.table)
		}
		if (typeof body.table === "string") {
			writes.add(body.table)
		}
	}
	target(statement)
	for (const cte of statement.with?.ctes ?? []) {
		target(cte.query)
	}
	const reads = new Set<CarrierName>()
	let stored = false
	for (const [key, { table, count: n }] of named) {
		if (n <= (inserted.get(key)?.count ?? 0)) {
			continue
		}
		if (typeof table === "string") {
			reads.add(table)
		} else {
			stored = true
		}
	}
	return { reads, writes, stored }
}

/**
 * Which relations a statement reads and writes, by name.
 *
 * A write program analyzes a transaction-scoped carrier after it is filled and before the first statement that joins
 * it against a stored relation (write/program/analyze.ts). That needs, per statement, the carriers it reads, the ones
 * it writes, and whether it reads a stored relation at all. A table a statement names is a carrier, by its bare name,
 * or a stored relation, by its qualified name (sql/ast.ts TableName).
 *
 * A table a statement names is read, except where it is only an INSERT target: a DELETE, UPDATE or MERGE target is
 * joined against the statement's input, which is a read of it as much as a write. The writes are every DML target, in
 * the statement itself or in a data-modifying CTE of its WITH (the only place a statement nests one), and the carrier a
 * CREATE TEMPORARY TABLE creates. An INSERT's target is located by the arbiter index of its ON CONFLICT clause, never
 * by a plan the target's estimate chooses, so it is no stored read.
 *
 * Every other statement accesses no carrier and reads no relation's rows: a definition, a grant or a role's setting
 * changes the catalog; a transaction statement and a lock touch no row. A REFRESH and an index build do read their
 * stored relations, but neither runs in a write program, the only reader.
 */
export const relationAccess = (statement: SqlStatement): RelationAccess => {
	switch (statement.kind) {
		case "select":
		case "insert":
		case "update":
		case "delete":
		case "merge":
			return dmlAccess(statement)
		case "createCarrier":
			return { reads: new Set(), writes: new Set([statement.name]), stored: false }
		case "analyze":
			return {
				reads: new Set(statement.carriers),
				writes: new Set(statement.carriers),
				stored: false
			}
		case "createSchema":
		case "createTable":
		case "alterTable":
		case "rename":
		case "renameColumn":
		case "renameConstraint":
		case "createDomain":
		case "alterDomain":
		case "createIndex":
		case "dropIndex":
		case "createMaterializedView":
		case "createView":
		case "createPolicy":
		case "dropPolicy":
		case "drop":
		case "dropFunction":
		case "dropTrigger":
		case "createFunction":
		case "packConstant":
		case "createConstant":
		case "createGuardTrigger":
		case "createConstraintTrigger":
		case "createPublication":
		case "dropPublication":
		case "createLiveSecret":
		case "alterDatabaseDefault":
		case "createRole":
		case "alterRole":
		case "grantRole":
		case "revokeRole":
		case "grant":
		case "revoke":
		case "grantColumns":
		case "alterDefaultPrivileges":
		case "createExtension":
		case "createStatistics":
		case "lockTable":
		case "comment":
		case "beginRead":
		case "beginWrite":
		case "commit":
		case "rollback":
		case "setConstraintsImmediate":
		case "refresh":
			return none
	}
}
