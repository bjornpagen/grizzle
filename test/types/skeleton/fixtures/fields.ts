import type { Brand } from "effect"
import { Compute } from "#compiler/public/compute.ts"
import {
	contract,
	Decimal,
	Money,
	pg,
	span,
	type Uuid,
	type uuid
} from "#compiler/public/fields.ts"
import { str } from "#compiler/public/text.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import type { ComputedOrigin, Term, TypeOfTerm } from "#compiler/types/core/phantom.ts"
import type {
	Contract,
	Field,
	Infer,
	IntegerLike,
	LiteralOf,
	SerialField
} from "#compiler/types/fields/field.ts"
import { Cents, type Ein, type EpochDay, type Rate } from "#test/types/skeleton/fixtures/work.ts"
import type { Equals, Expect, IsAssignable, Not } from "#test/types/skeleton/support.ts"

/**
 * Fields, contracts and scalar typing over declare-only values. Every `@ts-expect-error -- TSnnnn` names the diagnostic the harness requires on the next line.
 *
 * Infer<typeof Cents> is bigint & Brand<"Cents">.
 */
export type CentsHost = Expect<Equals<Infer<typeof Cents>, bigint & Brand.Brand<"Cents">>>
export type RateHost = Expect<Equals<Infer<typeof Rate>, Decimal & Brand.Brand<"Rate">>>
/** The base is str.regex("^\\d{2}-\\d{7}$"), whose host type ArkRegex infers as a template. */
export type EinHost = Expect<Equals<Infer<typeof Ein>, `${number}-${number}` & Brand.Brand<"Ein">>>
export type UuidHost = Expect<Equals<Infer<typeof uuid>, Uuid>>
export type MoneyHost = Expect<Equals<Infer<typeof pg.money>, Money>>
export type NumericHost = Expect<Equals<Infer<ReturnType<typeof pg.numeric>>, Decimal>>
export type BigserialHost = Expect<Equals<Infer<typeof pg.bigserial>, bigint>>

/** Two contracts over one base are mutually unassignable, as descriptors and as host values. */
export type ContractsDistinct = Expect<Not<IsAssignable<typeof Cents, typeof EpochDay>>>
export type ContractsDistinctReverse = Expect<Not<IsAssignable<typeof EpochDay, typeof Cents>>>
export type HostsDistinct = Expect<Not<IsAssignable<Infer<typeof Cents>, Infer<typeof EpochDay>>>>
export type HostsDistinctReverse = Expect<
	Not<IsAssignable<Infer<typeof EpochDay>, Infer<typeof Cents>>>
>
/** A contract and its bare base: the brand only narrows. */
export type ContractNarrowsBase = Expect<IsAssignable<Infer<typeof Cents>, bigint>>
export type BaseIsNotContract = Expect<Not<IsAssignable<bigint, Infer<typeof Cents>>>>
/** Contracts with identical bases and predicates are still different types. */
export const Cents2 = contract("Cents2", pg.bigint, (v) => v.ge(0n))
export type IdenticalPredicatesDistinct = Expect<
	Not<IsAssignable<Infer<typeof Cents2>, Infer<typeof Cents>>>
>
export type ContractShape = Expect<Equals<typeof Cents, Contract<"Cents", Field<bigint, "bigint">>>>

/** The contract value is an unchecked brand constructor. */
export const twelve: Infer<typeof Cents> = Cents(1250n)
// @ts-expect-error -- TS2322: a bare bigint is not a Cents
export const notCents: Infer<typeof Cents> = 1250n

/** A serial descriptor is not IntegerLike, so it is not a span endpoint. */
export type SerialIsNotIntegerLike = Expect<Not<IsAssignable<typeof pg.serial, IntegerLike>>>
export type BigserialIsNotIntegerLike = Expect<Not<IsAssignable<typeof pg.bigserial, IntegerLike>>>
export type AnySerialIsNotIntegerLike = Expect<
	Not<IsAssignable<SerialField<number, "integer">, IntegerLike>>
>
export type IntegerIsIntegerLike = Expect<IsAssignable<typeof pg.integer, IntegerLike>>
export type BigintIsIntegerLike = Expect<IsAssignable<typeof pg.bigint, IntegerLike>>
export type ContractIsIntegerLike = Expect<IsAssignable<typeof Cents, IntegerLike>>
export type SmallintIsNotIntegerLike = Expect<Not<IsAssignable<typeof pg.smallint, IntegerLike>>>
export type NumericIsNotIntegerLike = Expect<
	Not<IsAssignable<ReturnType<typeof pg.numeric>, IntegerLike>>
>
/** A serial is still a field: a relation may declare one. */
export type SerialIsAField = Expect<IsAssignable<typeof pg.serial, Field<number, "integer">>>

