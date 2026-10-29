import { Array as Arr, Effect, Option, pipe, Record, Result, Schema, String as Str } from "effect"
import { quoteIdent } from "#compiler/sql/print.ts"
import { indices } from "#test/support/oracle/pick.ts"
import type { RawQueryResult, SqlError } from "#test/support/pg.ts"

import { regex } from "arkregex"
/** One result row: each column's output-function text, in column order. */
export type RawRow = ReadonlyArray<string>

/** What a capture refused, and where: the result as a whole, a row of it, or one cell. */
export class RawCaptureError extends Schema.TaggedError<
	RawCaptureError,
	{ readonly brand: unique symbol }
>()("RawCaptureError", {
	reason: Schema.String,
	at: Schema.Union([
		Schema.Struct({ kind: Schema.Literal("result") }),
		Schema.Struct({ kind: Schema.Literal("row"), row: Schema.Finite }),
		Schema.Struct({ kind: Schema.Literal("cell"), row: Schema.Finite, column: Schema.Finite })
	])
}) {}

/** What capture needs from a session: PgConnection, or a substrate RawSession. */
export interface QueryRunner {
	readonly query: (
		sql: string,
		params: ReadonlyArray<unknown>
	) => Effect.Effect<RawQueryResult, SqlError>
}

const trimStatement = (sql: string): string =>
	Str.trimEnd(pipe(Str.trim(sql), Str.replace(regex(";$"), "")))

/** The capturing query over `sql`, which has `columns` output columns. */
const captureSql = (sql: string, columns: number): string => {
	const inner = trimStatement(sql)
	if (columns === 0) {
		return `SELECT FROM (${inner}) AS "r"`
	}
	const names = Arr.map(indices(columns), (i) => quoteIdent(`c${i + 1}`))
	const targets = Arr.map(names, (n) => `pg_catalog.format('%L', "r".${n}) AS ${n}`)
	return `SELECT ${Arr.join(targets, ", ")} FROM (${inner}) AS "r"(${Arr.join(names, ", ")})`
}

/** A captured cell's text: the literal format('%L') quoted, never NULL. */
const cellText = (
	value: unknown,
	row: number,
	column: number
): Result.Result<string, RawCaptureError> => {
	if (value === "NULL") {
		return Result.fail(
			RawCaptureError.make({ reason: "the query returned NULL", at: { kind: "cell", row, column } })
		)
	}
	const text = typeof value === "string" ? unquoteLiteral(value) : undefined
	return text === undefined
		? Result.fail(
				RawCaptureError.make({
					reason: "format('%L') returned no quoted literal",
					at: { kind: "cell", row, column }
				})
			)
		: Result.succeed(text)
}

/** The query that reports the output columns of `sql` without running it to completion. */
const columnsSql = (sql: string): string => `SELECT * FROM (${trimStatement(sql)}) AS "r" LIMIT 0`

/**
 * The text inside one format('%L') value: 'text' with '' for a quote, or E'text' with \\ for a backslash as well
 * (quote_literal doubles both and prefixes E when the text has a backslash). The bare word NULL, or anything else,
 * yields undefined. The text is joined from the runs between doubled characters, never appended character by
 * character: a per-character append builds a rope of one node per character, and a TOAST-sized cell in a wide
 * result then costs tens of times its own size.
 *
 * A quote, or an escaped literal's backslash, stands for itself only doubled.
 */
export const unquoteLiteral = (quoted: string): string | undefined => {
	const escaped = Str.startsWith("E'")(quoted)
	const start = escaped ? 2 : 1
	if (
		!(escaped || Str.startsWith("'")(quoted)) ||
		quoted.length < start + 1 ||
		!Str.endsWith("'")(quoted)
	) {
		return undefined
	}
	const body = Str.slice(start, -1)(quoted)
	const runs: Array<string> = []
	let from = 0
	for (let i = 0; i < body.length; i++) {
		const ch = Option.getOrElse(Str.charAt(body, i), () => "")
		if (ch !== "'" && !(escaped && ch === "\\")) {
			continue
		}
		if (Option.getOrElse(Str.charAt(body, i + 1), () => "") !== ch) {
			return undefined
		}
		runs.push(Str.slice(from, i + 1)(body))
		i++
		from = i + 1
	}
	runs.push(Str.slice(from)(body))
	return Arr.join(runs, "")
}

/**
 * The output-function texts of every row `sql` returns, in the order the server sent them. The query's own column count
 * is always read, because a column alias list shorter than the derived table's columns is legal in PostgreSQL and would
 * silently drop the extra trailing columns; where the caller expects a count, typically a lowering's heading, a query of
 * another count fails instead of being compared on a prefix.
 */
const capture = (
	runner: QueryRunner,
	sql: string,
	params: ReadonlyArray<unknown>,
	expected: { readonly kind: "any" } | { readonly kind: "exactly"; readonly count: number }
): Effect.Effect<ReadonlyArray<RawRow>, SqlError | RawCaptureError> =>
	Effect.gen(function* () {
		const columns = (yield* runner.query(columnsSql(sql), params)).fields.length
		if (expected.kind === "exactly" && expected.count !== columns) {
			return yield* RawCaptureError.make({
				reason: `expected ${expected.count} columns, the query has ${columns}`,
				at: { kind: "result" }
			})
		}
		const result = yield* runner.query(captureSql(sql, columns), params)
		const rows: Array<RawRow> = []
		for (const [r, record] of result.rows.entries()) {
			const values = Record.values(record)
			if (values.length !== columns) {
				return yield* RawCaptureError.make({
					reason: `expected ${columns} columns, got ${values.length}`,
					at: { kind: "row", row: r }
				})
			}
			const row = Result.all(Arr.map(values, (value, c) => cellText(value, r, c)))
			if (Result.isFailure(row)) {
				return yield* row.failure
			}
			rows.push(row.success)
		}
		return rows
	})

/**
 * Raw text result capture for the oracle: lowerings are compared as raw text multisets.
 *
 * The oracle compares lowerings by the exact text PostgreSQL's output functions write, with no codec in between, so a
 * lost distinction (1.0 vs 1.00, -0, NaN, an enum label, a supplementary-plane character) shows up as different
 * text. PgConnection reads every result column in binary format, so capture asks the server for the text itself:
 * each output column c of the query becomes format('%L', c), which calls the column type's own output function (the
 * text a text-format result would carry) and quotes it as a literal, or writes the bare word NULL for a NULL. The
 * host unquotes it. A NULL in a result is a failure, never a value: grizzle's output never contains one,
 * so capture reports it instead of letting it pass as a string.
 *
 * The query is wrapped as a derived table, so it must be a single query a FROM clause admits: a SELECT, VALUES or
 * WITH ... SELECT, never a data-modifying statement. Its parameters pass through unchanged.
 *
 * The rows of a query of exactly `expected.columns` output columns, typically a lowering's heading.
 */
export const captureRows = (
	runner: QueryRunner,
	sql: string,
	params: ReadonlyArray<unknown>,
	expected: { readonly columns: number }
): Effect.Effect<ReadonlyArray<RawRow>, SqlError | RawCaptureError> =>
	capture(runner, sql, params, { kind: "exactly", count: expected.columns })
