import { nominal } from "#compiler/core/brand.ts"
import { defined } from "#compiler/core/invariant.ts"

/**
 * A node's attributes interned, and sets of them as bitsets.
 *
 * The logical analysis reads a node's attributes, its heading's columns and then its hidden attributes (ir/keys.ts
 * hiddenAttribute), by position, interned once when the node's properties are built (logical/props.ts finish). A set of
 * them is a Bits, one bit a position, so whether a dependency's determinants are reached is a word-wise test and a step
 * of a closure an OR, never a lookup by name. Positions follow the attributes' order, so a set's positions read in
 * ascending order are its columns in heading order, then its hidden attributes in theirs: a set read out is in heading
 * order with no sort.
 */

/**
 * The width of a word.
 *
 * @formatConstant a word: the 32 bits JavaScript's bitwise operators read and write
 */
const wordBits = 32

declare const bitsBrand: unique symbol

/**
 * A set of a node's attributes: position p is bit p mod 32 of word ⌊p / 32⌋, in as many words as the node's attributes
 * take (Attributes words), every bit past the last attribute 0, minted only here, so no other array of words stands for
 * one. Only the analysis that interned the attributes reads it.
 */
export type Bits = Uint32Array & { readonly [bitsBrand]: true }

const asBits = nominal<Uint32Array, Bits>()

/** A node's attributes, each at its position, and the words a set of them takes. */
export interface Attributes {
	/** Every attribute, the heading's columns and then the hidden attributes, each once, at its position. */
	readonly names: ReadonlyArray<string>
	/** The hidden attributes, in their order: the positions past the heading's. */
	readonly hidden: ReadonlyArray<string>
	/** Each attribute's position. */
	readonly at: ReadonlyMap<string, number>
	/** The words a set of them takes. */
	readonly words: number
	/** The heading's columns: the positions below the heading's length. */
	readonly heading: Bits
	/** The heading's positions, in order. */
	readonly headingAt: ReadonlyArray<number>
}

/** The word at `w`, and 0 past either end: a set holds nothing outside its words. */
const wordAt = (bits: Bits, w: number): number => bits[w] ?? 0

/** The ones of a 32-bit word (Hacker's Delight 5-2). */
const onesOf = (word: number): number => {
	const a = word - ((word >>> 1) & 0x5555_5555)
	const b = (a & 0x3333_3333) + ((a >>> 2) & 0x3333_3333)
	return (Math.imul((b + (b >>> 4)) & 0x0f0f_0f0f, 0x0101_0101) >>> 24) & 0xff
}

/** The position of a word's lowest one, which `word` holds. */
const lowestOf = (word: number): number => wordBits - 1 - Math.clz32(word & -word)

/**
 * A node's attributes: its heading's columns, then each hidden attribute not already one, at the positions they take
 * in that order.
 */
export const attributesOver = (
	columns: ReadonlyArray<string>,
	hidden: ReadonlyArray<string>
): Attributes => {
	const names: Array<string> = []
	const at = new Map<string, number>()
	for (const c of columns) {
		at.set(c, names.length)
		names.push(c)
	}
	const headingAt = [...at.values()]
	const kept: Array<string> = []
	for (const h of hidden) {
		if (at.has(h)) {
			continue
		}
		at.set(h, names.length)
		names.push(h)
		kept.push(h)
	}
	const words = Math.ceil(names.length / wordBits)
	const heading = asBits(new Uint32Array(words))
	for (const p of headingAt) {
		addTo(heading, p)
	}
	return { names, hidden: kept, at, words, heading, headingAt }
}

/** The empty set of a node's attributes. */
export const noBits = (attributes: Attributes): Bits => asBits(new Uint32Array(attributes.words))

/** The empty set of the attributes `like` is a set of. */
export const emptyLike = (like: Bits): Bits => asBits(new Uint32Array(like.length))

/** A set holding what `of` holds, its holder's own to change. */
export const copyBits = (of: Bits): Bits => asBits(of.slice())

/** The attributes among `names` a node has, as a set; any other name is none of them. */
export const bitsOf = (attributes: Attributes, names: Iterable<string>): Bits => {
	const out = noBits(attributes)
	for (const n of names) {
		const p = attributes.at.get(n)
		if (p !== undefined) {
			addTo(out, p)
		}
	}
	return out
}

