import { firstIndex } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { compareCodePoints } from "@bjornpagen/grizzle-text/text"
import type { CodecFault, ValueFault } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { isPlainRecord } from "#compiler/core/record.ts"
import { type TextsKey, textsKey, validateText } from "#compiler/core/text.ts"
import { int8Max, int8Min } from "#compiler/ir/carriers.ts"
import { codeOf, type HandleOrder, handlesText, type RosterCodec } from "#compiler/ir/codes.ts"
import { type CalendarDate, toCalendarDate } from "#compiler/ir/date.ts"
import { baseOf, type Carrier, integerTypmodOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { statedRoster } from "#compiler/scalar/values/bits.ts"
import {
	AdmittedBytes,
	admitBytes,
	checkBytes,
	compareBytes,
	isAdmittedBytes
} from "#compiler/scalar/values/bytes.ts"
import {
	Decimal,
	integerNumeric,
	integerOfDecimal,
	type NumericTypmod,
	normalizeNumeric,
	parseNumeric
} from "#compiler/scalar/values/decimal.ts"
import {
	compareFloat,
	floatText,
	parseReal,
	toDouble,
	toReal
} from "#compiler/scalar/values/float.ts"
import { toInt2, toInt4, toInt8 } from "#compiler/scalar/values/integer.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import {
	admitSpan,
	compareSpan,
	isSpanOf,
	type Span,
	spanText
} from "#compiler/scalar/values/span.ts"
import { toUuid } from "#compiler/scalar/values/uuid.ts"
import { admitEncodable, isVector, Vector } from "#compiler/scalar/values/vector.ts"

export type { Carrier }

type PlainCarrier = Exclude<
	Carrier,
	| "numeric"
	| "exactInteger"
	| "code"
	| "bits"
	| "vector"
	| "range4"
	| "range8"
	| "rangeDate"
	| "bytes"
>

/**
 * What a carrier needs beyond its name to admit a value. A closed id and a set over a roster carry the roster's codes,
 * which the installation holds: a handle is written as its code, and a set as its hex digits, one bit per code. Bytes
 * is a spec of its own, since its value travels as no text, so a spec narrowed by it is a text carrier's.
 *
 * A spec is the value's, its host value's carrier, which is its type's carrier but for an integer numeric: numeric(p,
 * 0) holds integers alone, so its spec is the exact integer's, of its typmod, and its host value a bigint
 * (codec/scalar.ts carrierSpecOf), where an exact integer's own, a value grizzle computes, has no typmod. numeric's
 * typmod is then one of another scale, or none, a computed numeric's.
 */
export type CarrierSpec =
	| { readonly carrier: PlainCarrier }
	| { readonly carrier: "bytes" }
	| { readonly carrier: "numeric"; readonly typmod: NumericTypmod | undefined }
	| { readonly carrier: "exactInteger"; readonly typmod: NumericTypmod | undefined }
	| { readonly carrier: "code"; readonly roster: RosterCodec }
	| { readonly carrier: "bits"; readonly roster: RosterCodec }
	| { readonly carrier: "vector"; readonly dimensions: number }
	| { readonly carrier: "range4" | "range8" | "rangeDate"; readonly width: bigint | undefined }

export interface CarrierHost {
	readonly int2: number
	readonly int4: number
	readonly int8: bigint
	readonly numeric: Decimal
	readonly float4: number
	readonly float8: number
	readonly money: Money
	readonly bool: boolean
	readonly uuid: string
	/** A date's host value is its ISO 8601 text, its one form (ir/date.ts). */
	readonly date: CalendarDate
	readonly text: string
	/** A bytes value's host value is its bytes with their digest (values/bytes.ts AdmittedBytes). */
	readonly bytes: AdmittedBytes
	/** A closed id's host value is its handle. */
	readonly code: string
	/** A set's host value is its handles. */
	readonly bits: ReadonlySet<string>
	readonly range4: Span<number>
	readonly range8: Span<bigint>
	readonly rangeDate: Span<CalendarDate>
	readonly vector: Vector
	readonly exactInteger: bigint
	readonly exactMoney: Money
}

/** A value of some carrier as the host holds it: its carrier's host value (CarrierHost). */
export type HostValue = CarrierHost[Carrier]

/** What each carrier's spec holds beside its carrier: the CarrierSpec variant's other members. */
interface SpecExtras {
	readonly int2: unknown
	readonly int4: unknown
	readonly int8: unknown
	readonly numeric: { readonly typmod: NumericTypmod | undefined }
	readonly float4: unknown
	readonly float8: unknown
	readonly money: unknown
	readonly bool: unknown
	readonly uuid: unknown
	readonly date: unknown
	readonly text: unknown
	readonly bytes: unknown
	readonly code: { readonly roster: RosterCodec }
	readonly bits: { readonly roster: RosterCodec }
	readonly vector: { readonly dimensions: number }
	readonly range4: { readonly width: bigint | undefined }
	readonly range8: { readonly width: bigint | undefined }
	readonly rangeDate: { readonly width: bigint | undefined }
	readonly exactInteger: { readonly typmod: NumericTypmod | undefined }
	readonly exactMoney: unknown
}

/** The spec of one carrier, its carrier exactly C. */
export type SpecOf<C extends Carrier> = { readonly carrier: C } & SpecExtras[C]

/**
 * Each operation below is a table with one entry per carrier, over that carrier's spec and host values, read through
 * the spec's own carrier, so a spec and the values it meets are correlated by construction.
 */
