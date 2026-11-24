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
 *   one pass's properties is the analysis computed from scratch;
 * - a rewrite reads how each cell is read off the state's cells, worked out once a state, and the semantic
 *   simplification computes no demand of the DAG's columns at all, where every state a rule asked whether a cell was
 *   exclusive finished the DAG and analyzed its demand.
 *
 * Oracle: the frame's statement over an exhaustive space of root positions (a specification); for the rest, universal
 * laws over generated queries: determinism, and a pass's result a function of its input's content alone.
 *
 * Features: the query's root and a later root replaced; a pass that delivered the settled DAG; a pass that changed it; a
 * redefinition that changes a node's content, a cell an edit kept, and a cell above a redefined one; a simplification
 * that rewrote and one that changed nothing.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { structureOf, type Structure } from "#compiler/analysis/demand/demand.ts"
import {
	analyzePhysical,
	type PhysicalEnv,
	propsUnder,
	unplaced
} from "#compiler/analysis/physical/analyze.ts"
import { encode, everyProperty } from "#compiler/core/canonical.ts"
import { makeCertificate } from "#compiler/ir/certificate.ts"
import { columnReads } from "#compiler/ir/expr.ts"
import {
	type Cell,
	conservativeMeta,
	type EditNode,
	edgesOf,
	exprsOf,
	type Rooted,
	scopeLabels
} from "#compiler/ir/rel.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import { type CellState, DagEditor } from "#compiler/lower/optimize/demand/editor.ts"
import type { RewriteCx } from "#compiler/lower/optimize/demand/frame.ts"
import {
	relationalRewrites,
	semanticSimplification
} from "#compiler/lower/optimize/demand/phases.ts"
import { existencePass } from "#compiler/lower/optimize/existence/index.ts"

import { assert, defined } from "@bjornpagen/testing/assert"
import { simplifyPass } from "#compiler/lower/optimize/simplify/index.ts"
import {
	simplificationPotential,
	simplificationRules
} from "#compiler/lower/optimize/simplify/rules.ts"
import { succeeded } from "#test/support/assert.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
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
	type PotentialFeature,
	potentialSites,
	type ReachFeature,
	reachEdits,
	reachedOf,
	reachSites,
	type ReadersFeature,
	readersFeatures,
	readersSites,
	shapeSites,
	type RedirectFeature,
	freshCopy,
	passesNeed,
	type RootPosition,
	type StructureFeature,
	structureSites
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
						"\t\tconst done = unwrap(finishCells(this.base.roots, (root) => this.#rootCell(root), this.#folded))",
					replacement:
						"\t\tconst done = unwrap(finishCells([...this.base.roots].reverse(), (root) => this.#rootCell(root), this.#folded))",
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
 * other cell into the very node the last finish built, and each node's physical properties in the new DAG read through
 * the properties the old one's were (analysis/physical/analyze.ts PropsUnder), as a rewrite pass reads its states'
 * cells (lower/optimize/demand/frame.ts physicalAnalyses), are the properties computed from scratch.
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
					for (const n of analyzePhysical(before.dag, env).order) {
						props.of(n)
					}
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
					const scratch = analyzePhysical(after.dag, env)
					assert.deepEqual(
						Arr.map(scratch.order, (n) => props.of(n)),
						Arr.map(scratch.order, (n) => scratch.of(n).props)
					)
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
				original: "\t\tthis.#folded = done.folded\n",
				replacement: "",
				why: "The editor forgets what its last finish folded; a cell the edit left loses its node."
			}
		]
	})

/**
 * A rewrite reads how each cell is read off the state's cells, one state a step: over generated queries, the semantic
 * simplification (simplify, fusion, simplify) takes exactly one state of the cells for each its driver works out, reads
 * how each cell is read off the editor's reach (editor.ts Reach), never working it out of the cells again
 * (analysis/demand structureOf), and computes no demand of the DAG's columns, where every state a rule asked whether a
 * cell was exclusive finished the DAG and analyzed its demand whole.
 */
