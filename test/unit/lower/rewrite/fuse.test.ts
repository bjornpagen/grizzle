/**
 * R01 fusion (lower/optimize/fuse): an imported stage written as a region under filters and renames is inlined into the
 * region that matches it, preserving the complete bound tuple and every aggregate boundary, with the (account, amount)
 * versus (id, account, amount) counterexample held to the reference; a boundary, a correlated stage, two constants on
 * one inner variable, a constant reading a column on a variable the stage's filter reads, or a variable of the stage's
 * region that the reader neither binds nor fixes and that a filter, an equality or a second occurrence reads is never
 * fused: the fused region would hold it as a hidden variable under a projection restoring its heading, a derived table
 * its readers read it through (lower/optimize/fuse shapedFusion). Every
 * fusion delivers what its original does, by the reference evaluator, on every database of the candidate facts, alone
 * and composed with the rewrite phases, and lowers conservatively.
 *
 * Oracle: the rule's statement as a checker over exhaustive planted spaces (a specification), the reference evaluator's
 * delivery (a second implementation); the boundary search is the guard population's (rewrite/guarded.ts).
 *
 * Features: each bound tuple under each reader; fused and refused fixed columns; the guard shapes, a group that kept its
 * bound tuple and a scoped stage kept.
 */

import { assert, contains } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { nodesByLabel } from "#compiler/ir/dag.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import { fusePass } from "#compiler/lower/optimize/fuse/index.ts"
import { Account, plainRegion, Posting, Q, T } from "#test/unit/lower/conservative/fixtures.ts"
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
			kills: [
				{
					file: "packages/engine/src/ir/dag.ts",
					original: "\t\tif (!index.has(node.id)) {",
					replacement: "\t\tif (index.has(node.id)) {",
					why: "Operator mutant (negation) at packages/engine/src/ir/dag.ts:228 in nodesByLabel: `!index.has(node.id)` becomes `index.has(node.id)`; the property fails (lane CATCH, grizzle 0baff5d6)."
				}
			]
		}
	)

/** Fixed columns in R01 fusion two columns carrying one inner variable fuse unless one is fixed and the other fixed or bound, a read fixes a filtered one, or neither column binds or fixes the variable the filter reads. */
export const fixedColumnsInR01FusionTwoColumnsCarryingOneInnerVariableFuseUnlessOneIsFixedAndTheOtherFixedOrBoundAReadFixesAFilteredOneOrNeitherBindsTheFilteredOne =
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
								(first === "fixed to a read" ||
									second === "fixed to a read" ||
									(first === "existential" && second === "existential")))
						c.note(refused ? "refused" : "fused")
						assert.equal(rulesOf(ran.certificates).includes("R01.fusion"), !refused)
					}),
			oracle: {
				kind: "specification",
				name: "fused unless one column is fixed and the other fixed or bound, a read fixes a filtered one, or the filter reads a variable neither column binds nor fixes, which a fused region could hold only as a hidden variable under a projection"
			},
			box: "every use of each of two columns carrying one inner variable, over a filtered or an unfiltered stage",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/optimize/fuse/index.ts",
					original: "\t\tif (x === undefined || fixed.has(x)) {",
					replacement: "\t\tif (x === undefined) {",
					why: "A stage is fused where two fixed columns carry one inner variable; the fuse-fixed-columns search fails."
				}
			]
		}
	)

/** How a stage's region reads a variable beyond one binding: a second occurrence joins on it, its filter reads it, or a region equality equates it. */
type Read = "a join" | "a filter" | "an equality"

/** Whether the stage's import delivers that variable, so its reader binds it, or not. */
type Delivered = "delivered" | "undelivered"

