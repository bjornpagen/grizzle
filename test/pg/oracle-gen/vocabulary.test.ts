/**
 * The generators' claims about PostgreSQL 19, checked on PostgreSQL 19.
 *
 * - Every aggregate the generators emit exists over its argument type with the result type ops.ts states, and every
 *   aggregate they leave out of a type exists in neither PostgreSQL's schema nor the vector extension's, each looked
 *   up qualified, unless the language states why it leaves it out (declinedAggregates).
 * - The value domains' classes are PostgreSQL's equality classes: two literals are equal under PostgreSQL's `=`
 *   exactly when they share a class (NaN = NaN, -0 = 0, 1.0 = 1.00).
 * - Generated facts satisfy the declared laws natively: an explored population of schemas installs with PRIMARY KEY,
 *   UNIQUE and immediate FOREIGN KEY constraints, and every fact loads, so no key collides under native equality.
 */
import { layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, pipe, String as Str } from "effect"
import { canonicalTag } from "#compiler/core/canonical.ts"
import { codecOf, codeOf, firstCodebook } from "#compiler/ir/codes.ts"
import { decimalPayload } from "#compiler/ir/decimal.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { nativeName, rosterOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { quoteIdent, quoteString } from "#compiler/sql/print.ts"
import { assert } from "#test/support/assert.ts"
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import {
	baseTypeSpecs,
	scalarOfSpec,
	type SpelledValue,
	valueClasses,
	literalEqualityKey
} from "#test/support/oracle/gen/domain.ts"

import { caseHang } from "#test/support/limits.ts"
import {
	aggregateApplies,
	aggregateResult,
	type GenAggregate,
	genAggregates
} from "#test/support/oracle/gen/ops.ts"
import type { GenSchema } from "#test/support/oracle/gen/schema.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

/** The element at an index the test knows to be in range, or a failed test naming what is missing. */
const at = <T>(items: ReadonlyArray<T>, index: number, what: string): T => {
	const item = items[index]
	if (item === undefined) {
		throw new Error(`${what} at ${index} is missing`)
	}
	return item
}

/** The schema the cluster holds the vector extension in. */
const vectorSchema = quoteIdent("vector_ext")

/**
 * The SQL type of a generated column: a closed id the schema's domain over smallint named after its roster, which
 * admits exactly the roster's codes, and a vector the extension's type at its dimensions.
 */
const sqlType = (type: ScalarType, schema: string): string => {
	if (type.carrier === "code") {
		return `${quoteIdent(schema)}.${quoteIdent(Str.toLowerCase(type.roster.closed))}`
	}
	if (type.carrier === "numeric" && type.typmod !== undefined) {
		return `numeric(${type.typmod.precision},${type.typmod.scale})`
	}
	if (type.carrier === "vector") {
		return `${vectorSchema}.${quoteIdent("vector")}(${type.typmod.dims})`
	}
	return nativeName(type.carrier)
}

/**
 * The type PostgreSQL gives an aggregate's result of `type`: a closed id's is smallint, since min and max over a
 * domain are its base type's, which the decoder reads as the code it is; any other the column's type.
 */
const resultSqlType = (type: ScalarType, schema: string): string =>
	type.carrier === "code" ? "smallint" : sqlType(type, schema)

/**
 * The domain a generated roster's closed ids are typed by: smallint, admitting exactly its codes 0 … n − 1, which a
 * generated schema's installation, drafted from no codes, gives its n handles in declared order.
 */
const rosterDomainSql = (schema: string, roster: string, handles: number): string =>
	`CREATE DOMAIN ${quoteIdent(schema)}.${quoteIdent(Str.toLowerCase(roster))} AS smallint CHECK ((VALUE >= 0 AND VALUE < ${handles}) IS TRUE)`

/** A handle's code under a generated schema's codebook, drafted from no codes. */
const codeIn = (type: ScalarType, handle: string): number => {
	const r = rosterOf(type)
	if (r === undefined) {
		throw new Error("a handle literal of a closed id")
	}
	return codeOf(codecOf(firstCodebook([r]), r), handle)
}

/** PostgreSQL's equality operator over a generated type: the extension's for a vector. */
const equalitySql = (type: ScalarType): string =>
	type.carrier === "vector" ? `OPERATOR(${vectorSchema}.=)` : "="

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
		case "handle":
			return `${codeIn(type, literal.handle)}::smallint::${t}`
		case "handles":
			throw new Error("the generators draw no set column")
		case "span":
			return `${quoteString(`[${literal.start},${literal.end})`)}::${t}`
		case "vector":
			return `${quoteString(literal.value[canonicalTag]().payload)}::${t}`
	}
}

/** A stored value as SQL: in its twin spelling where it has one, which the column type's input function reads. */
const storedSql = (stored: SpelledValue, type: ScalarType, schema: string): string => {
	switch (stored.spelling.kind) {
		case "canonical":
			return sqlLiteral(stored.literal, type, schema)
		case "twin":
			return `${quoteString(stored.spelling.text)}::${sqlType(type, schema)}`
	}
}

