import { type Canonicalizable, canonicalTag, type TaggedValue } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription, type ValueFault } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { type DecimalValue, finiteDecimalText } from "#compiler/ir/decimal.ts"
import type { NumericTypmod } from "#compiler/ir/scalar.ts"
import { faultError } from "#compiler/scalar/values/fault.ts"

export type { NumericTypmod }

/** PostgreSQL's limits (src/include/utils/numeric.h, src/backend/utils/adt/numeric.c). */
const numericMaxPrecision = 1000
const numericMinScale = -1000
const numericMaxScale = 1000
export const numericMaxDisplayScale = 16383
export const numericMaxIntegerDigits = 131072
/** set_var_from_str refuses an exponent beyond PG_INT32_MAX / 2 before anything else. */
const maxExponent = 1073741823

type DecimalKind = "finite" | "nan" | "infinity" | "-infinity"

/** 10^0 through 10^63, the powers the arithmetic reads most, computed once. */
const pow10Table: ReadonlyArray<bigint> = [...Array.from({ length: 64 }).keys()].map(
	(i) => 10n ** BigInt(i)
)
/** 10^n: from the table below 64, computed above it. */
const pow10 = (n: number): bigint => pow10Table[n] ?? 10n ** BigInt(n)

/** The integer nearest to `c / 10^k` for c >= 0, ties away from zero (round_var). */
const roundHalfAway = (c: bigint, k: number): bigint => {
	if (k === 0) {
		return c
	}
	const divisor = pow10(k)
	const q = c / divisor
	return (c % divisor) * 2n >= divisor ? q + 1n : q
}

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39

const log10Of2 = Math.log10(2)

/** The end of the run of decimal digits of `text` from `start`. */
const digitsEnd = (text: string, start: number): number => {
	let i = start
	while (i < text.length && isDigit(text.charCodeAt(i))) {
		i++
	}
	return i
}

/**
 * The exponent written in `text` from `start`, after its `e` or `E`: an optional sign and at least one digit, at most
 * maxExponent in magnitude, with the index after it.
 */
const exponentAt = (
	text: string,
	start: number
): Result.Result<{ readonly value: number; readonly end: number }, ValueFault> => {
	const negative = text.startsWith("-", start)
	const digitsStart = negative || text.startsWith("+", start) ? start + 1 : start
	const end = digitsEnd(text, digitsStart)
	if (end === digitsStart) {
		return Result.err("decimalSyntax")
	}
	let magnitude = 0
	for (let i = digitsStart; i < end; i++) {
		magnitude = magnitude * 10 + (text.charCodeAt(i) - 0x30)
		if (magnitude > maxExponent) {
			return Result.err("decimalRange")
		}
	}
	return Result.ok({ value: negative ? -magnitude : magnitude, end })
}

/**
 * The length of a bigint's decimal text: its digits, and the sign of a negative one. It is read off the value without
 * writing the text, a bigint-to-decimal conversion of up to 147455 digits: below 10^15 by counting powers of ten on
 * the exact double; above, floor(log10 c) is bracketed between lo and hi, at most one apart, from the double's
 * logarithm or the bit length with a margin far beyond either's rounding, and one comparison with 10^hi decides.
 */
const digitCount = (c: bigint): number => {
	const n = Number(c)
	if (n > -1e15 && n < 1e15) {
		const m = Math.abs(n)
		let length = n < 0 ? 2 : 1
		for (let p = 10; p <= m; p *= 10) {
			length++
		}
		return length
	}
	if (c < 0n) {
		return digitCount(-c) + 1
	}
	let lo: number
	let hi: number
	if (n < Number.POSITIVE_INFINITY) {
		const l = Math.log10(n)
		lo = Math.floor(l - 1e-9)
		hi = Math.floor(l + 1e-9)
	} else {
		const hex = c.toString(16)
		const bits = (hex.length - 1) * 4 + 32 - Math.clz32(Number.parseInt(hex.charAt(0), 16))
		lo = Math.floor((bits - 1) * log10Of2 - 1e-6)
		hi = Math.floor(bits * log10Of2 + 1e-6)
	}
	return lo === hi || c < pow10(hi) ? lo + 1 : hi + 1
}

