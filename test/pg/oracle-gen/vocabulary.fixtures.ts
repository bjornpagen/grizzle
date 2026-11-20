/** What the properties of vocabulary.test.ts read: the SQL of each type and aggregate, the boxes and the roster template. */

import { element } from "@bjornpagen/testing/gen"
import type { Source } from "@bjornpagen/testing/source"
import { Array as Arr, Effect, pipe, String as Str } from "effect"
import { canonicalTag } from "#compiler/core/canonical.ts"

import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import { codecOf, codeOf, firstCodebook } from "#compiler/ir/codes.ts"
import { decimalPayload } from "#compiler/ir/decimal.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { baseOf, nativeNames, rosterOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { baseTypeSpecs, scalarOfSpec, type SpelledValue } from "#test/support/oracle/gen/domain.ts"

import {
	aggregateLowering,
	type GenAggregate,
	genAggregates
} from "#test/support/oracle/gen/ops.ts"
import type { GenSchema } from "#test/support/oracle/gen/schema.ts"
import { noTables } from "#test/support/substrate/replace.ts"
import { installTemplate, Substrate } from "#test/support/substrate/substrate.ts"

/** The element at an index the test knows to be in range, or a failed test naming what is missing. */

export const at = <T>(items: ReadonlyArray<T>, index: number, what: string): T => {
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
export const sqlType = (descriptor: ScalarType, schema: string): string => {
	const type = baseOf(descriptor)
	if (type.carrier === "code") {
		return `${quoteIdent(schema)}.${quoteIdent(Str.toLowerCase(type.roster.closed))}`
	}
	if (type.carrier === "numeric" && type.typmod !== undefined) {
		return `numeric(${type.typmod.precision},${type.typmod.scale})`
	}
	if (type.carrier === "vector") {
		return `${vectorSchema}.${quoteIdent("vector")}(${type.typmod.dims})`
	}
	return nativeNames[type.carrier]
}

/**
 * The type PostgreSQL gives an aggregate's result of `type`: a closed id's is smallint, since min and max over a
 * domain are its base type's, which the decoder reads as the code it is; any other the column's type.
 */
export const resultSqlType = (type: ScalarType, schema: string): string =>
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
export const equalitySql = (type: ScalarType): string =>
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
export const sqlLiteral = (literal: TypedLiteral, type: ScalarType, schema: string): string => {
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
		case "date":
			return `${quoteString(literal.value)}::date`
		case "handle":
			return `${codeIn(type, literal.handle)}::smallint::${t}`
		case "handles":
			throw new Error("the generators draw no set column")
		case "span":
			return `${quoteString(`[${literal.start},${literal.end})`)}::${t}`
		case "vector":
			return `${quoteString(literal.value[canonicalTag]().payload)}::${t}`
		case "pattern":
			throw new Error("the generators draw no pattern column")
	}
}

/** A stored value as SQL: in its twin spelling where it has one, which the column type's input function reads. */
export const storedSql = (stored: SpelledValue, type: ScalarType, schema: string): string => {
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
export const aggregateSql = (fn: GenAggregate, arg: string, schema: string): string =>
	fn === "count"
		? `${schema}.count(*)`
		: `${schema}.${fn === "boolAnd" ? "bool_and" : fn === "boolOr" ? "bool_or" : fn}(${arg})`

/**
 * The argument the conservative lowering passes an aggregate over `x`, by its lowering (ops.ts aggregateLowering,
 * lower/conservative/group aggregateExpr): a widened sum's, over smallint or integer, is each value as bigint, whose sum
 * PostgreSQL accumulates and types as numeric; a scale-free mean's is each value through trim_scale; a money sum's is
 * each amount's exact numeric value, since the checker keeps the total exact money, which PostgreSQL's sum(money) does
 * not; any other aggregate reads `x` as it is, a float's exact sum and mean rounding back to the float the native call
 * returns.
 */
export const argumentSql = (fn: GenAggregate, t: ScalarType, x: string): string => {
	const lowering = aggregateLowering(fn, t)
	switch (lowering.kind) {
		case "widened":
			return `${x}::bigint`
		case "scaleFree":
			return `pg_catalog.trim_scale(${x})`
		case "exactSum":
			return lowering.exact === "money" ? `${x}::numeric` : x
		case "native":
		case "exactMean":
			return x
	}
}

/** What an aggregate over a generated type reached: typed where the generators emit it, else defined only where declined. */
export type AggregateFeature =
	| "typed as PostgreSQL types it"
	| "declined, and defined"
	| "absent from PostgreSQL"

/** The schemas an aggregate over a generated type can live in: PostgreSQL's own, and the vector extension's. */
export const aggregateSchemas: Arr.NonEmptyReadonlyArray<string> = [
	quoteIdent("pg_catalog"),
	vectorSchema
]

/** The aggregates PostgreSQL or an extension defines over a generated type's storage that the language leaves out, by carrier, each with why. */
const declinedAggregates: ReadonlyArray<{
	readonly carrier: ScalarType["carrier"]
	readonly fn: GenAggregate
	/**
	 * Why the language leaves out an aggregate defined over a generated type's storage. Its answer depends on the order
	 * it meets its rows in: pgvector's sum(vector) adds the components in float32 in that order and fails where a partial
	 * sum overflows (vector.c vector_add), and its avg(vector) sums them in float8 in that order (vector_accum). Or it is
	 * no aggregate of the type's values: a closed id's column stores its handle's code, a smallint, whose sum and avg
	 * PostgreSQL computes, but a handle is no number.
	 */
	readonly why: "its accumulation depends on the order of its rows" | "a closed id is no number"
}> = [
	{ carrier: "vector", fn: "sum", why: "its accumulation depends on the order of its rows" },
	{ carrier: "vector", fn: "avg", why: "its accumulation depends on the order of its rows" },
	{ carrier: "code", fn: "sum", why: "a closed id is no number" },
	{ carrier: "code", fn: "avg", why: "a closed id is no number" }
]

export const declinedOver = (t: ScalarType, fn: GenAggregate): boolean =>
	Arr.some(declinedAggregates, (d) => d.carrier === t.carrier && d.fn === fn)

const cols = (names: ReadonlyArray<string>) => Arr.join(Arr.map(names, quoteIdent), ", ")

export const ddl = (schema: string, s: GenSchema): ReadonlyArray<string> => {
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

/**
 * The fresh schema the generators' roster K0 is a domain of, made once per member (substrate.ts installTemplate),
 * where each search made it before its box; a case only reads, so nothing is emptied after it.
 */
export const rosterTemplate = installTemplate({
	declaredIn: import.meta,
	name: "vocabulary roster",
	content: { roster: "K0" },
	plan: (names) => Effect.succeed(names.schema),
	install: () =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const schema = yield* s.schema({ create: true, label: "install" })
			yield* s.admin.query(rosterDomainSql(schema, "K0", 3), [])
		}),
	bind: (schema) => schema,
	reset: () => noTables
})

/** Every type the generators draw a column of, with every aggregate they know. */
export const aggregateBox = (source: Source): readonly [ScalarType, GenAggregate] =>
	[source.draw(element(generatedTypes)), source.draw(element(genAggregates))] as const

/** Every type the generators draw a column of. */
export const typeBox = (source: Source): ScalarType => source.draw(element(generatedTypes))
