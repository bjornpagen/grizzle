/**
 * The JSON wire's spelling of every scalar grizzle serves, as one table over the carriers (`carrierWire`): for each, the
 * JSON Schema of its spellings, its `encode` (a host value the server holds to JSON), its `parse` (the server's exact
 * parse of a caller's JSON to the declared host type) and its `decode` (the client's trusting conversion of the server's
 * own JSON back to the host value). The four are one row, so a spelling, its schema and its readers cannot disagree.
 *
 * A JSON number is a value, and a JSON string a spelling: an integer of the int2 and int4 carriers and a float travel as
 * numbers, read by value; every other value as a string or a structure, read by the wire's grammar of it, whose every
 * spelling names one value. `parse` refuses exactly what has no exact value of the declared type (a malformed uuid, an
 * unknown handle, 1.005 at scale 2, a float4 no binary32 number is), and nothing the schema's laws decide: those are
 * PostgreSQL's, a span's order and width and a vector's norm among them, and the schema names each such law of a type
 * among its gaps (`schemaGaps`), so no schema admits a value silently.
 *
 * The module is runtime-free and browser-safe: it imports the value core and core leaves alone.
 */
import { type FloatSpecialName, floatSpecialNameOf, type Json } from "#compiler/core/canonical.ts"
import { defect } from "#compiler/core/invariant.ts"
import {
	bytesMaxLength,
	int2Max,
	int2Min,
	int4Max,
	int4Min,
	int8Max,
	int8Min
} from "#compiler/core/limits.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { isList, isPlainRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { validateText } from "#compiler/core/text.ts"
import {
	binary32LeastExponent,
	binary32Max,
	moneyFractionDigits,
	uuidGroups
} from "#compiler/ir/carriers.ts"
import { type CalendarDate, convertDate, dayNumber, toCalendarDate } from "#compiler/ir/date.ts"
import type { Carrier } from "#compiler/ir/scalar.ts"
import {
	amounts,
	anchored,
	base64Texts,
	calendarDates,
	decimals,
	admittedText,
	integers,
	alternation,
	uuidSpelling
} from "#compiler/live/pattern.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import { toUuid } from "#compiler/scalar/values/uuid.ts"
import { isVector, Vector } from "#compiler/scalar/values/vector.ts"

/** A JSON value on the wire: what JSON.parse yields of a caller's body and what the server's frames write. */
export type WireJson =
	| null
	| boolean
	| number
	| string
	| ReadonlyArray<WireJson>
	| { readonly [member: string]: WireJson }

/** A JSON Schema object, as the document writes it (core/canonical.ts Json: no null). */
export type WireSchema = { readonly [keyword: string]: Json }

/**
 * What a JSON Schema does not state, each named where a schema lists it, under `x-grizzle-gaps`, with who refuses a
 * value its schema admits:
 *
 * - the exact parse (`parse`, as the host's parseValue): a float4's or a vector component's binary32 exactness, a
 *   span's start before its end, a fixed-width span's width, and a vector's norm in the cosine domain, each refused as
 *   the WireFaultKind of its name before any SQL;
 * - PostgreSQL, a refusal grizzle classifies by the law it names: a contract's predicate, a text's byte bound, and a
 *   text pattern no ECMA-262 regex states;
 * - nothing, for what a refusal reports: the members of each law it names (types/changeset Law, whose union of kinds no
 *   schema here restates), and which key of its relation a witness's values are.
 */
export const schemaGaps = [
	"binary32",
	"contract",
	"lawShape",
	"octets",
	"pattern",
	"spanOrder",
	"spanWidth",
	"vectorNorm",
	"witnessKey"
] as const

/** A law a JSON Schema does not state (schemaGaps). */
export type SchemaGap = (typeof schemaGaps)[number]

/** The extension keyword a schema lists its type's gaps under. */
export const gapsKeyword = "x-grizzle-gaps"

/**
 * Why `parse` refused a caller's JSON: no JSON of the spelling's kind; a malformed spelling; a value outside the type's
 * range; a decimal past the type's scale; a number no binary32 is; an unknown handle; a set's member twice; a vector of
 * another dimension count, or whose norm lies outside the cosine domain; a span whose start is not before its end, or
 * of another width than its type fixes; a text PostgreSQL's text cannot hold; members other than a record's own. A
 * fault a schema cannot state is named as its gap is (schemaGaps), so a schema-valid value the parse refuses names one
 * of its schema's gaps.
 */
