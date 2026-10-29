import { parentReads, parentRefusal } from "#compiler/check/approximate/attach.ts"
import {
	outerReads,
	outerRefusal,
	subtree,
	traceApproximate
} from "#compiler/check/approximate/trace.ts"
import type { ApproximatePlugin, ApproximateStage, CheckServices } from "#compiler/check/context.ts"
import { fail, unwrap } from "#compiler/check/fail.ts"
import type { ParamId } from "#compiler/core/ids.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { dagDigest } from "#compiler/ir/dag.ts"
import type { Heading, RelNode } from "#compiler/ir/rel.ts"

export { hnswPolicy } from "#compiler/check/approximate/policy.ts"
export { approximateMisuse, approximatePageMisuse } from "#compiler/check/approximate/provenance.ts"

/**
 * approximateNearest: the eligibility check and the sealed node. Approximate retrieval is explicit and still
 * relational.
 *
 * `query.approximateNearest({ by, take })` is the one explicitly approximate node: up to `take` distinct, eligible,
 * completely scored facts of its source, nearest by `by` under a bounded HNSW search. The checker turns
 * the stage into an ApproximateNearest node over the source it has already checked, after the eligibility check the
 * node requires: eligible source, score provenance, bound, parameter bindings, mandatory source sealing:
 *
 * - by names a column of the source's heading; anything else is MalformedDescription (the builder checks it too, but a
 *   JavaScript caller or a Description may not);
 * - eligible source and score provenance: the source is one rule whose `by` output traces to Compute.cosineDistance
 *   between one stored vector of 1-2000 dimensions and one query vector (trace.ts). A score that is not such a
 *   distance, a union, an aggregate, a bound, a vector the rule does not read from a stored relation, or an indexed
 *   vector above HNSW's 2000 dimensions is UnsupportedOperation with a capability that begins `approximateNearest:` and
 *   names what is missing (unsupported shapes are narrowed with clear diagnostics);
 * - parameter bindings and sealing: the source reads no outer row. A source bound to an outer variable, or reading an
 *   attachment's parent variable, by a filter or by a match that binds it, would run one search per outer row, while a
 *   shared approximate source evaluates once per execution and its candidate relation is reused, so it is UnsupportedOperation (attach.ts). The node records the parameters the sealed source depends
 *   on, the bindings fixed for its one evaluation, and `sealed: true`: no later filter, projection or bound enters it
 *   (pushdown, demand and fusion treat it as a boundary), and its heading is the source's whole heading, the candidate
 *   identity;
 * - the bound: `take` is a positive integer, the requested result bound and never a scan budget.
 *
 * Recursive feedback over a candidate set is refused by the recursion scan before this runs. The other banned uses, a
 * page, a law and a derived definition, and a search read inside an attachment's child and outside it, are properties
 * of the whole program, refused where it is lowered (provenance.ts, attach.ts, lower/shapes/vector). The HNSW index a
 * workload program's search requests is the workload extraction's (physical/access), and its lowering is
 * lower/shapes/vector.
 */
export const approximate: ApproximatePlugin = {
	check: (stage, input, loc, cx) => {
		const heading = input.heading
		if (!heading.some((c) => c.name === stage.by)) {
			fail(
				"MalformedDescription",
				loc,
				`approximateNearest: by naming a column of the source's heading; ${JSON.stringify(stage.by)} is none`
			)
		}
		if (!Number.isSafeInteger(stage.take) || stage.take < 1) {
			fail("MalformedDescription", loc, "approximateNearest: take, a positive integer bound")
		}
		/**
		 * A source that reads an attachment's parent variable is a search per parent row, whether a filter compares it
		 * or a match binds it; the latter reaches the source as the Attach's correlation column, not as an outer
		 * reference, so it is found in the source's Description (attach.ts).
		 */
		const parents = parentReads(stage.input)
		if (parents.length > 0) {
			fail("UnsupportedOperation", loc, parentRefusal(parents))
		}
		/**
		 * The source's own subgraph, rooted at it: every node it holds is complete, so the snapshot traces it exactly as
		 * the lowering will, and its identity and parameters are its own. A source whose own subgraph reads a label the
		 * checker has reserved and not defined yet, the enclosing rule's region before its matches are checked or a
		 * recursion whose step is being checked, is an import bound to a variable of the enclosing rule, read once per
		 * outer row.
		 */
		const outer = outerReads(input)
		if (
			outer.some((id) => cx.reserved(id)) ||
			[...subtree(input)].some((n) => n.kind === "SelfRef" && cx.reserved(n.recursive))
		) {
			fail(
				"UnsupportedOperation",
				loc,
				"approximateNearest: a source evaluated once per execution; this one reads a row of the enclosing rule (an import bound to an outer variable), which would run one search per outer row"
			)
		}
		const trace = traceApproximate(input, stage.by)
		if (!trace.ok) {
			fail("UnsupportedOperation", loc, trace.error)
		}
		if (outer.length > 0) {
			fail("UnsupportedOperation", loc, outerRefusal(outer))
		}
		/**
		 * One search per sealed source: a second stage over an equal source, with the same bindings, score and bound, is
		 * the node already built, so every match of it reads one candidate relation, which the CTE policy computes once.
		 * Two HNSW scans of one statement could see different graphs under concurrent inserts, so two
		 * evaluations of one search are not interchangeable with one.
		 */
		const identity = `${unwrap(dagDigest(cx.builder.build([input]), "approximate source"))}\u0000${stage.by}\u0000${stage.take}`
		const shared = cx.searches.get(identity)
		if (shared !== undefined) {
			return shared
		}
		const search = searchNode(stage, input, heading, input.meta.paramDeps, loc, cx)
		cx.searches.set(identity, search)
		return search
	}
}

/** The sealed node: the source's whole heading, its score, its bound and the parameters its one evaluation binds. */
const searchNode = (
	stage: ApproximateStage,
	input: RelNode,
	heading: Heading,
	params: ReadonlyArray<ParamId>,
	loc: SourceLoc,
	cx: CheckServices
): RelNode =>
	cx.node(
		{
			kind: "ApproximateNearest",
			source: input,
			score: stage.by,
			take: BigInt(stage.take),
			params: [...params],
			sealed: true,
			heading
		},
		loc
	)
