/**
 * The rewrite driver (lower/optimize/demand/frame.ts rewritePass) keeps its cells' order across edits and resumes its
 * scan, so its work at each firing is what the firing's edits reach, never the DAG:
 *
 * - the editor's kept order (lower/optimize/demand/order.ts KeptOrder) is, after any edits, the walk's postorder of the
 *   cells the roots reach, every label rising along it, whatever the edits moved, and through a cycle a rewrite made;
 * - the driver's work at a firing, the verdicts it takes and the cells' shapes it reads, is the same however many cells
 *   the firing's edits leave alone;
 * - the driver fires the same rule at the same cell at every state as a scan of every cell from the first, drawing every
 *   fresh label as that scan draws it: a cell where every rule settled false is passed over only while nothing it read
 *   moved, and a verdict that drew a label is taken again at every state.
 *
 * Oracle: a second implementation of each: the walk of the cells from the roots (walkOf); the doubling of the cells the
 * edits leave alone, under which the work at the firings must not move (a metamorphic law); and the driver as it was, a
 * scan of every cell at every state (scannedSimplification), whose DAG and certificates the driver's must equal.
 *
 * Features: a kept segment moved, a cell left and joined the order, several cells changed before a state, a root moved,
 * a cycle; a simplification that rewrote and one that changed nothing.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite, int, subset } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import type { Cell, EditNode } from "#compiler/ir/rel.ts"
import { DagEditor } from "#compiler/lower/optimize/demand/editor.ts"
import { rewritePass } from "#compiler/lower/optimize/demand/frame.ts"
import { simplifyPass } from "#compiler/lower/optimize/simplify/index.ts"
import { succeeded } from "#test/support/assert.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { caseQuery, ledgerCatalog, passContext } from "#test/support/unit/lower/rewrite/support.ts"
import {
	editOrder,
	foldChain,
	type OrderFeature,
	orderEdits,
	orderMoves,
	scanned,
	scannedSimplification,
	sharedDags,
	type ToyFeature,
	toyPotential,
	toyRuleNames,
	toyRules,
	walkOf,
	wakeGadget,
	wakes,
	workSites
} from "#test/unit/lower/rewrite/driver.fixtures.ts"
import type { StructureFeature } from "#test/unit/lower/rewrite/frame.fixtures.ts"

/**
 * The kept order is the walk's postorder after any edits: over small DAGs that share their nodes (sharedDags) and up to ten edits at their reached
 * cells (a cell redirected to a copy of itself, emptied, restored, given another cell's node, redirected to another
 * cell, or given an ancestor's node, a cycle), each followed by a state or by another edit first, the editor's order at
 * every state is the walk of the cells its roots reach (walkOf), each cell's label above the one before it.
 *
 * Budget: 120 runs and 120 steered cases, the frame-determinism suite's.
 */