export const wireFaults = [
	"binary32",
	"dimensions",
	"handle",
	"json",
	"members",
	"range",
	"repeated",
	"scale",
	"spanOrder",
	"spanWidth",
	"spelling",
	"text",
	"vectorNorm"
] as const

/** Why `parse` refused (wireFaults). */
export type WireFaultKind = (typeof wireFaults)[number]

/**
 * A decimal type's bound as the wire reads it: numeric(p, s), whose values may also be NaN, or a computed numeric's
 * proved bound, finite.
 */
export type WireNumeric =
	| { readonly kind: "typmod"; readonly precision: number; readonly scale: number }
	| { readonly kind: "bound"; readonly digits: number; readonly scale: number }

/** A span's width as the wire states it: any, or fixed, its units' decimal spelling. */
export type WireWidth =
	| { readonly kind: "free" }
	| { readonly kind: "fixed"; readonly units: string }

/** What each carrier's spelling reads beside its carrier, as data: the bounds and names its values are spelled by. */
interface WireExtras {
	readonly int2: unknown
	readonly int4: unknown
	readonly int8: unknown
	readonly numeric: { readonly numeric: WireNumeric }
	readonly float4: unknown
	readonly float8: unknown
	readonly money: unknown
	readonly bool: unknown
	readonly uuid: unknown
	readonly date: unknown
	readonly text: unknown
	readonly bytes: unknown
	readonly code: { readonly handles: NonEmptyReadonlyArray<string> }
	readonly bits: { readonly handles: NonEmptyReadonlyArray<string> }
	readonly range4: { readonly width: WireWidth }
	readonly range8: { readonly width: WireWidth }
	readonly rangeDate: { readonly width: WireWidth }
	readonly vector: { readonly dimensions: number }
	readonly exactInteger: { readonly digits: number }
	readonly exactMoney: { readonly digits: number }
}

/** One carrier's wire spec: its carrier, and what its spelling reads beside it (a roster's live handles in code order). */
export type WireSpec<C extends Carrier> = { readonly carrier: C } & WireExtras[C]

/** A scalar's wire spec, of any carrier: pure JSON data, which a document carries for its client. */
export type WireScalar = { readonly [C in Carrier]: WireSpec<C> }[Carrier]

/**
 * The host value of each carrier the wire spells: the value a served Db's handle takes and delivers, a bytes value as
 * its bytes.
 */
export interface WireHost {
	readonly int2: number
	readonly int4: number
	readonly int8: bigint
	readonly numeric: Decimal
	readonly float4: number
	readonly float8: number
	readonly money: Money
	readonly bool: boolean
	readonly uuid: string
	readonly date: CalendarDate
	readonly text: string
	readonly bytes: Uint8Array<ArrayBuffer>
	readonly code: string
	readonly bits: ReadonlySet<string>
	readonly range4: Span<number>
	readonly range8: Span<bigint>
	readonly rangeDate: Span<CalendarDate>
	readonly vector: Vector
	readonly exactInteger: bigint
	readonly exactMoney: Money
}

/** One carrier's row of the table: its schema, its encode, its exact parse, its trusting decode and its host check. */
interface CarrierWire<C extends Carrier> {
	readonly schema: (spec: WireSpec<C>) => WireSchema
	readonly encode: (value: WireHost[C], spec: WireSpec<C>) => WireJson
	readonly parse: (json: unknown, spec: WireSpec<C>) => Result.Result<WireHost[C], WireFaultKind>
	readonly decode: (json: WireJson, spec: WireSpec<C>) => WireHost[C]
	readonly is: (value: unknown) => value is WireHost[C]
}

/** The table's type: one row per carrier, each over its own spec and host type. */
type CarrierWires = { readonly [C in Carrier]: CarrierWire<C> }

/** A schema with its type's gaps (schemaGaps), none where the schema states the whole type. */
export const withGaps = (schema: WireSchema, gaps: ReadonlyArray<SchemaGap>): WireSchema =>
	gaps.length === 0 ? schema : { ...schema, [gapsKeyword]: [...gaps] }

/** A string of the spellings `body` matches whole. */
const spelled = (body: string): WireSchema => ({ type: "string", pattern: anchored(body) })

/** The words naming the floats JSON numbers cannot hold (core/canonical.ts floatSpecialNames). */
const floatWords: ReadonlyArray<FloatSpecialName> = ["NaN", "Infinity", "-Infinity"]

/** The float a word names. */
const floatOfWord = (word: FloatSpecialName): number =>
	word === "NaN"
		? Number.NaN
		: word === "Infinity"
			? Number.POSITIVE_INFINITY
			: Number.NEGATIVE_INFINITY