/** A Decimal that is neither NaN nor an infinity: what `isFinite` proves. */
export type FiniteDecimal = Decimal & { readonly [finiteDecimal]: true }
declare const finiteDecimal: unique symbol

/**
 * The owned exact Decimal carrier of pg.numeric and pg.decimal.
 *
 * A Decimal is a PostgreSQL numeric value exactly as PostgreSQL holds it: NaN, +Infinity, -Infinity, or a finite
 * value `(-1)^negative * coefficient / 10^scale`, where `scale` is the display scale (dscale) PostgreSQL prints and
 * carries through arithmetic, and `coefficient` is a nonnegative bigint. It never travels through a JavaScript number,
 * and zero is never negative (numeric has no signed zero; make_result forces it positive).
 *
 * Two identities exist, and they differ only in the display scale:
 *
 * - Value identity, the one facts, keys, DISTINCT, grouping and `equals` use: 1.0 = 1.00. The
 *   identity text strips trailing fractional zeros, so equal values have one text (`identityText`).
 * - Representation, the one a literal carries into SQL: `toString` is PostgreSQL's numeric_out text and keeps the
 *   display scale, because scale(), min_scale() and numeric division's result scale observe it. The canonical
 *   serializer carries this text under the tag "d", so a description round-trips exactly.
 *
 * Value limits are PostgreSQL's numeric format: at most 131072 digits before the decimal point (an int16 weight in
 * base 10000) and a display scale of at most 16383 (NUMERIC_DSCALE_MAX). Every Decimal satisfies them, so bare
 * `numeric` admits every Decimal unchanged.
 *
 * Declared precision and scale coerce exactly as PostgreSQL's apply_typmod does: round half away from
 * zero to the declared scale, set the display scale to max(scale, 0), then refuse a value whose rounded magnitude
 * needs more integer digits than precision minus scale, so rounding can cause the overflow. NaN passes every typmod
 * and infinity passes none (apply_typmod_special).
 *
 * Reading numeric_out text (fromOutput) and writing it (toString) are per-row hot paths: they scan code units in place
 * with native string methods and allocate only the digit text BigInt reads and the value itself.
 */
export class Decimal implements Canonicalizable {
	readonly kind: DecimalKind
	/** Finite values only; false for zero and for the special values. */
	readonly negative: boolean
	/** The unscaled magnitude: the value's digits including `scale` fractional digits. 0n for the special values. */
	readonly coefficient: bigint
	/** The display scale, 0..16383. 0 for the special values. */
	readonly scale: number
	/**
	 * The numeric_out text, written once on first use: a Decimal is immutable, and its text, which canonical encoding,
	 * hashing and identity read again and again, costs a bigint-to-decimal conversion of up to 147455 digits. A private
	 * field is no property, so the frozen instance's properties stay what they are.
	 */
	#text: string | undefined = undefined

	private constructor(kind: DecimalKind, negative: boolean, coefficient: bigint, scale: number) {
		this.kind = kind
		this.negative = negative && coefficient !== 0n
		this.coefficient = coefficient
		this.scale = scale
		Object.freeze(this)
	}

	static readonly nan: Decimal = new Decimal("nan", false, 0n, 0)
	static readonly infinity: Decimal = new Decimal("infinity", false, 0n, 0)
	static readonly negativeInfinity: Decimal = new Decimal("-infinity", false, 0n, 0)
	static readonly zero: Decimal = new Decimal("finite", false, 0n, 0)

	/** A finite Decimal from its parts, refused outside PostgreSQL's numeric format. */
	static fromParts(
		negative: boolean,
		coefficient: bigint,
		scale: number
	): Result.Result<Decimal, ValueFault> {
		if (typeof coefficient !== "bigint" || coefficient < 0n) {
			return Result.err("decimalType")
		}
		if (!Number.isInteger(scale) || scale < 0) {
			return Result.err("decimalType")
		}
		if (scale > numericMaxDisplayScale) {
			return Result.err("decimalRange")
		}
		if (coefficient !== 0n && digitCount(coefficient) - scale > numericMaxIntegerDigits) {
			return Result.err("decimalRange")
		}
		return Result.ok(new Decimal("finite", negative, coefficient, scale))
	}

