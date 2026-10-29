import { Array as Arr, Effect, String as Str } from "effect"
import { type PhysicalNames, statementOutput } from "#compiler/lower/conservative/types.ts"
import type { FusedStatement } from "#compiler/lower/shapes/index.ts"
import { columnType } from "#compiler/physical/ddl/names.ts"
import { lex } from "#compiler/sql/lexer.ts"
import { printType } from "#compiler/sql/print.ts"
import { indices } from "#test/support/oracle/pick.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"

/** `text` with every placeholder replaced by NULL, read from its tokens. */
const withNullPlaceholders = (text: string): string => {
	const lexed = lex(text)
	let out = ""
	let from = 0
	for (const t of lexed.tokens) {
		if (t.kind !== "param") {
			continue
		}
		out += `${Str.slice(from, t.start)(text)}NULL`
		from = t.start + `$${t.index}`.length
	}
	return out + Str.slice(from)(text)
}

const quoted = (s: string): string => `'${Str.replaceAll("'", "''")(s)}'`

/**
 * The type oracle: PostgreSQL's resolved type of every column a lowered statement delivers, against the IR's.
 *
 * The IR states each delivered column's type (the statement's heading), and the lowering emits SQL whose types
 * PostgreSQL resolves on its own: a native function's result is its catalog type, a parameter is bound at its cast, a
 * literal at its base until cast, a CASE at the common type of its branches. Where the two disagree, a cast is missing
 * or wrong, and a value is decoded by a type it does not have. So PostgreSQL judges both sides at every column a
 * statement delivers:
 *
 * - the statement's text, every placeholder replaced by NULL (each placeholder carries its cast, so the cast still
 *   types it), becomes a temporary view, and pg_attribute states each output column's type, domains and enums
 *   included;
 * - the IR's type of the column is printed as the DDL types a column of it (physical/ddl/names.ts columnType) and
 *   resolved by PostgreSQL's own ::regtype.
 *
 * An unrefined column must be exactly its type. A refined column (a contract's domain or a pattern's text domain) is
 * delivered as its domain, or as one of the types the domain is over, down to its base: the refined delivery leaves a
 * value whose membership it proved uncast (lower/conservative/refined.ts: min, max, LEAST, GREATEST and CASE deliver
 * one of their operands' values), and PostgreSQL types min over a domain by its base. The typmod is no part of the claim
 * for a query: a delivered column is decoded from its text. A fused attachment's array column is no heading column, and
 * its elements are judged by their decoding.
 *
 * Each heading column of `statement` whose type PostgreSQL resolves otherwise than the IR states, as one line located
 * at `where`: none when every column agrees. `probe` names the temporary view, unique within the session's
 * transaction.
 */
export const typeProblems = (
	session: PgConnection,
	statement: FusedStatement,
	names: PhysicalNames,
	probe: string,
	where: string
): Effect.Effect<ReadonlyArray<string>, SqlError> =>
	Effect.gen(function* () {
		const heading = statementOutput(statement.role, statement.heading, statement.fused).heading
		if (heading.length === 0) {
			return []
		}
		const columns = [
			...Arr.map(indices(heading.length), (i) => `c${i + 1}`),
			...Arr.map(indices(statement.fused.length), (j) => `f${j + 1}`)
		]
		const view = `pg_temp.${probe}`
		yield* session.query(
			`CREATE TEMPORARY VIEW ${probe} (${Arr.join(columns, ", ")}) AS ${withNullPlaceholders(statement.sql.text)}`,
			[]
		)
		const claimed = Arr.map(
			heading,
			(c, i) => `(${i + 1}, ${quoted(printType(columnType(names, c.type).type))})`
		)
		/** Each claimed type with the types it is over, a domain's chain down to its base. */
		const result = yield* session.query(
			`WITH RECURSIVE claim(n, t) AS (VALUES ${Arr.join(claimed, ", ")}),
			admitted(n, oid, typtype, typbasetype) AS (
				SELECT c.n, ty.oid, ty.typtype, ty.typbasetype
				FROM claim AS c JOIN pg_catalog.pg_type AS ty ON ty.oid = c.t::regtype
				UNION ALL
				SELECT d.n, ty.oid, ty.typtype, ty.typbasetype
				FROM admitted AS d JOIN pg_catalog.pg_type AS ty ON ty.oid = d.typbasetype
				WHERE d.typtype = 'd'
			)
			SELECT a.attnum::int4 AS n, format_type(a.atttypid, NULL) AS resolved, format_type(c.t::regtype, NULL) AS claimed,
				EXISTS (SELECT 1 FROM admitted AS d WHERE d.n = c.n AND d.oid = a.atttypid) AS admitted
			FROM pg_catalog.pg_attribute AS a JOIN claim AS c ON c.n = a.attnum
			WHERE a.attrelid = ${quoted(view)}::regclass ORDER BY a.attnum`,
			[]
		)
		yield* session.query(`DROP VIEW ${view}`, [])
		const byPosition = new Map(Arr.map(result.rows, (row) => [Number(row["n"]), row]))
		return Arr.flatMap(heading, (c, i) => {
			const row = byPosition.get(i + 1)
			if (row === undefined) {
				return [`${where} column ${c.name}: no column of the view at ${i + 1}`]
			}
			return row["admitted"] === true
				? []
				: [
						`${where} column ${c.name}: PostgreSQL resolves ${String(row["resolved"])}, the IR states ${String(row["claimed"])}`
					]
		})
	})
