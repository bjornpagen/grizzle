import { analyzeDemand } from "#compiler/analysis/demand/demand.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import type { Cell, EditNode, Heading } from "#compiler/ir/rel.ts"
import { restrictMeta } from "#compiler/lower/optimize/demand/editor.ts"
import {
	type CellDemand,
	cellDemand,
	nodePremises,
	type RewriteCx,
	traversalPass
} from "#compiler/lower/optimize/demand/frame.ts"

const pruneRule = "prune.heading"

/**
 * The cells pruning leaves as they are: every root (it delivers its heading), every cell on a recursive step, and every
 * cell a step reads (the recursion owns its feedback region). By label, which the demand analysis's nodes share.
 */
const prunePinned = (cx: RewriteCx): ReadonlySet<NodeId> => {
	const ed = cx.editor
	const readers = ed.readers()
	const pinned = new Set<NodeId>()
	for (const cell of ed.topoOrder()) {
		if (
			ed.isRoot(cell) ||
			ed.readsFeedback(cell) ||
			readers(cell).some((r) => ed.readsFeedback(r))
		) {
			pinned.add(cell.id)
		}
	}
	return pinned
}

/** The demand pruning narrows by: every `pinned` node delivers its whole heading and binds every variable. */
const pruneDemand = (cx: RewriteCx, pinned: ReadonlySet<NodeId>): CellDemand => {
	const snapshot = cx.dag()
	return cellDemand(
		snapshot,
		analyzeDemand(snapshot.dag, (node) => pinned.has(node.id))
	)
}

const restrict = (heading: Heading, keep: (name: string) => boolean): Heading =>
	heading.filter((c) => keep(c.name))

/**
 * A root delivers its heading; a node on a recursive step, or read by one, is the recursion's. Such a node keeps
 * its form: a pinned region's source loses only columns the region leaves unbound, its witnesses.
 */