type Admitters = {
	readonly [C in Carrier]: (
		value: unknown,
		spec: SpecOf<C>
	) => Result.Result<CarrierHost[C], ValueFault>
}
type CanonicalTexts = {
	readonly [C in Carrier]: (value: CarrierHost[C], spec: SpecOf<C>) => string
}
type Comparators = {
	readonly [C in Carrier]: (
		a: CarrierHost[C],
		b: CarrierHost[C],
		order: OrderSpecOf<C>
	) => -1 | 0 | 1
}

/**
 * What PostgreSQL's order of a carrier's values reads beside the values: a closed id's and a set's, their roster's
 * order (ir/codes.ts HandleOrder), which a codec's spec holds as its installation's codes and the evaluator as the
 * roster's declaration (scalar/compute/evaluate.ts evaluatorOrder). No other carrier's order reads anything but its
 * values, as SpecExtras states each carrier's spec.
 */
interface OrderExtras {
	readonly int2: unknown
	readonly int4: unknown
	readonly int8: unknown
	readonly numeric: unknown
	readonly float4: unknown
	readonly float8: unknown
	readonly money: unknown
	readonly bool: unknown
	readonly uuid: unknown
	readonly date: unknown
	readonly text: unknown
	readonly bytes: unknown
	readonly code: { readonly roster: HandleOrder }
	readonly bits: { readonly roster: HandleOrder }
	readonly vector: unknown
	readonly range4: unknown
	readonly range8: unknown
	readonly rangeDate: unknown
	readonly exactInteger: unknown
	readonly exactMoney: unknown
}

/** What the order of one carrier's values reads, its carrier exactly C. Every carrier's spec is one (CarrierSpec). */
export type OrderSpecOf<C extends Carrier> = { readonly carrier: C } & OrderExtras[C]

/** What the order of some carrier's values reads (OrderSpecOf), a codec's spec (CarrierSpec) among them. */
export type OrderSpec = { readonly [C in Carrier]: OrderSpecOf<C> }[Carrier]

/**
 * A numeric value at its typmod by `atTypmod`: parsed exactly (decimal.ts parseNumeric) or coerced as PostgreSQL
 * coerces a value it computes (normalizeNumeric). Without a typmod it is a computed numeric's, a window anchor's key
 * value of an aggregate column the only one a caller passes: every Decimal is within numeric's limits, and the computed
 * bound (ir/scalar.ts NumericBound) is a proof of the values the database computes, which a boundary value only meets
 * in a comparison.
 */
const decimalAt =
	(
		atTypmod: (d: Decimal, typmod: NumericTypmod | undefined) => Result.Result<Decimal, ValueFault>
	) =>
	(value: unknown, typmod: NumericTypmod | undefined): Result.Result<Decimal, ValueFault> =>
		value instanceof Decimal
			? atTypmod(value, typmod)
			: Result.err(typeof value === "number" ? "decimalNumber" : "decimalType")

/**
 * An exact integer at its typmod: an integer numeric's, numeric(p, 0), below 10^p in magnitude (decimal.ts
 * integerNumeric), its parse and its coercion one, since no bigint rounds. Without a typmod it is a computed exact
 * integer's, every bigint, whose digit bound is a proof of the values the database computes, as a computed numeric's
 * is (decimalAt).
 */
const integerAt = (
	value: unknown,
	typmod: NumericTypmod | undefined
): Result.Result<bigint, ValueFault> =>
	typeof value !== "bigint"
		? Result.err("integerType")
		: typmod === undefined
			? Result.ok(value)
			: integerNumeric(value, typmod)

/**
 * The encode-time boundary of a vector, read once from the caller's buffer as it is now into a copy grizzle alone holds:
 * a Float32Array of the dimensions, every component finite, its norm in the cosine domain. The admitted value is that
 * copy, so the fact's identity and every row text written from the fact later read the same components, whatever the
 * caller does to its buffer after admission. Every vector is in the cosine domain at every boundary, parameters
 * included; the database CHECK is the authority for stored values (values/vector.ts).
 */
const admitVector = (value: unknown, dimensions: number): Result.Result<Vector, ValueFault> =>
	admitEncodable(value, dimensions)

/**
 * What admitting a closed id or a set reads of its roster: its declared name, which a set's stated roster is held to,
 * and its live handles, each with its rank: an installation's codec (ir/codes.ts RosterCodec), or the roster's declared
 * order under its name, which no installation holds (codec/scalar.ts hostText).
 */
export type LiveHandles = Pick<RosterCodec, "roster" | "rank">

/** A closed id's handle: a string the roster holds live, whose code the codec writes. */
export const admitHandle = (
	value: unknown,
	roster: LiveHandles
): Result.Result<string, ValueFault> =>
	typeof value === "string" && roster.rank.has(value) ? Result.ok(value) : Result.err("codeHandle")

/**
 * A set of a roster's handles, read once into a fresh Set grizzle alone holds, so a later change to the caller's Set
 * changes no admitted value: a Set whose members are strings, each a handle the roster holds live, and which, where it
 * states its roster (Bits.of's), states this one. A Set cannot be frozen (Object.freeze leaves its members writable), so
 * the copy is what keeps the admitted value fixed.
 */
export const admitHandles = (
	value: unknown,
	roster: LiveHandles
): Result.Result<ReadonlySet<string>, ValueFault> => {
	if (!(value instanceof Set)) {
		return Result.err("bitsType")
	}
	const stated = statedRoster(value)
	if (stated !== undefined && stated !== roster.roster) {
		return Result.err("bitsMember")
	}
	const handles = new Set<string>()
	for (const member of value) {
		if (typeof member !== "string") {
			return Result.err("bitsType")
		}
		if (!roster.rank.has(member)) {
			return Result.err("bitsMember")
		}
		handles.add(member)
	}
	return Result.ok(handles)
}

/**
 * A money field's value: a Money (one this module's mint made, which `instanceof` checks) whose count is within int64,
 * the range of PostgreSQL's money. An exact amount outside it, money arithmetic's, is no money value.
 */
