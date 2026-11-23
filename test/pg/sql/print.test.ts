/**
 * The printed SQL on PostgreSQL 19 (packages/engine/src/sql): the text means what the AST says. Every statement this
 * file sends is one the audit accepts, the printer's output, never hand-edited.
 *
 * - Catalog reads: a catalog read of drawn arms is the set union of their rows, a row two arms share once.
 * - Relational: generated CROSS JOINs, IN and NOT IN over a subquery, and windows over drawn ROWS frames evaluate as
 *   the host computes them (test/pg/sql/evaluated.ts).
 * - Default privileges: a reset of PUBLIC's default privilege, in one schema and in the global form, of each kind
 *   PostgreSQL grants PUBLIC by default, leaves PUBLIC its privilege on a new function or type under the schema's form
 *   and takes it under the global one.
 * - Expressions: generated expressions of bigint, boolean and text evaluate as the host evaluates them, so the
 *   printer's parentheses are PostgreSQL's precedence.
 * - Set trees: generated set-operation trees, arms and whole levels parenthesized with their own ORDER BY and LIMIT,
 *   evaluate as SQL's set semantics say.
 * - Aggregates: generated aggregates keep their DISTINCT, their own ORDER BY and count(*)'s FILTER, group by group.
 * - RAISE: a generated RAISE, with any subset of its USING options, raises its SQLSTATE, message and DETAIL.
 * - Literals: every drawn typed literal arrives exactly: text of every plane, a text domain's, numerics as spelled
 *   (negative zero as zero), doubles and reals bit for bit, booleans, int4 ranges, and integers of every type at any
 *   value, its bounds among them, each of the type it is printed as.
 *
 * Oracle: the host's evaluation (evaluated.ts) for expressions, relational reads, set trees and aggregates; SQL's
 * specification of a catalog read, a RAISE and a literal; PostgreSQL itself for the default privileges.
 *
 * Features: the relational reads' joins, subqueries and frames; the expressions' types and a collated BETWEEN bound;
 * the catalog read's shared and apart arms; each privilege outcome; and a literal at an integer type's bound.
 */

