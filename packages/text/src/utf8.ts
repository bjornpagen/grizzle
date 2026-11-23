/**
 * UTF-8, the one codec of text and its bytes for grizzle and every program beside it: a well-formed text's bytes
 * (`WellFormedText`, which no lone surrogate is, so its UTF-8 is defined) and a text's byte length, and the one reader
 * of bytes as text (oxlint.config.ts refuses a TextDecoder anywhere else), which spells exactly the text the bytes hold. A
 * malformed sequence is refused, never replaced by U+FFFD (`fatal`), and a byte order mark is a character of the text,
 * never stripped (`ignoreBOM`). U+FEFF is a scalar like any other, which a stored text, a JSON body or a token may begin
 * with, and a TextDecoder's defaults would drop it from the start of every decode, so the text read would be another
 * value than the one the bytes hold. Its one encoder, `writeUtf8`, writes a text's bytes in place, where its caller
 * counted them (`utf8Length`, by the same rule), so a text written into a larger array is copied from nowhere; its one
 * writer of a text piece by piece as bytes, `Utf8Writer`, writes each piece, a JSON value's text among them, by it into
 * one buffer, so no text of the pieces is built. It imports nothing and runs wherever JavaScript does, a browser
 * included: the CLI generator carries it into every package it emits as the generated runtime's UTF-8 codec
 * (packages/cli-generator/src/emit/runtime.ts), where no other module of grizzle-text is.
 */

declare const wellFormedBrand: unique symbol

/**
 * A text of Unicode scalar values alone, no lone surrogate: a text UTF-8 writes (`writeUtf8`) and every text a decode
 * of UTF-8 reads (`utf8Text`). Minted only here: by `isWellFormedText`, the one check of a text's form, which a boundary
 * that admits a text, or holds one TypeScript cannot prove, reads; and, unchecked, where the making of a text is its
 * proof: the strict decoder's every text, JSON.stringify's (`jsonText`) and a text written of well-formed pieces
 * (`WellFormedWriter`).
 */
export type WellFormedText = string & { readonly [wellFormedBrand]: true }

/** Whether a text is well-formed (`WellFormedText`): it holds no lone surrogate. */
export const isWellFormedText = (text: string): text is WellFormedText => text.isWellFormed()

/** A text well-formed by how it was made (`WellFormedText`): read by the strict decoder, written by JSON.stringify, or
 * written of well-formed pieces. Unchecked: each of its callers is the proof. */
const proved: (text: string) => asserts text is WellFormedText = () => undefined

/**
 * A well-formed text written piece by piece, each piece well-formed, so the whole is, since no piece ends with a high
 * surrogate or begins with a low one, so no seam pairs or parts a surrogate: appended in place, never joined anew at
 * each piece. Unchecked: the pieces are the proof.
 */
export class WellFormedWriter {
	#text = ""

	/** How many UTF-16 code units the text holds so far. */
	get length(): number {
		return this.#text.length
	}

	append(piece: WellFormedText): void {
		this.#text += piece
	}

	/** The text written so far. */
	text(): WellFormedText {
		const text = this.#text
		proved(text)
		return text
	}
}

/**
 * A JSON value (RFC 8259): what JSON text spells, and nothing it cannot. An object member that may be absent is
 * optional, never `undefined`, so a value of this type has exactly one text.
 */
export type Json =
	| null
	| boolean
	| number
	| string
	| ReadonlyArray<Json>
	| { readonly [member: string]: Json }

/**
 * The JSON text of a value, JSON.stringify's, compact, each object's members in the value's own order: the one door
 * every JSON text grizzle and its packages write from a value of their own goes through. Well-formed, since
 * JSON.stringify writes a lone surrogate as its \u escape (ECMA-262 QuoteJSONString, well-formed JSON.stringify), and
 * every other text it writes as it is. Unchecked: JSON.stringify is the proof.
 */
export const jsonText = (value: Json): WellFormedText => {
	const text = JSON.stringify(value)
	proved(text)
	return text
}

