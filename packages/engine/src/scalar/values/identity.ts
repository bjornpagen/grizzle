import { firstIndex } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { compareCodePoints } from "@bjornpagen/grizzle-text/text"
import { sha256Text, toSha256 } from "#compiler/core/digest.ts"
import type { CodecFault, ValueFault } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { isPlainRecord } from "#compiler/core/record.ts"
import { type TextsId, textsId, validateText } from "#compiler/core/text.ts"
import { int8Max, int8Min } from "#compiler/ir/carriers.ts"
import { codeOf, type HandleOrder, handlesText, type RosterCodec } from "#compiler/ir/codes.ts"
import { type CalendarDate, toCalendarDate } from "#compiler/ir/date.ts"
import {
	baseOf,
	type Carrier,
	integerTypmodOf,
	isNonIdentity,
	type NonIdentityCarrier,
	type ScalarType
} from "#compiler/ir/scalar.ts"
import { statedRoster } from "#compiler/scalar/values/bits.ts"
import {
	AdmittedBytes,
	admitBytes,
	checkBytes,
	compareBytes,
	isAdmittedBytes
} from "#compiler/scalar/values/bytes.ts"
import {
	Numeric,
	integerNumeric,
	integerOfDecimal,
	type NumericBound,
	type NumericTypmod,
	normalizeNumeric,
	parseNumeric,
	withinBound
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
	admitCidr,
	admitInet,
	type Cidr,
	compareNet,
	type Inet,
	netValueOf
} from "#compiler/scalar/values/net.ts"
import { recordText } from "#compiler/scalar/values/record.ts"
import {
	admitSpan,
	compareSpan,
	isSpanOf,
	type Span,
	spanText
} from "#compiler/scalar/values/span.ts"
import { parseSearchDocument } from "#compiler/scalar/values/tsvector.ts"
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
	| "variant"
>

/** One field of a variant's arm as a spec reads it: its name and its own type's spec. */
export interface VariantFieldSpec {
	readonly name: string
	readonly spec: CarrierSpec
}

/**
 * One arm of a variant as a spec reads it: its fields in declared order, each with `at`, the attribute of the variant's
 * composite it is, in the variant's layout under the installation's codes (ir/codes.ts variantLayout).
 */
export interface VariantArmSpec {
	readonly fields: ReadonlyArray<
		VariantFieldSpec & { readonly at: number; readonly zero: number | undefined }
	>
}

/**
 * A variant's host value: its arm's handle under `tag`, and the host value of each of that arm's fields under its name,
 * frozen, its keys the tag and then the arm's fields in declared order (admitVariant).
 */
export interface VariantValue {
	readonly tag: string
	readonly [field: string]: unknown
}

/**
 * What a carrier needs beyond its name to admit a value. A closed id and a set over a roster carry the roster's codes,
 * which the installation holds: a handle is written as its code, and a set as its hex digits, one bit per code. Bytes
 * is a spec of its own, since its value travels as no text, so a spec narrowed by it is a text carrier's.
 *
 * A spec is the value's, its host value's carrier, which is its type's carrier but for an integer numeric: numeric(p,
 * 0) holds integers alone, so its spec is the exact integer's, of its typmod, and its host value a bigint
 * (codec/scalar.ts carrierSpecOf), where an exact integer's own, a value grizzle computes, has no typmod. numeric's
 * typmod is then one of another scale, or none, numeric of no typmod's, whose values lie within its bound (ir/scalar.ts
 * NumericBound): a computed numeric's, or numeric's own limits, numeric's.
 */
