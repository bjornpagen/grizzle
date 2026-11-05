import { nominal } from "#compiler/core/brand.ts"
import { invariant } from "#compiler/core/invariant.ts"

/**
 * The width of a word.
 *
 * @formatConstant a word: the 32 bits JavaScript's bitwise operators read and write
 */
const wordBits = 32

/**
 * The words one pass of the Harley–Seal count adds before it counts a word's ones: its counter planes carry ones, twos
 * and fours, and the pass's carry out of the fours plane is worth eight.
 *
 * @formatConstant a Harley–Seal block: eight words, the reach of three counter planes and their carry
 */
const blockWords = 8

/** The highest bit of a word, which holds the word's first position. */
const firstBit = 0x8000_0000

/**
 * A PostgreSQL `bit(n)` or `bit varying` value on the host, as 32-bit words: a set over a roster's codes, or a
 * relation's constant of w-bit cells, for the constants a connection reads when it opens and the set-valued folds a
 * write computes before PostgreSQL proves them.
 *
 * Position k, the string's (k + 1)th character and code k of a set, is bit 31 − (k mod 32) of word ⌊k / 32⌋. So each
 * word is the binary numeral its 32 positions spell, first position most significant, as PostgreSQL casts a 32-bit
 * substring to an integer: a cell's bits read off the words as one integer, and a word's numeral is its 32 characters
 * of text.
 *
 * Every read is total: a position or a cell past either end of the string reads 0, as PostgreSQL's substring is empty
 * past either end. The bits past `length` in the last word are 0, so counting and enumerating never mask.
 */
export interface BitString {
	/** How many bits the string holds: n for a set over n codes, the cells times w for a relation of w-bit cells. */
	readonly length: number
	/** ⌈length / 32⌉ words, position k at bit 31 − (k mod 32) of word ⌊k / 32⌋, and every bit past `length` 0. */
	readonly words: Uint32Array
}

/** The word at `j`, and 0 at any index past either end: a bit string reads 0 outside itself. */
const wordAt = (words: Uint32Array, j: number): number => words[j] ?? 0

/** The word that holds position `k`, by floor division, so a position below 0 lies in a word below 0, which reads 0. */
const wordOf = (k: number): number => Math.floor(k / wordBits)

/** The words a string of `length` bits takes. */
const wordsFor = (length: number): Uint32Array => new Uint32Array(Math.ceil(length / wordBits))

declare const accumulatorBrand: unique symbol

/**
 * A bit string a fold owns and changes in place, minted only by empty, copy and planes: the one kind of string `add`,
 * `or`, `and`, `andNot` and `step` write. A constant read from PostgreSQL is shared by every write that reads it, and is
 * never one, so changing a shared constant is a type error.
 */
export type Accumulator = BitString & { readonly [accumulatorBrand]: true }

const accumulator = nominal<BitString, Accumulator>()

/** The string of `length` bits, all 0: a fold's starting accumulator. */
export const empty = (length: number): Accumulator =>
	accumulator({ length, words: wordsFor(length) })

/** A fresh accumulator holding `bits`: a fold that starts from a value it reads, which it then changes alone. */
export const copy = (bits: BitString): Accumulator =>
	accumulator({ length: bits.length, words: Uint32Array.from(bits.words) })

/**
 * The bit string PostgreSQL's output text of a `bit` or `bit varying` value spells, one `0` or `1` per position,
 * converted trusting it: the text is PostgreSQL's own output, so nothing is checked. Each word is its 32 characters read
 * as a binary numeral, the last word's characters padded with zeros, which keeps the bits past the length 0.
 */
export const fromText = (text: string): BitString => {
	const words = wordsFor(text.length)
	for (let j = 0; j < words.length; j++) {
		words[j] = Number.parseInt(
			text.slice(j * wordBits, (j + 1) * wordBits).padEnd(wordBits, "0"),
			2
		)
	}
	return { length: text.length, words }
}