/** Whether a code unit is a high surrogate, the first of a pair. */
const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff

/** Whether a code unit is a low surrogate, the second of a pair; NaN, past a text's end, is none. */
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff

/** How many bytes UTF-8 writes one code point in: a code unit's sequence, or a surrogate pair's. */
type Width = 1 | 2 | 3 | 4

/**
 * How many bytes the code point at code unit `at` of `text` takes, the one rule `utf8Length` counts by and `writeUtf8`
 * writes by: one below U+0080, two below U+0800, four for a surrogate pair, which takes the unit after it too, and three
 * for any other unit, a lone surrogate's among them, the three bytes of the U+FFFD an encoder writes in its place.
 */
const widthAt = (text: string, at: number): Width => {
	const unit = text.charCodeAt(at)
	return unit < 0x80
		? 1
		: unit < 0x800
			? 2
			: isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(at + 1))
				? 4
				: 3
}

/** How many code units a code point of `width` bytes takes: a surrogate pair's two, any other one. */
const unitsOf = (width: Width): 1 | 2 => (width === 4 ? 2 : 1)

/**
 * The UTF-8 byte length of a text, as `writeUtf8` writes a well-formed one, counted from its code units without writing
 * it (`widthAt`), a lone surrogate counting three bytes.
 */
export const utf8Length = (text: string): number => {
	const length = text.length
	let bytes = 0
	for (let at = 0; at < length;) {
		if (text.charCodeAt(at) < 0x80) {
			bytes += 1
			at += 1
			continue
		}
		const width = widthAt(text, at)
		bytes += width
		at += unitsOf(width)
	}
	return bytes
}

/**
 * How many code units of a text, from its start, UTF-8 writes in at most `bytes` bytes, whole code points alone (`widthAt`):
 * the longest start of the text no longer than that, which parts no surrogate pair.
 */
export const unitsWithin = (text: string, bytes: number): number => {
	let used = 0
	let at = 0
	while (at < text.length) {
		const width = widthAt(text, at)
		if (used + width > bytes) {
			return at
		}
		used += width
		at += unitsOf(width)
	}
	return at
}

/**
 * Writes the code point at code unit `i` of `text`, of `width` bytes (`widthAt`), into `out` from `to`: the one spelling
 * of a code point's UTF-8, which `writeUtf8` and the JSON writer (`Utf8Writer.jsonString`) write by.
 */
const writePoint = (out: Uint8Array, to: number, text: string, i: number, width: Width): void => {
	const unit = text.charCodeAt(i)
	switch (width) {
		case 1:
			out[to] = unit
			return
		case 2:
			out[to] = 0xc0 | (unit >> 6)
			out[to + 1] = 0x80 | (unit & 0x3f)
			return
		case 3:
			out[to] = 0xe0 | (unit >> 12)
			out[to + 1] = 0x80 | ((unit >> 6) & 0x3f)
			out[to + 2] = 0x80 | (unit & 0x3f)
			return
		case 4: {
			const point = ((unit - 0xd800) << 10) + (text.charCodeAt(i + 1) - 0xdc00) + 0x10000
			out[to] = 0xf0 | (point >> 18)
			out[to + 1] = 0x80 | ((point >> 12) & 0x3f)
			out[to + 2] = 0x80 | ((point >> 6) & 0x3f)
			out[to + 3] = 0x80 | (point & 0x3f)
			return
		}
	}
}

/**
 * The one encoder of text as bytes: writes a well-formed text's UTF-8 into `out` from `at`, each code point's bytes in
 * place, as many as `widthAt` gives it (writePoint), and answers the position past its last byte, `at` plus its
 * utf8Length, which `out` holds from `at` (its caller counted them): exactly the platform's UTF-8 (TextEncoder). A lone
 * surrogate, which has no UTF-8, is no WellFormedText, so it never reaches here.
 */