export type CarrierSpec =
	| { readonly carrier: PlainCarrier }
	| { readonly carrier: "bytes" }
	| { readonly carrier: "numeric"; readonly typmod: NumericTypmod }
	| { readonly carrier: "numeric"; readonly typmod: undefined; readonly bound: NumericBound }
	| { readonly carrier: "exactInteger"; readonly typmod: NumericTypmod | undefined }
	| {
			readonly carrier: "code"
			readonly roster: RosterCodec
			/** The handles of the subset of its roster the closed id holds; none for every handle (ir/scalar.ts CodeType). */
			readonly only: ReadonlySet<string> | undefined
	  }
	| { readonly carrier: "bits"; readonly roster: RosterCodec }
	| { readonly carrier: "vector"; readonly dimensions: number }
	| { readonly carrier: "range4" | "range8" | "rangeDate"; readonly width: bigint | undefined }
	| {
			readonly carrier: "variant"
			/** The tag's roster's codes: a value is written by its tag's code, as a closed id is. */
			readonly roster: RosterCodec
			/** Each live handle's arm, by handle. */
			readonly arms: ReadonlyMap<string, VariantArmSpec>
			/** The composite's attributes: the tag and every arm's fields. */
			readonly attributes: number
	  }

export interface CarrierHost {
	readonly int2: number
	readonly int4: number
	readonly int8: bigint
	readonly numeric: Numeric
	readonly float4: number
	readonly float8: number
	readonly money: Money
	readonly bool: boolean
	readonly uuid: string
	/** A date's host value is its ISO 8601 text, its one form (ir/date.ts). */
	readonly date: CalendarDate
	/** An inet's and a cidr's host value is inet_out's and cidr_out's text, its one form (values/net.ts). */
	readonly inet: Inet
	readonly cidr: Cidr
	readonly text: string
	/** A bytes value's host value is its bytes with their digest (values/bytes.ts AdmittedBytes). */
	readonly bytes: AdmittedBytes
	/** A digest's host value is its 32 bytes (values/sha256.ts Sha256), a copy its admission made. */
	readonly sha256: Uint8Array
	/** A closed id's host value is its handle. */
	readonly code: string
	/** A set's host value is its handles. */
	readonly bits: ReadonlySet<string>
	readonly range4: Span<number>
	readonly range8: Span<bigint>
	readonly rangeDate: Span<CalendarDate>
	readonly vector: Vector
	/**
	 * A search document's host value is the text PostgreSQL prints for it (tsvector_out): its lexemes in their one order,
	 * each with its positions and weights, so two documents are one value exactly where their texts are one.
	 */
	readonly tsvector: string
	readonly exactInteger: bigint
	readonly exactMoney: Money
	/** A variant's host value is its arm's handle and that arm's fields' host values (VariantValue). */
	readonly variant: VariantValue
}

/** A value of some carrier as the host holds it: its carrier's host value (CarrierHost). */
export type HostValue = CarrierHost[Carrier]

/** What each carrier's spec holds beside its carrier: the CarrierSpec variant's other members. */
interface SpecExtras {
	readonly int2: unknown
	readonly int4: unknown
	readonly int8: unknown
	readonly numeric:
		| { readonly typmod: NumericTypmod }
		| { readonly typmod: undefined; readonly bound: NumericBound }
	readonly float4: unknown
	readonly float8: unknown
	readonly money: unknown
	readonly bool: unknown
	readonly uuid: unknown
	readonly date: unknown
	readonly inet: unknown
	readonly cidr: unknown
	readonly text: unknown
	readonly bytes: unknown
	readonly sha256: unknown
	readonly code: { readonly roster: RosterCodec; readonly only: ReadonlySet<string> | undefined }
	readonly bits: { readonly roster: RosterCodec }
	readonly vector: { readonly dimensions: number }
	readonly tsvector: unknown
	readonly range4: { readonly width: bigint | undefined }
	readonly range8: { readonly width: bigint | undefined }
	readonly rangeDate: { readonly width: bigint | undefined }
	readonly exactInteger: { readonly typmod: NumericTypmod | undefined }
	readonly exactMoney: unknown
	readonly variant: {
		readonly roster: RosterCodec
		readonly arms: ReadonlyMap<string, VariantArmSpec>
		readonly attributes: number
	}
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
	readonly inet: unknown
	readonly cidr: unknown
	readonly text: unknown
	readonly bytes: unknown
	readonly sha256: unknown
	readonly code: { readonly roster: HandleOrder }
	readonly bits: { readonly roster: HandleOrder }
	readonly vector: unknown
	readonly tsvector: unknown
	readonly range4: unknown
	readonly range8: unknown
	readonly rangeDate: unknown
	readonly exactInteger: unknown
	readonly exactMoney: unknown
	readonly variant: {
		readonly roster: HandleOrder
		readonly arms: ReadonlyMap<
			string,
			{ readonly fields: ReadonlyArray<{ readonly name: string; readonly spec: OrderSpec }> }
		>
	}
}

