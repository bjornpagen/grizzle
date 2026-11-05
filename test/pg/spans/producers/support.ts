import { exact, multiset, ordered } from "@grizzle/testing/oracle"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { catchRefusal } from "#compiler/core/canonical.ts"
import { identity } from "#compiler/core/identity.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { Heading, RelNode, ValidDag } from "#compiler/ir/rel.ts"
import { LowerContext } from "#compiler/lower/conservative/context.ts"
import { dispatchNode } from "#compiler/lower/conservative/dispatch.ts"
import type { QueryTemplate } from "#compiler/program/compile.ts"
import type { Select } from "#compiler/sql/ast.ts"
import { cast, core, select, target, types } from "#compiler/sql/build.ts"
import { emit } from "#compiler/sql/emit.ts"
import { renameToPublicHeading } from "#compiler/sql/naming.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import {
	atName,
	localVectorSchema,
	parsedSchemaName,
	productionNames
} from "#test/support/kernel/naming.ts"
import {
	type RawRow,
	rowSet,
	type SpanCase,
	spanInsert,
	spanInstallStatements,
	spanQueryDesc,
	spanRelationNames,
	spanSchemaDesc
} from "#test/support/oracle/gen/spans.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/** The physical names of the span schema under the test's PostgreSQL schema (Left is "left"). */
export const spanNames = (schema: string): PhysicalNames =>
	productionNames("Spans", atName(schema), localVectorSchema)

/** A query compiled into its template, both artifacts, against the case's schema under `schema`. */
export const compileSpanQuery = (
	schemaDesc: SchemaDesc,
	query: QueryDesc,
	schema: string
): QueryTemplate =>
	succeeded(
		compileTemplate(query, schemaDesc, {
			...testCompile,
			installation: identity.schema(parsedSchemaName(schema))
		}),
		"the span query compiles"
	)

export const compileSpanCase = (c: SpanCase, schema: string): QueryTemplate =>
	compileSpanQuery(spanSchemaDesc(c.schema), spanQueryDesc(c), schema)

/** The one statement of an artifact, which a span producer query always is. */
export const onlySql = (
	template: QueryTemplate,
	artifact: "optimized" | "conservative"
): string => {
	const statements = template[artifact]
	if (statements.length !== 1) {
		throw new Error(`${artifact}: ${statements.length} statements, expected one`)
	}
	const [only] = statements
	if (only === undefined) {
		throw new Error(`${artifact}: no statement`)
	}
	return only.sql
}

/**
 * What the span producer suites share: compiling a span case's query into both artifacts, installing a case's
 * facts, running SQL as raw text rows, and lowering a hand-built DAG node to one audited statement.
 */
export const installSpanCase = (
	db: RawSession,
	schema: string,
	c: SpanCase
): Effect.Effect<void, SqlError> =>
	Effect.gen(function* () {
		for (const statement of spanInstallStatements(schema, c)) {
			yield* db.query(statement, [])
		}
		for (const name of spanRelationNames) {
			if (c.facts[name].length === 0) {
				continue
			}
			const insert = spanInsert(schema, c, name, c.facts[name])
			yield* db.query(insert.sql, insert.params)
		}
	})

/** The rows of a statement as raw text. */
export const rawRows = (
	db: RawSession,
	sql: string,
	params: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<RawRow>, SqlError> =>
	Effect.map(db.values(sql, params), (rows): ReadonlyArray<RawRow> =>
		Arr.map(rows, (row) => Arr.map(row, String))
	)

/** How many rows of a result repeat an earlier one. */
export const repeats = (rows: ReadonlyArray<RawRow>): number => rows.length - rowSet(rows).length

/** Two results as sets of rows, each row compared cell by cell. */
const sameRowSet = multiset(ordered(exact))

/** A comparison of a result with the expected set: undefined when equal as sets with no repeated row. */
export const sameSet = (
	label: string,
	expected: ReadonlyArray<RawRow>,
	actual: ReadonlyArray<RawRow>
): string | undefined => {
	const r = repeats(actual)
	if (r > 0) {
		return `${label}: ${r} repeated row(s) in ${Formatter.format(actual)}`
	}
	const difference = sameRowSet(rowSet(expected), rowSet(actual))
	return Option.isNone(difference)
		? undefined
		: `${label}: ${difference.value}\n  expected ${Formatter.format(rowSet(expected))}\n  actual   ${Formatter.format(rowSet(actual))}`
}

/**
 * One query over a hand-built DAG: `build` lowers what it needs through the context, and the result is delivered with
 * every column cast to text under the given public names, audited and printed (sql/emit.ts).
 */
export const emitWith = (
	dag: ValidDag,
	names: PhysicalNames,
	heading: Heading,
	origin: RelNode,
	build: (cx: LowerContext) => Select
): { readonly sql: string; readonly ast: Select } => {
	const cx = new LowerContext(
		dag,
		{
			names,
			params: [],
			subject: { kind: "query" }
		},
		dispatchNode
	)
	const built = catchRefusal(() => build(cx))
	if (!built.ok) {
		throw new Error(`lower: ${built.error.message}`)
	}
	const query = built.value
	const source = cx.wrap(query, heading, { kind: "node", node: origin.id })
	const delivered = select(
		core(
			Arr.map(heading, (c) => {
				const column = source.map.get(c.name)
				if (column === undefined) {
					throw new Error(`the lowered source has no column ${c.name}`)
				}
				return target(cast(column, types.text))
			}),
			[source.item],
			undefined
		)
	)
	const renamed = renameToPublicHeading(
		delivered,
		Arr.map(heading, (c) => c.name)
	)
	if (!renamed.ok) {
		throw new Error(renamed.error.message)
	}
	const emitted = emit(renamed.value, cx.supply.map())
	if (!emitted.ok) {
		throw new Error(`emit: ${emitted.error.message}`)
	}
	return { sql: emitted.value.text, ast: renamed.value }
}
