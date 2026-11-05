import {
	type Canonicalizable,
	canonicalTag,
	isCanonicalizable,
	type TaggedValue,
	taggedValueOf
} from "#compiler/core/canonical.ts"
import {
	type DecimalParts,
	type FiniteParts,
	infinityParts,
	nanParts,
	negativeInfinityParts
} from "#compiler/core/decimal.ts"

export const decimalTag = "d"

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= "0" && ch <= "9"

/**
 * The IR's decimal: DecimalText or scalar/values' owned Decimal, both in the one form. The IR holds a numeric literal
 * as one (ir/expr.ts TypedLiteral), and either spells its canonical text from its parts.
 */
export type DecimalValue = Canonicalizable & { readonly parts: DecimalParts }

export const isDecimalPayload = (text: string): boolean => DecimalText.parse(text) !== undefined

/**
 * Exact decimal values at the Description boundary and in the IR.
 *
 * A numeric literal is a Decimal, a bigint, or an exact decimal string, never a JavaScript number. The IR holds a
 * decimal parsed (DecimalValue), so the owned Decimal of scalar/values travels through it unchanged; in canonical text
 * it is "~d:<the value's one text>". This module owns only what the boundary needs: the payload syntax it admits and a
 * minimal carrier, DecimalText, that a decode parses its payload into. DecimalText does no arithmetic and no rounding.
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
