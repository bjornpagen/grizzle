import { Predicate } from "effect"
import { ServerError } from "#adapter/errors/failures.ts"
import type { PgDatabaseError } from "#adapter/types/driver.ts"
import { Sqlstate } from "#compiler/plan/common.ts"

/**
 * An ErrorResponse as grizzle keeps it: the server's error, refused, after which the session goes on, or terminated,
 * after which the server ends the session (FATAL, PANIC).
 */
export type ServerAnswer =
	| { readonly _tag: "refused"; readonly error: ServerError }
	| { readonly _tag: "terminated"; readonly error: ServerError }

/** The severities after which the server closes the session. */
const fatalSeverities: ReadonlySet<string> = new Set(["FATAL", "PANIC"])

/**
 * The driver's DatabaseError read, once, into ServerError's one constructor, as the server gave it (its SQLSTATE,
 * message, DETAIL, HINT and identity fields, an empty one naming nothing), refused or terminated by its severity, or
 * undefined when it carries no SQLSTATE. The outcome mapping (key-law map, DETAIL codec, transient failures) belongs
 * to the operation that ran the statement.
 */
export const serverFailure = (error: PgDatabaseError): ServerAnswer | undefined => {
	const code = error.code === undefined ? undefined : Sqlstate.parse(error.code)
	if (code === undefined) {
		return undefined
	}
	const kept = new ServerError({
		sqlstate: code,
		message: error.message,
		constraint: error.constraint,
		schema: error.schema,
		table: error.table,
		column: error.column,
		dataType: error.dataType,
		detail: error.detail,
		hint: error.hint
	})
	return Predicate.isString(error.severity) && fatalSeverities.has(error.severity)
		? { _tag: "terminated", error: kept }
		: { _tag: "refused", error: kept }
}
