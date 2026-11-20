/**
 * The generators' claims about PostgreSQL 19, checked on PostgreSQL 19.
 *
 * - Every aggregate the generators emit exists over the argument its lowering passes it with the result type ops.ts
 *   states, a money sum over its amounts as numeric and a smallint's or an integer's sum over its values as bigint
 *   (an exact numeric, README: "the r.sum of an integer is an exact Decimal"), and every aggregate they leave out of
 *   a type exists in neither PostgreSQL's schema nor the vector extension's, each looked up qualified, unless the
 *   language states why it leaves it out (declinedAggregates).
 * - The value domains' classes are PostgreSQL's equality classes: two literals are equal under PostgreSQL's `=`
 *   exactly when they share a class (NaN = NaN, -0 = 0, 1.0 = 1.00).
 * - Generated facts satisfy the declared laws natively: an explored population of schemas installs with PRIMARY KEY,
 *   UNIQUE and immediate FOREIGN KEY constraints, and every fact loads, so no key collides under native equality.
 *
 * Oracle: PostgreSQL itself: pg_aggregate's overloads and pg_typeof, = over each type's class literals, and the
 * declared constraints over every fact loaded.
 *
 * Features: an aggregate typed as PostgreSQL types it and one declined and defined, and facts loaded.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import { nativeEqualityKey } from "#compiler/ir/expr.ts"
import {
	type AggregateFeature,
	aggregateBox,
	aggregateSchemas,
	aggregateSql,
	argumentSql,
	at,
	ddl,
	declinedOver,
	equalitySql,
	resultSqlType,
	rosterTemplate,
	sqlLiteral,
	sqlType,
	storedSql,
	typeBox
} from "#test/pg/oracle-gen/vocabulary.fixtures.ts"
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { valueClasses } from "#test/support/oracle/gen/domain.ts"
import { aggregateApplies, aggregateResult } from "#test/support/oracle/gen/ops.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The generators type every aggregate as PostgreSQL does, and emit none PostgreSQL lacks, each case on the worker's seat
 * of the roster's schema.
 *
 * Its pre-conversion budget: the box (test/pg/oracle-gen/vocabulary.test.ts at 011a72711).
 */
