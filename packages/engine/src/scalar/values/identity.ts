import { firstIndex } from "#compiler/core/array.ts"
import type { ValueFault } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { defect } from "#compiler/core/invariant.ts"
import { int8Max, int8Min } from "#compiler/core/limits.ts"
import * as Result from "#compiler/core/result.ts"
import { compareCodePoints, validateText } from "#compiler/core/text.ts"
import { codeOf, handlesText, type RosterCodec } from "#compiler/ir/codes.ts"
import type { Carrier } from "#compiler/ir/scalar.ts"
import { Decimal, type NumericTypmod, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { compareFloat, floatText, toDouble, toReal } from "#compiler/scalar/values/float.ts"
import { toInt2, toInt4, toInt8 } from "#compiler/scalar/values/integer.ts"
import { type CalendarDate, toCalendarDate } from "#compiler/ir/date.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { admitSpan, compareSpan, type Span, spanText } from "#compiler/scalar/values/span.ts"
import { toUuid } from "#compiler/scalar/values/uuid.ts"
import { admitEncodable, isVector, Vector } from "#compiler/scalar/values/vector.ts"

export type { Carrier }

type PlainCarrier = Exclude<Carrier, "numeric" | "code" | "bits" | "vector" | "range4" | "range8">

/**
 * What a carrier needs beyond its name to admit a value. A closed id and a set over a roster carry the roster's codes,
 * which the installation holds: a handle is written as its code, and a set as one bit per code.
 */
export type CarrierSpec =
	| { readonly carrier: PlainCarrier }
	| { readonly carrier: "numeric"; readonly typmod: NumericTypmod | undefined }
	| { readonly carrier: "code"; readonly roster: RosterCodec }
	| { readonly carrier: "bits"; readonly roster: RosterCodec }
	| { readonly carrier: "vector"; readonly dimensions: number }
	| { readonly carrier: "range4" | "range8"; readonly width: bigint | undefined }

/**
 * A carrier spec as plain data, what its canonical text encodes: a closed id's or a set's spec by its roster's name
 * and its names in code order, a hole the empty name, which are its codec's whole content; its lookup Map is derived
 * from them and no canonical encoding reads one. Two specs of equal content encode equally.
 */
export type SpecContent =
	| Exclude<CarrierSpec, { readonly carrier: "code" | "bits" }>
	| {
			readonly carrier: "code" | "bits"
			readonly roster: string
			readonly names: ReadonlyArray<string>
	  }

/** A spec's content (SpecContent). */
export const specContent = (spec: CarrierSpec): SpecContent =>
	spec.carrier === "code" || spec.carrier === "bits"
		? { carrier: spec.carrier, roster: spec.roster.roster, names: spec.roster.names }
		: spec

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
	/** A date's host value is its ISO 8601 text, its one form (values/date.ts). */
	readonly date: CalendarDate
	readonly text: string
	/** A closed id's host value is its handle. */
	readonly code: string
	/** A set's host value is its handles. */
	readonly bits: ReadonlySet<string>
	readonly range4: Span<number>
	readonly range8: Span<bigint>
	readonly vector: Vector
	readonly exactInteger: bigint
	readonly exactMoney: Money
}

export type HostOf<S extends CarrierSpec> = CarrierHost[S["carrier"]]

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
	readonly code: { readonly roster: RosterCodec }
	readonly bits: { readonly roster: RosterCodec }
	readonly vector: { readonly dimensions: number }
	readonly range4: { readonly width: bigint | undefined }
	readonly range8: { readonly width: bigint | undefined }
	readonly exactInteger: unknown
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
	readonly [C in Carrier]: (a: CarrierHost[C], b: CarrierHost[C], spec: SpecOf<C>) => -1 | 0 | 1
}

/**
 * A numeric value admitted at its typmod, rounded as PostgreSQL's coercion rounds. Without one it is a computed
 * numeric's, a cursor's boundary value of an aggregate column the only one a caller passes: every Decimal is within
 * numeric's limits, and the computed bound (ir/scalar.ts NumericBound) is a proof of the values the database computes,
 * which a boundary value only meets in a comparison.
 */
const admitDecimal = (
	value: unknown,
	typmod: NumericTypmod | undefined
): Result.Result<Decimal, ValueFault> =>
	value instanceof Decimal
		? normalizeNumeric(value, typmod)
		: Result.err(typeof value === "number" ? "decimalNumber" : "decimalType")