const step = (cx: RewriteCx): void => {
	const ed = cx.editor
	const pinnedNodes = prunePinned(cx)
	const d = pruneDemand(cx, pinnedNodes)
	const order = ed.topoOrder()
	const changed: Array<NodeId> = []
	/** A node narrowed to its demanded columns, or undefined when it keeps its form. */
	const pruned = (
		cell: Cell,
		node: EditNode,
		demanded: ReadonlySet<string>
	): EditNode | undefined => {
		switch (node.kind) {
			case "MatchRegion": {
				const live = d.liveVars(cell)
				const dead = new Set(node.vars.filter((v) => !live.has(v)).map((v) => v.id))
				if (dead.size === 0) {
					return undefined
				}
				return {
					...node,
					vars: node.vars.filter((v) => !dead.has(v.id)),
					occurrences: node.occurrences.map((o) => ({
						...o,
						bindings: o.bindings.filter((b) => !dead.has(b.var.id))
					})),
					heading: restrict(node.heading, (n) =>
						node.vars.some((v) => v.name === n && !dead.has(v.id))
					)
				}
			}
			case "ProjectSet": {
				const out = node.out.filter((o) => demanded.has(o.name))
				if (out.length === node.out.length) {
					return undefined
				}
				return { ...node, out, heading: restrict(node.heading, (n) => demanded.has(n)) }
			}
			case "Group": {
				const aggs = node.aggs.filter((a) => demanded.has(a.name))
				if (aggs.length === node.aggs.length) {
					return undefined
				}
				const names = new Set([...node.keys, ...aggs.map((a) => a.name)])
				return { ...node, aggs, heading: restrict(node.heading, (n) => names.has(n)) }
			}
			case "Filter":
			case "SemiJoin":
			case "AntiJoin": {
				const below = (node.kind === "Filter" ? node.input : node.left).current.heading
				if (below.length === node.heading.length) {
					return undefined
				}
				const names = new Set(below.map((c) => c.name))
				return { ...node, heading: restrict(node.heading, (n) => names.has(n)) }
			}
			case "Union": {
				const [group, ...others] = node.groups
				if (others.length > 0) {
					return undefined
				}
				const keep = (n: string) => demanded.has(n) || node.discriminant.includes(n)
				const heading = restrict(node.heading, keep)
				if (heading.length === node.heading.length) {
					return undefined
				}
				const arms = mapNonEmpty(group.arms, (arm) => {
					const armNode = arm.current
					const armHeading = armNode.heading
					const exact =
						armHeading.length === heading.length &&
						heading.every((c) => armHeading.some((a) => a.name === c.name))
					if (exact) {
						return arm
					}
					const narrowed = restrict(armHeading, keep)
					return ed.add({
						kind: "ProjectSet",
						input: arm,
						out: narrowed.map((c) => ({ name: c.name, expr: ed.column(arm, c) })),
						heading: narrowed,
						meta: restrictMeta(armNode.meta, narrowed),
						loc: undefined
					})
				})
				return {
					...node,
					heading,
					groups: [{ heading: restrict(group.heading, keep), arms }]
				}
			}
			case "Base":
			case "Closed":
			case "Context":
			case "InputSet":
			case "Delta":
			case "Intersect":
			case "Difference":
			case "Take":
			case "Produce":
			case "Recursive":
			case "SelfRef":
			case "ApproximateNearest":
			case "OrderedResult":
			case "Attach":
			case "Forbid":
			case "Window":
			case "OrderedSetAggregate":
				return undefined
		}
	}
	for (const cell of order) {
		const node = cell.current
		if (pinnedNodes.has(cell.id)) {
			continue
		}
		const next = pruned(cell, node, d.demanded(cell))
		if (next !== undefined) {
			ed.set(cell, { ...next, meta: restrictMeta(node.meta, next.heading) })
			changed.push(cell.id)
		}
	}
	if (changed.length > 0) {
		cx.certify({
			rule: pruneRule,
			inputs: changed,
			outputs: changed,
			premises: nodePremises(...changed),
			context: "queryLocal",
			preservedHeading: ed.roots.flatMap((r) => r.current.heading.map((c) => c.name)),
			equality: [],
			coercion: [],
			params: undefined
		})
	}
}

/**
 * The pruning pass: one traversal from the sources up.
 *
 * Pruning: drop the columns no consumer's result depends on.
 *
 * "Push predicates toward their sources and prune unused columns where semantics permit. Preserve the complete
 * distinct binding input to aggregates, including bound variables omitted from the answer." Demand analysis
 * (analysis/demand) says which columns of each node some reader's result depends on; this pass narrows every node
 * whose meaning lets it shed the rest, in one traversal from the sources up:
 *
 * - a region's dead variable (not demanded, not joining, not equated, not correlated, not read laterally) is no longer
 *   bound: its column becomes an existential witness, which is how an omitted field is meant to be
 *   matched;
 * - a projection drops its undemanded outputs, and a group its undemanded aggregates, never a key: a group's key and
 *   its whole bound tuple B are its contribution identity, which demand analysis keeps demanded;
 * - a filter, semi-join or anti-join takes its (left) input's narrowed heading;
 * - a single-heading union's arms are narrowed to its demanded columns and its literal discriminant; an arm that keeps
 *   wider columns for another reader is read through a projection onto exactly those.
 *
 * A node's readers depend only on its demanded columns, so each reader's set is unchanged; where a projection now
 * collapses rows the dedup placement decides again, on the narrower heading. Nothing on a recursive step, no root, and
 * no source relation changes. Such a pinned node keeps its form, so the demand this pass narrows by treats it as
 * delivering its whole heading and, for a region, binding every variable: its inputs
 * keep every column its unchanged body reads, a pinned projection's undemanded outputs and a pinned region's dead
 * bindings included. Logical keys are kept where their columns survive, since a key of a set is a key of
 * every projection that retains it.
 *
 * The pass is one traversal, so it terminates.
 */
export const prunePass = traversalPass({ name: "prune", step })
