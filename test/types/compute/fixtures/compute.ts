import type { Brand } from "effect"
import type { Phantom } from "#compiler/core/phantom.ts"
import { Compute } from "#compiler/public/compute.ts"
import { contract, pg, type Uuid, uuid } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { Money } from "#compiler/scalar/values/money.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import type {
	ParamOrigin,
	ParamType,
	Predicate,
	SqlOfCarrier,
	SqlOfTerm,
	Term,
	TypeOfTerm
} from "#compiler/types/core/phantom.ts"
import type { Infer } from "#compiler/types/fields/field.ts"
import type { ParamsOf } from "#compiler/types/query/query.ts"
import type { Rule } from "#compiler/types/query/rule.ts"
import type { Aggregate } from "#compiler/types/query/terms.ts"
import { query, v } from "#index.ts"
import type { Equals, Expect } from "#test/types/compute/support.ts"

/**
 * The type gate over the Compute catalogue's public types: brands flow from declarations, literals and casts only;
 * LiteralOf refuses a JavaScript number for numeric; each operation refuses the operand SQL types PostgreSQL defines no
 * overload for; computed terms carry their SQL type, so aggregates over them take PostgreSQL's result types; and the
 * gaps grizzle fills with native compositions (sign over the integer types, gcd and lcm over smallint) keep the operand's
 * type. Every `@ts-expect-error -- TSnnnn` names the diagnostic the runner requires on the next line.
 */
const Cents = contract("Cents", pg.bigint, (x) => x.ge(0n))
const Rate = contract("Rate", pg.numeric(7, 6), (x) => x.between(0n, 1n))
const EpochDay = contract("EpochDay", pg.bigint)

type CentsHost = Infer<typeof Cents>
type ParamsOfT<X> =
	X extends Phantom<{ readonly params: infer P }> ? { readonly [K in keyof P]: P[K] } : never
/** The names of a program's parameters: never for one that takes none. */
type ParamNamesOfT<X> = keyof ParamsOfT<X>
/** The host type an aggregate delivers. */
type AggregateHost<X> = X extends Aggregate<infer T> ? T : never

declare const cents: Term<CentsHost, unknown, unknown, "bigint">
declare const day: Term<Infer<typeof EpochDay>, unknown, unknown, "bigint">
declare const big: Term<bigint, unknown, unknown, "bigint">
declare const int: Term<number, unknown, unknown, "integer">
declare const small: Term<number, unknown, unknown, "smallint">
declare const real: Term<number, unknown, unknown, "real">
declare const dbl: Term<number, unknown, unknown, "double precision">
/** A number of unknown SQL type: any of smallint, integer, real and double precision. */
declare const unknownNumber: Term<number>
declare const dec: Term<Decimal, unknown, unknown, "numeric">
/** A Rate host value: a Decimal carrying Rate's brand. */
declare const rateDecimal: Decimal & Brand.Brand<"Rate">
declare const rate: Term<Infer<typeof Rate>, unknown, unknown, "numeric">
declare const money: Term<Money, unknown, unknown, "money">
declare const flag: Term<boolean, unknown, unknown, "boolean">
declare const text: Term<string, unknown, unknown, "text">
declare const id: Term<Uuid, unknown, unknown, "uuid">
declare const centsSpan: Term<Span<CentsHost>, unknown, unknown, "range">
declare const p: Predicate<{ readonly x: bigint }>
declare const nInt: Term<number, { readonly n: number }, ParamOrigin, "integer">
declare const nSmall: Term<number, { readonly n: number }, ParamOrigin, "smallint">
declare const nCents: Term<CentsHost, { readonly n: CentsHost }, ParamOrigin, "bigint">
declare const r: Rule<typeof Shop>
declare const unit: Money

/**
 * Brands: a contract's host type is its base branded with its name, and flows only from declarations,
 * literals and casts.
 */
