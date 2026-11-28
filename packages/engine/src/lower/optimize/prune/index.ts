import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { analyzeDemand } from "#compiler/analysis/demand/demand.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { localCertificate } from "#compiler/ir/certificate.ts"
import type { Cell, EditNode, EditRefs, Heading, KindOver } from "#compiler/ir/rel.ts"
import { restrictMeta } from "#compiler/lower/optimize/demand/editor.ts"
import {
	type CellDemand,
	cellDemand,
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
	const readers = cx.cells.readers
	const pinned = new Set<NodeId>()
	for (const cell of cx.cells.order) {
		if (
			ed.isRoot(cell) ||
			cx.cells.feedback.has(cell) ||
			readers(cell).some((r) => cx.cells.feedback.has(r))
		) {
			pinned.add(cell.id)
		}
	}
	return pinned
}

/**
 * The demand pruning narrows by, over the DAG the editor holds as the traversal starts: every `pinned` node delivers its
 * whole heading and binds every variable.
 */
const pruneDemand = (cx: RewriteCx, pinned: ReadonlySet<NodeId>): CellDemand => {
	const snapshot = cx.editor.finished()
	return cellDemand(
		snapshot,
		analyzeDemand(snapshot.dag, (node) => pinned.has(node.id))
	)
}

const restrict = (heading: Heading, keep: (name: string) => boolean): Heading =>
	heading.filter((c) => keep(c.name))

/**
 * Which nodes a prune narrows: every node but the sources, while a rewrite that reads two scans of one relation by
 * their whole headings is still to run (R03's key join folds two scans of a key into the first, which then binds what
 * both bind; the catalog's shapes take two scans for one source where their headings agree, catalog/context.ts
 * sameSource); and, once none is (`sourcePrunePass`), every node, the sources too.
 */
type Reach = "aboveSources" | "withSources"

/**
 * A scan of a stored relation narrowed to the columns its readers demand, and its primary key where a reader tells its
 * rows apart (`identified`), so each row it delivers there is still one stored row, keyed as it was, and no reader's
 * multiplicity or deduplication changes; a scan no reader tells the rows of apart, an existence read's, every reader a
 * region whose occurrence of it binds no variable the region keeps, delivers what its readers demand alone, its
 * conditions' columns, and holds no key, since no row of any reader holds anything of its rows. It keeps each other
 * declared key whose columns it keeps, and each generated field whose generation reads only columns it keeps, the
 * field among them (ir/rel.ts StoredBase generated), so every key and generation it states names its heading's columns
 * alone, where a generation reading a column it dropped named a determinant the scan does not deliver, which the logical
 * analysis of the narrowed DAG refuses (logical/closure.ts determinantsAt). A view's scan, a derived relation's or a
 * world relation's, delivers its whole heading: the keys it carries (ir/rel.ts ViewBase) are proved over the view's
 * columns and their classes together.
 */
const narrowedBase = (
	node: KindOver<"Base", EditRefs>,
	demanded: ReadonlySet<string>,
	identified: boolean
): EditNode | undefined => {
	if (node.relationKind !== "relation") {
		return undefined
	}
	const keep = (n: string) => demanded.has(n) || (identified && node.primaryKey.includes(n))
	const heading = restrict(node.heading, keep)
	return heading.length === node.heading.length
		? undefined
		: {
				...node,
				heading,
				keys: node.keys.filter((k) => k.every(keep)),
				generated: node.generated.filter((g) => keep(g.field) && g.reads.every(keep))
			}
}

/**
 * A delta narrowed to the columns its readers demand and its relation's primary key, the first of its keys, so a delta
 * keyed by its relation stays keyed and one its relation does not key (a rule's region, a world relation's) delivers a
 * row for each it delivered before; it keeps each other key whose columns it keeps. The relation it reads names each
 * field's column (lower/conservative/types.ts DeltaRelation), so it reads the fields it keeps.
 */
const narrowedDelta = (
	node: KindOver<"Delta", EditRefs>,
	demanded: ReadonlySet<string>
): EditNode | undefined => {
	const [primary] = node.keys
	const keep = (n: string) => demanded.has(n) || primary?.includes(n) === true
	const heading = restrict(node.heading, keep)
	return heading.length === node.heading.length
		? undefined
		: { ...node, heading, keys: node.keys.filter((k) => k.every(keep)) }
}

/**
 * A root delivers its heading; a node on a recursive step, or read by one, is the recursion's. Such a node keeps
 * its form: a pinned region's source loses only columns the region leaves unbound, its witnesses.
 */
const step = (cx: RewriteCx, reach: Reach): void => {
	const ed = cx.editor
	const pinnedNodes = prunePinned(cx)
	const d = pruneDemand(cx, pinnedNodes)
	const order = cx.cells.order
	const changed: Array<NodeId> = []
	/**
	 * Whether a reader of `cell` tells its rows apart: one that is no region, or a region whose occurrence of it binds a
	 * variable the region keeps live. An occurrence that binds none only tests whether a row its constants hold stands,
	 * an existence read, however deep it stands: the region's rows hold nothing of it.
	 */
	const identified = (cell: Cell): boolean =>
		cx.cells.readers(cell).some((reader) => {
			const r = reader.current
			if (r.kind !== "MatchRegion") {
				return true
			}
			const live = d.liveVars(reader)
			return r.occurrences.some((o) => o.source === cell && o.bindings.some((b) => live.has(b.var)))
		})
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
			case "Step":
			case "SemiJoin":
			case "AntiJoin": {
				const below = (node.kind === "Filter" || node.kind === "Step" ? node.input : node.left)
					.current.heading
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
				return reach === "withSources" ? narrowedBase(node, demanded, identified(cell)) : undefined
			case "Delta":
				return reach === "withSources" ? narrowedDelta(node, demanded) : undefined
			case "Closed":
			case "Context":
			case "InputSet":
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
			case "Call":
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
		cx.certify(
			localCertificate(
				pruneRule,
				changed,
				changed,
				changed,
				ed.roots.flatMap((r) => r.current.heading.map((c) => c.name))
			)
		)
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
 * - a filter, a navigation's step, a semi-join or an anti-join takes its (left) input's narrowed heading, a step's
 *   rows being its input's, unchanged;
 * - a single-heading union's arms are narrowed to its demanded columns and its literal discriminant; an arm that keeps
 *   wider columns for another reader is read through a projection onto exactly those;
 * - in the last prune (`sourcePrunePass`), a scan of a stored relation and a delta are narrowed to the columns their
 *   readers demand and their primary key (`narrowedBase`, `narrowedDelta`), so no statement reads a relation's
 *   columns that nothing reads: a rule's probe reads a qti node's columns its matches bind, never all forty.
 *
 * A node's readers depend only on its demanded columns, so each reader's set is unchanged; where a projection now
 * collapses rows the dedup placement decides again, on the narrower heading. Nothing on a recursive step, and no root,
 * changes, and no source does before the last prune (Reach). Such a pinned node keeps its form, so the demand this
 * pass narrows by treats it as delivering its whole heading and, for a region, binding every variable: its inputs
 * keep every column its unchanged body reads, a pinned projection's undemanded outputs and a pinned region's dead
 * bindings included. Logical keys are kept where their columns survive, since a key of a set is a key of
 * every projection that retains it.
 *
 * The pass is one traversal, so it terminates.
 */
export const prunePass = traversalPass({ name: "prune", step: (cx) => step(cx, "aboveSources") })

/** The last prune, after every rewrite that reads two scans of one relation by their whole headings (Reach). */
export const sourcePrunePass = traversalPass({
	name: "prune.sources",
	step: (cx) => step(cx, "withSources")
})
