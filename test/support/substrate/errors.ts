import { Data, Option, Predicate } from "effect"
import { admittedIdentifier } from "#compiler/core/identity.ts"
import type { ConstraintOwner } from "#compiler/ir/products.ts"
import { type PgErrorFields, reportedConstraintOf, SqlError } from "#test/support/pg.ts"

import { regex } from "arkregex"
export type { PgErrorFields }

/**
 * What a native violation reports its constraint on, as the installation's constraint map keys it (ir/products.ts
 * ConstraintOwner): its table, or the data type of a domain constraint, its domain. None for an error that reports
 * neither, a law function's or a write statement's refusal among them.
 */
export const reportedOwnerOf = (fields: PgErrorFields): ConstraintOwner | undefined => {
	if (Option.isSome(fields.table)) {
		return { kind: "table", name: admittedIdentifier(fields.table.value) }
	}
	return Option.isSome(fields.dataType)
		? { kind: "domain", name: admittedIdentifier(fields.dataType.value) }
		: undefined
}

/** A statement a psql child ran failed; the fields come from psql's verbose error report. */
export class PsqlStatementError extends Data.TaggedError("PsqlStatementError")<{
	readonly sql: string
	readonly fields: PgErrorFields
}> {}

/** The psql child could not start, refused the connection, or exited while a statement was in flight. */
export class PsqlProcessError extends Data.TaggedError("PsqlProcessError")<{
	readonly reason: string
	readonly stderr: string
}> {}

/**
 * A COMMIT that PostgreSQL answered with the command tag ROLLBACK: the transaction had already failed (an earlier
 * statement raised and was caught), so nothing was committed. PostgreSQL reports this without an error, SQLSTATE
 * 00000, so a session that ignored the tag would report a commit that never happened.
 */
export class TransactionRolledBack extends Data.TaggedError("TransactionRolledBack")<{
	readonly label: string
	/** The command tag PostgreSQL answered COMMIT with. */
	readonly command: string
}> {}

/** expectSqlstate or expectConstraint did not see the failure it expected. */
export class ExpectationFailed extends Data.TaggedError("ExpectationFailed")<{
	readonly message: string
}> {}

const sqlstate = regex("^[0-9A-Z]{5}$")

/** A field a recorded error may carry: its non-empty text, or none. */
const sentField = (
	record: Readonly<Record<string, unknown>>,
	key: string
): Option.Option<string> => {
	const value = record[key]
	return Predicate.isString(value) && value.length > 0 ? Option.some(value) : Option.none()
}

/**
 * Every property of an object reads as some value, which `unknown` describes, so this claims no more than it checks.
 */
const isReadable = (value: unknown): value is Readonly<Record<string, unknown>> =>
	Predicate.isObject(value)

const fromRecord = (value: unknown): PgErrorFields | undefined => {
	if (!isReadable(value)) {
		return undefined
	}
	const record = value
	const code = record["code"]
	if (!Predicate.isString(code) || !sqlstate.test(code)) {
		return undefined
	}
	return {
		code,
		message: Predicate.isString(record["message"]) ? record["message"] : "",
		detail: sentField(record, "detail"),
		hint: sentField(record, "hint"),
		where: sentField(record, "where"),
		schema: sentField(record, "schema"),
		table: sentField(record, "table"),
		column: sentField(record, "column"),
		dataType: sentField(record, "dataType"),
		constraint: reportedConstraintOf(record["constraint"])
	}
}

/**
 * Typed failures of the test substrate, and SQLSTATE extraction from both kinds of session.
 *
 * The PostgreSQL error behind a failure, if there is one: a psql statement error, or a test connection's SqlError
 * (../pg.ts), whose reason carries the ErrorResponse fields.
 */
export const pgErrorFields = (error: unknown): PgErrorFields | undefined => {
	if (error instanceof PsqlStatementError) {
		return error.fields
	}
	if (error instanceof SqlError) {
		return error.reason._tag === "ServerError" ? error.reason.fields : undefined
	}
	return fromRecord(error)
}

/**
 * PostgreSQL's message as a report reads it, with its DETAIL when it sent one: a 40001's reason code, a violated key,
 * a missing referenced row.
 */
export const messageText = (said: Pick<PgErrorFields, "message" | "detail">): string =>
	Option.match(said.detail, {
		onNone: () => said.message,
		onSome: (detail) => `${said.message}; DETAIL: ${detail}`
	})
