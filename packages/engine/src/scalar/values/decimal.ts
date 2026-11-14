import { type Canonicalizable, canonicalTag, type TaggedValue } from "#compiler/core/canonical.ts"
import {
	type DecimalParts,
	type FiniteParts,
	finiteDigitsText,
	infinityParts,
	nanParts,
	negativeInfinityParts
} from "#compiler/core/decimal.ts"
import { type CompileError, malformedDescription, type ValueFault } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { derived, int4Max, type Limit } from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import {
	moneyFractionDigits,
	numericMaxFractionDigits,
	numericMaxIntegerDigits,
	numericMaxPrecision,
	numericMaxScale,
	numericMinScale
} from "#compiler/ir/carriers.ts"
import { type DecimalValue, decimalPayload, decimalTag } from "#compiler/ir/decimal.ts"
import type { NumericTypmod } from "#compiler/ir/scalar.ts"
import { faultError } from "#compiler/scalar/values/fault.ts"

export type { DecimalParts, FiniteParts, NumericTypmod }

/**
 * The greatest exponent magnitude a numeric's text may write: set_var_from_str refuses a greater one before anything
 * else.
 */
const maxExponent: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "a decimal exponent",
	scope: "the exponent of a numeric text a caller writes, `1e5` and `1E-5`",
	from: [int4Max],
	derivation:
		'PG_INT32_MAX / 2 in C integer division, numeric.c set_var_from_str (https://github.com/postgres/postgres/blob/REL_19_RC2/src/backend/utils/adt/numeric.c#L6927, "if (exponent > PG_INT32_MAX / 2)")',
	compute: ([max]) => Math.trunc(max.value / 2)
})

/** 10^n. */
const pow10 = (n: number): bigint => 10n ** BigInt(n)

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

/** The end of the run of decimal digits of `text` from `start`. */
const digitsEnd = (text: string, start: number): number => {
	let i = start
	while (i < text.length && isDigit(text.charCodeAt(i))) {
		i++
	}
	return i
}

/** The end of `text`'s digits in [start, end) once its trailing zeros are dropped. */
const zerosDropped = (text: string, start: number, end: number): number => {
	let i = end
	while (i > start && text.charCodeAt(i - 1) === 0x30) {
		i--
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
		if (magnitude > maxExponent.value) {
			return Result.err("decimalRange")
		}
	}
	return Result.ok({ value: negative ? -magnitude : magnitude, end })
}

/** A finite Decimal: what `isFinite` proves, its parts the one form of a finite value. */
export type FiniteDecimal = Decimal & { readonly parts: FiniteParts }

const finiteParts = (negative: boolean, coefficient: bigint, minScale: number): FiniteParts =>
	Object.freeze({ kind: "finite", negative: negative && coefficient !== 0n, coefficient, minScale })

/** What a Decimal's parse answers for an input it could not read: no Decimal. */
const notDecimal = (): ValueFault => "decimalType"

/** The refusal of an IR decimal value whose payload could not be read. */
const unrevived = (): CompileError => faultError("decimalType", SourceLoc("Decimal value", []))

/** The key the one mint takes, which no other module holds. */
const minting: unique symbol = Symbol("Decimal")