export type CentsBrand = Expect<Equals<CentsHost, bigint & Brand.Brand<"Cents">>>
export const reentered = Compute.cast(Compute.add(cents, 1n), Cents)
export type CastBrand = Expect<Equals<TypeOfTerm<typeof reentered>, CentsHost>>
/** Arithmetic yields the base, never the contract. */
export const doubled = Compute.mul(cents, 2n)
export type ArithmeticBase = Expect<Equals<TypeOfTerm<typeof doubled>, bigint>>
/** Integer and money arithmetic is exact: an exact integer delivered as bigint, exact money as Money. */
export type ExactSql = Expect<Equals<SqlOfTerm<typeof doubled>, "exact integer">>
export const intSum = Compute.add(int, 1)
export type IntSumHost = Expect<Equals<TypeOfTerm<typeof intSum>, bigint>>
export const moneySum = Compute.add(money, unit)
export type MoneySumSql = Expect<Equals<SqlOfTerm<typeof moneySum>, "exact money">>
/** An exact integer meets the plain integers it was computed from: a comparison, a branch, a further operand. */
export const exactBelowInt = Compute.lt(intSum, int)
export const exactPlusInt = Compute.add(intSum, int)
// @ts-expect-error -- TS2345: opposite an exact integer a literal is a bigint
export const exactPlusNumber = Compute.add(intSum, 1)
/** Float arithmetic is IEEE 754 and partial nowhere: a quotient by any double is defined. */
export const floatQuotient = Compute.div(dbl, dbl)
export type FloatQuotient = Expect<Equals<SqlOfTerm<typeof floatQuotient>, "double precision">>
/** LEAST, GREATEST, CASE and the span endpoints return an input unchanged, so they keep the contract. */
export const lowest = Compute.least(cents, cents)
export type LeastBrand = Expect<Equals<TypeOfTerm<typeof lowest>, CentsHost>>
export const chosen = Compute.cond(flag, cents, 0n)
export type CondBrand = Expect<Equals<TypeOfTerm<typeof chosen>, CentsHost>>
/** An endpoint is read with the span's own endpoint descriptor, whose column delivers it. */
export const start = Compute.lower(centsSpan, Cents)
export type LowerSql = Expect<Equals<SqlOfTerm<typeof start>, "bigint">>
// @ts-expect-error -- TS2345: Cents's base is no endpoint descriptor of a span of Cents
export const bareEndpoint = Compute.lower(centsSpan, pg.bigint)
/** Two contracts over one base never meet, nor does a contract meet its base. */
// @ts-expect-error -- TS2345: EpochDay is not Cents
export const mixedContracts = Compute.add(cents, day)
// @ts-expect-error -- TS2345: a contract never meets its bare base without Compute.base
export const mixedBase = Compute.eq(cents, big)
export const based = Compute.eq(Compute.base(cents), big)
export type BasedParams = Expect<Equals<ParamNamesOfT<typeof based>, never>>

/** LiteralOf: over numeric, a Decimal, a bigint or an exact decimal string, never a JavaScript number. */
export const timesBig = Compute.mul(dec, 2n)
export const timesText = Compute.mul(dec, "2.50")
export const timesDecimal = Compute.mul(rate, rateDecimal)
export type DecimalProduct = Expect<Equals<TypeOfTerm<typeof timesText>, Decimal>>
// @ts-expect-error -- TS2345: a JavaScript number is never a numeric literal
export const timesNumber = Compute.mul(dec, 2)
// @ts-expect-error -- TS2345: a JavaScript number is never a numeric literal, in a comparison either
export const comparedToNumber = Compute.le(rate, 0.5)
// @ts-expect-error -- TS2345: Compute.literal over numeric takes no JavaScript number
export const numericLiteral = Compute.literal(pg.numeric, 1)
// @ts-expect-error -- TS2322: an IN list over numeric takes no JavaScript number
export const numericIn = Compute.in(dec, [1])
export const numericInOk = Compute.in(dec, [1n, "0.5"])
/** Over bigint a literal is a bigint, over integer a JavaScript integer. */
// @ts-expect-error -- TS2345: a JavaScript number is no bigint literal
export const bigintNumber = Compute.add(big, 1)
// @ts-expect-error -- TS2345: a bigint is no integer literal
export const integerBigint = Compute.add(int, 1n)
/**
 * The operands of an operation are of one SQL type, as the lowering checks them; an integer term meets a smallint one
 * through a cast.
 */
// @ts-expect-error -- TS2345: operands of one SQL type: a smallint never meets an integer
export const smallBelowInt = Compute.lt(small, int)
// @ts-expect-error -- TS2345: arithmetic operands of one SQL type
export const smallPlusInt = Compute.add(small, int)
export const smallBelowCast = Compute.lt(small, Compute.cast(int, pg.smallint))

/**
 * A partial operation needs its precondition proved in its type: a divisor nonzero, by a literal's own type, a
 * contract's declared facts or a guard's branch.
 */
