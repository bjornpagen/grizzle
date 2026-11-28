import * as Result from "@bjornpagen/grizzle-text/base/result"
import { isAsciiDigit } from "@bjornpagen/grizzle-text/text"
import { type Canonicalizable, canonicalTag, type TaggedValue } from "#compiler/core/canonical.ts"
import { int4Max } from "#compiler/core/canonical.ts"
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
import { SourceLoc } from "#compiler/core/loc.ts"
import { isIntegerTypmod } from "#compiler/ir/carriers.ts"
import { type DecimalValue, decimalPayload, decimalTag } from "#compiler/ir/decimal.ts"
import type { NumericBound, NumericTypmod } from "#compiler/ir/scalar.ts"
import {
	numericMaxFractionDigits,
	numericMaxIntegerDigits,
	numericMaxPrecision,
	numericMaxScale,
	numericMinScale
} from "#compiler/scalar/values/fault.ts"
import { faultError } from "#compiler/scalar/values/fault.ts"

/**
 * The fraction digits of money: a money value is a bigint count of minor units, 10^moneyFractionDigits to the unit. It
 * is lc_monetary's frac_digits, and every login pins lc_monetary to C.UTF-8, whose frac_digits is CHAR_MAX, which
 * cash.c replaces with 2 (physical/ddl/roles.ts, admission verifying it).
 *
 * @limitKind published
 * @owner PostgreSQL 19.0 cash.c, lc_monetary C.UTF-8
 * @unit decimal digits
 * @scope the fraction digits of every money value, its input, its output and its casts to and from numeric
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/cash.c#L210-L221
 * @quote frac_digits will be CHAR_MAX in some locales, notably C. [...] fpoint = lconvert->frac_digits; if (fpoint < 0
 *   || fpoint > 10) fpoint = 2;
 * @verified 2026-11-20
 */
export const moneyFractionDigits = 2

/**
 * The greatest exponent magnitude a numeric's text may write: set_var_from_str refuses a greater one before anything
 * else.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit a decimal exponent
 * @scope the exponent of a numeric text a caller writes, `1e5` and `1E-5`
 * @derivation PG_INT32_MAX / 2 in C integer division, numeric.c set_var_from_str
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/numeric.c#L6927, "if (exponent >
 *   PG_INT32_MAX / 2)")
 * @from {@link int4Max}
 */
const maxExponent = Math.trunc(int4Max / 2)

export type { DecimalParts, FiniteParts, NumericBound, NumericTypmod }

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

/** The end of the run of decimal digits of `text` from `start`. */
const digitsEnd = (text: string, start: number): number => {
	let i = start
	while (i < text.length && isAsciiDigit(text.charCodeAt(i))) {
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
		if (magnitude > maxExponent) {
			return Result.err("decimalRange")
		}
	}
	return Result.ok({ value: negative ? -magnitude : magnitude, end })
}

/** A finite Numeric: what `isFinite` proves, its parts the one form of a finite value. */
export type FiniteDecimal = Numeric & { readonly parts: FiniteParts }

const finiteParts = (negative: boolean, coefficient: bigint, minScale: number): FiniteParts =>
	Object.freeze({ kind: "finite", negative: negative && coefficient !== 0n, coefficient, minScale })

/** What a Numeric's parse answers for an input it could not read: no Numeric. */
const notDecimal = (): ValueFault => "decimalType"

/** The refusal of an IR decimal value whose payload could not be read. */
const unrevived = (): CompileError => faultError("decimalType", SourceLoc("Numeric value", []))

/** The key the one mint takes, which no other module holds. */
const minting: unique symbol = Symbol("Numeric")