	/** The Decimal of an IR decimal value (ir/decimal.ts DecimalValue), whose parts are a numeric's already. */
	static fromValue(value: DecimalValue): Decimal {
		return value.kind === "finite"
			? new Decimal("finite", value.negative, value.coefficient, value.scale)
			: new Decimal(value.kind, false, 0n, 0)
	}

	/**
	 * An int64 count of hundredths, at display scale 2: always a numeric, since an int64 has at most 19 digits and a
	 * numeric holds far more before its decimal point. A money amount's exact value (money.ts toDecimal).
	 */
	static fromHundredths(hundredths: bigint): Decimal {
		return new Decimal("finite", hundredths < 0n, hundredths < 0n ? -hundredths : hundredths, 2)
	}

	/** An integer Decimal, display scale 0. */
	static fromBigInt(value: bigint): Result.Result<Decimal, ValueFault> {
		if (typeof value !== "bigint") {
			return Result.err("decimalType")
		}
		return Decimal.fromParts(value < 0n, value < 0n ? -value : value, 0)
	}

	/**
	 * Parses an exact decimal literal. The grammar is PostgreSQL's numeric input restricted to its exact decimal
	 * spellings: an optional sign, digits with an optional fraction (".5" and "5." included), and an optional
	 * exponent; or exactly NaN, Infinity, +Infinity or -Infinity. Whitespace, digit-group underscores, non-decimal
	 * prefixes and the "inf" abbreviation are refused, so every accepted text means one value with one display scale,
	 * computed as numeric_in computes it: display scale max(0, fraction digits - exponent).
	 *
	 * Digits before the decimal point once the exponent is applied.
	 */
	static fromString(text: string): Result.Result<Decimal, ValueFault> {
		if (typeof text !== "string") {
			return Result.err("decimalType")
		}
		switch (text) {
			case "NaN":
				return Result.ok(Decimal.nan)
			case "Infinity":
			case "+Infinity":
				return Result.ok(Decimal.infinity)
			case "-Infinity":
				return Result.ok(Decimal.negativeInfinity)
		}
		const negative = text.startsWith("-")
		const intStart = negative || text.startsWith("+") ? 1 : 0
		const intEnd = digitsEnd(text, intStart)
		const intDigits = text.slice(intStart, intEnd)
		const point = text.startsWith(".", intEnd)
		const fracEnd = point ? digitsEnd(text, intEnd + 1) : intEnd
		const fracDigits = point ? text.slice(intEnd + 1, fracEnd) : ""
		if (intDigits.length === 0 && fracDigits.length === 0) {
			return Result.err("decimalSyntax")
		}
		const written: Result.Result<{ readonly value: number; readonly end: number }, ValueFault> =
			text.startsWith("e", fracEnd) || text.startsWith("E", fracEnd)
				? exponentAt(text, fracEnd + 1)
				: Result.ok({ value: 0, end: fracEnd })
		if (!written.ok) {
			return Result.err(written.error)
		}
		if (written.value.end !== text.length) {
			return Result.err("decimalSyntax")
		}
		const exponent = written.value.value
		const fractionLength = fracDigits.length
		const scale = Math.max(0, fractionLength - exponent)
		if (scale > numericMaxDisplayScale) {
			return Result.err("decimalRange")
		}
		const all = intDigits + fracDigits
		let zeros = 0
		while (zeros < all.length && all.charCodeAt(zeros) === 0x30) {
			zeros++
		}
		if (zeros === all.length) {
			return Result.ok(new Decimal("finite", false, 0n, scale))
		}
		const significant = all.slice(zeros)
		if (significant.length + exponent - fractionLength > numericMaxIntegerDigits) {
			return Result.err("decimalRange")
		}
		const shift = Math.max(exponent - fractionLength, 0)
		const coefficient = BigInt(significant) * pow10(shift)
		return Result.ok(new Decimal("finite", negative, coefficient, scale))
	}