const isFloatWord = (json: unknown): json is FloatSpecialName =>
	json === "NaN" || json === "Infinity" || json === "-Infinity"

/**
 * The magnitude past which a JSON number no longer rounds to a finite binary32, 2^128 - 2^103, the midpoint between
 * binary32's greatest value and 2^128, which ties to the even 2^128, infinity; and the magnitude at or below which a
 * nonzero number rounds to zero, 2^(emin - p), half the least subnormal, which ties to the even zero.
 */
const binary32Edges = {
	greatest: binary32Max.value,
	least: 2 ** binary32LeastExponent.value
} as const

/** A float's schema: a JSON number from `-most` to `most`, or a word naming a float no JSON number holds. */
const floatSchema = (most: number, gaps: ReadonlyArray<SchemaGap>): WireSchema =>
	withGaps(
		{
			anyOf: [
				{ type: "number", minimum: -most, maximum: most },
				{ type: "string", enum: [...floatWords] }
			]
		},
		gaps
	)

/** A float's JSON: a finite number as itself, NaN and the infinities by their words. */
const floatJson = (x: number): WireJson => floatSpecialNameOf(x) ?? (x === 0 ? 0 : x)

/**
 * A float a caller's JSON spells: a number, which a JSON literal past binary64 parsed to an infinity is not (no float
 * value is that literal's), or a word naming NaN or an infinity.
 */
const floatOf = (json: unknown): Result.Result<number, WireFaultKind> => {
	if (typeof json === "number") {
		return Number.isFinite(json) ? Result.ok(json === 0 ? 0 : json) : Result.err("range")
	}
	return isFloatWord(json) ? Result.ok(floatOfWord(json)) : Result.err("json")
}

/** A real a caller's JSON spells: a float (floatOf) that is a binary32 number exactly, its own Math.fround. */
const realOf = (json: unknown): Result.Result<number, WireFaultKind> =>
	Result.flatMap(floatOf(json), (x) =>
		Number.isNaN(x) || Math.fround(x) === x ? Result.ok(x) : Result.err("binary32")
	)

/** The trusted JSON of the server's own frames: a string where its spelling is one, a defect elsewhere. */
export const trustedString = (json: WireJson): string => {
	if (typeof json !== "string") {
		throw defect("a wire value spelled as a JSON string")
	}
	return json
}

/** The trusted JSON of the server's own frames: a number where its spelling is one, a defect elsewhere. */
const trustedNumber = (json: WireJson): number => {
	if (typeof json !== "number") {
		throw defect("a wire value spelled as a JSON number")
	}
	return json
}

/** The trusted JSON of the server's own frames: an array where its spelling is one, a defect elsewhere. */
export const trustedArray = (json: WireJson): ReadonlyArray<WireJson> => {
	if (!isList(json)) {
		throw defect("a wire value spelled as a JSON array")
	}
	return json
}

/** A float the server's own JSON spells: a number, or a word naming a float. */
const trustedFloat = (json: WireJson): number =>
	isFloatWord(json) ? floatOfWord(json) : trustedNumber(json)

/** An integer a caller's JSON spells as a number from `min` to `max`, -0 as 0. */
const smallIntegerOf = (
	json: unknown,
	min: number,
	max: number
): Result.Result<number, WireFaultKind> => {
	if (typeof json !== "number") {
		return Result.err("json")
	}
	if (!Number.isInteger(json)) {
		return Result.err("spelling")
	}
	return json < min || json > max ? Result.err("range") : Result.ok(json === 0 ? 0 : json)
}

/** Whether every code unit of `text` from `start` to `end` is a decimal digit. */
const allDigits = (text: string, start: number, end: number): boolean => {
	for (let i = start; i < end; i++) {
		const c = text.charCodeAt(i)
		if (c < 0x30 || c > 0x39) {
			return false
		}
	}
	return true
}

/** Whether a text is an integer in the wire's grammar: an optional minus sign and digits as JSON writes an integer. */
const isIntegerSpelling = (text: string): boolean => {
	const start = text.startsWith("-") ? 1 : 0
	const length = text.length - start
	return (
		length > 0 &&
		allDigits(text, start, text.length) &&
		(length === 1 || text.charCodeAt(start) !== 0x30)
	)
}

/** An integer a caller's JSON spells as a string in the wire's integer grammar, from `min` to `max` where bounded. */
const bigIntegerOf = (
	json: unknown,
	inRange: (value: bigint) => boolean
): Result.Result<bigint, WireFaultKind> => {
	if (typeof json !== "string") {
		return Result.err("json")
	}
	if (!isIntegerSpelling(json)) {
		return Result.err("spelling")
	}
	const value = BigInt(json)
	return inRange(value) ? Result.ok(value) : Result.err("range")
}