import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array, element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order, String as Str } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import type { RaiseOption } from "#compiler/sql/ast.ts"
import {
	cast,
	cUtf8Collation,
	lit,
	namedType,
	objectName,
	provedSelect,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import * as C from "#compiler/sql/catalog.ts"
import { emitCatalog } from "#compiler/sql/emit.ts"
import { printExpr } from "#compiler/sql/print.ts"
import {
	aggregateCaseGen,
	type Evaluated,
	evaluatedGen,
	type RelationalFeature,
	relationalSketchGen,
	resolveRelational,
	setCaseGen
} from "#test/pg/sql/evaluated.ts"
import {
	booleanFunction,
	catalogArmsGen,
	commands,
	decimalSpelled,
	literalsGen,
	type PrivilegeFeature,
	publicDefaults,
	raiseGen,
	resetScopes,
	run,
	sql,
	textLit,
	textOf,
	zero
} from "#test/pg/sql/print.fixtures.ts"
import { testTypeSchema } from "#test/support/sql.ts"
import { expectSqlstate } from "#test/support/substrate/expect.ts"
import {
	freshSchema,
	roleSession,
	Substrate,
	baseSubstrate
} from "#test/support/substrate/substrate.ts"

/**
 * Printed SQL on PostgreSQL 19 reads a catalog read of several arms as the set union of their rows, a row two arms share once.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/sql/print.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/sql/print.test.ts` at its budget before, `{
 *   runs: 60, steered: 60 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the red's
 *   headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path in
 *   run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const printedSQLOnPostgreSQL19ReadsACatalogReadOfSeveralArmsAsTheSetUnionOfTheirRowsARowTwoArmsShareOnce =
	property.explore(catalogArmsGen, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: ["a row two arms share", "arms apart"] satisfies ReadonlyArray<
			Reached<"a row two arms share" | "arms apart">
		>,
		budget: { runs: 1, steered: 60 },
		check:
			({ tx }, c: Case<"a row two arms share" | "arms apart">) =>
			(texts) =>
				Effect.gen(function* () {
					const { connection: admin } = yield* tx

					const read = C.union(
						nonEmpty(
							Arr.map(texts, (text) => C.catalogCore([C.text(text)], [], undefined)),
							"a read's arms"
						)
					)
					const rows = yield* admin.queryValues(emitCatalog(read), [])
					assert.deepEqual(
						Arr.sort(
							Arr.map(rows, (row) => String(row[0])),
							Order.String
						),
						Arr.sort(Arr.dedupe(texts), Order.String),
						"the read's rows, each once"
					)
					c.note(Arr.dedupe(texts).length < texts.length ? "a row two arms share" : "arms apart")
				}),
		oracle: {
			kind: "specification",
			name: "a catalog read is a set (sql/catalog.ts CatalogSelect)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: `\treturn \`\${ctes}\${arms.join(" UNION ")}\``,
				replacement: `\treturn \`\${ctes}\${arms.join(" UNION ALL ")}\``,
				why: "A catalog read's arms are joined by UNION ALL; the catalog reads property fails."
			}
		]
	})

/**
 * Printed SQL on PostgreSQL 19 evaluates generated CROSS JOINs, IN and NOT IN over a subquery, and windows over drawn ROWS frames as the host does.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/sql/print.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/sql/print.test.ts` at its budget before, `{
 *   runs: 120, steered: 120 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the
 *   red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path
 *   in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const printedSQLOnPostgreSQL19EvaluatesGeneratedCROSSJOINsINAndNOTINOverASubqueryAndWindowsOverDrawnROWSFramesAsTheHostDoes =
	property.explore(relationalSketchGen, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [
			"cross join",
			"in",
			"not in",
			"empty subquery",
			"frame unboundedPreceding to currentRow",
			"frame currentRow to unboundedFollowing",
			"frame offset to offset",
			"partitioned window",
			"descending window",
			"empty frame"
		] satisfies ReadonlyArray<Reached<RelationalFeature>>,
		budget: { runs: 1, steered: 120 },
		check:
			({ tx }, notes: Case<RelationalFeature>) =>
			(sketch) =>
				Effect.gen(function* () {
					const { connection: admin } = yield* tx
					const resolved = resolveRelational(sketch)
					const c = resolved

					const text = sql(c.statement)
					const rows = yield* admin.queryValues(text, [])
					const got: ReadonlyArray<ReadonlyArray<string | null>> = Arr.map(rows, (row) =>
						Arr.map(row, (cell) =>
							cell === null ? null : typeof cell === "string" ? cell : Formatter.format(cell)
						)
					)
					assert.deepEqual(got, c.rows, text)
					notes.noteAll(c.reached)
				}),
		oracle: {
			kind: "second-implementation",
			name: "the host's evaluation of the relational read (evaluated.ts)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: `\t\t\t\`ROWS BETWEEN \${printFrameBound(spec.frame.start)} AND \${printFrameBound(spec.frame.end)}\``,
				replacement: `\t\t\t\`RANGE BETWEEN \${printFrameBound(spec.frame.start)} AND \${printFrameBound(spec.frame.end)}\``,
				why: "A window frame is printed as RANGE; the relational property fails."
			}
		]
	})

/** Printed SQL on PostgreSQL 19 resets PUBLIC's defaults on functions and types only in the global form. */
export const printedSQLOnPostgreSQL19ResetsPUBLICsDefaultsOnFunctionsAndTypesOnlyInTheGlobalForm =
	property.exhaust(
		finite(
			(source) => [source.draw(element(resetScopes)), source.draw(element(publicDefaults))] as const
		),
		{
			needs: { substrate: Substrate.fresh(baseSubstrate) },
			situations: [
				"PUBLIC kept by a schema's reset",
				"PUBLIC revoked by the global reset"
			] satisfies ReadonlyArray<Reached<PrivilegeFeature>>,
			check:
				({ substrate }, c: Case<PrivilegeFeature>) =>
				([scope, on]) =>
					Effect.provideServiceEffect(
						Effect.gen(function* () {
							const s = yield* Substrate
							const schema = yield* s.schema(freshSchema)
							const q = quoteIdent(schema)
							return yield* Effect.scoped(
								Effect.gen(function* () {
									/** A role, a function and a type of each case's own, named by its case, so no case meets another's defaults. */
									const own = `${scope}_${Str.toLowerCase(on)}`
									const maker = yield* s.role(schema, `maker_${own}`)
									yield* s.admin.query(
										`GRANT USAGE, CREATE ON SCHEMA ${q} TO ${quoteIdent(maker.role)}`,
										[]
									)
									const m = yield* s.session({ ...roleSession(maker) })
									for (const command of commands({
										kind: "alterDefaultPrivileges",
										inSchema: scope === "schema" ? schema : undefined,
										privileges: ["ALL"],
										on,
										from: [{ kind: "PUBLIC" }]
									})) {
										yield* m.query(command, [])
									}
									const created = `__made_${own}`
									yield* m.query(
										sql(
											on === "FUNCTIONS"
												? booleanFunction(schema, created, [
														{ kind: "return", value: lit.bool(true) }
													])
												: {
														kind: "createDomain",
														name: objectName(schema, created),
														base: types.smallint,
														collation: undefined,
														constraints: []
													}
										),
										[]
									)
									const held = yield* s.admin.queryValues(
										on === "FUNCTIONS"
											? "SELECT has_function_privilege('public'::name, $1::text, 'EXECUTE'::text)"
											: "SELECT has_type_privilege('public'::name, $1::text, 'USAGE'::text)",
										[
											on === "FUNCTIONS"
												? `${q}.${quoteIdent(created)}()`
												: `${q}.${quoteIdent(created)}`
										]
									)
									assert.deepEqual(held, [[scope === "schema"]], `${scope} reset of ${on}`)
									c.note(
										scope === "schema"
											? "PUBLIC kept by a schema's reset"
											: "PUBLIC revoked by the global reset"
									)
								})
							)
						}),
						Substrate,
						Effect.map(substrate, (taken) => taken.substrate)
					),
			oracle: {
				kind: "postgresql",
				name: "PUBLIC's privilege on an object the role creates after the reset"
			},
			box: "a reset in one schema and in the global form, of each kind PostgreSQL grants PUBLIC by default",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/sql/print.ts",
					original: `\t\t\t\t\`ALTER DEFAULT PRIVILEGES\${statement.inSchema === undefined ? "" : \` IN SCHEMA \${quoteIdent(statement.inSchema)}\`} REVOKE \${statement.privileges.join(", ")} ON \${statement.on} FROM \${statement.from.map(printGrantee).join(", ")}\``,
					replacement: `\t\t\t\t\`ALTER DEFAULT PRIVILEGES REVOKE \${statement.privileges.join(", ")} ON \${statement.on} FROM \${statement.from.map(printGrantee).join(", ")}\``,
					why: "IN SCHEMA is dropped from a reset; the default privileges property fails."
				}
			]
		}
	)

