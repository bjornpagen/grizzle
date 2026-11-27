import { temporarySchema } from "#compiler/core/temporary.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"

/**
 * The objects of its session a statement names, by their printed names, in the order it names them: every relation,
 * type and function of the session's own temporary schema, pg_temp, a table it reads or writes, a function it calls or
 * a type it casts to. A served statement names none: its text is a function of its program alone, so it is one
 * statement in every session, one queryid, one plan a session keeps (write/carriers/carriers.ts).
 */
export const sessionObjectsNamed = (statement: SqlStatement): ReadonlyArray<string> => {
	const named: Array<string> = []
	transformStatement(statement, {
		...identityHooks,
		objectName: (name) => {
			if (name.schema === temporarySchema) {
				named.push(printObjectName(name))
			}
			return name
		},
		functionRef: (fn) => {
			if (fn.schema === temporarySchema) {
				named.push(printObjectName(fn))
			}
			return fn
		},
		typeRef: (type) => {
			if (type.kind === "named" && type.schema === temporarySchema) {
				named.push(printObjectName({ schema: type.schema, name: type.name }))
			}
			return type
		}
	})
	return named
}

/** Whether a statement is one a Db may serve, DML, as every served statement is: no installation's DDL. */
export const servable = (statement: SqlStatement): boolean =>
	statement.kind === "select" ||
	statement.kind === "insert" ||
	statement.kind === "update" ||
	statement.kind === "delete" ||
	statement.kind === "merge"
