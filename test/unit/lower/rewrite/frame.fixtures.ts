/** What the properties of frame.test.ts read: its spaces, models and helpers. */

import type { Need } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { relNode } from "#compiler/ir/dag.ts"
import { metaSpecOf, type Roots, type ValidDag } from "#compiler/ir/rel.ts"
import {
	relationalRewrites,
	semanticSimplification
} from "#compiler/lower/optimize/demand/phases.ts"
import { existencePass } from "#compiler/lower/optimize/existence/index.ts"
import { fusePass } from "#compiler/lower/optimize/fuse/index.ts"
import { simplifyPass } from "#compiler/lower/optimize/simplify/index.ts"
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

/** What the finish suite reaches: a redefinition that changes a node, a cell an edit kept, a cell above a redefined one. */
export type FinishFeature =
	| "a redefinition that changes a node's content"
	| "a cell an edit kept"
	| "a cell above a redefined one"

/** What the search built once before its cases (chain), now once per worker: every case on it reads them. */
export const chainNeed = {
	key: "test/unit/lower/rewrite/frame.fixtures.ts chainNeed",
	open: Effect.sync(() => {
		const chain = [
			semanticSimplification,
			relationalRewrites,
			simplifyPass,
			existencePass,
			fusePass,
			relationalRewrites
		]
		return Effect.succeed(chain)
	})
} as const satisfies Need<unknown>

/** What the search built once before its cases (passes), now once per worker: every case on it reads them. */
export const passesNeed = {
	key: "test/unit/lower/rewrite/frame.fixtures.ts passesNeed",
	open: Effect.sync(() => {
		const passes = [semanticSimplification, relationalRewrites]
		return Effect.succeed(passes)
	})
} as const satisfies Need<unknown>
