import type { Justification } from "#compiler/analysis/physical/fds.ts"
import {
	fdsOf,
	keyedBy,
	type PhysicalProps,
	plainKeyedBy
} from "#compiler/analysis/physical/props.ts"
import type { KeySet, NodeOf, RelNode } from "#compiler/ir/rel.ts"

/**
 * Complete contributions to a fold.
 *
 * "Before folding, record the complete bound tuple B. An optimization may use a narrower physical identity K only if K
 * determines B under current evidence and the surviving input has exactly one contribution for each B. It must not
 * remove a deliberately bound tag ID, nor automatically bind an omitted row ID." For every fold this module records:
 *
 * - B, exactly as the node states it: a Group's bound tuple (the checker's complete binding, hidden equality
 *   variables aside), or the whole input heading of an ordered-set aggregate or a window;
 * - whether the input, as realized, has exactly one row per B: B determines a physical key of the input under the
 *   input's own dependencies (fixed columns, equalities, key-implied dependencies), and on what; otherwise elimination
 *   is owed on B, never on a narrower or a wider tuple;
 * - whether an input DISTINCT is removable: B determines a key proved without the input's own
 *   duplicate elimination. An input realized `distinct` has one row per B because of that DISTINCT, which proves
 *   nothing about removing it: binding only (account, amount) keeps the inner DISTINCT;
 * - the narrowest identity a deduplication may compare on instead: a minimal K within B that determines B under the
 *   input's dependencies. Distinct K values are then exactly distinct B values, because K lies within B.
 *
 * Posting(id, account, amount) keyed by id with B = (account, amount) owes a DISTINCT on (account, amount); with
 * B = (id, account, amount) the base key proves one row per B and the DISTINCT is elided, so two postings with equal
 * amounts both contribute.
 */
export interface Contribution {
	readonly node: FoldNode
	readonly input: RelNode
	readonly bound: KeySet
	readonly keys: KeySet
	readonly identity: ContributionIdentity
	/** A minimal subset of B that determines B, with the dependencies that make it so. */
	readonly narrowest: KeySet
	readonly narrowing: Justification
}

/**
 * Whether the input, as realized, has exactly one row per value of B, and how: then the input key B determines, with
 * its justification. The key holds without the input's own duplicate elimination (removable), and `removal` is the
 * justification that makes an input DISTINCT removable, which never cites that DISTINCT; or only through it (exact),
 * and no DISTINCT is removable. Otherwise elimination is owed on B.
 */
type ContributionIdentity =
	| {
			readonly kind: "removable"
			readonly key: KeySet
			readonly proof: Justification
			readonly removal: Justification
	  }
	| { readonly kind: "exact"; readonly key: KeySet; readonly proof: Justification }
	| { readonly kind: "owed" }

export type FoldNode = NodeOf<"Group"> | NodeOf<"OrderedSetAggregate"> | NodeOf<"Window">

/** The complete bound tuple of a fold. */
const boundTuple = (node: FoldNode, input: PhysicalProps): KeySet =>
	node.kind === "Group" ? node.bound : input.columns

export const contributionOf = (node: FoldNode, input: PhysicalProps): Contribution => {
	const bound = boundTuple(node, input)
	const keys =
		node.kind === "Group" ? node.keys : node.kind === "Window" ? node.partition : node.keys
	const fds = fdsOf(input)
	/** Greedy minimization from the end of B: drop a column while the rest still determines all of B. */
	let narrowest = [...bound]
	for (let i = narrowest.length - 1; i >= 0; i--) {
		const without = narrowest.toSpliced(i, 1)
		if (fds.determines(without, bound)) {
			narrowest = without
		}
	}
	const narrowing = fds.explain(fds.closure(narrowest), bound)
	const found = keyedBy(input, bound)
	if (found === undefined) {
		return {
			node,
			input: node.input,
			bound,
			keys,
			identity: { kind: "owed" },
			narrowest,
			narrowing
		}
	}
	const plain = plainKeyedBy(input, bound)
	/**
	 * The key keyedBy (or plainKeyedBy) just proved: the first one, in key order, inside the bound's closure, which is the
	 * first option its one requirement met.
	 */
	const [[proved]] = (plain ?? found).inside
	const key = proved.columns
	const proof = found.just
	return {
		node,
		input: node.input,
		bound,
		keys,
		identity:
			plain === undefined
				? { kind: "exact", key, proof }
				: { kind: "removable", key, proof, removal: plain.just },
		narrowest,
		narrowing
	}
}
