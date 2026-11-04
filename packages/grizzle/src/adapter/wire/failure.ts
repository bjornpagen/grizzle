import { Predicate } from "effect"
import type { DatabaseError } from "pg"
import { ServerError } from "#adapter/errors/failures.ts"
import { admittedIdentifier } from "#compiler/core/identity.ts"
import type {
	ColumnIdent,
	ConstraintName,
	DomainName,
	Identifier,
	RelationIdent
} from "#compiler/core/ids.ts"
import { parseSqlstate } from "#compiler/core/sqlstate.ts"

/**
 * An ErrorResponse as grizzle keeps it: the server's error, refused, after which the session goes on, or terminated,
 * after which the server ends the session (FATAL, PANIC).
 */
export type ServerAnswer =
	| { readonly _tag: "refused"; readonly error: ServerError }
	| { readonly _tag: "terminated"; readonly error: ServerError }

/**
 * An identity field as grizzle keeps it: pg's undefined for a field the ErrorResponse left out, and an empty one,
 * which names nothing, alike.
 */
const reported = (value: string | undefined): string | undefined =>
	value === "" ? undefined : value

/** The reported identity fields as the installed names they are, admitted here once. */
const constraintOf = (text: string | undefined): ConstraintName | undefined =>
	text === undefined ? undefined : admittedIdentifier(text)

const schemaOf = (text: string | undefined): Identifier<"schema" | "roleSchema"> | undefined =>
	text === undefined ? undefined : admittedIdentifier(text)

const tableOf = (text: string | undefined): RelationIdent | undefined =>
	text === undefined ? undefined : admittedIdentifier(text)

const columnOf = (text: string | undefined): ColumnIdent | undefined =>
	text === undefined ? undefined : admittedIdentifier(text)

const domainOf = (text: string | undefined): DomainName | undefined =>
	text === undefined ? undefined : admittedIdentifier(text)

/** The severities after which the server closes the session. */
const fatalSeverities: ReadonlySet<string> = new Set(["FATAL", "PANIC"])

/**
 * pg's DatabaseError read, once, into the one constructor of ServerError, as the server gave it (its SQLSTATE, message,
 * DETAIL, HINT and identity fields), refused or terminated by its severity, or undefined when it carries no SQLSTATE.
 * An identity field that is absent or empty is undefined, and never refuses the error. The outcome mapping (key-law
 * map, DETAIL codec, transient failures) belongs to the operation that ran the statement.
 */
export const serverFailure = (error: DatabaseError): ServerAnswer | undefined => {
	const code = error.code === undefined ? undefined : parseSqlstate(error.code)
	if (code === undefined) {
		return undefined
	}
	const kept = new ServerError({
		sqlstate: code,
		message: error.message,
		constraint: constraintOf(reported(error.constraint)),
		schema: schemaOf(reported(error.schema)),
		table: tableOf(reported(error.table)),
		column: columnOf(reported(error.column)),
		dataType: domainOf(reported(error.dataType)),
		detail: reported(error.detail),
		hint: reported(error.hint)
	})
	return Predicate.isString(error.severity) && fatalSeverities.has(error.severity)
		? { _tag: "terminated", error: kept }
		: { _tag: "refused", error: kept }
}
