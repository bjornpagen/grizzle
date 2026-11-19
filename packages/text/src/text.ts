/**
 * Text as PostgreSQL's C.UTF-8 contract and XML read it, one implementation of each rule for grizzle and every
 * program beside it: a text's code points and their order, PostgreSQL's translate and ASCII case fold, and XML's
 * whiteSpace replace and collapse. Every function here reads strings alone, imports nothing and runs wherever
 * JavaScript does, a browser included.
 *
 * Equality is exact Unicode scalar sequence equality and ordering is code point order, as pg_catalog.pg_c_utf8
 * compares. There is no normalization, case folding or locale. JavaScript's default string order compares UTF-16 code
 * units, which disagrees with code point order exactly when a supplementary-plane scalar (a surrogate pair, units
 * U+D800-U+DFFF) meets a BMP scalar in U+E000-U+FFFF. Over well-formed strings, `compareCodePoints` repairs that one
 * case at the first differing unit, which is code point order and also UTF-8 byte order.
 */

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
 * The code point of a text that starts at code unit `i`, below the text's length, as string iteration reads it: a
 * surrogate pair is one supplementary code point, and a lone surrogate is a code point of its own. It spans two code
 * units past U+FFFF (codePointUnits), one otherwise. Read by code unit, so a reader steps through a text allocating
 * nothing.
 */
export const codePointAt = (text: string, i: number): number => {
	const unit = text.charCodeAt(i)
	const next = text.charCodeAt(i + 1)
	return unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
		? (unit - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000
		: unit
}

/** The code units a code point spans in a text: two past U+FFFF, a surrogate pair, and one otherwise. */
export const codePointUnits = (point: number): 1 | 2 => (point > 0xffff ? 2 : 1)

/** The code points of a text in order (codePointAt). */
export const codePoints = (text: string): ReadonlyArray<number> => {
	const out: Array<number> = []
	for (let i = 0; i < text.length;) {
		const point = codePointAt(text, i)
		out.push(point)
		i += codePointUnits(point)
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

/**
 * PostgreSQL's translate(text, from, to) over any three texts, by code points: a character of text that occurs in from
 * becomes the character of to at the position of its first occurrence there, or nothing where to has no character at
 * that position, and every other character stays.
 */
export const translated = (text: string, from: string, to: string): string => {
	const sources = codePoints(from)
	const targets = codePoints(to)
	const first = new Map<number, number>()
	for (const [i, source] of sources.entries()) {
		if (!first.has(source)) {
			first.set(source, i)
		}
	}
	const out: Array<number> = []
	for (const c of codePoints(text)) {
		const at = first.get(c)
		const target = at === undefined ? c : targets[at]
		if (target !== undefined) {
			out.push(target)
		}
	}
	return codePointsText(out)
}

/**
 * ASCII's case fold, Compute.lowerAscii: each capital, A to Z, to its small letter, the code point 0x20 above it, as
 * PostgreSQL's pg_ascii_tolower folds it, and every other character itself.
 */
export const asciiFold: ReadonlyMap<number, number> = new Map(
	codePoints("ABCDEFGHIJKLMNOPQRSTUVWXYZ").map((capital) => [capital, capital + 0x20] as const)
)

/** A text's ASCII case fold (asciiFold), code point by code point: each capital its small letter, every other kept. */
export const asciiLowered = (text: string): string =>
	codePointsText(codePoints(text).map((c) => asciiFold.get(c) ?? c))

/** The four characters XML calls white space, `S ::= (#x20 | #x9 | #xD | #xA)+` (XML 1.0, §2.3): tab, LF, CR and space. */
export const xmlWhitespace: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0d, 0x20])

/**
 * XML Schema's whiteSpace `replace` as translate's map (XML Schema 1.0 Part 2, §4.3.6): "All occurrences of #x9 (tab),
 * #xA (line feed) and #xD (carriage return) are replaced with #x20 (space)", each one character for one, so a replaced
 * text has its length in code points.
 */
export const replaceMap = Object.freeze({ from: "\t\n\r", to: "   " })

/** whiteSpace replace of a text (replaceMap): each tab, line feed and carriage return a space, every other kept. */
export const replaced = (text: string): string => translated(text, replaceMap.from, replaceMap.to)

/**
 * The text without the XML whitespace at either end, its inner whitespace as it stands: what a value sheds before a
 * typed reading of it (an identifier, a number, a boolean) where its type's whiteSpace is collapse and its lexical
 * space holds no space, so collapsing it and trimming it are one text. Linear in the text, stepping in from each end
 * once.
 */
export const trimmed = (text: string): string => {
	let start = 0
	let end = text.length
	while (start < end && xmlWhitespace.has(text.charCodeAt(start))) {
		start += 1
	}
	while (end > start && xmlWhitespace.has(text.charCodeAt(end - 1))) {
		end -= 1
	}
	return text.slice(start, end)
}

/**
 * whiteSpace collapse of a text, by code points (XML Schema 1.0 Part 2, §4.3.6): each run of white space between two
 * other characters is one space, and a run at either end is nothing. No other character is white space to it: a
 * no-break space, an ideographic space or a byte order mark stays.
 */
export const collapsed = (text: string): string => {
	const out: Array<number> = []
	let spaced = false
	for (const c of codePoints(text)) {
		if (xmlWhitespace.has(c)) {
			spaced = out.length > 0
			continue
		}
		if (spaced) {
			out.push(0x20)
			spaced = false
		}
		out.push(c)
	}
	return codePointsText(out)
}
