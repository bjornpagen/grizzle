import { Array as Arr, Data, Effect, Option, pipe, Record, Result, String as Str } from "effect"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { RawQueryResult, SqlError } from "#test/support/pg.ts"

import { regex } from "arkregex"
/** One result row: each column's result text (captureRows), in column order. */
export type RawRow = ReadonlyArray<string>

/** What a capture refused, and where: the result as a whole, a row of it, or one cell. */
export class RawCaptureError extends Data.TaggedError("RawCaptureError")<{
	readonly reason: string
	readonly at:
		| { readonly kind: "result" }
		| { readonly kind: "row"; readonly row: number }
		| { readonly kind: "cell"; readonly row: number; readonly column: number }
}> {}

/** What capture needs from a session: PgConnection, or a substrate RawSession. */
export interface QueryRunner {
	readonly query: (
		sql: string,
		params: ReadonlyArray<unknown>
	) => Effect.Effect<RawQueryResult, SqlError>
}

const trimStatement = (sql: string): string =>
	Str.trimEnd(pipe(Str.trim(sql), Str.replace(regex(";$"), "")))

/**
 * The casts that make one output column's result text, as the outermost SELECT of an executable statement applies
 * them (lower/template.ts): codec resultTextCasts of a heading column's type, money through numeric, and text for a
 * fused attachment's array.
 */
export type ColumnCasts = ReadonlyArray<"numeric" | "text">

/** The capturing query over `sql`, whose output columns take `columns` casts each. */
const captureSql = (sql: string, columns: ReadonlyArray<ColumnCasts>): string => {
	const inner = trimStatement(sql)
	if (!Arr.isReadonlyArrayNonEmpty(columns)) {
		return `SELECT FROM (${inner}) AS "r"`
	}
	const names = Arr.map(columns, (_, i) => quoteIdent(`c${i + 1}`))
	const targets = Arr.map(columns, (casts, i) => {
		const n = quoteIdent(`c${i + 1}`)
		const cast = Arr.join(
			Arr.map(casts, (c) => `::pg_catalog.${c}`),
			""
		)
		return `pg_catalog.format('%L', ("r".${n})${cast}) AS ${n}`
	})
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
			new RawCaptureError({ reason: "the query returned NULL", at: { kind: "cell", row, column } })
		)
	}
	const text = typeof value === "string" ? unquoteLiteral(value) : undefined
	return text === undefined
		? Result.fail(
				new RawCaptureError({
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
 * Result text capture for the oracle: lowerings are compared by the texts the runtime receives.
 *
 * PgConnection reads every result column in binary format, so capture asks the server for the text itself: each
 * output column c of the query becomes format('%L', c) after the casts an executable statement's outermost SELECT
 * applies to it (ColumnCasts, codec resultTextCasts), so a money cell is its numeric text and every other cell its
 * type's text, the text a runtime read receives, quoted as a literal, or the bare word NULL for a NULL. The host
 * unquotes it. A NULL in a result is a failure, never a value: grizzle's output never contains one, so capture reports
 * it instead of letting it pass as a string. The comparison reads each text to its value (compare.ts canonicalCell).
 *
 * The query is wrapped as a derived table, so it must be a single query a FROM clause admits: a SELECT, VALUES or
 * WITH ... SELECT, never a data-modifying statement. Its parameters pass through unchanged.
 *
 * The rows of a query of exactly one output column per entry of `columns`, typically a lowering's heading, in the
 * order the server sent them. The query's own column count is always read, because a column alias list shorter than
 * the derived table's columns is legal in PostgreSQL and would silently drop the extra trailing columns: a query of
 * another count fails instead of being compared on a prefix.
 */
export const captureRows = (
	runner: QueryRunner,
	sql: string,
	params: ReadonlyArray<unknown>,
	columns: ReadonlyArray<ColumnCasts>
): Effect.Effect<ReadonlyArray<RawRow>, SqlError | RawCaptureError> =>
	captured(runner, sql, params, (width) =>
		columns.length === width
			? Result.succeed(columns)
			: Result.fail(
					new RawCaptureError({
						reason: `expected ${columns.length} columns, the query has ${width}`,
						at: { kind: "result" }
					})
				)
	)

/**
 * The rows of a statement whose every output column is a text the runtime reads as sent, a program's sent statement
 * (lower/template.ts executableQueryFrom, lower/parts.ts): captureRows with no cast, over every column the query has.
 */
export const captureTexts = (
	runner: QueryRunner,
	sql: string,
	params: ReadonlyArray<unknown>
): Effect.Effect<ReadonlyArray<RawRow>, SqlError | RawCaptureError> =>
	captured(runner, sql, params, (width) =>
		Result.succeed(Array.from({ length: width }, (): ColumnCasts => []))
	)

/** The rows of `sql`, each of its output columns cast as `columnsOf` says for the query's own column count. */
const captured = (
	runner: QueryRunner,
	sql: string,
	params: ReadonlyArray<unknown>,
	columnsOf: (width: number) => Result.Result<ReadonlyArray<ColumnCasts>, RawCaptureError>
): Effect.Effect<ReadonlyArray<RawRow>, SqlError | RawCaptureError> =>
	Effect.gen(function* () {
		const described = yield* runner.query(columnsSql(sql), params)
		const width = described.fields.length
		const columns = columnsOf(width)
		if (Result.isFailure(columns)) {
			return yield* columns.failure
		}
		const result = yield* runner.query(captureSql(sql, columns.success), params)
		const rows: Array<RawRow> = []
		for (const [r, record] of result.rows.entries()) {
			const values = Record.values(record)
			if (values.length !== width) {
				return yield* new RawCaptureError({
					reason: `expected ${width} columns, got ${values.length}`,
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
