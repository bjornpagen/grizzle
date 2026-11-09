import type { ValueFault } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"

/**
 * Storable text and its order: what PostgreSQL text can hold, and how it compares, under the fixed C.UTF-8 contract.
 *
 * At every input boundary NUL and unpaired UTF-16 surrogates are refused, never replaced: PostgreSQL text cannot hold
 * U+0000, and a lone surrogate is no Unicode scalar, so a UTF-8 encoder would silently substitute U+FFFD for it. A
 * declared name is storable text too (ir/desc.ts), so the rule lives below every layer that states one.
 *
 * Equality is exact Unicode scalar sequence equality and ordering is code point order, as pg_catalog.pg_c_utf8
 * compares. There is no normalization, case folding or locale. JavaScript's default string order compares UTF-16 code
 * units, which disagrees with code point order exactly when a supplementary-plane scalar (a surrogate pair, units
 * U+D800-U+DFFF) meets a BMP scalar in U+E000-U+FFFF. Over well-formed strings, `compareCodePoints` repairs that one
 * case at the first differing unit, which is code point order and also UTF-8 byte order.
 *
 * A text value: a string with no NUL and no unpaired surrogate.
 */
export const validateText = (value: unknown): Result.Result<string, ValueFault> => {
	if (typeof value !== "string") {
		return Result.err("textType")
	}
	if (value.includes("\u0000")) {
		return Result.err("textNul")
	}
	if (!value.isWellFormed()) {
		return Result.err("textSurrogate")
	}
	return Result.ok(value)
}

export const isValidText = (value: unknown): value is string => validateText(value).ok

/** Places surrogates (U+D800-U+DFFF) above U+E000-U+FFFF and keeps every other unit's order. */
const codePointRank = (unit: number): number =>
	unit < 0xd800 ? unit : unit >= 0xe000 ? unit - 0x800 : unit + 0x2000

/** Code point order of two well-formed strings: -1, 0 or 1. */
export const compareCodePoints = (a: string, b: string): -1 | 0 | 1 => {
	const n = Math.min(a.length, b.length)
	for (let i = 0; i < n; i++) {
		const x = a.charCodeAt(i)
		const y = b.charCodeAt(i)
		if (x !== y) {
			return codePointRank(x) < codePointRank(y) ? -1 : 1
		}
	}
	return a.length < b.length ? -1 : a.length > b.length ? 1 : 0
}

/**
 * The order of two lists of well-formed texts as each text after its length and a colon would spell them, compared by
 * code point, without spelling them: at the first position they differ, texts of two lengths are ordered by their
 * lengths' decimal spellings, a colon after each, and texts of one length by code point; a list that is the other's
 * prefix is first. No text is ever copied, so the order costs its lists' arity and the units it reads, never a text as
 * long as their sum.
 */
export const compareTextTuples = (
	a: ReadonlyArray<string>,
	b: ReadonlyArray<string>
): -1 | 0 | 1 => {
	for (const [i, x] of a.entries()) {
		const y = b[i]
		if (y === undefined) {
			return 1
		}
		if (x.length !== y.length) {
			return compareCodePoints(`${x.length}:`, `${y.length}:`)
		}
		const order = compareCodePoints(x, y)
		if (order !== 0) {
			return order
		}
	}
	return a.length < b.length ? -1 : 0
}

/**
 * The hex digits of a JSON `\u` escape, as ECMA-262's UnicodeEscape (https://tc39.es/ecma262/#sec-unicodeescape)
 * writes them: "Let hex be the String representation of n, formatted as a lowercase hexadecimal number", then "Return
 * the string-concatenation of the code unit 0x005C (REVERSE SOLIDUS), "u", and StringPad(hex, 4, "0", start)."
 *
 * @formatConstant a JSON \u escape: four lowercase hex digits
 */
const unicodeEscapeDigits = 4