	/**
	 * The Decimal whose numeric_out text is `text`, trusted: a column's output, NaN, Infinity, -Infinity, or an optional
	 * minus sign, integer digits and an optional fraction whose length is the display scale. Nothing is checked, and
	 * `text` is kept as the value's text instead of being written again.
	 */
	static fromOutput(text: string): Decimal {
		switch (text) {
			case "NaN":
				return Decimal.nan
			case "Infinity":
				return Decimal.infinity
			case "-Infinity":
				return Decimal.negativeInfinity
		}
		const negative = text.startsWith("-")
		const start = negative ? 1 : 0
		const point = text.indexOf(".", start)
		const decimal =
			point < 0
				? new Decimal("finite", negative, BigInt(text.slice(start)), 0)
				: new Decimal(
						"finite",
						negative,
						BigInt(text.slice(start, point) + text.slice(point + 1)),
						text.length - point - 1
					)
		decimal.#text = text
		return decimal
	}

	/**
	 * The literal boundary: a Decimal as is, a bigint, or an exact decimal string. A
	 * JavaScript number is refused, because it has already rounded to binary64. Reading the caller's value can run its
	 * code (instanceof runs a proxy's getPrototypeOf trap), so it is read once through hostRead, and a value whose
	 * reading throws is refused as no Decimal; `admit` and `of` read through here.
	 */
	static parse(input: unknown): Result.Result<Decimal, ValueFault> {
		return hostRead("decimalType", (): Result.Result<Decimal, ValueFault> => {
			if (input instanceof Decimal) {
				return Result.ok(input)
			}
			if (typeof input === "bigint") {
				return Decimal.fromBigInt(input)
			}
			if (typeof input === "string") {
				return Decimal.fromString(input)
			}
			return Result.err(typeof input === "number" ? "decimalNumber" : "decimalType")
		})
	}

	/** The builders' throwing convenience: `parse`, raising CompileError MalformedDescription. */
	static of(input: Decimal | bigint | string): Decimal {
		return Decimal.admit(input)
	}

	/**
	 * The admission core `of` runs, for what a JavaScript caller may pass: `parse`, raising CompileError
	 * MalformedDescription.
	 */
	static admit(input: unknown): Decimal {
		const parsed = Decimal.parse(input)
		if (!parsed.ok) {
			throw faultError(parsed.error, SourceLoc("Decimal literal", []))
		}
		return parsed.value
	}

	/** The reviver for the canonical tag "d": exactly the text `toString` writes, and nothing else. */
	static fromCanonical(payload: string): Result.Result<Decimal, CompileError> {
		const parsed = Decimal.fromString(payload)
		if (!parsed.ok) {
			return Result.err(faultError(parsed.error, SourceLoc("canonical Decimal", [])))
		}
		if (parsed.value.toString() !== payload) {
			return Result.err(
				malformedDescription(
					SourceLoc("canonical Decimal", []),
					"the canonical text of a Decimal, as PostgreSQL's numeric output writes it"
				)
			)
		}
		return Result.ok(parsed.value)
	}

	isNaN(): boolean {
		return this.kind === "nan"
	}

	isFinite(): this is FiniteDecimal {
		return this.kind === "finite"
	}

	isInfinite(): boolean {
		return this.kind === "infinity" || this.kind === "-infinity"
	}

	isZero(): boolean {
		return this.kind === "finite" && this.coefficient === 0n
	}

	/**
	 * PostgreSQL's numeric_out text: the display scale's fractional digits, no exponent, "NaN", "Infinity" and
	 * "-Infinity" for the special values.
	 */
	toString(): string {
		this.#text ??= this.#write()
		return this.#text
	}

	#write(): string {
		switch (this.kind) {
			case "nan":
				return "NaN"
			case "infinity":
				return "Infinity"
			case "-infinity":
				return "-Infinity"
			case "finite":
				return finiteDecimalText(this.negative, this.coefficient, this.scale)
		}
	}

	/**
	 * The value's one text: `toString` with trailing fractional zeros (and a then bare point) removed, which is
	 * PostgreSQL's trim_scale. Equal values, whatever their display scales, have equal identity texts.
	 */
	identityText(): string {
		const text = this.toString()
		if (this.kind !== "finite" || this.scale === 0) {
			return text
		}
		let end = text.length
		while (end > 0 && text.charCodeAt(end - 1) === 0x30) {
			end--
		}
		if (end > 0 && text.charCodeAt(end - 1) === 0x2e) {
			end--
		}
		return text.slice(0, end)
	}

	/**
	 * PostgreSQL's numeric comparison (cmp_numerics): -Infinity < every finite value < +Infinity < NaN, NaN = NaN,
	 * and finite values by value regardless of display scale.
	 */
	compare(that: Decimal): -1 | 0 | 1 {
		return compareDecimal(this, that)
	}

	equals(that: Decimal): boolean {
		return compareDecimal(this, that) === 0
	}

	[canonicalTag](): TaggedValue {
		return { tag: "d", payload: this.toString() }
	}
}

