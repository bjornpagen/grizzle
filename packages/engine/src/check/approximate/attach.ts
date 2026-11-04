import { subtree } from "#compiler/check/approximate/trace.ts"
import type { ResolvedStage } from "#compiler/check/params.ts"
import { parentUse } from "#compiler/check/scan.ts"
import { appendAll } from "#compiler/core/array.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { inputsOf, keptRowsOf, type NodeOf, type RelDag, type RelNode } from "#compiler/ir/rel.ts"

const prefix = "approximateNearest"

/**
 * The parent variables a source's Description reads, sorted: empty unless it is an attachment child reading its parent.
 */
export const parentReads = (source: ResolvedStage): ReadonlyArray<string> =>
	[...parentUse({ stage: source }).columns].toSorted(compareStrings)

export const parentRefusal = (parents: ReadonlyArray<string>): string =>
	`${prefix}: a source evaluated once per execution; this one reads the parent variable${parents.length === 1 ? "" : "s"} ${parents.join(", ")} of an attachment, so the child's candidates for each parent row are a search of their own, which the first release does not run, and one search over every parent's candidates filtered afterwards would hand each parent an arbitrary share`

/**
 * The searches an attachment's correlation column `column` passes through, traced from the child `start` down to the
 * first node that binds it: a region, or anything that computes rather than carries it.
 */
const searchesOnCorrelation = (start: RelNode, column: string): ReadonlySet<RelNode> => {
	const found = new Set<RelNode>()
	/** Each node's correlation columns met so far. */
	const seen = new Map<RelNode, Set<string>>()
	const queue: Array<readonly [RelNode, string]> = [[start, column]]
	for (const [node, name] of queue) {
		const names = seen.get(node) ?? new Set<string>()
		if (names.has(name)) {
			continue
		}
		names.add(name)
		seen.set(node, names)
		if (node.kind === "ApproximateNearest") {
			found.add(node)
		}
		appendAll(queue, correlationSteps(node, name))
	}
	return found
}

/**
 * Where a correlation column `name` of `node` comes from, the next steps of its trace: the input column a projection
 * carries it from, every arm of a group that has it, both sides of an intersection, the input whose rows a node keeps
 * (rel.ts keptRowsOf); none at a search or a node that binds or computes it.
 */
const correlationSteps = (
	node: RelNode,
	name: string
): ReadonlyArray<readonly [RelNode, string]> => {
	switch (node.kind) {
		case "ProjectSet": {
			const out = node.out.find((o) => o.name === name)
			if (out === undefined) {
				return []
			}
			const expr = out.expr
			return expr.kind === "column" && expr.column.node === node.input.id
				? [[node.input, expr.column.name]]
				: []
		}
		case "Union":
			return node.groups
				.filter((g) => g.heading.some((c) => c.name === name))
				.flatMap((g) => g.arms.map((arm) => [arm, name] as const))
		case "Intersect":
			return [
				[node.left, name],
				[node.right, name]
			]
		case "OrderedResult":
		case "Attach":
		case "Forbid":
		case "Filter":
		case "Take":
		case "SemiJoin":
		case "AntiJoin":
		case "Difference": {
			const kept = keptRowsOf(node)
			return kept === undefined ? [] : [[kept.input, name]]
		}
		case "ApproximateNearest":
		case "Base":
		case "Closed":
		case "InputSet":
		case "Context":
		case "Delta":
		case "MatchRegion":
		case "Group":
		case "Produce":
		case "Recursive":
		case "SelfRef":
		case "Window":
		case "OrderedSetAggregate":
			return []
	}
}

/** The nodes the roots reach without entering `avoid`. */
const reachableAvoiding = (dag: RelDag, avoid: RelNode): ReadonlySet<RelNode> => {
	const seen = new Set<RelNode>()
	const queue = dag.roots.filter((r) => r !== avoid)
	for (const node of queue) {
		if (seen.has(node)) {
			continue
		}
		seen.add(node)
		appendAll(
			queue,
			inputsOf(node).filter((input) => input !== avoid)
		)
	}
	return seen
}

