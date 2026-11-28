import { type Column, convertColumn, textColumn } from "#compiler/core/decoder.ts"
import type { CalendarDate } from "#compiler/ir/date.ts"
import { carrierColumn } from "#compiler/scalar/values/convert.ts"
import type { Numeric } from "#compiler/scalar/values/decimal.ts"
import type { Money } from "#compiler/scalar/values/money.ts"
import type { Cidr, Inet } from "#compiler/scalar/values/net.ts"
import type { Sha256 } from "#compiler/scalar/values/sha256.ts"
import type { Uuid } from "#compiler/scalar/values/uuid.ts"

/** The unbranded host value of each SQL type a plain result can have. */
export interface PlainHost {
	readonly int2: number
	readonly int4: number
	readonly int8: bigint
	readonly numeric: Numeric
	readonly float4: number
	readonly float8: number
	readonly money: Money
	readonly bool: boolean
	readonly uuid: Uuid
	readonly date: CalendarDate
	readonly inet: Inet
	readonly cidr: Cidr
	readonly text: string
	readonly sha256: Sha256
	readonly "exact integer": bigint
	readonly "exact money": Money
}
export type PlainSql = keyof PlainHost

/**
 * The result tables of the scalar catalogue and of the aggregates, keyed by SQL type.
 *
 * An operation whose result is no operand's own value takes PostgreSQL's result type over its operand's SQL type:
 * arithmetic keeps the operand's type without its contract, money / money is double precision, SUM and AVG over the
 * integer types are numeric (scalar/compute/registry.ts and scalar/aggregate.ts hold the overloads). The result is a plain value, so its column
 * is the plain column of its SQL type, which delivers the unbranded host value.
 *
 * A typed builder indexes these tables by its operand's `sql`, whose type is the operand's SQL type literal, so its
 * result's column and host type follow by construction: `plainColumns[a.sql]` is a `Column<PlainHost[S]>` for an
 * operand of SQL type S. A JavaScript caller's operand has a SQL type known only at run time, so the untyped builders
 * read the plain column of the SQL type of the result's carrier, which the builder's check narrowed to a plain one
 * (builders.ts finishPlain).
 *
 * The plain column of each SQL type: its carrier's conversion, and a uuid's text column over Uuid (scalar/uuid.ts).
 */
export const plainColumns: { readonly [S in PlainSql]: Column<PlainHost[S]> } = Object.freeze({
	int2: carrierColumn("int2"),
	int4: carrierColumn("int4"),
	int8: carrierColumn("int8"),
	numeric: carrierColumn("numeric"),
	float4: carrierColumn("float4"),
	float8: carrierColumn("float8"),
	money: carrierColumn("money"),
	bool: carrierColumn("bool"),
	uuid: textColumn<Uuid>(),
	date: carrierColumn("date"),
	inet: carrierColumn("inet"),
	cidr: carrierColumn("cidr"),
	text: carrierColumn("text"),
	sha256: convertColumn<Sha256>({ carrier: "sha256" }),
	"exact integer": carrierColumn("exactInteger"),
	"exact money": carrierColumn("exactMoney")
})

/**
 * The operand families, by SQL type: + and - over the numeric family and money; *, unary minus, abs and sign over the
 * numeric family; / over both; % gcd and lcm over the integer types and numeric; power and sqrt over numeric and double
 * precision; a span's endpoint is an integer, a bigint or a date.
 */
export type NumericSql =
	| "int2"
	| "int4"
	| "int8"
	| "numeric"
	| "float4"
	| "float8"
	| "money"
	| "exact integer"
	| "exact money"
export type SignedSql = Exclude<NumericSql, "money" | "exact money">
export type IntegralSql = "int2" | "int4" | "int8" | "numeric" | "exact integer"
export type PowerSql = "numeric" | "float8"
export type EndpointSql = "int4" | "int8" | "date"
/**
 * The SQL type of a span's width, the difference of its endpoints, for each SQL type an endpoint has: an exact integer
 * of integer endpoints, which never overflows, and PostgreSQL's integer count of days of dates (date - date).
 */
export interface SpanWidthSql {
	readonly int4: "exact integer"
	readonly int8: "exact integer"
	readonly date: "int4"
}
export const spanWidthSql: SpanWidthSql = Object.freeze({
	int4: "exact integer",
	int8: "exact integer",
	date: "int4"
})
/** The float SQL types, which Num.floatBits reads. */
export type FloatSql = "float4" | "float8"