const admitMoney = (value: unknown): Result.Result<Money, ValueFault> => {
	if (!(value instanceof Money)) {
		return Result.err("moneyType")
	}
	return value.minorUnits >= int8Min && value.minorUnits <= int8Max
		? Result.ok(value)
		: Result.err("moneyRange")
}

/**
 * PostgreSQL's assignment coercion of a value grizzle computes on the host for a column, as a fill's fold step or a
 * greatest value: a numeric rounded to its typmod's scale, a double rounded to binary32, as PostgreSQL stores a value it
 * computes. No caller's value goes through it: a caller's is parsed (parsers).
 */
const coercions: Admitters = {
	int2: (value) => toInt2(value),
	int4: (value) => toInt4(value),
	int8: (value) => toInt8(value),
	numeric: (value, spec) => decimalAt(normalizeNumeric)(value, spec.typmod),
	float4: (value) => toReal(value),
	float8: (value) => toDouble(value),
	money: (value) => admitMoney(value),
	bool: (value) => (typeof value === "boolean" ? Result.ok(value) : Result.err("boolType")),
	uuid: (value) => toUuid(value),
	date: (value) => toCalendarDate(value),
	text: (value) => validateText(value),
	bytes: (value) => admitBytes(value),
	code: (value, spec) => admitHandle(value, spec.roster),
	bits: (value, spec) => admitHandles(value, spec.roster),
	range4: (value, spec) => admitSpan("int4", value, spec.width),
	range8: (value, spec) => admitSpan("int8", value, spec.width),
	rangeDate: (value, spec) => admitSpan("date", value, spec.width),
	vector: (value, spec) => admitVector(value, spec.dimensions),
	exactInteger: (value, spec) => integerAt(value, spec.typmod),
	exactMoney: (value) => (value instanceof Money ? Result.ok(value) : Result.err("moneyType"))
}

/**
 * The exact parse of a caller's value, every carrier's: the value of the declared type it is, unchanged, or the fault
 * that no such value exists. It never rounds: a numeric of more fractional digits than its typmod's scale and a double
 * that is no binary32 value are refused, where PostgreSQL would store another value than the one sent. Every other
 * carrier's parse is its coercion, which alters no value: its one form only, -0 as +0, a uuid in lowercase.
 */
const parsers: Admitters = {
	...coercions,
	numeric: (value, spec) => decimalAt(parseNumeric)(value, spec.typmod),
	float4: (value) => parseReal(value)
}

/**
 * What admission answers for a value it could not read, a proxy whose traps throw or a getter that throws: the word for
 * a value not of the carrier's host type, made when a read throws (core/host.ts hostRead). Every carrier names its own;
 * a literal operand's admission (scalar/registry.ts literalDescFor) answers the same.
 */
export const unreadableOf: { readonly [C in Carrier]: () => ValueFault } = {
	int2: () => "integerType",
	int4: () => "integerType",
	int8: () => "integerType",
	numeric: () => "decimalType",
	float4: () => "floatType",
	float8: () => "floatType",
	money: () => "moneyType",
	bool: () => "boolType",
	uuid: () => "uuidSyntax",
	date: () => "dateSyntax",
	text: () => "textType",
	bytes: () => "bytesType",
	code: () => "codeHandle",
	bits: () => "bitsType",
	range4: () => "spanType",
	range8: () => "spanType",
	rangeDate: () => "spanType",
	vector: () => "vectorType",
	exactInteger: () => "integerType",
	exactMoney: () => "moneyType"
}

/** One carrier's entry of an admitter table, read through the spec's own carrier, its value read once (hostRead). */
const admitBy = <C extends Carrier>(
	table: Admitters,
	spec: SpecOf<C> & CarrierSpec,
	value: unknown
): Result.Result<CarrierHost[C], ValueFault> => {
	const own: SpecOf<C> = spec
	const admit: (value: unknown, spec: SpecOf<C>) => Result.Result<CarrierHost[C], ValueFault> =
		table[own.carrier]
	return hostRead(unreadableOf[own.carrier], () => admit(value, own))
}

/**
 * The input boundary, one door for every caller's value, a parameter's, a fact's, a window anchor's key value's: the
 * exact parse of the value as its carrier's host value (parsers), or the fault that the declared type holds no such
 * value. PostgreSQL then enforces every law over it.
 */
export const parseValue = <C extends Carrier>(
	spec: SpecOf<C> & CarrierSpec,
	value: unknown
): Result.Result<CarrierHost[C], ValueFault> => admitBy(parsers, spec, value)

/**
 * The value PostgreSQL stores for a value grizzle computes on the host for a column of this carrier (coercions), or
 * the refusal PostgreSQL would raise storing it.
 */
export const storedValue = <C extends Carrier>(
	spec: SpecOf<C> & CarrierSpec,
	value: unknown
): Result.Result<CarrierHost[C], ValueFault> => admitBy(coercions, spec, value)

const isNumber = (value: unknown): value is number => typeof value === "number"
const isBigint = (value: unknown): value is bigint => typeof value === "bigint"
const isString = (value: unknown): value is string => typeof value === "string"
const isStringSet = (value: unknown): value is ReadonlySet<string> =>
	value instanceof Set && Array.from(value).every(isString)