/** Whether a text is a decimal in the wire's decimal grammar (pattern.ts decimalGrammar): no exponent, no plus sign. */
const isDecimalSpelling = (text: string): boolean => {
	const point = text.indexOf(".")
	if (point < 0) {
		return isIntegerSpelling(text)
	}
	return (
		isIntegerSpelling(text.slice(0, point)) &&
		point + 1 < text.length &&
		allDigits(text, point + 1, text.length)
	)
}

/** A finite decimal a caller's JSON spells in the wire's decimal grammar. */
const finiteDecimalOf = (json: unknown): Result.Result<Decimal, WireFaultKind> => {
	if (typeof json !== "string") {
		return Result.err("json")
	}
	if (!isDecimalSpelling(json)) {
		return Result.err("spelling")
	}
	const parsed = Decimal.fromString(json)
	return parsed.ok ? Result.ok(parsed.value) : Result.err("range")
}

/**
 * Whether a finite decimal is one of the decimals below 10^`integerDigits` whose digits past the `scale`th fraction
 * digit are zero: its least scale within `scale` (for a negative scale, a multiple of 10^-scale), and its coefficient
 * below 10^(integerDigits + its least scale).
 */
const decimalFits = (
	value: Decimal,
	integerDigits: number,
	scale: number
): Result.Result<Decimal, WireFaultKind> => {
	const parts = value.parts
	if (parts.kind !== "finite") {
		return Result.err("range")
	}
	const exact =
		scale >= 0
			? parts.minScale <= scale
			: parts.minScale === 0 && parts.coefficient % 10n ** BigInt(-scale) === 0n
	if (!exact) {
		return Result.err("scale")
	}
	return parts.coefficient < 10n ** BigInt(integerDigits + parts.minScale)
		? Result.ok(value)
		: Result.err("range")
}

/** The integer digits and scale of a decimal type's values (WireNumeric). */
const numericBounds = (
	numeric: WireNumeric
): { readonly integerDigits: number; readonly scale: number } =>
	numeric.kind === "typmod"
		? { integerDigits: numeric.precision - numeric.scale, scale: numeric.scale }
		: { integerDigits: numeric.digits, scale: numeric.scale }

/** A decimal of a decimal type a caller's JSON spells: NaN where numeric(p, s) holds it, else a finite value it holds. */
const numericOf = (json: unknown, numeric: WireNumeric): Result.Result<Decimal, WireFaultKind> => {
	if (json === "NaN" && numeric.kind === "typmod") {
		return Result.ok(Decimal.nan)
	}
	const { integerDigits, scale } = numericBounds(numeric)
	return Result.flatMap(finiteDecimalOf(json), (value) => decimalFits(value, integerDigits, scale))
}

/**
 * An amount of money a caller's JSON spells, at most moneyFractionDigits fraction digits: a money field's within its
 * signed 64-bit count of minor units (Money.fromDecimal, which rounds nothing at that scale), or an exact amount's below
 * 10^`integerDigits`.
 */
const moneyOf = (
	json: unknown,
	integerDigits: number | undefined
): Result.Result<Money, WireFaultKind> =>
	Result.flatMap(finiteDecimalOf(json), (value) => {
		const parts = value.parts
		if (parts.kind !== "finite") {
			return Result.err("range")
		}
		if (parts.minScale > moneyFractionDigits.value) {
			return Result.err("scale")
		}
		if (integerDigits !== undefined) {
			return Result.map(decimalFits(value, integerDigits, moneyFractionDigits.value), (exact) =>
				Money.exact(minorUnitsOf(exact))
			)
		}
		const made = Money.fromDecimal(value)
		return made.ok ? Result.ok(made.value) : Result.err("range")
	})

/** The minor units of a finite decimal of at most moneyFractionDigits fraction digits. */
const minorUnitsOf = (value: Decimal): bigint => {
	const parts = value.parts
	if (parts.kind !== "finite") {
		throw defect("a finite amount of money")
	}
	const units = parts.coefficient * 10n ** BigInt(moneyFractionDigits.value - parts.minScale)
	return parts.negative ? -units : units
}

/** A string of `handles`, as a closed id's spelling: one of its roster's live handles. */
const handleOf = (
	json: unknown,
	handles: ReadonlyArray<string>
): Result.Result<string, WireFaultKind> => {
	if (typeof json !== "string") {
		return Result.err("json")
	}
	return handles.includes(json) ? Result.ok(json) : Result.err("handle")
}

