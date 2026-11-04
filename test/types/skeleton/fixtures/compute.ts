import type { Phantom } from "#compiler/core/phantom.ts"
import { Compute } from "#compiler/public/compute.ts"
import { contract, pg, uuid } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import type { AggregateLowering, AggregateOverload } from "#compiler/scalar/aggregate.ts"
import type { FixedOp, OperandReading } from "#compiler/scalar/compute/registry.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import type { Decimal, DecimalParts, FiniteParts } from "#compiler/scalar/values/decimal.ts"
import type { Money } from "#compiler/scalar/values/money.ts"
import type { Vector } from "#compiler/scalar/values/vector.ts"
import type { Scalar } from "#compiler/types/compute/scalar.ts"
import type {
	ComputedOrigin,
	ParamOrigin,
	ParamType,
	Predicate,
	SqlOfTerm,
	Term,
	TypeOfTerm
} from "#compiler/types/core/phantom.ts"
import type { Infer, Span } from "#compiler/types/fields/field.ts"
import type { ParamsOf } from "#compiler/types/query/query.ts"
import { derived, query, v } from "#index.ts"
import { Cents, type Rate } from "#test/types/skeleton/fixtures/work.ts"
import type { Equals, Expect } from "#test/types/skeleton/support.ts"

/**
 * The Compute catalogue over declare-only terms: the
 * result type and parameter map of every member, and the refusals of the numeric-only, span-only, text-only,
 * space-only and same-type members. `computeCovered` lists every member, so a member added to the catalogue without
 * an entry here fails to typecheck. Every `@ts-expect-error -- TSnnnn` names the diagnostic the harness requires on
 * the next line.
 */
type CentsHost = Infer<typeof Cents>
/** A term's or predicate's parameter map, flattened for exact comparison. */
type ParamsOfT<X> =
	X extends Phantom<{ readonly params: infer P }> ? { readonly [K in keyof P]: P[K] } : never
/** The names of a program's parameters: never for one that takes none. */
type ParamNamesOfT<X> = keyof ParamsOfT<X>

/** A term of host type T and SQL type Sql. */
type Of<T, Sql extends SqlTag> = Term<T, unknown, unknown, Sql>
declare const cents: Of<CentsHost, "bigint">
declare const otherCents: Of<CentsHost, "bigint">
declare const plainBigint: Of<bigint, "bigint">
declare const int: Of<number, "integer">
declare const dec: Of<Decimal, "numeric">
declare const rate: Of<Infer<typeof Rate>, "numeric">
declare const money: Of<Money, "money">
declare const text: Of<string, "text">
declare const flag: Of<boolean, "boolean">
declare const centsSpan: Of<Span<CentsHost>, "range">
declare const intSpan: Of<Span<number>, "range">
declare const docs: Of<Vector<3>, "vector">
declare const wider: Of<Vector<4>, "vector">
declare const p: Predicate<{ readonly x: bigint }>
declare const q: Predicate<{ readonly y: string }>
/** Parameters: input terms of their descriptors' types, r.param(name, descriptor), each map entry its type. */
type ParamTerm<N extends string, T, Sql extends SqlTag> = Term<
	T,
	{ readonly [K in N]: ParamType<T, Sql> },
	ParamOrigin,
	Sql
>
declare const cCents: ParamTerm<"c", CentsHost, "bigint">
declare const cBig: ParamTerm<"c", bigint, "bigint">
declare const cText: ParamTerm<"c", string, "text">
declare const hiCents: ParamTerm<"hi", CentsHost, "bigint">
declare const hiDec: ParamTerm<"hi", Decimal, "numeric">
declare const hiInt: ParamTerm<"hi", number, "integer">

/** Literals, the explicit base, and casts. */
export const literal = Compute.literal(Cents, Cents(5n))
export type LiteralType = Expect<Equals<TypeOfTerm<typeof literal>, CentsHost>>
export type LiteralParams = Expect<Equals<ParamNamesOfT<typeof literal>, never>>
export const based = Compute.base(cents)
export type BaseType = Expect<Equals<TypeOfTerm<typeof based>, bigint>>
export const cast = Compute.cast(plainBigint, Cents)
export type CastType = Expect<Equals<TypeOfTerm<typeof cast>, CentsHost>>