/** What the order of one carrier's values reads, its carrier exactly C. Every carrier's spec is one (CarrierSpec). */
export type OrderSpecOf<C extends Carrier> = { readonly carrier: C } & OrderExtras[C]

/** What the order of some carrier's values reads (OrderSpecOf), a codec's spec (CarrierSpec) among them. */
export type OrderSpec = { readonly [C in Carrier]: OrderSpecOf<C> }[Carrier]

/**
 * A numeric value at its spec: at its typmod by `atTypmod`, parsed exactly (decimal.ts parseNumeric) or coerced as
 * PostgreSQL coerces a value it computes (normalizeNumeric); without one, within its bound (decimal.ts withinBound), a
 * computed numeric's, which a stored field of it (numeric.within) and a window anchor's key value of an aggregate
 * column hold, or numeric's own limits, which every Numeric is within. A value of the bound is never rounded into it:
 * PostgreSQL's numeric of no typmod stores a value as it is, so one past the bound is refused (numericBound).
 */
const decimalAt =
	(atTypmod: (d: Numeric, typmod: NumericTypmod) => Result.Result<Numeric, ValueFault>) =>
	(value: unknown, spec: SpecExtras["numeric"]): Result.Result<Numeric, ValueFault> =>
		value instanceof Numeric
			? spec.typmod === undefined
				? withinBound(value, spec.bound)
				: atTypmod(value, spec.typmod)
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
const admitHandle = (value: unknown, roster: LiveHandles): Result.Result<string, ValueFault> =>
	typeof value === "string" && roster.rank.has(value) ? Result.ok(value) : Result.err("codeHandle")

/**
 * A handle of the subset `only` of a roster a closed id holds (ir/scalar.ts CodeType): a live handle of the roster
 * (admitHandle), and one of `only`'s, where the closed id holds no more than some of them; any other is codeSubset.
 */
export const admitSubsetHandle = (
	value: unknown,
	roster: LiveHandles,
	only: ReadonlySet<string> | undefined
): Result.Result<string, ValueFault> =>
	Result.flatMap(admitHandle(value, roster), (handle) =>
		only === undefined || only.has(handle) ? Result.ok(handle) : Result.err("codeSubset")
	)

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
 * A variant's value, read once into a frozen record grizzle alone holds: a plain record whose own keys are exactly `tag`,
 * a live handle of the variant's roster, and that arm's fields, each admitted by its own spec through `admit` (the
 * exact parse of a caller's value, or PostgreSQL's coercion of one grizzle computed). A value that is no such record is
 * variantType, a tag no arm holds variantTag, and a field its spec refuses that field's own fault.
 */