export const aRewriteReadsHowEachCellIsReadOffTheStatesCellsWorkedOutOnceAStateAndComputesNoDemand =
	property.explore(queryCaseGen(defaultGenConfig), {
		needs: {},
		budget: { runs: 120, steered: 120 },
		situations: [
			"a simplification that rewrote",
			"a simplification that changed nothing"
		] satisfies ReadonlyArray<Reached<StructureFeature>>,
		check: (_, c: Case<StructureFeature>) => (generated) =>
			Effect.gen(function* () {
				const [ran, counts] = yield* callCounts(
					Effect.sync(() =>
						succeeded(
							runPasses(
								caseQuery(generated),
								[semanticSimplification],
								passContext({ catalog: genCatalog(generated.schema), evidence: "snapshot" })
							)
						)
					),
					structureSites
				)
				c.note(
					ran.certificates.length > 0
						? "a simplification that rewrote"
						: "a simplification that changed nothing"
				)
				assert.equal(
					counts.state,
					counts.rewriteCx,
					`${counts.state} states of the cells over ${counts.rewriteCx} the driver worked out`
				)
				assert.equal(counts.structureOf, 0, "no structure worked out of the cells")
				assert.equal(
					counts.feedbackReadsOf,
					0,
					"no walk of the cells for their recursive steps beside the state's own"
				)
				assert.equal(counts.analyzeDemand, 0, "no demand of the DAG's columns")
			}),
		oracle: {
			kind: "specification",
			name: "one state of the cells a state the driver works out, no structure worked out of the cells, and no demand analysis, in the semantic simplification"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/simplify/rules.ts",
				original:
					"\tcx.cells.references(cell) === 1 && !cx.editor.isRoot(cell) && !cx.cells.lateral(cell)",
				replacement:
					"\tcx.editor.cellState().references(cell) === 1 && !cx.editor.isRoot(cell) && !cx.cells.lateral(cell)",
				why: "Exclusivity takes a state of the cells again at every rule that asks (lower/optimize/simplify/rules.ts exclusive); the structure property fails."
			},
			{
				file: "packages/engine/src/lower/optimize/demand/editor.ts",
				original:
					"\t\t\t? kept.read(kept.generation, (cell, edges, found) =>\n\t\t\t\t\treadsFeedback(cell.current, edges, found)\n\t\t\t\t)\n",
				replacement:
					"\t\t\t? { order: kept.cells(kept.generation), feedback: feedbackReadsOf(cellGraph, kept.cells(kept.generation)) }\n",
				why: "A state works out its cells' recursive steps in a walk of its own after its order, each cell's edges read again, as before the order's one reading found them as it read each cell."
			}
		]
	})

/**
 * How each cell is read is the editor's reach, kept as every edit moves it (lower/optimize/demand/editor.ts Reach): over
 * generated queries and edits at their reached cells (a cell redirected to a copy of itself; a cell's node replaced by
 * an empty relation of its heading, which takes its inputs out of reach where nothing else reads them; and an emptied
 * cell's node put back), every state of the cells reads each cell's references and lateral reads as analysis/demand
 * structureOf works them out of the cells as they were when it was taken, read then and again after every later edit;
 * taking a state moves no count; and an edit moves at most twice the edges of the reached nodes it set and of the cells
 * it brought into reach or took out of it, and two a root it moved, never the whole DAG's; and after each edit a cell's
 * set version is past the one before the edit exactly when the edit set its node, and its moved version is past it
 * wherever its references or lateral reads changed.
 *
 * Oracle: a second implementation, structureOf over each state's own cells as they were, and the cells reached before
 * and after each edit walked from its roots for its bound.
 *
 * Budget: 120 runs and 120 steered cases, the frame-determinism suite's.
 */
