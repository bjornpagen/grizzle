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
export type Identity = ReadonlyArray<Atom>

/** SameValueZero, as a Map compares keys: NaN is NaN, -0 is 0. */
const sameAtom = (a: Atom, b: Atom): boolean =>
	a === b || (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b))

/** Whether two identities are one, atom for atom. */
export const sameIdentity = (a: Identity, b: Identity): boolean =>
	a.length === b.length &&
	Arr.every(a, (x, i) => {
		const y = b[i]
		return y !== undefined && sameAtom(x, y)
	})

/** An identity interned: the one token of every equal identity of its interner (Identities). */
export class Interned {
	readonly identity: Identity

	constructor(identity: Identity) {
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
	of(identity: Identity): Interned {
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
	find(identity: Identity): Interned | undefined {
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
