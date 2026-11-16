/** What the properties of frame.test.ts read: its spaces, models and helpers. */

import { relNode } from "#compiler/ir/dag.ts"
import { metaSpecOf, type Roots, type ValidDag } from "#compiler/ir/rel.ts"
import { rebuildDag } from "#test/support/dag.ts"

/** Where the rewritten root sits among a DAG's roots: first, the query's own, or after it. */
export type RootPosition = "the query's root" | "a later root"

/**
 * A fresh copy of a DAG: every node rebuilt under its own label over its inputs' copies (dag.ts rebuildDag), each shared
 * node copied once, so the copy holds the same content in objects no pass has seen.
 */
export const freshCopy = <R extends Roots>(dag: ValidDag<R>): ValidDag<R> =>
	rebuildDag(dag, (node, inputs) => relNode(node.id, { ...inputs, meta: metaSpecOf(node.meta) }))

/** What the frame suites reach: a pass that delivered the DAG it was given, and one that changed it. */
export type FrameFeature = "a pass delivered the settled DAG" | "a pass changed the DAG"
