import {
	type Canonicalizable,
	canonicalTag,
	isCanonicalizable,
	type TaggedValue,
	taggedValueOf
} from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"

export const decimalTag = "d"

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= "0" && ch <= "9"

export type DecimalKind = "finite" | "nan" | "infinity" | "-infinity"

/**
 * A decimal value parsed: NaN, an infinity, or a finite `(-1)^negative * coefficient / 10^scale` with a nonnegative
 * coefficient, a display scale of 0 or more, and zero never negative. The IR holds a numeric literal as one
 * (ir/expr.ts TypedLiteral): DecimalText, or scalar/values' Decimal, which has the same parts; either spells its
 * canonical text from them.
 */
export type DecimalValue = Canonicalizable &
	(
		| {
				readonly kind: "finite"
				readonly negative: boolean
				readonly coefficient: bigint
				readonly scale: number
		  }
		| { readonly kind: "nan" | "infinity" | "-infinity" }
	)

/**
 * The canonical text of a finite decimal's parts, PostgreSQL's numeric_out spelling: the display scale's fractional
 * digits, no exponent.
 */
export const finiteDecimalText = (
	negative: boolean,
	coefficient: bigint,
	scale: number
): string => {
	const sign = negative ? "-" : ""
	const digits = coefficient.toString()
	if (scale === 0) {
		return sign + digits
	}
	const padded = digits.padStart(scale + 1, "0")
	const point = padded.length - scale
	return `${sign}${padded.slice(0, point)}.${padded.slice(point)}`
}

const specialDecimals = {
	NaN: "nan",
	Infinity: "infinity",
	"-Infinity": "-infinity"
} as const

export const isDecimalPayload = (text: string): boolean => DecimalText.parse(text) !== undefined

/**
 * Exact decimal values at the Description boundary and in the IR.
 *
 * A numeric literal is a Decimal, a bigint, or an exact decimal string, never a JavaScript number. The IR holds a
 * decimal parsed (DecimalValue), so the owned Decimal of scalar/values travels through it unchanged; in canonical text
 * it is "~d:<exact text>". This module owns only what the boundary needs: the payload syntax it admits and a minimal
 * carrier, DecimalText, that a decode parses its payload into when no richer reviver is supplied. DecimalText does no
 * arithmetic and no rounding; it spells exactly the payload it was parsed from, so a decimal survives decode and
 * re-encode exactly.
 *
 * The admitted payload is the canonical text, PostgreSQL's numeric_out spelling, so one decimal value with one display
 * scale has exactly one payload and fingerprints stay byte-stable. This is exactly the text scalar/values' Decimal
 * writes and its reviver accepts.
 */
export class DecimalText implements Canonicalizable {
	readonly kind: DecimalKind
	/** Finite values only; false for zero and for the special values. */
	readonly negative: boolean
	/** The unscaled magnitude: the value's digits including `scale` fractional digits. 0n for the special values. */
	readonly coefficient: bigint
	/** The display scale. 0 for the special values. */
	readonly scale: number

	private constructor(kind: DecimalKind, negative: boolean, coefficient: bigint, scale: number) {
		this.kind = kind
		this.negative = negative
		this.coefficient = coefficient
		this.scale = scale
		Object.freeze(this)
	}

	static make(text: string): Result.Result<DecimalText, CompileError> {
		const parsed = DecimalText.parse(text)
		return parsed === undefined
			? Result.err(
					malformedDescription(
						SourceLoc("decimal literal", []),
						"the canonical text of a decimal, as PostgreSQL's numeric output writes it: digits with an optional fraction, NaN, or Infinity"
					)
				)
			: Result.ok(parsed)
	}

	/**
	 * The decimal `text` spells when it is a decimal's canonical text, else undefined: an optional '-', the integer
	 * digits with no leading zero (a lone 0 when the integer part is zero), an optional '.' followed by the display
	 * scale's fractional digits, no exponent and no negative zero; or one of NaN, Infinity and -Infinity.
	 */
	static parse(text: string): DecimalText | undefined {
		if (text === "NaN" || text === "Infinity" || text === "-Infinity") {
			return new DecimalText(specialDecimals[text], false, 0n, 0)
		}
		let i = 0
		const negative = text[i] === "-"
		if (negative) {
			i++
		}
		const intStart = i
		while (isDigit(text[i])) {
			i++
		}
		const intDigits = i - intStart
		if (intDigits === 0 || (intDigits > 1 && text[intStart] === "0")) {
			return undefined
		}
		const intEnd = i
		let fracStart = i
		if (text[i] === ".") {
			i++
			fracStart = i
			while (isDigit(text[i])) {
				i++
			}
			if (i === fracStart) {
				return undefined
			}
		}
		if (i !== text.length) {
			return undefined
		}
		const coefficient = BigInt(text.slice(intStart, intEnd) + text.slice(fracStart, i))
		if (negative && coefficient === 0n) {
			return undefined
		}
		return new DecimalText("finite", negative, coefficient, i - fracStart)
	}

	[canonicalTag](): TaggedValue {
		return { tag: decimalTag, payload: this.toString() }
	}

	toString(): string {
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
}

/** The canonical payload of a decimal-tagged value. */
export const decimalPayload = (value: Canonicalizable): string => value[canonicalTag]().payload

/** Whether a value is a canonical value with the decimal tag: DecimalText, or scalar/values' Decimal. */
export const isDecimalLike = (value: unknown): value is Canonicalizable => {
	const tagged = taggedValueOf(value)
	if (tagged === undefined || !isCanonicalizable(value)) {
		return false
	}
	return tagged.tag === decimalTag && isDecimalPayload(tagged.payload)
}
