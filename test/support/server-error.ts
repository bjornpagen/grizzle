import { DatabaseError } from "pg"
import type { ServerError } from "#adapter/errors/failures.ts"
import { serverFailure } from "#adapter/wire/failure.ts"
import { assert } from "#test/support/assert.ts"

/**
 * A ServerError as the wire parses it (packages/grizzle/src/adapter/wire/failure.ts serverFailure): the ErrorResponse pg reports as a
 * DatabaseError, carrying the SQLSTATE and the identity fields given. A field undefined is one the server did not
 * report, so a test's error is the one production builds from the same report.
 *
 * The SQLSTATE and each identity field of an ErrorResponse, undefined for a field the server did not report, as pg
 * parses one (DatabaseError). Every field is stated: a test spreads nothingReported with the fields its error reports.
 */
export interface Reported {
	readonly sqlstate: string
	readonly constraint: string | undefined
	readonly schema: string | undefined
	readonly table: string | undefined
	readonly column: string | undefined
	readonly dataType: string | undefined
	readonly detail: string | undefined
}

/** No identity field reported. */
export const nothingReported: Omit<Reported, "sqlstate"> = {
	constraint: undefined,
	schema: undefined,
	table: undefined,
	column: undefined,
	dataType: undefined,
	detail: undefined
}

export const serverError = (reported: Reported): ServerError => {
	const response = new DatabaseError("an ErrorResponse a test reports", 0, "error")
	response.severity = "ERROR"
	response.code = reported.sqlstate
	response.constraint = reported.constraint
	response.schema = reported.schema
	response.table = reported.table
	response.column = reported.column
	response.dataType = reported.dataType
	response.detail = reported.detail
	const parsed = serverFailure(response)
	assert.ok(parsed !== undefined, `${reported.sqlstate} is a SQLSTATE`)
	return parsed.error
}
