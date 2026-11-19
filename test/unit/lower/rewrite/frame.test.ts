/**
 * The rewrite frame (lower/optimize/demand/frame.ts rewritePass): rewrites run only in the optimized lowering, every
 * applied rewrite strictly lowers its pass's potential, a natural, or the pass fails (which every suite that runs a pass
 * checks on every rewrite), and:
 *
 * - a root a rewrite replaces stays at its position among the DAG's roots, the query's root first;
 * - the same input rewrites to the same DAG, certificates and SQL, run after run;
 * - a pass given a DAG a frame settled delivers that very DAG where it changes nothing, and otherwise one whose content
 *   differs, the DAG a fresh copy of the same content gives;
 * - a pass computed cold from a fresh copy of a DAG equals the pass computed warm from the one a pass delivered;
 * - a finish after an edit keeps the node of every cell the edit left as it was, and folds the redefined cell and every
 *   cell above it anew, into the DAG a finish with no memory of the last gives, whose physical analysis read through
 *   one pass's properties is the analysis computed from scratch.
 *
 * Oracle: the frame's statement over an exhaustive space of root positions (a specification); for the rest, universal
 * laws over generated queries: determinism, and a pass's result a function of its input's content alone.
 *
 * Features: the query's root and a later root replaced; a pass that delivered the settled DAG; a pass that changed it; a
 * redefinition that changes a node's content, a cell an edit kept, and a cell above a redefined one.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	analyzePhysical,
	analyzePhysicalUnder,
	type PhysicalEnv,
	propsUnder,
	unplaced
} from "#compiler/analysis/physical/analyze.ts"
import { encode, everyProperty } from "#compiler/core/canonical.ts"
import { type Cell, conservativeMeta, type Rooted } from "#compiler/ir/rel.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import { DagEditor } from "#compiler/lower/optimize/demand/editor.ts"
import { relationalRewrites } from "#compiler/lower/optimize/demand/phases.ts"
import { existencePass } from "#compiler/lower/optimize/existence/index.ts"

import { simplifyPass } from "#compiler/lower/optimize/simplify/index.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { standInNames } from "#test/support/kernel/naming.ts"
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { schemaCodes } from "#test/support/oracle/gen/schema.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { upTo } from "#test/support/up-to.ts"
import { Posting, Q, T } from "#test/unit/lower/conservative/fixtures.ts"
import {
	chainNeed,
	type FinishFeature,
	type FrameFeature,
	freshCopy,
	passesNeed,
	type RootPosition
} from "#test/unit/lower/rewrite/frame.fixtures.ts"
import {
	caseQuery,
	ledgerCatalog,
	passContext,
	type Ran,
	runPasses
} from "#test/unit/lower/rewrite/support.ts"

/** A DAG's roots a root stays at its position among the DAG's roots when a rewrite replaces it, the query's root first. */
export const aDAGsRootsARootStaysAtItsPositionAmongTheDAGsRootsWhenARewriteReplacesItTheQuerysRootFirst =
	property.exhaust(
		finite((source) => {
			const roots = source.draw(int(2, 3))
			return { roots, at: source.draw(int(0, roots - 1)) }
		}),
		{
			needs: {},
			situations: ["the query's root", "a later root"] satisfies ReadonlyArray<
				Reached<RootPosition>
			>,
			check:
				(_, c: Case<RootPosition>) =>
				({ roots, at }) =>
					Effect.sync(() => {
						c.note(at === 0 ? "the query's root" : "a later root")
						const q = new Q()
						const occurrence = () => ({
							source: q.base(Posting, conservativeMeta),
							bind: { id: "id", account: "account" },
							constants: {}
						})
						/** Each other root a projection of its own region, which simplification keeps. */
						const built: Rooted = nonEmptyList(
							upTo(roots, (i) =>
								i === at
									? q.filter(q.region([occurrence()]), q.lit({ kind: "bool", value: true }, T.bool))
									: q.project(q.region([occurrence()]), [["id", "id"]], conservativeMeta)
							),
							"the roots"
						)
						const ran = succeeded(
							simplifyPass.run(
								{ dag: q.b.build(built), params: [] },
								passContext({ catalog: ledgerCatalog, evidence: "snapshot" })
							)
						)
						assert.equal(ran.dag.roots.length, roots)
						for (const [i, root] of ran.dag.roots.entries()) {
							if (i === at) {
								assert.equal(root.kind, "MatchRegion")
							} else {
								assert.equal(root.id, defined(built[i], "the root as built").id)
							}
						}
					}),
			oracle: {
				kind: "specification",
				name: "a replaced root stays at its position, every other root as built"
			},
			box: "two or three roots, the one simplification replaces at each position",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/optimize/demand/editor.ts",
					original:
						"\t\tconst done = finishCells(this.base.roots, (root) => this.#rootCell(root), this.#folded)",
					replacement:
						"\t\tconst done = finishCells([...this.base.roots].reverse(), (root) => this.#rootCell(root), this.#folded)",
					why: "The editor finishes a DAG with its roots reversed; the frame-root-position search fails."
				}
			]
		}
	)