export const theKeptOrderIsTheWalksPostorderOfTheCellsTheRootsReachAfterAnyEdits = property.explore(
	(s) => ({ query: s.draw(sharedDags), edits: s.draw(orderEdits) }),
	{
		needs: {},
		budget: { runs: 120, steered: 120 },
		situations: [
			"a kept segment moved",
			"a cell left the order",
			"a cell joined the order",
			"several cells changed before a state",
			"a root moved",
			"a cycle"
		] satisfies ReadonlyArray<Reached<OrderFeature>>,
		check: (_, c: Case<OrderFeature>) => (drawn) =>
			Effect.sync(() => {
				const editor = new DagEditor(drawn.query.dag)
				const emptied = new Map<Cell, EditNode>()
				const holds = (): ReadonlyArray<Cell> => {
					const order = editor.topoOrder()
					assert.deepEqual(
						Arr.map(order, (cell) => cell.id),
						Arr.map(walkOf(editor.roots), (cell) => cell.id),
						"the kept order is the walk's"
					)
					for (const [i, cell] of order.entries()) {
						const before = order[i - 1]
						if (before !== undefined) {
							assert.ok(
								defined(editor.labelAt(before), "a label") <
									defined(editor.labelAt(cell), "a label"),
								`${cell.id}'s label is above ${before.id}'s`
							)
						}
					}
					return order
				}
				let before = holds()
				let edits = 0
				for (const edit of drawn.edits) {
					for (const reached of editOrder(editor, edit, emptied)) {
						c.note(reached)
					}
					edits++
					if (edit.next === "a state taken") {
						if (edits > 1) {
							c.note("several cells changed before a state")
						}
						const after = holds()
						for (const moved of orderMoves(before, after)) {
							c.note(moved)
						}
						before = after
						edits = 0
					}
				}
				holds()
			}),
		oracle: {
			kind: "second-implementation",
			name: "the walk of the cells the roots reach, from each root in order, depth first over each cell's edges"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/demand/order.ts",
				original: "\t\t\tif (within(remaining, low, high)) {\n\t\t\t\treturn false\n\t\t\t}\n",
				replacement: "",
				why: "A run takes a kept segment whole though a changed cell lies in it, keeping the segment's old walk: the order is no walk's."
			},
			{
				file: "packages/engine/src/lower/optimize/demand/order.ts",
				original: "\t\t\tremaining.size === 0 &&\n\t\t\tpending.size === 0 &&\n",
				replacement: "\t\t\tremaining.size === 0 &&\n",
				why: "A run ends while a kept cell it reached ahead of its place is still to come, which the kept order then holds twice and the walk once."
			},
			{
				file: "packages/engine/src/lower/optimize/demand/order.ts",
				original: "\t\t\t\tdropped.push(cursor)\n",
				replacement: "",
				why: "A run passes a kept cell no root reaches now but keeps its place, so once an edit reaches it again the walk takes it for reached already: the order lacks a cell the walk reaches."
			}
		]
	}
)

/**
 * The driver's work at a firing is what the firing's edits reach: over a box of chains of regions under filters that
 * always hold (foldChain), each filter folded into the region below it in turn, the verdicts the driver takes and the
 * kept shapes it reads for one more filter, a firing more, are the same over twice the regions as over the regions,
 * which no fold touches. Where every state walked every cell and judged every one before its firing, both grow with the
 * regions.
 *
 * Oracle: a metamorphic law, the work's difference for one more firing unmoved by doubling the cells the firings leave
 * alone, by V8's call counts.
 */
export const theDriversWorkAtAFiringIsTheRegionItsEditsReachNeverTheCellsTheyLeaveAlone =
	property.exhaust(
		finite((source) => ({
			regions: source.draw(int(8, 16)),
			filters: source.draw(int(1, 3))
		})),
		{
			box: "a chain of 8 to 16 regions under one to three filters that always hold, and the chain twice as long",
			needs: {},
			situations: [],
			check: () => (box) =>
				Effect.gen(function* () {
					const work = (regions: number, filters: number) =>
						Effect.map(
							callCounts(
								Effect.sync(() =>
									succeeded(
										simplifyPass.run(
											foldChain(regions, filters),
											passContext({ catalog: ledgerCatalog, evidence: "snapshot" })
										)
									)
								),
								workSites
							),
							([, counts]) => counts
						)
					const firing = (regions: number) =>
						Effect.gen(function* () {
							const fewer = yield* work(regions, box.filters)
							const more = yield* work(regions, box.filters + 1)
							return {
								verdicts: more.verdicts - fewer.verdicts,
								shapes: more.shapes - fewer.shapes
							}
						})
					const narrow = yield* firing(box.regions)
					const wide = yield* firing(2 * box.regions)
					assert.deepEqual(wide, narrow, "the work of one more firing over twice the regions")
				}),
			oracle: {
				kind: "universal",
				name: "the work of one more firing unmoved by doubling the cells no firing touches"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/optimize/demand/editor.ts",
					original: "\t\treturn { kept: known, moved: known.patch(this.roots, touched) }\n",
					replacement:
						"\t\tconst kept = new KeptOrder(this.roots, (cell) => this.#entryOf(cell).shape.edges, (cell) => this.#reach.has(cell))\n\t\tthis.#kept = kept\n\t\treturn { kept, moved: kept.cells(kept.generation) }\n",
					why: "Every state walks every cell the roots reach again, as before the order was kept: the shapes read for a firing grow with the regions."
				},
				{
					file: "packages/engine/src/lower/optimize/demand/quiet.ts",
					original: "\t\tif (asked || hearing.whole || this.#editor.draws !== hearing.draws) {\n",
					replacement: "\t\tif (true) {\n",
					why: "No cell is ever quiet, so every state judges every cell before its firing, as before the scan resumed: the verdicts for a firing grow with the regions."
				}
			]
		}
	)

