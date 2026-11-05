import type { Justification } from "#compiler/analysis/physical/fds.ts"
import { keyedBy, type PhysicalProps, plainKeyedBy } from "#compiler/analysis/physical/props.ts"
import type { KeySet, NodeOf, RelNode } from "#compiler/ir/rel.ts"

/**
 * Complete contributions to a catalog fold: an ordered-set aggregate or a window, whose bound tuple B is its input's
 * whole heading. A Group has none of its own: its bound tuple is proved a key of its input (ir/rel.ts FoldInput), so its
 * input, distinct over its heading as placement realizes it, holds one row per B.
 *
 * "An optimization may use a narrower physical identity K only if K determines B under current evidence and the
 * surviving input has exactly one contribution for each B." For every catalog fold this module records:
 *
 * - B, the whole input heading;
 * - whether the input, as realized, has exactly one row per B: B determines a physical key of the input under the
 *   input's own dependencies (fixed columns, equalities, key-implied dependencies), and on what; otherwise elimination
 *   is still owed on the input, which placement discharges before the fold reads it;
 * - whether an input DISTINCT is removable: B determines a key proved without the input's own duplicate elimination.
 *   An input realized `distinct` has one row per B because of that DISTINCT, which proves nothing about removing it;
 * - the narrowest identity a deduplication may compare on instead: a minimal K within B that determines B under the
 *   input's dependencies. Distinct K values are then exactly distinct B values, because K lies within B.
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

export type FoldNode = NodeOf<"OrderedSetAggregate"> | NodeOf<"Window">

export const contributionOf = (node: FoldNode, input: PhysicalProps): Contribution => {
	const bound = input.columns
	const keys = node.kind === "Window" ? node.partition : node.keys
	/** Greedy minimization from the end of B: drop a column while the rest still determines all of B. */
	let narrowest = [...bound]
	for (let i = narrowest.length - 1; i >= 0; i--) {
		const without = narrowest.toSpliced(i, 1)
		if (input.dependencies.determines(without, bound)) {
			narrowest = without
		}
	}
	const narrowing = input.dependencies.explain(input.dependencies.closure(narrowest), bound)
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
	/** The key keyedBy (or plainKeyedBy) just proved: the canonical minimal key among B's columns (fds.ts keyAmong). */
	const key = (plain ?? found).key
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