export const writeUtf8 = (out: Uint8Array, at: number, text: WellFormedText): number => {
	const length = text.length
	let to = at
	for (let i = 0; i < length;) {
		const unit = text.charCodeAt(i)
		if (unit < 0x80) {
			out[to] = unit
			to += 1
			i += 1
			continue
		}
		const width = widthAt(text, i)
		writePoint(out, to, text, i, width)
		to += width
		i += unitsOf(width)
	}
	return to
}

/** A well-formed text's bytes, the ones SHA-256 hashes for it: its UTF-8 (`writeUtf8`), in an array of their own. */
export const utf8 = (text: WellFormedText): Uint8Array => {
	const out = new Uint8Array(utf8Length(text))
	writeUtf8(out, 0, text)
	return out
}

/**
 * What a `Utf8Writer` does with a piece that does not fit in its buffer: `grow` the buffer, every byte kept until the
 * end (a text decoded whole); or `drain` it into `into` first, once it holds `chunk` bytes (a hash, which reads its
 * message in pieces), so the buffer holds no more than a chunk and the piece being written, whatever the length of all
 * it writes. A drained view is read at once: the writer writes over it next.
 */
export type Overflow =
	| { readonly kind: "grow" }
	| { readonly kind: "drain"; readonly chunk: number; readonly into: (bytes: Uint8Array) => void }

/**
 * The most bytes one code unit of a JSON string literal takes (`Utf8Writer.jsonString`): a control character's
 * escape, \u00XX, the longest of a unit above ASCII's three bytes, a pair's four for two units, and an ASCII unit's one
 * or two.
 *
 * @formatConstant a JSON \u escape: six characters, all ASCII
 */
const jsonUnitMaxBytes = 6

/**
 * The most bytes one code unit of a text's UTF-8 takes (`writeUtf8`): a unit of the Basic Multilingual Plane's three,
 * a surrogate pair's four for its two units.
 *
 * @formatConstant UTF-8: three bytes a code unit of the Basic Multilingual Plane
 */
const utf8UnitMaxBytes = 3

/**
 * The hex digits of a JSON `\u` escape, as ECMA-262's UnicodeEscape (https://tc39.es/ecma262/#sec-unicodeescape)
 * writes them: "Let hex be the String representation of n, formatted as a lowercase hexadecimal number", then "Return
 * the string-concatenation of the code unit 0x005C (REVERSE SOLIDUS), "u", and StringPad(hex, 4, "0", start)."
 *
 * @formatConstant a JSON \u escape: four lowercase hex digits
 */
const unicodeEscapeDigits = 4

/** A code unit's JSON `\u` escape (ECMA-262 UnicodeEscape): a control's, and a lone surrogate's. */
const unicodeEscape = (unit: number): string =>
	`\\u${unit.toString(16).padStart(unicodeEscapeDigits, "0")}`

/**
 * The escape JSON.stringify writes each unit it escapes by (ECMA-262 QuoteJSONString): the quotation mark's and the
 * reverse solidus's, the five controls' two-character escapes, and every other control's `\u` escape.
 */
const escapedUnit = (unit: number): string | undefined => {
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
			return unit < 0x20 ? unicodeEscape(unit) : undefined
	}
}

/** The escape of each ASCII code unit, by unit: none for a unit JSON writes as itself. */
const asciiEscapes: ReadonlyArray<string | undefined> = Array.from({ length: 0x80 }, (_, unit) =>
	escapedUnit(unit)
)

/**
 * The JSON escape of one UTF-16 code unit inside a string literal, as JSON.stringify writes it (escapedUnit), read from
 * the escapes made once as the module loads, so no escape is spelled again for each unit; none for a unit JSON writes
 * as itself, a surrogate among them, which is escaped only where it is lone (Utf8Writer.jsonString). The one spelling
 * of JSON's escapes: the writer's, and the order of two literals without their texts (engine core/text.ts
 * compareQuoted).
 */
export const jsonEscape = (unit: number): string | undefined =>
	unit < 0x80 ? asciiEscapes[unit] : undefined

/** An ASCII text's bytes written into `out` from `to`, one a code unit, and the position past them. */
const writeAscii = (out: Uint8Array, to: number, text: string): number => {
	for (let i = 0; i < text.length; i++) {
		out[to + i] = text.charCodeAt(i)
	}
	return to + text.length
}