/**
 * Determinism the same input rewrites to the same DAG, certificates and SQL, run after run.
 *
 * Budget: 120 runs and 0 steered cases, what its suite stated before it became a property
 * (test/unit/lower/rewrite/frame.test.ts:139 at 8cad5bce, its runs and its coverage's cases).
 */
export const determinismTheSameInputRewritesToTheSameDAGCertificatesAndSQLRunAfterRun =
	property.explore(queryCaseGen(defaultGenConfig), {
		needs: { passesNeed },
		budget: { runs: 120, steered: 0 },
		situations: [],
		check:
			({ passesNeed }) =>
			(c) =>
				Effect.gen(function* () {
					const passes = yield* passesNeed
					return yield* Effect.sync(() => {
						const run = () =>
							succeeded(
								runPasses(
									caseQuery(c),
									passes,
									passContext({ catalog: genCatalog(c.schema), evidence: "snapshot" })
								)
							)
						const sqlOf = (r: Ran): string =>
							Arr.join(
								Arr.map(
									flight(
										succeeded(
											lowerConservative(conservativeInput(r.query), {
												names: standInNames("s", schemaCodes(c.schema)),
												params: r.query.params,
												subject: { kind: "query" }
											})
										).roots
									),
									(s) => s.sql.text
								),
								"\n"
							)
						const first = run()
						for (const again of [run(), run()]) {
							assert.deepEqual(again.query.dag, first.query.dag)
							assert.deepEqual(again.certificates, first.certificates)
							assert.equal(sqlOf(again), sqlOf(first))
						}
					})
				}),
		oracle: {
			kind: "universal",
			name: "one input rewrites to one DAG, one certificate list and one SQL text"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/demand/editor.ts",
				original: "\t\t\tthis.#counter += 1",
				replacement: "\t\t\tthis.#counter += 1 + Math.floor(Math.random() * 3)",
				why: "Fresh identifiers skip a random count, so labels differ run to run; the frame-determinism search fails."
			}
		]
	})

/**
 * Determinism a frame that changes nothing in a DAG a frame delivered delivers it again, as collecting and annotating
 * would.
 *
 * Budget: 60 runs and 60 steered cases, what its suite stated before it became a property
 * (test/unit/lower/rewrite/frame.test.ts:199 at 8cad5bce, its runs and its coverage's cases).
 */