/**
 * The string's text, one `0` or `1` per position, the form `bit` and `bit varying` read: each word's binary numeral in
 * 32 digits, cut to the length.
 */
export const toText = (bits: BitString): string =>
	Array.from(bits.words, (word) => word.toString(2).padStart(wordBits, "0"))
		.join("")
		.slice(0, bits.length)

/** Whether position `k` holds a 1: a code's membership in a set. A position past either end holds none. */
export const has = (bits: BitString, k: number): boolean => {
	const j = wordOf(k)
	return (wordAt(bits.words, j) & (firstBit >>> (k - j * wordBits))) !== 0
}

/**
 * Sets position `k` to 1 in place, and returns 1 when it was 0 and 0 when it already held a 1, with no branch: the
 * changed bit, shifted down to the units. A fold that adds each member's code and sums what `add` returns keeps its
 * count, and a 0 is a member already present. `k` lies inside the string, as PostgreSQL's set_bit requires.
 */
export const add = (bits: Accumulator, k: number): number => {
	invariant(
		k >= 0 && k < bits.length,
		`a bit added at ${k} lies inside its string of ${bits.length} bits`
	)
	const j = wordOf(k)
	const shift = k - j * wordBits
	const was = wordAt(bits.words, j)
	const now = was | (firstBit >>> shift)
	bits.words[j] = now
	return (was ^ now) >>> (wordBits - 1 - shift)
}

/** Two strings an operation combines have one length, as PostgreSQL's `&` and `|` refuse strings of two. */
const sameLength = (target: BitString, source: BitString): void => {
	invariant(
		target.length === source.length,
		`two bit strings combined have one length, not ${target.length} and ${source.length}`
	)
}

/** Each word of `target` replaced in place by `op` of it and the same word of `source`, a string of its length. */
const combine = (
	target: Accumulator,
	source: BitString,
	op: (t: number, s: number) => number
): void => {
	sameLength(target, source)
	for (let j = 0; j < target.words.length; j++) {
		target.words[j] = op(wordAt(target.words, j), wordAt(source.words, j))
	}
}

/** `target | source`, into `target`: the union, a set-valued fold's step. */
export const or = (target: Accumulator, source: BitString): void =>
	combine(target, source, (t, s) => t | s)

/** `target & source`, into `target`: the intersection. */
export const and = (target: Accumulator, source: BitString): void =>
	combine(target, source, (t, s) => t & s)

/** `target & ~source`, into `target`: the difference. Its bits past the length stay 0, since the target's are. */
export const andNot = (target: Accumulator, source: BitString): void =>
	combine(target, source, (t, s) => t & ~s)

/**
 * The ones in a word, by the Wilkes–Wheeler–Gill tree of adders: pairs of bits summed in place, then nibbles, then
 * bytes, and the four byte counts summed by one multiplication into the top byte.
 */
const wordCount = (x: number): number => {
	const pairs = x - ((x >>> 1) & 0x5555_5555)
	const nibbles = (pairs & 0x3333_3333) + ((pairs >>> 2) & 0x3333_3333)
	const bytes = (nibbles + (nibbles >>> 4)) & 0x0f0f_0f0f
	return Math.imul(bytes, 0x0101_0101) >>> 24
}

/** The carry of three words added bit by bit: each bit where at least two of the three hold a 1. */
const carry = (a: number, b: number, c: number): number => (a & b) | ((a ^ b) & c)

/** The sum of three words added bit by bit: each bit where an odd number of the three hold a 1. */
const parity = (a: number, b: number, c: number): number => a ^ b ^ c

/**
 * How many positions hold a 1, by Harley–Seal: each block of eight words is added bit by bit into counter planes of
 * weight one, two and four with carry-save adders, and only the carry out of the fours plane, worth eight, is counted
 * per block; the planes and the words past the last block are counted once at the end. A string shorter than a block
 * is the per-word count alone. The bits past the length are 0, so they count nothing.
 */
