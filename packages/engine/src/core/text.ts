import { compareCodePoints } from "@bjornpagen/grizzle-text/text"
import { isWellFormedText, type WellFormedText } from "@bjornpagen/grizzle-text/utf8"
import type { ValueFault } from "#compiler/core/errors.ts"
import { defect } from "#compiler/core/invariant.ts"
import * as Result from "#compiler/core/result.ts"

/**
 * Storable text: what PostgreSQL text can hold, and the orders of texts that spell lists of them, under the fixed
 * C.UTF-8 contract whose code points and order are @bjornpagen/grizzle-text's (text.ts).
 *
 * At every input boundary NUL and unpaired UTF-16 surrogates are refused, never replaced: PostgreSQL text cannot hold
 * U+0000, and a lone surrogate is no Unicode scalar, so a UTF-8 encoder would silently substitute U+FFFD for it. A
 * declared name is storable text too (ir/desc.ts), so the rule lives below every layer that states one.
 *
 * A text value: a string with no NUL and no unpaired surrogate, so a well-formed one (grizzle-text WellFormedText).
 */
export const validateText = (value: unknown): Result.Result<WellFormedText, ValueFault> => {
	if (typeof value !== "string") {
		return Result.err("textType")
	}
	if (value.includes("\u0000")) {
		return Result.err("textNul")
	}
	if (!isWellFormedText(value)) {
		return Result.err("textSurrogate")
	}
	return Result.ok(value)
}

export const isValidText = (value: unknown): value is WellFormedText => validateText(value).ok

/**
 * A text grizzle holds, proved well-formed (grizzle-text WellFormedText) by grizzle-text's one proof of a text's form
 * (isWellFormedText) where it becomes bytes: an admitted text's parameter text, a text PostgreSQL or a file gave, or one
 * grizzle composes of those and its own (a fingerprint's frame, an identity's canonical form, a statement, a function's
 * source, a JSON body). Every such text is admitted, decoded or composed of such parts, so one that is not well-formed
 * is a defect.
 */
export const wellFormed = (text: string): WellFormedText => {
	if (!isWellFormedText(text)) {
		throw defect("a text grizzle holds is well-formed")
	}
	return text
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
	for (let i = 0; i < a.length; i += 1) {
		const x = a[i]
		const y = b[i]
		if (x === undefined || y === undefined) {
			return y === undefined ? 1 : -1
		}
		if (x === y) {
			continue
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
		if (a === b) {
			return 0
		}
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
		for (let i = 0; i < a.length; i += 1) {
			const x = a[i]
			const y = b[i]
			if (x === undefined || y === undefined) {
				return y === undefined ? -1 : 1
			}
			const order = quoted(x, y)
			if (order !== 0) {
				return order
			}
		}
		return a.length < b.length ? 1 : 0
	}
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

/**
 * PostgreSQL's quoted identifier of a name: double quotes around it, each `"` in it doubled, so case and reserved words
 * never matter. The one quoting of an identifier, which the SQL printer (sql/print.ts), the replication protocol's
 * commands (live/replication.ts) and every other spelling of a name read.
 */
export const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`

/** A standard-conforming string literal: single quotes around it, only the single quote special, each one doubled. */
export const quoteString = (value: string): string => `'${value.replaceAll("'", "''")}'`
