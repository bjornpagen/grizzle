/**
 * R01 fusion (lower/optimize/fuse): an imported stage written as a region under filters and renames is inlined into the
 * region that matches it, preserving the complete bound tuple and every aggregate boundary, with the (account, amount)
 * versus (id, account, amount) counterexample held to the reference; a boundary, a correlated stage, two constants on
 * one inner variable, or a constant reading a column on a variable the stage's filter reads is never fused. Every
 * fusion delivers what its original does, by the reference evaluator, on every database of the candidate facts, alone
 * and composed with the rewrite phases, and lowers conservatively.
 *
 * Oracle: the rule's statement as a checker over exhaustive planted spaces (a specification), the reference evaluator's
 * delivery (a second implementation); the boundary search is the guard population's (rewrite/guarded.ts).
 *
 * Features: each bound tuple under each reader; fused and refused fixed columns; the guard shapes, a group that kept its
 * bound tuple and a scoped stage kept.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { nodesByLabel } from "#compiler/ir/dag.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import { fusePass } from "#compiler/lower/optimize/fuse/index.ts"
import { assert, contains } from "#test/support/assert.ts"
import { Posting, Q, T } from "#test/unit/lower/conservative/fixtures.ts"
import {
	type Bound,
	fused,
	postings,
	type Reader,
	type Stage,
	type Use,
	uses
} from "#test/unit/lower/rewrite/fuse.fixtures.ts"
import { guardSearch, scopedStay } from "#test/unit/lower/rewrite/guarded.ts"
import { nodesOf, rulesOf } from "#test/unit/lower/rewrite/support.ts"

/** The complete bound tuple survives fusion a fold over an imported stage keeps its bound tuple, (account, amount) or (id, account, amount), through fusion. */
export const theCompleteBoundTupleSurvivesFusionAFoldOverAnImportedStageKeepsItsBoundTupleAccountAmountOrIdAccountAmountThroughFusion =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(element<Bound>(["account, amount", "id, account, amount"])),
					source.draw(element<Reader>(["a fold", "the query"]))
				] as const
		),
		{
			needs: {},
			situations: [
				"account, amount read by a fold",
				"account, amount read by the query",
				"id, account, amount read by a fold",
				"id, account, amount read by the query"
			] satisfies ReadonlyArray<Reached<`${Bound} read by ${Reader}`>>,
			check:
				(_, c: Case<`${Bound} read by ${Reader}`>) =>
				([bound, reader]) =>
					Effect.sync(() => {
						c.note(`${bound} read by ${reader}`)
						const columns =
							bound === "account, amount" ? ["account", "amount"] : ["id", "account", "amount"]
						const q = new Q()
						const imported = q.project(
							postings(q),
							Arr.map(columns, (col) => [col, col] as const),
							conservativeMeta
						)
						const outer = q.region([
							{
								source: imported,
								bind: Rec.fromEntries(Arr.map(columns, (col) => [col, col])),
								constants: {}
							}
						])
						if (reader === "the query") {
							contains(rulesOf(fused(q.build(outer).dag).certificates), "R01.fusion")
							return
						}
						const group = q.group(
							outer,
							columns,
							["account"],
							[{ name: "total", fn: "sum", op: "sum(bigint)", args: ["amount"], type: T.numeric }],
							conservativeMeta
						)
						const ran = fused(
							q.build(
								q.project(
									group,
									[
										["account", "account"],
										["total", "total"]
									],
									conservativeMeta
								)
							).dag
						)
						contains(rulesOf(ran.certificates), "R01.fusion")
						const g = nodesByLabel(ran.query.dag).get(group.id)
						assert.deepEqual(g?.kind === "Group" ? g.bound.columns : [], columns)
					}),
			oracle: {
				kind: "specification",
				name: "R01 fuses the stage and the fold keeps its bound tuple; the reference's delivery on every database"
			},
			box: "an import of (account, amount) or (id, account, amount), read by the query or by a fold",
			kept: [],
			kills: []
		}
	)