// @ts-expect-error -- TS2345 refusal: a divisor proved nonzero: guard it with Compute.when(Compute.nonzero(x), (x) => …, otherwise)
export const unguardedQuotient = Compute.div(int, int)
// @ts-expect-error -- TS2345 refusal: a divisor proved nonzero: guard it with Compute.when(Compute.nonzero(x), (x) => …, otherwise)
export const zeroQuotient = Compute.div(int, 0)
export const literalQuotient = Compute.div(int, 7)
export type LiteralQuotient = Expect<Equals<TypeOfTerm<typeof literalQuotient>, bigint>>
export const guardedQuotient = Compute.when(
	Compute.nonzero(int),
	(d) => Compute.div(big, Compute.cast(d, pg.bigint)),
	0n
)
export type GuardedQuotient = Expect<Equals<TypeOfTerm<typeof guardedQuotient>, bigint>>
/** An integer's remainder keeps its type: it fits its divisor's. */
export const guardedRemainder = Compute.when(Compute.positive(int), (d) => Compute.mod(int, d), 0)
export type GuardedRemainder = Expect<Equals<TypeOfTerm<typeof guardedRemainder>, number>>
/** A guard is a predicate too. */
export const guardAsPredicate: Predicate = Compute.nonzero(int)
const Divisor = contract("Divisor", pg.integer, (x) => x.ne(0), { proves: ["nonzero"] })
declare const divisor: Term<
	Infer<typeof Divisor>,
	unknown,
	unknown,
	"integer",
	Infer<typeof Divisor>,
	{ readonly nonzero: true }
>
export const contractQuotient = Compute.div(int, Compute.base(divisor))
/**
 * A parameter stands where any term does: a guard's subject, whose branch receives it refined, and Compute.base's
 * operand; a parameter of a contract that declares nonzero divides unguarded, its binding checking every value.
 */
export const paramGuardedQuotient = Compute.when(
	Compute.nonzero(nInt),
	(d) => Compute.div(int, d),
	0n
)
export type ParamGuardedQuotient = Expect<Equals<TypeOfTerm<typeof paramGuardedQuotient>, bigint>>
export type ParamGuardedQuotientParams = Expect<
	Equals<ParamsOfT<typeof paramGuardedQuotient>, { readonly n: number }>
>
// @ts-expect-error -- TS2345 refusal: a divisor proved nonzero: guard it with Compute.when(Compute.nonzero(x), (x) => …, otherwise)
export const unguardedParamQuotient = Compute.div(int, nInt)
export const paramBase = Compute.base(nCents)
export type ParamBase = Expect<Equals<TypeOfTerm<typeof paramBase>, bigint>>
// @ts-expect-error -- TS2345 refusal: a radicand proved nonnegative: guard it with Compute.when(Compute.nonnegative(x), (x) => …, otherwise)
export const unguardedRoot = Compute.sqrt(dec)
export const guardedRoot = Compute.when(Compute.nonnegative(dec), (x) => Compute.sqrt(x), 0n)
export const floatRoot = Compute.sqrt(dbl)
// @ts-expect-error -- TS2345 refusal: a value proved finite: guard it with Compute.when(Compute.isFinite(x), (x) => …, otherwise)
export const unguardedScale = Compute.minScale(dec)
export const guardedScale = Compute.when(Compute.isFinite(dec), (x) => Compute.minScale(x), 0)
/** A within guard proves nonnegative and nonzero from its bounds' literal types. */
export const withinPower = Compute.when(
	Compute.within(dec, 1n, 10n),
	(x) => Compute.power(x, 2n),
	0n
)
// @ts-expect-error -- TS2345 refusal: a power's base proved nonnegative, and nonzero or its exponent nonnegative: guard it with Compute.when(Compute.positive(x), (x) => …, otherwise)
export const unguardedPower = Compute.power(dec, 2n)