/** The refusal of the search `search` under some attachment of the DAG, or undefined. */
export const attachmentRefusal = (dag: RelDag, search: RelNode): string | undefined => {
	for (const node of topoOrder(dag).toSorted((a, b) => compareStrings(a.id, b.id))) {
		if (node.kind !== "Attach") {
			continue
		}
		const correlated = node.correlation.find((c) =>
			searchesOnCorrelation(node.child, c.child).has(search)
		)
		if (correlated !== undefined) {
			return correlatedRefusal(node, correlated.parent, correlated.child, search)
		}
		if (subtree(node.child).has(search) && reachableAvoiding(dag, node.child).has(search)) {
			return `${prefix}: a search evaluated once per execution; ${search.id} is read by the attachment ${node.name} (${node.id}) and outside its child, and an attachment over an approximate source is a statement of its own, so the two statements would run two searches, which need not retrieve the same set`
		}
	}
	return undefined
}

const correlatedRefusal = (
	node: NodeOf<"Attach">,
	parent: string,
	child: string,
	search: RelNode
): string =>
	`${prefix}: a source evaluated once per execution; the attachment ${node.name} (${node.id}) equates its parent's ${parent} with the column ${child} of the search ${search.id}, bound by the search's own source, so the child's candidates for each parent row would be a search of their own, and one search over every parent's candidates filtered afterwards would hand each parent an arbitrary share`

/**
 * What in a child's subtree makes its attachment a statement of its own whatever its width, or undefined: the
 * structural part of the fusion rule (lower/shapes/attach chooseAttachment).
 */
export const pipelinedOnly = (child: RelNode): string | undefined => {
	const seen = new Set<RelNode>([child])
	const queue = [child]
	for (const [i, node] of queue.entries()) {
		const why = pipelinedReason(node, i === 0)
		if (why !== undefined) {
			return why
		}
		for (const input of inputsOf(node)) {
			if (!seen.has(input)) {
				seen.add(input)
				queue.push(input)
			}
		}
	}
	return undefined
}

/** Why a node of a child's subtree makes its attachment a statement of its own, or undefined; `top` marks the child. */
const pipelinedReason = (node: RelNode, top: boolean): string | undefined => {
	switch (node.kind) {
		case "Recursive":
			return "a recursive child is seeded once from the parent keys"
		case "ApproximateNearest":
			return "an approximate source evaluates once per execution"
		case "Attach":
			return "a child with attachments of its own delivers nested sets"
		case "Union":
			return node.groups.length > 1 && top
				? "a heterogeneous union delivers one statement per group"
				: undefined
		case "Base":
		case "Closed":
		case "InputSet":
		case "Context":
		case "Delta":
		case "MatchRegion":
		case "Filter":
		case "SemiJoin":
		case "AntiJoin":
		case "Intersect":
		case "Difference":
		case "ProjectSet":
		case "Group":
		case "Produce":
		case "SelfRef":
		case "Take":
		case "OrderedResult":
		case "Forbid":
		case "Window":
		case "OrderedSetAggregate":
			return undefined
	}
}

/**
 * The search the rows of `id` read when a statement computes them, or undefined: an attachment's rows are its
 * parent's, so an Attach is followed to its parent only.
 */
const searchInRows = (start: RelNode): RelNode | undefined => {
	const seen = new Set<RelNode>([start])
	const queue = [start]
	for (const node of queue) {
		if (node.kind === "ApproximateNearest") {
			return node
		}
		const fresh = (node.kind === "Attach" ? [node.parent] : inputsOf(node)).filter(
			(input) => !seen.has(input)
		)
		for (const input of fresh) {
			seen.add(input)
		}
		appendAll(queue, fresh)
	}
	return undefined
}

/**
 * The attachments a query delivers, each with whether it attaches to an attachment's child: those on the rows' spine
 * from `root` (every node that keeps its input's rows, rel.ts keptRowsOf, and each heading group of one arm), the
 * spine lower/conservative/deliver.ts delivers, and the attachments on each one's child spine, nested.
 */