/** Fixed columns in R01 fusion two columns carrying one inner variable fuse unless one is fixed and the other fixed or bound, or a read fixes a filtered one. */
export const fixedColumnsInR01FusionTwoColumnsCarryingOneInnerVariableFuseUnlessOneIsFixedAndTheOtherFixedOrBoundOrAReadFixesAFilteredOne =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(uses),
					source.draw(uses),
					source.draw(element<Stage>(["filtered", "unfiltered"]))
				] as const
		),
		{
			needs: {},
			situations: ["fused", "refused"] satisfies ReadonlyArray<Reached<"fused" | "refused">>,
			check:
				(_, c: Case<"fused" | "refused">) =>
				([first, second, stage]) =>
					Effect.sync(() => {
						const q = new Q()
						const inner = postings(q)
						const imported = q.project(
							stage === "filtered"
								? q.filter(
										inner,
										q.op("int8gt", [q.col(inner, "amount"), q.int(6, T.int8)], T.bool)
									)
								: inner,
							[
								["id", "id"],
								["a1", "amount"],
								["a2", "amount"]
							],
							conservativeMeta
						)
						const other = q.base(Posting, conservativeMeta)
						const bind: Record<string, string> = { id: "task" }
						const fixed: Record<string, ScalarExpr> = {}
						for (const [column, use] of [
							["a1", first],
							["a2", second]
						] as const) {
							if (use === "bound") {
								bind[column] = column
							}
							if (use === "fixed to 5") {
								fixed[column] = q.int(5, T.int8)
							}
							if (use === "fixed to 7") {
								fixed[column] = q.int(7, T.int8)
							}
							if (use === "fixed to a read") {
								fixed[column] = q.col(other, "amount")
							}
						}
						const outer = q.region([
							{ source: other, bind: { id: "other" }, constants: {} },
							{ source: imported, bind, constants: fixed }
						])
						const ran = fused(q.build(outer).dag)
						const isFixed = (use: Use) =>
							use === "fixed to 5" || use === "fixed to 7" || use === "fixed to a read"
						const refused =
							(isFixed(first) && second !== "existential") ||
							(isFixed(second) && first !== "existential") ||
							(stage === "filtered" &&
								(first === "fixed to a read" || second === "fixed to a read"))
						c.note(refused ? "refused" : "fused")
						assert.equal(rulesOf(ran.certificates).includes("R01.fusion"), !refused)
					}),
			oracle: {
				kind: "specification",
				name: "fused unless one column is fixed and the other fixed or bound, or a read fixes a filtered one"
			},
			box: "every use of each of two columns carrying one inner variable, over a filtered or an unfiltered stage",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/optimize/fuse/index.ts",
					original:
						'\t\t\tif (hidden.length > 0) {\n\t\t\t\tconst input = top\n\t\t\t\ttop = ed.add({\n\t\t\t\t\tkind: "ProjectSet",\n\t\t\t\t\tinput,\n\t\t\t\t\tout: original.heading.map((c) => ({ name: c.name, expr: ed.column(input, c) })),\n\t\t\t\t\theading: original.heading,\n\t\t\t\t\tmeta: original.meta,\n\t\t\t\t\tloc: undefined\n\t\t\t\t})\n\t\t\t\toutputs.push(top.id)\n\t\t\t}\n',
					replacement: "",
					why: "A fused region delivers the hidden variables its import hid, no projection restoring its heading; the fuse-fixed-columns search fails where a column is left existential."
				},
				{
					file: "packages/engine/src/lower/optimize/fuse/index.ts",
					original: "\t\tif (x === undefined || fixed.has(x)) {",
					replacement: "\t\tif (x === undefined) {",
					why: "A stage is fused where two fixed columns carry one inner variable; the fuse-fixed-columns search fails."
				}
			]
		}
	)

/** Boundaries and refusals fuses no stage across an aggregate boundary, and none an expression correlates or another occurrence reads laterally. */
export const boundariesAndRefusalsFusesNoStageAcrossAnAggregateBoundaryAndNoneAnExpressionCorrelatesOrAnotherOccurrenceReadsLaterally =
	guardSearch<"a group kept its bound tuple" | "a scoped stage kept">({
		passes: [fusePass],
		evidence: "snapshot",
		situations: [
			"R01.fusion",
			"a region over a group",
			"an occurrence over a correlated source",
			"an occurrence whose source another occurrence reads laterally",
			"a group kept its bound tuple",
			"a scoped stage kept"
		],
		aims: [],
		holds: (_q, input, ran, c) => {
			const after = nodesByLabel(ran.query.dag)
			for (const group of nodesOf(input.dag, "Group")) {
				const kept = after.get(group.id)
				assert.deepEqual(
					kept?.kind === "Group" ? kept.bound.columns : [],
					group.bound.columns,
					`the group ${group.id}`
				)
				c.note("a group kept its bound tuple")
			}
			if (scopedStay(input.dag, ran.query.dag) > 0) {
				c.note("a scoped stage kept")
			}
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/fuse/index.ts",
				original:
					"\tif (chain.regionCell === cell || inner.correlated.length > 0) {\n\t\treturn false\n\t}\n\tif (cx.cells.feedback.has(cell)) {\n\t\treturn false\n\t}\n\tif (DagEditor.correlated(o.source)) {",
				replacement:
					"\tif (chain.regionCell === cell) {\n\t\treturn false\n\t}\n\tif (cx.cells.feedback.has(cell)) {",
				why: "A correlated stage, its region or its source reading outside it, is fused; the fuse-boundaries search fails."
			}
		]
	})