/**
 * The owned exact Numeric carrier of numeric: a numeric value and nothing else. 1, 1.0 and 1.00
 * are one Numeric, written "1".
 *
 * A Numeric is NaN, +Infinity, -Infinity, or a finite value in its one form (ir/decimal.ts FiniteParts):
 * `(-1)^negative * coefficient / 10^minScale`, where minScale is the least scale that writes the value exactly and zero
 * is never negative. It has no display scale. Every constructor, the decoder of PostgreSQL's output included, yields
 * that form, so two Decimals are `equals` exactly when their parts, their texts and their canonical payloads are
 * identical, and no observation grizzle offers tells equal values apart. Its one text, `text` and `toString`, is
 * PostgreSQL's numeric_out of trim_scale(value), written at construction.
 *
 * Value limits are PostgreSQL's numeric format: at most numericMaxIntegerDigits digits before the decimal point (an
 * int16 weight in base 10000) and at most numericMaxFractionDigits past it (NUMERIC_DSCALE_MAX). Admission is by value:
 * a written scale above numericMaxFractionDigits whose value's minScale fits is admitted as its value, which is never
 * sent as written. Every Numeric satisfies the limits.
 *
 * Declared precision and scale coerce as PostgreSQL's apply_typmod does: round half away from zero to the declared
 * scale, then refuse a value whose rounded magnitude needs more integer digits than precision minus scale, so rounding
 * can cause the overflow. The result is the one form: numeric(5,2) admits 1.2 as 1.2, never 1.20. NaN passes every
 * typmod but numeric(p, 0), whose values are integers (isIntegerTypmod), and infinity passes none
 * (apply_typmod_special).
 *
 * Reading numeric_out text (fromOutput) and writing it (toString) are per-row hot paths: fromOutput scans code units in
 * place and allocates only the digit text BigInt reads, the value, and a slice when the text ends in fractional zeros.
 */
export class Numeric implements Canonicalizable {
	readonly parts: DecimalParts
	/** numeric_out of trim_scale(value): the value's one text, written at construction. */
	readonly text: string
	/** The brand `instanceof Numeric` reads: installed only by the constructor, which only this module can call. */
	readonly #minted = true

	/**
	 * The one mint. It refuses a call without the module's key, so a JavaScript caller that reaches past the private
	 * constructor, a subclass's `super` included, makes no Numeric: every Numeric is one of the checked constructors'
	 * below, its text derived from its parts.
	 */
	private constructor(key: typeof minting, parts: DecimalParts, text: string) {
		if (key !== minting) {
			throw faultError("decimalType", SourceLoc("Numeric constructor", []))
		}
		this.parts = parts
		this.text = text
		Object.freeze(this)
	}

	/**
	 * A Numeric is exactly what this module minted: `instanceof` reads the private brand, which no object built on
	 * Numeric.prototype and no proxy holds, so a forged Numeric is never mistaken for one and runs no code of its own.
	 */
	static [Symbol.hasInstance](value: unknown): value is Numeric {
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
	): Result.Result<Numeric, ValueFault> {
		if (exponent >= 0) {
			if (digits.length + exponent > numericMaxIntegerDigits) {
				return Result.err("decimalRange")
			}
			const text = digits + "0".repeat(exponent)
			const parts = finiteParts(negative, BigInt(digits) * pow10(exponent), 0)
			return Result.ok(new Numeric(minting, parts, negative ? `-${text}` : text))
		}
		const minScale = -exponent
		if (minScale > numericMaxFractionDigits || digits.length - minScale > numericMaxIntegerDigits) {
			return Result.err("decimalRange")
		}
		const parts = finiteParts(negative, BigInt(digits), minScale)
		return Result.ok(new Numeric(minting, parts, finiteDigitsText(negative, digits, minScale)))
	}

	static readonly nan: Numeric = new Numeric(minting, nanParts, "NaN")
	static readonly infinity: Numeric = new Numeric(minting, infinityParts, "Infinity")
	static readonly negativeInfinity: Numeric = new Numeric(
		minting,
		negativeInfinityParts,
		"-Infinity"
	)
	static readonly zero: Numeric = new Numeric(minting, finiteParts(false, 0n, 0), "0")