/** A set of handles a caller's JSON spells: an array of its roster's live handles, each once. */
const handlesOf = (
	json: unknown,
	handles: ReadonlyArray<string>
): Result.Result<ReadonlySet<string>, WireFaultKind> => {
	if (!isList(json)) {
		return Result.err("json")
	}
	const members = new Set<string>()
	for (const item of json) {
		const handle = handleOf(item, handles)
		if (!handle.ok) {
			return handle
		}
		if (members.has(handle.value)) {
			return Result.err("repeated")
		}
		members.add(handle.value)
	}
	return Result.ok(members)
}

/**
 * A span a caller's JSON spells: a record of exactly `start` and `end`, each read by `endpoint`, its start before its
 * end, and, for a fixed width, its end that many units past its start, each endpoint's units read by `units`: every
 * value a span type holds, nonempty and bounded (ir/scalar.ts SpanInfo).
 */
const spanOf = <E>(
	json: unknown,
	endpoint: (json: unknown) => Result.Result<E, WireFaultKind>,
	units: (value: E) => bigint,
	width: WireWidth
): Result.Result<Span<E>, WireFaultKind> => {
	if (!isPlainRecord(json)) {
		return Result.err("json")
	}
	const keys = Object.keys(json)
	if (keys.length !== 2 || !Object.hasOwn(json, "start") || !Object.hasOwn(json, "end")) {
		return Result.err("members")
	}
	return Result.flatMap(endpoint(json["start"]), (start) =>
		Result.flatMap(endpoint(json["end"]), (end): Result.Result<Span<E>, WireFaultKind> => {
			const length = units(end) - units(start)
			if (length <= 0n) {
				return Result.err("spanOrder")
			}
			return width.kind === "fixed" && length !== BigInt(width.units)
				? Result.err("spanWidth")
				: Result.ok(Object.freeze({ start, end }))
		})
	)
}

/** A span's schema: a record of exactly `start` and `end`, each `endpoint`, with the span's laws as gaps. */
const spanSchema = (endpoint: WireSchema, width: WireWidth): WireSchema =>
	withGaps(
		{
			type: "object",
			properties: { start: endpoint, end: endpoint },
			required: ["start", "end"],
			additionalProperties: false
		},
		width.kind === "fixed" ? ["spanOrder", "spanWidth"] : ["spanOrder"]
	)

/** A span's JSON: its two endpoints, each `endpoint`'s. */
const spanJson = <E>(span: Span<E>, endpoint: (value: E) => WireJson): WireJson => ({
	start: endpoint(span.start),
	end: endpoint(span.end)
})

/** The trusted JSON of the server's own frames: a record where its spelling is one, a defect elsewhere. */
export const trustedRecord = (json: WireJson): { readonly [member: string]: WireJson } => {
	if (typeof json !== "object" || json === null || isList(json)) {
		throw defect("a wire value spelled as a JSON record")
	}
	return json
}

/** A member of the server's own JSON record, which its spelling holds. */
export const trustedMember = (
	record: { readonly [member: string]: WireJson },
	member: string
): WireJson => {
	const value = record[member]
	if (value === undefined) {
		throw defect(`a wire record holding its member ${member}`)
	}
	return value
}

/** A span the server's own JSON spells: its two endpoints, each read by `endpoint`. */
const trustedSpan = <E>(json: WireJson, endpoint: (json: WireJson) => E): Span<E> => {
	const record = trustedRecord(json)
	return Object.freeze({
		start: endpoint(trustedMember(record, "start")),
		end: endpoint(trustedMember(record, "end"))
	})
}

/** Whether a value is a span of endpoints `is` holds: a record of its start and end. */
const isSpanOf =
	<E>(is: (value: unknown) => value is E) =>
	(value: unknown): value is Span<E> =>
		typeof value === "object" &&
		value !== null &&
		"start" in value &&
		"end" in value &&
		is(value.start) &&
		is(value.end)

const isNumber = (value: unknown): value is number => typeof value === "number"
const isBigint = (value: unknown): value is bigint => typeof value === "bigint"
const isString = (value: unknown): value is string => typeof value === "string"
const isCalendarDate = (value: unknown): value is CalendarDate => toCalendarDate(value).ok
const isDecimal = (value: unknown): value is Decimal => value instanceof Decimal
const isMoney = (value: unknown): value is Money => value instanceof Money