/**
 * Printed SQL on PostgreSQL 19 evaluates generated expressions as the host does, so the printer's parentheses are PostgreSQL's.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/sql/print.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/sql/print.test.ts` at its budget before, `{
 *   runs: 60, steered: 60 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the red's
 *   headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path in
 *   run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const printedSQLOnPostgreSQL19EvaluatesGeneratedExpressionsAsTheHostDoesSoThePrintersParenthesesArePostgreSQLs =
	property.explore(array(evaluatedGen, { min: 1, max: 40 }), {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: ["int", "bool", "text", "collated between bound"] satisfies ReadonlyArray<
			Reached<Evaluated["type"] | "collated between bound">
		>,
		budget: { runs: 1, steered: 60 },
		check:
			({ tx }, c: Case<Evaluated["type"] | "collated between bound">) =>
			(cases) =>
				Effect.gen(function* () {
					const { connection: admin } = yield* tx

					const [row] = yield* admin.queryValues(
						`SELECT ${Arr.join(
							Arr.map(cases, (entry) => printExpr(entry.item.expr)),
							", "
						)}`,
						[]
					)
					const cells = defined(row, "the SELECT's one row")
					for (const [i, entry] of cases.entries()) {
						const item = entry.item
						const got = cells[i]
						const expected = item.type === "int" ? item.value.toString() : item.value
						assert.deepEqual(
							{ expr: printExpr(item.expr), value: item.type === "int" ? String(got) : got },
							{ expr: printExpr(item.expr), value: expected }
						)
						c.note(item.type)
						c.noteAll(entry.reached)
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "the host's evaluation of each expression (evaluated.ts)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: "\t\t\tconst right = wrapTighter(expr(e.right), self)",
				replacement: "\t\t\tconst right = wrap(expr(e.right), self)",
				why: "A right operand of equal precedence is printed bare; the expressions property fails."
			}
		]
	})

/**
 * Printed SQL on PostgreSQL 19 evaluates generated set-operation trees as SQL's set semantics do, levels nested and parenthesized.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/sql/print.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/sql/print.test.ts` at its budget before, `{
 *   runs: 180, steered: 0 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the red's
 *   headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path in
 *   run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on case 2 of its floor stream
 * @decision the least runs whose floor stream, a quarter of them rounded up, holds its first 3 cases: 9; no headroom: a
 *   kill its witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const printedSQLOnPostgreSQL19EvaluatesGeneratedSetOperationTreesAsSQLsSetSemanticsDoLevelsNestedAndParenthesized =
	property.explore(setCaseGen, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [],
		budget: { runs: 9, steered: 0 },
		check:
			({ tx }) =>
			(c) =>
				Effect.gen(function* () {
					const { connection: admin } = yield* tx

					const text = sql(c.statement)
					const rows = yield* admin.queryValues(text, [])
					const got: ReadonlyArray<number> = Arr.sort(
						Arr.map(rows, (row) => Number(row[0])),
						Order.Number
					)
					assert.deepEqual(got, c.rows, text)
				}),
		oracle: {
			kind: "second-implementation",
			name: "SQL's set semantics over the tree's arms (evaluated.ts)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: `\t\`(\${printSelectInline(select, reader)})\``,
				replacement: "\tprintSelectInline(select, reader)",
				why: "A nested set-operation level is printed without its parentheses; the set trees property fails."
			}
		]
	})

/**
 * Printed SQL on PostgreSQL 19 evaluates generated aggregates with DISTINCT, their own ORDER BY and FILTER, group by group.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/sql/print.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/sql/print.test.ts` at its budget before, `{
 *   runs: 120, steered: 0 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the red's
 *   headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path in
 *   run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on case 4 of its floor stream
 * @decision the least runs whose floor stream, a quarter of them rounded up, holds its first 5 cases: 17; no headroom:
 *   a kill its witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const printedSQLOnPostgreSQL19EvaluatesGeneratedAggregatesWithDISTINCTTheirOwnORDERBYAndFILTERGroupByGroup =
	property.explore(aggregateCaseGen, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [],
		budget: { runs: 17, steered: 0 },
		check:
			({ tx }) =>
			(c) =>
				Effect.gen(function* () {
					const { connection: admin } = yield* tx

					const text = sql(c.statement)
					const rows = yield* admin.queryValues(text, [])
					const got: ReadonlyArray<ReadonlyArray<string>> = Arr.map(rows, (row) =>
						Arr.map(row, String)
					)
					assert.deepEqual(got, c.rows, text)
				}),
		oracle: {
			kind: "second-implementation",
			name: "the host's aggregation group by group (evaluated.ts)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: `\t\treturn call.filter === undefined\n\t\t\t? \`\${inCatalog("count")}(*)\`\n\t\t\t: \`\${inCatalog("count")}(*) FILTER (WHERE \${printExpr(call.filter)})\``,
				replacement: `\t\treturn \`\${inCatalog("count")}(*)\``,
				why: "count(*)'s FILTER is dropped; the aggregates property fails."
			}
		]
	})

/**
 * Printed SQL on PostgreSQL 19 raises every generated RAISE with the SQLSTATE, message and DETAIL its USING options give.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/sql/print.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/sql/print.test.ts` at its budget before, `{
 *   runs: 24, steered: 0 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the red's
 *   headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path in
 *   run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const printedSQLOnPostgreSQL19RaisesEveryGeneratedRAISEWithTheSQLSTATEMessageAndDETAILItsUSINGOptionsGive =
	property.explore(raiseGen, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [],
		budget: { runs: 1, steered: 0 },
		check:
			({ tx }) =>
			({ message, code, detail, hint }) =>
				Effect.gen(function* () {
					const { connection: admin, schema: allocate } = yield* tx
					const schema = yield* allocate("print")
					yield* admin.query(`CREATE SCHEMA ${quoteIdent(schema)}`, [])
					let made = 0

					const using: ReadonlyArray<RaiseOption> = [
						...(code === undefined ? [] : [{ option: "ERRCODE" as const, value: textLit(code) }]),
						...(detail === undefined
							? []
							: [{ option: "DETAIL" as const, value: textLit(detail) }]),
						...(hint === undefined ? [] : [{ option: "HINT" as const, value: textLit(hint) }])
					]
					made++
					const name = `__raise_${made}`
					yield* run(admin, [
						booleanFunction(schema, name, [
							{ kind: "raise", message, using },
							{ kind: "return", value: lit.bool(true) }
						])
					])
					const invoke = provedSelect(
						"oneRow",
						[
							targetAs(
								{
									kind: "call",
									fn: { kind: "qualified", schema, name },
									args: [],
									star: false,
									distinct: false,
									orderBy: [],
									withinGroup: [],
									over: undefined
								},
								"c1"
							)
						],
						[],
						undefined
					)
					const raised = yield* expectSqlstate(admin.query(sql(invoke), []), code ?? "P0001")
					assert.equal(raised.message, message)
					assert.deepEqual(raised.detail, Option.fromUndefinedOr(detail))
				}),
		oracle: {
			kind: "specification",
			name: "RAISE ... USING: the SQLSTATE of ERRCODE or P0001, the message and DETAIL given"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: `\tconst head = \`RAISE EXCEPTION \${quoteString(statement.message)}\``,
				replacement: `\tstatement = { ...statement, using: statement.using.filter((o) => o.option !== "DETAIL") }\n\tconst head = \`RAISE EXCEPTION \${quoteString(statement.message)}\``,
				why: "A RAISE's DETAIL is dropped; the RAISE property fails."
			}
		]
	})

/**
 * Printed SQL on PostgreSQL 19 delivers every typed literal exactly.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/sql/print.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/sql/print.test.ts` at its budget before, `{
 *   runs: 60, steered: 60 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the red's
 *   headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path in
 *   run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const printedSQLOnPostgreSQL19DeliversEveryTypedLiteralExactly = property.explore(
	literalsGen,
	{
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: ["an integer type's bound"] satisfies ReadonlyArray<
			Reached<"an integer type's bound">
		>,
		budget: { runs: 1, steered: 60 },
		check:
			({ tx }, c: Case<"an integer type's bound">) =>
			(sample) =>
				Effect.gen(function* () {
					const { connection: admin, schema: allocate } = yield* tx
					const schema = yield* allocate("print")
					yield* admin.query(`CREATE SCHEMA ${quoteIdent(schema)}`, [])
					yield* run(admin, [
						{
							kind: "createDomain",
							name: { schema, name: "label" },
							base: types.text,
							collation: cUtf8Collation,
							constraints: []
						}
					])
					const label = namedType(testTypeSchema(schema), "label", [])
					const values = (exprs: ReadonlyArray<string>) =>
						Effect.map(
							admin.queryValues(`SELECT ${Arr.join(exprs, ", ")}`, []),
							([row]): ReadonlyArray<string> =>
								Arr.map(defined(row, "the SELECT's one row"), String)
						)

					const texts = yield* values(
						Arr.map(sample.texts, (x) => printExpr(lit.text(x, types.text)))
					)
					assert.deepEqual(texts, sample.texts)
					const labels = yield* values(Arr.map(sample.labels, (l) => textOf(lit.text(l, label))))
					assert.deepEqual(labels, sample.labels)
					const decimals = yield* values(Arr.map(sample.decimals, (d) => textOf(decimalSpelled(d))))
					assert.deepEqual(
						decimals,
						Arr.map(sample.decimals, (d) =>
							zero(d) && Str.startsWith("-")(d) ? Str.slice(1)(d) : d
						)
					)
					const doubles = yield* values(
						Arr.map(sample.doubles, (d) => textOf(lit.float(d, types.double)))
					)
					for (const [i, d] of sample.doubles.entries()) {
						assert.ok(
							Object.is(Number(doubles[i]), d),
							`${Formatter.format(d)} came back as ${doubles[i]}`
						)
					}
					const reals = yield* values(
						Arr.map(sample.reals, (r) => textOf(cast(lit.float(r, types.real), types.double)))
					)
					for (const [i, r] of sample.reals.entries()) {
						assert.ok(
							Object.is(Number(reals[i]), r),
							`${Formatter.format(r)} came back as ${reals[i]}`
						)
					}
					const ints = yield* values(
						Arr.flatMap(sample.ints, ([t, n]) => {
							const printed = printExpr(lit.int(n, t.type))
							return [textOf(lit.int(n, t.type)), `pg_typeof(${printed})::text`]
						})
					)
					assert.deepEqual(
						ints,
						Arr.flatMap(sample.ints, ([t, n]) => [n.toString(), t.name])
					)
					if (Arr.some(sample.ints, ([t, n]) => n === t.least || n === t.greatest)) {
						c.note("an integer type's bound")
					}
					const others = yield* values(
						Arr.appendAll(
							Arr.map(sample.bools, (b) => textOf(lit.bool(b))),
							Arr.map(sample.spans, (span) => textOf(lit.text(span, types.int4range)))
						)
					)
					assert.deepEqual(others, Arr.appendAll(Arr.map(sample.bools, String), sample.spans))
				}),
		oracle: {
			kind: "specification",
			name: "each literal's own value, read back as text, and the type it is printed as"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: '\t\t\treturn { kind: "quoted", text: String(value.value) }',
				replacement:
					'\t\t\treturn { kind: "quoted", text: String(Number(value.value.toPrecision(15))) }',
				why: "A double literal is printed to fifteen significant digits; the literals property fails."
			}
		]
	}
)
