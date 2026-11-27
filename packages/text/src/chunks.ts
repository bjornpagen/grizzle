/**
 * A text held as its chunks, never joined: the one form of every text grizzle writes to a file and reads back from one
 * (an artifact's: a served file, an OpenAPI document, snapshot.json, manifest.json, meta.json, a migration's SQL), so no
 * string as long as a whole artifact is ever built, encoded or decoded. V8 builds a string in one allocation, and a text
 * written piece by piece is a rope that its first read flattens into one: edullm's qti generate died flattening a served
 * file's rope as it wrote it, its live heap a quarter of the cap, where no contiguous allocation that long was left.
 *
 * A chunk is a well-formed text of at most `chunkUnits` UTF-16 code units, cut where no surrogate pair parts, so each
 * chunk's UTF-8 is its own and the chunks' encodings together are the text's. Chunks are minted only by a `ChunkWriter`,
 * which a producer writes its pieces into, or by cutting a text already built (`chunksOf`); a reader reads them one at a
 * time: their bytes (`chunkBytes`), a comparison of those bytes with a file's as it is read (`ByteMatch`), a view the
 * SQL lexer reads as it reads a string (`ChunkView`), and their JSON value (`readJson`). Where a reader's unit is longer
 * than a chunk (a token, a statement, a JSON string), it builds that unit alone, never the text around it.
 */
import { defect, defined } from "#text/base/invariant.ts"
import * as Result from "#text/base/result.ts"
import { isWellFormedText, unitsWithin, utf8, utf8Length, type WellFormedText } from "#text/utf8.ts"

declare const chunksBrand: unique symbol

/** A text as its well-formed chunks (see the header), in order, none empty, each at most `chunkUnits` code units. */
export type TextChunks = ReadonlyArray<WellFormedText> & { readonly [chunksBrand]: true }

/** Chunks made by a writer or a cut (see the header). Unchecked: their making is the proof. */
const minted: (chunks: ReadonlyArray<WellFormedText>) => asserts chunks is TextChunks = () =>
	undefined

/**
 * How many UTF-16 code units a chunk holds at most: Node's default high-water mark of a byte stream, the run a file
 * stream of Node's own writes at, so a chunk's encoding is at most three times it.
 *
 * @limitKind published
 * @owner Node.js 26.13.0 stream
 * @unit UTF-16 code units of a chunk (TextChunks)
 * @scope each chunk of a text written to or read from a file
 * @constraint documented default
 * @source https://nodejs.org/docs/v26.13.0/api/stream.html#streamgetdefaulthighwatermarkobjectmode
 * @quote Returns the default highWaterMark used by streams. Defaults to `65536` (64 KiB), or `16` for `objectMode`.
 * @verified 2026-11-22
 */
export const chunkUnits = 65_536

/** Whether a code unit is a high surrogate, the first of a pair. */
const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff

/**
 * Where a cut of `text` at most at `at` leaves no surrogate pair parted: `at`, or one before it where the unit before
 * `at` is a pair's first half.
 */
const pairSafe = (text: string, at: number): number =>
	at < text.length && isHighSurrogate(text.charCodeAt(at - 1)) ? at - 1 : at

/**
 * The part of a well-formed text between two cuts where no pair parts, or the pieces of one chunk joined: well-formed,
 * which the check proves (isWellFormedText), so a cut placed wrong is a defect here and never a malformed chunk.
 */
const wellFormedChunk = (text: string): WellFormedText => {
	if (!isWellFormedText(text)) {
		defect("a chunk cut where no surrogate pair parts is well-formed")
	}
	return text
}

/**
 * A writer of a text as its chunks (TextChunks): each piece appended in order, the chunk being written sealed once it
 * holds `chunkUnits` code units, a piece longer than the room left cut where no pair parts, so no chunk passes the
 * bound and the text is never joined. A chunk of several pieces is joined from them as it is sealed, a join no longer
 * than a chunk, so each sealed chunk is one flat string and no piece's own string outlives its chunk.
 */
export class ChunkWriter {
	readonly #sealed: Array<WellFormedText> = []
	/** The pieces of the chunk being written, and their code units. */
	#open: Array<string> = []
	#openUnits = 0
	/** How many code units the text holds so far. */
	#length = 0