/**
 * Arithmetic yields PostgreSQL's native result over the bases; a parameter of the operand's type contributes its own
 * parameter map.
 */
export const added = Compute.add(cents, cCents)
export type AddType = Expect<Equals<TypeOfTerm<typeof added>, bigint>>
export type AddParams = Expect<
	Equals<ParamsOfT<typeof added>, { readonly c: ParamType<CentsHost, "bigint"> }>
>
export const moneySum = Compute.add(money, money)
export type MoneySum = Expect<Equals<TypeOfTerm<typeof moneySum>, Money>>
export const decSum = Compute.add(dec, 1n)
export type DecSum = Expect<Equals<TypeOfTerm<typeof decSum>, Decimal>>
export const subbed = Compute.sub(cents, otherCents)
export type SubType = Expect<Equals<TypeOfTerm<typeof subbed>, bigint>>
/** Integer and money arithmetic is exact: an exact integer, delivered as bigint, and exact money. */
export const multiplied = Compute.mul(int, 2)
export type MulType = Expect<Equals<TypeOfTerm<typeof multiplied>, bigint>>
export type MulSql = Expect<Equals<SqlOfTerm<typeof multiplied>, "exact integer">>
/**
 * money / money is double precision; every other quotient follows the native result, an integer's the exact integer
 * truncated. A divisor is proved nonzero: by a literal's type, or a guard's branch.
 */
export const ratio = Compute.when(Compute.nonzero(money), (m) => Compute.div(money, m), 0)
export type MoneyRatio = Expect<Equals<TypeOfTerm<typeof ratio>, number>>
export const halved = Compute.div(cents, 2n)
export type DivType = Expect<Equals<TypeOfTerm<typeof halved>, bigint>>
export const decRatio = Compute.when(Compute.nonzero(rate), (d) => Compute.div(rate, d), 0n)
export type DecRatio = Expect<Equals<TypeOfTerm<typeof decRatio>, Decimal>>
// @ts-expect-error -- TS2345 refusal: a divisor proved nonzero: guard it with Compute.when(Compute.nonzero(x), (x) => …, otherwise)
export const unprovedRatio = Compute.div(rate, rate)
export const remainder = Compute.mod(cents, 3n)
export type ModType = Expect<Equals<TypeOfTerm<typeof remainder>, bigint>>
/** neg, abs and sign drop a contract to its base: the negation of a nonnegative Cents is no Cents. */
export const negated = Compute.neg(cents)
export type NegType = Expect<Equals<TypeOfTerm<typeof negated>, bigint>>
export const negatedRate = Compute.neg(rate)
export type NegRate = Expect<Equals<TypeOfTerm<typeof negatedRate>, Decimal>>
export const absolute = Compute.abs(cents)
export type AbsType = Expect<Equals<TypeOfTerm<typeof absolute>, bigint>>
export const signed = Compute.sign(cents)
export type SignType = Expect<Equals<TypeOfTerm<typeof signed>, bigint>>
// @ts-expect-error -- TS2345 refusal: a term first: a literal takes its place opposite a term, never first
export const literalFirst = Compute.add(1n, cents)

/**
 * Numeric only: quot, rem, round, trunc, ceil, floor, power, sqrt and minScale take a numeric term or a contract
 * over one, and yield numeric, or integer for minScale. A Decimal has no display scale, so the language has no scale
 * and no trimScale, which would read or remove one.
 */
export const quotient = Compute.when(Compute.nonzero(rate), (d) => Compute.quot(rate, d), 0n)
export type QuotType = Expect<Equals<TypeOfTerm<typeof quotient>, Decimal>>
export const rem = Compute.when(Compute.nonzero(dec), (d) => Compute.rem(dec, d), hiDec)
export type RemType = Expect<Equals<TypeOfTerm<typeof rem>, Decimal>>
export type RemParams = Expect<
	Equals<ParamsOfT<typeof rem>, { readonly hi: ParamType<Decimal, "numeric"> }>