/**
 * The encode-time boundary of a vector, read once from the caller's buffer as it is now into a copy grizzle alone holds:
 * a Float32Array of the dimensions, every component finite, its norm in the cosine domain. The admitted value is that
 * copy, so the fact's identity and every row text written from the fact later read the same components, whatever the
 * caller does to its buffer after admission. Every vector is in the cosine domain at every boundary, parameters
 * included; the database CHECK is the authority for stored values (values/vector.ts).
 */
const admitVector = (value: unknown, dimensions: number): Result.Result<Vector, ValueFault> =>
	admitEncodable(value, dimensions)

/** A closed id's handle: a string the roster holds live, whose code the codec writes. */
const admitHandle = (value: unknown, roster: RosterCodec): Result.Result<string, ValueFault> =>
	typeof value === "string" && roster.codeOf.has(value)
		? Result.ok(value)
		: Result.err("codeHandle")

/**
 * A set of a roster's handles, read once into a fresh Set grizzle alone holds, so a later change to the caller's Set
 * changes no admitted value: a Set whose members are strings, each a handle the roster holds live. A Set cannot be
 * frozen (Object.freeze leaves its members writable), so the copy is what keeps the admitted value fixed.
 */
const admitHandles = (
	value: unknown,
	roster: RosterCodec
): Result.Result<ReadonlySet<string>, ValueFault> => {
	if (!(value instanceof Set)) {
		return Result.err("bitsType")
	}
	const handles = new Set<string>()
	for (const member of value) {
		if (typeof member !== "string") {
			return Result.err("bitsType")
		}
		if (!roster.codeOf.has(member)) {
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
	return value.minorUnits >= int8Min.value && value.minorUnits <= int8Max.value
		? Result.ok(value)
		: Result.err("moneyRange")
}

const admitters: Admitters = {
	int2: (value) => toInt2(value),
	int4: (value) => toInt4(value),
	int8: (value) => toInt8(value),
	numeric: (value, spec) => admitDecimal(value, spec.typmod),
	float4: (value) => toReal(value),
	float8: (value) => toDouble(value),
	money: (value) => admitMoney(value),
	bool: (value) => (typeof value === "boolean" ? Result.ok(value) : Result.err("boolType")),
	uuid: (value) => toUuid(value),
	date: (value) => toCalendarDate(value),
	text: (value) => validateText(value),
	code: (value, spec) => admitHandle(value, spec.roster),
	bits: (value, spec) => admitHandles(value, spec.roster),
	range4: (value, spec) => admitSpan("int4", value, spec.width),
	range8: (value, spec) => admitSpan("int8", value, spec.width),
	vector: (value, spec) => admitVector(value, spec.dimensions),
	exactInteger: (value) =>
		typeof value === "bigint" ? Result.ok(value) : Result.err("integerType"),
	exactMoney: (value) => (value instanceof Money ? Result.ok(value) : Result.err("moneyType"))
}

/**
 * What admission answers for a value it could not read, a proxy whose traps throw or a getter that throws: the word for
 * a value not of the carrier's host type. Every carrier names its own; a literal operand's admission (scalar/registry.ts
 * literalDescFor) answers the same.
 */
export const unreadableFault: { readonly [C in Carrier]: ValueFault } = {
	int2: "integerType",
	int4: "integerType",
	int8: "integerType",
	numeric: "decimalType",
	float4: "floatType",
	float8: "floatType",
	money: "moneyType",
	bool: "boolType",
	uuid: "uuidSyntax",
	date: "dateSyntax",
	text: "textType",
	code: "codeHandle",
	bits: "bitsType",
	range4: "spanType",
	range8: "spanType",
	vector: "vectorType",
	exactInteger: "integerType",
	exactMoney: "moneyType"
}

/** The stored value PostgreSQL holds for a host value of this carrier, or the boundary's refusal. */
export const admitValue = <C extends Carrier>(
	spec: SpecOf<C> & CarrierSpec,
	value: unknown
): Result.Result<CarrierHost[C], ValueFault> => {
	const own: SpecOf<C> = spec
	const admit: (value: unknown, spec: SpecOf<C>) => Result.Result<CarrierHost[C], ValueFault> =
		admitters[own.carrier]
	return hostRead(unreadableFault[own.carrier], () => admit(value, own))
}

const isNumber = (value: unknown): value is number => typeof value === "number"
const isBigint = (value: unknown): value is bigint => typeof value === "bigint"
const isString = (value: unknown): value is string => typeof value === "string"
const isStringSet = (value: unknown): value is ReadonlySet<string> =>
	value instanceof Set && Array.from(value).every(isString)
const isSpanOf =
	<E extends number | bigint>(isEndpoint: (value: unknown) => value is E) =>
	(value: unknown): value is Span<E> =>
		typeof value === "object" &&
		value !== null &&
		"start" in value &&
		"end" in value &&
		isEndpoint(value.start) &&
		isEndpoint(value.end)

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
	code: isString,
	bits: isStringSet,
	range4: isSpanOf(isNumber),
	range8: isSpanOf(isBigint),
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
	code: (v, spec) => String(codeOf(spec.roster, v)),
	bits: (v, spec) => handlesText(spec.roster, v),
	range4: (v) => spanText(v),
	range8: (v) => spanText(v),
	vector: (v) => Vector.componentText(v),
	exactInteger: (v) => String(v),
	exactMoney: (v) => v.toString()
}

/**
 * Canonical value encoding for fact identity.
 *
 * One logical value must compare the same in codecs, PostgreSQL equality, DISTINCT, keys, grouping and the test
 * oracle. This module is that host side, per scalar carrier:
 *
 * - `admitValue` is the boundary: it checks a host value against its carrier strictly and applies the native coercion
 *   PostgreSQL applies on the way in (numeric precision and scale, binary32 rounding of real, -0 as +0, uuid case),
 *   because coercion happens before fact identity is established: two inputs that coerce to one stored
 *   value are one admitted value.
 * - `canonicalText` gives every admitted value its one text, equal exactly when PostgreSQL's equality for the type
 *   holds, because every host value is in its one form (a Decimal has no display scale, a float and a vector component
 *   one zero): numeric 1.0 = 1.00 are one Decimal written 1, NaN = NaN, -0 = +0, text by exact scalar sequence. It is
 *   the parameter text, the array element and the fact identity's part alike (codec/scalar.ts text).
 * - `compareValues` is PostgreSQL's B-tree order for the type: float and numeric total orders with NaN last, text in
 *   code point order, uuid by bytes, closed ids by code, which is roster order, spans by start then end, vectors as
 *   vector_cmp, and sets by their bit strings, an order internal to the host, since a set has no ordering.
 * - `factIdentity` admits a whole fact against its heading and gives it one text, so two facts are the same fact
 *   exactly when their texts are equal: the identity ChangeSet normalization and exact-repeat checks use.
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
	code: (x, y, spec) => sign(codeOf(spec.roster, x) - codeOf(spec.roster, y)),
	bits: (x, y, spec) => compareOrdered(handlesText(spec.roster, x), handlesText(spec.roster, y)),
	range4: (x, y) => compareSpan(x, y),
	range8: (x, y) => compareSpan(x, y),
	vector: (x, y) => Vector.compare(x, y),
	exactInteger: (x, y) => compareOrdered(x, y),
	exactMoney: (x, y) => x.compare(y)
}

/** PostgreSQL's order of two admitted values of one carrier. */
export const compareValues = <C extends Carrier>(
	spec: SpecOf<C> & CarrierSpec,
	a: CarrierHost[C],
	b: CarrierHost[C]
): -1 | 0 | 1 => {
	const own: SpecOf<C> = spec
	const compare: (a: CarrierHost[C], b: CarrierHost[C], spec: SpecOf<C>) => -1 | 0 | 1 =
		comparators[own.carrier]
	return compare(a, b, own)
}

/**
 * A value this spec already admitted, held in an admitted fact's field, as its carrier's host value. The one site of the
 * fact "an admitted fact's field holds its carrier's host value": a fact is a record keyed by its heading's runtime field
 * names, and the host type of each field's value is a function of the carrier of the field of that name in a heading held
 * apart from it. No TypeScript type is indexed by a runtime name or ties two runtime structures field by field, and a
 * spec packed with its value only moves the lookup to the reader, which reaches the field through a name from another
 * structure, so a value of another host type is a defect, and throws.
 */
export const admitted = <C extends Carrier>(
	spec: SpecOf<C> & CarrierSpec,
	value: unknown
): CarrierHost[C] => {
	const own: SpecOf<C> = spec
	if (!isHostValue(own.carrier, value)) {
		throw defect(`an admitted ${own.carrier} host value`)
	}
	return value
}

/** The canonical text of a value this spec already admitted (admitted). */
export const admittedText = <C extends Carrier>(
	spec: SpecOf<C> & CarrierSpec,
	value: unknown
): string => canonicalText(spec, admitted(spec, value))

export interface HeadingField {
	readonly name: string
	readonly spec: CarrierSpec
}

/** A fact refused at the boundary: the fault, and the field it is in when it is about one field. */
interface FactFault {
	readonly fault: ValueFault
	readonly field: string | undefined
}

interface AdmittedFact {
	/** The admitted values, by field name, frozen. */
	readonly fact: { readonly [field: string]: unknown }
	/** The fact's identity: equal exactly for the same fact. */
	readonly identity: string
}

const fieldOrder = (a: HeadingField, b: HeadingField): number => compareCodePoints(a.name, b.name)

/** A plain object: any non-null object reads every string key as unknown. */
const isPlainRecord = (value: unknown): value is { readonly [field: string]: unknown } => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false
	}
	const proto: unknown = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