export const howEachCellIsReadIsTheEditorsReachKeptAsEveryEditMovesItAndAStateReadsItAsItWasWhenTaken =
	property.explore(
		(s) => ({ query: s.draw(queryCaseGen(defaultGenConfig)), edits: s.draw(reachEdits) }),
		{
			needs: {},
			budget: { runs: 120, steered: 120 },
			situations: [
				"a cell's inputs taken out of reach",
				"a cell's inputs brought back into reach",
				"a root moved",
				"a state read after later edits"
			] satisfies ReadonlyArray<Reached<ReachFeature>>,
			check: (_, c: Case<ReachFeature>) => (drawn) =>
				Effect.gen(function* () {
					const editor = new DagEditor(caseQuery(drawn.query).dag)
					const known = new Set<Cell>()
					const states: Array<{
						readonly state: CellState
						readonly expected: Structure
						readonly cells: ReadonlyArray<Cell>
					}> = []
					const holds = (taken: (typeof states)[number]): void => {
						for (const cell of taken.cells) {
							assert.equal(
								taken.state.references(cell),
								taken.expected.references(cell.id),
								`${cell.id}'s references`
							)
							assert.equal(
								taken.state.lateral(cell),
								taken.expected.lateral(cell.id),
								`whether a scope expression reads ${cell.id}`
							)
						}
					}
					const take = Effect.gen(function* () {
						const [state, counts] = yield* callCounts(
							Effect.sync(() => editor.cellState()),
							reachSites
						)
						assert.equal(counts.step, 0, "taking a state moves no count")
						for (const cell of state.order) {
							known.add(cell)
						}
						const taken = {
							state,
							expected: structureOf(
								state.order,
								editor.roots,
								(cell) => edgesOf(cell.current),
								(cell) => scopeLabels(cell.current),
								(cell) => cell.id
							),
							cells: [...known]
						}
						holds(taken)
						states.push(taken)
					})
					const emptied = new Map<Cell, EditNode>()
					yield* take
					for (const edit of drawn.edits) {
						const order = editor.topoOrder()
						const cell = defined(order[edit.at % order.length], "a reached cell")
						const before = reachedOf(editor.roots)
						const versionBefore = editor.version
						const nodes = new Map(Arr.map([...known], (k) => [k, k.current] as const))
						const roots = editor.roots
						const back = Arr.head([...emptied])
						const [, counts] = yield* callCounts(
							Effect.sync(() => {
								if (edit.kind === "restored" && back._tag === "Some") {
									const [at, node] = back.value
									emptied.delete(at)
									editor.set(at, node)
									return
								}
								if (edit.kind === "redirected to a copy") {
									const copy = editor.add(cell.current)
									known.add(copy)
									editor.redirect(cell, copy)
									return
								}
								emptied.set(cell, cell.current)
								editor.set(cell, {
									kind: "Closed",
									closed: "_reach",
									rows: [],
									heading: cell.current.heading,
									meta: cell.current.meta,
									loc: cell.current.loc
								})
							}),
							reachSites
						)
						const after = reachedOf(editor.roots)
						const now = editor.cellState()
						const previous = defined(states.at(-1), "the state before the edit").state
						for (const k of known) {
							const was = nodes.get(k)
							assert.equal(
								now.set(k) > versionBefore,
								was === undefined || was !== k.current,
								`${k.id}'s node was set by the edit exactly when the edit set it`
							)
							if (
								previous.references(k) !== now.references(k) ||
								previous.lateral(k) !== now.lateral(k)
							) {
								assert.ok(now.moved(k) > versionBefore, `${k.id}'s reach moved with the edit`)
							}
						}
						const edges = (k: Cell): number => edgesOf(k.current).length
						const set = Arr.filter(
							[...nodes],
							([k, node]) => k.current !== node && (before.has(k) || after.has(k))
						)
						const flipped = Arr.filter(
							[...new Set([...before.keys(), ...after.keys(), ...known])],
							(k) => before.has(k) !== after.has(k)
						)
						const moved = Arr.filter(roots, (root, i) => editor.roots[i] !== root).length
						const bound =
							2 *
							(Arr.reduce(set, 0, (n, [k, node]) => n + edgesOf(node).length + edges(k)) +
								Arr.reduce(flipped, 0, (n, k) => n + edges(k)) +
								2 * moved)
						assert.ok(
							counts.step <= bound,
							`${edit.kind} at ${cell.id} moved ${counts.step} counts, past ${bound}`
						)
						if (Arr.some(flipped, (k) => before.has(k))) {
							c.note(
								edit.kind === "restored"
									? "a cell's inputs brought back into reach"
									: "a cell's inputs taken out of reach"
							)
						}
						if (Arr.some(flipped, (k) => after.has(k)) && edit.kind === "restored") {
							c.note("a cell's inputs brought back into reach")
						}
						if (moved > 0) {
							c.note("a root moved")
						}
						yield* take
					}
					for (const taken of states.slice(0, -1)) {
						holds(taken)
						c.note("a state read after later edits")
					}
				}),
			oracle: {
				kind: "second-implementation",
				name: "structureOf over each state's own cells as they were, and the cells reached before and after each edit walked from its roots"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/optimize/demand/editor.ts",
					original: "\t\tconst read = this.#reach.taken()\n",
					replacement:
						"\t\tconst read = new Reach((cell) => this.#entryOf(cell).shape, this.roots).taken()\n",
					why: "Every state works out how each cell is read anew, a walk of every cell the roots reach, as structureOf did at every state: taking a state moves every count."
				},
				{
					file: "packages/engine/src/lower/optimize/demand/editor.ts",
					original: "\t\tif (epoch !== undefined && !log(epoch).has(key)) {\n",
					replacement: "\t\tif (epoch !== undefined && epoch === epoch.next) {\n",
					why: "A change records nothing of what it moves: a state read after a later edit reads the counts as they are now, not as they were when it was taken."
				},
				{
					file: "packages/engine/src/lower/optimize/demand/editor.ts",
					original: "\t\t\tthis.#movedAt.set(cell, this.#version)\n",
					replacement: "",
					why: "A change stamps no cell whose references it moved: a reader keeping a cell's verdict while its reach stood keeps it past an edit that moved it."
				}
			]
		}
	)