/** The SQL types whose values a narrowing cast into an integer or money needs proved finite: numeric and the floats. */
export type InexactSql = "numeric" | "float4" | "float8"

/**
 * The result of +, -, *, unary minus and abs over each SQL type: integers and money exactly, an exact integer and
 * exact money, which never overflow (scalar/compute/registry.ts Totality exact); numeric and the floats their own.
 */
export interface ArithmeticSql {
	readonly int2: "exact integer"
	readonly int4: "exact integer"
	readonly int8: "exact integer"
	readonly numeric: "numeric"
	readonly float4: "float4"
	readonly float8: "float8"
	readonly money: "exact money"
	readonly "exact integer": "exact integer"
	readonly "exact money": "exact money"
}

export const arithmeticSql: ArithmeticSql = Object.freeze({
	int2: "exact integer",
	int4: "exact integer",
	int8: "exact integer",
	numeric: "numeric",
	float4: "float4",
	float8: "float8",
	money: "exact money",
	"exact integer": "exact integer",
	"exact money": "exact money"
})

/**
 * The result of / over each SQL type: integer division truncates over the exact integers, money / money is double
 * precision, numeric and the floats keep theirs.
 */
export interface QuotientSql {
	readonly int2: "exact integer"
	readonly int4: "exact integer"
	readonly int8: "exact integer"
	readonly numeric: "numeric"
	readonly float4: "float4"
	readonly float8: "float8"
	readonly money: "float8"
	readonly "exact integer": "exact integer"
	readonly "exact money": "float8"
}

export const quotientSql: QuotientSql = Object.freeze({
	int2: "exact integer",
	int4: "exact integer",
	int8: "exact integer",
	numeric: "numeric",
	float4: "float4",
	float8: "float8",
	money: "float8",
	"exact integer": "exact integer",
	"exact money": "float8"
})

/** gcd's and lcm's result: the integers' exact, numeric's numeric. */
export interface DivisorSql {
	readonly int2: "exact integer"
	readonly int4: "exact integer"
	readonly int8: "exact integer"
	readonly numeric: "numeric"
	readonly "exact integer": "exact integer"
}

export const divisorSql: DivisorSql = Object.freeze({
	int2: "exact integer",
	int4: "exact integer",
	int8: "exact integer",
	numeric: "numeric",
	"exact integer": "exact integer"
})

/** % over each SQL type: an integer's remainder keeps its type, as it fits its divisor's; numeric's numeric. */
export interface RemainderSql {
	readonly int2: "int2"
	readonly int4: "int4"
	readonly int8: "int8"
	readonly numeric: "numeric"
	readonly "exact integer": "exact integer"
}

export const remainderSql: RemainderSql = Object.freeze({
	int2: "int2",
	int4: "int4",
	int8: "int8",
	numeric: "numeric",
	"exact integer": "exact integer"
})

/**
 * SUM's result type: the integers and numeric give numeric, the floats keep theirs, money and the exact values an exact
 * one (scalar/aggregate.ts). A sum over smallint or integer is numeric, as over bigint: PostgreSQL's own bigint sum of
 * them wraps past 2^63, so grizzle sums them as bigint, exactly.
 */
export interface SumSql {
	readonly int2: "numeric"
	readonly int4: "numeric"
	readonly int8: "numeric"
	readonly numeric: "numeric"
	readonly float4: "float4"
	readonly float8: "float8"
	readonly money: "exact money"
	readonly "exact integer": "exact integer"
	readonly "exact money": "exact money"
}

export const sumSql: SumSql = Object.freeze({
	int2: "numeric",
	int4: "numeric",
	int8: "numeric",
	numeric: "numeric",
	float4: "float4",
	float8: "float8",
	money: "exact money",
	"exact integer": "exact integer",
	"exact money": "exact money"
})

/**
 * AVG's result type: the integer types and numeric give numeric, the floats double precision. There is no AVG(money).
 */
export interface AvgSql {
	readonly int2: "numeric"
	readonly int4: "numeric"
	readonly int8: "numeric"
	readonly numeric: "numeric"
	readonly float4: "float8"
	readonly float8: "float8"
	readonly "exact integer": "numeric"
}

export const avgSql: AvgSql = Object.freeze({
	int2: "numeric",
	int4: "numeric",
	int8: "numeric",
	numeric: "numeric",
	float4: "float8",
	float8: "float8",
	"exact integer": "numeric"
})