const admitVariant = (
	value: unknown,
	spec: SpecExtras["variant"],
	admit: (spec: CarrierSpec, value: unknown) => Result.Result<HostValue, ValueFault>
): Result.Result<VariantValue, ValueFault> => {
	if (!isPlainRecord(value)) {
		return Result.err("variantType")
	}
	const tag = value["tag"]
	if (typeof tag !== "string") {
		return Result.err("variantType")
	}
	const arm = spec.arms.get(tag)
	if (arm === undefined) {
		return Result.err("variantTag")
	}
	if (Reflect.ownKeys(value).length !== arm.fields.length + 1) {
		return Result.err("variantType")
	}
	const held: Record<string, unknown> = { tag }
	for (const field of arm.fields) {
		if (!Object.hasOwn(value, field.name)) {
			return Result.err("variantType")
		}
		const fieldValue: unknown = value[field.name]
		if (fieldValue === null || fieldValue === undefined) {
			return Result.err("variantType")
		}
		const admittedField = admit(field.spec, fieldValue)
		if (!admittedField.ok) {
			return admittedField
		}
		held[field.name] = admittedField.value
	}
	return Result.ok(Object.freeze({ ...held, tag }))
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
	numeric: (value, spec) => decimalAt(normalizeNumeric)(value, spec),
	float4: (value) => toReal(value),
	float8: (value) => toDouble(value),
	money: (value) => admitMoney(value),
	bool: (value) => (typeof value === "boolean" ? Result.ok(value) : Result.err("boolType")),
	uuid: (value) => toUuid(value),
	date: (value) => toCalendarDate(value),
	inet: (value) => admitInet(value),
	cidr: (value) => admitCidr(value),
	text: (value) => validateText(value),
	bytes: (value) => admitBytes(value),
	sha256: (value) => Result.map(toSha256(value), (digest) => Uint8Array.from(digest)),
	code: (value, spec) => admitSubsetHandle(value, spec.roster, spec.only),
	bits: (value, spec) => admitHandles(value, spec.roster),
	range4: (value, spec) => admitSpan("int4", value, spec.width),
	range8: (value, spec) => admitSpan("int8", value, spec.width),
	rangeDate: (value, spec) => admitSpan("date", value, spec.width),
	vector: (value, spec) => admitVector(value, spec.dimensions),
	tsvector: (value) => parseSearchDocument(value),
	exactInteger: (value, spec) => integerAt(value, spec.typmod),
	exactMoney: (value) => (value instanceof Money ? Result.ok(value) : Result.err("moneyType")),
	variant: (value, spec) => admitVariant(value, spec, (field, v) => storedValue(field, v))
}

/**
 * The exact parse of a caller's value, every carrier's: the value of the declared type it is, unchanged, or the fault
 * that no such value exists. It never rounds: a numeric of more fractional digits than its typmod's scale and a double
 * that is no binary32 value are refused, where PostgreSQL would store another value than the one sent. Every other
 * carrier's parse is its coercion, which alters no value: its one form only, -0 as +0, a uuid in lowercase.
 */
const parsers: Admitters = {
	...coercions,
	numeric: (value, spec) => decimalAt(parseNumeric)(value, spec),
	float4: (value) => parseReal(value),
	variant: (value, spec) => admitVariant(value, spec, (field, v) => parseValue(field, v))
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
	inet: () => "inetSyntax",
	cidr: () => "cidrSyntax",
	text: () => "textType",
	bytes: () => "bytesType",
	sha256: () => "sha256Value",
	code: () => "codeHandle",
	bits: () => "bitsType",
	range4: () => "spanType",
	range8: () => "spanType",
	rangeDate: () => "spanType",
	vector: () => "vectorType",
	tsvector: () => "textType",
	exactInteger: () => "integerType",
	exactMoney: () => "moneyType",
	variant: () => "variantType"
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
	numeric: (value) => value instanceof Numeric,
	float4: isNumber,
	float8: isNumber,
	money: (value) => value instanceof Money,
	bool: (value) => typeof value === "boolean",
	uuid: isString,
	date: (value): value is CalendarDate => toCalendarDate(value).ok,
	inet: (value): value is Inet => admitInet(value).ok,
	cidr: (value): value is Cidr => admitCidr(value).ok,
	text: isString,
	bytes: isAdmittedBytes,
	sha256: (value) => value instanceof Uint8Array,
	code: isString,
	bits: isStringSet,
	range4: isSpanOf(isNumber),
	range8: isSpanOf(isBigint),
	rangeDate: isSpanOf((value): value is CalendarDate => toCalendarDate(value).ok),
	vector: isVector,
	tsvector: isString,
	exactInteger: isBigint,
	exactMoney: (value) => value instanceof Money,
	variant: (value): value is VariantValue =>
		isPlainRecord(value) && Object.isFrozen(value) && typeof value["tag"] === "string"
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
	inet: (v) => v,
	cidr: (v) => v,
	text: (v) => v,
	bytes: (v) => v.digest,
	sha256: (v) => sha256Text(v),
	code: (v, spec) => String(codeOf(spec.roster, v)),
	bits: (v, spec) => handlesText(spec.roster, v),
	range4: (v) => spanText(v),
	range8: (v) => spanText(v),
	rangeDate: (v) => spanText(v),
	vector: (v) => Vector.componentText(v),
	tsvector: (v) => v,
	exactInteger: (v) => String(v),
	exactMoney: (v) => v.toString(),
	variant: (v, spec) => variantText(v, spec)
}

