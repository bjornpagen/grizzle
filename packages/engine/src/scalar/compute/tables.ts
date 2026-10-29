import { type Column, convertColumn } from "#compiler/core/decoder.ts"
import { convertByCarrier } from "#compiler/scalar/values/convert.ts"
import type { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { Money } from "#compiler/scalar/values/money.ts"

/** The unbranded host value of each SQL type a plain result can have. */
export interface PlainHost {
	readonly smallint: number
	readonly integer: number
	readonly bigint: bigint
	readonly numeric: Decimal
	readonly real: number
	readonly "double precision": number
	readonly money: Money
	readonly boolean: boolean
	readonly uuid: string
	readonly text: string
}
export type PlainSql = keyof PlainHost

/**
 * The result tables of the Compute catalogue and of the aggregates, keyed by SQL type.
 *
 * An operation whose result is no operand's own value takes PostgreSQL's result type over its operand's SQL type:
 * arithmetic keeps the operand's type without its contract, money / money is double precision, SUM over smallint and
 * integer is bigint, AVG over the integer types is numeric (scalar/compute/registry.ts and scalar/aggregate.ts hold the overloads). The result is a plain value, so its column
 * is the plain column of its SQL type, which delivers the unbranded host value.
 *
 * A typed builder indexes these tables by its operand's `sql`, whose type is the operand's SQL type literal, so its
 * result's column and host type follow by construction: `plainColumns[a.sql]` is a `Column<PlainHost[S]>` for an
 * operand of SQL type S. A JavaScript caller's operand has a SQL type known only at run time, so the untyped builders
 * read the plain column of the SQL type of the result's carrier, which the builder's check narrowed to a plain one
 * (builders.ts finishPlain).
 *
 * The plain column of each SQL type: its carrier's conversion.
 */
export const plainColumns: { readonly [S in PlainSql]: Column<PlainHost[S]> } = Object.freeze({
	smallint: convertColumn(convertByCarrier.int2({ carrier: "int2" })),
	integer: convertColumn(convertByCarrier.int4({ carrier: "int4" })),
	bigint: convertColumn(convertByCarrier.int8({ carrier: "int8" })),
	numeric: convertColumn(convertByCarrier.numeric({ carrier: "numeric", typmod: undefined })),
	real: convertColumn(convertByCarrier.float4({ carrier: "float4" })),
	"double precision": convertColumn(convertByCarrier.float8({ carrier: "float8" })),
	money: convertColumn(convertByCarrier.money({ carrier: "money" })),
	boolean: convertColumn(convertByCarrier.bool({ carrier: "bool" })),
	uuid: convertColumn(convertByCarrier.uuid({ carrier: "uuid" })),
	text: convertColumn(convertByCarrier.text({ carrier: "text" }))
})

/**
 * The operand families, by SQL type: + and - over the numeric family and money; *, unary minus, abs and sign over the
 * numeric family; / over both; % gcd and lcm over the integer types and numeric; power and sqrt over numeric and double
 * precision; a span's endpoint is an integer or a bigint.
 */
export type NumericSql =
	| "smallint"
	| "integer"
	| "bigint"
	| "numeric"
	| "real"
	| "double precision"
	| "money"
export type SignedSql = Exclude<NumericSql, "money">
export type IntegralSql = "smallint" | "integer" | "bigint" | "numeric"
export type PowerSql = "numeric" | "double precision"
export type EndpointSql = "integer" | "bigint"

/** money / money is double precision; every other quotient keeps its operand's type. */
export interface QuotientSql {
	readonly smallint: "smallint"
	readonly integer: "integer"
	readonly bigint: "bigint"
	readonly numeric: "numeric"
	readonly real: "real"
	readonly "double precision": "double precision"
	readonly money: "double precision"
}

export const quotientSql: QuotientSql = Object.freeze({
	smallint: "smallint",
	integer: "integer",
	bigint: "bigint",
	numeric: "numeric",
	real: "real",
	"double precision": "double precision",
	money: "double precision"
})

/**
 * SUM's result type: smallint and integer give bigint, bigint and numeric numeric; the floats and money keep theirs.
 */
export interface SumSql {
	readonly smallint: "bigint"
	readonly integer: "bigint"
	readonly bigint: "numeric"
	readonly numeric: "numeric"
	readonly real: "real"
	readonly "double precision": "double precision"
	readonly money: "money"
}

export const sumSql: SumSql = Object.freeze({
	smallint: "bigint",
	integer: "bigint",
	bigint: "numeric",
	numeric: "numeric",
	real: "real",
	"double precision": "double precision",
	money: "money"
})

/**
 * AVG's result type: the integer types and numeric give numeric, the floats double precision. There is no AVG(money).
 */
export interface AvgSql {
	readonly smallint: "numeric"
	readonly integer: "numeric"
	readonly bigint: "numeric"
	readonly numeric: "numeric"
	readonly real: "double precision"
	readonly "double precision": "double precision"
}

export const avgSql: AvgSql = Object.freeze({
	smallint: "numeric",
	integer: "numeric",
	bigint: "numeric",
	numeric: "numeric",
	real: "double precision",
	"double precision": "double precision"
})
