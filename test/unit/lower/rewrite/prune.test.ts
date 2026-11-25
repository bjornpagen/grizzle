/**
 * Pruning (lower/optimize/prune): unused columns leave the nodes whose meaning allows it, "preserve the complete
 * distinct binding input to aggregates, including bound variables omitted from the answer"; a dead witness becomes an
 * existential; a root keeps its heading; a node on or read by a recursive step keeps its form, and its inputs keep every
 * column that form reads. Every pruned query, and every query the relational rewrites compose over, delivers what its
 * original does, by the reference evaluator, on every database of the candidate facts, and lowers conservatively.
 *
 * Oracle: the rule's statement as a checker over exhaustive planted spaces (a specification), the reference evaluator's
 * delivery (a second implementation).
 *
 * And the last prune, which narrows the sources too (sourcePrunePass), narrows a stored relation's scan to a heading its
 * keys and generations name alone: a generated field whose generation reads a column the scan drops is no generation
 * of the narrowed scan, whose logical analysis reads each one's reads as the determinants of its field
 * (logical/closure.ts determinantsAt). Oracle: the narrowed scan's statement, every key and generation over its heading,
 * and the logical analysis of the narrowed query, which refuses one that names a column the scan lacks (a
 * specification). Kill: the generations kept whole.
 *
 * Features: an aggregate dropped and every aggregate delivered; each reader over each stage; a generation dropped, one
 * kept.
 */

import { assert, contains, defined, lacks } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite, subarray } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { topoOrder } from "#compiler/ir/dag.ts"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import { analyzeLogical, everyNode, queryEvidence } from "#compiler/logical/annotate.ts"
import { sourcePrunePass } from "#compiler/lower/optimize/prune/index.ts"
import { succeeded } from "#test/support/assert.ts"
import { Edge, Posting, Q } from "#test/unit/lower/conservative/fixtures.ts"
import {
	aggregateNames,
	aggregates,
	bindingsOf,
	edges,
	Generating,
	generatingColumns,
	generations,
	headingOf,
	postings,
	pruned,
	readBy,
	type Reader,
	type Stage
} from "#test/unit/lower/rewrite/prune.fixtures.ts"
import { ledgerCatalog, passContext, rulesOf, runPasses } from "#test/unit/lower/rewrite/support.ts"

/** Demand pruning keeps a fold's whole bound tuple, the key no head reads included, and drops only undemanded aggregates. */
export const demandPruningKeepsAFoldsWholeBoundTupleTheKeyNoHeadReadsIncludedAndDropsOnlyUndemandedAggregates =
	property.exhaust(finite(subarray(aggregateNames)), {
		needs: {},
		situations: ["an aggregate dropped", "every aggregate delivered"] satisfies ReadonlyArray<
			Reached<"an aggregate dropped" | "every aggregate delivered">
		>,
		check: (_, c: Case<"an aggregate dropped" | "every aggregate delivered">) => (delivered) =>
			Effect.sync(() => {
				const q = new Q()
				const region = q.region([
					{
						source: q.base(Posting, conservativeMeta),
						bind: { id: "id", account: "account", amount: "amount" },
						constants: {}
					}
				])
				const bound = ["id", "account", "amount"]
				const group = q.group(
					region,
					bound,
					["account"],
					Arr.map(aggregateNames, (a) => aggregates[a]),
					conservativeMeta
				)
				const ran = pruned(
					q.build(
						q.project(
							group,
							[["account", "account"], ...Arr.map(delivered, (a) => [a, a] as const)],
							conservativeMeta
						)
					).dag,
					[Posting],
					postings
				)
				c.note(
					delivered.length < aggregateNames.length
						? "an aggregate dropped"
						: "every aggregate delivered"
				)
				assert.deepEqual(headingOf(ran.query.dag, region), bound)
				assert.deepEqual(headingOf(ran.query.dag, group), ["account", ...delivered])
			}),
		oracle: {
			kind: "specification",
			name: "a fold keeps its whole bound tuple, and only undemanded aggregates leave it"
		},
		box: "a fold over every posting by its whole bound tuple, delivering every subset of its three aggregates",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/demand/demand.ts",
				original: "\t\t\t\t...reader.bound.columns,\n",
				replacement: "",
				why: "A fold demands of its input only its keys and its aggregates' arguments, not its bound tuple (analysis/demand/demand.ts); the prune-fold search fails."
			}
		]
	})

