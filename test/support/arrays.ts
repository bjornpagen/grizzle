import { String as Str } from "effect"

/**
 * A one-dimensional text-format array literal read as PostgreSQL's array_in reads it (src/backend/utils/adt/arrayfuncs.c
 * ReadArrayToken), the reference the input arrays' writer (codec/recordset.ts arrayTexts) is checked against: braces
 * around elements separated by commas; a quoted element is its characters with each backslash-escaped character taken
 * as itself, and needs a comma or the closing brace after it, whitespace aside; an unquoted element is its characters
 * with leading and trailing whitespace dropped and backslash escapes taken as quoted ones are, NULL, in any case and
 * unescaped, being no value. A literal that is malformed throws.
 */
export const readArrayLiteral = (literal: string): ReadonlyArray<string | null> => {
	const space = (c: string | undefined): boolean =>
		c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\v" || c === "\f"
	let at = 0
	const skipSpace = (): void => {
		while (space(literal[at])) {
			at += 1
		}
	}
	const fail = (why: string): never => {
		throw new Error(`malformed array literal at ${at}: ${why}`)
	}
	skipSpace()
	if (literal[at] !== "{") {
		fail("no opening brace")
	}
	at += 1
	const out: Array<string | null> = []
	skipSpace()
	if (literal[at] === "}") {
		at += 1
		skipSpace()
		return at === literal.length ? out : fail("text after the closing brace")
	}
	for (;;) {
		skipSpace()
		if (literal[at] === '"') {
			at += 1
			let element = ""
			for (;;) {
				const c = literal[at]
				if (c === undefined) {
					return fail("an unterminated quoted element")
				}
				if (c === "\\") {
					const next = literal[at + 1]
					if (next === undefined) {
						return fail("a backslash at the end")
					}
					element += next
					at += 2
					continue
				}
				if (c === '"') {
					at += 1
					break
				}
				element += c
				at += 1
			}
			out.push(element)
		} else {
			let element = ""
			let escaped = false
			let kept = 0
			for (;;) {
				const c = literal[at]
				if (c === undefined) {
					return fail("an unterminated element")
				}
				if (c === "," || c === "}") {
					break
				}
				if (c === '"' || c === "{") {
					return fail("a quote or brace inside an unquoted element")
				}
				if (c === "\\") {
					const next = literal[at + 1]
					if (next === undefined) {
						return fail("a backslash at the end")
					}
					element += next
					escaped = true
					at += 2
					kept = element.length
					continue
				}
				element += c
				at += 1
				if (!space(c)) {
					kept = element.length
				}
			}
			const trimmed = Str.slice(0, kept)(element)
			if (trimmed === "" && !escaped) {
				return fail("an empty unquoted element")
			}
			out.push(!escaped && Str.toUpperCase(trimmed) === "NULL" ? null : trimmed)
		}
		skipSpace()
		const c = literal[at]
		at += 1
		if (c === "}") {
			skipSpace()
			return at === literal.length ? out : fail("text after the closing brace")
		}
		if (c !== ",") {
			return fail("no comma or closing brace after an element")
		}
	}
}
