import type { Order } from "effect"
import {
	type ReadonlyTupleMap,
	type ReadonlyTupleSet,
	TupleMap,
	TupleSet
} from "#compiler/core/tuple-map.ts"
import { compareFactIdentities, type FactIdentity } from "#compiler/scalar/values/identity.ts"

export type Fact = { readonly [field: string]: unknown }

/** Identity to fact, keyed structurally by each fact's identity texts (scalar/values/identity.ts FactIdentity). */
export type FactSet = ReadonlyTupleMap<FactIdentity, Fact>

/** Fact identities in their canonical order (scalar/values/identity.ts compareFactIdentities). */
export const identityOrder: Order.Order<FactIdentity> = (a, b) => {
	const order = compareFactIdentities(a, b)
	return order < 0 ? -1 : order > 0 ? 1 : 0
}

/** The fact set of `entries`, each identity once, the last fact of an identity kept. */
export const factSetOf = (entries: Iterable<readonly [FactIdentity, Fact]>): FactSet => {
	const set = new TupleMap<FactIdentity, Fact>()
	for (const [identity, fact] of entries) {
		set.set(identity, fact)
	}
	return set
}

/** The set of `identities`, each once. */
export const identitySetOf = (
	identities: Iterable<FactIdentity>
): ReadonlyTupleSet<FactIdentity> => {
	const set = new TupleSet<FactIdentity>()
	for (const identity of identities) {
		set.add(identity)
	}
	return set
}

export interface RelationDelta {
	readonly added: FactSet
	readonly removed: FactSet
}

const minus = (a: FactSet, b: FactSet): FactSet => {
	const out = new TupleMap<FactIdentity, Fact>()
	for (const [identity, fact] of a) {
		if (!b.has(identity)) {
			out.set(identity, fact)
		}
	}
	return out
}

/**
 * The delta and count calculator: what a ChangeSet made present and absent, and the outcome's counts. Test-only oracle.
 *
 * A relation's state is a map from fact identity (scalar/values factIdentity) to the admitted fact, so set operations
 * are map operations on identities.
 *
 * - `stateDelta` is the definition: delta.added(R) is R in the final state minus R in the initial
 *   state, and delta.removed(R) the reverse. An exact repeat appears in neither; a fact one stratum adds and a later
 *   one removes appears in neither; a fact replaced by put appears as the old fact removed and the new one added.
 * - `netStrata` nets the per-stratum changes, as the realization does over its per-stratum RETURNING carriers:
 *   walking the strata in order, an addition cancels a pending removal of the same fact and a removal cancels a
 *   pending addition. It equals `stateDelta` for every sequence of actual changes. The literal formula "what was added
 *   minus what a later stratum removed" does not: a fact present before the change that one stratum removes and a
 *   later stratum adds back is in neither state difference, yet the formula reports it added, so the definition, not
 *   the formula, is the rule.
 * - The counts are netted the same way. `attributeStratum` applies the count rules to one
 *   stratum, the one add-wins transition the rules are written for: its actual change, with each addition tagged put
 *   or insert and each removal tagged delete when a delete member of that stratum requested it, untagged when it is
 *   only an occupant a put displaced. `netCounts` walks the strata in order with the same cancellation as `netStrata`
 *   and counts the surviving tagged changes. For a single stratum it is the count rules on S and S' exactly. Across
 *   strata it departs from those rules read once over the whole sequence wherever a fact's attribution changes
 *   between strata, because the realization's counts come from the per-stratum RETURNING carriers: a later delete of
 *   an occupant an earlier put displaced returns no row and is not counted; a fact one stratum inserts and a later
 *   one puts again is an exact repeat there, counted under added; and a fact put, deleted and inserted again counts
 *   under the insert that made it present last. So "a fact both requested counts once, under put" holds within one
 *   stratum.
 *
 * The definition: added = final minus initial, removed = initial minus final.
 */
export const stateDelta = (before: FactSet, after: FactSet): RelationDelta => ({
	added: minus(after, before),
	removed: minus(before, after)
})

