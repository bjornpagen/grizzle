/** What the properties of frame.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Need } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { relNode } from "#compiler/ir/dag.ts"
import { type Cell, edgesOf, metaSpecOf, type Roots, type ValidDag } from "#compiler/ir/rel.ts"
import {
	relationalRewrites,
	semanticSimplification
} from "#compiler/lower/optimize/demand/phases.ts"
import { existencePass } from "#compiler/lower/optimize/existence/index.ts"
import { fusePass } from "#compiler/lower/optimize/fuse/index.ts"
import { simplifyPass } from "#compiler/lower/optimize/simplify/index.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { rebuildDag } from "#test/support/dag.ts"
import type { CountedFunction } from "#test/support/kernel/calls.ts"

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
	budget: fixtureNeedBudget,
	runNeeds: [],
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
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.sync(() => {
		const passes = [semanticSimplification, relationalRewrites]
		return Effect.succeed(passes)
	})
} as const satisfies Need<unknown>

/**
 * What the structure property counts: each state's cells worked out for its rules (frame.ts rewriteCx), each state of
 * the cells taken (editor.ts DagEditor cellState), how a finished DAG's nodes are read worked out whole (analysis/demand
 * structureOf), a finished DAG's recursive steps worked out in a walk of their own (editor.ts feedbackReadsOf), and the
 * demand of the DAG's columns (analyzeDemand).
 */
export const structureSites = Object.freeze({
	rewriteCx: { file: "packages/engine/src/lower/optimize/demand/frame.ts", name: "rewriteCx" },
	state: { file: "packages/engine/src/lower/optimize/demand/editor.ts", name: "#state" },
	structureOf: { file: "packages/engine/src/analysis/demand/demand.ts", name: "structureOf" },
	feedbackReadsOf: {
		file: "packages/engine/src/lower/optimize/demand/editor.ts",
		name: "feedbackReadsOf"
	},
	analyzeDemand: { file: "packages/engine/src/analysis/demand/demand.ts", name: "analyzeDemand" }
} satisfies Readonly<Record<string, CountedFunction>>)

/** What the reach property counts: each reference the editor's reach moves (editor.ts Reach #reachStep). */
export const reachSites = Object.freeze({
	step: { file: "packages/engine/src/lower/optimize/demand/editor.ts", name: "#reachStep" }
} satisfies Readonly<Record<string, CountedFunction>>)

/** One edit the reach property makes at the reached cell its index picks among a state's cells, by kind. */
export interface ReachEdit {
	readonly at: number
	readonly kind: "redirected to a copy" | "emptied" | "restored"
}

/** Up to eight edits, each at a cell an index picks among the cells reached when it is made. */
export const reachEdits: Gen<ReadonlyArray<ReachEdit>> = array(
	(s) => ({
		at: s.draw(int(0, 1000)),
		kind: s.draw(element(["redirected to a copy", "emptied", "restored"] as const))
	}),
	{ min: 1, max: 8 }
)

/** What the reach property reaches. */
export type ReachFeature =
	| "a cell's inputs taken out of reach"
	| "a cell's inputs brought back into reach"
	| "a root moved"
	| "a state read after later edits"

/** The cells `roots` reach through data edges, each with how many references it has, as structureOf counts them. */
export const reachedOf = (roots: ReadonlyArray<Cell>): ReadonlyMap<Cell, number> => {
	const counts = new Map<Cell, number>()
	const steps = [...roots]
	for (let at = steps.pop(); at !== undefined; at = steps.pop()) {
		const was = counts.get(at) ?? 0
		counts.set(at, was + 1)
		if (was === 0) {
			for (const input of edgesOf(at.current)) {
				steps.push(input)
			}
		}
	}
	return counts
}

/** What the structure property reaches: a simplification that rewrote, and one that changed nothing. */
export type StructureFeature =
	| "a simplification that rewrote"
	| "a simplification that changed nothing"

/** What the redirection property reaches: a reader through either kind of reference, a root moved, a cell left as it was. */
export type RedirectFeature =
	| "a reader through a data edge"
	| "a reader through a column reference"
	| "a root moved"
	| "a cell left as it was"

/** What the potential property counts: each reading of a filter the simplification potential takes (rules.ts filterReading). */
export const potentialSites = Object.freeze({
	filterReading: {
		file: "packages/engine/src/lower/optimize/simplify/rules.ts",
		name: "filterReading"
	}
} satisfies Readonly<Record<string, CountedFunction>>)

/** What the potential property reaches: a simplification that rewrote, and a filter whose input cell changed node. */
export type PotentialFeature =
	| "a simplification that rewrote"
	| "a filter read again over its input's new node"

/**
 * What the readers property counts: each state of the cells worked out (editor.ts DagEditor cellState), a driver's for
 * its rules or a rule's for its own edit, and each reader map worked out over one (DagEditor.readersIn).
 */
export const readersSites = Object.freeze({
	state: { file: "packages/engine/src/lower/optimize/demand/editor.ts", name: "#state" },
	readers: { file: "packages/engine/src/lower/optimize/demand/editor.ts", name: "#keptReaders" },
	walked: { file: "packages/engine/src/lower/optimize/demand/editor.ts", name: "readersIn" }
} satisfies Readonly<Record<string, CountedFunction>>)

/** What the readers property reaches: a state whose readers a rule read. */
export const readersFeatures = ["a state whose readers a rule read"] as const

export type ReadersFeature = (typeof readersFeatures)[number]

/**
 * What the shape property counts: each cell the editor made and each node set in a cell (editor.ts Readers created and
 * changed), and each reading of what a node reads (editor.ts nodeShape).
 */
export const shapeSites = Object.freeze({
	created: { file: "packages/engine/src/lower/optimize/demand/editor.ts", name: "created" },
	changed: { file: "packages/engine/src/lower/optimize/demand/editor.ts", name: "changed" },
	nodeShape: { file: "packages/engine/src/lower/optimize/demand/editor.ts", name: "nodeShape" }
} satisfies Readonly<Record<string, CountedFunction>>)
