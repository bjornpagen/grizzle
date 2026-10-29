import type { NodeOf, RelKind, RelNode } from "#compiler/ir/rel.ts"
import { antiJoinLowering } from "#compiler/lower/conservative/anti-join/index.ts"
import { attachLowering } from "#compiler/lower/conservative/attach/index.ts"
import { baseLowering } from "#compiler/lower/conservative/base/index.ts"
import { contextLowering } from "#compiler/lower/conservative/claims/index.ts"
import { closedLowering } from "#compiler/lower/conservative/closed/index.ts"
import type {
	Env,
	LowerContext,
	Lowerers,
	NodeLowerer
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
import type { Select } from "#compiler/sql/ast.ts"

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
): Select => {
	const lowerer: NodeLowerer<K> = conservativeLowerers[kind]
	return lowerer(node, cx, env)
}

/** The one dispatch: a node to its kind's plug-in. */
export const dispatchNode = (node: RelNode, cx: LowerContext, env: Env): Select =>
	dispatchKind(node.kind, node, cx, env)