/** The buffer a writer begins with, which holds nothing, so its first piece grows it: one for every writer. */
const noBytes = new Uint8Array(0)

/**
 * Text written as UTF-8 into one byte buffer, piece by piece, each piece's bytes written in place once, with no string
 * built: a well-formed text's (`writeUtf8`), and a JSON value's as `jsonText` spells it, a string's literal escaped
 * and encoded in the one pass over its code units, a safe integer's digits written from its value. A full buffer
 * grows to twice what it must hold, its bytes copied whole, or is drained (`Overflow`). It counts the UTF-16 code
 * units of the text it has written (`units`), which is what V8's longest string bounds.
 */
export class Utf8Writer {
	#bytes = noBytes
	/** Where the next byte goes: how many bytes the buffer holds since it was last drained. */
	#at = 0
	/** How many bytes were drained before. */
	#drained = 0
	/** How many UTF-16 code units the text written so far holds. */
	#units = 0
	readonly #overflow: Overflow

	constructor(overflow: Overflow) {
		this.#overflow = overflow
	}

	/** How many UTF-16 code units the text written so far holds. */
	get units(): number {
		return this.#units
	}

	/** How many bytes were written so far, drained or held. */
	get length(): number {
		return this.#drained + this.#at
	}

	/** How many bytes the buffer can hold: the most it ever held at once, since it never shrinks. */
	get capacity(): number {
		return this.#bytes.length
	}

	/** The bytes held since the buffer was last drained, a view the next write writes over: every byte, when it grows. */
	held(): Uint8Array {
		return this.#bytes.subarray(0, this.#at)
	}

	/** The bytes held passed to `into`, and the buffer emptied for what is written next, its capacity kept. */
	drain(into: (bytes: Uint8Array) => void): void {
		into(this.held())
		this.clear()
	}

	/**
	 * The buffer emptied for what is written next, its capacity kept, the bytes it held counted as drained: what `drain`
	 * leaves, for a caller that read them (`held`) before.
	 */
	clear(): void {
		this.#drained += this.#at
		this.#at = 0
	}

	/** A well-formed text's UTF-8 (`writeUtf8`). */
	text(text: WellFormedText): void {
		this.#reserve(text.length * utf8UnitMaxBytes)
		this.#at = writeUtf8(this.#bytes, this.#at, text)
		this.#units += text.length
	}

	/**
	 * Bytes a writer wrote before, a text's UTF-8 of `units` UTF-16 code units, copied as they are: a template's piece
	 * (core/canonical.ts writeTemplate).
	 */
	encoded(bytes: Uint8Array, units: number): void {
		this.#reserve(bytes.length)
		this.#bytes.set(bytes, this.#at)
		this.#at += bytes.length
		this.#units += units
	}

	/** An ASCII text's bytes, one a code unit: JSON's punctuation, literals and a number's text. */
	ascii(text: string): void {
		this.#reserve(text.length)
		this.#at = writeAscii(this.#bytes, this.#at, text)
		this.#units += text.length
	}

	/**
	 * The UTF-8 of `jsonText(text)`, a string's JSON literal, in one pass over its code units: each unit JSON escapes by
	 * its escape (`jsonEscape`), a lone surrogate by its `\u` escape, as JSON.stringify writes each (ECMA-262
	 * QuoteJSONString), and every other code point as its UTF-8 (`writePoint`).
	 */
	jsonString(text: string): void {
		const length = text.length
		this.#reserve(length * jsonUnitMaxBytes + 2)
		const out = this.#bytes
		let to = this.#at
		/** How many more UTF-16 code units the literal holds than the text and its quotation marks: its escapes'. */
		let escaped = 0
		out[to] = 0x22
		to += 1
		for (let i = 0; i < length; i++) {
			const unit = text.charCodeAt(i)
			if (unit < 0x80) {
				const escape = jsonEscape(unit)
				if (escape === undefined) {
					out[to] = unit
					to += 1
					continue
				}
				to = writeAscii(out, to, escape)
				escaped += escape.length - 1
				continue
			}
			const width = widthAt(text, i)
			if (width === 3 && unit >= 0xd800 && unit <= 0xdfff) {
				const escape = unicodeEscape(unit)
				to = writeAscii(out, to, escape)
				escaped += escape.length - 1
				continue
			}
			writePoint(out, to, text, i, width)
			to += width
			i += unitsOf(width) - 1
		}
		out[to] = 0x22
		to += 1
		this.#at = to
		this.#units += length + 2 + escaped
	}