/** A pinned node keeps its form, and its inputs every column that form reads a stage read by a recursive step or a root region keeps the column of a dead binding. */
export const aPinnedNodeKeepsItsFormAndItsInputsEveryColumnThatFormReadsAStageReadByARecursiveStepOrARootRegionKeepsTheColumnOfADeadBinding =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(element<Stage>(["projection", "filter", "region"])),
					source.draw(
						element<Reader>([
							"recursive step",
							"root region",
							"unpinned region",
							"unpinned named region"
						])
					)
				] as const
		),
		{
			needs: {},
			situations: [
				"recursive step over a projection",
				"recursive step over a filter",
				"recursive step over a region",
				"root region over a projection",
				"root region over a filter",
				"root region over a region",
				"unpinned region over a projection",
				"unpinned region over a filter",
				"unpinned region over a region",
				"unpinned named region over a projection",
				"unpinned named region over a filter",
				"unpinned named region over a region"
			] satisfies ReadonlyArray<Reached<`${Reader} over a ${Stage}`>>,
			check:
				(_, c: Case<`${Reader} over a ${Stage}`>) =>
				([stageKind, reader]) =>
					Effect.sync(() => {
						c.note(`${reader} over a ${stageKind}`)
						const { dag, region, stage } = readBy(stageKind, reader)
						const before = bindingsOf(dag, region)
						const ran = pruned(dag, [Edge], edges)
						const after = bindingsOf(ran.query.dag, region)
						const stageHeading = defined(headingOf(ran.query.dag, stage), "the stage")
						if (reader === "recursive step") {
							assert.deepEqual(after, before)
							assert.deepEqual(stageHeading, defined(headingOf(dag, stage), "the stage as built"))
							return
						}
						contains(rulesOf(ran.certificates), "prune.heading")
						lacks(stageHeading, "c")
						if (reader === "root region") {
							assert.deepEqual(after, before)
							for (const column of before.flat()) {
								contains(stageHeading, column)
							}
						} else {
							assert.deepEqual(
								after,
								Arr.map(before, (columns) => Arr.filter(columns, (column) => column !== "b"))
							)
						}
					}),
			oracle: {
				kind: "specification",
				name: "a pinned node keeps its form and its inputs every column it reads; any other loses its dead binding"
			},
			box: "a projection, a filter or a region read by a recursive step, a root region, or a region that is neither",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/optimize/prune/index.ts",
					original:
						"\t\tif (\n\t\t\ted.isRoot(cell) ||\n\t\t\tcx.cells.feedback.has(cell) ||\n\t\t\treaders(cell).some((r) => cx.cells.feedback.has(r))\n\t\t) {",
					replacement:
						"\t\tif (ed.isRoot(cell) || cx.cells.feedback.has(cell) || readers(cell).length < 0) {",
					why: "A node a recursive step reads is pruned like any other, only the step's own cells pinned; the prune-pinned search fails."
				}
			]
		}
	)

/** The last prune narrows a stored relation's scan to a heading its keys and generations name alone. */
export const theLastPruneNarrowsAStoredRelationsScanToAHeadingItsKeysAndGenerationsNameAlone =
	property.exhaust(finite(subarray(generatingColumns)), {
		needs: {},
		situations: ["a generation dropped", "a generation kept"],
		check: (_, c: Case<"a generation dropped" | "a generation kept">) => (read) =>
			Effect.sync(() => {
				const q = new Q()
				const scan = q.generatingBase(Generating, generations, conservativeMeta)
				const region = q.region([
					{
						source: scan,
						bind: Rec.fromEntries(Arr.map(["id", ...read], (column) => [column, column] as const)),
						constants: {}
					}
				])
				const ran = succeeded(
					runPasses(
						q.build(region),
						[sourcePrunePass],
						passContext({ catalog: ledgerCatalog, evidence: "snapshot" })
					)
				)
				const [narrowed] = Arr.flatMap(topoOrder(ran.query.dag), (node) =>
					node.kind === "Base" && node.relationKind === "relation" ? [node] : []
				)
				if (narrowed === undefined) {
					throw new Error("the narrowed scan")
				}
				const columns = new Set(Arr.map(narrowed.heading, (h) => h.name))
				for (const key of [narrowed.primaryKey, ...narrowed.keys]) {
					assert.ok(
						Arr.every(key, (k) => columns.has(k)),
						`a key over the heading: ${Arr.join(key, ",")}`
					)
				}
				for (const g of narrowed.generated) {
					assert.ok(
						columns.has(g.field) && Arr.every(g.reads, (r) => columns.has(r)),
						`a generation over the heading: ${g.field} from ${Arr.join(g.reads, ",")}`
					)
				}
				c.note(
					narrowed.generated.length < generations.length
						? "a generation dropped"
						: "a generation kept"
				)
				succeeded(
					analyzeLogical(ran.query.dag, queryEvidence, everyNode),
					"the narrowed query's analysis"
				)
			}),
		oracle: {
			kind: "specification",
			name: "a narrowed scan's keys and generations name its heading's columns, and its analysis reads them"
		},
		box: "a scan of a relation with two generated fields, one reading one column and one two, read at its key and every subset of its other columns",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/prune/index.ts",
				original:
					"\t\t\t\tgenerated: node.generated.filter((g) => keep(g.field) && g.reads.every(keep))\n",
				replacement: "",
				why: "A narrowed scan keeps every generation whole, one reading a column it dropped among them, which its analysis refuses."
			}
		]
	})