/** The set of the positions `positions` of a node's attributes. */
export const bitsAt = (attributes: Attributes, positions: Iterable<number>): Bits => {
	const out = noBits(attributes)
	for (const p of positions) {
		addTo(out, p)
	}
	return out
}

/** Whether a set holds the attribute at `p`. */
export const holdsAt = (bits: Bits, p: number): boolean =>
	(wordAt(bits, p >>> 5) & (1 << (p & 31))) !== 0

/** Whether a set holds the attribute named `name` (Attributes at); never one the node lacks. */
export const holdsName = (attributes: Attributes, bits: Bits, name: string): boolean => {
	const p = attributes.at.get(name)
	return p !== undefined && holdsAt(bits, p)
}

/** The attribute at `p` added to a set its holder owns. */
export const addTo = (bits: Bits, p: number): void => {
	const w = p >>> 5
	bits[w] = wordAt(bits, w) | (1 << (p & 31))
}

/** The attribute at `p` taken from a set its holder owns. */
export const dropFrom = (bits: Bits, p: number): void => {
	const w = p >>> 5
	bits[w] = wordAt(bits, w) & ~(1 << (p & 31))
}

/** Every attribute of `source` added to `target`, a set its holder owns. */
export const orInto = (target: Bits, source: Bits): void => {
	for (let w = 0; w < target.length; w++) {
		target[w] = wordAt(target, w) | wordAt(source, w)
	}
}

/** Whether every attribute of `a` is one of `b`. */
export const subsetOf = (a: Bits, b: Bits): boolean => {
	for (let w = 0; w < a.length; w++) {
		if ((wordAt(a, w) & ~wordAt(b, w)) !== 0) {
			return false
		}
	}
	return true
}

/** Whether two sets of one node's attributes hold the same attributes. */
export const sameBits = (a: Bits, b: Bits): boolean => {
	for (let w = 0; w < a.length; w++) {
		if (wordAt(a, w) !== wordAt(b, w)) {
			return false
		}
	}
	return true
}

/** Whether a set holds no attribute. */
export const isEmpty = (bits: Bits): boolean => {
	for (let w = 0; w < bits.length; w++) {
		if (wordAt(bits, w) !== 0) {
			return false
		}
	}
	return true
}

/** The attributes of `a` or `b`, a new set. */
export const union = (a: Bits, b: Bits): Bits => {
	const out = copyBits(a)
	orInto(out, b)
	return out
}

/** The attributes of both `a` and `b`, a new set. */
export const intersect = (a: Bits, b: Bits): Bits => {
	const out = emptyLike(a)
	for (let w = 0; w < out.length; w++) {
		out[w] = wordAt(a, w) & wordAt(b, w)
	}
	return out
}

/** The attributes of `a` that are not of `b`, a new set. */
export const minus = (a: Bits, b: Bits): Bits => {
	const out = emptyLike(a)
	for (let w = 0; w < out.length; w++) {
		out[w] = wordAt(a, w) & ~wordAt(b, w)
	}
	return out
}

/** How many attributes a set holds. */
export const sizeOf = (bits: Bits): number => {
	let n = 0
	for (let w = 0; w < bits.length; w++) {
		n += onesOf(wordAt(bits, w))
	}
	return n
}

/** The lowest position of a set that holds one. */
export const lowest = (bits: Bits): number | undefined => {
	for (let w = 0; w < bits.length; w++) {
		const word = wordAt(bits, w)
		if (word !== 0) {
			return w * wordBits + lowestOf(word)
		}
	}
	return undefined
}

/** A set's positions, ascending. */
export const positions = (bits: Bits): Array<number> => {
	const out: Array<number> = []
	for (let w = 0; w < bits.length; w++) {
		for (let word = wordAt(bits, w); word !== 0; word &= word - 1) {
			out.push(w * wordBits + lowestOf(word))
		}
	}
	return out
}

/** The name of the attribute at `p`, which the node has. */
export const nameAt = (attributes: Attributes, p: number): string =>
	defined(attributes.names[p], "a set's position is one of its node's attributes")

/** A set's attributes by name, in their order: the heading's columns in heading order, then the hidden attributes. */
export const namesOf = (attributes: Attributes, bits: Bits): Array<string> =>
	positions(bits).map((p) => nameAt(attributes, p))