/**
 * What admitting a fact reads of its heading, worked out once per heading rather than once per fact (the relation
 * codec plans its heading when it is built, codec/recordset.ts): its fields in name order, the JSON text before each
 * field's canonical text in the identity, and whether a name repeats.
 */
export interface HeadingPlan {
	readonly fields: ReadonlyArray<HeadingField>
	/**
	 * Each field in name order up to the first whose name repeats the one before, with `[["name",` before its text for
	 * the first field and `,["name",` for the others.
	 */
	readonly entries: ReadonlyArray<{ readonly field: HeadingField; readonly prefix: string }>
	/** Whether the heading repeats a name: a fact of it is refused once its entries before the repeat are admitted. */
	readonly names: "distinct" | "repeated"
}

export const headingPlan = (heading: ReadonlyArray<HeadingField>): HeadingPlan => {
	const fields = heading.toSorted(fieldOrder)
	const repeat = firstIndex(fields, (f, i) => i > 0 && fields[i - 1]?.name === f.name)
	return {
		fields,
		entries: (repeat === undefined ? fields : fields.slice(0, repeat)).map((field, i) => ({
			field,
			prefix: `${i === 0 ? "[" : ","}[${JSON.stringify(field.name)},`
		})),
		names: repeat === undefined ? "distinct" : "repeated"
	}
}

