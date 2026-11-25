import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { quoteString } from "#compiler/core/text.ts"
import { lexemesOf } from "#compiler/sql/lexer.ts"

/**
 * The characters a text tool may read as a line ending, or rewrite, and their backslash escapes: what a drafted
 * migration file never holds inside a constant (deploy/render/filed.ts), and what the drift report shows by name.
 *
 * Python's universal newlines read a carriage return as a line feed, git's eol conversion and many editors rewrite line
 * endings, and an editor may strip or flag a control character or a Unicode line separator. Each would change the value
 * of a constant a file spells with it raw, so none is written raw there.
 */

/** The four hex digits of a `\uXXXX` escape. @formatConstant PostgreSQL's E'' Unicode escape: \u and four hex digits */
const unicodeEscapeDigits = 4

/**
 * Whether a UTF-16 code unit is a character a text tool may rewrite: Unicode's controls (category Cc, U+0000 to U+001F
 * and U+007F to U+009F) and its line and paragraph separators (U+2028, U+2029).
 */
export const isUnfiled = (unit: number): boolean =>
	unit < 0x20 || (unit >= 0x7f && unit <= 0x9f) || unit === 0x2028 || unit === 0x2029

/**
 * The escape of a backslash or of a character isUnfiled holds, as PostgreSQL's escape strings read it (E'', sql-syntax
 * 4.1.2.2): a backslash doubled, \b \t \n \f \r by name, and any other as \uXXXX, which reads in every database grizzle
 * installs into, each UTF-8 (pg_c_utf8); none for any other character, which stands as itself.
 */
const escapeOf = (unit: number): string | undefined => {
	switch (unit) {
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
			return isUnfiled(unit)
				? `\\u${unit.toString(16).toUpperCase().padStart(unicodeEscapeDigits, "0")}`
				: undefined
	}
}

/**
 * `text` with each backslash doubled and each character isUnfiled holds escaped (escapeOf): an escape string's content
 * before its quotes are doubled, and a text as the drift report shows it, in which no character is invisible and no
 * escape reads as a character the text holds.
 */
export const escaped = (text: string): string => {
	let out = ""
	let from = 0
	for (let k = 0; k < text.length; k++) {
		const escape = escapeOf(text.charCodeAt(k))
		if (escape !== undefined) {
			out += text.slice(from, k) + escape
			from = k + 1
		}
	}
	return from === 0 ? text : out + text.slice(from)
}

/** What each named escape escapedValue reads stands for, as escapeOf writes it. */
const namedEscapes: ReadonlyMap<string, string> = new Map([
	["\\", "\\"],
	["b", "\b"],
	["t", "\t"],
	["n", "\n"],
	["f", "\f"],
	["r", "\r"]
])

/**
 * The value of an escape string's content, its quotes undoubled and its pieces joined as the lexer reads them
 * (sql/lexer.ts, a `string` lexeme prefixed E): each escape escapeOf writes read back, a backslash doubled, \b \t \n \f
 * \r by name and \uXXXX by its code unit, the inverse of `escaped`. An escape grizzle never writes is a defect, since
 * only a text grizzle printed is read so.
 */
export const escapedValue = (content: string): string => {
	let out = ""
	let from = 0
	let k = content.indexOf("\\")
	while (k !== -1) {
		out += content.slice(from, k)
		const name = content.charAt(k + 1)
		const named = namedEscapes.get(name)
		if (named !== undefined) {
			out += named
			from = k + 2
		} else if (name === "u") {
			const digits = content.slice(k + 2, k + 2 + unicodeEscapeDigits)
			const unit = Number.parseInt(digits, 16)
			if (escapeOf(unit) !== `\\u${digits}`) {
				throw defect(
					`an escape string grizzle wrote holds the escape \\u${digits}, which it never writes`
				)
			}
			out += String.fromCharCode(unit)
			from = k + 2 + unicodeEscapeDigits
		} else {
			throw defect(
				`an escape string grizzle wrote holds the escape \\${name}, which it never writes`
			)
		}
		k = content.indexOf("\\", from)
	}
	return from === 0 ? content : out + content.slice(from)
}

/** One piece of an escape string: `value` escaped (escaped) and its quotes doubled, between quotes. */
export const escapedPiece = (value: string): string => quoteString(escaped(value))

/** The escape string of `value`, E'<value>' on one line, which PostgreSQL parses into the constant `value`. */
export const escapeString = (value: string): string => `E${escapedPiece(value)}`

/**
 * `text` with each standard string constant whose value holds a line feed spelled as its escape string (escapeString),
 * so no line of `text` ends inside a constant; every other lexeme, and everything between lexemes, stands as it is. A
 * text whose every string constant holds no line feed is itself.
 */
export const lineFeedsEscaped = (text: string): string => {
	let out = ""
	let from = 0
	for (const lexeme of lexemesOf(text).lexemes) {
		if (lexeme.kind === "string" && lexeme.prefix === undefined && lexeme.text.includes("\n")) {
			out += text.slice(from, lexeme.start) + escapeString(lexeme.text)
			from = lexeme.end
		}
	}
	return from === 0 ? text : out + text.slice(from)
}

/**
 * The UTF-16 code units of context a difference is shown with on either side of where it begins.
 *
 * @formatConstant a drift report's window: 60 code units before and after the first difference
 */
const differenceContext = 60

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff

/** The characters (code points) of a well-formed text's first `units` code units: every unit but a low surrogate. */
const charactersIn = (text: string, units: number): number => {
	let n = 0
	for (let k = 0; k < units; k++) {
		n += isLowSurrogate(text.charCodeAt(k)) ? 0 : 1
	}
	return n
}

/** The code units two texts share before their first difference, never ending inside a surrogate pair. */
const sharedPrefix = (a: string, b: string): number => {
	const n = Math.min(a.length, b.length)
	let d = 0
	while (d < n && a.charCodeAt(d) === b.charCodeAt(d)) {
		d += 1
	}
	return d > 0 && isHighSurrogate(a.charCodeAt(d - 1)) ? d - 1 : d
}

/** `text` from `from` to `to`, code units widened to whole surrogate pairs, escaped, with an ellipsis where it is cut. */
const window = (text: string, from: number, to: number): string => {
	const start = from > 0 && isLowSurrogate(text.charCodeAt(from)) ? from - 1 : from
	const end = Math.min(
		text.length,
		to < text.length && isHighSurrogate(text.charCodeAt(to - 1)) ? to + 1 : to
	)
	return `${start > 0 ? "…" : ""}${escaped(text.slice(start, end))}${end < text.length ? "…" : ""}`
}

/** Two different texts by where they part: the character they first differ at, 1-based, each one's characters, and
 * each shown escaped (escaped) from differenceContext code units before it to as many after. */
export interface DifferenceShown {
	readonly at: number
	readonly characters: { readonly first: number; readonly second: number }
	readonly first: string
	readonly second: string
}

export const differenceShown = (first: string, second: string): DifferenceShown => {
	const d = sharedPrefix(first, second)
	const from = Math.max(0, d - differenceContext)
	return {
		at: charactersIn(first, d) + 1,
		characters: {
			first: charactersIn(first, first.length),
			second: charactersIn(second, second.length)
		},
		first: window(first, from, d + differenceContext),
		second: window(second, from, d + differenceContext)
	}
}