/** Operand families. */
export const moneyRatio = Compute.when(Compute.nonzero(money), (m) => Compute.div(money, m), 0)
// @ts-expect-error -- TS2345: money has no product
export const moneyProduct = Compute.mul(money, money)
// @ts-expect-error -- TS2345: money has no %
export const moneyMod = Compute.mod(money, money)
// @ts-expect-error -- TS2345: money has no unary minus
export const moneyNeg = Compute.neg(money)
// @ts-expect-error -- TS2345: money has no abs
export const moneyAbs = Compute.abs(money)
// @ts-expect-error -- TS2345: booleans have no arithmetic
export const boolSum = Compute.add(flag, flag)
// @ts-expect-error -- TS2345: text has no arithmetic in the language
export const textSum = Compute.add(text, "x")
// @ts-expect-error -- TS2345: PostgreSQL has no % over double precision
export const floatMod = Compute.mod(dbl, 2)
// @ts-expect-error -- TS2345: power is numeric or double precision
export const intPower = Compute.power(int, 2)
// @ts-expect-error -- TS2345: power is numeric or double precision, and a number of unknown SQL type is neither
export const unknownPower = Compute.power(unknownNumber, 2)
// @ts-expect-error -- TS2345: sqrt is numeric or double precision
export const realSqrt = Compute.sqrt(real)
export const floatPower = Compute.when(Compute.positive(dbl), (x) => Compute.power(x, 0.5), 0)
export type FloatPower = Expect<Equals<TypeOfTerm<typeof floatPower>, number>>
export const intMod = Compute.mod(int, 3)
// @ts-expect-error -- TS2345: % is over the integer types and numeric, and a number of unknown SQL type may be a float
export const unknownMod = Compute.mod(unknownNumber, 3)
// @ts-expect-error -- TS2345: gcd over a float is no PostgreSQL function
export const floatGcd = Compute.gcd(dbl, dbl)

/** sign over an integer type and gcd over smallint are native compositions that keep the operand's type. */
export const intSign = Compute.sign(int)
export type IntSign = Expect<Equals<TypeOfTerm<typeof intSign>, number>>
export const smallGcd = Compute.gcd(small, nSmall)
export type SmallGcdParams = Expect<Equals<ParamsOfT<typeof smallGcd>, { readonly n: number }>>

/**
 * Casts: the numeric family and money convert where PostgreSQL has a cast; other bases only into their own refinements.
 */
export const toInteger = Compute.when(Compute.isFinite(dec), (x) => Compute.cast(x, pg.integer), 0)
export type ToInteger = Expect<Equals<TypeOfTerm<typeof toInteger>, number>>
// @ts-expect-error -- TS2345 refusal: a value proved finite: guard it with Compute.when(Compute.isFinite(x), (x) => …, otherwise)
export const unguardedToInteger = Compute.cast(dec, pg.integer)
/** An integer cast keeps its operand's finiteness, which its type states. */
export const intToNumeric = Compute.cast(int, pg.numeric)
export const scaleOfInt = Compute.minScale(intToNumeric)
export const moneyAmount = Compute.cast(money, pg.numeric)
export type MoneyAmount = Expect<Equals<TypeOfTerm<typeof moneyAmount>, Decimal>>
// @ts-expect-error -- TS2345 refusal: PostgreSQL has no cast between these types that Compute admits
export const textToInteger = Compute.cast(text, pg.integer)
// @ts-expect-error -- TS2345 refusal: PostgreSQL has no cast between these types that Compute admits
export const moneyToInteger = Compute.cast(money, pg.integer)
// @ts-expect-error -- TS2345 refusal: PostgreSQL has no cast between these types that Compute admits
export const flagToInteger = Compute.cast(flag, pg.integer)
// @ts-expect-error -- TS2345 refusal: PostgreSQL has no cast between these types that Compute admits
export const uuidToText = Compute.cast(id, str.regex("^.*$", "su"))
/** The numeric family converts in every direction, whatever the host types (the registry's cast table). */
export const intToDouble = Compute.cast(int, pg["double precision"])
export type IntToDouble = Expect<Equals<TypeOfTerm<typeof intToDouble>, number>>
export const intToSmall = Compute.cast(int, pg.smallint)
export const smallToInt = Compute.cast(small, pg.integer)
export const realToDouble = Compute.cast(real, pg.float8)
export const doubleToInt = Compute.when(Compute.isFinite(dbl), (x) => Compute.cast(x, pg.int), 0)
export const doubleToBig = Compute.when(
	Compute.isFinite(dbl),
	(x) => Compute.cast(x, pg.bigint),
	0n
)
export type DoubleToBig = Expect<Equals<TypeOfTerm<typeof doubleToBig>, bigint>>
export const bigToReal = Compute.cast(big, pg.real)
export const decToReal = Compute.cast(dec, pg.real)
export const decToRate = Compute.cast(dec, Rate)
export type DecToRate = Expect<Equals<TypeOfTerm<typeof decToRate>, Infer<typeof Rate>>>
/** Money is a target from integer, bigint and numeric only, and a source to numeric only. */
export const intToMoney = Compute.cast(int, pg.money)
export type IntToMoney = Expect<Equals<TypeOfTerm<typeof intToMoney>, Money>>
export const bigToMoney = Compute.cast(big, pg.money)
export const decToMoney = Compute.when(
	Compute.isFinite(dec),
	(x) => Compute.cast(x, pg.money),
	unit
)
export const centsToMoney = Compute.cast(cents, pg.money)
export const moneyToMoney = Compute.cast(money, pg.money)
// @ts-expect-error -- TS2345 refusal: PostgreSQL has no cast between these types that Compute admits
export const smallToMoney = Compute.cast(small, pg.money)
// @ts-expect-error -- TS2345 refusal: PostgreSQL has no cast between these types that Compute admits
export const realToMoney = Compute.cast(real, pg.money)
// @ts-expect-error -- TS2345 refusal: PostgreSQL has no cast between these types that Compute admits
export const doubleToMoney = Compute.cast(dbl, pg.money)
// @ts-expect-error -- TS2345 refusal: PostgreSQL has no cast between these types that Compute admits
export const unknownToMoney = Compute.cast(unknownNumber, pg.money)
// @ts-expect-error -- TS2345 refusal: PostgreSQL has no cast between these types that Compute admits
export const moneyToBig = Compute.cast(money, pg.bigint)
// @ts-expect-error -- TS2345 refusal: PostgreSQL has no cast between these types that Compute admits
export const moneyToDouble = Compute.cast(money, pg.float8)

