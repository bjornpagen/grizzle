import type { Brand } from "effect"
import { type Column, convertColumn } from "#compiler/core/decoder.ts"
import {
	type ClosedIdField,
	type Contract,
	closedId,
	contract,
	Decimal,
	type Field,
	type FloatField,
	type Infer,
	type IntegerLike,
	type LiteralOf,
	Money,
	type NumericTypmodField,
	pg,
	type SerialField,
	type Span,
	type SpanField,
	span,
	type uuid,
	type Vector
} from "#compiler/public/fields.ts"
import { closed } from "#compiler/public/schema.ts"
import type { Equals, Expect, IsAssignable, Not } from "#test/types/fields/support.ts"

/**
 * The public field descriptor types: brands, alias identity, typmod arguments as runtime numbers, span endpoint and
 * width typing, and LiteralOf. Typechecked only. Every `@ts-expect-error -- TSnnnn` names the diagnostic the harness
 * requires on the next line.
 *
 * Columns: a descriptor's host type is its column's, the conversion its builder made, so a descriptor built from
 * another carrier's conversion does not compile: pg.bigint over the int4 conversion (Number) is no bigint field.
 */
export type BigintColumn = Expect<Equals<(typeof pg.bigint)["column"], Column<bigint>>>
export type CentsColumn = Expect<
	Equals<(typeof Cents)["column"], Column<bigint & Brand.Brand<"Cents">>>
>
// @ts-expect-error -- TS2322: the int4 conversion yields numbers, which no bigint field's column delivers
export const int4Bigint: Field<bigint, "bigint"> = { ...pg.bigint, column: convertColumn(Number) }

/** Brands: a contract's host type is its base's, branded with its name. */
export const Cents = contract("Cents", pg.bigint, (v) => v.ge(0n))
export const EpochDay = contract("EpochDay", pg.bigint)
export const Rate = contract("Rate", pg.numeric(7, 6), (v) => v.between(0n, "1"))
export type CentsHost = Expect<Equals<Infer<typeof Cents>, bigint & Brand.Brand<"Cents">>>
export type RateHost = Expect<Equals<Infer<typeof Rate>, Decimal & Brand.Brand<"Rate">>>
export type CentsShape = Expect<Equals<typeof Cents, Contract<"Cents", Field<bigint, "bigint">>>>
export type BrandsDistinct = Expect<Not<IsAssignable<Infer<typeof Cents>, Infer<typeof EpochDay>>>>
export type BrandNarrowsBase = Expect<IsAssignable<Infer<typeof Cents>, bigint>>
export type BaseIsNoBrand = Expect<Not<IsAssignable<bigint, Infer<typeof Cents>>>>
export const branded: Infer<typeof Cents> = Cents(1250n)
// @ts-expect-error -- TS2322: a bare bigint is not a Cents
export const unbranded: Infer<typeof Cents> = 1250n
// @ts-expect-error -- TS2322: an EpochDay is not a Cents
export const crossBranded: Infer<typeof Cents> = EpochDay(5n)
// @ts-expect-error -- TS2345: the brand constructor takes the base's host type
export const wrongHost = Cents(12)
/** A contract over a contract brands twice, and still narrows to the inner brand. */
export const Outer = contract("Outer", Cents)
export type OuterHost = Expect<
	Equals<Infer<typeof Outer>, bigint & Brand.Brand<"Cents"> & Brand.Brand<"Outer">>
>
// @ts-expect-error -- TS2345 refusal: a contract is a value domain; a serial is a generation declaration, so use its integer type
export const serialContract = contract("Id", pg.serial)
/**
 * A contract's name is its brand, so it is one literal: a union of names would brand its values with every one of them.
 */
declare const eitherName: "Cents" | "Dollars"
// @ts-expect-error -- TS2345 refusal: a contract's name is one literal, the brand of its values
export const eitherContract = contract(eitherName, pg.bigint)
declare const anyName: string
// @ts-expect-error -- TS2345 refusal: a contract's name is one literal, the brand of its values
export const stringContract = contract(anyName, pg.bigint)
declare const suffixed: `${string}Cents`
// @ts-expect-error -- TS2345 refusal: a contract's name is one literal, the brand of its values
export const templateContract = contract(suffixed, pg.bigint)

/** LiteralOf: a JavaScript number is never a numeric literal. */
export type DecimalLiteral = Expect<Equals<LiteralOf<Decimal>, Decimal | bigint | string>>
export type RateLiteral = Expect<Equals<LiteralOf<Infer<typeof Rate>>, Decimal | bigint | string>>
export type NumberNotNumeric = Expect<Not<IsAssignable<number, LiteralOf<Decimal>>>>
export type CentsLiteral = Expect<Equals<LiteralOf<Infer<typeof Cents>>, bigint>>
export type IntegerLiteral = Expect<Equals<LiteralOf<Infer<typeof pg.integer>>, number>>
export type MoneyLiteral = Expect<Equals<LiteralOf<Money>, Money>>
// @ts-expect-error -- TS2345: a JavaScript number is never a numeric literal
export const numberRate = contract("NumberRate", pg.numeric(7, 6), (v) => v.le(0.062))
export const stringRate = contract("StringRate", pg.numeric(7, 6), (v) => v.le("0.062"))
export const decimalRate = contract("DecimalRate", pg.numeric(7, 6), (v) =>
	v.le(Decimal.of("0.062"))
)
// @ts-expect-error -- TS2345: a bigint is not an integer literal
export const bigintBasis = contract("Basis", pg.integer, (v) => v.between(0n, 10000n))
export const fee: Money = Money.of(1250n)