>
export const rounded = Compute.round(rate, 2)
export type RoundType = Expect<Equals<TypeOfTerm<typeof rounded>, Decimal>>
export const truncated = Compute.trunc(rate)
export type TruncType = Expect<Equals<TypeOfTerm<typeof truncated>, Decimal>>
export const ceiling = Compute.ceil(dec)
export type CeilType = Expect<Equals<TypeOfTerm<typeof ceiling>, Decimal>>
export const floored = Compute.floor(dec)
export type FloorType = Expect<Equals<TypeOfTerm<typeof floored>, Decimal>>
export const powered = Compute.when(Compute.nonnegative(dec), (x) => Compute.power(x, 2n), 0n)
export type PowerType = Expect<Equals<TypeOfTerm<typeof powered>, Decimal>>
export const root = Compute.when(Compute.nonnegative(rate), (x) => Compute.sqrt(x), 0n)
export type SqrtType = Expect<Equals<TypeOfTerm<typeof root>, Decimal>>
export const minScaled = Compute.when(Compute.isFinite(rate), (x) => Compute.minScale(x), 0)
export type MinScaleType = Expect<Equals<TypeOfTerm<typeof minScaled>, number>>
// @ts-expect-error -- TS2345: quot is numeric only
export const quotBigint = Compute.quot(cents, 1n)
// @ts-expect-error -- TS2345: rem is numeric only
export const remInt = Compute.rem(int, 1)
// @ts-expect-error -- TS2345: trunc is numeric only
export const truncBigint = Compute.trunc(cents)
// @ts-expect-error -- TS2345: ceil is numeric only
export const ceilInt = Compute.ceil(int)
// @ts-expect-error -- TS2345: floor is numeric only
export const floorMoney = Compute.floor(money)
// @ts-expect-error -- TS2345: power is numeric only
export const powerInt = Compute.power(int, 2)
// @ts-expect-error -- TS2345: sqrt is numeric only
export const sqrtBigint = Compute.sqrt(cents)
// @ts-expect-error -- TS2345: minScale is numeric only
export const minScaleInt = Compute.minScale(int)
// @ts-expect-error -- TS2339: Compute has no scale, which would read a display scale no Decimal has
export const noScale = Compute.scale(dec)
// @ts-expect-error -- TS2339: Compute has no trimScale, the identity on a Decimal
export const noTrimScale = Compute.trimScale(dec)

/** gcd and lcm take two terms of one type, a parameter of it among them, and yield the base. */
export const divisor = Compute.gcd(cents, otherCents)
export type GcdType = Expect<Equals<TypeOfTerm<typeof divisor>, bigint>>
export const multiple = Compute.lcm(plainBigint, cBig)
export type LcmType = Expect<Equals<TypeOfTerm<typeof multiple>, bigint>>
export type LcmParams = Expect<
	Equals<ParamsOfT<typeof multiple>, { readonly c: ParamType<bigint, "bigint"> }>
>
// @ts-expect-error -- TS2345: lcm takes a term or a parameter, never a literal
export const lcmLiteral = Compute.lcm(plainBigint, 2n)

/** least and greatest keep their operands' exact type, a contract included; every operand has that type. */
export const smallest = Compute.least(cents, otherCents)
export type LeastType = Expect<Equals<TypeOfTerm<typeof smallest>, CentsHost>>
export const largest = Compute.greatest(cents, otherCents, hiCents)
export type GreatestType = Expect<Equals<TypeOfTerm<typeof largest>, CentsHost>>
export type GreatestParams = Expect<
	Equals<ParamsOfT<typeof largest>, { readonly hi: ParamType<CentsHost, "bigint"> }>
>
// @ts-expect-error -- TS2345: a bare base never meets a contract term
export const greatestMixed = Compute.greatest(cents, plainBigint)

