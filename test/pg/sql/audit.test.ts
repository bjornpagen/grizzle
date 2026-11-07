import { layer } from "@effect/vitest"
import { explore, drawn, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { maxOf } from "#compiler/core/array.ts"
import type { CreateTable, SqlStatement } from "#compiler/sql/ast.ts"
import { builtinType, cUtf8Collation } from "#compiler/sql/build.ts"
import { lex } from "#compiler/sql/lexer.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { assert, defined } from "#test/support/assert.ts"
import { type ShapeFeature, shapeFeatures, shapeOf } from "#test/support/kernel/shape.ts"
import {
	breaks,
	oneHole,
	resolveStatement,
	type SqlCatalog,
	type SqlColumnType,
	statementGen
} from "#test/support/kernel/sqlgen.ts"
import { caseHang } from "#test/support/limits.ts"
import { auditStatementViolations } from "#test/support/oracle/verify/sql.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"
import { sqlCatalog } from "#test/unit/sql/audit/catalog.ts"
import {
	lateralRewrite,
	mirroredBreaks,
	type StatementBreakName
} from "#test/unit/sql/audit/operators.ts"

/**
 * PostgreSQL as the second oracle of the SQL generator and of the structural audit (test/support/oracle/verify/sql.ts).
 *
 * Every statement the kernel's generator draws (sqlgen.ts statementGen) passes both audits by construction; here
 * PostgreSQL 19 plans it too, with EXPLAIN (GENERIC_PLAN), over the generator's catalog installed from the same AST
 * (a table's first column its key). A statement the audit admits and PostgreSQL refuses is a bug in the generator, the
 * printer or the audit.
 *
 * The audit rules that mirror PostgreSQL's own (scope, the visibility of ON, LATERAL, a write's target and a MERGE
 * WHEN, a data-modifying CTE's placement, clauses merged across a parenthesized body, a set operation's widths) are
 * checked from the other side: each Wild operator of such a rule (test/unit/sql/audit/operators.ts), at a drawn site,
 * is refused by PostgreSQL as well, with a SQLSTATE of the expected class; and the faithful rewrite that makes a
 * derived table LATERAL is planned. The lists SQL requires to be nonempty are NonEmpty by type (sql/ast.ts), and the
 * zero-width forms PostgreSQL spells by absence, which the generator draws, are each required to plan here.
 *
 * What a case reaches: each statement kind it plans, each Wild operator of a mirrored rule PostgreSQL refuses, the
 * LATERAL rewrite planned, each zero-width form planned, and the shape of every statement it plans.
 */
type AuditFeature =
	| `statement ${SqlStatement["kind"]}`
	| "lateral planned"
	| `refused ${StatementBreakName}`
	| ShapeFeature

const situations: Arr.NonEmptyReadonlyArray<AuditFeature> = [
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

const explain = (statement: SqlStatement): string =>
	`EXPLAIN (GENERIC_PLAN, COSTS OFF) ${printStatement(statement)}`

/**
 * A NULL for each placeholder up to the highest a text uses: the test's sessions speak the extended protocol, whose Bind
 * carries that many values, and GENERIC_PLAN plans the statement without reading them.
 */
const nulls = (text: string): ReadonlyArray<null> => {
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

const cases = 150

/** A case: a generated statement, and a drawn site per mirrored break, then one for the LATERAL rewrite. */
interface AuditCase {
	readonly statement: SqlStatement
	readonly sites: ReadonlyArray<number>
}

/** The sites a case draws: a pick per mirrored break, then one for the LATERAL rewrite. */
const siteCount = mirroredBreaks.length + 1

/** A statement over the catalog and its sites. */
const auditCaseGen =
	(catalog: SqlCatalog): Gen<AuditCase> =>
	(source) => ({
		statement: source.draw(statementGen(catalog)),
		sites: source.draw(array(pickGen, { min: siteCount, max: siteCount }))
	})

/**
 * The kept cases over the catalog, each statement a planted sketch replayed against the generator: its swarm and the
 * decisions the generator takes after it.
 */
const keptOver = (catalog: SqlCatalog): ReadonlyArray<Kept<AuditCase, AuditFeature>> => [
	{
		note: "a LATERAL derived table's count(*) FILTER read only the outer relation's column, which makes PostgreSQL place the aggregate in the outer query, whose FROM may not hold it (42803)",
		sketch: {
			statement: resolveStatement(catalog, {
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
		},
		draws: "",
		reaches: ["statement select", "lateral", "count(*)"]
	}
]

layer(Substrate.layer)("generated SQL on PostgreSQL 19", (it) => {
	it.effect(
		`plans every generated statement, and refuses every break of a rule that mirrors its own (${cases} cases)`,
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema(freshSchema)
					const catalog = catalogIn(schema)
					for (const statement of installation(catalog)) {
						assert.deepEqual(auditStatementViolations(statement), [])
						yield* s.admin.query(printStatement(statement), [])
					}
					/**
					 * Runs a statement's EXPLAIN: the SQLSTATE PostgreSQL refuses it with, or undefined when it plans it.
					 */
					const plan = (statement: SqlStatement) => {
						const text = explain(statement)
						return Effect.matchEffect(s.admin.query(text, nulls(text)), {
							onSuccess: () => Effect.void,
							onFailure: (error) => {
								const fields = pgErrorFields(error)
								return fields === undefined ? Effect.fail(error) : Effect.succeed(fields)
							}
						})
					}
					return yield* explore(
						{
							oracle: { kind: "unstated" },
							suite: "pg/sql/generated",
							draw: drawn(auditCaseGen(catalog)),
							literal: Formatter.format,
							coverage: required<AuditFeature>(situations, { cases: cases, sense: notesOnly }),
							kept: keptOver(catalog),
							runs: cases,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ statement, sites }, c) =>
							Effect.gen(function* () {
								const refused = yield* plan(statement)
								if (refused !== undefined) {
									assert.fail(
										`PostgreSQL refused a generated statement with ${refused.code}: ${refused.message}\n${printStatement(statement)}`
									)
								}
								const shape = shapeOf(statement)
								c.note(`statement ${shape.statement}`)
								c.noteAll(shapeFeatures(shape))
								for (const [i, { operator, sqlstateClass }] of mirroredBreaks.entries()) {
									const [first, ...rest] = breaks(statement, operator)
									if (first === undefined) {
										continue
									}
									const broken = pickFrom(
										[first, ...rest],
										defined(sites[i], "a drawn site")
									).statement
									const fields = yield* plan(broken)
									if (fields === undefined || !Str.startsWith(sqlstateClass)(fields.code)) {
										assert.fail(
											`${operator.name}: PostgreSQL ${fields === undefined ? "planned it" : `refused it with ${fields.code}: ${fields.message}`}, not with class ${sqlstateClass}\n${printStatement(broken)}`
										)
									}
									c.note(`refused ${operator.name}`)
								}
								const [first, ...rest] = oneHole(statement, lateralRewrite.holes)
								if (first !== undefined) {
									const site = defined(
										sites[mirroredBreaks.length],
										"the LATERAL rewrite's drawn site"
									)
									const admitted = pickFrom([first, ...rest], site).statement
									const fields = yield* plan(admitted)
									if (fields !== undefined) {
										assert.fail(
											`PostgreSQL refused a LATERAL rewrite with ${fields.code}: ${fields.message}\n${printStatement(admitted)}`
										)
									}
									c.note("lateral planned")
								}
							})
					)
				})
			)
	)
})