/**
 * A redirection rewrites exactly the cells that read the redirected cell (lower/optimize/demand/editor.ts redirect),
 * each found by the editor's index of readers, which it keeps as every cell's node changes: over generated queries, each
 * cell of the DAG redirected to a copy of itself and back, every cell that read it, through a data edge or a column
 * reference, reads the copy in its place, its column references to it retargeted in their order, then the cell again;
 * every other cell keeps its very node; and a root at it moves with it.
 *
 * Oracle: the redirection's statement, every cell's reading of the redirected cell worked out by a scan of its node
 * (a specification).
 *
 * Budget: 120 runs and 120 steered cases, the frame-determinism suite's.
 */
export const aRedirectionRewritesExactlyTheCellsThatReadTheRedirectedCellAndLeavesEveryOtherCellsNodeAsItWas =
	property.explore(queryCaseGen(defaultGenConfig), {
		needs: {},
		budget: { runs: 120, steered: 120 },
		situations: [
			"a reader through a data edge",
			"a reader through a column reference",
			"a root moved",
			"a cell left as it was"
		] satisfies ReadonlyArray<Reached<RedirectFeature>>,
		check: (_, c: Case<RedirectFeature>) => (q) =>
			Effect.sync(() => {
				const editor = new DagEditor(caseQuery(q).dag)
				const cells = editor.topoOrder()
				const known: Array<Cell> = [...cells]
				/** `from` redirected to `to`, every cell `known` holds checked against the redirection's statement. */
				const redirected = (from: Cell, to: Cell): void => {
					const before = new Map(Arr.map(known, (cell) => [cell, cell.current] as const))
					const roots = editor.roots
					const columnsOf = (node: EditNode) => columnReads(exprsOf(node))
					editor.redirect(from, to)
					for (const cell of known) {
						const old = defined(before.get(cell), "a cell's node before the redirection")
						const throughEdge = edgesOf(old).includes(from)
						const throughColumn = Arr.some(columnsOf(old), (r) => r.node === from.id)
						if (cell === to || !(throughEdge || throughColumn)) {
							assert.equal(cell.current, old, `${cell.id} keeps its node`)
							c.note("a cell left as it was")
							continue
						}
						if (throughEdge) {
							c.note("a reader through a data edge")
						}
						if (throughColumn) {
							c.note("a reader through a column reference")
						}
						assert.deepEqual(
							edgesOf(cell.current),
							Arr.map(edgesOf(old), (input) => (input === from ? to : input)),
							`${cell.id} reads ${to.id} in place of ${from.id}`
						)
						assert.deepEqual(
							Arr.map(columnsOf(cell.current), (r) => [r.node, r.name]),
							Arr.map(columnsOf(old), (r) => [r.node === from.id ? to.id : r.node, r.name]),
							`${cell.id}'s column references to ${from.id} name ${to.id}`
						)
					}
					assert.deepEqual(
						editor.roots,
						Arr.map(roots, (root) => (root === from ? to : root))
					)
					if (roots.includes(from)) {
						c.note("a root moved")
					}
				}
				for (const from of cells) {
					const to = editor.add(from.current)
					known.push(to)
					redirected(from, to)
					redirected(to, from)
				}
			}),
		oracle: {
			kind: "specification",
			name: "a redirection's statement: every cell's reading of the redirected cell worked out from its node"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/demand/editor.ts",
				original: "		return [...readers].toSorted((a, b) => this.#index(a) - this.#index(b))\n",
				replacement: "		return [...this.#created.keys()]\n",
				why: "A redirection rewrites every cell the editor holds, as the scan of every cell it replaced did, reading or not: a cell that reads nothing redirected is rebuilt, and keeps no node of its own."
			},
			{
				file: "packages/engine/src/lower/optimize/demand/editor.ts",
				original: "			this.#readers.changed(cell, node)\n",
				replacement: "",
				why: "A redirection leaves the index of readers as it was: a cell it moved onto the copy is no reader of the copy there, so the redirection back misses it, and it still reads the copy."
			}
		]
	})