const kindRank = (d: Decimal): number => {
	switch (d.kind) {
		case "-infinity":
			return 0
		case "finite":
			return 1
		case "infinity":
			return 2
		case "nan":
			return 3
	}
}

export const compareDecimal = (a: Decimal, b: Decimal): -1 | 0 | 1 => {
	const ra = kindRank(a)
	const rb = kindRank(b)
	if (ra !== rb) {
		return ra < rb ? -1 : 1
	}
	if (a.kind !== "finite") {
		return 0
	}
	if (a.negative !== b.negative) {
		return a.negative ? -1 : 1
	}
	const scale = Math.max(a.scale, b.scale)
	const ma = a.coefficient * pow10(scale - a.scale)
	const mb = b.coefficient * pow10(scale - b.scale)
	if (ma === mb) {
		return 0
	}
	return ma < mb === a.negative ? 1 : -1
}

/**
 * A finite Decimal as a signed integer count of 10^-scale units, rounded half away from zero: round(d * 10^scale).
 * `scale` may be negative. This is the rounding of PostgreSQL's round_var and of its numeric-to-integer casts.
 */
export const roundedUnits = (d: FiniteDecimal, scale: number): bigint => {
	const magnitude =
		scale >= d.scale
			? d.coefficient * pow10(scale - d.scale)
			: roundHalfAway(d.coefficient, d.scale - scale)
	return d.negative ? -magnitude : magnitude
}

const isInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value)

/**
 * numerictypmodin's rule over the typmod list a JavaScript caller passes: precision 1..1000, scale -1000..1000, both
 * integers; a one-element list is numeric(p), scale 0. null, like every other non-integer, is refused. This is the one
 * check: a NumericTypmod is checked, so normalizeNumeric takes one as it is.
 */
export const checkNumericTypmod = (
	typmod: readonly [unknown] | readonly [unknown, unknown]
): Result.Result<NumericTypmod, ValueFault> => {
	const [precision] = typmod
	if (!isInteger(precision) || precision < 1 || precision > numericMaxPrecision) {
		return Result.err("numericTypmod")
	}
	if (typmod.length === 1) {
		return Result.ok({ precision, scale: 0 })
	}
	const [, scale] = typmod
	if (!isInteger(scale) || scale < numericMinScale || scale > numericMaxScale) {
		return Result.err("numericTypmod")
	}
	return Result.ok({ precision, scale: scale === 0 ? 0 : scale })
}

/**
 * The value a numeric(p, s) column stores for `d`, as apply_typmod and apply_typmod_special compute it:
 * NaN unchanged; infinity refused (numericInfinity); otherwise rounded half away from zero to scale s, displayed at
 * scale max(s, 0), and refused when the rounded magnitude is at least 10^(p - s) (numericOverflow, SQLSTATE 22003 in
 * PostgreSQL). Without a typmod the value is bare numeric's, which every Decimal already is.
 *
 * A value already at the declared scale is its own normal form: kept, with the text it may already hold.
 */
export const normalizeNumeric = (
	d: Decimal,
	typmod: NumericTypmod | undefined
): Result.Result<Decimal, ValueFault> => {
	if (typmod === undefined) {
		return Result.ok(d)
	}
	const { precision, scale } = typmod
	if (!d.isFinite()) {
		return d.isNaN() ? Result.ok(d) : Result.err("numericInfinity")
	}
	const units = roundedUnits(d, scale)
	const magnitude = units < 0n ? -units : units
	if (magnitude >= pow10(precision)) {
		return Result.err("numericOverflow")
	}
	const negative = units < 0n
	if (scale >= 0 && d.scale === scale && d.coefficient === magnitude && d.negative === negative) {
		return Result.ok(d)
	}
	if (scale >= 0) {
		return Decimal.fromParts(negative, magnitude, scale)
	}
	return Decimal.fromParts(negative, magnitude * pow10(-scale), 0)
}