export const determinismAFrameThatChangesNothingInADAGAFrameDeliveredDeliversItAgainAsCollectingAndAnnotatingWould =
	property.explore(queryCaseGen(defaultGenConfig), {
		needs: {},
		budget: { runs: 60, steered: 60 },
		situations: ["a pass delivered the settled DAG"] satisfies ReadonlyArray<Reached<FrameFeature>>,
		check: (_, c: Case<FrameFeature>) => (q) =>
			Effect.sync(() => {
				const catalog = genCatalog(q.schema)
				const settled = succeeded(
					runPasses(
						caseQuery(q),
						[relationalRewrites],
						passContext({ catalog, evidence: "snapshot" })
					)
				).query
				for (const pass of [simplifyPass, existencePass, relationalRewrites]) {
					const again = succeeded(pass.run(settled, passContext({ catalog, evidence: "snapshot" })))
					/** The same DAG as a fresh table with the same content gives, which no frame delivered. */
					const fresh = succeeded(
						pass.run(
							{ ...settled, dag: freshCopy(settled.dag) },
							passContext({ catalog, evidence: "snapshot" })
						)
					)
					assert.deepEqual(again.dag, fresh.dag)
					assert.equal(again.dag.roots[0].id, fresh.dag.roots[0].id)
					if (again.dag !== settled.dag) {
						assert.notEqual(
							succeeded(encode(again.dag, everyProperty)),
							succeeded(encode(settled.dag, everyProperty))
						)
					} else {
						c.note("a pass delivered the settled DAG")
					}
				}
			}),
		oracle: {
			kind: "universal",
			name: "a pass that changes nothing delivers its input, and its result is its input's content's"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/demand/frame.ts",
				original: "\teditor.version === 0 ? query : { ...query, dag: editor.finish() }",
				replacement: "\t({ ...query, dag: editor.finish() })",
				why: "A pass that changes nothing delivers a rebuilt copy of its DAG; the frame-delivered search fails."
			}
		]
	})

/**
 * Determinism a pass computed cold from a fresh copy of a DAG equals the pass computed warm from the cached one.
 *
 * Budget: 150 runs and 150 steered cases, what its suite stated before it became a property
 * (test/unit/lower/rewrite/frame.test.ts:260 at 8cad5bce, its runs and its coverage's cases).
 */