/** width_bucket is the four-argument numeric form over operands proved finite, and yields integer. */
export const bucket = Compute.when(
	Compute.isFinite(dec),
	(x) =>
		Compute.widthBucket(x, Compute.literal(pg.numeric, 0n), Compute.literal(pg.numeric, 10n), int),
	0
)
export type BucketType = Expect<Equals<TypeOfTerm<typeof bucket>, number>>
// @ts-expect-error -- TS2345: width_bucket's bounds are numeric
export const bucketBigint = Compute.widthBucket(dec, cents, dec, int)

/**
 * cond: the first branch, a term, types the conditional; the other is a term or parameter of its type, or a literal.
 */
export const chosen = Compute.cond(flag, cents, otherCents)
export type CondType = Expect<Equals<TypeOfTerm<typeof chosen>, CentsHost>>
export const counted = Compute.cond(p, Compute.literal(pg.integer, 1), 0)
export type CondCount = Expect<Equals<TypeOfTerm<typeof counted>, number>>
export type CondCountParams = Expect<Equals<ParamsOfT<typeof counted>, { readonly x: bigint }>>
export const labelled = Compute.cond(flag, text, "b")
export type CondLiterals = Expect<Equals<TypeOfTerm<typeof labelled>, string>>
export const defaulted = Compute.cond(flag, int, hiInt)
export type CondParamBranch = Expect<
	Equals<ParamsOfT<typeof defaulted>, { readonly hi: ParamType<number, "integer"> }>
>
export const defaultedLast = Compute.cond(flag, cents, cCents)
export type CondParamLast = Expect<
	Equals<ParamsOfT<typeof defaultedLast>, { readonly c: ParamType<CentsHost, "bigint"> }>
>
/** A parameter is a term of its declared type, so it stands first too. */
export const condParamFirst = Compute.cond(flag, hiInt, int)
export type CondParamFirst = Expect<
	Equals<ParamsOfT<typeof condParamFirst>, { readonly hi: ParamType<number, "integer"> }>
>
// @ts-expect-error -- TS2345: a branch opposite a term has the term's type
export const condMixed = Compute.cond(flag, cents, int)

/** A parameter in a cond branch is a parameter of the query, so a definition that writes one is no derived relation. */
export const Reading = relation("Reading", { id: uuid, m: pg.integer, b: pg.boolean }, ["id"])
export const Readings = schema("Readings", { Reading }, [])
export const withDefault = query(Readings).rule((r) => {
	const { id, m, b } = v(Reading, "reading")
	return r
		.match(Reading, { id, m, b })
		.find({ id, x: Compute.cond(r.eq(b, false), m, r.param("dflt", pg.integer)) })
})

export type WithDefaultParams = Expect<
	Equals<ParamsOf<typeof withDefault>, { readonly dflt: ParamType<number, "integer"> }>
>
// @ts-expect-error -- TS2345: a derived definition reads no parameter
export const DefaultedDerived = derived("Defaulted", withDefault)

/** Boolean helpers thread every operand's parameters. */
export const negation = Compute.not(p)
export type NotType = Expect<
	Equals<typeof negation, Predicate<{ readonly x: bigint }, ComputedOrigin<unknown>>>
>
export const both = Compute.and(p, q)
export type AndParams = Expect<
	Equals<ParamsOfT<typeof both>, { readonly x: bigint; readonly y: string }>
>
export const either = Compute.or(p, q)
export type OrParams = Expect<
	Equals<ParamsOfT<typeof either>, { readonly x: bigint; readonly y: string }>
>

/**
 * Comparisons: the second operand is a term of the first's exact type, a parameter among them, or a literal of its base.
 */
export const equal = Compute.eq(cents, 5n)
export type EqParams = Expect<Equals<ParamNamesOfT<typeof equal>, never>>
export const unequal = Compute.ne(cents, cCents)
export type NeParams = Expect<
	Equals<ParamsOfT<typeof unequal>, { readonly c: ParamType<CentsHost, "bigint"> }>