/** Whether a value has a carrier's host type. It checks the type only, never the carrier's admission rules. */
const hostChecks: { readonly [C in Carrier]: (value: unknown) => value is CarrierHost[C] } = {
	int2: isNumber,
	int4: isNumber,
	int8: isBigint,
	numeric: (value) => value instanceof Decimal,
	float4: isNumber,
	float8: isNumber,
	money: (value) => value instanceof Money,
	bool: (value) => typeof value === "boolean",
	uuid: isString,
	date: (value): value is CalendarDate => toCalendarDate(value).ok,
	text: isString,
	bytes: isAdmittedBytes,
	code: isString,
	bits: isStringSet,
	range4: isSpanOf(isNumber),
	range8: isSpanOf(isBigint),
	rangeDate: isSpanOf((value): value is CalendarDate => toCalendarDate(value).ok),
	vector: isVector,
	exactInteger: isBigint,
	exactMoney: (value) => value instanceof Money
}

/** Whether a value has the host type of a carrier. */
export const isHostValue = <C extends Carrier>(
	carrier: C,
	value: unknown
): value is CarrierHost[C] => {
	const is: (value: unknown) => value is CarrierHost[C] = hostChecks[carrier]
	return is(value)
}

const canonicalTexts: CanonicalTexts = {
	int2: (v) => String(v),
	int4: (v) => String(v),
	int8: (v) => String(v),
	bool: (v) => (v ? "true" : "false"),
	numeric: (v) => v.text,
	float4: (v) => floatText(v),
	float8: (v) => floatText(v),
	money: (v) => v.toString(),
	uuid: (v) => v,
	date: (v) => v,
	text: (v) => v,
	bytes: (v) => v.digest,
	code: (v, spec) => String(codeOf(spec.roster, v)),
	bits: (v, spec) => handlesText(spec.roster, v),
	range4: (v) => spanText(v),
	range8: (v) => spanText(v),
	rangeDate: (v) => spanText(v),
	vector: (v) => Vector.componentText(v),
	exactInteger: (v) => String(v),
	exactMoney: (v) => v.toString()
}

/**
 * Canonical value encoding for fact identity.
 *
 * A value is only its value, the same under every plan. One logical value compares the same in codecs, PostgreSQL
 * equality, DISTINCT, keys, grouping and the test oracle, and every value is in its one form, but a float's zero: -0
 * and +0 are two values, each its own fact identity, and one key under PostgreSQL's equality (keyText), so a write
 * compares two facts of one key by their identity (ir/compare.ts factEq) and two keys by their key texts. Wherever an
 * operation may take one float of several equal ones, a set's member, a group's key, a union's row, a recursion's
 * state, a join variable's value, the merged zero is +0, so no plan picks one; min and max of floats order -0 below 0,
 * and a float sum or mean is -0 exactly when every value it sums is (check/merge.ts, scalar/aggregate.ts). This module
 * is the host side, per scalar carrier:
 *
 * - `parseValue` is the boundary: the exact parse of a host value as its carrier's, which refuses a value its column
 *   would store as another (a numeric past its scale, a double no binary32 value holds) and alters none: two spellings
 *   of one value are one admitted value (uuid case), so fact identity is the stored value's; a float's -0 is a value of
 *   its own, distinct from +0 (values/float.ts), as PostgreSQL stores it. `storedValue` is
 *   PostgreSQL's own coercion of a value grizzle computes on the host, which rounds as PostgreSQL rounds.
 * - `canonicalText` gives every admitted value its one text, equal exactly when the values are one value, because every
 *   host value is in its one form (a Decimal has no display scale, a vector component one zero): numeric 1.0 = 1.00
 *   are one Decimal written 1, NaN one text, text by exact scalar sequence; a float's -0 and +0 are two values, equal
 *   under PostgreSQL's equality and `compareValues` but each its own fact identity, as a key holds them. It is
 *   the parameter text, the array element and the fact identity's part alike (codec/scalar.ts text); a bytes value's is
 *   its SHA-256 digest (values/bytes.ts BytesDigest), the fact identity's part and no parameter text: every bytes value
 *   travels in binary (codec/bytea.ts). Two bytes values of one digest are one only when their bytes are equal, which
 *   every host site that takes two facts of one identity as one checks (`sameFact`).
 * - `compareValues` is PostgreSQL's B-tree order for the type, the host's one comparison, the evaluator's
 *   (scalar/compute/evaluate.ts) and the stored values' alike: float and numeric total orders with NaN last, text in
 *   code point order, uuid and bytes by bytes, closed ids by code, which is roster order (ir/codes.ts HandleOrder), spans
 *   by start then end, vectors as vector_cmp, and sets by their bit strings, which no language order reads, since a set
 *   has no ordering.
 * - `factIdentity` admits a whole fact against its heading and gives it its identity, each field's canonical text in
 *   field-name order, so two facts are the same fact exactly when their identities are equal element by element: the
 *   identity ChangeSet normalization and exact-repeat checks use, a key of a TupleMap (core/tuple-map.ts).
 *
 * The carrier names are the scalar IR's, imported from ir/scalar.ts so the two cannot drift.
 *
 * The one text of an admitted value. Texts of different carriers are not comparable.
 */
export const canonicalText = <C extends Carrier>(
	spec: SpecOf<C> & CarrierSpec,
	value: CarrierHost[C]
): string => {
	const own: SpecOf<C> = spec
	const text: (value: CarrierHost[C], spec: SpecOf<C>) => string = canonicalTexts[own.carrier]
	return text(value, own)
}

const sign = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0)

const compareOrdered = <V extends bigint | string>(x: V, y: V): -1 | 0 | 1 =>
	x < y ? -1 : x > y ? 1 : 0

/** A handle's rank in its roster's order; the order holds every live handle, which is all a value holds. */
const rankOf = (order: HandleOrder, handle: string): number =>
	defined(order.rank.get(handle), "a live handle's rank in its roster's order")

/**
 * A set's order, PostgreSQL's of its bit string, bit c the handle of code c: the first handle by rank that one set holds
 * and the other does not, the set that holds it the greater; equal sets are equal. A set has no order of the language
 * (bits has no ordering capability), so only equality reads it beyond the host's own sorts.
 */