export const count = (bits: BitString): number => {
	const { words } = bits
	const blocks = Math.floor(words.length / blockWords)
	let ones = 0
	let twos = 0
	let fours = 0
	let eights = 0
	for (let b = 0; b < blocks; b++) {
		const j = b * blockWords
		const w0 = wordAt(words, j)
		const w1 = wordAt(words, j + 1)
		const w2 = wordAt(words, j + 2)
		const w3 = wordAt(words, j + 3)
		const w4 = wordAt(words, j + 4)
		const w5 = wordAt(words, j + 5)
		const w6 = wordAt(words, j + 6)
		const w7 = wordAt(words, j + 7)
		const twosA = carry(ones, w0, w1)
		ones = parity(ones, w0, w1)
		const twosB = carry(ones, w2, w3)
		ones = parity(ones, w2, w3)
		const foursA = carry(twos, twosA, twosB)
		twos = parity(twos, twosA, twosB)
		const twosC = carry(ones, w4, w5)
		ones = parity(ones, w4, w5)
		const twosD = carry(ones, w6, w7)
		ones = parity(ones, w6, w7)
		const foursB = carry(twos, twosC, twosD)
		twos = parity(twos, twosC, twosD)
		eights += wordCount(carry(fours, foursA, foursB))
		fours = parity(fours, foursA, foursB)
	}
	let rest = 0
	for (let j = blocks * blockWords; j < words.length; j++) {
		rest += wordCount(wordAt(words, j))
	}
	return eights * 8 + wordCount(fours) * 4 + wordCount(twos) * 2 + wordCount(ones) + rest
}

/**
 * The positions that hold a 1, ascending: a set's codes. Each word yields one position per 1 it holds and none per 0,
 * the next one at its count of leading zeros, which is then cleared.
 */
export const members = (bits: BitString): ReadonlyArray<number> => {
	const found: Array<number> = []
	bits.words.forEach((word, j) => {
		let rest = word
		while (rest !== 0) {
			const at = Math.clz32(rest)
			found.push(j * wordBits + at)
			rest ^= firstBit >>> at
		}
	})
	return found
}

/**
 * Cell `index` of a string of `width`-bit cells, `width` from 1 to 32: the value PostgreSQL reads as
 * `substring(S FROM index * width + 1 FOR width)::int4`, its bits one binary numeral, first bit most significant, read
 * as a signed int4. The cell's bits are a window of the two words it may straddle, shifted into place, and a cell past
 * either end reads 0, which is absent. The second word's shift is taken in two steps, by 1 and then by 31 less the
 * offset, because a shift by 32 is a shift by 0.
 */
export const cell = (bits: BitString, index: number, width: number): number => {
	const at = index * width
	const j = wordOf(at)
	const shift = at - j * wordBits
	const window =
		(wordAt(bits.words, j) << shift) |
		((wordAt(bits.words, j + 1) >>> 1) >>> (wordBits - 1 - shift))
	return (window >>> (wordBits - width)) | 0
}

/**
 * The two planes of a saturating fold of sets, whose step is (ones, twos) ⊕ x = (ones | x, twos | (ones & x)): it is
 * commutative and associative, so the order the members are folded in never shows. "At most one of K" is
 * `twos & K` empty.
 */
export interface Planes {
	/** The positions set in at least one string folded in. */
	readonly ones: Accumulator
	/** The positions set in at least two. */
	readonly twos: Accumulator
}

/** The planes of `length` bits with nothing folded in. */
export const planes = (length: number): Planes => ({ ones: empty(length), twos: empty(length) })

/** Folds `x` into `fold`'s planes in place: each word's twos take the ones `x` repeats, then its ones take `x`. */
export const step = (fold: Planes, x: BitString): void => {
	sameLength(fold.ones, x)
	const { ones, twos } = fold
	for (let j = 0; j < ones.words.length; j++) {
		const o = wordAt(ones.words, j)
		const v = wordAt(x.words, j)
		twos.words[j] = wordAt(twos.words, j) | (o & v)
		ones.words[j] = o | v
	}
}
