import { nominal } from "#compiler/core/brand.ts"
import { type Comparator, compareStrings } from "#compiler/core/order.ts"
import { compareQuotedTuples } from "#compiler/core/text.ts"

declare const setBrand: unique symbol

/**
 * A set: each member once, in canonical order, the order of its members' identities' canonical texts. Only the mints
 * below make one, so a set's order is a function of its members alone, never of the order they were given in. A
 * member's identity is the key its set's members are told apart by; two members of one identity are one member, the
 * first one given. A set is a frozen array, which the canonical encoder writes as one, in that order.
 */
export type CanonicalSet<A> = ReadonlyArray<A> & { readonly [setBrand]: true }

/** A member with its identity, read once before the members are ordered. */
interface Identified<A, K> {
	readonly member: A
	readonly identity: K
}

/** Lists of texts in the order of their canonical texts, JSON arrays of string literals: a closed row's key's. */
const byQuotedTuple: Comparator<ReadonlyArray<string>> = compareQuotedTuples(compareStrings)

/** Members each with its identity, ordered by them, stably: the first given of one identity first among them. */
const ordered = <A, K>(
	members: ReadonlyArray<A>,
	identity: (member: A) => K,
	order: Comparator<K>
): ReadonlyArray<Identified<A, K>> =>
	members
		.map((member): Identified<A, K> => ({ member, identity: identity(member) }))
		.toSorted((x, y) => order(x.identity, y.identity))

/** The first member of each identity of members ordered by their identities. */
const firstOfEach = <A, K>(
	sorted: ReadonlyArray<Identified<A, K>>,
	order: Comparator<K>
): ReadonlyArray<A> =>
	sorted.flatMap((m, i) => {
		const before = sorted[i - 1]
		return before !== undefined && order(before.identity, m.identity) === 0 ? [] : [m.member]
	})

const mintSet = <A>(members: ReadonlyArray<A>): CanonicalSet<A> =>
	nominal<ReadonlyArray<A>, CanonicalSet<A>>()(Object.freeze(members))

/** The set of `members` under `identity`, in `order`. */
const setOf = <A, K>(
	members: ReadonlyArray<A>,
	identity: (member: A) => K,
	order: Comparator<K>
): CanonicalSet<A> => mintSet(firstOfEach(ordered(members, identity, order), order))

/**
 * A set of members told apart by a list of names, `key`, its identity, as a closed relation's rows are by their key's
 * handles: one member of each list, the first given. Whoever builds the members refuses two of one key that differ, as
 * a closed relation refuses two rows of one key and other payloads.
 */
export const tupleKeyedSet = <A>(
	members: ReadonlyArray<A>,
	key: (member: A) => ReadonlyArray<string>
): CanonicalSet<A> => setOf(members, key, byQuotedTuple)