const compareSets = (
	x: ReadonlySet<string>,
	y: ReadonlySet<string>,
	order: HandleOrder
): -1 | 0 | 1 => {
	let first: { readonly rank: number; readonly side: -1 | 1 } | undefined
	for (const [set, other, side] of [
		[x, y, 1],
		[y, x, -1]
	] as const) {
		for (const handle of set) {
			if (!other.has(handle)) {
				const rank = rankOf(order, handle)
				if (first === undefined || rank < first.rank) {
					first = { rank, side }
				}
			}
		}
	}
	return first === undefined ? 0 : first.side
}

const comparators: Comparators = {
	int2: (x, y) => sign(x - y),
	int4: (x, y) => sign(x - y),
	int8: (x, y) => compareOrdered(x, y),
	numeric: (x, y) => x.compare(y),
	float4: (x, y) => compareFloat(x, y),
	float8: (x, y) => compareFloat(x, y),
	money: (x, y) => x.compare(y),
	bool: (x, y) => (x === y ? 0 : x ? 1 : -1),
	uuid: (x, y) => compareOrdered(x, y),
	date: (x, y) => compareOrdered(x, y),
	text: (x, y) => compareCodePoints(x, y),
	bytes: (x, y) => compareBytes(x.bytes, y.bytes),
	code: (x, y, order) => sign(rankOf(order.roster, x) - rankOf(order.roster, y)),
	bits: (x, y, order) => compareSets(x, y, order.roster),
	range4: (x, y) => compareSpan(x, y),
	range8: (x, y) => compareSpan(x, y),
	rangeDate: (x, y) => compareSpan(x, y),
	vector: (x, y) => Vector.compare(x, y),
	exactInteger: (x, y) => compareOrdered(x, y),
	exactMoney: (x, y) => x.compare(y)
}

/**
 * Whether PostgreSQL's equality of a carrier's values is their host values' identity: a carrier each of whose values has
 * one host value, so two values are equal exactly where they are one host value (compareValues's 0 of them): an
 * integer, a boolean, a uuid's and a date's text, a text, whose order compares code points, and a closed id's handle,
 * whose order ranks it in its roster. A numeric's and money's are objects; a double's NaN is equal to itself in
 * PostgreSQL's order and to no value in the host's identity; bytes, a set, a span and a vector are objects; so each of
 * those is equal by its order. Each carrier states it here, so a new one is a case to decide.
 */
export const equalByIdentity: { readonly [C in Carrier]: boolean } = {
	int2: true,
	int4: true,
	int8: true,
	numeric: false,
	float4: false,
	float8: false,
	money: false,
	bool: true,
	uuid: true,
	date: true,
	text: true,
	bytes: false,
	code: true,
	bits: false,
	range4: false,
	range8: false,
	rangeDate: false,
	vector: false,
	exactInteger: true,
	exactMoney: false
}

/**
 * PostgreSQL's order of two values of one carrier, the host's one comparison of values: by `order`, a codec's spec
 * (CarrierSpec), whose closed ids rank by the installation's codes, or the evaluator's (scalar/compute/evaluate.ts
 * evaluatorOrder), whose rank by their roster's declaration, the same order (ir/codes.ts HandleOrder).
 */
export const compareValues = <C extends Carrier>(
	order: OrderSpecOf<C> & OrderSpec,
	a: CarrierHost[C],
	b: CarrierHost[C]
): -1 | 0 | 1 => {
	const own: OrderSpecOf<C> = order
	const compare: (a: CarrierHost[C], b: CarrierHost[C], order: OrderSpecOf<C>) => -1 | 0 | 1 =
		comparators[own.carrier]
	return compare(a, b, own)
}

/**
 * A value of a carrier's host type, which a value grizzle admitted or computed at a type of that carrier is: the one site
 * of the fact "a value held at a type holds its carrier's host value". An admitted fact is a record keyed by its
 * heading's runtime field names, the host type of each field's value a function of the carrier of the field of that
 * name's spec (CarrierSpec), in a heading held apart from it; an evaluated term's value is a function of the term's
 * type, its type's carrier, held in its expression table apart from it (scalar/compute/evaluate.ts); the two meet at
 * evaluatedValue and heldValue. No TypeScript type is indexed by a runtime name or ties two runtime
 * structures entry by entry, and a carrier packed with its value only moves the lookup to the reader, which reaches it
 * through a name or an id from another structure, so a value of another host type is a defect, and throws.
 */
export const hostOf = <C extends Carrier>(carrier: C, value: unknown): CarrierHost[C] => {
	if (!isHostValue(carrier, value)) {
		throw defect(`a ${carrier} host value`)
	}
	return value
}

/** An integer numeric's bigint as the Decimal numeric.c computes with. */
const decimalOfInteger = (x: bigint): Decimal => {
	const d = Decimal.fromBigInt(x)
	if (!d.ok) {
		throw defect(
			"an integer numeric's value is a Decimal: its typmod bounds it far inside numeric's format"
		)
	}
	return d.value
}

/**
 * A field's host value of type `t` as the evaluator computes with it (scalar/compute/evaluate.ts), its type carrier's
 * host value: the value itself, but an integer numeric's bigint (integerTypmodOf), which the evaluator reads as the
 * Decimal numeric.c computes with, since numeric arithmetic is the column's whatever its scale.
 */
export const evaluatedValue = (t: ScalarType, value: unknown): HostValue =>
	integerTypmodOf(t) === undefined
		? hostOf(baseOf(t).carrier, value)
		: decimalOfInteger(hostOf("exactInteger", value))

