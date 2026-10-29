/**
 * The generators' claims about PostgreSQL 19, checked on PostgreSQL 19.
 *
 * - Every aggregate the generators emit exists over its argument type with the result type ops.ts states, and every
 *   aggregate they leave out of a type does not exist there.
 * - The value domains' classes are PostgreSQL's equality classes: two literals are equal under PostgreSQL's `=`
 *   exactly when they share a class (NaN = NaN, -0 = 0, 1.0 = 1.00).
 * - Generated facts satisfy the declared laws natively: an explored population of schemas installs with PRIMARY KEY,
 *   UNIQUE and immediate FOREIGN KEY constraints, and every fact loads, so no key collides under native equality.
 */
import { layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { features, noFeatures } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, pipe, String as Str } from "effect"
import { canonicalTag } from "#compiler/core/canonical.ts"
import { decimalPayload } from "#compiler/ir/decimal.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { nativeName, type ScalarType } from "#compiler/ir/scalar.ts"
import { quoteIdent, quoteString } from "#compiler/sql/print.ts"
import { assert } from "#test/support/assert.ts"
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import {
	baseTypeSpecs,
	scalarOfSpec,
	valueClasses,
	literalEqualityKey
} from "#test/support/oracle/gen/domain.ts"

import {
	aggregateApplies,
	aggregateResult,
	type GenAggregate,
	genAggregates
} from "#test/support/oracle/gen/ops.ts"
import type { GenSchema } from "#test/support/oracle/gen/schema.ts"
import { expectSqlstate } from "#test/support/substrate/expect.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

/** The element at an index the test knows to be in range, or a failed test naming what is missing. */
const at = <T>(items: ReadonlyArray<T>, index: number, what: string): T => {
	const item = items[index]
	if (item === undefined) {
		throw new Error(`${what} at ${index} is missing`)
	}
	return item
}

/** The SQL type of a generated column; an enum is the schema's type named after its roster. */
const sqlType = (type: ScalarType, schema: string): string => {
	if (type.carrier === "enum") {
		return `${quoteIdent(schema)}.${quoteIdent(Str.toLowerCase(type.roster.closed))}`
	}
	if (type.carrier === "numeric" && type.typmod !== undefined) {
		return `numeric(${type.typmod.precision},${type.typmod.scale})`
	}
	return nativeName(type.carrier)
}

const moneyText = (minor: bigint): string => {
	const negative = minor < 0n
	const abs = negative ? -minor : minor
	return `${negative ? "-" : ""}${abs / 100n}.${pipe((abs % 100n).toString(), Str.padStart(2, "0"))}`
}

/**
 * A literal as typed SQL, exactly as the fact loader writes it.
 *
 * A double's text, -0 with its sign, which String drops.
 */
const sqlLiteral = (literal: TypedLiteral, type: ScalarType, schema: string): string => {
	const t = sqlType(type, schema)
	switch (literal.kind) {
		case "int":
			return `${quoteString(literal.value.toString())}::${t}`
		case "numeric":
			return `${quoteString(decimalPayload(literal.value))}::${t}`
		case "float":
			return `${quoteString(Object.is(literal.value, -0) ? "-0" : String(literal.value))}::${t}`
		case "floatSpecial":
			return `${quoteString(literal.value)}::${t}`
		case "money":
			return `(${quoteString(moneyText(BigInt(literal.value[canonicalTag]().payload)))}::numeric)::money`
		case "bool":
			return literal.value ? "TRUE" : "FALSE"
		case "text":
			return `${quoteString(literal.value)}::text`
		case "uuid":
			return `${quoteString(literal.value)}::uuid`
		case "enum":
			return `${quoteString(literal.handle)}::${t}`
		case "span":
		case "vector":
			throw new Error(`the generators emit no ${literal.kind} literal`)
	}
}

const roster = (closed: string) =>
	scalarOfSpec({ carrier: "enum", roster: { closed, handles: ["H0", "H1", "H2"] } })

/** Every type the generators draw a column of: the base types, and an enum over the roster K0. */
const generatedTypes: Arr.NonEmptyReadonlyArray<ScalarType> = Arr.append(
	Arr.map(baseTypeSpecs, scalarOfSpec),
	roster("K0")
)

const aggregateSql = (fn: GenAggregate, arg: string): string =>
	fn === "count"
		? "count(*)"
		: `${fn === "boolAnd" ? "bool_and" : fn === "boolOr" ? "bool_or" : fn}(${arg})`

const cols = (names: ReadonlyArray<string>) => Arr.join(Arr.map(names, quoteIdent), ", ")