/**
 * A variant value's one text: the record literal of its composite (ir/scalar.ts VariantType), `(` the tag's code, then
 * each attribute, its arm's fields' canonical texts at their attributes and every other arm's left unwritten, NULL,
 * `)`. It is the parameter text record_in reads into the variant's domain, which checks each attribute's own domain
 * and the arm the tag names, and the fact identity's part: two values are one exactly where their tags are and each
 * field's canonical text is, since each attribute is quoted and so framed.
 */
const variantText = (value: VariantValue, spec: SpecExtras["variant"]): string => {
	const arm = defined(spec.arms.get(value.tag), "an admitted variant's arm")
	const attributes: Array<string | undefined> = Array.from(
		{ length: spec.attributes },
		() => undefined
	)
	attributes[0] = String(codeOf(spec.roster, value.tag))
	for (const field of arm.fields) {
		const held = value[field.name]
		attributes[field.at] = canonicalText(field.spec, hostOf(field.spec.carrier, held))
		if (field.zero !== undefined) {
			attributes[field.zero] = Object.is(held, -0) ? "t" : "f"
		}
	}
	return recordText(attributes)
}

/**
 * Canonical value encoding for fact identity.
 *
 * A value is only its value, the same under every plan. One logical value compares the same in codecs, PostgreSQL
 * equality, DISTINCT, keys, grouping and the test oracle, and every value is in its one form, but a float's zero: -0
 * and +0 are two values, each its own fact identity, and one key under PostgreSQL's equality (keyText), so a write
 * compares two facts of one key by their identity (ir/compare.ts factEq) and two keys by their key texts. Wherever an
 * operation may take one float of several equal ones, a set's member, a group's key, a union's row, a recursion's
 * state, a join variable's value, the merged zero is +0, so no plan picks one. A write stores the facts it states: a
 * parameter relation's facts and a ChangeSet member's rows are sets of facts by their identity, -0 and +0 two of them,
 * so a -0 a write states is stored as -0 wherever it reads the relation, and two facts at one key that differ only in a
 * zero's sign are refused as two facts (ir/compare.ts factSet, check/checker.ts RowsOf). A read of a parameter relation
 * delivers each of its facts, so -0 and +0 at otherwise equal fields are two rows; a read's own merges, a projection
 * that drops a field, a union or a group's key, take +0 as every merge does. min and max of floats order -0
 * below 0, and a float sum or mean whose exact value is zero is -0 exactly when every value it sums is; any other float
 * that rounds to zero, a product, quotient, conversion or mean too small for its type, is the zero of its sign
 * (check/merge.ts, scalar/aggregate.ts, lower/conservative/expr/total.ts roundToFloat). This module is the host side,
 * per scalar carrier:
 *
 * - `parseValue` is the boundary: the exact parse of a host value as its carrier's, which refuses a value its column
 *   would store as another (a numeric past its scale, a double no binary32 value holds) and alters none: two spellings
 *   of one value are one admitted value (uuid case), so fact identity is the stored value's; a float's -0 is a value of
 *   its own, distinct from +0 (values/float.ts), as PostgreSQL stores it. `storedValue` is
 *   PostgreSQL's own coercion of a value grizzle computes on the host, which rounds as PostgreSQL rounds.
 * - `canonicalText` gives every admitted value its one text, equal exactly when the values are one value, because every
 *   host value is in its one form (a Numeric has no display scale, a vector component one zero): numeric 1.0 = 1.00
 *   are one Numeric written 1, NaN one text, text by exact scalar sequence; a float's -0 and +0 are two values, equal
 *   under PostgreSQL's equality and `compareValues` but each its own fact identity, as a key holds them. It is
 *   the parameter text, the array element and the fact identity's part alike (codec/scalar.ts text); a bytes value's is
 *   its SHA-256 digest (values/bytes.ts BytesDigest), the fact identity's part and no parameter text: every bytes value
 *   travels in binary (codec/bytea.ts). Two bytes values of one digest are one only when their bytes are equal, which
 *   every host site that takes two facts of one identity as one checks (`sameFact`).
 * - `compareValues` is PostgreSQL's B-tree order for the type, the host's one comparison, the evaluator's
 *   (scalar/compute/evaluate.ts) and the stored values' alike: float and numeric total orders with NaN last, text in
 *   code point order, uuid and bytes by bytes, inet and cidr as network_cmp orders them (values/net.ts), closed ids by code, which is roster order (ir/codes.ts HandleOrder), spans
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
	inet: (x, y) => compareNet(netValueOf(x, "inet"), netValueOf(y, "inet")),
	cidr: (x, y) => compareNet(netValueOf(x, "cidr"), netValueOf(y, "cidr")),
	text: (x, y) => compareCodePoints(x, y),
	bytes: (x, y) => compareBytes(x.bytes, y.bytes),
	sha256: (x, y) => compareBytes(x, y),
	code: (x, y, order) => sign(rankOf(order.roster, x) - rankOf(order.roster, y)),
	bits: (x, y, order) => compareSets(x, y, order.roster),
	range4: (x, y) => compareSpan(x, y),
	range8: (x, y) => compareSpan(x, y),
	rangeDate: (x, y) => compareSpan(x, y),
	vector: (x, y) => Vector.compare(x, y),
	tsvector: (x, y) => compareCodePoints(x, y),
	exactInteger: (x, y) => compareOrdered(x, y),
	exactMoney: (x, y) => x.compare(y),
	variant: (x, y, order) => compareVariants(x, y, order)
}

/**
 * Two variant values in PostgreSQL's record order of their composite: by their tags' codes, the order's rank (ir/codes.ts
 * HandleOrder), then, under one tag, field by field in the arm's declared order, each by its own type's order, a float's
 * then by its zero sign, false first, so 0 before -0 (ir/codes.ts FieldLayout `zero`); every other arm's attributes are
 * absent alike in both, which record order holds equal.
 */
