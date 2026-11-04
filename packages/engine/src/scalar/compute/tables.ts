import { type Column, convertColumn, textColumn } from "#compiler/core/decoder.ts"
import { convertByCarrier } from "#compiler/scalar/values/convert.ts"
import type { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { Money } from "#compiler/scalar/values/money.ts"
import type { Uuid } from "#compiler/scalar/values/uuid.ts"

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
	readonly uuid: Uuid
	readonly text: string
	readonly "exact integer": bigint
	readonly "exact money": Money
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
 * The plain column of each SQL type: its carrier's conversion, and a uuid's text column over Uuid (scalar/uuid.ts).
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
	uuid: textColumn<Uuid>(),
	text: convertColumn(convertByCarrier.text({ carrier: "text" })),
	"exact integer": convertColumn(convertByCarrier.exactInteger({ carrier: "exactInteger" })),
	"exact money": convertColumn(convertByCarrier.exactMoney({ carrier: "exactMoney" }))
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
	| "exact integer"
	| "exact money"
export type SignedSql = Exclude<NumericSql, "money" | "exact money">
export type IntegralSql = "smallint" | "integer" | "bigint" | "numeric" | "exact integer"
export type PowerSql = "numeric" | "double precision"
export type EndpointSql = "integer" | "bigint"
/** The SQL types whose values a narrowing cast into an integer or money needs proved finite: numeric and the floats. */
export type InexactSql = "numeric" | "real" | "double precision"

/**
 * The result of +, -, *, unary minus and abs over each SQL type: integers and money exactly, an exact integer and
 * exact money, which never overflow (scalar/compute/registry.ts Totality exact); numeric and the floats their own.
 */
export interface ArithmeticSql {
	readonly smallint: "exact integer"
	readonly integer: "exact integer"
	readonly bigint: "exact integer"
	readonly numeric: "numeric"
	readonly real: "real"
	readonly "double precision": "double precision"
	readonly money: "exact money"
	readonly "exact integer": "exact integer"
	readonly "exact money": "exact money"
}

export const arithmeticSql: ArithmeticSql = Object.freeze({
	smallint: "exact integer",
	integer: "exact integer",
	bigint: "exact integer",
	numeric: "numeric",
	real: "real",
	"double precision": "double precision",
	money: "exact money",
	"exact integer": "exact integer",
	"exact money": "exact money"
})

/**
 * The result of / over each SQL type: integer division truncates over the exact integers, money / money is double
 * precision, numeric and the floats keep theirs.
 */
export interface QuotientSql {
	readonly smallint: "exact integer"
	readonly integer: "exact integer"
	readonly bigint: "exact integer"
	readonly numeric: "numeric"
	readonly real: "real"
	readonly "double precision": "double precision"
	readonly money: "double precision"
	readonly "exact integer": "exact integer"
	readonly "exact money": "double precision"
}

export const quotientSql: QuotientSql = Object.freeze({
	smallint: "exact integer",
	integer: "exact integer",
	bigint: "exact integer",
	numeric: "numeric",
	real: "real",
	"double precision": "double precision",
	money: "double precision",
	"exact integer": "exact integer",
	"exact money": "double precision"
})

/** gcd's and lcm's result: the integers' exact, numeric's numeric. */
export interface DivisorSql {
	readonly smallint: "exact integer"
	readonly integer: "exact integer"
	readonly bigint: "exact integer"
	readonly numeric: "numeric"
	readonly "exact integer": "exact integer"
}

export const divisorSql: DivisorSql = Object.freeze({
	smallint: "exact integer",
	integer: "exact integer",
	bigint: "exact integer",
	numeric: "numeric",
	"exact integer": "exact integer"
})

/** % over each SQL type: an integer's remainder keeps its type, as it fits its divisor's; numeric's numeric. */
export interface RemainderSql {
	readonly smallint: "smallint"
	readonly integer: "integer"
	readonly bigint: "bigint"
	readonly numeric: "numeric"
	readonly "exact integer": "exact integer"
}

export const remainderSql: RemainderSql = Object.freeze({
	smallint: "smallint",
	integer: "integer",
	bigint: "bigint",
	numeric: "numeric",
	"exact integer": "exact integer"
})

/**
 * SUM's result type: smallint and integer give bigint, bigint and numeric numeric, the floats keep theirs, money and
 * the exact values an exact one (scalar/aggregate.ts).
 */
export interface SumSql {
	readonly smallint: "bigint"
	readonly integer: "bigint"
	readonly bigint: "numeric"
	readonly numeric: "numeric"
	readonly real: "real"
	readonly "double precision": "double precision"
	readonly money: "exact money"
	readonly "exact integer": "exact integer"
	readonly "exact money": "exact money"
}

export const sumSql: SumSql = Object.freeze({
	smallint: "bigint",
	integer: "bigint",
	bigint: "numeric",
	numeric: "numeric",
	real: "real",
	"double precision": "double precision",
	money: "exact money",
	"exact integer": "exact integer",
	"exact money": "exact money"
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
	readonly "exact integer": "numeric"
}

export const avgSql: AvgSql = Object.freeze({
	smallint: "numeric",
	integer: "numeric",
	bigint: "numeric",
	numeric: "numeric",
	real: "double precision",
	"double precision": "double precision",
	"exact integer": "numeric"
})
