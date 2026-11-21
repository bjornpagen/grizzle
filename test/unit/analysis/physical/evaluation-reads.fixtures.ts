/** What evaluation-reads.test.ts reads: its space, the chains of one-row filters, and the work their analysis does. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Effect } from "effect"
import { analyzePhysical, unplaced } from "#compiler/analysis/physical/analyze.ts"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import { asc, Ir } from "#test/support/fixtures/ir/build.ts"
import { workModel } from "#test/support/fixtures/ir/work.ts"
import { callCounts } from "#test/support/kernel/calls.ts"

/** The depths of the box, one to sixteen filters over the row. */
const depths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] as const

/**
 * One case: a chain of filters `depth` deep over the first row of Account, each of at most one row, so the analysis
 * finishes each with the premise of its own computation (analysis/physical/rules.ts ownPremise), which reads what its
 * evaluation varies with (`evaluationReads`); the chain read as the program's result, or as the one occurrence of a
 * region over it, which reads its source's evaluation reads too (`regionProps`).
 */
export interface Chain {
	readonly read: "whole" | "by a region"
	readonly depth: (typeof depths)[number]
}

export const chainGen: Gen<Chain> = (s) => ({
	read: s.draw(element<Chain["read"]>(["whole", "by a region"])),
	depth: s.draw(element(depths))
})

export type Reached =
	| "a chain read whole"
	| "a chain read by a region"
	| "a chain one deep"
	| "a chain sixteen deep"

/** Case `c`'s chain `depth` deep, built afresh over the Work schema, and the node its program delivers. */
const chainAt = (c: Chain, depth: number) => {
	const q = new Ir(workModel())
	let top: RelNode = q.take(
		q.base("Account"),
		asc("id"),
		{ kind: "literal", k: 1n },
		conservativeMeta
	)
	for (let at = 0; at < depth; at++) {
		top = q.filter(top, q.eq(q.col(top, "name"), q.col(top, "name")))
	}
	const root =
		c.read === "whole"
			? top
			: q.region([{ source: top, bind: { id: "account" }, constants: {} }], conservativeMeta)
	return q.build(root)
}

/**
 * The calls of exprsOf (ir/rel.ts) analyzing case `c`'s chain `depth` deep: the expressions of a node read once for
 * each subtree that asks what its evaluation reads, counted, never timed.
 */
const readsWork = (c: Chain, depth: number): Effect.Effect<number> =>
	Effect.map(
		callCounts(
			Effect.sync(() => {
				const built = chainAt(c, depth)
				return analyzePhysical(built.dag, {
					context: "snapshot",
					catalog: workModel().fixture.catalog,
					realization: unplaced,
					roots: "result"
				})
			}),
			{ exprs: { file: "packages/engine/src/ir/rel.ts", name: "exprsOf" } }
		),
		([, counts]) => counts.exprs
	)

/**
 * Judges case `c`: analyzing its chain `depth` deep reads expressions as often as its chain two deep does and, for
 * each filter more, as often as the third added to the second, each node's own expressions read once, however many
 * subtrees above it ask what their evaluation reads; where each subtree asking walked itself whole and read every
 * expression in it, a filter k deep read k nodes' expressions again, and the reads grew with the square of the depth.
 */
export const judgedChain = (c: Chain, note: (r: Reached) => void): Effect.Effect<void> =>
	Effect.gen(function* () {
		note(c.read === "whole" ? "a chain read whole" : "a chain read by a region")
		if (c.depth === 1) {
			note("a chain one deep")
		}
		if (c.depth === 16) {
			note("a chain sixteen deep")
		}
		const two = yield* readsWork(c, 2)
		const three = yield* readsWork(c, 3)
		assert.ok(three > two, "a filter more reads more")
		const work = yield* readsWork(c, c.depth)
		assert.equal(
			work,
			two + (c.depth - 2) * (three - two),
			`analyzing the chain ${c.depth} deep, read ${c.read}, reads expressions as two filters and ${c.depth - 2} filters more of what the third added do`
		)
	})