/**
 * The owned exact Decimal carrier of pg.numeric and pg.decimal: a numeric value and nothing else. 1, 1.0 and 1.00
 * are one Decimal, written "1".
 *
 * A Decimal is NaN, +Infinity, -Infinity, or a finite value in its one form (ir/decimal.ts FiniteParts):
 * `(-1)^negative * coefficient / 10^minScale`, where minScale is the least scale that writes the value exactly and zero
 * is never negative. It has no display scale. Every constructor, the decoder of PostgreSQL's output included, yields
 * that form, so two Decimals are `equals` exactly when their parts, their texts and their canonical payloads are
 * identical, and no observation grizzle offers tells equal values apart. Its one text, `text` and `toString`, is
 * PostgreSQL's numeric_out of trim_scale(value), written at construction.
 *
 * Value limits are PostgreSQL's numeric format: at most numericMaxIntegerDigits digits before the decimal point (an
 * int16 weight in base 10000) and at most numericMaxFractionDigits past it (NUMERIC_DSCALE_MAX). Admission is by value:
 * a written scale above numericMaxFractionDigits whose value's minScale fits is admitted as its value, which is never
 * sent as written. Every Decimal satisfies the limits.
 *
 * Declared precision and scale coerce as PostgreSQL's apply_typmod does: round half away from zero to the declared
 * scale, then refuse a value whose rounded magnitude needs more integer digits than precision minus scale, so rounding
 * can cause the overflow. The result is the one form: numeric(5,2) admits 1.2 as 1.2, never 1.20. NaN passes every
 * typmod and infinity passes none (apply_typmod_special).
 *
 * Reading numeric_out text (fromOutput) and writing it (toString) are per-row hot paths: fromOutput scans code units in
 * place and allocates only the digit text BigInt reads, the value, and a slice when the text ends in fractional zeros.
 */
export class Decimal implements Canonicalizable {
	readonly parts: DecimalParts
	/** numeric_out of trim_scale(value): the value's one text, written at construction. */
	readonly text: string
	/** The brand `instanceof Decimal` reads: installed only by the constructor, which only this module can call. */
	readonly #minted = true

	/**
	 * The one mint. It refuses a call without the module's key, so a JavaScript caller that reaches past the private
	 * constructor, a subclass's `super` included, makes no Decimal: every Decimal is one of the checked constructors'
	 * below, its text derived from its parts.
	 */
	private constructor(key: typeof minting, parts: DecimalParts, text: string) {
		if (key !== minting) {
			throw faultError("decimalType", SourceLoc("Decimal constructor", []))
		}
		this.parts = parts
		this.text = text
		Object.freeze(this)
	}

	/**
	 * A Decimal is exactly what this module minted: `instanceof` reads the private brand, which no object built on
	 * Decimal.prototype and no proxy holds, so a forged Decimal is never mistaken for one and runs no code of its own.
	 */
	static [Symbol.hasInstance](value: unknown): value is Decimal {
		return typeof value === "object" && value !== null && #minted in value
	}

