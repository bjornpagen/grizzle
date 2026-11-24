/**
 * Text as PostgreSQL's C.UTF-8 contract and XML read it, one implementation of each rule for grizzle and every
 * program beside it: a text's code points and their order, PostgreSQL's translate and ASCII case fold, a text cut at
 * the first of a set of characters, and XML's whiteSpace replace and collapse and a list's tokens. Every function here reads strings alone, imports nothing and
 * runs wherever JavaScript does, a browser included.
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

/**
 * Whether a code unit is an ASCII decimal digit, 0 to 9: the one digit test of every reader of decimal numerals. A
 * text's unit past its end, NaN, is none.
 */
export const isAsciiDigit = (unit: number): boolean => unit >= 0x30 && unit <= 0x39

/**
 * Whether every code unit of `text` from `start` to `end` is an ASCII decimal digit (isAsciiDigit): an empty range is,
 * holding none.
 */
export const isAsciiDigits = (text: string, start: number, end: number): boolean => {
	for (let i = start; i < end; i++) {
		if (!isAsciiDigit(text.charCodeAt(i))) {
			return false
		}
	}
	return true
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
 * ASCII's case fold, Text.lowerAscii: each capital, A to Z, to its small letter, the code point 0x20 above it, as
 * PostgreSQL's pg_ascii_tolower folds it, and every other character itself.
 */
export const asciiFold: ReadonlyMap<number, number> = new Map(
	codePoints("ABCDEFGHIJKLMNOPQRSTUVWXYZ").map((capital) => [capital, capital + 0x20] as const)
)

/** A text's ASCII case fold (asciiFold), code point by code point: each capital its small letter, every other kept. */
export const asciiLowered = (text: string): string =>
	codePointsText(codePoints(text).map((c) => asciiFold.get(c) ?? c))

/**
 * The four characters XML calls white space, `S ::= (#x20 | #x9 | #xD | #xA)+` (XML 1.0, §2.3): tab, LF, CR and space.
 * Each is one code unit and none a surrogate, so a text read by code unit meets each where a reading by code point
 * would, and every whiteSpace facet and list split below reads a text by code unit, allocating nothing per character.
 */
export const xmlWhitespace: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0d, 0x20])

/** The last of XML's white space, U+0020: a code unit above it is read as no white space by one comparison. */
const lastWhitespace = Array.from(xmlWhitespace).reduce((last, c) => Math.max(last, c), 0)

/** Whether a code unit is one of XML's white space (xmlWhitespace). */
const isWhitespaceUnit = (unit: number): boolean =>
	unit <= lastWhitespace && xmlWhitespace.has(unit)

/**
 * XML Schema's whiteSpace `replace` as translate's map (XML Schema 1.0 Part 2, §4.3.6): "All occurrences of #x9 (tab),
 * #xA (line feed) and #xD (carriage return) are replaced with #x20 (space)", each one character for one, so a replaced
 * text has its length in code points.
 */
export const replaceMap = Object.freeze({ from: "\t\n\r", to: "   " })

/** The characters replaceMap replaces, in its order. */
const replacedCharacters: ReadonlyArray<string> = Array.from(replaceMap.from)

/**
 * Where a character next stands in a text at or after `from`, by the engine's own search: its index, or the text's
 * length where it stands nowhere after, the end being where every search stops.
 */
const nextOf = (text: string, character: string, from: number): number => {
	const at = text.indexOf(character, from)
	return at === -1 ? text.length : at
}

/** A character replaceMap replaces and where it next stands in the text being replaced. */
interface Cursor {
	readonly character: string
	at: number
}

/** The first place any cursor stands, the text's length when none stands before it. */
const earliest = (cursors: ReadonlyArray<Cursor>, end: number): number =>
	cursors.reduce((least, cursor) => Math.min(least, cursor.at), end)

/**
 * whiteSpace replace of a text (replaceMap): each tab, line feed and carriage return a space, every other kept,
 * translate's answer by its map. Each character of the map is found by the engine's own search, once and again after
 * each place it stands, so no stretch between two replaced characters is read in JavaScript, and the text between
 * them is copied as one slice.
 */
export const replaced = (text: string): string => {
	const cursors = replacedCharacters.map((character): Cursor => ({
		character,
		at: nextOf(text, character, 0)
	}))
	let out = ""
	let from = 0
	for (
		let at = earliest(cursors, text.length);
		at < text.length;
		at = earliest(cursors, text.length)
	) {
		out += `${text.slice(from, at)} `
		from = at + 1
		for (const cursor of cursors) {
			if (cursor.at === at) {
				cursor.at = nextOf(text, cursor.character, from)
			}
		}
	}
	return out + text.slice(from)
}

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
 * whiteSpace collapse of a text (XML Schema 1.0 Part 2, §4.3.6): each run of white space between two other characters
 * is one space, and a run at either end is nothing. No other character is white space to it: a no-break space, an
 * ideographic space or a byte order mark stays. The text is trimmed, so every run left has a character after it, and
 * read by code unit; a run that is one space is already collapsed and stays where it stands, so only a run that
 * changes ends a slice, and a text none of whose runs changes is its trimmed text.
 */
export const collapsed = (text: string): string => {
	const inner = trimmed(text)
	let out = ""
	let from = 0
	for (let i = 0; i < inner.length; i++) {
		const unit = inner.charCodeAt(i)
		if (!isWhitespaceUnit(unit)) {
			continue
		}
		let end = i + 1
		while (isWhitespaceUnit(inner.charCodeAt(end))) {
			end += 1
		}
		if (unit !== 0x20 || end > i + 1) {
			out += `${inner.slice(from, i)} `
			from = end
		}
		i = end - 1
	}
	return out + inner.slice(from)
}

/**
 * The tokens of a whitespace-separated list, XML Schema's list lexical space (XML Schema 1.0 Part 2, §4.3.6, a list's
 * whiteSpace collapse, its items separated by spaces): the runs of no white space in the text, in order, none of a
 * blank text. Read by code unit, the text's end read as one more space, so its last token ends there as any other does.
 */
export const tokens = (text: string): ReadonlyArray<string> => {
	const out: Array<string> = []
	let from = 0
	for (let i = 0; i <= text.length; i++) {
		if (i === text.length || isWhitespaceUnit(text.charCodeAt(i))) {
			if (i > from) {
				out.push(text.slice(from, i))
			}
			from = i + 1
		}
	}
	return out
}

/**
 * The code unit where `text`'s first code point among `chars`' stands, by code point, as PostgreSQL's strpos reads a
 * text: undefined where it holds none of them, `chars` holding none among them too. Each character of `chars` is one
 * member of the set, a repeat none more.
 */
const firstAmong = (text: string, chars: string): number | undefined => {
	const set = new Set(codePoints(chars))
	for (let i = 0; i < text.length;) {
		const point = codePointAt(text, i)
		if (set.has(point)) {
			return i
		}
		i += codePointUnits(point)
	}
	return undefined
}

/**
 * `text` before its first character among `chars`, all of it where it holds none: Text.cutBefore, whose cut at
 * `cutFrom` gives `text` back, `cutBefore(t, c) + cutFrom(t, c) === t`.
 */
export const cutBefore = (text: string, chars: string): string =>
	text.slice(0, firstAmong(text, chars) ?? text.length)

/**
 * `text` from its first character among `chars` on, that character included, the empty text where it holds none:
 * Text.cutFrom, the rest of `cutBefore`'s cut.
 */
export const cutFrom = (text: string, chars: string): string =>
	text.slice(firstAmong(text, chars) ?? text.length)