export const determinismAPassComputedColdFromAFreshCopyOfADAGEqualsThePassComputedWarmFromTheCachedOne =
	property.explore(queryCaseGen(defaultGenConfig), {
		needs: { chainNeed },
		budget: { runs: 150, steered: 150 },
		situations: ["a pass changed the DAG"] satisfies ReadonlyArray<Reached<FrameFeature>>,
		check:
			({ chainNeed }, c: Case<FrameFeature>) =>
			(q) =>
				Effect.gen(function* () {
					const chain = yield* chainNeed
					return yield* Effect.sync(() => {
						const catalog = genCatalog(q.schema)
						let warm = caseQuery(q)
						for (const pass of chain) {
							const cold = { ...warm, dag: freshCopy(warm.dag) }
							const warmCtx = passContext({ catalog, evidence: "snapshot" })
							const coldCtx = passContext({ catalog, evidence: "snapshot" })
							const hot = succeeded(pass.run(warm, warmCtx))
							const fresh = succeeded(pass.run(cold, coldCtx))
							assert.deepEqual(hot.dag, fresh.dag)
							assert.equal(hot.dag.roots[0].id, fresh.dag.roots[0].id)
							assert.deepEqual(warmCtx.certificates.all(), coldCtx.certificates.all())
							if (hot.dag !== warm.dag) {
								c.note("a pass changed the DAG")
							}
							warm = hot
						}
					})
				}),
		oracle: {
			kind: "universal",
			name: "a pass's result is a function of its input's content: cold from a fresh copy equals warm"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/rel.ts",
				original: "\t\tif (exprsOf(node).some((e) => e.deps.nodes.includes(read))) {",
				replacement: "\t\tif (exprsOf(node).some((e) => true)) {",
				why: "Operator mutant (boolean-return) at packages/engine/src/ir/rel.ts:550 in semiJoinRight: `e.deps.nodes.includes(read)` becomes `true`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * A finish after an edit keeps the node of every cell the edit left as it was (ir/dag.ts finishCells): with the cell at
 * each position of a generated query's topological order redefined under another cardinality claim, a finish reads
 * structure and never its claims' truth, so the editor's finish is the
 * DAG a finish with no memory of the last gives, the redefined cell and every cell above it fold into new nodes, every
 * other cell into the very node the last finish built, and the physical analysis of the new DAG read through the
 * properties the old one's was (analysis/physical/analyze.ts PropsUnder) is the analysis computed from scratch.
 *
 * Budget: 120 runs and 120 steered cases, the frame-determinism suite's.
 */
export const aFinishAfterAnEditKeepsTheNodeOfEveryCellTheEditLeftAsItWasAndFoldsTheRedefinedCellAndEveryCellAboveItAnew =
	property.explore(queryCaseGen(defaultGenConfig), {
		needs: {},
		budget: { runs: 120, steered: 120 },
		situations: [
			"a redefinition that changes a node's content",
			"a cell an edit kept",
			"a cell above a redefined one"
		] satisfies ReadonlyArray<Reached<FinishFeature>>,
		check: (_, c: Case<FinishFeature>) => (q) =>
			Effect.sync(() => {
				const query = caseQuery(q)
				const ctx = passContext({ catalog: genCatalog(q.schema), evidence: "snapshot" })
				const env: PhysicalEnv = {
					context: ctx.evidenceContext,
					catalog: ctx.catalog,
					realization: unplaced,
					roots: "result"
				}
				const positions = new DagEditor(query.dag).topoOrder().length
				for (const at of upTo(positions, (i) => i)) {
					/** The editor's edit: the cell at position `at` redefined under another cardinality claim. */
					const edited = (editor: DagEditor): Cell => {
						const cell = defined(editor.topoOrder()[at], "a cell at the position")
						const { meta } = cell.current
						editor.set(cell, {
							...cell.current,
							meta: { ...meta, card: meta.card === "many" ? "atMostOne" : "many" }
						})
						return cell
					}
					const editor = new DagEditor(query.dag)
					const before = editor.finished()
					const props = propsUnder(env)
					analyzePhysicalUnder(before.dag, props)
					const redefined = edited(editor)
					const after = editor.finished()
					const fresh = new DagEditor(query.dag)
					edited(fresh)
					assert.deepEqual(after.dag, fresh.finished().dag)
					if (
						succeeded(encode(after.node(redefined), everyProperty)) !==
						succeeded(encode(before.node(redefined), everyProperty))
					) {
						c.note("a redefinition that changes a node's content")
					}
					for (const cell of editor.topoOrder()) {
						if (DagEditor.subtree(cell).has(redefined)) {
							assert.notEqual(after.node(cell), before.node(cell), `${cell.id} is folded anew`)
							if (cell !== redefined) {
								c.note("a cell above a redefined one")
							}
						} else {
							assert.equal(after.node(cell), before.node(cell), `${cell.id} keeps its node`)
							c.note("a cell an edit kept")
						}
					}
					const shared = analyzePhysicalUnder(after.dag, props)
					const scratch = analyzePhysical(after.dag, env)
					assert.deepEqual(
						Arr.map(shared.order, (n) => shared.of(n)),
						Arr.map(scratch.order, (n) => scratch.of(n))
					)
					assert.deepEqual(shared.obligations, scratch.obligations)
				}
			}),
		oracle: {
			kind: "universal",
			name: "a finish's DAG is its cells' content alone, and a node an edit left is the node the last finish built"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/dag.ts",
				original: "\t\t\tbefore?.current === current && unchangedEdges(before.node, spec)",
				replacement: "\t\t\tbefore !== undefined && unchangedEdges(before.node, spec)",
				why: "A finish keeps the node of a cell an edit redefined; the redefined cell is not folded anew."
			},
			{
				file: "packages/engine/src/ir/dag.ts",
				original: "\t\t\tbefore?.current === current && unchangedEdges(before.node, spec)",
				replacement: "\t\t\tbefore?.current === current",
				why: "A finish keeps the node of a cell whose input was folded anew; the cell above a redefined one is stale."
			},
			{
				file: "packages/engine/src/ir/dag.ts",
				original: "\t\t\t\t? before.node\n",
				replacement: "\t\t\t\t? relNode(cell.id, spec)\n",
				why: "A finish folds every cell anew; a cell the edit left loses its node."
			},
			{
				file: "packages/engine/src/lower/optimize/demand/editor.ts",
				original: "\t\tthis.#folded = done.value.folded\n",
				replacement: "",
				why: "The editor forgets what its last finish folded; a cell the edit left loses its node."
			}
		]
	})
