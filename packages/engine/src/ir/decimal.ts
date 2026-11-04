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

/**
 * A finite numeric value in its one form: (-1)^negative · coefficient · 10^-minScale, where minScale is the least
 * scale that writes the value exactly (PostgreSQL's min_scale).
 */
export interface FiniteParts {
	readonly kind: "finite"
	/** False for zero: numeric has no signed zero. */
	readonly negative: boolean
	/** Not a multiple of 10 when minScale > 0; 0n only at minScale 0. */
	readonly coefficient: bigint
	/** 0..16383. */
	readonly minScale: number
}

/** A numeric value: NaN, an infinity, or a finite value in its one form. */
export type DecimalParts =
	| FiniteParts
	| { readonly kind: "nan" }
	| { readonly kind: "infinity" }
	| { readonly kind: "-infinity" }

/**
 * The IR's decimal: DecimalText or scalar/values' owned Decimal, both in the one form. The IR holds a numeric literal
 * as one (ir/expr.ts TypedLiteral), and either spells its canonical text from its parts.
 */
export type DecimalValue = Canonicalizable & { readonly parts: DecimalParts }

export const nanParts: DecimalParts = Object.freeze({ kind: "nan" })
export const infinityParts: DecimalParts = Object.freeze({ kind: "infinity" })
export const negativeInfinityParts: DecimalParts = Object.freeze({ kind: "-infinity" })

/**
 * The text of a finite value in its one form, PostgreSQL's numeric_out of trim_scale(value): `digits` are the
 * coefficient's decimal digits, written with minScale fractional digits and no exponent.
 */
export const finiteDigitsText = (negative: boolean, digits: string, minScale: number): string => {
	const sign = negative ? "-" : ""
	if (minScale === 0) {
		return sign + digits
	}
	const padded = digits.padStart(minScale + 1, "0")
	const point = padded.length - minScale
	return `${sign}${padded.slice(0, point)}.${padded.slice(point)}`
}

/** The text of a finite value's parts in its one form. */
export const finiteDecimalText = (parts: FiniteParts): string =>
	finiteDigitsText(parts.negative, parts.coefficient.toString(), parts.minScale)

/** The one text of a decimal value: numeric_out of trim_scale(value), NaN, Infinity or -Infinity. */
export const decimalPartsText = (parts: DecimalParts): string => {
	switch (parts.kind) {
		case "nan":
			return "NaN"
		case "infinity":
			return "Infinity"
		case "-infinity":
			return "-Infinity"
		case "finite":
			return finiteDecimalText(parts)
	}
}

export const isDecimalPayload = (text: string): boolean => DecimalText.parse(text) !== undefined

/**
 * Exact decimal values at the Description boundary and in the IR.
 *
 * A numeric literal is a Decimal, a bigint, or an exact decimal string, never a JavaScript number. The IR holds a
 * decimal parsed (DecimalValue), so the owned Decimal of scalar/values travels through it unchanged; in canonical text
 * it is "~d:<the value's one text>". This module owns only what the boundary needs: the payload syntax it admits and a
 * minimal carrier, DecimalText, that a decode parses its payload into when no richer reviver is supplied. DecimalText
 * does no arithmetic and no rounding.
 *
 * The admitted payload is the value's one text, numeric_out of trim_scale(value): a decimal value has exactly one
 * payload, so equal values fingerprint alike and fingerprints stay byte-stable. "1.50" is no payload; "1.5" is. This
 * is exactly the text scalar/values' Decimal writes and its reviver accepts.
 */
export class DecimalText implements Canonicalizable {
	readonly parts: DecimalParts
	readonly text: string

	private constructor(parts: DecimalParts, text: string) {
		this.parts = parts
		this.text = text
		Object.freeze(this)
	}

	static make(text: string): Result.Result<DecimalText, CompileError> {
		const parsed = DecimalText.parse(text)
		return parsed === undefined
			? Result.err(
					malformedDescription(
						SourceLoc("decimal literal", []),
						"the one text of a decimal, numeric_out of trim_scale(value): digits with an optional fraction that ends in a nonzero digit, NaN, or Infinity"
					)
				)
			: Result.ok(parsed)
	}

	/**
	 * The decimal `text` spells when it is a decimal's one text, else undefined: an optional '-', the integer digits
	 * with no leading zero (a lone 0 when the integer part is zero), an optional '.' followed by fractional digits whose
	 * last is not 0, no exponent and no negative zero; or one of NaN, Infinity and -Infinity.
	 */
	static parse(text: string): DecimalText | undefined {
		switch (text) {
			case "NaN":
				return new DecimalText(nanParts, text)
			case "Infinity":
				return new DecimalText(infinityParts, text)
			case "-Infinity":
				return new DecimalText(negativeInfinityParts, text)
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
			if (i === fracStart || text[i - 1] === "0") {
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
		const parts: FiniteParts = Object.freeze({
			kind: "finite",
			negative,
			coefficient,
			minScale: i - fracStart
		})
		return new DecimalText(parts, text)
	}

	[canonicalTag](): TaggedValue {
		return { tag: decimalTag, payload: this.text }
	}

	toString(): string {
		return this.text
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