/**
 * The simplification potential reads each filter once while its input cell holds one node (lower/optimize/simplify/
 * rules.ts standingOf): over generated queries simplified rule by rule as the rewrite frame applies them (the first rule
 * that fires at the first cell in order), the first filter's input cell given a copy of its node at each state, the
 * potential the pass holds, which keeps its readings from state to state, is
 * at every state the potential read afresh, and reads a filter again only at a state where its input cell holds another
 * node than at the last, where every state read every filter again.
 *
 * Oracle: the potential computed afresh at each state, a reading of every filter (a second implementation: the old
 * algorithm), weighed by the pass's start, and the count of states at which a filter's input cell holds another node
 * than at the last.
 *
 * Budget: 120 runs and 120 steered cases, the frame suites'.
 */
export const theSimplificationPotentialReadsEachFilterOnceWhileItsInputHoldsOneNodeAndIsAtEveryStateThePotentialReadAfresh =
	property.explore(queryCaseGen(defaultGenConfig), {
		needs: {},
		budget: { runs: 120, steered: 120 },
		situations: [
			"a simplification that rewrote",
			"a filter read again over its input's new node"
		] satisfies ReadonlyArray<Reached<PotentialFeature>>,
		check: (_, c: Case<PotentialFeature>) => (q) =>
			Effect.gen(function* () {
				const editor = new DagEditor(caseQuery(q).dag)
				const ctx = passContext({ catalog: genCatalog(q.schema), evidence: "snapshot" })
				const cxOf = (): RewriteCx => ({
					editor,
					ctx,
					pass: "simplify",
					catalog: ctx.catalog,
					cells: editor.cellState(),
					certify: (input) => {
						ctx.certificates.record(succeeded(makeCertificate(input)))
					}
				})
				/** Each filter node the states reach, with the node its input cell held at the last of them. */
				const last = new Map<EditNode, EditNode>()
				let keptReadings = 0
				let freshReadings = 0
				const [values, counts] = yield* callCounts(
					Effect.sync(() => {
						let cx = cxOf()
						const kept = simplificationPotential(cx)
						const startWeight =
							Arr.filter(cx.cells.order, (cell) => cell.current.kind === "Filter").length + 1
						const out: Array<readonly [unknown, unknown]> = []
						for (let fired = true; fired;) {
							for (const cell of cx.cells.order) {
								const node = cell.current
								if (node.kind !== "Filter") {
									continue
								}
								const before = last.get(node)
								if (before !== node.input.current) {
									keptReadings++
									if (before !== undefined) {
										c.note("a filter read again over its input's new node")
									}
								}
								last.set(node, node.input.current)
								freshReadings++
							}
							/**
							 * The potential afresh is W × (shape + unfolded) + equated with W one more than the filters the
							 * state holds, and equated below W, so it gives shape + unfolded and equated, which the pass's
							 * potential weighs by its own W, the filters the pass started with and one.
							 */
							const weight =
								Arr.filter(cx.cells.order, (cell) => cell.current.kind === "Filter").length + 1
							const fresh = simplificationPotential(cx)(cx)
							/** The pass's potential read twice at one state: the second read takes no reading again. */
							const twice: readonly [unknown, unknown] = [kept(cx), kept(cx)]
							out.push(twice)
							out.push([
								kept(cx),
								typeof fresh === "number"
									? startWeight * Math.floor(fresh / weight) + (fresh % weight)
									: fresh
							])
							/** The first filter's input cell given a copy of its node: the same content, another node. */
							const [first] = Arr.filter(cx.cells.order, (cell) => cell.current.kind === "Filter")
							const filter = first?.current
							if (filter?.kind === "Filter") {
								editor.set(filter.input, { ...filter.input.current })
							}
							fired = Arr.some(
								cx.cells.order,
								(cell) =>
									!cx.cells.feedback.has(cell) &&
									Arr.some(simplificationRules, (rule) => rule.at(cell, cx) === true)
							)
							if (fired) {
								c.note("a simplification that rewrote")
								cx = cxOf()
							}
						}
						return out
					}),
					potentialSites
				)
				for (const [held, fresh] of values) {
					assert.deepEqual(held, fresh, "the potential the pass holds is the potential read afresh")
				}
				assert.equal(
					counts.filterReading,
					keptReadings + freshReadings,
					`${counts.filterReading} filter readings, ${keptReadings} by the pass's potential and ${freshReadings} afresh`
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the potential read afresh at every state, and a filter read again only over its input's new node"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/simplify/rules.ts",
				original:
					"\t\tconst reading = known?.input === input ? known : filterReading(node, input)\n",
				replacement: "\t\tconst reading = filterReading(node, input)\n",
				why: "The potential reads every filter again at every state, as before its readings were kept: the pass's readings outnumber the states at which a filter's input changed node."
			},
			{
				file: "packages/engine/src/lower/optimize/simplify/rules.ts",
				original:
					"\t\tconst reading = known?.input === input ? known : filterReading(node, input)\n",
				replacement: "\t\tconst reading = known ?? filterReading(node, input)\n",
				why: "A filter's reading is kept whatever node its input cell holds: a filter whose input changed node is not read again."
			}
		]
	})

/**
 * A rewrite reads each state's readers off the state's cells, worked out at most once a state (lower/optimize/demand/
 * editor.ts CellState readers): over generated queries, the relational rewrites work out the readers of the cells
 * (DagEditor.readersIn) no more often than they work out a state of the cells (cellState, a driver's or a rule's own).
 *
 * Oracle: one reader map a state at most (a specification), by V8's call counts.
 *
 * Budget: 120 runs and 120 steered cases, the structure property's.
 */
export const aRewriteReadsEachStatesReadersOffItsCellsWorkedOutAtMostOnceAState = property.explore(
	queryCaseGen(defaultGenConfig),
	{
		needs: {},
		budget: { runs: 120, steered: 120 },
		situations: readersFeatures satisfies ReadonlyArray<Reached<ReadersFeature>>,
		check: (_, c: Case<ReadersFeature>) => (generated) =>
			Effect.gen(function* () {
				const [, counts] = yield* callCounts(
					Effect.sync(() =>
						succeeded(
							runPasses(
								caseQuery(generated),
								[relationalRewrites],
								passContext({ catalog: genCatalog(generated.schema), evidence: "snapshot" })
							)
						)
					),
					readersSites
				)
				if (counts.readers > 0) {
					c.note("a state whose readers a rule read")
				}
				assert.ok(
					counts.readers + counts.walked <= counts.state,
					`${counts.readers + counts.walked} reader maps over ${counts.state} states`
				)
			}),
		oracle: {
			kind: "specification",
			name: "at most one reader map a state of the cells, in the relational rewrites"
		},
		kept: [],
		kills: []
	}
)

/**
 * A state of the editor's cells reads what each node reads (its edges and the labels its scope expressions name) off
 * the node, worked out once a node a cell holds (lower/optimize/demand/editor.ts #entries): over generated queries, the semantic
 * simplification and the relational rewrites work out what no more nodes read than the editor ever held, its
 * cells as they started and each node a rewrite set in one's place, where every state of every pass worked them out for
 * every cell it reached.
 *
 * Oracle: the nodes the editor held, counted by V8 as the cells it made and the nodes it set in them (Readers created and
 * changed), against V8's count of nodeShape (a specification).
 *
 * Budget: 120 runs and 120 steered cases, the structure property's.
 */
export const aStateOfTheCellsReadsWhatEachNodeReadsOffTheNodeWorkedOutOnceANode = property.explore(
	queryCaseGen(defaultGenConfig),
	{
		needs: {},
		budget: { runs: 120, steered: 120 },
		situations: ["a pass that set a node"] satisfies ReadonlyArray<
			Reached<"a pass that set a node">
		>,
		check: (_, c: Case<"a pass that set a node">) => (generated) =>
			Effect.gen(function* () {
				const [, counts] = yield* callCounts(
					Effect.sync(() =>
						succeeded(
							runPasses(
								caseQuery(generated),
								[semanticSimplification, relationalRewrites],
								passContext({ catalog: genCatalog(generated.schema), evidence: "snapshot" })
							)
						)
					),
					shapeSites
				)
				if (counts.changed > 0) {
					c.note("a pass that set a node")
				}
				assert.ok(
					counts.nodeShape <= counts.created + counts.changed,
					`${counts.nodeShape} shape readings over ${counts.created} cells made and ${counts.changed} nodes set`
				)
			}),
		oracle: {
			kind: "specification",
			name: "one scope reading a node the editor held: its cells as made and each node set in one"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/demand/editor.ts",
				original: "\t\tif (known.node !== cell.current) {\n",
				replacement: "\t\tif (known.node === known.node) {\n",
				why: "Every state works out what each reached cell's node reads again, as before cells kept it: the scope readings outnumber the nodes the editor held."
			}
		]
	}
)