	/** How many UTF-16 code units the text holds so far. */
	get length(): number {
		return this.#length
	}

	append(piece: WellFormedText): void {
		this.#length += piece.length
		let at = 0
		while (piece.length - at > chunkUnits - this.#openUnits) {
			const end = pairSafe(piece, at + chunkUnits - this.#openUnits)
			if (end > at) {
				this.#open.push(piece.slice(at, end))
				this.#openUnits += end - at
			}
			this.#seal()
			at = end
		}
		if (at < piece.length) {
			this.#open.push(at === 0 ? piece : piece.slice(at))
			this.#openUnits += piece.length - at
		}
	}

	/** The text written, as its chunks: the chunk being written sealed last. The writer is spent. */
	chunks(): TextChunks {
		this.#seal()
		const chunks = this.#sealed
		minted(chunks)
		return chunks
	}

	/** The chunk being written sealed, when it holds anything: its pieces joined, at most a chunk long. */
	#seal(): void {
		if (this.#openUnits === 0) {
			return
		}
		const [only] = this.#open
		this.#sealed.push(
			wellFormedChunk(
				this.#open.length === 1 ? defined(only, "a chunk's piece") : this.#open.join("")
			)
		)
		this.#open = []
		this.#openUnits = 0
	}
}

/** A text already built, as its chunks: cut where no pair parts, each a part of the text, nothing joined. */
export const chunksOf = (text: WellFormedText): TextChunks => {
	const chunks: Array<WellFormedText> = []
	for (let at = 0; at < text.length;) {
		const end = pairSafe(text, Math.min(text.length, at + chunkUnits))
		chunks.push(wellFormedChunk(at === 0 && end === text.length ? text : text.slice(at, end)))
		at = end
	}
	minted(chunks)
	return chunks
}

/** How many UTF-16 code units a text's chunks hold together. */
export const chunksLength = (chunks: TextChunks): number => {
	let units = 0
	for (const chunk of chunks) {
		units += chunk.length
	}
	return units
}

/** A place in a list of pieces: the piece, and how many of its code units come before it. */
interface PieceCut {
	readonly piece: number
	readonly at: number
}

/**
 * The last place in `pieces` that ends `seam`, a run of line feeds, read across the pieces' seams, or none: the place
 * after its last line feed, so the text before it ends in `seam` and is never empty.
 */
const lastEnding = (pieces: ReadonlyArray<string>, seam: "\n\n" | "\n"): PieceCut | undefined => {
	for (let i = pieces.length - 1; i >= 0; i -= 1) {
		const piece = defined(pieces[i], "a piece of a part")
		const at = piece.lastIndexOf(seam)
		if (at >= 0) {
			return { piece: i, at: at + seam.length }
		}
		const before = pieces[i - 1]
		if (seam === "\n\n" && before?.endsWith("\n") === true && piece.startsWith("\n")) {
			return { piece: i, at: 1 }
		}
	}
	return undefined
}

/**
 * The texts a text is laid out in when no one of them may be longer than `bound` bytes of UTF-8, each a run of the text,
 * in order, together the text (`joinedParts` gives it back), each but the last as long as it can be within the bound and
 * ending at the text's coarsest joint within it: after a blank line, where a drafted file's statements and comments part;
 * else after a line, where a JSON file's members and items part; else, in a line longer than the bound, after the last
 * whole code point within it. A text within the bound is one part, itself; the empty text is one empty part. The cuts
 * are the text's alone, so one text is laid out alike every time. `bound` is at least four, a code point's longest UTF-8,
 * so every part holds one.
 */
