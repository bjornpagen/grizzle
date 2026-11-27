import { postorder } from "@bjornpagen/grizzle-text/base/graph"
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import type { NodeId } from "#compiler/core/ids.ts"
import { edgesOf, type NodeOf, type RelKind, type RelNode } from "#compiler/ir/rel.ts"
import { antiJoinLowering } from "#compiler/lower/conservative/anti-join/index.ts"
import { attachLowering } from "#compiler/lower/conservative/attach/index.ts"
import { baseLowering } from "#compiler/lower/conservative/base/index.ts"
import { callLowering } from "#compiler/lower/conservative/call/index.ts"
import { contextLowering } from "#compiler/lower/conservative/claims/index.ts"
import { closedLowering } from "#compiler/lower/conservative/closed/index.ts"
import {
	cteAtFirstUse,
	type Env,
	freshCtes,
	type LowerContext,
	type Lowerers,
	type NodeLowerer,
	type ShareFrame,
	withLeading
} from "#compiler/lower/conservative/context.ts"
import { deltaLowering } from "#compiler/lower/conservative/delta/index.ts"
import { differenceLowering } from "#compiler/lower/conservative/difference/index.ts"
import { filterLowering } from "#compiler/lower/conservative/filter/index.ts"
import { forbidLowering } from "#compiler/lower/conservative/forbid/index.ts"
import { groupLowering } from "#compiler/lower/conservative/group/index.ts"
import { inputSetLowering } from "#compiler/lower/conservative/input-set/index.ts"
import { intersectLowering } from "#compiler/lower/conservative/intersect/index.ts"
import { matchRegionLowering } from "#compiler/lower/conservative/match-region/index.ts"
import { orderedResultLowering } from "#compiler/lower/conservative/ordered-result/index.ts"
import { orderedSetAggregateLowering } from "#compiler/lower/conservative/ordered-set-aggregate/index.ts"
import { produceLowering } from "#compiler/lower/conservative/producers/index.ts"
import { projectSetLowering } from "#compiler/lower/conservative/project-set/index.ts"
import { recursiveLowering } from "#compiler/lower/conservative/recursive/index.ts"
import { selfRefLowering } from "#compiler/lower/conservative/self-ref/index.ts"
import { semiJoinLowering } from "#compiler/lower/conservative/semi-join/index.ts"
import { stepLowering } from "#compiler/lower/conservative/step/index.ts"
import { takeLowering } from "#compiler/lower/conservative/take/index.ts"
import { unionLowering } from "#compiler/lower/conservative/union/index.ts"
import { approximateNearestLowering } from "#compiler/lower/conservative/vector/index.ts"
import { windowLowering } from "#compiler/lower/conservative/window/index.ts"
import { copyClassesOf } from "#compiler/lower/optimize/cte-policy/index.ts"
import type { OperandSelect } from "#compiler/sql/ast.ts"

/**
 * The kind table of the conservative lowering, written once.
 *
 * Every RelNode kind has exactly one plug-in in its own fixed subdirectory, which exports its one-entry table; this
 * table is their union. A plug-in changes only its own directory and never edits the table. The table's type is a
 * mapped type over the closed kind union, so a kind added to the IR
 * fails to typecheck here until it has a plug-in.
 */
export const conservativeLowerers: Lowerers<RelKind> = {
	...baseLowering,
	...closedLowering,
	...contextLowering,
	...inputSetLowering,
	...deltaLowering,
	...matchRegionLowering,
	...filterLowering,
	...projectSetLowering,
	...semiJoinLowering,
	...antiJoinLowering,
	...unionLowering,
	...intersectLowering,
	...differenceLowering,
	...takeLowering,
	...groupLowering,
	...produceLowering,
	...recursiveLowering,
	...selfRefLowering,
	...approximateNearestLowering,
	...orderedResultLowering,
	...attachLowering,
	...forbidLowering,
	...windowLowering,
	...orderedSetAggregateLowering,
	...stepLowering,
	...callLowering
}