/** A calendar date a caller's JSON spells: `YYYY-MM-DD`, a day from 0001-01-01 to 9999-12-31. */
const dateOf = (json: unknown): Result.Result<CalendarDate, WireFaultKind> => {
	if (typeof json !== "string") {
		return Result.err("json")
	}
	const date = toCalendarDate(json)
	return date.ok && date.value === json ? Result.ok(date.value) : Result.err("spelling")
}

const int4Wire: CarrierWire<"int4"> = {
	schema: () => ({ type: "integer", minimum: int4Min.value, maximum: int4Max.value }),
	encode: (value) => value,
	parse: (json) => smallIntegerOf(json, int4Min.value, int4Max.value),
	decode: (json) => trustedNumber(json),
	is: isNumber
}

const int8Range = (value: bigint): boolean => value >= int8Min.value && value <= int8Max.value

const dateWire: CarrierWire<"date"> = {
	schema: () => ({ ...spelled(calendarDates), format: "date" }),
	encode: (value) => value,
	parse: dateOf,
	decode: (json) => convertDate(trustedString(json)),
	is: isCalendarDate
}

/**
 * The wire's table: each carrier's schema, encode, exact parse, trusting decode and host check (see the module's
 * header).
 */
export const carrierWire: CarrierWires = {
	int2: {
		schema: () => ({ type: "integer", minimum: int2Min.value, maximum: int2Max.value }),
		encode: (value) => value,
		parse: (json) => smallIntegerOf(json, int2Min.value, int2Max.value),
		decode: (json) => trustedNumber(json),
		is: isNumber
	},
	int4: int4Wire,
	int8: {
		schema: () => spelled(integers(int8Min.value, int8Max.value)),
		encode: (value) => value.toString(),
		parse: (json) => bigIntegerOf(json, int8Range),
		decode: (json) => BigInt(trustedString(json)),
		is: isBigint
	},
	numeric: {
		schema: (spec) => {
			const { integerDigits, scale } = numericBounds(spec.numeric)
			const finite = decimals(integerDigits, scale)
			return spelled(spec.numeric.kind === "typmod" ? alternation(["NaN", finite]) : finite)
		},
		encode: (value) => value.toString(),
		parse: (json, spec) => numericOf(json, spec.numeric),
		decode: (json) => Decimal.fromOutput(trustedString(json)),
		is: isDecimal
	},
	float4: {
		schema: () => floatSchema(binary32Edges.greatest, ["binary32"]),
		encode: floatJson,
		parse: realOf,
		decode: trustedFloat,
		is: isNumber
	},
	float8: {
		schema: () => floatSchema(Number.MAX_VALUE, []),
		encode: floatJson,
		parse: floatOf,
		decode: trustedFloat,
		is: isNumber
	},
	money: {
		schema: () => spelled(amounts(int8Min.value, int8Max.value, moneyFractionDigits.value)),
		encode: (value) => value.toString(),
		parse: (json) => moneyOf(json, undefined),
		decode: (json) => Money.fromOutput(trustedString(json)),
		is: isMoney
	},
	bool: {
		schema: () => ({ type: "boolean" }),
		encode: (value) => value,
		parse: (json) => (typeof json === "boolean" ? Result.ok(json) : Result.err("json")),
		decode: (json) => {
			if (typeof json !== "boolean") {
				throw defect("a boolean spelled as a JSON boolean")
			}
			return json
		},
		is: (value): value is boolean => typeof value === "boolean"
	},
	uuid: {
		schema: () => ({ ...spelled(uuidSpelling(uuidGroups)), format: "uuid" }),
		encode: (value) => value,
		parse: (json) => {
			if (typeof json !== "string") {
				return Result.err("json")
			}
			const uuid = toUuid(json)
			return uuid.ok ? uuid : Result.err("spelling")
		},
		decode: trustedString,
		is: isString
	},
	date: dateWire,
	text: {
		schema: () => spelled(admittedText),
		encode: (value) => value,
		parse: (json) => {
			if (typeof json !== "string") {
				return Result.err("json")
			}
			return validateText(json).ok ? Result.ok(json) : Result.err("text")
		},
		decode: trustedString,
		is: isString
	},
	bytes: {
		schema: () => ({
			...spelled(base64Texts(bytesMaxLength.value)),
			contentEncoding: "base64"
		}),
		encode: (value) => value.toBase64(),
		parse: (json) => {
			if (typeof json !== "string") {
				return Result.err("json")
			}
			const bytes = base64Of(json)
			if (bytes === undefined) {
				return Result.err("spelling")
			}
			return bytes.length > bytesMaxLength.value ? Result.err("range") : Result.ok(bytes)
		},
		decode: (json) => Uint8Array.fromBase64(trustedString(json)),
		is: (value): value is Uint8Array<ArrayBuffer> =>
			value instanceof Uint8Array && value.buffer instanceof ArrayBuffer
	},
	code: {
		schema: (spec) => ({ type: "string", enum: [...spec.handles] }),
		encode: (value) => value,
		parse: (json, spec) => handleOf(json, spec.handles),
		decode: trustedString,
		is: isString
	},
	bits: {
		schema: (spec) => ({
			type: "array",
			items: { type: "string", enum: [...spec.handles] },
			uniqueItems: true
		}),
		encode: (value, spec) => spec.handles.filter((handle) => value.has(handle)),
		parse: (json, spec) => handlesOf(json, spec.handles),
		decode: (json) => new Set(trustedArray(json).map(trustedString)),
		is: (value): value is ReadonlySet<string> => value instanceof Set && [...value].every(isString)
	},
	range4: {
		schema: (spec) => spanSchema(int4Wire.schema({ carrier: "int4" }), spec.width),
		encode: (value) => spanJson(value, (endpoint) => endpoint),
		parse: (json, spec) =>
			spanOf(
				json,
				(endpoint) => smallIntegerOf(endpoint, int4Min.value, int4Max.value),
				BigInt,
				spec.width
			),
		decode: (json) => trustedSpan(json, trustedNumber),
		is: isSpanOf(isNumber)
	},
	range8: {
		schema: (spec) => spanSchema(spelled(integers(int8Min.value, int8Max.value)), spec.width),
		encode: (value) => spanJson(value, (endpoint) => endpoint.toString()),
		parse: (json, spec) =>
			spanOf(
				json,
				(endpoint) => bigIntegerOf(endpoint, int8Range),
				(value) => value,
				spec.width
			),
		decode: (json) => trustedSpan(json, (endpoint) => BigInt(trustedString(endpoint))),
		is: isSpanOf(isBigint)
	},
	rangeDate: {
		schema: (spec) => spanSchema(dateWire.schema({ carrier: "date" }), spec.width),
		encode: (value) => spanJson(value, (endpoint): WireJson => endpoint),
		parse: (json, spec) => spanOf(json, dateOf, (value) => BigInt(dayNumber(value)), spec.width),
		decode: (json) => trustedSpan(json, (endpoint) => convertDate(trustedString(endpoint))),
		is: isSpanOf(isCalendarDate)
	},
	vector: {
		schema: (spec) =>
			withGaps(
				{
					type: "array",
					items: {
						type: "number",
						minimum: -binary32Edges.greatest,
						maximum: binary32Edges.greatest
					},
					minItems: spec.dimensions,
					maxItems: spec.dimensions
				},
				["binary32", "vectorNorm"]
			),
		encode: (value) => Array.from(value, (x) => (x === 0 ? 0 : x)),
		parse: (json, spec) => {
			if (!isList(json)) {
				return Result.err("json")
			}
			if (json.length !== spec.dimensions) {
				return Result.err("dimensions")
			}
			const components = new Float32Array(json.length)
			for (const [i, item] of json.entries()) {
				if (typeof item !== "number") {
					return Result.err("json")
				}
				const real = realOf(item)
				if (!real.ok) {
					return real
				}
				if (!Number.isFinite(real.value)) {
					return Result.err("range")
				}
				components[i] = real.value
			}
			return Vector.inCosineDomain(components)
				? Result.ok(Vector.branded(components))
				: Result.err("vectorNorm")
		},
		decode: (json) => Vector.branded(Float32Array.from(trustedArray(json), trustedNumber)),
		is: isVector
	},
	exactInteger: {
		schema: (spec) => spelled(decimals(spec.digits, 0).replace(String.raw`(?:\.0+)?`, "")),
		encode: (value) => value.toString(),
		parse: (json, spec) =>
			bigIntegerOf(json, (value) => (value < 0n ? -value : value) < 10n ** BigInt(spec.digits)),
		decode: (json) => BigInt(trustedString(json)),
		is: isBigint
	},
	exactMoney: {
		schema: (spec) => spelled(decimals(spec.digits, moneyFractionDigits.value)),
		encode: (value) => value.toString(),
		parse: (json, spec) => moneyOf(json, spec.digits),
		decode: (json) => Money.fromOutput(trustedString(json)),
		is: isMoney
	}
}