export const CentsSpan = span(Cents)
export type SpanEndpointsBranded = Expect<
	Equals<Infer<typeof CentsSpan>, Span<Infer<typeof Cents>>>
>
export const DaySpan = span(pg.integer, 1)
// @ts-expect-error -- TS2345: a serial is not a span endpoint
export const SerialSpan = span(pg.serial)
// @ts-expect-error -- TS2345: smallint is not a span endpoint
export const SmallSpan = span(pg.smallint)
/**
 * A contract over a serial is neither a contract nor a span endpoint: a serial is a generation declaration, not a
 * value domain, and PostgreSQL has no identity column over a domain.
 */
// @ts-expect-error -- TS2345 refusal: a contract is a value domain; a serial is a generation declaration, so use its integer type
export const SerialContractSpan = span(contract("SerialId", pg.serial))
export type SerialContractIsNotIntegerLike = Expect<
	Not<IsAssignable<Contract<"SerialId", SerialField<number, "integer">>, IntegerLike>>
>

export type BigserialContractIsNotIntegerLike = Expect<
	Not<IsAssignable<Contract<"SerialId", SerialField<bigint, "bigint">>, IntegerLike>>
>

export type NestedSerialContractIsNotIntegerLike = Expect<
	Not<
		IsAssignable<
			Contract<"Outer", Contract<"SerialId", SerialField<bigint, "bigint">>>,
			IntegerLike
		>
	>
>

export type NestedContractIsIntegerLike = Expect<
	IsAssignable<Contract<"Outer", typeof Cents>, IntegerLike>
>

/**
 * A literal over a Decimal is a Decimal, a bigint or an exact decimal string, never a JS number; a
 * literal against a contract term adopts the contract's base.
 */
export type DecimalLiteral = Expect<Equals<LiteralOf<Decimal>, Decimal | bigint | string>>
export type RateLiteral = Expect<Equals<LiteralOf<Infer<typeof Rate>>, Decimal | bigint | string>>
export type CentsLiteral = Expect<Equals<LiteralOf<Infer<typeof Cents>>, bigint>>
export type NumberIsNotANumericLiteral = Expect<Not<IsAssignable<number, LiteralOf<Decimal>>>>
// @ts-expect-error -- TS2345: a JavaScript number is never a numeric literal
export const rateCheck = contract("BadRate", pg.numeric(7, 6), (v) => v.between(0, 1))
export const rateOk = contract("GoodRate", pg.numeric(7, 6), (v) => v.between("0.000000", 1n))

/**
 * Arithmetic on contract values drops the brand: over bigint it is the exact integer, delivered as bigint; a cast
 * re-enters the contract.
 */
declare const cents: Term<Infer<typeof Cents>, unknown, unknown, "bigint">
declare const plainBigint: Term<bigint, unknown, unknown, "bigint">
declare const rate: Term<Infer<typeof Rate>, unknown, unknown, "numeric">
export const doubled = Compute.mul(cents, 2n)
export type ArithmeticYieldsBase = Expect<
	Equals<typeof doubled, Term<bigint, unknown, ComputedOrigin<unknown>, "exact integer">>
>
export const reentered = Compute.cast(doubled, Cents)
export type CastReenters = Expect<Equals<TypeOfTerm<typeof reentered>, Infer<typeof Cents>>>
export const based = Compute.base(cents)
export type BaseDropsBrand = Expect<Equals<TypeOfTerm<typeof based>, bigint>>
export const rounded = Compute.round(rate, 2)
export type RoundIsNumeric = Expect<Equals<TypeOfTerm<typeof rounded>, Decimal>>
// @ts-expect-error -- TS2345: a contract term never meets its bare base without Compute.base
export const mixed = Compute.add(cents, plainBigint)
// @ts-expect-error -- TS2345: a bare base never meets a contract term
export const mixedReversed = Compute.add(plainBigint, cents)
// @ts-expect-error -- TS2345: round is numeric only
export const roundedInt = Compute.round(cents)
/** The exact host carriers have static constructors. */
export const exactCarriers: Readonly<
	Record<"half" | "fromBigint" | "fromDecimal" | "fromNumber", Decimal>
> = {
	half: Decimal.of("0.5"),
	fromBigint: Decimal.of(2n),
	fromDecimal: Decimal.of(Decimal.of("0.5")),
	// @ts-expect-error -- TS2345: a JavaScript number is never an exact decimal
	fromNumber: Decimal.of(0.5)
}
export const fee: Money = Money.of(1250n)
export type FeeMinorUnits = Expect<Equals<typeof fee.minorUnits, bigint>>
// @ts-expect-error -- TS2345: money is minor units, a bigint
export const feeFromNumber = Money.of(12.5)
export const bodyLength = contract("Body", str.regex("^.*$", "su"), (v) =>
	Compute.charLength(v).le(2000)
)