const compareVariants = (
	x: VariantValue,
	y: VariantValue,
	order: OrderExtras["variant"]
): -1 | 0 | 1 => {
	const byTag = sign(rankOf(order.roster, x.tag) - rankOf(order.roster, y.tag))
	if (byTag !== 0) {
		return byTag
	}
	const arm = defined(order.arms.get(x.tag), "a compared variant's arm")
	for (const field of arm.fields) {
		const { spec } = field
		const a = x[field.name]
		const b = y[field.name]
		const byField = compareValues(spec, hostOf(spec.carrier, a), hostOf(spec.carrier, b))
		if (byField !== 0) {
			return byField
		}
		if (spec.carrier === "float4" || spec.carrier === "float8") {
			const byZero = sign(Number(Object.is(a, -0)) - Number(Object.is(b, -0)))
			if (byZero !== 0) {
				return byZero
			}
		}
	}
	return 0
}

/**
 * Whether PostgreSQL's equality of a carrier's values is their host values' identity: a carrier each of whose values has
 * one host value, so two values are equal exactly where they are one host value (compareValues's 0 of them): an
 * integer, a boolean, a uuid's, a date's, an inet's and a cidr's text, a text and a search document's printed text, whose order compares
 * code points, and a closed id's handle, whose order ranks it in its roster. A numeric's and money's are objects; a double's NaN is equal to itself in
 * PostgreSQL's order and to no value in the host's identity; bytes, a digest, a set, a span and a vector are objects; so each of
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
	inet: true,
	cidr: true,
	text: true,
	bytes: false,
	sha256: false,
	code: true,
	bits: false,
	range4: false,
	range8: false,
	rangeDate: false,
	vector: false,
	tsvector: true,
	exactInteger: true,
	exactMoney: false,
	variant: false
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
		defect(`a ${carrier} host value`)
	}
	return value
}

/** An integer numeric's bigint as the Numeric numeric.c computes with. */
const decimalOfInteger = (x: bigint): Numeric => {
	const d = Numeric.fromBigInt(x)
	if (!d.ok) {
		defect(
			"an integer numeric's value is a Numeric: its typmod bounds it far inside numeric's format"
		)
	}
	return d.value
}

