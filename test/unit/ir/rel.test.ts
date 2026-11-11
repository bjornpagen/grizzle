/**
 * The RelNode family's structural readers (ir/rel.ts), over the every-kind fixture and generated DAGs.
 *
 * - Structural map: a node's edges and expressions are listed exactly as its structural map meets them, in its order,
 *   and the map restates the node unchanged. Oracle: the structural map, driven, against edgesOf and exprsOf.
 * - Kept rows: a node keeps rows only of a data input whose heading is its own, and delivers that input exactly when it
 *   keeps every row. Oracle: the kept-rows rule as a checker.
 *
 * Features: every node kind; each kind that keeps rows, and one keeping every row.
 *
 * Plants: ir-rel-attach-child-unlisted (an attachment's child missing from its edges), ir-rel-attach-keeps-child (an
 * attachment keeps its child's rows).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { constant, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { makeIdSupply } from "#compiler/core/ids.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { drive } from "#compiler/ir/fold.ts"
import {
	deliveredInput,
	edgesOf,
	exprsOf,
	inputsOf,
	keptRefs,
	keptRowsOf,
	type LiveRefs,
	mapNode,
	type RelKind,
	type RelNode,
	relKinds
} from "#compiler/ir/rel.ts"
import { assert, contains } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { everyKind } from "#test/unit/ir/fixture.ts"
import { generatedDags } from "#test/unit/ir/population.ts"

const dags = weighted([
	[1, constant(everyKind(makeIdSupply()).dag)],
	[4, generatedDags]
])

describe("the RelNode family", () => {
	it.effect(
		"lists a node's edges and expressions exactly as its structural map meets them, and restates it unchanged",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "the structural map (mapNode, driven) as the edge and expression listings' reference"
						},
						suite: "unit/ir/rel-structural-map",
						literal: Formatter.format,
						draw: drawn(dags),
						runs: 100,
						shrink: completeShrink,
						coverage: required<`a ${RelKind}`>(
							Arr.map(relKinds, (kind): `a ${RelKind}` => `a ${kind}`),
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(dag, c) =>
						Effect.sync(() => {
							for (const node of topoOrder(dag)) {
								c.note(`a ${node.kind}`)
								const yielded: Array<RelNode> = []
								const restated: Array<ScalarExpr> = []
								const same = drive(
									mapNode<LiveRefs, LiveRefs>(node, {
										...keptRefs,
										expr: (e) => {
											restated.push(e)
											return e
										}
									}),
									(edge) => {
										yielded.push(edge)
										return edge
									}
								)
								assert.deepEqual(same, node)
								assert.deepEqual<ReadonlyArray<RelNode>>(
									yielded,
									edgesOf(node),
									`${node.kind} ${node.id} edges`
								)
								assert.deepEqual<ReadonlyArray<ScalarExpr>>(
									restated,
									exprsOf(node),
									`${node.kind} ${node.id} expressions`
								)
							}
						})
				)
			)
	)

	it.effect("keeps rows only of a data input whose heading is its own, for every kind", (ctx) => {
		type Keeping = "Filter" | "Take" | "OrderedResult" | "Attach" | "Forbid"
		return searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "a node keeps rows only of a data input of its own heading, and delivers it exactly when it keeps every row"
					},
					suite: "unit/ir/rel-kept-rows",
					literal: Formatter.format,
					draw: drawn(dags),
					runs: 100,
					shrink: completeShrink,
					coverage: required<`keeps rows of a ${RelKind}` | "keeps every row">(
						[
							"keeps every row",
							...Arr.map(
								[
									"Filter",
									"Take",
									"OrderedResult",
									"Attach",
									"Forbid"
								] satisfies ReadonlyArray<Keeping>,
								(kind): `keeps rows of a ${RelKind}` => `keeps rows of a ${kind}`
							)
						],
						{ cases: 100, sense: notesOnly }
					),
					kept: [],
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(dag, c) =>
					Effect.sync(() => {
						for (const node of topoOrder(dag)) {
							const kept = keptRowsOf(node)
							if (kept === undefined) {
								continue
							}
							c.note(`keeps rows of a ${node.kind}`)
							if (kept.keeps === "every") {
								c.note("keeps every row")
							}
							contains(inputsOf(node), kept.input)
							assert.deepEqual(kept.input.heading, node.heading, `${node.kind} ${node.id}`)
							assert.equal(deliveredInput(node), kept.keeps === "every" ? kept.input : undefined)
						}
					})
			)
		)
	})
})
