import { subtree } from "#compiler/check/approximate/trace.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { RelDag, RelNode } from "#compiler/ir/rel.ts"

/** Nodes in the order of their labels. */
const byLabel = (a: RelNode, b: RelNode): number => compareStrings(a.id, b.id)

/** The approximate searches a node's rows are computed from, in label order. */
const approximateSources = (node: RelNode): ReadonlyArray<RelNode> =>
	[...subtree(node)].filter((n) => n.kind === "ApproximateNearest").toSorted(byLabel)

type ApproximateUse = "recursion" | "page" | "law" | "derived"

interface ApproximateMisuse {
	readonly use: ApproximateUse
	/**
	 * The node that would read candidates as exact evidence: the Recursive or Forbid, the root of a paged query, or the
	 * root of a derived definition.
	 */
	readonly consumer: RelNode
	readonly approximate: RelNode
	readonly capability: string
}

const capabilityOf = (
	use: ApproximateUse,
	consumerNode: RelNode,
	approximateNode: RelNode
): string => {
	const consumer = consumerNode.id
	const approximate = approximateNode.id
	switch (use) {
		case "recursion":
			return `recursion: approximate source ${approximate} feeding ${consumer}: approximate candidates are not a complete relation, and they never enter recursive feedback`
		case "page":
			return `approximateNearest: approximate candidates ${approximate} under the page ${consumer}; exact page membership never rests on approximate retrieval, and two searches need not retrieve the same set`
		case "law":
			return `approximateNearest: approximate candidates ${approximate} in the violation query ${consumer} of a law; approximation never proves a law`
		case "derived":
			return `approximateNearest: approximate candidates ${approximate} in a derived relation's definition, whose stored rows and inherited keys every reader takes as exact evidence`
	}
}

/**
 * The banned use of approximate candidates by a page over a compiled query's result, or undefined. The page compiler
 * wraps the checked query (lower/shapes/page/compile.ts), so the consumer is the query's root: every page request
 * re-runs the query, and two searches need not retrieve the same set.
 */
export const approximatePageMisuse = (root: RelNode): ApproximateMisuse | undefined => {
	const [approximate] = approximateSources(root)
	return approximate === undefined
		? undefined
		: {
				use: "page",
				consumer: root,
				approximate,
				capability: capabilityOf("page", root, approximate)
			}
}

/**
 * Approximate provenance and the uses it bans.
 *
 * The compiler preserves that provenance through projection, joins, aggregates, imports and further filters. Count over candidates counts retrieved candidates, not all matches. Absence from candidates does not prove absence from the eligible source. Approximate sources establish no database law and enter no recursive feedback. Provenance is structural: a node's rows are approximate exactly when an
 * ApproximateNearest node lies among the nodes they are computed from, whatever lies between, so no composition can
 * launder it. It labels a result approximate (a template whose DAG holds one runs a bounded search whose underfill is
 * allowed), and it bans four uses, each a place where approximate completeness would become exact evidence:
 *
 * - recursive feedback: a Recursive node whose base or step reads candidates (the checker's
 *   recursion scan refuses the stage first, with capability `recursion: approximate source`);
 * - a page: keyset pages re-run their query per page, and two approximate executions need not retrieve the same set,
 *   so a page over candidates could skip or repeat facts; exact page membership never rests on approximate retrieval
 *   (there is no combined vector cursor);
 * - a law: a violation query (Forbid) over candidates would accept a state as lawful because a search missed the
 *   violating fact (approximation never proves a law);
 * - a derived relation: its definition's rows are stored and its keys become the unique indexes every later query
 *   reads as base-scan evidence, so a definition over candidates would store one search's
 *   recall as facts and serve it as exact evidence.
 *
 * The first banned use of approximate candidates among the nodes a DAG's roots reach, or undefined. `derivedDefinition`
 * marks the DAG as a derived relation's definition.
 */
export const approximateMisuse = (
	dag: RelDag,
	options: { readonly derivedDefinition: boolean }
): ApproximateMisuse | undefined => {
	const misuse = (use: ApproximateUse, consumer: RelNode, inputs: ReadonlyArray<RelNode>) => {
		for (const input of inputs) {
			const [approximate] = approximateSources(input)
			if (approximate !== undefined) {
				return { use, consumer, approximate, capability: capabilityOf(use, consumer, approximate) }
			}
		}
		return undefined
	}
	for (const node of topoOrder(dag).toSorted(byLabel)) {
		const found =
			node.kind === "Recursive"
				? misuse("recursion", node, [node.base, node.step])
				: node.kind === "Forbid"
					? misuse("law", node, [node.violation])
					: undefined
		if (found !== undefined) {
			return found
		}
	}
	const derived = options.derivedDefinition ? dag.roots : []
	for (const root of derived) {
		const found = misuse("derived", root, [root])
		if (found !== undefined) {
			return found
		}
	}
	return undefined
}