/**
 * A field's host value of type `t` as the evaluator computes with it (scalar/compute/evaluate.ts), its type carrier's
 * host value: the value itself, but an integer numeric's bigint (integerTypmodOf), which the evaluator reads as the
 * Numeric numeric.c computes with, since numeric arithmetic is the column's whatever its scale.
 */
export const evaluatedValue = (t: ScalarType, value: unknown): HostValue =>
	integerTypmodOf(t) === undefined
		? hostOf(baseOf(t).carrier, value)
		: decimalOfInteger(hostOf("exactInteger", value))

/**
 * An evaluated value of type `t` as a field of the type holds it, the inverse of evaluatedValue: an integer numeric's
 * Numeric as its bigint, every other value itself. A value of an integer numeric type is an integer, since its typmod's
 * coercion and every stored literal of it refuse NaN and round a fraction away (decimal.ts normalizeNumeric), so any
 * other is a defect, and throws.
 */
export const heldValue = (t: ScalarType, value: unknown): HostValue => {
	if (integerTypmodOf(t) === undefined) {
		return hostOf(baseOf(t).carrier, value)
	}
	const x = integerOfDecimal(hostOf("numeric", value))
	if (x === undefined) {
		defect("an evaluated integer numeric is an integer")
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

/** The canonical text of each carrier whose equality is no identity, of its canonical text (keyText): a float's -0 0. */
const canonicalKeyText: { readonly [C in NonIdentityCarrier]: (text: string) => string } = {
	float4: (text) => (text === floatText(-0) ? floatText(0) : text),
	float8: (text) => (text === floatText(-0) ? floatText(0) : text)
}

/**
 * The text a key compares a value by, of its canonical text (canonicalText): the text itself where its carrier's
 * equality is identity (ir/scalar.ts equalityIsIdentity), else its canonical form's, a float zero's, -0's and +0's
 * alike, since PostgreSQL's equality holds them one key: two values of one type share a key text exactly when that
 * equality holds them equal, as a key's same-key refusal reads them, where a fact's identity tells them apart. A
 * variant's is its text itself: its one equality is its identity, which its composite's record equality is, each float
 * field's zero sign beside it (ir/codes.ts FieldLayout `zero`).
 */
export const keyText = (spec: CarrierSpec, text: string): string =>
	isNonIdentity(spec.carrier) ? canonicalKeyText[spec.carrier](text) : text

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
 * (`texts`) and as its identity (core/text.ts TextsId), the same exactly for the same fact of its heading, whose order
 * is the canonical order of facts: the texts' code point order, field by field, PostgreSQL's C-collation order of
 * their row, the order normal facts are in (codec/recordset.ts). Every canonical text is well-formed.
 */
export interface AdmittedFact {
	/** The admitted values, by field name, frozen. */
	readonly fact: { readonly [field: string]: unknown }
	/** Each field's canonical text, in field-name order, a bytes field's its digest. */
	readonly texts: ReadonlyArray<string>
	/** The fact's identity, its texts' key. */
	readonly identity: TextsId
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
	numeric: (a, b) =>
		b.carrier === "numeric" &&
		(a.typmod === undefined || b.typmod === undefined
			? a.typmod === undefined &&
				b.typmod === undefined &&
				a.bound.digits === b.bound.digits &&
				a.bound.scale === b.bound.scale
			: sameTypmod(a.typmod, b.typmod)),
	float4: (_, b) => b.carrier === "float4",
	float8: (_, b) => b.carrier === "float8",
	money: (_, b) => b.carrier === "money",
	bool: (_, b) => b.carrier === "bool",
	uuid: (_, b) => b.carrier === "uuid",
	date: (_, b) => b.carrier === "date",
	inet: (_, b) => b.carrier === "inet",
	cidr: (_, b) => b.carrier === "cidr",
	text: (_, b) => b.carrier === "text",
	bytes: (_, b) => b.carrier === "bytes",
	sha256: (_, b) => b.carrier === "sha256",
	code: (a, b) => b.carrier === "code" && sameCodes(a.roster, b.roster),
	bits: (a, b) => b.carrier === "bits" && sameCodes(a.roster, b.roster),
	range4: (a, b) => b.carrier === "range4" && a.width === b.width,
	range8: (a, b) => b.carrier === "range8" && a.width === b.width,
	rangeDate: (a, b) => b.carrier === "rangeDate" && a.width === b.width,
	vector: (a, b) => b.carrier === "vector" && a.dimensions === b.dimensions,
	tsvector: (_, b) => b.carrier === "tsvector",
	exactInteger: (a, b) => b.carrier === "exactInteger" && sameTypmod(a.typmod, b.typmod),
	exactMoney: (_, b) => b.carrier === "exactMoney",
	variant: (a, b) =>
		b.carrier === "variant" &&
		sameCodes(a.roster, b.roster) &&
		a.attributes === b.attributes &&
		a.arms.size === b.arms.size &&
		Array.from(a.arms).every(([handle, arm]) => {
			const other = b.arms.get(handle)
			return (
				other !== undefined &&
				other.fields.length === arm.fields.length &&
				arm.fields.every((f, i) => {
					const g = other.fields[i]
					return g !== undefined && f.name === g.name && f.at === g.at && sameSpec(f.spec, g.spec)
				})
			)
		})
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
 * when called once; factShape when the fact has no such own field or its read throws.
 */
const ownField = (fact: object, name: string): Result.Result<unknown, CodecFault> =>
	hostRead<unknown, CodecFault>(
		() => "factShape",
		() => {
			const descriptor = Reflect.getOwnPropertyDescriptor(fact, name)
			if (descriptor === undefined) {
				return Result.err("factShape")
			}
			const value: unknown =
				descriptor.get === undefined ? descriptor.value : Reflect.apply(descriptor.get, fact, [])
			return Result.ok(value)
		}
	)

/**
 * A field `name` of a caller's fact read as `spec`'s, the one reading of a stated field, every reader's, a write's
 * fact's (readFact) and an evaluated row's (program/evaluate.ts admission): its own field read once (`ownField`), a
 * field the fact lacks, or one whose read throws, factShape; then its value admitted (`admitValue`), NULL or undefined
 * the null ban's nullValue.
 */
export const readField = (
	spec: CarrierSpec,
	fact: object,
	name: string
): Result.Result<HostValue | Uint8Array, CodecFault> =>
	Result.flatMap(ownField(fact, name), (value) => admitValue(spec, value))

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
		const value = readField(field.spec, fact, field.name)
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
 * A read value's part of its fact's identity (ReadFact `parts`), from the value admitValue read, by its field's carrier: a
 * bytes value's length, the caller's array's or an admitted value's, and any other's canonical text, a digest's its one
 * text (core/digest.ts sha256Text), though a digest is an array too, so two facts of two digests are two facts.
 */
const partOf = (spec: CarrierSpec, value: HostValue | Uint8Array): string =>
	spec.carrier === "bytes" && value instanceof Uint8Array
		? String(value.length)
		: spec.carrier === "bytes" && value instanceof AdmittedBytes
			? String(value.bytes.length)
			: canonicalText(spec, value)

/**
 * How a read holds a carrier's value (ReadFact `values`): an immutable value ("shared"), a primitive or a frozen object,
 * which any number of writes may take from one read; or one a write takes again from the read ("again"): a bytes
 * value, the caller's array, which a read checks and keeps unread (values/bytes.ts checkBytes); a set's, the copy its
 * read made in a Set, which no freeze fixes (admitHandles); a vector's, the copy its read made in a Float32Array
 * (admitVector); a digest's, the copy its read made of its bytes (toSha256).
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
	inet: "shared",
	cidr: "shared",
	text: "shared",
	bytes: "again",
	sha256: "again",
	code: "shared",
	bits: "again",
	range4: "shared",
	range8: "shared",
	rangeDate: "shared",
	vector: "again",
	tsvector: "shared",
	exactInteger: "shared",
	exactMoney: "shared",
	variant: "again"
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
		defect(`a read fact's bytea field ${name}, the caller's array`)
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
	return { fact: Object.freeze(kept), texts, identity: textsId(texts) }
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
