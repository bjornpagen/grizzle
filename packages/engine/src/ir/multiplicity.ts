import type { NodeId } from "#compiler/core/ids.ts"
import {
	type Comparator,
	combine,
	compareNumbers,
	compareStrings,
	mapInput
} from "#compiler/core/order.ts"
import type { Cardinality } from "#compiler/ir/cardinality.ts"
import type { Premise } from "#compiler/ir/evidence.ts"
import type { KeySet } from "#compiler/ir/rel.ts"

/**
 * How a consumer treats repeats of its input: it passes them on, cannot see them (an emptiness test, a
 * set operator that absorbs them), or changes meaning because of them (COUNT, SUM, LIMIT, pagination, row numbering,
 * recursive feedback, a public stream, a storage operation).
 */
export type ConsumerSensitivity = "preserves" | "ignores" | "observes"

export interface PhysicalKey {
	/** Sorted, duplicate-free column names. */
	readonly columns: KeySet
	readonly proof: ReadonlyArray<Premise>
}

/** Whether duplicate elimination is still owed on a node's rows: nothing, or on an exact heading. */
export type Owed = { readonly kind: "none" } | { readonly kind: "on"; readonly heading: KeySet }

export const nothingOwed: Owed = Object.freeze({ kind: "none" })

/**
 * Physical multiplicity records.
 *
 * The logical promise that every node denotes a set is NodeMeta's; whether a node's current SQL realizes it is this
 * record's, and the two are never confused, so physical uniqueness is never inferred from a node being a set. A record holds the physical candidate keys with their proof dependencies, the maximum
 * cardinality where known, the exact heading on which duplicate elimination is still owed, and which consumers can
 * observe multiplicity. Records are optimization-only metadata in a map beside the DAG, computed by
 * analysis/physical; the conservative lowering never reads them.
 *
 * Keys are kept as a bounded antichain under set inclusion, not an exhaustive dependency closure: a key that contains another key is redundant and is never stored.
 */
export interface MultiplicityRecord {
	readonly keys: ReadonlyArray<PhysicalKey>
	/** The most rows the node yields. */
	readonly maxCard: Cardinality
	readonly owed: Owed
	readonly observers: ReadonlyArray<ConsumerSensitivity>
}

export type MultiplicityMap = Readonly<Record<NodeId, MultiplicityRecord>>

const sortedColumns = (columns: KeySet): KeySet =>
	Object.freeze([...new Set(columns)].toSorted(compareStrings))

const isSubset = (small: KeySet, large: KeySet): boolean => small.every((c) => large.includes(c))

/**
 * Smaller keys first, then canonical column order: the deterministic policy that decides which keys a full antichain
 * keeps.
 */
const keyOrder: Comparator<PhysicalKey> = combine(
	mapInput(compareNumbers, (k: PhysicalKey) => k.columns.length),
	mapInput(compareStrings, (k: PhysicalKey) => k.columns.join("\u0000"))
)

/**
 * Adds a key to an antichain of at most `bound` keys. A key containing an existing key is redundant and changes
 * nothing; existing keys containing the new key are dropped. When the antichain is full, the largest keys under the
 * deterministic order are dropped: forgetting a key is always sound, because fewer keys prove less.
 */
export const insertKey = (
	chain: ReadonlyArray<PhysicalKey>,
	key: PhysicalKey,
	bound: number
): ReadonlyArray<PhysicalKey> => {
	const candidate: PhysicalKey = { columns: sortedColumns(key.columns), proof: key.proof }
	if (chain.some((k) => isSubset(k.columns, candidate.columns))) {
		return chain
	}
	const kept = chain.filter((k) => !isSubset(candidate.columns, k.columns))
	return Object.freeze([...kept, candidate].toSorted(keyOrder).slice(0, Math.max(0, bound)))
}