export const partsOf = (text: TextChunks, bound: number): ReadonlyArray<TextChunks> => {
	if (bound < 4) {
		defect("a part's bound holds a code point's longest UTF-8")
	}
	const parts: Array<TextChunks> = []
	const pending: Array<string> = [...text].toReversed()
	let part: Array<string> = []
	let bytes = 0
	const close = (pieces: ReadonlyArray<string>): void => {
		const chunks = pieces.filter((p) => p.length > 0).map(wellFormedChunk)
		minted(chunks)
		parts.push(chunks)
	}
	for (let piece = pending.pop(); piece !== undefined; piece = pending.pop()) {
		const size = utf8Length(piece)
		if (bytes + size <= bound) {
			part.push(piece)
			bytes += size
			continue
		}
		const fit = unitsWithin(piece, bound - bytes)
		const pieces = [...part, piece.slice(0, fit)]
		const cut = lastEnding(pieces, "\n\n") ?? lastEnding(pieces, "\n")
		const kept =
			cut === undefined
				? pieces
				: [
						...pieces.slice(0, cut.piece),
						defined(pieces[cut.piece], "the piece a part ends in").slice(0, cut.at)
					]
		const carried =
			cut === undefined
				? []
				: [
						defined(pieces[cut.piece], "the piece a part ends in").slice(cut.at),
						...pieces.slice(cut.piece + 1)
					].filter((p) => p.length > 0)
		close(kept)
		pending.push(piece.slice(fit))
		for (const p of carried.toReversed()) {
			pending.push(p)
		}
		part = []
		bytes = 0
	}
	close(part)
	return parts
}

/** A text's parts (`partsOf`) joined back into the text, as its chunks, in order. */
export const joinedParts = (parts: ReadonlyArray<TextChunks>): TextChunks => {
	const chunks = parts.flat()
	minted(chunks)
	return chunks
}

/** Each chunk's UTF-8, in order, encoded as it is read: together, exactly the text's. */
export const chunkBytes = function* (chunks: TextChunks): Generator<Uint8Array> {
	for (const chunk of chunks) {
		yield utf8(chunk)
	}
}

/**
 * Where two byte sequences first part: nowhere (`same`), or at the offset of the first byte one holds and the other
 * does not hold alike, the shorter's length where one is the other's start (`differ`).
 */
export type BytesParting =
	| { readonly kind: "same" }
	| { readonly kind: "differ"; readonly at: number }

/**
 * Our bytes, read as they are needed from `ours`, held to theirs as theirs arrive in any blocks (`next`), each byte
 * compared once, so neither side is ever held whole; `end`, once theirs are all read, is where the two part
 * (BytesParting).
 */
export class ByteMatch {
	readonly #ours: Iterator<Uint8Array>
	/** Our block being compared, and how far into it. */
	#block: Uint8Array = new Uint8Array(0)
	#in = 0
	/** How many bytes matched so far. */
	#matched = 0
	#parted = false

	constructor(ours: Iterable<Uint8Array>) {
		this.#ours = ours[Symbol.iterator]()
	}