/** Computed terms carry their SQL type, so aggregates take PostgreSQL's result types. */
export const sumOfIntegerProduct = r.sum(Compute.mul(int, 2))
export type SumOfIntegerProduct = Expect<Equals<AggregateHost<typeof sumOfIntegerProduct>, bigint>>
/** A conditional is typed by its first branch, a term: a literal first branch states its type with Compute.literal. */
export const conditional = Compute.cond(p, Compute.literal(pg.integer, 1), 0)
export const conditionalCountSum = r.sum(conditional)
export type ConditionalCountSum = Expect<Equals<AggregateHost<typeof conditionalCountSum>, bigint>>
export const bigConditional = Compute.cond(p, Compute.literal(pg.bigint, 1n), 0n)
export const bigConditionalSum = r.sum(bigConditional)
export type BigConditionalSum = Expect<Equals<AggregateHost<typeof bigConditionalSum>, Decimal>>
/** The other branch is a term of the first's type, a parameter among them, or a literal of it. */
export const moneyConditional = Compute.cond(p, Compute.literal(pg.money, unit), unit)
export type MoneyConditional = Expect<Equals<TypeOfTerm<typeof moneyConditional>, Money>>
export const flagConditional = Compute.cond(p, flag, false)
export type FlagConditional = Expect<Equals<TypeOfTerm<typeof flagConditional>, boolean>>
/** Over numeric the second literal is a Decimal, a bigint or an exact decimal string. */
export const decimalConditional = Compute.cond(p, dec, "0.25")
export const decimalBigConditional = Compute.cond(p, dec, 0n)
export type DecimalConditional = Expect<Equals<TypeOfTerm<typeof decimalConditional>, Decimal>>
export const paramConditional = Compute.cond(p, int, nInt)
export type ParamConditional = Expect<Equals<TypeOfTerm<typeof paramConditional>, number>>
export type ParamConditionalParams = Expect<
	Equals<ParamsOfT<typeof paramConditional>, { readonly x: bigint; readonly n: number }>
>
export const paramOpposite = Compute.cond(flag, cents, nCents)
export type ParamOpposite = Expect<
	Equals<ParamsOfT<typeof paramOpposite>, { readonly n: CentsHost }>
