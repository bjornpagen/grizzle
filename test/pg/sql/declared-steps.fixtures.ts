/** What declared-steps.test.ts reads: its space of declarations over a session's temporary table, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect } from "effect"
import type { DeclaredDistinct, DeclareStatistics, Expr, PlFunction } from "#compiler/sql/ast.ts"
import { col, core, eq, qualifiedCall, types } from "#compiler/sql/build.ts"
import { declaredStatisticsSteps, printStatement } from "#compiler/sql/print.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

export type DeclaredStepsFeature = "a relative number restored" | "an absolute number restored"

/** The session's temporary table the case declares, and its definer function. */
const tableName = "declared_steps"

/** One to three columns, each declared relative or absolute, 2^0 to 2^6. */
export const declarationsGen: Gen<ReadonlyArray<DeclaredDistinct>> = array(
	(s): DeclaredDistinct => ({
		kind: s.draw(element(["relative", "absolute"] as const)),
		exponent: s.draw(int(0, 6))
	}),
	{ min: 1, max: 3 }
)

/** The name of the session's temporary schema, read where the steps run, as text: a restore reads no `name` argument. */
const temporarySchema: Expr = {
	kind: "subquery",
	query: {
		kind: "select",
		with: undefined,
		body: core(
			[{ expr: { kind: "cast", expr: col("n", "nspname"), type: types.text }, alias: undefined }],
			[{ kind: "table", table: { schema: "pg_catalog", name: "pg_namespace" }, alias: "n" }],
			eq(
				col("n", "oid"),
				qualifiedCall(
					{
						kind: "qualified",
						schema: "pg_catalog",
						name: "pg_my_temp_schema",
						volatility: "STABLE"
					},
					[]
				)
			)
		),
		orderBy: [],
		limit: undefined,
		offset: undefined
	}
}

/** A declared number of distinct values as PostgreSQL holds it, a float4. */
const valueOf = (d: DeclaredDistinct): number =>
	(d.kind === "relative" ? -1 : 1) * 2 ** (d.kind === "relative" ? -d.exponent : d.exponent)

/**
 * A case: a SECURITY DEFINER function of the session's own temporary schema makes a temporary table of one bigint column
 * a declaration and runs the declaration's steps over it (sql/print.ts declaredStatisticsSteps), its schema the session's
 * temporary one's name; then pg_stats holds exactly each column's declared number.
 */
export const runDeclared = (
	session: RawSession,
	declarations: ReadonlyArray<DeclaredDistinct>,
	note: (feature: DeclaredStepsFeature) => void
) =>
	Effect.gen(function* () {
		const columns = Arr.map(declarations, (distinct, at) => ({ column: `c${at}`, distinct }))
		const [first, ...rest] = columns
		if (first === undefined) {
			return assert.fail("a declaration of no column")
		}
		const declared: DeclareStatistics = {
			kind: "declareStatistics",
			table: { schema: "pg_temp", name: tableName },
			columns: [first, ...rest],
			dependencies: []
		}
		const definer: PlFunction = {
			kind: "createFunction",
			advice: undefined,
			language: "plpgsql",
			name: { schema: "pg_temp", name: `${tableName}_declared` },
			volatility: "VOLATILE",
			parallel: "UNSAFE",
			security: "DEFINER",
			returns: "void",
			params: [],
			body: {
				declare: [],
				body: [
					{
						kind: "createSessionTable",
						name: tableName,
						columns: Arr.map(columns, (c) => ({
							name: c.column,
							type: types.bigint,
							collation: undefined
						})),
						storage: "toasted"
					},
					...declaredStatisticsSteps(declared, temporarySchema)
				]
			}
		}
		yield* session.query(printStatement(definer), [])
		yield* session.query(`SELECT pg_temp.${tableName}_declared()`, [])
		const rows = yield* session.values(
			"SELECT s.attname::text, s.n_distinct::text FROM pg_catalog.pg_stats AS s " +
				"WHERE s.schemaname = (SELECT n.nspname FROM pg_catalog.pg_namespace AS n WHERE n.oid = pg_catalog.pg_my_temp_schema()) " +
				`AND s.tablename = '${tableName}' AND NOT s.inherited ORDER BY 1`,
			[]
		)
		for (const c of columns) {
			note(
				c.distinct.kind === "relative"
					? "a relative number restored"
					: "an absolute number restored"
			)
		}
		assert.deepEqual(
			Arr.map(rows, ([name, value]) => [String(name), Number(value)] as const),
			Arr.map(columns, (c) => [c.column, valueOf(c.distinct)] as const),
			"each column holds its declared number of distinct values"
		)
	})