const ddl = (schema: string, s: GenSchema): ReadonlyArray<string> => {
	const out: Array<string> = []
	for (const c of s.closed) {
		out.push(
			`CREATE TYPE ${quoteIdent(schema)}.${quoteIdent(Str.toLowerCase(c.name))} AS ENUM (${Arr.join(Arr.map(c.handles, quoteString), ", ")})`
		)
	}
	const table = (name: string) => `${quoteIdent(schema)}.${quoteIdent(Str.toLowerCase(name))}`
	for (const r of s.relations) {
		const columns = Arr.map(r.columns, (c) => {
			const collate = c.type.carrier === "text" ? ` COLLATE "pg_catalog"."pg_c_utf8"` : ""
			return `${quoteIdent(c.name)} ${sqlType(c.type, schema)}${collate} NOT NULL`
		})
		const constraints = [
			`PRIMARY KEY (${cols(r.primaryKey)})`,
			...Arr.map(r.keys, (k) => `UNIQUE (${cols(k)})`),
			...Arr.map(
				Arr.filter(s.containments, (k) => k.from.relation === r.name),
				(k) =>
					`FOREIGN KEY (${cols(k.from.fields)}) REFERENCES ${table(k.to.relation)} (${cols(k.to.fields)})`
			)
		]
		out.push(`CREATE TABLE ${table(r.name)} (${Arr.join([...columns, ...constraints], ", ")})`)
	}
	return out
}

layer(Substrate.layer)("the generators against PostgreSQL 19", (it) => {
	it.effect("type every aggregate as PostgreSQL does, and emit none PostgreSQL lacks", () =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const schema = yield* s.schema(freshSchema)
			yield* s.admin.query(`CREATE TYPE ${quoteIdent(schema)}."k0" AS ENUM ('H0', 'H1', 'H2')`, [])
			/** Every aggregate over every generated type. */
			const pairs = Arr.flatMap(generatedTypes, (type) =>
				Arr.map(genAggregates, (aggregate) => [type, aggregate] as const)
			)
			for (const [t, fn] of pairs) {
				const value = sqlLiteral(
					at(at(valueClasses(t, false), 0, "a value class"), 0, "a literal"),
					t,
					schema
				)
				const query = `SELECT pg_typeof(${aggregateSql(fn, "v.x")})::regtype::text FROM (VALUES (${value})) AS v(x)`
				if (aggregateApplies(fn, t)) {
					const [row = []] = yield* s.admin.queryValues(query, [])
					const expected = aggregateResult(fn, fn === "count" ? undefined : t)
					/**
					 * pg_typeof reports the type without its typmod; min and max keep the argument's descriptor.
					 */
					const [want = []] = yield* s.admin.queryValues(
						`SELECT ${quoteString(sqlType(expected, schema))}::regtype::text`,
						[]
					)
					assert.equal(row[0], want[0], `${fn}(${sqlType(t, schema)})`)
				} else if (fn !== "count") {
					yield* expectSqlstate(s.admin.queryValues(query, []), "42883")
				}
			}
		})
	)

	it.effect("draw value classes that are PostgreSQL's equality classes", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const s = yield* Substrate
				const schema = yield* s.schema(freshSchema)
				yield* s.admin.query(
					`CREATE TYPE ${quoteIdent(schema)}."k0" AS ENUM ('H0', 'H1', 'H2')`,
					[]
				)
				return yield* exhaust(
					{
						suite: "oracle-gen/value-classes",
						generator: element(generatedTypes),
						literal: Formatter.format,
						limit: generatedTypes.length,
						features: noFeatures,
						caseHang: Duration.minutes(2)
					},
					(t) =>
						Effect.gen(function* () {
							const literals = valueClasses(t, false).flat()
							const values = Arr.join(
								Arr.map(literals, (l, i) => `(${i}, ${sqlLiteral(l, t, schema)})`),
								", "
							)
							const rows = yield* s.admin.queryValues(
								`SELECT a.i, b.i, a.v = b.v FROM (VALUES ${values}) AS a(i, v), (VALUES ${values}) AS b(i, v) ORDER BY a.i, b.i`,
								[]
							)
							assert.equal(rows.length, literals.length * literals.length)
							for (const [i, j, equal] of rows) {
								const a = at(literals, Number(i), "the left literal")
								const b = at(literals, Number(j), "the right literal")
								assert.equal(
									equal,
									literalEqualityKey(a) === literalEqualityKey(b),
									`${sqlLiteral(a, t, schema)} = ${sqlLiteral(b, t, schema)}`
								)
							}
						})
				)
			})
		)
	)

	it.effect("generate facts that load under every declared key and containment", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const s = yield* Substrate
				return yield* explore(
					{
						suite: "oracle-gen/facts",
						draw: drawn(queryCaseGen(defaultGenConfig)),
						literal: Formatter.format,
						features: features<"facts loaded">(["facts loaded"]),
						kept: [],
						/** The rotating stream's 160 cases and the floor's 40. */
						runs: 160,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(c, k) =>
						Effect.gen(function* () {
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
													sqlLiteral(v, at(r.columns, i, "the column").type, schema)
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
				)
			})
		)
	)
})