/** Aliases are the same descriptors. */
export type IntAlias = Expect<Equals<typeof pg.int, typeof pg.integer>>
export type Int4Alias = Expect<Equals<typeof pg.int4, typeof pg.integer>>
export type Int2Alias = Expect<Equals<typeof pg.int2, typeof pg.smallint>>
export type Int8Alias = Expect<Equals<typeof pg.int8, typeof pg.bigint>>
export type Float4Alias = Expect<Equals<typeof pg.float4, typeof pg.real>>
export type Float8Alias = Expect<Equals<typeof pg.float8, (typeof pg)["double precision"]>>
export type FloatIsDouble = Expect<IsAssignable<typeof pg.float, (typeof pg)["double precision"]>>
export type BoolAlias = Expect<Equals<typeof pg.bool, typeof pg.boolean>>
export type DecimalAlias = Expect<Equals<typeof pg.decimal, typeof pg.numeric>>
export type Serial2Alias = Expect<Equals<typeof pg.serial2, typeof pg.smallserial>>
export type Serial4Alias = Expect<Equals<typeof pg.serial4, typeof pg.serial>>
export type Serial8Alias = Expect<Equals<typeof pg.serial8, typeof pg.bigserial>>
export type UuidHost = Expect<Equals<Infer<typeof uuid>, string>>
export type BigserialHost = Expect<Equals<typeof pg.bigserial, SerialField<bigint, "bigint">>>

/** float(p) selects real for 1-24 and double precision for 25-53 at runtime: the type is either. */
export const f24 = pg.float(24)
export type Float24 = Expect<Equals<typeof f24, FloatField>>
export const f53 = pg.float(53)
export type Float53 = Expect<
	Equals<typeof f53, Field<number, "real"> | Field<number, "double precision">>
>
// @ts-expect-error -- TS2322: float's choice is a runtime value, so pg.float(24) is not typed real
export const f24Real: Field<number, "real"> = pg.float(24)
// @ts-expect-error -- TS2345: a float precision is a number
export const fText = pg.float("24")

/** numeric(p, s): precision and scale are runtime values; numeric(p) is numeric(p, 0). */
export const n186 = pg.numeric(18, 6)
export type Numeric186 = Expect<Equals<typeof n186, NumericTypmodField>>
export const n5 = pg.numeric(5)
export const d72 = pg.decimal(7, 2)
export type Decimal72 = Expect<Equals<typeof d72, NumericTypmodField>>
export type NumericHost = Expect<Equals<Infer<typeof n186>, Decimal>>
export type TypmodPrecision = Expect<Equals<typeof n186.precision, number>>
export const wide = pg.numeric(1000, -1000)
export const scaled = pg.numeric(1, 1000)
// @ts-expect-error -- TS2345: a numeric precision is a number
export const nText = pg.numeric("18")

/** pg.vector(n): model-agnostic, its dimension count an equality-only literal tag. */
export const docs = pg.vector(1536)
export type DocsDims = Expect<Equals<typeof docs.dimensions, 1536>>
export type DocsHost = Expect<Equals<Infer<typeof docs>, Vector<1536>>>
export const raw = pg.vector(3)
export type RawIsNoDocs = Expect<Not<IsAssignable<typeof raw, typeof docs>>>
export const maxed = pg.vector(16000)
// @ts-expect-error -- TS2345: vector dimensions are a number
export const textDims = pg.vector("3")

/** Span endpoints and widths of the endpoint's base type. */
export const intSpan = span(pg.integer)
export type IntSpan = Expect<Equals<Infer<typeof intSpan>, Span<number>>>
export const int4Span = span(pg.int4, 7)
export const int8Span = span(pg.int8, 15n)
export type Int8Span = Expect<Equals<Infer<typeof int8Span>, Span<bigint>>>
export const centsSpan = span(Cents, 15n)
export type CentsSpanHost = Expect<Equals<Infer<typeof centsSpan>, Span<Infer<typeof Cents>>>>
export type CentsSpanWidth = Expect<Equals<NonNullable<typeof centsSpan.width>, bigint>>
export type CentsSpanShape = Expect<Equals<typeof centsSpan, SpanField<Infer<typeof Cents>>>>
export type BigintIsEndpoint = Expect<IsAssignable<typeof pg.int8, IntegerLike>>
export type ContractIsEndpoint = Expect<IsAssignable<typeof Cents, IntegerLike>>
export type Int2IsNoEndpoint = Expect<Not<IsAssignable<typeof pg.int2, IntegerLike>>>
export type Serial4IsNoEndpoint = Expect<Not<IsAssignable<typeof pg.serial4, IntegerLike>>>
// @ts-expect-error -- TS2345: smallint is not a span endpoint
export const smallSpan = span(pg.int2)
// @ts-expect-error -- TS2345: a serial is not a span endpoint
export const serialSpan = span(pg.serial8)
// @ts-expect-error -- TS2345: money is not a span endpoint
export const moneySpan = span(pg.money)
// @ts-expect-error -- TS2345: numeric is not a span endpoint
export const numericSpan = span(pg.numeric(10, 0))
// @ts-expect-error -- TS2345: a width over integer is a number
export const bigintWidth = span(pg.integer, 15n)
// @ts-expect-error -- TS2345: a width over bigint is a bigint
export const numberWidth = span(pg.bigint, 15)

/** closedId: the roster's handles. */
export const Kind = closed("Kind", ["Automatic", "Manual"])
export const kind = closedId(Kind)
export type KindHost = Expect<Equals<Infer<typeof kind>, "Automatic" | "Manual">>
export type KindShape = Expect<Equals<typeof kind, ClosedIdField<typeof Kind>>>
export const Mode = contract("Mode", kind, (v) => v.ne("Manual"))
// @ts-expect-error -- TS2345: a literal of a closed reference is one of its handles
export const badMode = contract("BadMode", kind, (v) => v.ne("Unknown"))