/**
 * The driver passes over a quiet cell only while nothing it read moved: over small DAGs that share their nodes (sharedDags) and passes of toy rules
 * (toyRules: a filter over an input one reference reads, a cell over an empty input, a cell beside an empty sibling, a
 * projection that draws a label and holds), a drawn subset in the roster's order, each firing emptying its cell under a name holding a fresh
 * label, the driver's DAG is that of the driver as it was, a scan of every cell at every state (scanned): every cell a
 * firing's reach, subtree or readers moved is judged again, and every one that drew judged again at every state.
 *
 * Oracle: a second implementation, the driver as it was.
 *
 * Budget: 120 runs and 120 steered cases, the structure property's.
 */
export const aQuietCellIsJudgedAgainOnceAnythingItsVerdictReadMovesAsAScanOfEveryCellWouldJudgeIt =
	property.explore(
		(s) => ({
			query: s.draw(sharedDags),
			rules: s.draw(subset(toyRuleNames, { min: 1, max: toyRuleNames.length }))
		}),
		{
			needs: {},
			budget: { runs: 120, steered: 120 },
			situations: [
				"a pass that emptied a cell",
				"a pass that emptied nothing"
			] satisfies ReadonlyArray<Reached<ToyFeature>>,
			check: (_, c: Case<ToyFeature>) => (drawn) =>
				Effect.sync(() => {
					const rules = Arr.map(drawn.rules, (name) => toyRules[name])
					const query = drawn.query
					const scannedCtx = passContext({ catalog: ledgerCatalog, evidence: "snapshot" })
					const expected = scanned(rules, "toy", query, scannedCtx)
					const ctx = passContext({ catalog: ledgerCatalog, evidence: "snapshot" })
					const driven = succeeded(
						rewritePass({ name: "toy", rules, potential: toyPotential }).run(query, ctx)
					)
					c.note(driven === query ? "a pass that emptied nothing" : "a pass that emptied a cell")
					assert.deepEqual(driven.dag, expected.dag, "the driver's DAG is the scan's")
				}),
			oracle: {
				kind: "second-implementation",
				name: "a pass of toy rules as a scan of every cell at every state runs it"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/optimize/demand/quiet.ts",
					original: "\t\t\tif (parent.label <= entry.label) {\n",
					replacement: "\t\t\tif (parent.label >= entry.label) {\n",
					why: "The queue hands out the latest queued cell first, so the driver empties cells in another order than a scan from the first, and names them by other labels."
				}
			]
		}
	)

/**
 * A quiet cell wakes where a firing moved what it read, and a verdict that drew is taken at every state: over a box of
 * gadgets (wakeGadget), each a union whose first arm holds a cell quiet since the first state that fires once a later
 * firing moves its subtree, a reach it read or its reader's other input, or a projection that draws at every state
 * before a later firing, and every subset of the toy rules, the driver's DAG is the scan of every cell's (scanned).
 *
 * Oracle: a second implementation, the driver as it was.
 */
