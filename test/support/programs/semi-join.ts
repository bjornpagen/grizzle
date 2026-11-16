/**
 * The names the semi-join program reads (test/types/ir/semi-join.ts), its prelude (test/support/prelude.ts): the
 * program imports these alone, each through this module.
 */
export type { DagBuilder } from "#compiler/ir/builder.ts"
export {
	builtSides,
	type Cell,
	conservativeMeta,
	type NodeOf,
	type RelNode,
	semiJoinRight
} from "#compiler/ir/rel.ts"
export { cellGraph, type DagEditor } from "#compiler/lower/optimize/demand/editor.ts"