	/**
	 * The text of `jsonText(x)` of a number, a safe integer's digits written from its value (0 for -0, as JSON writes
	 * it), any other number's text, which is ASCII, written as it is.
	 */
	jsonNumber(x: number): void {
		if (!Number.isSafeInteger(x)) {
			this.ascii(jsonText(x))
			return
		}
		let magnitude = x < 0 ? -x : x
		let digits = 1
		for (let rest = magnitude; rest >= 10; rest = (rest - (rest % 10)) / 10) {
			digits += 1
		}
		const sign = x < 0 ? 1 : 0
		this.#reserve(sign + digits)
		const out = this.#bytes
		if (sign === 1) {
			out[this.#at] = 0x2d
		}
		const end = this.#at + sign + digits
		for (let to = end - 1; to >= this.#at + sign; to--) {
			const digit = magnitude % 10
			out[to] = 0x30 + digit
			magnitude = (magnitude - digit) / 10
		}
		this.#at = end
		this.#units += sign + digits
	}

	/** Room for `bytes` more bytes: the buffer drained first where it holds a chunk, and grown where they still do not fit. */
	#reserve(bytes: number): void {
		if (this.#at + bytes <= this.#bytes.length) {
			return
		}
		const overflow = this.#overflow
		if (overflow.kind === "drain" && this.#at > 0 && this.#at + bytes > overflow.chunk) {
			this.drain(overflow.into)
			if (bytes <= this.#bytes.length) {
				return
			}
		}
		const doubled = 2 * Math.max(this.#bytes.length, this.#at + bytes)
		const grown = new Uint8Array(
			Math.max(
				this.#at + bytes,
				overflow.kind === "drain" ? Math.min(doubled, overflow.chunk) : doubled
			)
		)
		grown.set(this.#bytes)
		this.#bytes = grown
	}
}

/** A decoder that refuses a malformed sequence and keeps a byte order mark (see the header). */
const strict = (): TextDecoder => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** What `decode` reads, a well-formed text (`proved`), or undefined where it refused the bytes: the TypeError a fatal
 * decoder throws is its one signal. */
const readWith = (decode: () => string): WellFormedText | undefined => {
	try {
		const text = decode()
		proved(text)
		return text
	} catch {
		return undefined
	}
}

/** The decoder of whole texts: a decode that is not streamed starts afresh, so one serves every call. */
const whole = strict()

/** The text `bytes` spell in UTF-8, every byte read as it is; undefined where they are no UTF-8. */
export const utf8Text = (bytes: Uint8Array): WellFormedText | undefined =>
	readWith(() => whole.decode(bytes))

/**
 * A reader of UTF-8 text that arrives in chunks: each chunk's text, a sequence a chunk boundary cuts carried into the
 * next chunk, and the end, which refuses a sequence the last chunk left cut. Where the bytes are cut changes nothing it
 * reads.
 */
export interface Utf8Chunks {
	readonly chunk: (bytes: Uint8Array) => WellFormedText | undefined
	readonly end: () => WellFormedText | undefined
}

/** A reader of chunked UTF-8 text from its first byte (Utf8Chunks), with a decoder of its own. */
export const utf8Chunks = (): Utf8Chunks => {
	const decoder = strict()
	return {
		chunk: (bytes) => readWith(() => decoder.decode(bytes, { stream: true })),
		end: () => readWith(() => decoder.decode())
	}
}