/**
 * An evaluated value of type `t` as a field of the type holds it, the inverse of evaluatedValue: an integer numeric's
 * Decimal as its bigint, every other value itself. A value of an integer numeric type is an integer, since its typmod's
 * coercion and every stored literal of it refuse NaN and round a fraction away (decimal.ts normalizeNumeric), so any
 * other is a defect, and throws.
 */
export const heldValue = (t: ScalarType, value: unknown): HostValue => {
	if (integerTypmodOf(t) === undefined) {
		return hostOf(baseOf(t).carrier, value)
	}
	const x = integerOfDecimal(hostOf("numeric", value))
	if (x === undefined) {
		throw defect("an evaluated integer numeric is an integer")
	}
	return x
}

/** A value this spec already admitted, held in an admitted fact's field, as its carrier's host value (hostOf). */
export const admitted = <C extends Carrier>(
	spec: SpecOf<C> & CarrierSpec,
	value: unknown
): CarrierHost[C] => {
	const own: SpecOf<C> = spec
	return hostOf(own.carrier, value)
}

/** The canonical text of a value this spec already admitted (admitted). */
export const admittedText = <C extends Carrier>(
	spec: SpecOf<C> & CarrierSpec,
	value: unknown
): string => canonicalText(spec, admitted(spec, value))

/**
 * The text a key compares a value by, of its canonical text (canonicalText): the text itself, but a float zero's, -0's
 * and +0's alike, since PostgreSQL's equality holds them one key: two values of one type share a key text exactly when
 * that equality holds them equal, as a key's same-key refusal reads them, where a fact's identity tells them apart.
 */
export const keyText = (spec: CarrierSpec, text: string): string =>
	(spec.carrier === "float4" || spec.carrier === "float8") && text === floatText(-0)
		? floatText(0)
		: text

export interface HeadingField {
	readonly name: string
	readonly spec: CarrierSpec
}

/** A fact refused at the boundary: the fault, and the field it is in when it is about one field. */
interface FactFault {
	readonly fault: CodecFault
	readonly field: string | undefined
}

/**
 * An admitted fact: its values, and its identity, each field's canonical text in field-name order, as the list itself
 * (`texts`) and as its key (core/text.ts TextsKey), one string, the same exactly for the same fact of its heading, whose
 * own order is the canonical order of facts: the code point order of the JSON text of the texts, the order normal
 * facts are in (codec/recordset.ts). Every canonical text is well-formed.
 */
export interface AdmittedFact {
	/** The admitted values, by field name, frozen. */
	readonly fact: { readonly [field: string]: unknown }
	/** Each field's canonical text, in field-name order, a bytes field's its digest. */
	readonly texts: ReadonlyArray<string>
	/** The fact's identity, its texts' key. */
	readonly identity: TextsKey
}

const fieldOrder = (a: HeadingField, b: HeadingField): number => compareCodePoints(a.name, b.name)

/**
 * What admitting a fact reads of its heading, worked out once per heading rather than once per fact (the relation
 * codec plans its heading when it is built, codec/recordset.ts): its fields in name order, and whether a name repeats.
 */
export interface HeadingPlan {
	readonly fields: ReadonlyArray<HeadingField>
	/** Each field in name order up to the first whose name repeats the one before. */
	readonly entries: ReadonlyArray<HeadingField>
	/** Whether the heading repeats a name: a fact of it is refused once its entries before the repeat are admitted. */
	readonly names: "distinct" | "repeated"
}

export const headingPlan = (heading: ReadonlyArray<HeadingField>): HeadingPlan => {
	const fields = heading.toSorted(fieldOrder)
	const repeat = firstIndex(fields, (f, i) => i > 0 && fields[i - 1]?.name === f.name)
	return {
		fields,
		entries: repeat === undefined ? fields : fields.slice(0, repeat),
		names: repeat === undefined ? "distinct" : "repeated"
	}
}

/** Whether two numeric typmods are one, or both none. */
const sameTypmod = (a: NumericTypmod | undefined, b: NumericTypmod | undefined): boolean =>
	a === b ||
	(a !== undefined && b !== undefined && a.precision === b.precision && a.scale === b.scale)

/** Whether two rosters' codecs are one: one roster, each code the same handle, each hole a hole. */
const sameCodes = (a: RosterCodec, b: RosterCodec): boolean =>
	a === b ||
	(a.roster === b.roster &&
		a.names.length === b.names.length &&
		a.names.every((name, code) => name === b.names[code]))

/**
 * Whether a spec of carrier C and another spec admit, part and spell every value alike, each read through its own
 * carrier: the other spec of C too, with the same typmod, roster codes, dimensions or width.
 */
const sameExtras: { readonly [C in Carrier]: (a: SpecOf<C>, b: CarrierSpec) => boolean } = {
	int2: (_, b) => b.carrier === "int2",
	int4: (_, b) => b.carrier === "int4",
	int8: (_, b) => b.carrier === "int8",
	numeric: (a, b) => b.carrier === "numeric" && sameTypmod(a.typmod, b.typmod),
	float4: (_, b) => b.carrier === "float4",
	float8: (_, b) => b.carrier === "float8",
	money: (_, b) => b.carrier === "money",
	bool: (_, b) => b.carrier === "bool",
	uuid: (_, b) => b.carrier === "uuid",
	date: (_, b) => b.carrier === "date",
	text: (_, b) => b.carrier === "text",
	bytes: (_, b) => b.carrier === "bytes",
	code: (a, b) => b.carrier === "code" && sameCodes(a.roster, b.roster),
	bits: (a, b) => b.carrier === "bits" && sameCodes(a.roster, b.roster),
	range4: (a, b) => b.carrier === "range4" && a.width === b.width,
	range8: (a, b) => b.carrier === "range8" && a.width === b.width,
	rangeDate: (a, b) => b.carrier === "rangeDate" && a.width === b.width,
	vector: (a, b) => b.carrier === "vector" && a.dimensions === b.dimensions,
	exactInteger: (a, b) => b.carrier === "exactInteger" && sameTypmod(a.typmod, b.typmod),
	exactMoney: (_, b) => b.carrier === "exactMoney"
}