>
export const less = Compute.lt(cents, otherCents)
export type LtParams = Expect<Equals<ParamNamesOfT<typeof less>, never>>
export const atMost = Compute.le(int, hiInt)
export type LeParams = Expect<
	Equals<ParamsOfT<typeof atMost>, { readonly hi: ParamType<number, "integer"> }>
>
export const greater = Compute.gt(dec, "0.5")
export type GtParams = Expect<Equals<ParamNamesOfT<typeof greater>, never>>
export const atLeast = Compute.ge(text, cText)
export type GeParams = Expect<
	Equals<ParamsOfT<typeof atLeast>, { readonly c: ParamType<string, "text"> }>
>
export const within = Compute.between(cents, 0n, hiCents)
export type BetweenParams = Expect<
	Equals<ParamsOfT<typeof within>, { readonly hi: ParamType<CentsHost, "bigint"> }>
>
export const listed = Compute.in(cents, [1n, 2n])
export type InParams = Expect<Equals<ParamNamesOfT<typeof listed>, never>>
// @ts-expect-error -- TS2345: a bare base never meets a contract term
export const neMixed = Compute.ne(cents, plainBigint)
// @ts-expect-error -- TS2322: a number is not a literal of a text term
export const inWrong = Compute.in(text, [1])

/**
 * Span endpoints keep the endpoint type, a contract included, read with the span's own endpoint descriptor; a width is
 * a difference, so it drops to the base.
 */
export const lowest = Compute.lower(centsSpan, Cents)
export type LowerType = Expect<Equals<TypeOfTerm<typeof lowest>, CentsHost>>
export const highest = Compute.upper(centsSpan, Cents)
export type UpperType = Expect<Equals<TypeOfTerm<typeof highest>, CentsHost>>
export const spanWidth = Compute.width(centsSpan, Cents)
export type WidthType = Expect<Equals<TypeOfTerm<typeof spanWidth>, bigint>>
export const dayWidth = Compute.width(intSpan, pg.integer)
export type DayWidthType = Expect<Equals<TypeOfTerm<typeof dayWidth>, bigint>>
// @ts-expect-error -- TS2345: lower takes a span term
export const lowerScalar = Compute.lower(cents, Cents)
// @ts-expect-error -- TS2345: upper takes a span term
export const upperScalar = Compute.upper(int, pg.integer)
// @ts-expect-error -- TS2345: width takes a span term
export const widthScalar = Compute.width(cents, Cents)
// @ts-expect-error -- TS2345: the endpoint descriptor is the span's own
export const otherEndpoint = Compute.upper(intSpan, pg.bigint)

/** char_length is a scalar for contract predicates and row checks. */
export const length = Compute.charLength(text)
export type CharLengthType = Expect<
	Equals<typeof length, Scalar<number, unknown, ComputedOrigin<unknown>, "integer">>
>
// @ts-expect-error -- TS2345: char_length takes a text term
export const lengthOfInt = Compute.charLength(int)

/** cosine distance is double precision and is defined over two vectors of one dimension count. */
export const distance = Compute.cosineDistance(docs, docs)
export type DistanceType = Expect<Equals<TypeOfTerm<typeof distance>, number>>
// @ts-expect-error -- TS2345: a vector of other dimensions has no cosine distance to this one
export const widerDistance = Compute.cosineDistance(docs, wider)

/** The Scalar methods a contract predicate uses. */
export const NonZero = contract("NonZero", pg.bigint, (x) => x.ne(0n))
export const SmallCount = contract("SmallCount", pg.integer, (x) => x.in([1, 2, 3]))
// @ts-expect-error -- TS2322: a string is not a literal of an integer
export const WrongIn = contract("WrongIn", pg.integer, (x) => x.in(["1"]))
declare const scalar: Scalar<CentsHost>
export const scalarNe = scalar.ne(cCents)
export type ScalarNeParams = Expect<
	Equals<ParamsOfT<typeof scalarNe>, { readonly c: ParamType<CentsHost, "bigint"> }>
>
export const scalarIn = scalar.in([1n])
export type ScalarInParams = Expect<Equals<ParamNamesOfT<typeof scalarIn>, never>>

