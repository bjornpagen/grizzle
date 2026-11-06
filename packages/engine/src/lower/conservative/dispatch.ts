import type { NodeId } from "#compiler/core/ids.ts"
import { extendNonEmpty, isNonEmpty } from "#compiler/core/nonempty.ts"
import { postorder } from "#compiler/ir/dag.ts"
import { edgesOf, type NodeOf, type RelKind, type RelNode } from "#compiler/ir/rel.ts"
import { antiJoinLowering } from "#compiler/lower/conservative/anti-join/index.ts"
import { attachLowering } from "#compiler/lower/conservative/attach/index.ts"
import { baseLowering } from "#compiler/lower/conservative/base/index.ts"
import { contextLowering } from "#compiler/lower/conservative/claims/index.ts"
import { closedLowering } from "#compiler/lower/conservative/closed/index.ts"
import {
	type Env,
	type LowerContext,
	type Lowerers,
	type NodeLowerer,
	outputNames,
	type ShareFrame
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
import { takeLowering } from "#compiler/lower/conservative/take/index.ts"
import { unionLowering } from "#compiler/lower/conservative/union/index.ts"
import { approximateNearestLowering } from "#compiler/lower/conservative/vector/index.ts"
import { windowLowering } from "#compiler/lower/conservative/window/index.ts"
import { type Cte, isSetQuery, type OperandSelect } from "#compiler/sql/ast.ts"
import { cteRead } from "#compiler/sql/build.ts"

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
	...orderedSetAggregateLowering
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
				: loweredInputs(node).flatMap((input) => [...(open.get(input) ?? noRecursions)])
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
			(open.get(node) ?? noRecursions).size === 0 &&
			[...cx.scopeOf(node).outer.keys()].every((id) => !inside.has(id))
		if (shares) {
			shared.add(node)
		}
		const times = shares ? "once" : counted
		for (const input of loweredInputs(node)) {
			lowered.set(input, plus(lowered.get(input), times))
		}
	}
	return shared
}

/** `query` with `ctes` leading its WITH. */
const leading = <Q extends OperandSelect>(query: Q, ctes: ReadonlyArray<Cte>): Q =>
	isNonEmpty(ctes)
		? {
				...query,
				with:
					query.with === undefined
						? { ctes, recursive: false }
						: { ...query.with, ctes: extendNonEmpty(ctes, query.with.ctes) }
			}
		: query

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
	const frame: ShareFrame = { outer, shared, cx, env, defined: new Map(), ctes: [] }
	const query = plugIn(node, cx.withSharing(frame), env)
	return leading(query, frame.ctes)
}

/**
 * The query of `node` inside `frame`, unless a frame shares it: a node that reads outer values opens a frame of its
 * own, where a node it lowers more than once that reads only those values is shared, so the row they come from binds
 * its CTE once per row; any other node is its plug-in's query.
 */
const owned = (node: RelNode, cx: LowerContext, env: Env, frame: ShareFrame): OperandSelect =>
	cx.scopeOf(node).outer.size > 0 ? framed(node, cx, env, frame) : plugIn(node, cx, env)

/** A read of the CTE `home` holds for `node`, defined at its first use, its body lowered where `home`'s root was. */
const sharedRead = (node: RelNode, cx: LowerContext, home: ShareFrame): OperandSelect => {
	const origin = { kind: "node", node: node.id } as const
	let cte = home.defined.get(node)
	if (cte === undefined) {
		const query = owned(node, home.cx.withSharing(home), home.env, home)
		const name = cx.relationAlias(origin)
		const columns = cx.supply.columns(outputNames(node.heading).map(() => origin))
		home.ctes.push({ name, columns, materialized: "MATERIALIZED", query })
		cte = { name, columns, set: isSetQuery(query) }
		home.defined.set(node, cte)
	}
	return cteRead(cx.relationAlias(origin), cte)
}

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