/**
 * One kind's node to its plug-in: the table is a mapped type over the kinds, so its entry at `kind` is the lowerer of
 * exactly the node type `kind` selects.
 */
const dispatchKind = <K extends RelKind>(
	kind: K,
	node: NodeOf<K>,
	cx: LowerContext,
	env: Env
): OperandSelect => {
	const lowerer: NodeLowerer<K> = conservativeLowerers[kind]
	return lowerer(node, cx, env)
}

/** The plug-in's query of a node. */
const plugIn = (node: RelNode, cx: LowerContext, env: Env): OperandSelect =>
	dispatchKind(node.kind, node, cx, env)

/** The inputs a node's plug-in lowers, once per reference: an attachment lowers its parent, and its child is delivered. */
const loweredInputs = (node: RelNode): ReadonlyArray<RelNode> =>
	node.kind === "Attach" ? [node.parent] : edgesOf(node)

/** The innermost of `frame` and the frames around it that shares `node`. */
const frameSharing = (frame: ShareFrame | undefined, node: RelNode): ShareFrame | undefined => {
	for (let f = frame; f !== undefined; f = f.outer) {
		if (f.shared.has(node)) {
			return f
		}
	}
	return undefined
}

const noRecursions: ReadonlySet<NodeId> = new Set()

/** How often a frame's lowering lowers a node it lowers at all: once, or more than once. */
type Lowerings = "once" | "many"

/** A node's lowerings once a consumer lowers it `more` again, from `known`, none when it was not lowered yet. */
const plus = (known: Lowerings | undefined, more: Lowerings): Lowerings =>
	known === undefined ? more : "many"

/**
 * The nodes a frame rooted at `root`, inside `outer`, shares: those its lowering would lower more than once that its
 * root's WITH can hold.
 *
 * Its lowering is counted in one pass, consumers first: the root is lowered once, and each node as many times as its
 * consumers lower it, once per reference, counted as once or many (Lowerings). A node a frame around it shares is
 * read from that frame's CTE, so its inputs are not lowered here. A node lowered at least twice is shared here, and
 * lowered once, when the root's WITH can hold it: it reads no column of a node inside the root, whose row is not in
 * scope at the root's WITH, and no feedback of a recursion around it, which only its recursive term may scan.
 */
const sharedOf = (
	cx: LowerContext,
	root: RelNode,
	outer: ShareFrame | undefined
): ReadonlySet<RelNode> => {
	const order = postorder([root], loweredInputs)
	const inside = new Set(order.map((n) => n.id))
	/** The recursions each node scans the feedback of and does not enclose, inputs first. */
	const open = new Map<RelNode, ReadonlySet<NodeId>>()
	for (const node of order) {
		const scanned =
			node.kind === "SelfRef"
				? [node.recursive]
				: loweredInputs(node).flatMap((input) => [
						...defined(
							open.get(input),
							"an input's open recursions, met before its consumer in postorder"
						)
					])
		const own = scanned.filter((id) => node.kind !== "Recursive" || id !== node.id)
		open.set(node, own.length === 0 ? noRecursions : new Set(own))
	}
	const lowered = new Map<RelNode, Lowerings>([[root, "once"]])
	const shared = new Set<RelNode>()
	for (const node of order.toReversed()) {
		const counted = lowered.get(node)
		if (counted === undefined || (node !== root && frameSharing(outer, node) !== undefined)) {
			continue
		}
		const shares =
			node !== root &&
			counted === "many" &&
			defined(open.get(node), "the open recursions of a node in the postorder").size === 0 &&
			[...cx.scopeOf(node).outer.keys()].every((id) => !inside.has(id))
		if (shares) {
			shared.add(node)
		}
		const times = shares ? "once" : counted
		for (const input of loweredInputs(node)) {
			lowered.set(input, plus(lowered.get(input), times))
		}
	}
	/**
	 * Copies of one sub-query (cte-policy copyClassesOf), each lowered once, are one node lowered as often as all of them
	 * are: shared here where every copy may be, one CTE of the class (sharedRead), the first copy's lowering its body.
	 */
	const firstOf = copyClassesOf(cx.dag, readsWholeHere)
	const copies = new Map<RelNode, Array<RelNode>>()
	for (const node of order) {
		copies.getOrInsertComputed(firstOf(node), () => []).push(node)
	}
	for (const all of copies.values()) {
		if (
			all.length > 1 &&
			all.every(
				(c) =>
					c !== root &&
					lowered.get(c) !== undefined &&
					defined(open.get(c), "the open recursions of a node in the postorder").size === 0 &&
					[...cx.scopeOf(c).outer.keys()].every((id) => !inside.has(id))
			)
		) {
			for (const c of all) {
				shared.add(c)
			}
		}
	}
	return shared
}

