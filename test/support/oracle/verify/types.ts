import { Array as Arr, Data, Effect, Option, String as Str } from "effect"
import { indices } from "#compiler/core/array.ts"
import { fieldColumnType, type PhysicalNames } from "#compiler/ir/physical.ts"
import { contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import type { FusedStatement, StatementParts } from "#compiler/lower/shapes/index.ts"
import { statementOutput, type StatementRoots } from "#compiler/runtime/lower/tree.ts"
import type { TypeRef } from "#compiler/sql/ast.ts"
import { types } from "#compiler/sql/build.ts"
import { lex } from "#compiler/sql/lexer.ts"
import { printStatement, printType } from "#compiler/sql/print.ts"
import { elementAt } from "#test/support/oracle/pick.ts"
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
 * The type a delivered column of `t` is claimed as: the DDL's type of a column of it (fieldColumnType), or, for a text
 * refinement outside any contract whose domain the installation does not name, its base, text.
 */
const claimedType = (names: PhysicalNames, t: ScalarType): TypeRef =>
	contractOf(t) === undefined &&
	t.carrier === "text" &&
	t.text.regex !== "wildcard" &&
	names.textDomain(t.text.regex) === undefined
		? types.text
		: fieldColumnType(names, t).type

/**
 * A delivered statement the type oracle judges, and where its problems are located: the relation it delivers, its
 * role, heading and fused attachments, and the text PostgreSQL resolves its columns from.
 */
export interface Judged {
	readonly where: string
	readonly statement: Pick<FusedStatement, "role" | "heading" | "fused"> & {
		readonly sql: { readonly text: string }
	}
}

/**
 * The statements the type oracle judges of a program sent as one statement (shapes/index.ts PartedStatement), each
 * located at `where`: its one part as lowered; or each part of a statement of tagged parts as lowered (LoweredTaggedPart
 * `delivered`), a query of its own, before its executable form casts its columns to texts and the statement tags
 * them, judged against the relation the part delivers, the first of the program's delivered relations its rows are
 * (a relation another's part feeds has that relation's heading). A tagged part no relation reads is located without
 * one, and judged by no heading: the channel verification refuses it (verify/channels.ts partProblems).
 */
export const programJudged = (
	program: {
		readonly parts: StatementParts
		readonly roots: StatementRoots<
			Pick<FusedStatement, "role" | "heading" | "fused"> & {
				readonly answer: number
			}
		>
	},
	where: string
): ReadonlyArray<Judged> => {
	const parts = program.parts
	if (parts.kind === "one") {
		return [{ where, statement: parts.delivered }]
	}
	const relations = flight(program.roots)
	return Arr.flatMap(parts.parts, (part, tag) =>
		Arr.map(
			Option.toArray(Arr.findFirst(relations, (r) => r.answer === tag)),
			(relation): Judged => ({
				where: `${where} part ${tag}`,
				statement: { ...relation, sql: { text: printStatement(part.delivered) } }
			})
		)
	)
}

/**
 * PostgreSQL refused a probe statement: the view over the statement judged at `where`, or the one read of every view's
 * columns, located at "the probes' columns".
 */
class ProbeRefused extends Data.TaggedError("ProbeRefused")<{
	readonly where: string
	readonly sql: string
	readonly error: SqlError
}> {}

/** A judged statement that delivers a heading column, and the temporary view it is probed through. */
interface Probe {
	readonly judged: Judged
	readonly heading: ReadonlyArray<{ readonly name: string; readonly type: ScalarType }>
	readonly view: string
}

/**
 * The type oracle: PostgreSQL's resolved type of every column the lowered statements deliver, against the IR's.
 *
 * The IR states each delivered column's type (the statement's heading), and the lowering emits SQL whose types
 * PostgreSQL resolves on its own: a native function's result is its catalog type, a parameter is bound at its cast, a
 * literal at its base until cast, a CASE at the common type of its branches. Where the two disagree, a cast is missing
 * or wrong, and a value is decoded by a type it does not have. So PostgreSQL judges both sides at every column a
 * statement delivers:
 *
 * - each statement's text, every placeholder replaced by NULL (each placeholder carries its cast, so the cast still
 *   types it), becomes a temporary view, and pg_attribute states each output column's type, domains and enums
 *   included, read once for every view;
 * - the IR's type of the column is printed as the DDL types a column of it (ir/physical.ts fieldColumnType) and
 *   resolved by PostgreSQL's own ::regtype; a text refinement the installation names no domain for, a pattern no stored
 *   column carries (a literal's, or a closed read's query-local payload's), is typed by its base, text, as the lowering
 *   types it (lower/conservative/context.ts physicalTypeOf), since no column could be typed by it.
 *
 * An unrefined column must be exactly its type. A refined column (a contract's domain or a pattern's text domain) is
 * delivered as its domain, or as one of the types the domain is over, down to its base: the refined delivery leaves a
 * value whose membership it proved uncast (lower/conservative/refined.ts: min, max, LEAST, GREATEST and CASE deliver
 * one of their operands' values), and PostgreSQL types min over a domain by its base. The typmod is no part of the claim
 * for a query: a delivered column is decoded from its text. A fused attachment's array column is no heading column, and
 * its elements are judged by their decoding.
 *
 * The views and the read go in one flush (PgConnection pipeline), inside the caller's transaction, whose rollback drops
 * the views: the session's temporary views of one case are named type_probe_<k>, k the judged statement's position.
 *
 * Each heading column whose type PostgreSQL resolves otherwise than the IR states, as one line located at its
 * statement's `where`: none when every column agrees.
 */
export const typeProblems = (
	session: PgConnection,
	names: PhysicalNames,
	judged: ReadonlyArray<Judged>
): Effect.Effect<ReadonlyArray<string>, ProbeRefused> =>
	Effect.gen(function* () {
		const probes: ReadonlyArray<Probe> = Arr.flatMap(judged, (j, k) => {
			const heading = statementOutput(
				j.statement.role,
				j.statement.heading,
				j.statement.fused
			).heading
			return heading.length === 0 ? [] : [{ judged: j, heading, view: `type_probe_${k}` }]
		})
		if (!Arr.isReadonlyArrayNonEmpty(probes)) {
			return []
		}
		const views = Arr.map(probes, (p) => {
			const columns = [
				...Arr.map(indices(p.heading.length), (i) => `c${i + 1}`),
				...Arr.map(indices(p.judged.statement.fused.length), (j) => `f${j + 1}`)
			]
			return `CREATE TEMPORARY VIEW ${p.view} (${Arr.join(columns, ", ")}) AS ${withNullPlaceholders(p.judged.statement.sql.text)}`
		})
		const claimed = Arr.flatMap(probes, (p, v) =>
			Arr.map(
				p.heading,
				(c, i) => `(${v}, ${i + 1}, ${quoted(printType(claimedType(names, c.type)))})`
			)
		)
		const viewed = Arr.map(probes, (p, v) => `(${v}, ${quoted(`pg_temp.${p.view}`)}::regclass)`)
		/** Each claimed type with the types it is over, a domain's chain down to its base. */
		const read = `WITH RECURSIVE claim(v, n, t) AS (VALUES ${Arr.join(claimed, ", ")}),
			viewed(v, oid) AS (VALUES ${Arr.join(viewed, ", ")}),
			admitted(v, n, oid, typtype, typbasetype) AS (
				SELECT c.v, c.n, ty.oid, ty.typtype, ty.typbasetype
				FROM claim AS c JOIN pg_catalog.pg_type AS ty ON ty.oid = c.t::regtype
				UNION ALL
				SELECT d.v, d.n, ty.oid, ty.typtype, ty.typbasetype
				FROM admitted AS d JOIN pg_catalog.pg_type AS ty ON ty.oid = d.typbasetype
				WHERE d.typtype = 'd'
			)
			SELECT c.v, c.n, a.attnum IS NOT NULL AS found, format_type(a.atttypid, NULL) AS resolved,
				format_type(c.t::regtype, NULL) AS claimed,
				EXISTS (SELECT 1 FROM admitted AS d WHERE d.v = c.v AND d.n = c.n AND d.oid = a.atttypid) AS admitted
			FROM claim AS c JOIN viewed AS w ON w.v = c.v
			LEFT JOIN pg_catalog.pg_attribute AS a ON a.attrelid = w.oid AND a.attnum = c.n
			ORDER BY c.v, c.n`
		const statements = [...views, read]
		const answers = yield* session.pipeline(statements).pipe(
			Effect.mapError(
				(refused) =>
					new ProbeRefused({
						where:
							refused.index < probes.length
								? elementAt(probes, refused.index, "a probe").judged.where
								: "the probes' columns",
						sql: elementAt(statements, refused.index, "a probe statement"),
						error: refused.error
					})
			)
		)
		const rows = elementAt(answers, views.length, "the probes' columns").rows
		return Arr.flatMap(rows, (row) => {
			const probe = elementAt(probes, Number(row["v"]), "a probe")
			const n = Number(row["n"])
			const column = elementAt(probe.heading, n - 1, "a probed column")
			if (row["found"] !== true) {
				return [`${probe.judged.where} column ${column.name}: no column of the view at ${n}`]
			}
			return row["admitted"] === true
				? []
				: [
						`${probe.judged.where} column ${column.name}: PostgreSQL resolves ${String(row["resolved"])}, the IR states ${String(row["claimed"])}`
					]
		})
	})
