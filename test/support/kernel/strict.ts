import { Array as Arr, Option, Result, String as Str } from "effect"
import { toResult } from "#adapter/engine.ts"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import type { ValueFault } from "#compiler/core/errors.ts"
import { int2Max, int2Min, int4Max, int4Min, int8Max, int8Min } from "#compiler/core/limits.ts"
import { validateText } from "#compiler/core/text.ts"
import { moneyFractionDigits } from "#compiler/ir/carriers.ts"
import { type Codebook, emptyCodebook, type RosterCodec } from "#compiler/ir/codes.ts"
import { toCalendarDate } from "#compiler/ir/date.ts"
import {
	type Carrier,
	type NumericBound,
	numericBoundOf,
	type ScalarType
} from "#compiler/ir/scalar.ts"
import { Decimal, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { canonicalZero, decimalToBinary32 } from "#compiler/scalar/values/float.ts"
import type { CarrierHost, CarrierSpec, SpecOf } from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import {
	makeSpan,
	type Span,
	type SpanEndpointCarrier,
	type SpanEndpointHost
} from "#compiler/scalar/values/span.ts"
import { toUuid } from "#compiler/scalar/values/uuid.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { wholeDigits } from "#test/support/closed/bit-text.ts"

/**
 * Why a text is no output text of the type: the words the library's decoders used before the conversions trusted their
 * texts, and the value words of the carriers whose boundaries the strict reading shares (uuidSyntax, textNul,
 * textSurrogate, integerRange, codeHandle, bitsMember, vectorDimensions).
 */
const strictFaults = [
	"integerSyntax",
	"numericSyntax",
	"numericShape",
	"numericBound",
	"floatSyntax",
	"floatRange",
	"boolSyntax",
	"moneyShape",
	"spanSyntax",
	"bitsSyntax",
	"bytesSyntax",
	"vectorSyntax",
	"vectorOverflow"
] as const
export type StrictFault = (typeof strictFaults)[number] | ValueFault

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39

/** Whether `text` holds the UTF-16 code unit `code` at `at`; past its end it holds none. */
const codeIs = (text: string, at: number, code: number): boolean =>
	Option.contains(Str.charCodeAt(text, at), code)

/** The UTF-16 code unit of `text` at `at`, as a string; past its end, the empty string. */
const unitAt = (text: string, at: number): string =>
	Option.getOrElse(Str.charAt(text, at), () => "")

/** Whether `text` holds an ASCII digit at `at`; past its end it holds none. */
const digitAt = (text: string, at: number): boolean =>
	Option.exists(Str.charCodeAt(text, at), isDigit)

/**
 * Integer output: an optional minus sign and one to nineteen digits without leading zeros (int2out, int4out, int8out).
 */
const isIntegerText = (text: string): boolean => {
	const start = codeIs(text, 0, 0x2d) ? 1 : 0
	const digits = text.length - start
	if (digits < 1 || digits > 19) {
		return false
	}
	for (let i = start; i < text.length; i++) {
		if (!digitAt(text, i)) {
			return false
		}
	}
	return digits === 1 || !codeIs(text, start, 0x30)
}

const readSmall =
	(min: number, max: number) =>
	(text: string): Result.Result<number, StrictFault> => {
		if (!isIntegerText(text) || text === "-0") {
			return Result.fail("integerSyntax")
		}
		const n = Number(text)
		return n >= min && n <= max ? Result.succeed(n) : Result.fail("integerRange")
	}

const readInt8 = (text: string): Result.Result<bigint, StrictFault> => {
	if (!isIntegerText(text) || text === "-0") {
		return Result.fail("integerSyntax")
	}
	const n = BigInt(text)
	return n >= int8Min.value && n <= int8Max.value ? Result.succeed(n) : Result.fail("integerRange")
}

/**
 * Whether `text` is numeric_out's spelling of a finite value: an optional minus sign, integer digits with no leading
 * zero (a lone 0), and an optional point followed by at least one fractional digit, never a minus zero; with exactly
 * `fraction` fractional digits when the column fixes them (a typmod's max(s, 0), money's 2), any number otherwise.
 * NaN, Infinity and -Infinity pass when `special` admits them.
 */
const isNumericOutput = (
	text: string,
	fraction: number | "any",
	special: "special" | "finite"
): boolean => {
	if (text === "NaN" || text === "Infinity" || text === "-Infinity") {
		return special === "special"
	}
	const start = codeIs(text, 0, 0x2d) ? 1 : 0
	let i = start
	while (digitAt(text, i)) {
		i++
	}
	const integer = i - start
	if (integer === 0 || (integer > 1 && codeIs(text, start, 0x30))) {
		return false
	}
	let digits = 0
	if (codeIs(text, i, 0x2e)) {
		i++
		while (digitAt(text, i)) {
			i++
			digits++
		}
		if (digits === 0) {
			return false
		}
	}
	if (i !== text.length || (fraction !== "any" && digits !== fraction)) {
		return false
	}
	const zero = Arr.every(Arr.fromIterable(Str.slice(start)(text)), (ch) => ch === "0" || ch === ".")
	return start === 0 || !zero
}

/**
 * numeric_out text, read without trusting it: its syntax checked here, at the declared scale's exact count of
 * fractional digits when there is a typmod, and the value one the column stores there (normalizeNumeric leaves it
 * alone). The value it yields is the one form, the trailing zeros of any display scale dropped.
 */
const readNumeric =
	(spec: SpecOf<"numeric">) =>
	(text: string): Result.Result<Decimal, StrictFault> => {
		const fraction = spec.typmod === undefined ? "any" : Math.max(spec.typmod.scale, 0)
		if (!isNumericOutput(text, "any", "special")) {
			return Result.fail("numericSyntax")
		}
		const parsed = Decimal.fromString(text)
		if (!parsed.ok) {
			return Result.fail("numericSyntax")
		}
		if (spec.typmod === undefined) {
			return Result.succeed(parsed.value)
		}
		if (!isNumericOutput(text, fraction, "special")) {
			return Result.fail("numericShape")
		}
		const normalized = normalizeNumeric(parsed.value, spec.typmod)
		return normalized.ok && normalized.value.equals(parsed.value)
			? Result.succeed(parsed.value)
			: Result.fail("numericShape")
	}

/**
 * money::numeric text: numeric_out's grammar, special values included, then money's shape: a finite amount with
 * exactly two fractional digits (cash_numeric), read without rounding.
 */
const readMoney = (text: string): Result.Result<Money, StrictFault> => {
	if (!isNumericOutput(text, "any", "special")) {
		return Result.fail("numericSyntax")
	}
	if (!isNumericOutput(text, moneyFractionDigits.value, "finite")) {
		return Result.fail("moneyShape")
	}
	const parsed = Decimal.fromString(text)
	if (
		!parsed.ok ||
		!parsed.value.isFinite() ||
		parsed.value.parts.minScale > moneyFractionDigits.value
	) {
		return Result.fail("moneyShape")
	}
	const money = Money.fromDecimal(parsed.value)
	return money.ok ? Result.succeed(money.value) : Result.fail("moneyShape")
}

/** An exact integer's output: numeric_out (or int8out) of a value at scale 0, of any length, never -0. */
const readExactInteger = (text: string): Result.Result<bigint, StrictFault> =>
	isNumericOutput(text, 0, "finite") ? Result.succeed(BigInt(text)) : Result.fail("integerSyntax")

/** Exact money's output: numeric_out of a finite amount with at most two fractional digits, of any magnitude. */
const readExactMoney = (text: string): Result.Result<Money, StrictFault> => {
	if (!isNumericOutput(text, "any", "finite")) {
		return Result.fail("numericSyntax")
	}
	const parsed = Decimal.fromString(text)
	if (
		!parsed.ok ||
		!parsed.value.isFinite() ||
		parsed.value.parts.minScale > moneyFractionDigits.value
	) {
		return Result.fail("moneyShape")
	}
	const p = parsed.value.parts
	const units = p.coefficient * 10n ** BigInt(moneyFractionDigits.value - p.minScale)
	return Result.succeed(Money.exact(p.negative ? -units : units))
}

const readBool = (text: string): Result.Result<boolean, StrictFault> => {
	if (text === "t" || text === "true") {
		return Result.succeed(true)
	}
	if (text === "f" || text === "false") {
		return Result.succeed(false)
	}
	return Result.fail("boolSyntax")
}

/**
 * A decimal float text: an optional minus sign, digits, an optional fraction of at least one digit, and an optional
 * exponent (e or E, an optional sign, one to six digits). Leading zeros are admitted, as strtod admits them.
 */
interface FloatParts {
	readonly sign: "+" | "-"
	readonly coefficient: bigint
	readonly exponent: number
}

const parseParts = (text: string): FloatParts | undefined => {
	const n = text.length
	let i = 0
	const negative = codeIs(text, 0, 0x2d)
	if (negative) {
		i = 1
	}
	const intStart = i
	while (i < n && digitAt(text, i)) {
		i++
	}
	if (i === intStart) {
		return undefined
	}
	const int = Str.slice(intStart, i)(text)
	let frac = ""
	if (i < n && codeIs(text, i, 0x2e)) {
		const fracStart = ++i
		while (i < n && digitAt(text, i)) {
			i++
		}
		if (i === fracStart) {
			return undefined
		}
		frac = Str.slice(fracStart, i)(text)
	}
	let exponent = 0
	if (i < n && (codeIs(text, i, 0x65) || codeIs(text, i, 0x45))) {
		i++
		let expNegative = false
		if (i < n && (codeIs(text, i, 0x2b) || codeIs(text, i, 0x2d))) {
			expNegative = codeIs(text, i, 0x2d)
			i++
		}
		const expStart = i
		while (i < n && digitAt(text, i)) {
			i++
		}
		if (i === expStart || i - expStart > 6) {
			return undefined
		}
		const magnitude = Number(Str.slice(expStart, i)(text))
		exponent = expNegative ? -magnitude : magnitude
	}
	if (i !== n) {
		return undefined
	}
	return {
		sign: negative ? "-" : "+",
		coefficient: BigInt(int + frac),
		exponent: exponent - frac.length
	}
}

const specials: ReadonlyMap<string, number> = new Map([
	["NaN", Number.NaN],
	["Infinity", Number.POSITIVE_INFINITY],
	["-Infinity", Number.NEGATIVE_INFINITY]
])

/** A double precision output text: its binary64 value, -0 as +0. */
export const strictDouble = (text: string): Result.Result<number, StrictFault> => {
	const special = specials.get(text)
	if (special !== undefined) {
		return Result.succeed(special)
	}
	if (parseParts(text) === undefined) {
		return Result.fail("floatSyntax")
	}
	const x = Number(text)
	return Number.isFinite(x) ? Result.succeed(canonicalZero(x)) : Result.fail("floatRange")
}

/** A finite binary32 text, exactly rounded; a text that overflows or underflows a nonzero value is refused. */
const finiteBinary32 = (text: string): Result.Result<number, StrictFault> => {
	const parts = parseParts(text)
	if (parts === undefined) {
		return Result.fail("floatSyntax")
	}
	const magnitude = decimalToBinary32(parts.coefficient, parts.exponent)
	if (!Number.isFinite(magnitude)) {
		return Result.fail("floatRange")
	}
	if (magnitude === 0 && parts.coefficient !== 0n) {
		return Result.fail("floatRange")
	}
	return Result.succeed(canonicalZero(parts.sign === "-" ? -magnitude : magnitude))
}

/** A real output text: its binary32 value exactly, -0 as +0. */
export const strictReal = (text: string): Result.Result<number, StrictFault> => {
	const special = specials.get(text)
	return special !== undefined ? Result.succeed(special) : finiteBinary32(text)
}

/** A vector component text: finite only (pgvector refuses NaN and infinity). */
export const strictComponent = (text: string): Result.Result<number, StrictFault> =>
	finiteBinary32(text)

/**
 * range_out of a nonempty bounded half-open range, "[start,end)": its two endpoint texts, the text between "[" and its
 * one comma and between that comma and ")", which the endpoint's own strict reader reads (endpointReaders).
 */
const spanEndpoints = (text: string): readonly [string, string] | undefined => {
	const n = text.length
	if (n < 5 || !codeIs(text, 0, 0x5b) || !codeIs(text, n - 1, 0x29)) {
		return undefined
	}
	const comma = Str.indexOf(",")(text)
	if (Option.isNone(comma)) {
		return undefined
	}
	return [Str.slice(1, comma.value)(text), Str.slice(comma.value + 1, n - 1)(text)]
}

const endpointReaders: {
	readonly [P in SpanEndpointCarrier]: (
		text: string
	) => Result.Result<SpanEndpointHost[P], StrictFault>
} = {
	int4: readSmall(int4Min.value, int4Max.value),
	int8: readInt8,
	date: (text) => toResult(toCalendarDate(text))
}

const readSpan =
	<P extends SpanEndpointCarrier>(endpoint: P) =>
	(text: string): Result.Result<Span<SpanEndpointHost[P]>, StrictFault> => {
		const endpoints = spanEndpoints(text)
		if (endpoints === undefined) {
			return Result.fail("spanSyntax")
		}
		const read: (text: string) => Result.Result<SpanEndpointHost[P], StrictFault> =
			endpointReaders[endpoint]
		const s = read(endpoints[0])
		const e = read(endpoints[1])
		if (Result.isFailure(s) || Result.isFailure(e)) {
			return Result.fail("spanSyntax")
		}
		const span = makeSpan(endpoint, s.success, e.success)
		return span.ok ? Result.succeed(span.value) : Result.fail("spanSyntax")
	}

/** vector_out text: "[c1,...,cn]" of exactly the column's dimensions, each component read exactly as binary32. */
const readVector =
	(spec: SpecOf<"vector">) =>
	(text: string): Result.Result<Vector, StrictFault> => {
		const last = text.length - 1
		if (text.length < 3 || !codeIs(text, 0, 0x5b) || !codeIs(text, last, 0x5d)) {
			return Result.fail("vectorSyntax")
		}
		const buffer = new Float32Array(spec.dimensions)
		let i = 0
		let start = 1
		while (start <= last) {
			const comma = Option.map(Str.indexOf(",")(Str.slice(start)(text)), (at) => start + at)
			const end = Option.isNone(comma) || comma.value > last ? last : comma.value
			if (i >= buffer.length) {
				return Result.fail("vectorDimensions")
			}
			const c = strictComponent(Str.slice(start, end)(text))
			if (Result.isFailure(c)) {
				return Result.fail(c.failure === "floatSyntax" ? "vectorSyntax" : "vectorOverflow")
			}
			buffer[i] = c.success
			i++
			start = end + 1
		}
		if (i !== buffer.length) {
			return Result.fail("vectorDimensions")
		}
		return toResult(Vector.admit(buffer, spec.dimensions))
	}

/**
 * int2out of a closed id's code: digits without a leading zero, no sign, naming a live code of the roster (a domain
 * admits no other), read as the handle it names. A hole, a code past the roster's size or a negative one is codeHandle.
 */
const readCode =
	(roster: RosterCodec) =>
	(text: string): Result.Result<string, StrictFault> => {
		if (!isIntegerText(text) || text === "-0") {
			return Result.fail("integerSyntax")
		}
		const name = roster.names[Number(text)]
		return name === undefined || name === "" ? Result.fail("codeHandle") : Result.succeed(name)
	}

/**
 * bit(n)'s output text of a set over the roster: exactly n characters, the roster's codes rounded up to whole hex digits
 * (test/support/closed/bit-text.ts wholeDigits), each 0 or 1, position c code c, every 1 at a live code (a set holds no
 * hole, and no padding position past the last code). Another length or character is bitsSyntax; a 1 at a hole or past
 * the last code is bitsMember.
 */
const readBits =
	(roster: RosterCodec) =>
	(text: string): Result.Result<ReadonlySet<string>, StrictFault> => {
		if (text.length !== wholeDigits(roster.size)) {
			return Result.fail("bitsSyntax")
		}
		const handles = new Set<string>()
		for (let code = 0; code < text.length; code++) {
			const bit = unitAt(text, code)
			if (bit === "1") {
				const name = roster.names[code]
				if (name === undefined || name === "") {
					return Result.fail("bitsMember")
				}
				handles.add(name)
			} else if (bit !== "0") {
				return Result.fail("bitsSyntax")
			}
		}
		return Result.succeed(handles)
	}

/**
 * byteaout's hex text: `\x`, then two lowercase hex digits a byte, which hex_encode writes; any other text is
 * bytesSyntax.
 */
const readBytes = (text: string): Result.Result<Uint8Array<ArrayBuffer>, StrictFault> => {
	if (!Str.startsWith("\\x")(text) || text.length % 2 !== 0) {
		return Result.fail("bytesSyntax")
	}
	for (let at = 2; at < text.length; at++) {
		if (!Option.exists(Str.charCodeAt(text, at), (c) => isDigit(c) || (c >= 0x61 && c <= 0x66))) {
			return Result.fail("bytesSyntax")
		}
	}
	return Result.succeed(Uint8Array.fromHex(Str.slice(2)(text)))
}

const readers: {
	readonly [C in Carrier]: (
		spec: SpecOf<C>
	) => (text: string) => Result.Result<CarrierHost[C], StrictFault>
} = {
	int2: () => readSmall(int2Min.value, int2Max.value),
	int4: () => readSmall(int4Min.value, int4Max.value),
	int8: () => readInt8,
	numeric: (spec) => readNumeric(spec),
	float4: () => strictReal,
	float8: () => strictDouble,
	money: () => readMoney,
	bool: () => readBool,
	uuid: () => (text) => toResult(toUuid(text)),
	date: () => (text) => toResult(toCalendarDate(text)),
	text: () => (text) => toResult(validateText(text)),
	bytes: () => readBytes,
	code: (spec) => readCode(spec.roster),
	bits: (spec) => readBits(spec.roster),
	range4: () => readSpan("int4"),
	range8: () => readSpan("int8"),
	rangeDate: () => readSpan("date"),
	vector: (spec) => readVector(spec),
	exactInteger: () => readExactInteger,
	exactMoney: () => readExactMoney
}

const readerOf = <C extends Carrier>(
	spec: SpecOf<C> & CarrierSpec
): ((text: string) => Result.Result<CarrierHost[Carrier], StrictFault>) => {
	const own: SpecOf<C> = spec
	const of: (spec: SpecOf<C>) => (text: string) => Result.Result<CarrierHost[C], StrictFault> =
		readers[own.carrier]
	return of(own)
}

/**
 * The strict reader of a column type's output texts, built once per type, a closed id's or a set's under the
 * installation's codes.
 *
 * The strict readers of PostgreSQL's output texts, one per carrier: the test kernel's side of the trusting conversions.
 *
 * src converts a result text without a check (packages/engine/src/scalar/values/convert.ts): the text is PostgreSQL's own
 * output of a value of the column's type, so the library reads it at its cheapest. The kernel keeps the strict reading
 * of the same texts, which admits only the spellings PostgreSQL's output functions write for a value of the type, and
 * refuses every other text with a named fault: the public-boundary differential (test/pg/oracle/public) reads every
 * delivered cell's text through it and requires the trusting conversion to agree, so a converter that misreads a text
 * PostgreSQL really writes fails there, and the codec tests pin each carrier's output grammar here.
 *
 * | Carrier | Admitted text |
 * | --- | --- |
 * | int2, int4, int8 | an optional minus sign and one to nineteen digits without a leading zero, no -0, in range |
 * | numeric | numeric_out text (Decimal.fromString's value writes it back), at the declared typmod, or a computed numeric's value within the integer and fraction digits its type proves (numericBound) |
 * | float4, float8 | a shortest round-trip decimal, NaN, Infinity or -Infinity; a real read exactly as binary32 |
 * | money | money::numeric text: a finite amount with at most two fractional digits, within int64 |
 * | bool | t, f, true, false |
 * | uuid | a hyphenated uuid, read as its lowercase spelling |
 * | text | well-formed text without NUL |
 * | code | int2out of a live code of the roster, read as its handle |
 * | bits | bit(n) text of exactly the roster's size, every 1 at a live code, read as its handles |
 * | range4, range8 | [start,end) of in-range endpoints, start < end |
 * | vector | [c1,...,cn] of exactly the dimensions, finite binary32 components |
 * | exact integer | an optional minus sign and digits without a leading zero, of any length, no -0 |
 * | exact money | numeric_out text of a finite amount with at most two fractional digits, of any magnitude |
 */
export const strictReader = (
	type: ScalarType,
	codes: Codebook
): ((text: string) => Result.Result<CarrierHost[Carrier], StrictFault>) => {
	const read = readerOf(carrierSpecOf(type, codes))
	const bound = numericBoundOf(type)
	return bound === undefined
		? read
		: (text) =>
				Result.flatMap(read(text), (value) =>
					value instanceof Decimal && !withinBound(value, bound)
						? Result.fail("numericBound")
						: Result.succeed(value)
				)
}

/**
 * The least scale of a finite nonzero value of `coefficient` at `minScale`: its own where it has a fraction, and an
 * integer's trailing zeros below scale 0, so 500 is a multiple of 10^2, scale -2. The zeros are counted in one pass over
 * the coefficient's digits, so an integer of numeric's 131072 digits reads without a frame per zero.
 */
const leastScale = (coefficient: bigint, minScale: number): number => {
	if (minScale > 0) {
		return minScale
	}
	const digits = coefficient.toString()
	let end = digits.length
	while (codeIs(digits, end - 1, 0x30)) {
		end--
	}
	return minScale - (digits.length - end)
}

/**
 * Whether a computed numeric's value is one its type proves: a finite value below 10^digits, a multiple of 10^-scale,
 * every value PostgreSQL computes for the expression, so a database run's cell past the bound is a bound the compiler
 * proved and PostgreSQL broke; NaN and the infinities carry no digits. A negative digits or scale is read exactly, as
 * bounds.ts tenTo reads it: a value is below 10^d exactly when its coefficient's digits less its scale are at most d,
 * so 0.00042 is below 10^-3, and 500 is a multiple of 10^2.
 */
const withinBound = (value: Decimal, bound: NumericBound): boolean => {
	const p = value.parts
	if (p.kind !== "finite" || p.coefficient === 0n) {
		return true
	}
	return (
		p.coefficient.toString().length - p.minScale <= bound.digits &&
		leastScale(p.coefficient, p.minScale) <= bound.scale
	)
}

/**
 * The value of PostgreSQL's output `text` of a value of `type`, or why it is no such text: a type of no roster, which
 * reads no codes. A closed id's or a set's text is read under its installation's codes (strictReader).
 */
export const strictRead = (
	type: ScalarType,
	text: string
): Result.Result<CarrierHost[Carrier], StrictFault> => strictReader(type, emptyCodebook)(text)

/** An element of array_out's text: its value, `null` for a NULL element, and the index just past it. */
interface ArrayElement {
	readonly value: string | null
	readonly next: number
}

/** A double-quoted element from its opening quote at `i`, each backslash escape undone; `end` is the closing brace. */
const quoted = (text: string, i: number, end: number): Result.Result<ArrayElement, "syntax"> => {
	let value = ""
	let at = i + 1
	while (at < end) {
		const ch = unitAt(text, at)
		if (ch === '"') {
			return Result.succeed({ value, next: at + 1 })
		}
		const escaped = ch === "\\"
		if (escaped && at + 1 >= end) {
			return Result.fail("syntax")
		}
		value += escaped ? unitAt(text, at + 1) : ch
		at += escaped ? 2 : 1
	}
	return Result.fail("syntax")
}

/** An unquoted element from `i` up to the next comma, NULL in any case spelling a NULL element; `end` is the closing brace. */
const bare = (text: string, i: number, end: number): Result.Result<ArrayElement, "syntax"> => {
	let at = i
	while (at < end && text[at] !== ",") {
		const ch = unitAt(text, at)
		if (ch === '"' || ch === "{" || ch === "}" || ch === "\\") {
			return Result.fail("syntax")
		}
		at += 1
	}
	const value = Str.slice(i, at)(text)
	if (value.length === 0) {
		return Result.fail("syntax")
	}
	return Result.succeed({ value: Str.toUpperCase(value) === "NULL" ? null : value, next: at })
}

/**
 * The elements of a one-dimensional array's text output (array_out), read strictly: `{}` when empty, elements separated
 * by commas, an element double-quoted when it is empty, holds a delimiter, brace, quote, backslash or whitespace, or
 * spells NULL, with `\"` and `\\` escaped inside quotes; an unquoted NULL is a NULL element, `null` here. Any other
 * text is a syntax fault. src reads a fused attachment's array without a check (lower/shapes/attach/decode.ts
 * arrayElements), and must agree with this reading on every text PostgreSQL writes.
 */
export const strictArrayText = (
	text: string
): Result.Result<ReadonlyArray<string | null>, "syntax"> => {
	if (text.length < 2 || !Str.startsWith("{")(text) || !Str.endsWith("}")(text)) {
		return Result.fail("syntax")
	}
	const out: Array<string | null> = []
	if (text.length === 2) {
		return Result.succeed(out)
	}
	const end = text.length - 1
	let i = 1
	for (;;) {
		const element =
			i >= end ? Result.fail("syntax") : text[i] === '"' ? quoted(text, i, end) : bare(text, i, end)
		if (Result.isFailure(element)) {
			return Result.fail("syntax")
		}
		out.push(element.success.value)
		i = element.success.next
		if (i === end) {
			return Result.succeed(out)
		}
		if (text[i] !== ",") {
			return Result.fail("syntax")
		}
		i += 1
	}
}