/** The JSON escape of one UTF-16 code unit inside a string literal, none for a unit JSON writes as itself. */
const escapeOf = (unit: number): string | undefined => {
	switch (unit) {
		case 0x22:
			return '\\"'
		case 0x5c:
			return "\\\\"
		case 0x08:
			return "\\b"
		case 0x09:
			return "\\t"
		case 0x0a:
			return "\\n"
		case 0x0c:
			return "\\f"
		case 0x0d:
			return "\\r"
		default:
			return unit < 0x20 ? `\\u${unit.toString(16).padStart(unicodeEscapeDigits, "0")}` : undefined
	}
}

/**
 * What a JSON string literal of `text` holds where `text` holds the unit at `i`: that unit's escape, the unit itself,
 * or, past the text's end, the literal's closing quote.
 */
const quotedAt = (text: string, i: number): string =>
	i >= text.length ? '"' : (escapeOf(text.charCodeAt(i)) ?? text.charAt(i))

/**
 * The order `units` gives two well-formed texts' JSON string literals (JSON.stringify), without spelling them: the
 * literals agree up to the first unit the texts differ at, where each holds that unit's escape, the unit itself, or
 * the closing quote past its text's end. An escape begins with a backslash, which no unescaped unit is, and two escapes
 * differ at their second character or are both `\u00XX`, so neither compared string is a prefix of the other and one
 * comparison decides. `units` is compareCodePoints for code point order, or core/order.ts compareStrings for UTF-16
 * code unit order. A well-formed text holds no lone surrogate, which JSON.stringify would escape.
 */
export const compareQuoted =
	(units: (a: string, b: string) => number) =>
	(a: string, b: string): number => {
		const n = Math.min(a.length, b.length)
		for (let i = 0; i < n; i++) {
			if (a.charCodeAt(i) !== b.charCodeAt(i)) {
				return units(quotedAt(a, i), quotedAt(b, i))
			}
		}
		return a.length === b.length ? 0 : units(quotedAt(a, n), quotedAt(b, n))
	}

/**
 * The order `units` gives two lists of well-formed texts as JSON arrays of string literals (JSON.stringify), without
 * spelling them: element by element in compareQuoted's order, and past a shared prefix the longer list first, as an
 * array that goes on (`,`) is below one that ends (`]`).
 */
export const compareQuotedTuples = (units: (a: string, b: string) => number) => {
	const quoted = compareQuoted(units)
	return (a: ReadonlyArray<string>, b: ReadonlyArray<string>): number => {
		for (const [i, x] of a.entries()) {
			const y = b[i]
			if (y === undefined) {
				return -1
			}
			const order = quoted(x, y)
			if (order !== 0) {
				return order
			}
		}
		return a.length < b.length ? 1 : 0
	}
}

/**
 * The code points of a text in order, as string iteration reads them: a surrogate pair is one supplementary code point,
 * and a lone surrogate is a code point of its own. Read by code unit, so every step has its unit.
 */
export const codePoints = (text: string): ReadonlyArray<number> => {
	const out: Array<number> = []
	for (let i = 0; i < text.length; i++) {
		const unit = text.charCodeAt(i)
		const next = text.charCodeAt(i + 1)
		if (unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
			out.push((unit - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000)
			i++
		} else {
			out.push(unit)
		}
	}
	return out
}

/** The text of `points` in order, each one code point: String.fromCodePoint over a list of any length. */
export const codePointsText = (points: Iterable<number>): string => {
	let text = ""
	for (const point of points) {
		text += String.fromCodePoint(point)
	}
	return text
}

/** Whether a text spells a natural number in decimal with no leading zero ("0" itself included). */
export const isDecimal = (text: string): boolean => {
	if (text === "") {
		return false
	}
	if (text.length > 1 && text.startsWith("0")) {
		return false
	}
	for (const ch of text) {
		if (ch < "0" || ch > "9") {
			return false
		}
	}
	return true
}