/** Whether two specs admit, part and spell every value alike (`sameExtras`). */
const sameSpec = <C extends Carrier>(a: SpecOf<C> & CarrierSpec, b: CarrierSpec): boolean => {
	const own: SpecOf<C> = a
	const same: (a: SpecOf<C>, b: CarrierSpec) => boolean = sameExtras[own.carrier]
	return same(own, b)
}

/**
 * Whether two planned headings read every fact alike: the same fields, each of the same name and spec, so a fact read
 * against one is read against the other, value for value and part for part (`readFact`). Codes are an installation's,
 * so a closed id's or a set's field is the same only under the same roster codes.
 */
export const samePlan = (a: HeadingPlan, b: HeadingPlan): boolean =>
	a === b ||
	(a.names === b.names &&
		a.fields.length === b.fields.length &&
		a.fields.every((field, at) => {
			const other = b.fields[at]
			return other !== undefined && field.name === other.name && sameSpec(field.spec, other.spec)
		}))

/** What reading a fact answers for a fact whose shape could not be read. */
const unshapedFact = (): FactFault => ({ fault: "factShape", field: undefined })

/**
 * One own field of a fact, read once through its descriptor: a data property's value, or what its getter returns
 * when called once; none when the fact has no such own field.
 */
const ownField = (fact: object, name: string): Result.Result<unknown, FactFault> =>
	hostRead<unknown, FactFault>(
		() => ({ fault: "factShape", field: name }),
		() => {
			const descriptor = Reflect.getOwnPropertyDescriptor(fact, name)
			if (descriptor === undefined) {
				return Result.err({ fault: "factShape", field: name })
			}
			const value: unknown =
				descriptor.get === undefined ? descriptor.value : Reflect.apply(descriptor.get, fact, [])
			return Result.ok(value)
		}
	)

/**
 * A fact read against its heading and its values admitted, its bytes values not yet digested: each field's value in the
 * heading's name order, a bytes field's the caller's array (values/bytes.ts checkBytes), and each field's part of its
 * identity, a bytes field's its length, so two reads of one fact share their parts and two facts whose parts differ
 * are two facts. Reading a fact reads none of its bytes, so an input can be measured from its parts and lengths alone
 * before any is (codec/recordset.ts RelationNormalizer).
 */
export interface ReadFact {
	readonly values: ReadonlyArray<unknown>
	readonly parts: ReadonlyArray<string>
}

/**
 * Reads a fact against its heading: a plain object whose own keys are exactly the heading's field names, each value
 * admitted by its carrier but a bytes value, which is checked and kept as it is (`ReadFact`). Its shape and each field
 * are read once (hostRead), so a getter runs once and what it returned is the value admitted.
 *
 * A fact is refused by the first fault the one read meets, in the order it reads, which is the order of refusal:
 * - the fact itself: NULL or undefined is nullValue, the null ban's; anything but a plain record, or one whose own
 *   keys are not as many as its heading's fields, is factShape;
 * - then each field in its heading's name order (`HeadingPlan` entries): a field the fact lacks, or one whose read
 *   throws, is factShape at it; a NULL or undefined value is nullValue at it; a value its carrier does not admit is
 *   that carrier's fault at it (`admitValue`);
 * - then a heading that repeats a name refuses the fact as factShape.
 * So the null ban is one fault among a field's, never a pass of its own: a NULL in a fact of another shape is the
 * shape's refusal, and a NULL after a field its carrier refuses is that field's.
 *
 * A per-fact hot path: the heading's plan is worked out once per heading, and each fact costs one pass over its
 * fields with no per-field closure, tuple or Option beyond the field's own read.
 */
export const readFact = (plan: HeadingPlan, fact: unknown): Result.Result<ReadFact, FactFault> => {
	if (fact === null || fact === undefined) {
		return Result.err({ fault: "nullValue", field: undefined })
	}
	if (typeof fact !== "object") {
		return Result.err({ fault: "factShape", field: undefined })
	}
	const keys = hostRead<number, FactFault>(unshapedFact, () =>
		isPlainRecord(fact)
			? Result.ok(Reflect.ownKeys(fact).length)
			: Result.err({ fault: "factShape", field: undefined })
	)
	if (!keys.ok) {
		return Result.err(keys.error)
	}
	if (keys.value !== plan.fields.length) {
		return Result.err({ fault: "factShape", field: undefined })
	}
	const { entries, names } = plan
	const values: Array<unknown> = []
	const parts: Array<string> = []
	for (const field of entries) {
		const read = ownField(fact, field.name)
		if (!read.ok) {
			return Result.err(read.error)
		}
		const value = admitValue(field.spec, read.value)
		if (!value.ok) {
			return Result.err({ fault: value.error, field: field.name })
		}
		values.push(value.value)
		parts.push(partOf(field.spec, value.value))
	}
	if (names === "repeated") {
		return Result.err({ fault: "factShape", field: undefined })
	}
	return Result.ok({ values, parts })
}

/**
 * A stated value read as its field's: the one admission of a caller's value of a field, every reader's, a write's facts
 * (readFact), an evaluated row's (program/evaluate.ts admission) and a decoded row's (program/decode.ts): NULL or
 * undefined refused by the null ban (nullValue), a field holding no value; a bytes value checked and kept as it is,
 * its bytes unread (values/bytes.ts checkBytes), or a value admitted already; every other carrier's value its exact
 * parse (parseValue).
 */