const roster = (closed: string) =>
	scalarOfSpec({ carrier: "code", roster: { closed, handles: ["H0", "H1", "H2"] } })

/** Every type the generators draw a column of: the base types, and a closed id of the roster K0. */
const generatedTypes: Arr.NonEmptyReadonlyArray<ScalarType> = Arr.append(
	Arr.map(baseTypeSpecs, scalarOfSpec),
	roster("K0")
)

/** An aggregate over `arg`, the function qualified by `schema`, never found through a search path. */
const aggregateSql = (fn: GenAggregate, arg: string, schema: string): string =>
	fn === "count"
		? `${schema}.count(*)`
		: `${schema}.${fn === "boolAnd" ? "bool_and" : fn === "boolOr" ? "bool_or" : fn}(${arg})`

/** The schemas an aggregate over a generated type can live in: PostgreSQL's own, and the vector extension's. */
const aggregateSchemas: Arr.NonEmptyReadonlyArray<string> = [quoteIdent("pg_catalog"), vectorSchema]

/** The aggregates an extension defines that the language leaves out, by carrier, each with why. */
const declinedAggregates: ReadonlyArray<{
	readonly carrier: ScalarType["carrier"]
	readonly fn: GenAggregate
	/**
	 * Why the language leaves out an aggregate an extension defines over a generated type: its answer depends on the
	 * order it meets its rows in. pgvector's sum(vector) adds the components in float32 in that order and fails where a
	 * partial sum overflows (vector.c vector_add), and its avg(vector) sums them in float8 in that order (vector_accum).
	 */
	readonly why: "its accumulation depends on the order of its rows"
}> = [
	{ carrier: "vector", fn: "sum", why: "its accumulation depends on the order of its rows" },
	{ carrier: "vector", fn: "avg", why: "its accumulation depends on the order of its rows" }
]

const declinedOver = (t: ScalarType, fn: GenAggregate): boolean =>
	Arr.some(declinedAggregates, (d) => d.carrier === t.carrier && d.fn === fn)

const cols = (names: ReadonlyArray<string>) => Arr.join(Arr.map(names, quoteIdent), ", ")

const ddl = (schema: string, s: GenSchema): ReadonlyArray<string> => {
	const out: Array<string> = []
	for (const c of s.closed) {
		out.push(rosterDomainSql(schema, c.name, c.handles.length))
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
			yield* s.admin.query(rosterDomainSql(schema, "K0", 3), [])
			/** Every aggregate over every generated type. */
			const pairs = Arr.flatMap(generatedTypes, (type) =>
				Arr.map(genAggregates, (aggregate) => [type, aggregate] as const)
			)
			for (const [t, fn] of pairs) {
				const value = sqlLiteral(at(valueClasses(t, false), 0, "a value class"), t, schema)
				const query = (home: string) =>
					`SELECT pg_typeof(${aggregateSql(fn, "v.x", home)})::regtype::text FROM (VALUES (${value})) AS v(x)`
				if (aggregateApplies(fn, t)) {
					const [row = []] = yield* s.admin.queryValues(query(quoteIdent("pg_catalog")), [])
					const expected = aggregateResult(fn, fn === "count" ? undefined : t)
					/**
					 * pg_typeof reports the type without its typmod; min and max keep the argument's descriptor.
					 */
					const [want = []] = yield* s.admin.queryValues(
						`SELECT ${quoteString(resultSqlType(expected, schema))}::regtype::text`,
						[]
					)
					assert.equal(row[0], want[0], `${fn}(${sqlType(t, schema)})`)
				} else if (fn !== "count") {
					/** Whether the aggregate resolves in a schema: it runs, or fails with 42883 where it does not exist. */
					const resolves = (home: string) =>
						s.admin.queryValues(query(home), []).pipe(
							Effect.as(true),
							Effect.catchIf(
								(e) => pgErrorFields(e)?.code === "42883",
								() => Effect.succeed(false)
							)
						)
					const found = yield* Effect.forEach(aggregateSchemas, resolves)
					assert.equal(
						Arr.some(found, (f) => f),
						declinedOver(t, fn),
						`${fn}(${sqlType(t, schema)}): defined in ${Arr.join(aggregateSchemas, " or ")} exactly where the language states why it leaves it out`
					)
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
				yield* s.admin.query(rosterDomainSql(schema, "K0", 3), [])
				return yield* exhaust(
					{
						suite: "oracle-gen/value-classes",
						generator: element(generatedTypes),
						literal: Formatter.format,
						limit: generatedTypes.length,
						coverage: noCoverage,
						caseHang
					},
					(t) =>
						Effect.gen(function* () {
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
						coverage: required<"facts loaded">(["facts loaded"], { cases: 160, sense: notesOnly }),
						kept: [],
						/** The rotating stream's 160 cases and the floor's 40. */
						runs: 160,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
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
				)
			})
		)
	)
})
