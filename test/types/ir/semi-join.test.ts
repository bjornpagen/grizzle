/**
 * A semi-join's right side (test/types/ir/semi-join.ts), one program the type batch checks disarmed: over every node
 * kind of the IR's roster, built, and the editor's cell, a node's constructor takes a semi-join over the right side
 * semiJoinRight minted, refuses one over the node as it is, and takes an anti-join over the node as it is. Oracle: the
 * representation's own contract (rel.ts SemiJoinRight), that only the mint, which reads the right side's subtree for a
 * column of the left, makes a semi-join's right side; the analysis reads a column the right side fixes as fixed per
 * evaluation of the semi-join (logical/props.ts), which a right side reading its left would break.
 *
 * @plant test/plants/types/ir/semi-join-right-plain.patch A semi-join's right side is a plain node (rel.ts SemiJoinRight
 * is the node itself), so a node as it is, correlated on its left or not, stands there unread; the program fails, every
 * refusal's directive unused.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"

layer(NodeServices.layer, { excludeTestServices: true })("a semi-join's right side", (it) => {
	it.effect(
		"over every node kind and the editor's cell, a semi-join takes the minted right side and refuses the node as it is, which an anti-join takes",
		() =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("ir/semi-join")
				assert.deepEqual(actual, expected)
			})
	)
})