	/** Theirs' next bytes, held to ours from where the last left off. */
	next(theirs: Uint8Array): void {
		for (let k = 0; k < theirs.length && !this.#parted;) {
			if (this.#in === this.#block.length && !this.#advance()) {
				this.#parted = true
				return
			}
			const run = Math.min(this.#block.length - this.#in, theirs.length - k)
			const same = firstUnlike(this.#block, this.#in, theirs, k, run)
			if (same < run) {
				this.#matched += same
				this.#parted = true
				return
			}
			this.#in += run
			this.#matched += run
			k += run
		}
	}

	/** Where ours and theirs part, theirs read whole: ours longer parts at theirs' end. */
	end(): BytesParting {
		if (this.#parted) {
			return { kind: "differ", at: this.#matched }
		}
		const spent = this.#in === this.#block.length && !this.#advance()
		return spent ? { kind: "same" } : { kind: "differ", at: this.#matched }
	}

	/** Our next nonempty block read, or false where ours are spent. */
	#advance(): boolean {
		let read = this.#ours.next()
		while (read.done !== true && read.value.length === 0) {
			read = this.#ours.next()
		}
		if (read.done === true) {
			return false
		}
		this.#block = read.value
		this.#in = 0
		return true
	}
}

/** How many of `run` bytes from `a` at `i` and `b` at `k` are alike before the first that is not: `run` where all are. */
const firstUnlike = (a: Uint8Array, i: number, b: Uint8Array, k: number, run: number): number => {
	let j = 0
	while (j < run && a[i + j] === b[k + j]) {
		j += 1
	}
	return j
}

/**
 * What the SQL lexer reads of a text: a string, or a text's chunks read as one (`ChunkView`). A slice is built of the
 * units it spans alone.
 */
export interface TextView {
	readonly length: number
	charCodeAt(at: number): number
	charAt(at: number): string
	indexOf(search: string, from: number): number
	slice(start: number, end: number): string
}

/**
 * A text's chunks read as one text (TextView), by offset: a unit or a search found in the chunk that holds it, the
 * chunk a read last reached kept so a read in order finds it at once, and a slice joined of the parts of the chunks it
 * spans, nothing beyond them. It reads any cut of a text into strings, a text's chunks (TextChunks) among them.
 */
export class ChunkView implements TextView {
	readonly #chunks: ReadonlyArray<string>
	/** The offset each chunk starts at, one past the last for the text's end. */
	readonly #starts: ReadonlyArray<number>
	readonly length: number
	/** The chunk a read last reached. */
	#last = 0

	constructor(chunks: ReadonlyArray<string>) {
		this.#chunks = chunks
		const starts: Array<number> = [0]
		let at = 0
		for (const chunk of chunks) {
			at += chunk.length
			starts.push(at)
		}
		this.#starts = starts
		this.length = at
	}

	charCodeAt(at: number): number {
		if (at < 0 || at >= this.length) {
			return Number.NaN
		}
		const k = this.#chunkAt(at)
		return this.#chunk(k).charCodeAt(at - this.#start(k))
	}

	charAt(at: number): string {
		if (at < 0 || at >= this.length) {
			return ""
		}
		const k = this.#chunkAt(at)
		return this.#chunk(k).charAt(at - this.#start(k))
	}

	indexOf(search: string, from: number): number {
		const start = Math.max(0, Math.min(from, this.length))
		if (search.length === 0) {
			return start
		}
		for (
			let k = start < this.length ? this.#chunkAt(start) : this.#chunks.length;
			k < this.#chunks.length;
			k++
		) {
			const base = this.#start(k)
			const inside = this.#chunk(k).indexOf(search, Math.max(0, start - base))
			if (inside !== -1) {
				return base + inside
			}
			const seam = this.#start(k + 1)
			if (seam < this.length) {
				const low = Math.max(start, seam - search.length + 1)
				const across = this.slice(low, Math.min(this.length, seam + search.length - 1)).indexOf(
					search
				)
				if (across !== -1) {
					return low + across
				}
			}
		}
		return -1
	}

	slice(start: number, end: number): string {
		const from = Math.max(0, Math.min(start, this.length))
		const to = Math.max(from, Math.min(end, this.length))
		if (from === to) {
			return ""
		}
		const first = this.#chunkAt(from)
		const last = this.#chunkAt(to - 1)
		if (first === last) {
			const base = this.#start(first)
			return this.#chunk(first).slice(from - base, to - base)
		}
		const parts: Array<string> = []
		for (let k = first; k <= last; k++) {
			const base = this.#start(k)
			parts.push(
				this.#chunk(k).slice(Math.max(0, from - base), Math.min(this.#chunk(k).length, to - base))
			)
		}
		return parts.join("")
	}

	#chunk(k: number): string {
		return defined(this.#chunks[k], "a chunk below the chunks' count")
	}

	#start(k: number): number {
		return defined(this.#starts[k], "a chunk's start")
	}

	/** The chunk holding the unit at `at`, which is inside the text: the last one reached, its next, or a search. */
	#chunkAt(at: number): number {
		for (const k of [this.#last, this.#last + 1]) {
			if (k < this.#chunks.length && this.#start(k) <= at && at < this.#start(k + 1)) {
				this.#last = k
				return k
			}
		}
		let low = 0
		let high = this.#chunks.length - 1
		while (low < high) {
			const middle = (low + high + 1) >> 1
			if (this.#start(middle) <= at) {
				low = middle
			} else {
				high = middle - 1
			}
		}
		this.#last = low
		return low
	}
}

/** Where a text failed to read as JSON: the offset of the unit the reader stopped at, and what it expected there. */
export interface JsonUnread {
	readonly at: number
	readonly expected: string
}

/** A container whose value the JSON reader is reading: an array's items, or an object's members and the key read last. */
type JsonFrame =
	| { readonly kind: "array"; readonly items: Array<unknown> }
	| { readonly kind: "object"; readonly members: Array<readonly [string, unknown]>; key: string }

/** JSON's whitespace (RFC 8259 ws): space, horizontal tab, line feed and carriage return. */
const isJsonSpace = (unit: number): boolean =>
	unit === 0x20 || unit === 0x09 || unit === 0x0a || unit === 0x0d

const isDigit = (unit: number): boolean => unit >= 0x30 && unit <= 0x39

/** The value of a hex digit, or -1 for a unit that is none. */
const hexValue = (unit: number): number =>
	isDigit(unit)
		? unit - 0x30
		: unit >= 0x61 && unit <= 0x66
			? unit - 0x57
			: unit >= 0x41 && unit <= 0x46
				? unit - 0x37
				: -1

/** The character each one-character JSON escape stands for, by the unit after its backslash. */
const shortEscapes: ReadonlyMap<number, string> = new Map([
	[0x22, '"'],
	[0x5c, "\\"],
	[0x2f, "/"],
	[0x62, "\b"],
	[0x66, "\f"],
	[0x6e, "\n"],
	[0x72, "\r"],
	[0x74, "\t"]
])

/** The literal names JSON spells and the values they stand for. */
const literals = [
	["true", true],
	["false", false],
	["null", null]
] as const

/** Thrown inside the reader where the text is no JSON, and caught at readJson, which answers it. */
class Unread extends Error {
	readonly unread: JsonUnread
	constructor(unread: JsonUnread) {
		super(`no JSON text: at ${unread.at}, ${unread.expected}`)
		this.unread = unread
	}
}

/**
 * A cursor over a text's chunks, a unit at a time, for the JSON reader: no chunk is joined to another, and a string or
 * number the reader takes is built of its own units alone.
 */
class JsonCursor {
	readonly #chunks: ReadonlyArray<string>
	#k = 0
	#chunk: string
	#in = 0
	/** The offset of the unit at the cursor. */
	at = 0

	constructor(chunks: ReadonlyArray<string>) {
		this.#chunks = chunks
		this.#chunk = chunks[0] ?? ""
	}

	/** The unit at the cursor, or -1 at the text's end. */
	peek(): number {
		while (this.#in === this.#chunk.length) {
			if (this.#k + 1 >= this.#chunks.length) {
				return -1
			}
			this.#k += 1
			this.#chunk = defined(this.#chunks[this.#k], "a chunk below the chunks' count")
			this.#in = 0
		}
		return this.#chunk.charCodeAt(this.#in)
	}

	advance(): void {
		this.#in += 1
		this.at += 1
	}

	refuse(expected: string): never {
		throw new Unread({ at: this.at, expected })
	}

	skipSpace(): void {
		while (isJsonSpace(this.peek())) {
			this.advance()
		}
	}

	expect(unit: number, expected: string): void {
		if (this.peek() !== unit) {
			this.refuse(expected)
		}
		this.advance()
	}

	/** A string's value, the cursor past its opening quotation mark: each run of plain units taken from its chunk. */
	string(): string {
		const parts: Array<string> = []
		for (;;) {
			const unit = this.peek()
			if (unit === 0x22) {
				this.advance()
				return parts.join("")
			}
			if (unit === -1 || unit < 0x20) {
				return this.refuse("a string's next character or its closing quotation mark")
			}
			if (unit === 0x5c) {
				this.advance()
				parts.push(this.#escape())
				continue
			}
			const from = this.#in
			while (this.#in < this.#chunk.length) {
				const next = this.#chunk.charCodeAt(this.#in)
				if (next === 0x22 || next === 0x5c || next < 0x20) {
					break
				}
				this.#in += 1
				this.at += 1
			}
			parts.push(this.#chunk.slice(from, this.#in))
		}
	}

	/** An escape's character, the cursor past its backslash. */
	#escape(): string {
		const unit = this.peek()
		const short = shortEscapes.get(unit)
		if (short !== undefined) {
			this.advance()
			return short
		}
		if (unit !== 0x75) {
			return this.refuse('an escape: one of " \\ / b f n r t, or u and four hex digits')
		}
		this.advance()
		let code = 0
		for (let d = 0; d < 4; d++) {
			const digit = hexValue(this.peek())
			if (digit === -1) {
				return this.refuse("a hex digit of a \\u escape")
			}
			code = code * 16 + digit
			this.advance()
		}
		return String.fromCharCode(code)
	}

	/** A number's value, read from its text as JSON spells it (RFC 8259 number), built of its own units. */
	number(): number {
		let text = ""
		const take = () => {
			text += String.fromCharCode(this.peek())
			this.advance()
		}
		const digits = (what: string) => {
			if (!isDigit(this.peek())) {
				this.refuse(what)
			}
			while (isDigit(this.peek())) {
				take()
			}
		}
		if (this.peek() === 0x2d) {
			take()
		}
		if (this.peek() === 0x30) {
			take()
		} else {
			digits("a number's integer digits")
		}
		if (this.peek() === 0x2e) {
			take()
			digits("a number's fraction digits")
		}
		if (this.peek() === 0x65 || this.peek() === 0x45) {
			take()
			if (this.peek() === 0x2b || this.peek() === 0x2d) {
				take()
			}
			digits("a number's exponent digits")
		}
		return Number(text)
	}

	literal(): unknown {
		for (const [name, value] of literals) {
			if (this.peek() === name.charCodeAt(0)) {
				for (let i = 0; i < name.length; i++) {
					this.expect(name.charCodeAt(i), `the literal ${name}`)
				}
				return value
			}
		}
		return this.refuse("a JSON value")
	}
}

/**
 * The value of a JSON text held as its chunks (TextChunks, or any cut of a text into strings), as JSON.parse reads the
 * text they make (ECMA-262 JSON.parse, RFC 8259):
 * each object built of its members in text order, a key it repeats holding the last value at the first place, every
 * member its own property (`__proto__` among them), each number the value of its literal; or where the text is no JSON
 * (JsonUnread), wherever JSON.parse refuses it. Containers are read onto a stack on the heap, so no depth of nesting
 * reaches the call stack, and no string longer than one of the text's own strings or numbers is built.
 */
export const readJson = (chunks: ReadonlyArray<string>): Result.Result<unknown, JsonUnread> => {
	const cursor = new JsonCursor(chunks)
	const read = Result.catchSignal(Unread, () => {
		const value = readValue(cursor)
		cursor.skipSpace()
		if (cursor.peek() !== -1) {
			cursor.refuse("the text's end after its value")
		}
		return value
	})
	return Result.mapError(read, (refused) => refused.unread)
}

/** One value read, its containers onto the reader's own stack. */
const readValue = (cursor: JsonCursor): unknown => {
	const frames: Array<JsonFrame> = []
	for (;;) {
		cursor.skipSpace()
		let value: unknown
		const unit = cursor.peek()
		if (unit === 0x7b) {
			cursor.advance()
			cursor.skipSpace()
			if (cursor.peek() === 0x7d) {
				cursor.advance()
				value = {}
			} else {
				frames.push({ kind: "object", members: [], key: memberKey(cursor) })
				continue
			}
		} else if (unit === 0x5b) {
			cursor.advance()
			cursor.skipSpace()
			if (cursor.peek() === 0x5d) {
				cursor.advance()
				value = []
			} else {
				frames.push({ kind: "array", items: [] })
				continue
			}
		} else if (unit === 0x22) {
			cursor.advance()
			value = cursor.string()
		} else if (unit === 0x2d || isDigit(unit)) {
			value = cursor.number()
		} else {
			value = cursor.literal()
		}
		for (;;) {
			const top = frames.at(-1)
			if (top === undefined) {
				return value
			}
			cursor.skipSpace()
			if (top.kind === "array") {
				top.items.push(value)
				if (cursor.peek() === 0x2c) {
					cursor.advance()
					break
				}
				cursor.expect(0x5d, "a comma or the array's closing bracket")
				frames.pop()
				value = top.items
				continue
			}
			top.members.push([top.key, value])
			if (cursor.peek() === 0x2c) {
				cursor.advance()
				cursor.skipSpace()
				top.key = memberKey(cursor)
				break
			}
			cursor.expect(0x7d, "a comma or the object's closing brace")
			frames.pop()
			value = Object.fromEntries(top.members)
		}
	}
}

/** A member's key and its colon, the cursor at the key's opening quotation mark. */
const memberKey = (cursor: JsonCursor): string => {
	cursor.expect(0x22, "a member's key")
	const key = cursor.string()
	cursor.skipSpace()
	cursor.expect(0x3a, "the colon after a member's key")
	return key
}