export const aQuietCellWakesWhereAFiringMovedItsSubtreeAReachItReadOrItsReadersInputs =
	property.exhaust(
		finite((source) => ({
			wake: source.draw(int(0, wakes.length - 1)),
			rules: source.draw(subset(toyRuleNames, { min: 1, max: toyRuleNames.length }))
		})),
		{
			box: "each gadget, a union whose first arm a later firing must wake, under every subset of the toy rules",
			needs: {},
			situations: [],
			check: () => (box) =>
				Effect.sync(() => {
					const rules = Arr.map(box.rules, (name) => toyRules[name])
					const query = wakeGadget(defined(wakes[box.wake], "a wake"))
					const scannedCtx = passContext({ catalog: ledgerCatalog, evidence: "snapshot" })
					const expected = scanned(rules, "toy", query, scannedCtx)
					const ctx = passContext({ catalog: ledgerCatalog, evidence: "snapshot" })
					const driven = succeeded(
						rewritePass({ name: "toy", rules, potential: toyPotential }).run(query, ctx)
					)
					assert.deepEqual(driven.dag, expected.dag, "the driver's DAG is the scan's")
				}),
			oracle: {
				kind: "second-implementation",
				name: "a pass of toy rules as a scan of every cell at every state runs it"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/optimize/demand/quiet.ts",
					original: "\t\tfor (const cell of moves.stamped) {\n\t\t\tthis.#wake(cell)\n",
					replacement: "\t\tfor (const cell of moves.stamped) {\n",
					why: "A quiet cell stays quiet though a node of its own subtree changed: the region over the filter that emptied is never emptied."
				},
				{
					file: "packages/engine/src/lower/optimize/demand/quiet.ts",
					original: "\t\t\tthis.#wakeAll(this.#bySubtree, cell)\n",
					replacement: "",
					why: "A quiet cell stays quiet though a node of a subtree it read through its readers changed: the first arm beside the second that emptied is never emptied."
				},
				{
					file: "packages/engine/src/lower/optimize/demand/quiet.ts",
					original:
						"\t\tfor (const label of moves.reach) {\n\t\t\tthis.#wakeAll(this.#byReach, label)\n\t\t}\n",
					replacement: "",
					why: "A quiet cell stays quiet though a reach it read moved: the filter left the one reader of its input is never emptied."
				},
				{
					file: "packages/engine/src/lower/optimize/demand/quiet.ts",
					original: "\t\tif (asked || hearing.whole || this.#editor.draws !== hearing.draws) {\n",
					replacement: "\t\tif (asked || hearing.whole) {\n",
					why: "The projection whose verdict drew a label is quiet, so the state the union empties it at never draws that label again, and the empty relation is named by another label than the scan's."
				}
			]
		}
	)

/**
 * The driver fires as a scan of every cell does: over generated queries, the semantic simplification's DAG and
 * certificates are those of the driver as it was, a scan of every cell from the first at every state
 * (scannedSimplification), so no cell it passed over as quiet would have fired.
 *
 * Oracle: a second implementation, the driver as it was.
 *
 * Budget: 120 runs and 120 steered cases, the structure property's.
 */
export const theDriverFiresTheRuleAScanOfEveryCellFromTheFirstFiresAtEveryState = property.explore(
	queryCaseGen(defaultGenConfig),
	{
		needs: {},
		budget: { runs: 120, steered: 120 },
		situations: [
			"a simplification that rewrote",
			"a simplification that changed nothing"
		] satisfies ReadonlyArray<Reached<StructureFeature>>,
		check: (_, c: Case<StructureFeature>) => (generated) =>
			Effect.sync(() => {
				const query = caseQuery(generated)
				const scannedCtx = passContext({
					catalog: genCatalog(generated.schema),
					evidence: "snapshot"
				})
				const scanned = scannedSimplification(query, scannedCtx)
				const ctx = passContext({ catalog: genCatalog(generated.schema), evidence: "snapshot" })
				const driven = succeeded(simplifyPass.run(query, ctx))
				c.note(
					ctx.certificates.all().length > 0
						? "a simplification that rewrote"
						: "a simplification that changed nothing"
				)
				assert.deepEqual(driven.dag, scanned.dag, "the driver's DAG is the scan's")
				assert.deepEqual(ctx.certificates.all(), scannedCtx.certificates.all(), "its certificates")
			}),
		oracle: {
			kind: "second-implementation",
			name: "the semantic simplification as a scan of every cell at every state runs it"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/demand/quiet.ts",
				original: "\t\t\tif (parent.label <= entry.label) {\n",
				replacement: "\t\t\tif (parent.label >= entry.label) {\n",
				why: "The queue hands out the latest queued cell first, so the driver fires at a cell after the first where a rule fires, where a scan from the first would not."
			}
		]
	}
)
