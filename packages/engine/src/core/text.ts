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
