/**
 * A change to a set as a signed multiset, a Z-set: each key weighs the times the change makes it present less the
 * times it makes it absent, and a key of weight 0 is not in it. Changes compose by addition (`addInto`): a key one
 * change adds and a later one removes weighs 0 and is gone, as is one removed and later added back, so the sum of a
 * sequence of changes to a set is the set it ends as less the set it began as, whatever happened between. That is the
 * one netting rule of a change, and both of its readers apply it: a write's outcome sums its strata's changes
 * (runtime/write/net.ts), and a rule judge's side of news sums its statements' captures per image, keeping the images
 * whose weights sum positive (physical/ddl/rules.ts netted).
 */

import type { TextsMap } from "#compiler/core/text.ts"

/** What one change of each side weighs: a key it makes present 1, a key it makes absent -1. */
export const weightOf = { added: 1, removed: -1 } as const

/** A side of a change: what it makes present, or absent. */
export type Side = keyof typeof weightOf

/** The side a weight stands on: a positive weight's key is added, a negative one's removed, and a key of weight 0 is on
 * neither, so it is not in the Z-set. */
export const sideOf = (weight: number): Side | undefined =>
	weight > 0 ? "added" : weight < 0 ? "removed" : undefined

/** A key's weight in a Z-set, never 0, with the value of the change it stands by. */
export interface Weighted<V> {
	readonly weight: number
	readonly value: V
}

/** A Z-set: each key in it, the identity of a fact's texts (core/text.ts TextsId), with its weight and value. */
export type ZSet<V> = TextsMap<Weighted<V>>

/**
 * Adds `change` into `net`, which it changes and returns: each key weighs the sum of its weights in the two, and a key
 * whose weights sum to 0 is dropped. A key that stands keeps the value of the change whose weight stands on its sum's
 * side, `change`'s where both do.
 */
export const addInto = <V>(net: ZSet<V>, change: ZSet<V>): ZSet<V> => {
	for (const [key, next] of change) {
		const held = net.get(key)
		if (held === undefined) {
			net.set(key, next)
			continue
		}
		const weight = held.weight + next.weight
		const side = sideOf(weight)
		if (side === undefined) {
			net.delete(key)
		} else {
			net.set(key, { weight, value: sideOf(next.weight) === side ? next.value : held.value })
		}
	}
	return net
}
