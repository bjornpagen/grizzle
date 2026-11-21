/** What the property of audit.test.ts reads: the catalog's template, the cases and their aims, and a plan's text. */

import { maxOf } from "@bjornpagen/grizzle-text/base/array"

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array, constant, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import type { CreateTable, SqlStatement } from "#compiler/sql/ast.ts"
import { builtinType, cUtf8Collation } from "#compiler/sql/build.ts"
import { lex } from "#compiler/sql/lexer.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { templateNeedBudget } from "#test/support/budgets.ts"
import { type ShapeFeature } from "#test/support/kernel/shape.ts"
import {
	resolveStatement,
	type SqlCatalog,
	type SqlColumnType,
	statementGen
} from "#test/support/kernel/sqlgen.ts"
import { auditStatementViolations } from "#test/support/oracle/verify/sql.ts"
import { pickGen } from "#test/support/pick.ts"
import { noTables } from "#test/support/substrate/replace.ts"
import { installTemplate, Substrate } from "#test/support/substrate/substrate.ts"
import { sqlCatalog } from "#test/unit/sql/audit/catalog.ts"
import { mirroredBreaks, type StatementBreakName } from "#test/unit/sql/audit/operators.ts"

export type AuditFeature =
	| `statement ${SqlStatement["kind"]}`
	| "lateral planned"
	| `refused ${StatementBreakName}`
	| ShapeFeature

export const situations: Arr.NonEmptyReadonlyArray<AuditFeature> = [
	"statement select",
	"statement insert",
	"statement update",
	"statement delete",
	"statement merge",
	"lateral planned",
	"derived of no column",
	"function of no column",
	"arrays of no column",
	"cte of no column",
	"core of no target",
	"insert of no column",
	...Arr.map(mirroredBreaks, (b) => `refused ${b.operator.name}` as const)
]

const columnTypes: { readonly [T in SqlColumnType]: CreateTable["columns"][number]["type"] } = {
	bigint: builtinType("bigint"),
	integer: builtinType("integer"),
	text: builtinType("text"),
	boolean: builtinType("boolean"),
	numeric: builtinType("numeric")
}

/** The generator's catalog, moved into the test's own schema. */
const catalogIn = (schema: string): SqlCatalog => {
	const [first, ...rest] = sqlCatalog
	const moved = (t: (typeof sqlCatalog)[number]) => ({ ...t, schema })
	return [moved(first), ...Arr.map(rest, moved)]
}

/** The catalog's tables, every column NOT NULL, text under the fixed collation, the first column the key. */
const installation = (catalog: SqlCatalog): ReadonlyArray<SqlStatement> =>
	Arr.map(catalog, (t): SqlStatement => ({
		kind: "createTable",
		table: { schema: t.schema, name: t.name },
		columns: Arr.map(t.columns, (c) => ({
			name: c.name,
			type: columnTypes[c.type],
			collation: c.type === "text" ? cUtf8Collation : undefined,
			generated: undefined
		})),
		primaryKey: {
			kind: "primaryKey",
			name: `${t.name}_key`,
			columns: [{ column: t.columns[0].name, withoutOverlaps: false }]
		},
		secondary: []
	}))

export const explainText = (statement: SqlStatement): string =>
	`EXPLAIN (GENERIC_PLAN, COSTS OFF) ${printStatement(statement)}`

/**
 * A NULL for each placeholder up to the highest a text uses: the test's sessions speak the extended protocol, whose Bind
 * carries that many values, and GENERIC_PLAN plans the statement without reading them.
 */
export const nulls = (text: string): ReadonlyArray<null> => {
	const lexed = lex(text)
	if (lexed.error !== undefined) {
		throw new Error(
			`the lexer refuses a printed statement at ${lexed.error.offset}: ${lexed.error.message}\n${text}`
		)
	}
	const highest = maxOf(
		Arr.flatMap(lexed.tokens, (t) => (t.kind === "param" ? [t.index] : [])),
		0
	)
	return Array.from({ length: highest }, () => null)
}

export const cases = 150

/** A case: a generated statement, and a drawn site per mirrored break, then one for the LATERAL rewrite. */
interface AuditCase {
	readonly statement: SqlStatement
	readonly sites: ReadonlyArray<number>
}

/** The sites a case draws: a pick per mirrored break, then one for the LATERAL rewrite. */
const siteCount = mirroredBreaks.length + 1

/** A statement over the catalog and its sites. */
export const auditCaseGen =
	(catalog: SqlCatalog): Gen<AuditCase> =>
	(source) => ({
		statement: source.draw(statementGen(catalog)),
		sites: source.draw(array(pickGen, { min: siteCount, max: siteCount }))
	})

/** The schema the audit's catalog lives in, inside the template's database, which every clone copies. */
const auditSchema = "sql_audit"

/** The generator's catalog, in the audit's schema. */
export const auditCatalog = catalogIn(auditSchema)

/**
 * The catalog installed from the same AST once per member (substrate.ts installTemplate), in a schema of its own inside
 * the template's database, where the search installed it in a fresh schema before its cases; each statement is only
 * planned, so nothing is emptied after a case.
 */
export const auditTemplate = installTemplate({
	budget: templateNeedBudget,
	declaredIn: import.meta,
	name: "sql audit catalog",
	content: { schema: auditSchema },
	plan: () => Effect.void,
	install: () =>
		Effect.gen(function* () {
			const s = yield* Substrate
			yield* s.admin.query(`CREATE SCHEMA ${quoteIdent(auditSchema)}`, [])
			for (const statement of installation(auditCatalog)) {
				assert.deepEqual(auditStatementViolations(statement), [])
				yield* s.admin.query(printStatement(statement), [])
			}
		}),
	bind: () => undefined,
	reset: () => noTables
})

/**
 * The case the search kept, a LATERAL derived table's count(*) FILTER reading only the outer relation's column, which
 * makes PostgreSQL place the aggregate in the outer query, whose FROM may not hold it (42803): its statement replayed
 * against the generator, its swarm and the decisions the generator takes after it, no red in git log -S on the module
 * (65203c443 kept it), aimed at the one required situation it reaches.
 */
export const lateralCountAims: ReadonlyArray<readonly [Reached<AuditFeature>, Gen<AuditCase>]> = [
	[
		"statement select",
		constant<AuditCase>({
			statement: resolveStatement(auditCatalog, {
				swarm: {
					lateral: 1,
					values: 1,
					cte: 3,
					materialized: 1,
					where: 2,
					"group by": 1,
					aggregate: 2,
					"count filter": 2,
					"distinct on": 3,
					arithmetic: 1
				},
				tape: [
					0, 1, 0, 0, 0, 0, 2, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
					0, 1, 2, 0, 0, 0, 2, 1
				]
			}),
			sites: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6164]
		})
	]
]