/** Every node the conservative lowering prints stands behind its set boundary, computed whole at each read. */
const readsWholeHere = (): "distinct" => "distinct"

/**
 * The query of `node` in a frame of its own inside `outer`, its shared nodes' CTEs leading its WITH. A frame inside
 * another is opened only where it shares a node, so a node lowered inside one with nothing to share is its plug-in's
 * query.
 */
const framed = (
	node: RelNode,
	cx: LowerContext,
	env: Env,
	outer: ShareFrame | undefined
): OperandSelect => {
	const shared = sharedOf(cx, node, outer)
	if (outer !== undefined && shared.size === 0) {
		return plugIn(node, cx, env)
	}
	const frame: ShareFrame = { outer, shared, cx, env, table: freshCtes() }
	const query = plugIn(node, cx.withSharing(frame), env)
	return withLeading(query, frame.table.ctes)
}

/**
 * The query of `node` inside `frame`, unless a frame shares it: a node that reads outer values opens a frame of its
 * own, where a node it lowers more than once that reads only those values is shared, so the row they come from binds
 * its CTE once per row; any other node is its plug-in's query.
 */
const owned = (node: RelNode, cx: LowerContext, env: Env, frame: ShareFrame): OperandSelect =>
	cx.scopeOf(node).outer.size > 0 ? framed(node, cx, env, frame) : plugIn(node, cx, env)

/**
 * A read of the CTE `home` holds for `node`'s class of copies (cte-policy copyClassesOf), defined at the class's first
 * use, its body lowered where `home`'s root was.
 */
const sharedRead = (node: RelNode, cx: LowerContext, home: ShareFrame): OperandSelect =>
	cteAtFirstUse(
		cx,
		node,
		home.table,
		copyClassesOf(cx.dag, readsWholeHere)(node),
		"MATERIALIZED",
		() => owned(node, home.cx.withSharing(home), home.env, home)
	)

/**
 * The one dispatch: a node to its kind's plug-in, every node a query's lowering would lower more than once lowered
 * once.
 *
 * A lowering entered from outside any node, a statement's rows, a parent's rows computed again or an attachment's
 * child, is the root of a frame (ShareFrame): each node its lowering reaches more than once becomes one MATERIALIZED
 * CTE of the root's query, read at every use. A node that reads outer values cannot be computed at a WITH where they
 * are not in scope, so it is shared in the frame of the nearest node inside the row that supplies them: the
 * consumer that binds them places that node's query LATERAL or inside EXISTS, so its WITH is evaluated once per outer
 * row. A node reading feedback stays in its recursive term. So the text of a statement grows with the DAG it lowers,
 * never with the number of paths through it.
 */
export const dispatchNode = (node: RelNode, cx: LowerContext, env: Env): OperandSelect => {
	const frame = cx.sharing
	if (frame === undefined) {
		return framed(node, cx, env, undefined)
	}
	const home = frameSharing(frame, node)
	return home === undefined ? owned(node, cx, env, frame) : sharedRead(node, cx, home)
}