/**
 * The guards of a partial operation: each a predicate over its subject, which Compute.when hands its branch with the
 * guard's facts proved; within proves its subject's facts from its literal bounds.
 */
export const positiveGuard: Predicate = Compute.positive(int)
export const withinGuard: Predicate = Compute.within(dec, 1n, 10n)
export const withinRoot = Compute.when(Compute.within(dec, 0n, 10n), (x) => Compute.sqrt(x), 0n)
export type WithinRoot = Expect<Equals<TypeOfTerm<typeof withinRoot>, Decimal>>
// @ts-expect-error -- TS2345 refusal: a radicand proved nonnegative: guard it with Compute.when(Compute.nonnegative(x), (x) => …, otherwise)
export const belowZeroRoot = Compute.when(Compute.within(dec, -1n, 10n), (x) => Compute.sqrt(x), 0n)
// @ts-expect-error -- TS2345: isFinite is numeric or a float's: an integer is finite by its type
export const finiteInt = Compute.isFinite(int)
export const guardedParams = Compute.when(Compute.nonzero(dec), (d) => Compute.div(dec, d), hiDec)
export type GuardedParams = Expect<
	Equals<ParamsOfT<typeof guardedParams>, { readonly hi: ParamType<Decimal, "numeric"> }>
>

/** Every member of the catalogue has assertions above. A member added without an entry here is TS2741. */
export const computeCovered: { readonly [K in keyof typeof Compute]: true } = {
	literal: true,
	base: true,
	cast: true,
	add: true,
	sub: true,
	mul: true,
	div: true,
	mod: true,
	neg: true,
	quot: true,
	rem: true,
	abs: true,
	sign: true,
	round: true,
	trunc: true,
	ceil: true,
	floor: true,
	gcd: true,
	lcm: true,
	power: true,
	sqrt: true,
	least: true,
	greatest: true,
	widthBucket: true,
	minScale: true,
	cond: true,
	when: true,
	nonzero: true,
	nonnegative: true,
	positive: true,
	isFinite: true,
	within: true,
	not: true,
	and: true,
	or: true,
	eq: true,
	ne: true,
	lt: true,
	le: true,
	gt: true,
	ge: true,
	between: true,
	in: true,
	lower: true,
	upper: true,
	width: true,
	charLength: true,
	cosineDistance: true
}

/**
 * A Decimal is a value and nothing else: its parts in the one form and its one text, no display scale beside them.
 * A finite value's parts are readable only once `isFinite` proved them finite.
 */
declare const someDecimal: Decimal
export const decimalText: string = someDecimal.text
export type DecimalPartsType = Expect<Equals<typeof someDecimal.parts, DecimalParts>>
export const leastScale = someDecimal.isFinite() ? someDecimal.parts.minScale : 0
export type FinitePartsType = Expect<
	Equals<Extract<DecimalParts, { readonly kind: "finite" }>, FiniteParts>
>
// @ts-expect-error -- TS2339: a Decimal has no display scale
export const noDisplayScale = someDecimal.scale
// @ts-expect-error -- TS2339: one text per value, no identity text beside it
export const noIdentityText = someDecimal.identityText()
// @ts-expect-error -- TS2339: a value that may be NaN or an infinity has no coefficient to read
export const noCoefficient = someDecimal.parts.coefficient

/**
 * Every catalogue overload states what it reads of its numeric operands, and every aggregate overload how it is
 * lowered: neither field is optional, so an entry added without deciding is a type error.
 */
export type ReadsRequired = Expect<Equals<FixedOp["reads"], OperandReading>>
export type LoweringRequired = Expect<Equals<AggregateOverload["lowering"], AggregateLowering>>
// @ts-expect-error -- TS2741: an overload without its reading is no overload
export const unread: Pick<FixedOp, "reads" | "fn"> = { fn: "div" }
// @ts-expect-error -- TS2741: an aggregate overload without its lowering is no overload
export const unlowered: Pick<AggregateOverload, "lowering" | "sql"> = { sql: "sum" }