/**
 * One own field of a fact, read once through its descriptor: a data property's value, or what its getter returns
 * when called once; none when the fact has no such own field.
 */
const ownField = (fact: object, name: string): Result.Result<unknown, FactFault> =>
	hostRead<unknown, FactFault>({ fault: "factShape", field: name }, () => {
		const descriptor = Reflect.getOwnPropertyDescriptor(fact, name)
		if (descriptor === undefined) {
			return Result.err({ fault: "factShape", field: name })
		}
		const value: unknown =
			descriptor.get === undefined ? descriptor.value : Reflect.apply(descriptor.get, fact, [])
		return Result.ok(value)
	})

/**
 * Admits a fact against its heading: a plain object whose own keys are exactly the heading's field names, each value
 * admitted by its carrier. Its shape and each field are read once (hostRead), and only the admitted values are kept.
 * The identity is the JSON text of the [field, canonicalText] pairs in field-name order, written directly rather than
 * through an array of pairs.
 *
 * A per-fact hot path: the heading's plan is worked out once per heading, and each fact costs one pass over its
 * fields with no per-field closure, tuple or Option beyond the field's own read.
 */
export const factIdentity = (
	heading: ReadonlyArray<HeadingField>,
	fact: unknown
): Result.Result<AdmittedFact, FactFault> => admitFact(headingPlan(heading), fact)

/** factIdentity over a heading already planned (headingPlan): the per-fact path of a codec that planned its heading. */
export const admitFact = (
	plan: HeadingPlan,
	fact: unknown
): Result.Result<AdmittedFact, FactFault> => {
	if (typeof fact !== "object" || fact === null) {
		return Result.err({ fault: "factShape", field: undefined })
	}
	const keys = hostRead<number, FactFault>({ fault: "factShape", field: undefined }, () =>
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
	/** A prototype-less object, so assigning "__proto__" defines an ordinary property. */
	const kept: Record<string, unknown> = {}
	Reflect.setPrototypeOf(kept, null)
	let identity = ""
	for (const { field, prefix } of entries) {
		const read = ownField(fact, field.name)
		if (!read.ok) {
			return Result.err(read.error)
		}
		const value = admitValue(field.spec, read.value)
		if (!value.ok) {
			return Result.err({ fault: value.error, field: field.name })
		}
		kept[field.name] = value.value
		identity += `${prefix}${JSON.stringify(canonicalText(field.spec, value.value))}]`
	}
	if (names === "repeated") {
		return Result.err({ fault: "factShape", field: undefined })
	}
	return Result.ok({
		fact: Object.freeze(kept),
		identity: entries.length === 0 ? "[]" : `${identity}]`
	})
}