export const typeEveryAggregateAsPostgreSQLDoesAndEmitNonePostgreSQLLacks = property.exhaust(
	finite(aggregateBox),
	{
		needs: { roster: Substrate.seat(rosterTemplate) },
		situations: [
			"typed as PostgreSQL types it",
			"declined, and defined",
			"absent from PostgreSQL"
		] satisfies ReadonlyArray<Reached<AggregateFeature>>,
		check:
			({ roster }, c: Case<AggregateFeature>) =>
			([t, fn]) =>
				Effect.scoped(
					Effect.flatMap(roster, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const s = yield* Substrate
								const schema = seat.value
								const value = sqlLiteral(at(valueClasses(t, false), 0, "a value class"), t, schema)
								const query = (home: string, arg: string) =>
									`SELECT pg_typeof(${aggregateSql(fn, arg, home)})::regtype::text FROM (VALUES (${value})) AS v(x)`
								if (aggregateApplies(fn, t)) {
									const [row = []] = yield* s.admin.queryValues(
										query(quoteIdent("pg_catalog"), argumentSql(fn, t, "v.x")),
										[]
									)
									const expected = aggregateResult(fn, fn === "count" ? undefined : t)
									/**
									 * pg_typeof reports the type without its typmod; min and max keep the argument's descriptor.
									 */
									const [want = []] = yield* s.admin.queryValues(
										`SELECT ${quoteString(resultSqlType(expected, schema))}::regtype::text`,
										[]
									)
									assert.equal(row[0], want[0], `${fn}(${sqlType(t, schema)})`)
									c.note("typed as PostgreSQL types it")
									return
								}
								if (fn === "count") {
									return
								}
								/** Whether the aggregate resolves in a schema: it runs, or fails with 42883 where it does not exist. */
								const resolves = (home: string) =>
									s.admin.queryValues(query(home, "v.x"), []).pipe(
										Effect.as(true),
										Effect.catchIf(
											(e) => pgErrorFields(e)?.code === "42883",
											() => Effect.succeed(false)
										)
									)
								const found = yield* Effect.forEach(aggregateSchemas, resolves)
								const declined = declinedOver(t, fn)
								assert.equal(
									Arr.some(found, (f) => f),
									declined,
									`${fn}(${sqlType(t, schema)}): defined in ${Arr.join(aggregateSchemas, " or ")} exactly where the language states why it leaves it out`
								)
								c.note(declined ? "declined, and defined" : "absent from PostgreSQL")
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "postgresql",
			name: "pg_typeof of the aggregate PostgreSQL resolves, qualified in pg_catalog or the vector extension's schema"
		},
		box: "every aggregate the generators know over every type they draw a column of",
		show: ([t, fn]) => `${fn}(${sqlType(t, "s")})`,
		kept: [],
		kills: []
	}
)

/**
 * The generators draw value classes that are PostgreSQL's equality classes, each case on the worker's seat of the
 * roster's schema.
 *
 * Its pre-conversion budget: the box (test/pg/oracle-gen/vocabulary.test.ts at 011a72711).
 */
export const drawValueClassesThatArePostgreSQLsEqualityClasses = property.exhaust(finite(typeBox), {
	needs: { roster: Substrate.seat(rosterTemplate) },
	situations: [],
	check:
		({ roster }) =>
		(t) =>
			Effect.scoped(
				Effect.flatMap(roster, (seat) =>
					Effect.provideService(
						Effect.gen(function* () {
							const s = yield* Substrate
							const schema = seat.value
							const literals = valueClasses(t, false)
							const values = Arr.join(
								Arr.map(literals, (l, i) => `(${i}, ${sqlLiteral(l, t, schema)})`),
								", "
							)
							const rows = yield* s.admin.queryValues(
								`SELECT a.i, b.i, a.v ${equalitySql(t)} b.v FROM (VALUES ${values}) AS a(i, v), (VALUES ${values}) AS b(i, v) ORDER BY a.i, b.i`,
								[]
							)
							assert.equal(rows.length, literals.length * literals.length)
							for (const [i, j, equal] of rows) {
								const a = at(literals, Number(i), "the left literal")
								const b = at(literals, Number(j), "the right literal")
								assert.equal(
									equal,
									nativeEqualityKey(a) === nativeEqualityKey(b),
									`${sqlLiteral(a, t, schema)} = ${sqlLiteral(b, t, schema)}`
								)
							}
						}),
						Substrate,
						seat.substrate
					)
				)
			),
	oracle: { kind: "postgresql", name: "= over every pair of each type's class literals" },
	box: "every type the generators draw, each with every literal of its value classes",
	show: Formatter.format,
	kept: [],
	kills: []
})

/**
 * The generators generate facts that load under every declared key and containment, each case its own schema, as each
 * case of the search made one.
 *
 * Its pre-conversion budget: runs 160, coverage cases 160 (test/pg/oracle-gen/vocabulary.test.ts at 011a72711).
 */
export const generateFactsThatLoadUnderEveryDeclaredKeyAndContainment = property.explore(
	queryCaseGen(defaultGenConfig),
	{
		needs: { substrate: Substrate.installing },
		situations: ["facts loaded"] satisfies ReadonlyArray<Reached<"facts loaded">>,
		check:
			({ substrate }, k: Case<"facts loaded">) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const s = yield* Substrate
							const schema = yield* s.schema(freshSchema)
							for (const statement of ddl(schema, c.schema)) {
								yield* s.admin.query(statement, [])
							}
							for (const r of c.schema.relations) {
								const rows = c.facts[r.name] ?? []
								if (rows.length === 0) {
									continue
								}
								const values = Arr.join(
									Arr.map(
										rows,
										(row) =>
											`(${Arr.join(
												Arr.map(row, (v, i) =>
													storedSql(v, at(r.columns, i, "the column").type, schema)
												),
												", "
											)})`
									),
									", "
								)
								yield* s.admin.query(
									`INSERT INTO ${quoteIdent(schema)}.${quoteIdent(Str.toLowerCase(r.name))} (${Arr.join(
										Arr.map(r.columns, (col) => quoteIdent(col.name)),
										", "
									)}) VALUES ${values}`,
									[]
								)
								const [count = []] = yield* s.admin.queryValues(
									`SELECT count(*)::text FROM ${quoteIdent(schema)}.${quoteIdent(Str.toLowerCase(r.name))}`,
									[]
								)
								assert.equal(Number(count[0]), rows.length)
								k.note("facts loaded")
							}
							yield* s.admin.query(`DROP SCHEMA ${quoteIdent(schema)} CASCADE`, [])
						})
					),
					Substrate,
					substrate
				),
		oracle: {
			kind: "postgresql",
			name: "the declared PRIMARY KEY, UNIQUE and immediate FOREIGN KEY constraints over every fact loaded"
		},
		show: Formatter.format,
		budget: { runs: 160, steered: 160 },
		kept: [],
		kills: []
	}
)