	/**
	 * Any (negative, coefficient, scale) in, the one form out: trailing zeros of the coefficient are divided away. Refused
	 * outside PostgreSQL's numeric format, judged by the value.
	 */
	static fromParts(
		negative: boolean,
		coefficient: bigint,
		scale: number
	): Result.Result<Numeric, ValueFault> {
		if (typeof negative !== "boolean" || typeof coefficient !== "bigint" || coefficient < 0n) {
			return Result.err("decimalType")
		}
		if (!Number.isInteger(scale) || scale < 0) {
			return Result.err("decimalType")
		}
		if (coefficient === 0n) {
			return Result.ok(Numeric.zero)
		}
		const digits = coefficient.toString()
		const end = zerosDropped(digits, 0, digits.length)
		const dropped = Math.min(digits.length - end, scale)
		return Numeric.#fromSignificant(
			negative,
			digits.slice(0, digits.length - dropped),
			dropped - scale
		)
	}

	/**
	 * The Numeric of an IR decimal value (ir/decimal.ts DecimalValue): a Numeric as it is, and any other value revived from
	 * its canonical payload, which must be exactly a value's one text (fromCanonical). Its parts and its payload are the
	 * caller's, so neither is believed: the Numeric is minted from the checked text alone, and a payload that is no one
	 * text is refused with CompileError MalformedDescription.
	 */
	static fromValue(value: DecimalValue): Numeric {
		if (value instanceof Numeric) {
			return value
		}
		const revived = hostRead(unrevived, () => Numeric.fromCanonical(decimalPayload(value)))
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
	static fromMinorUnits(minorUnits: bigint): Numeric {
		const negative = minorUnits < 0n
		let coefficient = negative ? -minorUnits : minorUnits
		let minScale = moneyFractionDigits
		while (minScale > 0 && coefficient % 10n === 0n) {
			coefficient /= 10n
			minScale--
		}
		const parts = finiteParts(negative, coefficient, minScale)
		return new Numeric(
			minting,
			parts,
			finiteDigitsText(parts.negative, coefficient.toString(), minScale)
		)
	}

	/** An integer Numeric. */
	static fromBigInt(value: bigint): Result.Result<Numeric, ValueFault> {
		if (typeof value !== "bigint") {
			return Result.err("decimalType")
		}
		return Numeric.fromParts(value < 0n, value < 0n ? -value : value, 0)
	}

	/**
	 * Parses an exact decimal literal. The grammar is PostgreSQL's numeric input restricted to its exact decimal
	 * spellings: an optional sign, digits with an optional fraction (".5" and "5." included), and an optional
	 * exponent; or exactly NaN, Infinity, +Infinity or -Infinity. Whitespace, digit-group underscores, non-decimal
	 * prefixes and the "inf" abbreviation are refused. Every accepted text means one value, and the Numeric is that
	 * value in its one form: "1.50", "1.5E0" and "15e-1" are one Numeric, written "1.5". Its text is written from the
	 * significant digits the input already holds, with no bigint-to-decimal conversion.
	 */
	static fromString(text: string): Result.Result<Numeric, ValueFault> {
		if (typeof text !== "string") {
			return Result.err("decimalType")
		}
		switch (text) {
			case "NaN":
				return Result.ok(Numeric.nan)
			case "Infinity":
			case "+Infinity":
				return Result.ok(Numeric.infinity)
			case "-Infinity":
				return Result.ok(Numeric.negativeInfinity)
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
			return Result.ok(Numeric.zero)
		}
		const end = zerosDropped(all, lead, all.length)
		const exponent = written.value.value - fractionLength + (all.length - end)
		return Numeric.#fromSignificant(negative, all.slice(lead, end), exponent)
	}

	/**
	 * The Numeric whose numeric_out text is `text`, trusted: a column's output, NaN, Infinity, -Infinity, or an optional
	 * minus sign, integer digits and an optional fraction. Nothing is checked. Trailing fractional zeros, and a then bare
	 * point, are dropped; the rest is the text, so a padded spelling decodes to its value's one form.
	 */
	static fromOutput(text: string): Numeric {
		switch (text) {
			case "NaN":
				return Numeric.nan
			case "Infinity":
				return Numeric.infinity
			case "-Infinity":
				return Numeric.negativeInfinity
		}
		const negative = text.startsWith("-")
		const start = negative ? 1 : 0
		const point = text.indexOf(".", start)
		if (point < 0) {
			return new Numeric(minting, finiteParts(negative, BigInt(text.slice(start)), 0), text)
		}
		const end = zerosDropped(text, point + 1, text.length)
		if (end === point + 1) {
			const integer = text.slice(0, point)
			return new Numeric(
				minting,
				finiteParts(negative, BigInt(text.slice(start, point)), 0),
				integer
			)
		}
		const coefficient = BigInt(text.slice(start, point) + text.slice(point + 1, end))
		const parts = finiteParts(negative, coefficient, end - point - 1)
		return new Numeric(minting, parts, end === text.length ? text : text.slice(0, end))
	}

	/**
	 * The literal boundary: a Numeric as is, a bigint, or an exact decimal string. A
	 * JavaScript number is refused, because it has already rounded to binary64. Reading the caller's value can run its
	 * code (instanceof runs a proxy's getPrototypeOf trap), so it is read once through hostRead, and a value whose
	 * reading throws is refused as no Numeric; `admit` and `of` read through here.
	 */
	static parse(input: unknown): Result.Result<Numeric, ValueFault> {
		return hostRead(notDecimal, (): Result.Result<Numeric, ValueFault> => {
			if (input instanceof Numeric) {
				return Result.ok(input)
			}
			if (typeof input === "bigint") {
				return Numeric.fromBigInt(input)
			}
			if (typeof input === "string") {
				return Numeric.fromString(input)
			}
			return Result.err(typeof input === "number" ? "decimalNumber" : "decimalType")
		})
	}

	/** The builders' throwing convenience: `parse`, raising CompileError MalformedDescription. */
	static of(input: Numeric | bigint | string): Numeric {
		return Numeric.admit(input)
	}

	/**
	 * The admission core `of` runs, for what a JavaScript caller may pass: `parse`, raising CompileError
	 * MalformedDescription.
	 */
	static admit(input: unknown): Numeric {
		const parsed = Numeric.parse(input)
		if (!parsed.ok) {
			throw faultError(parsed.error, SourceLoc("Numeric literal", []))
		}
		return parsed.value
	}

	/** The reviver for the canonical tag "d": exactly the one text `toString` writes, and nothing else. */
	static fromCanonical(payload: string): Result.Result<Numeric, CompileError> {
		const parsed = Numeric.fromString(payload)
		if (!parsed.ok) {
			return Result.err(faultError(parsed.error, SourceLoc("canonical Numeric", [])))
		}
		if (parsed.value.text !== payload) {
			return Result.err(
				malformedDescription(
					SourceLoc("canonical Numeric", []),
					"the one text of a Numeric, numeric_out of trim_scale(value)"
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
	compare(that: Numeric): -1 | 0 | 1 {
		return compareDecimal(this, that)
	}

	/** Numeric equality, which for the one form is identity of the texts. */
	equals(that: Numeric): boolean {
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

export const compareDecimal = (a: Numeric, b: Numeric): -1 | 0 | 1 => {
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
 * A finite Numeric as a signed integer count of 10^-scale units, rounded half away from zero: round(d * 10^scale).
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
	if (!isInteger(precision) || precision < 1 || precision > numericMaxPrecision) {
		return Result.err("numericTypmod")
	}
	if (!isInteger(scale) || scale < numericMinScale || scale > numericMaxScale) {
		return Result.err("numericTypmod")
	}
	return Result.ok({ precision, scale: scale === 0 ? 0 : scale })
}

/** Whether a count of a typmod's units fits its precision, below 10^p in magnitude, as apply_typmod's check reads it. */
const withinPrecision = (units: bigint, precision: number): boolean =>
	(units < 0n ? -units : units) < pow10(precision)

/**
 * A special value at a typmod: NaN where its column holds it, at every scale but 0, and refused (numericNaN) at an
 * integer typmod (isIntegerTypmod), which no bigint spells; an infinity nowhere (numericInfinity, apply_typmod_special).
 */
const special = (d: Numeric, typmod: NumericTypmod): Result.Result<Numeric, ValueFault> =>
	!d.isNaN()
		? Result.err("numericInfinity")
		: isIntegerTypmod(typmod)
			? Result.err("numericNaN")
			: Result.ok(d)

/**
 * The value a numeric(p, s) column stores for `d`, as apply_typmod and apply_typmod_special compute it, in its one
 * form: NaN unchanged, but refused at scale 0 (numericNaN), whose column holds integers alone (isIntegerTypmod); infinity refused (numericInfinity); otherwise rounded half away from zero to scale
 * s, and refused when the rounded magnitude is at least 10^(p - s) (numericOverflow, SQLSTATE 22003 in PostgreSQL).
 * Without a typmod, a computed numeric's, the value is numeric's own, which every Numeric already is. This is
 * PostgreSQL's coercion of a value it computes or a literal it casts; a caller's value is parsed exactly instead
 * (parseNumeric).
 */
export const normalizeNumeric = (
	d: Numeric,
	typmod: NumericTypmod | undefined
): Result.Result<Numeric, ValueFault> => {
	if (typmod === undefined) {
		return Result.ok(d)
	}
	const { precision, scale } = typmod
	if (!d.isFinite()) {
		return special(d, typmod)
	}
	const units = roundedUnits(d, scale)
	const magnitude = units < 0n ? -units : units
	if (!withinPrecision(units, precision)) {
		return Result.err("numericOverflow")
	}
	return scale >= 0
		? Numeric.fromParts(units < 0n, magnitude, scale)
		: Numeric.fromParts(units < 0n, magnitude * pow10(-scale), 0)
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
 * holds it unchanged; never rounded. NaN passes, but is refused at scale 0 (numericNaN); infinity is refused (numericInfinity), a value of more fractional digits
 * than s, or at a negative s no multiple of 10^-s, is refused (numericScale) where PostgreSQL's coercion would round it
 * (normalizeNumeric), and one of 10^(p - s) or more in magnitude is refused (numericOverflow). Without a typmod every
 * Numeric is numeric's own value.
 */
export const parseNumeric = (
	d: Numeric,
	typmod: NumericTypmod | undefined
): Result.Result<Numeric, ValueFault> => {
	if (typmod === undefined) {
		return Result.ok(d)
	}
	if (!d.isFinite()) {
		return special(d, typmod)
	}
	const units = exactUnits(d, typmod.scale)
	if (units === undefined) {
		return Result.err("numericScale")
	}
	return withinPrecision(units, typmod.precision) ? Result.ok(d) : Result.err("numericOverflow")
}

/**
 * A value of numeric of no typmod within `bound` (ir/scalar.ts NumericBound), a computed numeric's or numeric's at
 * numeric's own limits: itself, NaN and the infinities among them, as numeric of no typmod holds them, and a finite
 * value of at most bound.scale fraction digits below 10^bound.digits in magnitude; any other refused (numericBound),
 * never rounded. Every Numeric is within numeric's own limits, so numeric's bound admits each as it is.
 */
export const withinBound = (
	d: Numeric,
	bound: NumericBound
): Result.Result<Numeric, ValueFault> => {
	const p = d.parts
	if (p.kind !== "finite" || p.coefficient === 0n) {
		return Result.ok(d)
	}
	const integerDigits = p.coefficient.toString().length - p.minScale
	return p.minScale <= bound.scale && integerDigits <= bound.digits
		? Result.ok(d)
		: Result.err("numericBound")
}

/**
 * A computed numeric's bound as a JavaScript caller or a Description states it (numeric.within(digits, scale),
 * ir/desc.ts FieldDesc computedNumeric): both integers, its scale 0..numericMaxFractionDigits and its digits
 * -numericMaxFractionDigits..numericMaxIntegerDigits, as numeric's own format bounds a value, and narrower than
 * numeric's own limits, which numeric is: what the bound refuses, or none.
 */
export const numericBoundRefusal = (digits: unknown, scale: unknown): string | undefined =>
	!isInteger(digits) ||
	!isInteger(scale) ||
	scale < 0 ||
	scale > numericMaxFractionDigits ||
	digits < -numericMaxFractionDigits ||
	digits > numericMaxIntegerDigits
		? `a computed numeric's bound: integer digits -${numericMaxFractionDigits}..${numericMaxIntegerDigits} and a scale 0..${numericMaxFractionDigits}`
		: digits === numericMaxIntegerDigits && scale === numericMaxFractionDigits
			? "a bound narrower than numeric's own limits, which numeric holds"
			: undefined

/** The bigint a finite integer Numeric is; undefined for NaN, an infinity and a value with a fraction. */
export const integerOfDecimal = (d: Numeric): bigint | undefined => {
	const p = d.parts
	return p.kind === "finite" && p.minScale === 0
		? p.negative
			? -p.coefficient
			: p.coefficient
		: undefined
}

/**
 * An integer at an integer typmod (isIntegerTypmod), numeric(p, 0), as its column holds it: the bigint itself, below
 * 10^p in magnitude, or refused past it (numericOverflow), as parseNumeric and normalizeNumeric refuse a Numeric. No
 * bigint has a fraction to round or a NaN to refuse, so a caller's parse and PostgreSQL's coercion of a value it
 * computes are one.
 */
export const integerNumeric = (
	x: bigint,
	typmod: NumericTypmod
): Result.Result<bigint, ValueFault> =>
	withinPrecision(x, typmod.precision) ? Result.ok(x) : Result.err("numericOverflow")