>
// @ts-expect-error -- TS2345: the first branch types the conditional, so it is a term, never a literal
export const literalFirst = Compute.cond(p, 1, 0)
/** A parameter is a term of its declared type, first included: the literal opposite it adopts that type. */
export const paramFirst = Compute.cond(p, nInt, 0)
export type ParamFirst = Expect<Equals<TypeOfTerm<typeof paramFirst>, number>>
// @ts-expect-error -- TS2345: an integer conditional's other branch is no bigint literal
export const mixedIntegerBigint = Compute.cond(p, int, 0n)
// @ts-expect-error -- TS2345: a branch opposite a bigint term is a bigint literal, not a JavaScript number
export const termAndNumber = Compute.cond(flag, big, 0)
/** SUM over smallint and integer is bigint, over bigint and numeric numeric; the floats and money keep their type. */
export const sumOfMoneyRatio = r.sum(moneyRatio)
export type SumOfMoneyRatio = Expect<Equals<AggregateHost<typeof sumOfMoneyRatio>, number>>
export const sumOfCents = r.sum(cents)
export type SumOfCents = Expect<Equals<AggregateHost<typeof sumOfCents>, Decimal>>
export const sumOfSmallint = r.sum(small)
export type SumOfSmallint = Expect<Equals<AggregateHost<typeof sumOfSmallint>, bigint>>
export const sumOfReal = r.sum(real)
export type SumOfReal = Expect<Equals<AggregateHost<typeof sumOfReal>, number>>
export type SumOfRealSql = Expect<Equals<SqlOfCarrier<typeof sumOfReal>, "real">>
export const sumOfMoney = r.sum(money)
export type SumOfMoney = Expect<Equals<AggregateHost<typeof sumOfMoney>, Money>>
/** AVG over the integer types and numeric is numeric, over the floats double precision; there is no AVG(money). */
export const meanOfInteger = r.mean(int)
export type MeanOfInteger = Expect<Equals<AggregateHost<typeof meanOfInteger>, Decimal>>
export const meanOfReal = r.mean(real)
export type MeanOfReal = Expect<Equals<AggregateHost<typeof meanOfReal>, number>>
export type MeanOfRealSql = Expect<Equals<SqlOfCarrier<typeof meanOfReal>, "double precision">>
export const meanOfBigint = r.mean(big)
export type MeanOfBigint = Expect<Equals<AggregateHost<typeof meanOfBigint>, Decimal>>
// @ts-expect-error -- TS2345: there is no AVG(money)
export const meanOfMoney = r.mean(money)

/** A typecheck over a schema: a query whose output is a Compute expression over its fields. */
export const Line = relation("Line", { id: uuid, qty: pg.integer, price: Cents, rate: Rate }, [
	"id"
])
export const Shop = schema("Shop", { Line }, [])
export const lines = query(Shop).rule((r) => {
	const { id: lineId, qty, price, rate: lineRate } = v(Line, "line")
	return r
		.match(Line, { id: lineId, qty, price, rate: lineRate })
		.where(r.gt(qty, r.param("minimum", pg.integer)))
		.find({
			id: lineId,
			total: Compute.mul(Compute.cast(price, pg.numeric), Compute.base(lineRate)),
			bucket: Compute.widthBucket(
				Compute.cast(qty, pg.numeric),
				Compute.literal(pg.numeric, 0n),
				Compute.literal(pg.numeric, 100n),
				r.param("buckets", pg.integer)
			)
		})
})

export type LinesParams = Expect<
	Equals<
		ParamsOf<typeof lines>,
		{
			readonly minimum: ParamType<number, "integer">
			readonly buckets: ParamType<number, "integer">
		}
	>
>

/** A parameter of a contract that declares nonzero divides unguarded, first through Compute.base. */
export const divisorParamQuotient = query(Shop).rule((r) => {
	const { id: lineId, qty } = v(Line, "line")
	return r
		.match(Line, { id: lineId, qty })
		.find({ id: lineId, share: Compute.div(qty, Compute.base(r.param("d", Divisor))) })
})
/** A plain parameter divides only under its guard, the branch receiving the refined parameter. */
export const guardedParamQuotient = query(Shop).rule((r) => {
	const { id: lineId, qty } = v(Line, "line")
	return r.match(Line, { id: lineId, qty }).find({
		id: lineId,
		share: Compute.when(Compute.nonzero(r.param("d", pg.integer)), (d) => Compute.div(qty, d), 0n)
	})
})
export const unguardedParamDivision = query(Shop).rule((r) => {
	const { id: lineId, qty } = v(Line, "line")
	return r.match(Line, { id: lineId, qty }).find({
		id: lineId,
		// @ts-expect-error -- TS2345 refusal: a divisor proved nonzero: guard it with Compute.when(Compute.nonzero(x), (x) => …, otherwise)
		share: Compute.div(qty, r.param("d", pg.integer))
	})
})