	/**
	 * The finite value `digits` times 10^exponent in its one form, `digits` its significant digits (no leading zero, and
	 * no trailing zero when the exponent is negative), or its refusal outside PostgreSQL's numeric format: more than
	 * numericMaxFractionDigits digits past the point, or more than numericMaxIntegerDigits before it.
	 */
	static #fromSignificant(
		negative: boolean,
		digits: string,
		exponent: number
	): Result.Result<Decimal, ValueFault> {
		if (exponent >= 0) {
			if (digits.length + exponent > numericMaxIntegerDigits.value) {
				return Result.err("decimalRange")
			}
			const text = digits + "0".repeat(exponent)
			const parts = finiteParts(negative, BigInt(digits) * pow10(exponent), 0)
			return Result.ok(new Decimal(minting, parts, negative ? `-${text}` : text))
		}
		const minScale = -exponent
		if (
			minScale > numericMaxFractionDigits.value ||
			digits.length - minScale > numericMaxIntegerDigits.value
		) {
			return Result.err("decimalRange")
		}
		const parts = finiteParts(negative, BigInt(digits), minScale)
		return Result.ok(new Decimal(minting, parts, finiteDigitsText(negative, digits, minScale)))
	}

	static readonly nan: Decimal = new Decimal(minting, nanParts, "NaN")
	static readonly infinity: Decimal = new Decimal(minting, infinityParts, "Infinity")
	static readonly negativeInfinity: Decimal = new Decimal(
		minting,
		negativeInfinityParts,
		"-Infinity"
	)
	static readonly zero: Decimal = new Decimal(minting, finiteParts(false, 0n, 0), "0")

	/**
	 * Any (negative, coefficient, scale) in, the one form out: trailing zeros of the coefficient are divided away. Refused
	 * outside PostgreSQL's numeric format, judged by the value.
	 */
	static fromParts(
		negative: boolean,
		coefficient: bigint,
		scale: number
	): Result.Result<Decimal, ValueFault> {
		if (typeof negative !== "boolean" || typeof coefficient !== "bigint" || coefficient < 0n) {
			return Result.err("decimalType")
		}
		if (!Number.isInteger(scale) || scale < 0) {
			return Result.err("decimalType")
		}
		if (coefficient === 0n) {
			return Result.ok(Decimal.zero)
		}
		const digits = coefficient.toString()
		const end = zerosDropped(digits, 0, digits.length)
		const dropped = Math.min(digits.length - end, scale)
		return Decimal.#fromSignificant(
			negative,
			digits.slice(0, digits.length - dropped),
			dropped - scale
		)
	}

	/**
	 * The Decimal of an IR decimal value (ir/decimal.ts DecimalValue): a Decimal as it is, and any other value revived from
	 * its canonical payload, which must be exactly a value's one text (fromCanonical). Its parts and its payload are the
	 * caller's, so neither is believed: the Decimal is minted from the checked text alone, and a payload that is no one
	 * text is refused with CompileError MalformedDescription.
	 */
	static fromValue(value: DecimalValue): Decimal {
		if (value instanceof Decimal) {
			return value
		}
		const revived = hostRead(unrevived, () => Decimal.fromCanonical(decimalPayload(value)))
		if (!revived.ok) {
			throw revived.error
		}
		return revived.value
	}

	/**
	 * An int64 count of money's minor units, 10^moneyFractionDigits to the unit: always a numeric, since an int64 has
	 * at most int8Digits digits and a numeric holds far more before its decimal point. A money amount's exact value
	 * (money.ts toDecimal), in its one form.
	 */
	static fromMinorUnits(minorUnits: bigint): Decimal {
		const negative = minorUnits < 0n
		let coefficient = negative ? -minorUnits : minorUnits
		let minScale = moneyFractionDigits.value
		while (minScale > 0 && coefficient % 10n === 0n) {
			coefficient /= 10n
			minScale--
		}
		const parts = finiteParts(negative, coefficient, minScale)
		return new Decimal(
			minting,
			parts,
			finiteDigitsText(parts.negative, coefficient.toString(), minScale)
		)
	}

	/** An integer Decimal. */
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
	 * prefixes and the "inf" abbreviation are refused. Every accepted text means one value, and the Decimal is that
	 * value in its one form: "1.50", "1.5E0" and "15e-1" are one Decimal, written "1.5". Its text is written from the
	 * significant digits the input already holds, with no bigint-to-decimal conversion.
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
		const point = text.startsWith(".", intEnd)
		const fracEnd = point ? digitsEnd(text, intEnd + 1) : intEnd
		const fractionLength = point ? fracEnd - intEnd - 1 : 0
		if (intEnd === intStart && fractionLength === 0) {
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
		const all = point
			? text.slice(intStart, intEnd) + text.slice(intEnd + 1, fracEnd)
			: text.slice(intStart, intEnd)
		let lead = 0
		while (lead < all.length && all.charCodeAt(lead) === 0x30) {
			lead++
		}
		if (lead === all.length) {
			return Result.ok(Decimal.zero)
		}
		const end = zerosDropped(all, lead, all.length)
		const exponent = written.value.value - fractionLength + (all.length - end)
		return Decimal.#fromSignificant(negative, all.slice(lead, end), exponent)
	}

	/**
	 * The Decimal whose numeric_out text is `text`, trusted: a column's output, NaN, Infinity, -Infinity, or an optional
	 * minus sign, integer digits and an optional fraction. Nothing is checked. Trailing fractional zeros, and a then bare
	 * point, are dropped; the rest is the text, so a padded spelling decodes to its value's one form.
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
		if (point < 0) {
			return new Decimal(minting, finiteParts(negative, BigInt(text.slice(start)), 0), text)
		}
		const end = zerosDropped(text, point + 1, text.length)
		if (end === point + 1) {
			const integer = text.slice(0, point)
			return new Decimal(
				minting,
				finiteParts(negative, BigInt(text.slice(start, point)), 0),
				integer
			)
		}
		const coefficient = BigInt(text.slice(start, point) + text.slice(point + 1, end))
		const parts = finiteParts(negative, coefficient, end - point - 1)
		return new Decimal(minting, parts, end === text.length ? text : text.slice(0, end))
	}

	/**
	 * The literal boundary: a Decimal as is, a bigint, or an exact decimal string. A
	 * JavaScript number is refused, because it has already rounded to binary64. Reading the caller's value can run its
	 * code (instanceof runs a proxy's getPrototypeOf trap), so it is read once through hostRead, and a value whose
	 * reading throws is refused as no Decimal; `admit` and `of` read through here.
	 */
	static parse(input: unknown): Result.Result<Decimal, ValueFault> {
		return hostRead(notDecimal, (): Result.Result<Decimal, ValueFault> => {
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

	/** The reviver for the canonical tag "d": exactly the one text `toString` writes, and nothing else. */
	static fromCanonical(payload: string): Result.Result<Decimal, CompileError> {
		const parsed = Decimal.fromString(payload)
		if (!parsed.ok) {
			return Result.err(faultError(parsed.error, SourceLoc("canonical Decimal", [])))
		}
		if (parsed.value.text !== payload) {
			return Result.err(
				malformedDescription(
					SourceLoc("canonical Decimal", []),
					"the one text of a Decimal, numeric_out of trim_scale(value)"
				)
			)
		}
		return Result.ok(parsed.value)
	}

	isNaN(): boolean {
		return this.parts.kind === "nan"
	}

	isFinite(): this is FiniteDecimal {
		return this.parts.kind === "finite"
	}

	isInfinite(): boolean {
		return this.parts.kind === "infinity" || this.parts.kind === "-infinity"
	}

	isZero(): boolean {
		return this.parts.kind === "finite" && this.parts.coefficient === 0n
	}

	/** The value's one text: numeric_out of trim_scale(value), "NaN", "Infinity" or "-Infinity". */
	toString(): string {
		return this.text
	}

	/**
	 * PostgreSQL's numeric comparison (cmp_numerics): -Infinity < every finite value < +Infinity < NaN, NaN = NaN,
	 * and finite values by value.
	 */
	compare(that: Decimal): -1 | 0 | 1 {
		return compareDecimal(this, that)
	}

	/** Numeric equality, which for the one form is identity of the texts. */
	equals(that: Decimal): boolean {
		return this.text === that.text
	}

	[canonicalTag](): TaggedValue {
		return { tag: decimalTag, payload: this.text }
	}
}

const kindRank = (parts: DecimalParts): 0 | 1 | 2 | 3 => {
	switch (parts.kind) {
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
	const x = a.parts
	const y = b.parts
	if (x.kind !== "finite" || y.kind !== "finite") {
		const rx = kindRank(x)
		const ry = kindRank(y)
		return rx === ry ? 0 : rx < ry ? -1 : 1
	}
	if (x.negative !== y.negative) {
		return x.negative ? -1 : 1
	}
	const scale = Math.max(x.minScale, y.minScale)
	const mx = x.coefficient * pow10(scale - x.minScale)
	const my = y.coefficient * pow10(scale - y.minScale)
	if (mx === my) {
		return 0
	}
	return mx < my === x.negative ? 1 : -1
}

/**
 * A finite Decimal as a signed integer count of 10^-scale units, rounded half away from zero: round(d * 10^scale).
 * `scale` may be negative. This is the rounding of PostgreSQL's round_var and of its numeric-to-integer casts.
 */
export const roundedUnits = (d: FiniteDecimal, scale: number): bigint => {
	const { negative, coefficient, minScale } = d.parts
	const magnitude =
		scale >= minScale
			? coefficient * pow10(scale - minScale)
			: roundHalfAway(coefficient, minScale - scale)
	return negative ? -magnitude : magnitude
}

const isInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value)

/**
 * numerictypmodin's rule over the precision and scale a JavaScript caller passes: precision 1..numericMaxPrecision,
 * scale numericMinScale..numericMaxScale, both integers and both given. null, like every other non-integer, is refused.
 * This is the one check: a NumericTypmod is checked, so normalizeNumeric takes one as it is.
 */
export const checkNumericTypmod = (
	precision: unknown,
	scale: unknown
): Result.Result<NumericTypmod, ValueFault> => {
	if (!isInteger(precision) || precision < 1 || precision > numericMaxPrecision.value) {
		return Result.err("numericTypmod")
	}
	if (!isInteger(scale) || scale < numericMinScale.value || scale > numericMaxScale.value) {
		return Result.err("numericTypmod")
	}
	return Result.ok({ precision, scale: scale === 0 ? 0 : scale })
}

/**
 * The value a numeric(p, s) column stores for `d`, as apply_typmod and apply_typmod_special compute it, in its one
 * form: NaN unchanged; infinity refused (numericInfinity); otherwise rounded half away from zero to scale s, and
 * refused when the rounded magnitude is at least 10^(p - s) (numericOverflow, SQLSTATE 22003 in PostgreSQL). Without a
 * typmod, a computed numeric's, the value is numeric's own, which every Decimal already is. This is PostgreSQL's
 * coercion of a value it computes or a literal it casts; a caller's value is parsed exactly instead (parseNumeric).
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
	return scale >= 0
		? Decimal.fromParts(units < 0n, magnitude, scale)
		: Decimal.fromParts(units < 0n, magnitude * pow10(-scale), 0)
}

/**
 * The count of 10^-scale units `d` is exactly, or undefined where it is no whole count: a value with more fractional
 * digits than a nonnegative scale, or, at a negative scale, one that is no multiple of 10^-scale.
 */
const exactUnits = (d: FiniteDecimal, scale: number): bigint | undefined => {
	const { negative, coefficient, minScale } = d.parts
	if (scale >= minScale) {
		const magnitude = coefficient * pow10(scale - minScale)
		return negative ? -magnitude : magnitude
	}
	const divisor = pow10(minScale - scale)
	if (coefficient % divisor !== 0n) {
		return undefined
	}
	const magnitude = coefficient / divisor
	return negative ? -magnitude : magnitude
}

/**
 * A caller's numeric parsed exactly at its typmod: the value itself, already in its one form, where a numeric(p, s)
 * holds it unchanged; never rounded. NaN passes; infinity is refused (numericInfinity), a value of more fractional digits
 * than s, or at a negative s no multiple of 10^-s, is refused (numericScale) where PostgreSQL's coercion would round it
 * (normalizeNumeric), and one of 10^(p - s) or more in magnitude is refused (numericOverflow). Without a typmod every
 * Decimal is numeric's own value.
 */
export const parseNumeric = (
	d: Decimal,
	typmod: NumericTypmod | undefined
): Result.Result<Decimal, ValueFault> => {
	if (typmod === undefined) {
		return Result.ok(d)
	}
	if (!d.isFinite()) {
		return d.isNaN() ? Result.ok(d) : Result.err("numericInfinity")
	}
	const units = exactUnits(d, typmod.scale)
	if (units === undefined) {
		return Result.err("numericScale")
	}
	const magnitude = units < 0n ? -units : units
	return magnitude >= pow10(typmod.precision) ? Result.err("numericOverflow") : Result.ok(d)
}