/** The stage's region, over the postings and, where it joins or equates, the accounts, and the variables it reads beyond one binding. */
const stageOf = (
	q: Q,
	read: Read
): { readonly stage: RelNode; readonly reads: ReadonlyArray<string> } => {
	switch (read) {
		case "a join":
			return {
				stage: q.region([
					{
						source: q.base(Posting, conservativeMeta),
						bind: { id: "id", account: "account", amount: "amount" },
						constants: {}
					},
					{ source: q.base(Account, conservativeMeta), bind: { id: "account" }, constants: {} }
				]),
				reads: ["account"]
			}
		case "a filter": {
			const inner = postings(q)
			return {
				stage: q.filter(inner, q.op("int8gt", [q.col(inner, "amount"), q.int(6, T.int8)], T.bool)),
				reads: ["amount"]
			}
		}
		case "an equality":
			return {
				stage: q.regionWith(
					[
						{
							source: q.base(Posting, conservativeMeta),
							bind: { id: "id", account: "account", amount: "amount" },
							constants: {}
						},
						{ source: q.base(Account, conservativeMeta), bind: { id: "owner" }, constants: {} }
					],
					{ ...plainRegion, equalities: [["account", "owner"]] }
				),
				reads: ["account", "owner"]
			}
	}
}

/** Fusion keeps the region's heading a stage whose region reads a variable beyond one binding fuses only where its reader binds that variable, and fusion adds no projection. */
export const fusionKeepsTheRegionsHeadingAStageWhoseRegionReadsAVariableBeyondOneBindingFusesOnlyWhereItsReaderBindsThatVariableAndFusionAddsNoProjection =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(element<Read>(["a join", "a filter", "an equality"])),
					source.draw(element<Delivered>(["delivered", "undelivered"]))
				] as const
		),
		{
			needs: {},
			situations: ["fused", "refused"] satisfies ReadonlyArray<Reached<"fused" | "refused">>,
			check:
				(_, c: Case<"fused" | "refused">) =>
				([read, delivered]) =>
					Effect.sync(() => {
						const q = new Q()
						const { stage, reads } = stageOf(q, read)
						const columns = delivered === "delivered" ? ["id", ...reads] : ["id"]
						const imported = q.project(
							stage,
							Arr.map(columns, (col) => [col, col] as const),
							conservativeMeta
						)
						const input = q.build(
							q.region([
								{
									source: imported,
									bind: Rec.fromEntries(Arr.map(columns, (col) => [col, col])),
									constants: {}
								}
							])
						).dag
						const ran = fused(input)
						const fusedNow = rulesOf(ran.certificates).includes("R01.fusion")
						c.note(fusedNow ? "fused" : "refused")
						assert.equal(
							fusedNow,
							delivered === "delivered",
							"fused exactly where the reader binds the variable"
						)
						const before = nodesByLabel(input)
						for (const p of nodesOf(ran.query.dag, "ProjectSet")) {
							assert.ok(before.has(p.id), `a projection ${p.id} fusion added`)
						}
					}),
			oracle: {
				kind: "specification",
				name: "fused exactly where the reader binds every variable the stage reads beyond one binding; no projection added; the reference's delivery on every database"
			},
			box: "a stage that joins, filters or equates a variable, its import delivering it or not",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/optimize/fuse/index.ts",
					original:
						"\t\tinner.vars.every(\n\t\t\t(x) =>\n\t\t\t\timaged.has(x.name) ||\n\t\t\t\t((bindings.get(x.name) ?? 0) === 1 && !predVars.has(x.name) && !equated.has(x.name))\n\t\t)\n",
					replacement: "\t\ttrue\n",
					why: "Fusion admits a stage whose region reads a variable its reader leaves unbound, as it did when it held such a variable hidden under a restoring projection: the fused region drops the join, filter or equality on it and delivers other rows than the stage."
				}
			]
		}
	)

/**
 * Boundaries and refusals fuses no stage across an aggregate boundary, and none an expression correlates or another
 * occurrence reads laterally.
 *
 * Budget: 150 runs and 450 steered cases, what its suite stated before it became a property
 * (test/unit/lower/rewrite/fuse.test.ts:286 at 8cad5bce, its runs and its coverage's cases).
 */
export const boundariesAndRefusalsFusesNoStageAcrossAnAggregateBoundaryAndNoneAnExpressionCorrelatesOrAnotherOccurrenceReadsLaterally =
	guardSearch<"a group kept its bound tuple" | "a scoped stage kept">({
		runs: 150,
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