/** Whether two JSON values are one: equal primitives, or arrays and records of equal members. */
export const sameJson = (a: WireJson, b: WireJson): boolean => {
	if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
		return a === b
	}
	if (isList(a) || isList(b)) {
		return (
			isList(a) &&
			isList(b) &&
			a.length === b.length &&
			a.every((x, i) => {
				const y = b[i]
				return y !== undefined && sameJson(x, y)
			})
		)
	}
	const keys = Object.keys(a)
	return (
		Object.keys(b).length === keys.length &&
		keys.every((key) => {
			const x = a[key]
			const y = b[key]
			return x !== undefined && y !== undefined && sameJson(x, y)
		})
	)
}

/**
 * Whether a code unit is a digit of base64's alphabet, RFC 4648 §4.
 *
 * @formatConstant RFC 4648 §4's base64 alphabet
 */
const isBase64Digit = (c: number): boolean =>
	(c >= 0x41 && c <= 0x5a) ||
	(c >= 0x61 && c <= 0x7a) ||
	(c >= 0x30 && c <= 0x39) ||
	c === 0x2b ||
	c === 0x2f

/**
 * The shape of base64's text, RFC 4648 §4: four digits to a group, and the most a last group pads with `=`.
 *
 * @formatConstant RFC 4648 §4's base64: four digits to a group, at most two of its last padding
 */
