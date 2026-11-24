/**
 * Where a relation is frozen: at a key every writer of its rows there founds, so no other write changes its rows at that
 * key once founded, and a read of them there needs no borrow and a definition over them no upkeep. The one predicate
 * the storage admission (analysis/derived/storage.ts) and the borrow checker read.
 *
 * A closed relation (a roster or `closed.relation`) is frozen at the installation: a migration alone writes its rows,
 * founding the installation, and no program writes them. A derived relation is frozen at the installation where every
 * relation its definition reads, at any depth, is, so its rows change only with a migration. An ordinary relation is
 * frozen at no key here.
 */

import type { FrozenUnit } from "#compiler/ir/unit.ts"
import type { Owned } from "#compiler/schema/own.ts"

/** The installation, the key a migration founds (ir/unit.ts FrozenUnit). */
const installation: FrozenUnit = Object.freeze({ kind: "installation" })

/** The key `relation` of `owned` is frozen at, if any (see the header). */
export const frozenAt = (owned: Owned, relation: string): FrozenUnit | undefined => {
	const seen = new Set<string>()
	const frozen = (name: string): boolean => {
		const r = owned.relations[name]
		if (r === undefined) {
			return false
		}
		switch (r.kind) {
			case "closed":
			case "closedRelation":
				return true
			case "relation":
				return false
			case "derived":
				if (seen.has(name)) {
					return true
				}
				seen.add(name)
				return r.reads.every(frozen)
		}
	}
	return frozen(relation) ? installation : undefined
}