const deliveredAttachments = (
	root: RelNode
): ReadonlyArray<{ readonly attach: NodeOf<"Attach">; readonly nested: boolean }> => {
	const out: Array<{ readonly attach: NodeOf<"Attach">; readonly nested: boolean }> = []
	const seen = new Set<RelNode>()
	const walk = (start: RelNode, nested: boolean): void => {
		for (let node: RelNode | undefined = start; node !== undefined && !seen.has(node);) {
			seen.add(node)
			if (node.kind === "Attach") {
				out.push({ attach: node, nested })
				walk(node.child, true)
			}
			const singleArms =
				node.kind === "Union" ? node.groups.flatMap((g) => (g.arms.length === 1 ? g.arms : [])) : []
			for (const only of singleArms) {
				walk(only, nested)
			}
			node = keptRowsOf(node)?.input
		}
	}
	walk(root, false)
	return out
}

/**
 * Approximate searches and attachments: one search per execution, and never one search per parent.
 *
 * An attachment is Nest: for each parent p, the child's facts for p. Two placements of a search under an
 * attachment break the contract that a shared approximate source evaluates once per execution and that its eligible
 * universe is fixed before the bound, so both are refused, as UnsupportedOperation with an
 * `approximateNearest:` capability:
 *
 * - a search whose own source binds a parent variable. The checker delivers the parent variable as a correlation column
 *   of the child, which the Attach equates with the parent's column; when that column comes from the search's own
 *   source, the child's facts for p are the nearest neighbors of p's candidates. One search over every parent's
 *   candidates, filtered to each parent after its bound, would hand each parent an arbitrary share of a global top-k,
 *   which is ruled out (choosing fewer arbitrary global neighbors and filtering afterward is not a substitute), and a
 *   search per parent row is not one evaluation per execution. The correlation travels as the Attach node's correlation
 *   column, not as a column reference inside the source, so outerReads cannot see it; the checker finds the parent
 *   variable in the source's Description (parentUse, check/scan.ts), and the lowering traces each correlation column
 *   from the child down to the first region that binds it, refusing it when it passes through a search on the way. A
 *   search the child only matches, its parent variable bound in the child's own rule above the
 *   search, is sealed and parent-independent: its one evaluation serves every parent, and the child's rule matches it
 *   per parent like any relation.
 * - one search read both inside an attachment's child and outside it. A child over an approximate source is a
 *   pipelined statement of its own (lower/shapes/attach), and nothing hands it the other statement's candidates, so the
 *   two statements would run two searches, which can see different graphs under concurrent inserts and leave a parent
 *   without the attachment of one of its own candidates.
 *
 * A third placement is refused for the same reason, by the checker over the whole query (pipelinedOverSearch), so that
 * both lowerings accept the same programs: an attachment that must be a statement of its own (pipelinedOnly: a
 * recursive, approximate or paged child, a child with attachments of its own, a heterogeneous union, or any attachment
 * of an attachment's child) under rows that read a search. That statement computes its parent's rows again in the same
 * snapshot, so it would run the parent's search a second time, and a delivered parent the second search misses would
 * lose its children. An attachment that is a statement only because of its width is fused under such rows instead
 * (lower/shapes/attach chooseAttachment), so the search runs once.
 *
 * The refusal of an attachment that must be a statement of its own under rows that read a search (see the header),
 * or undefined. Each such attachment's own parent rows are checked: an attachment's child that has attachments of its
 * own is one too, so a search further up the chain is refused at the attachment nearest it.
 */
export const pipelinedOverSearch = (root: RelNode): string | undefined => {
	for (const { attach, nested } of deliveredAttachments(root)) {
		const why = nested
			? "an attachment of an attachment's child is a statement of its own"
			: pipelinedOnly(attach.child)
		if (why === undefined) {
			continue
		}
		const search = searchInRows(attach.parent)
		if (search === undefined) {
			continue
		}
		return `${prefix}: a search evaluated once per execution; the attachment ${attach.name} (${attach.id}) is a statement of its own (${why}), which computes its parent's rows again in the same snapshot, and those rows read the search ${search.id}, so the search would run twice and need not retrieve the same set; query the nearest rows first, then attach to their keys in a second query`
	}
	return undefined
}
