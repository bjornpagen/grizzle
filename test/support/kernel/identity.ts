import { Array as Arr } from "effect"

/**
 * One part of a value's identity under native equality: a primitive, which a native Map or Set compares by
 * SameValueZero, the reference's native equality on each (NaN is NaN, -0 is 0).
 */
export type Atom = string | number | bigint | boolean

/**
 * A value's or a row's identity: its atoms in order, each value's self-delimiting (its kind first, a list after its
 * length), so two identities are equal atom for atom exactly when they are of one value or one row.
 */
export type ValueIdentity = ReadonlyArray<Atom>

/** SameValueZero, as a Map compares keys: NaN is NaN, -0 is 0. */
const sameAtom = (a: Atom, b: Atom): boolean =>
	a === b || (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b))

/** Whether two identities are one, atom for atom. */
export const sameIdentity = (a: ValueIdentity, b: ValueIdentity): boolean =>
	a.length === b.length &&
	Arr.every(a, (x, i) => {
		const y = b[i]
		return y !== undefined && sameAtom(x, y)
	})

/** An atom's kind, which orders atoms of two kinds: texts, then numbers, bigints and booleans. */
const atomRank = (a: Atom): number =>
	typeof a === "string" ? 0 : typeof a === "number" ? 1 : typeof a === "bigint" ? 2 : 3

/** A total order of atoms: by kind, then by value, NaN after every other number and equal to itself. */
const compareAtoms = (a: Atom, b: Atom): number => {
	if (sameAtom(a, b)) {
		return 0
	}
	if (typeof a === "string" && typeof b === "string") {
		return a < b ? -1 : 1
	}
	if (typeof a === "number" && typeof b === "number") {
		return Number.isNaN(a) ? 1 : Number.isNaN(b) || a < b ? -1 : 1
	}
	if (typeof a === "bigint" && typeof b === "bigint") {
		return a < b ? -1 : 1
	}
	if (typeof a === "boolean" && typeof b === "boolean") {
		return a ? 1 : -1
	}
	return atomRank(a) - atomRank(b)
}

/**
 * A total order of identities, atom by atom and the shorter first where one is the other's prefix: what sorts a set
 * of identities into one canonical sequence.
 */
const compareValueIdentities = (a: ValueIdentity, b: ValueIdentity): number => {
	for (const [i, x] of a.entries()) {
		const y = b[i]
		if (y === undefined) {
			return 1
		}
		const order = compareAtoms(x, y)
		if (order !== 0) {
			return order
		}
	}
	return a.length < b.length ? -1 : 0
}

/** compareValueIdentities as an order a sort takes. */
export const valueIdentityOrder = (a: ValueIdentity, b: ValueIdentity): -1 | 0 | 1 => {
	const order = compareValueIdentities(a, b)
	return order < 0 ? -1 : order > 0 ? 1 : 0
}

/** An identity interned: the one token of every equal identity of its interner (Identities). */
export class Interned {
	readonly identity: ValueIdentity

	constructor(identity: ValueIdentity) {
		this.identity = identity
	}
}

/** One position of the interner's trie: the next atom's nodes, and the token of the identity that ends here. */
interface Trie {
	readonly next: Map<Atom, Trie>
	token: Interned | undefined
}

/**
 * Identities interned, structurally: `of` gives one token for every equal identity, so a native Map or Set keys rows
 * and values by their identity's structure, never by a text joined from it. One interner serves one evaluation, and
 * only its own tokens are comparable.
 */
export class Identities {
	readonly #root: Trie = { next: new Map(), token: undefined }

	/** The token of `identity`, interned on first use. */
	of(identity: ValueIdentity): Interned {
		let node = this.#root
		for (const atom of identity) {
			const child = node.next.get(atom)
			const next: Trie = child ?? { next: new Map(), token: undefined }
			if (child === undefined) {
				node.next.set(atom, next)
			}
			node = next
		}
		node.token ??= new Interned(identity)
		return node.token
	}

	/** The token of `identity` when one was interned, none otherwise: a lookup that interns nothing. */
	find(identity: ValueIdentity): Interned | undefined {
		let node: Trie | undefined = this.#root
		for (const atom of identity) {
			node = node.next.get(atom)
			if (node === undefined) {
				return undefined
			}
		}
		return node.token
	}
}