const base64Groups = { digits: 4, padding: 2 } as const

/**
 * Whether a text is whole groups of base64 digits, RFC 4648 §4, its last group padded by at most two `=`: no whitespace
 * and no padding elsewhere, so Uint8Array.fromBase64 reads it without refusing.
 */
const isBase64Shape = (text: string): boolean => {
	if (text.length % base64Groups.digits !== 0) {
		return false
	}
	let end = text.length
	while (end > 0 && text.length - end < base64Groups.padding && text.charCodeAt(end - 1) === 0x3d) {
		end--
	}
	for (let i = 0; i < end; i++) {
		if (!isBase64Digit(text.charCodeAt(i))) {
			return false
		}
	}
	return true
}

/**
 * The bytes a base64 text spells in its one spelling, RFC 4648 §4: whole padded groups, and its padding bits zero, the
 * text the bytes' own toBase64 writes; undefined for any other text.
 */
const base64Of = (text: string): Uint8Array<ArrayBuffer> | undefined => {
	if (!isBase64Shape(text)) {
		return undefined
	}
	const bytes = Uint8Array.fromBase64(text)
	return bytes.toBase64() === text ? bytes : undefined
}

/** The row of `spec`'s carrier, typed by it. */
const rowOf = <C extends Carrier>(spec: WireSpec<C>): CarrierWire<C> => {
	const own: WireSpec<C> = spec
	const row: CarrierWire<C> = carrierWire[own.carrier]
	return row
}

/** The JSON Schema of a carrier's spellings. */
const schemaAt = <C extends Carrier>(spec: WireSpec<C>): WireSchema => rowOf(spec).schema(spec)

/** A host value's JSON under its carrier's spelling, a value of another host type a defect. */
const encodeAt = <C extends Carrier>(spec: WireSpec<C>, value: unknown): WireJson => {
	const row = rowOf(spec)
	if (!row.is(value)) {
		throw defect(`a ${spec.carrier} host value to encode`)
	}
	return row.encode(value, spec)
}

/** A caller's JSON parsed to its carrier's host value. */
const parseAt = <C extends Carrier>(
	spec: WireSpec<C>,
	json: unknown
): Result.Result<unknown, WireFaultKind> => rowOf(spec).parse(json, spec)

/** The server's own JSON of a carrier's value converted back to it. */
const decodeAt = <C extends Carrier>(spec: WireSpec<C>, json: WireJson): unknown =>
	rowOf(spec).decode(json, spec)

/** The JSON Schema of a scalar's spellings. */
export const scalarSchema = (spec: WireScalar): WireSchema => schemaAt(spec)

/**
 * A host value's JSON under its scalar's spelling: a value the server holds, decoded by grizzle from its own rows. A
 * value of another carrier's host type is a defect, and throws: a row's values are read as unknown, and this is where
 * a value's carrier type is read.
 */
export const encodeScalar = (spec: WireScalar, value: unknown): WireJson => encodeAt(spec, value)

/** A caller's JSON parsed to its scalar's host value, exactly (see the module's header). */
export const parseScalar = (
	spec: WireScalar,
	json: unknown
): Result.Result<unknown, WireFaultKind> => parseAt(spec, json)

/** The server's own JSON of a scalar converted back to its host value, trusted. */
export const decodeScalar = (spec: WireScalar, json: WireJson): unknown => decodeAt(spec, json)