/** Sequential netting over per-stratum changes (read so that it equals the `stateDelta` definition). */
export const netStrata = (steps: ReadonlyArray<RelationDelta>): RelationDelta => {
	const added = new TupleMap<FactIdentity, Fact>()
	const removed = new TupleMap<FactIdentity, Fact>()
	/** A removal cancels a pending addition of the same fact, or is pending itself. */
	const remove = (identity: FactIdentity, fact: Fact): void => {
		if (added.has(identity)) {
			added.delete(identity)
		} else {
			removed.set(identity, fact)
		}
	}
	/** An addition cancels a pending removal of the same fact, or is pending itself. */
	const add = (identity: FactIdentity, fact: Fact): void => {
		if (removed.has(identity)) {
			removed.delete(identity)
		} else {
			added.set(identity, fact)
		}
	}
	for (const step of steps) {
		for (const [identity, fact] of step.removed) {
			remove(identity, fact)
		}
		for (const [identity, fact] of step.added) {
			add(identity, fact)
		}
	}
	return { added, removed }
}

/**
 * The identities each kind of member of one stratum requested. Generated additions are in `insert` with the values
 * they were given.
 */
interface Requested {
	readonly insert: ReadonlyTupleSet<FactIdentity>
	readonly put: ReadonlyTupleSet<FactIdentity>
	readonly delete: ReadonlyTupleSet<FactIdentity>
}

export interface Counts {
	readonly added: bigint
	readonly deleted: bigint
	readonly put: bigint
}

/** One stratum's actual change to one relation, attributed to the kind of member that caused it. */
export interface AttributedChange {
	/**
	 * The facts the stratum made present, under put when a put member requested them (a fact both an insert and a put
	 * of the stratum requested counts once, under put), under insert otherwise.
	 */
	readonly added: ReadonlyTupleMap<FactIdentity, "insert" | "put">
	/**
	 * The facts the stratum made absent, under delete when a delete member of the stratum requested them; an occupant
	 * that only a put displaced is "displaced" and never counted.
	 */
	readonly removed: ReadonlyTupleMap<FactIdentity, "delete" | "displaced">
}

/** The count rules for one add-wins transition from `before` to `after`. */
export const attributeStratum = (
	before: FactSet,
	after: FactSet,
	requested: Requested
): AttributedChange => {
	const delta = stateDelta(before, after)
	const added = new TupleMap<FactIdentity, "insert" | "put">()
	const removed = new TupleMap<FactIdentity, "delete" | "displaced">()
	for (const identity of delta.added.keys()) {
		if (requested.put.has(identity)) {
			added.set(identity, "put")
		} else if (requested.insert.has(identity)) {
			added.set(identity, "insert")
		} else {
			throw new Error("a stratum made present a fact no insert or put member requested")
		}
	}
	for (const identity of delta.removed.keys()) {
		removed.set(identity, requested.delete.has(identity) ? "delete" : "displaced")
	}
	return { added, removed }
}

/**
 * The counts netted over the strata in order: an addition cancels a pending removal of the same fact and
 * a removal cancels a pending addition, and each surviving change counts under its tag.
 */
export const netCounts = (steps: ReadonlyArray<AttributedChange>): Counts => {
	const added = new TupleMap<FactIdentity, "insert" | "put">()
	const removed = new TupleMap<FactIdentity, "delete" | "displaced">()
	/** A removal cancels a pending addition of the same fact, or is pending itself under its tag. */
	const remove = (identity: FactIdentity, tag: "delete" | "displaced"): void => {
		if (added.has(identity)) {
			added.delete(identity)
		} else {
			removed.set(identity, tag)
		}
	}
	/** An addition cancels a pending removal of the same fact, or is pending itself under its tag. */
	const add = (identity: FactIdentity, tag: "insert" | "put"): void => {
		if (removed.has(identity)) {
			removed.delete(identity)
		} else {
			added.set(identity, tag)
		}
	}
	for (const step of steps) {
		for (const [identity, tag] of step.removed) {
			remove(identity, tag)
		}
		for (const [identity, tag] of step.added) {
			add(identity, tag)
		}
	}
	let insert = 0n
	let put = 0n
	let deleted = 0n
	for (const tag of added.values()) {
		if (tag === "put") {
			put += 1n
		} else {
			insert += 1n
		}
	}
	for (const tag of removed.values()) {
		if (tag === "delete") {
			deleted += 1n
		}
	}
	return { added: insert, deleted, put }
}

/** accepted when some relation's count is nonzero, no-change otherwise. */
export const outcomeKind = (counts: Iterable<Counts>): "accepted" | "no-change" => {
	for (const c of counts) {
		if (c.added !== 0n || c.deleted !== 0n || c.put !== 0n) {
			return "accepted"
		}
	}
	return "no-change"
}