export const admitValue = (
	spec: CarrierSpec,
	value: unknown
): Result.Result<HostValue | Uint8Array, CodecFault> =>
	value === null || value === undefined
		? Result.err("nullValue")
		: spec.carrier !== "bytes"
			? parseValue(spec, value)
			: value instanceof AdmittedBytes
				? Result.ok(value)
				: checkBytes(value)

/**
 * A read value's part of its fact's identity (ReadFact `parts`), from the value admitValue read: a bytes value's length,
 * the caller's array's or an admitted value's, and any other's canonical text.
 */
const partOf = (spec: CarrierSpec, value: HostValue | Uint8Array): string =>
	value instanceof Uint8Array
		? String(value.length)
		: spec.carrier === "bytes" && value instanceof AdmittedBytes
			? String(value.bytes.length)
			: canonicalText(spec, value)

/**
 * How a read holds a carrier's value (ReadFact `values`): an immutable value ("shared"), a primitive or a frozen object,
 * which any number of writes may take from one read; or one a write takes again from the read ("again"): a bytes
 * value, the caller's array, which a read checks and keeps unread (values/bytes.ts checkBytes); a set's, the copy its
 * read made in a Set, which no freeze fixes (admitHandles); a vector's, the copy its read made in a Float32Array
 * (admitVector).
 */
const heldAs: { readonly [C in Carrier]: "shared" | "again" } = {
	int2: "shared",
	int4: "shared",
	int8: "shared",
	numeric: "shared",
	float4: "shared",
	float8: "shared",
	money: "shared",
	bool: "shared",
	uuid: "shared",
	date: "shared",
	text: "shared",
	bytes: "again",
	code: "shared",
	bits: "again",
	range4: "shared",
	range8: "shared",
	rangeDate: "shared",
	vector: "again",
	exactInteger: "shared",
	exactMoney: "shared"
}

/** The positions among a planned heading's entries of the fields whose values a write takes again (`heldAs`). */
export const againAt = (plan: HeadingPlan): ReadonlyArray<number> =>
	plan.entries.flatMap((field, at) => (heldAs[field.spec.carrier] === "again" ? [at] : []))

/**
 * A fact's read made earlier, as a write takes it now, `again` the positions of its heading's fields it takes again
 * (`againAt`), each admitted again from the value the read holds: a bytes value checked again, its part its length
 * now, so a buffer detached since is refused as a read now refuses it and one resized since is measured at its length
 * now; a set or a vector copied again, so every write holds a copy of its own and the read's own copy goes to none, its
 * part the same, since its members or components are the copy's. Every other value is immutable, the read's own.
 */
export const readAgain = (
	plan: HeadingPlan,
	read: ReadFact,
	again: ReadonlyArray<number>
): Result.Result<ReadFact, FactFault> => {
	let values: Array<unknown> | undefined
	let parts: Array<string> | undefined
	for (const at of again) {
		const { name, spec } = defined(plan.entries[at], "a field among the heading's entries")
		const value = admitValue(spec, read.values[at])
		if (!value.ok) {
			return Result.err({ fault: value.error, field: name })
		}
		if (value.value !== read.values[at]) {
			values ??= [...read.values]
			values[at] = value.value
		}
		if (spec.carrier === "bytes") {
			const part = partOf(spec, value.value)
			if (part !== read.parts[at]) {
				parts ??= [...read.parts]
				parts[at] = part
			}
		}
	}
	return Result.ok(
		values === undefined && parts === undefined
			? read
			: { values: values ?? read.values, parts: parts ?? read.parts }
	)
}

/**
 * A read fact's bytes field `name` admitted with its digest: the caller's array digested, or a value admitted already
 * as it is; any other value there is a defect of the read that holds it.
 */
const admittedRead = (value: unknown, name: string): AdmittedBytes => {
	if (value instanceof AdmittedBytes) {
		return value
	}
	if (!(value instanceof Uint8Array)) {
		throw defect(`a read fact's bytes field ${name}, the caller's array`)
	}
	return new AdmittedBytes(value)
}

/**
 * A read fact admitted whole: each bytes value admitted with its digest (values/bytes.ts AdmittedBytes), which is its
 * text in the fact's identity (AdmittedFact), every other text the read's part.
 */
export const digestFact = (plan: HeadingPlan, read: ReadFact): AdmittedFact => {
	/** A prototype-less object, so assigning "__proto__" defines an ordinary property. */
	const kept: Record<string, unknown> = {}
	Reflect.setPrototypeOf(kept, null)
	let digested: Array<string> | undefined
	for (const [at, field] of plan.entries.entries()) {
		const value = read.values[at]
		if (field.spec.carrier !== "bytes") {
			kept[field.name] = value
			continue
		}
		const bytes = admittedRead(value, field.name)
		kept[field.name] = bytes
		digested ??= [...read.parts]
		digested[at] = bytes.digest
	}
	const texts = digested ?? read.parts
	return { fact: Object.freeze(kept), texts, identity: textsKey(texts) }
}

/**
 * Admits a fact against its heading (`readFact`, `digestFact`). The identity is each field's canonical text in
 * field-name order, keyed (`AdmittedFact`).
 */
export const factIdentity = (
	heading: ReadonlyArray<HeadingField>,
	fact: unknown
): Result.Result<AdmittedFact, FactFault> => admitFact(headingPlan(heading), fact)

/** factIdentity over a heading already planned (headingPlan): the per-fact path of a codec that planned its heading. */
const admitFact = (plan: HeadingPlan, fact: unknown): Result.Result<AdmittedFact, FactFault> => {
	const read = readFact(plan, fact)
	return read.ok ? Result.ok(digestFact(plan, read.value)) : read
}
