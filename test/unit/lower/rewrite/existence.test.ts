/**
 * R02 (lower/optimize/existence): express existence as existence. An occurrence whose every variable another occurrence
 * binds contributes only existence and becomes a semi-join's right side, its constants with it, the reader's heading
 * and a fold's bound tuple unchanged; a match binding a witness of its own is never touched. A set comparison becomes a
 * semi- or anti-join only over a physically unique left input, its key's premises and context in the certificate. An
 * occurrence over a correlated source, or whose source another occurrence reads laterally, stays in its region. Every
 * rewritten query delivers what its original does, by the reference evaluator, on every database of the candidate
 * facts, and lowers conservatively.
 *
 * Oracle: the rule's statement as a checker over exhaustive planted spaces (a specification), the reference evaluator's
 * delivery (a second implementation); the scope search is the guard population's (rewrite/guarded.ts).
 *
 * Features: each Account occurrence under each reader, each posting source; each set comparison rewritten and kept; the
 * scoped shapes and a scoped occurrence that stayed.
 */

import { assert, contains, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { type CertificateRule, makeCertificate } from "#compiler/ir/certificate.ts"
import { nodesByLabel } from "#compiler/ir/dag.ts"
import { type Cell, conservativeMeta, type EditNode } from "#compiler/ir/rel.ts"
import { DagEditor } from "#compiler/lower/optimize/demand/editor.ts"
import type { RewriteCx } from "#compiler/lower/optimize/demand/frame.ts"
import { relationalRewrites } from "#compiler/lower/optimize/demand/phases.ts"
import { existencePass, existencePotential } from "#compiler/lower/optimize/existence/index.ts"
import { prunePass } from "#compiler/lower/optimize/prune/index.ts"
import { succeeded } from "#test/support/assert.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import {
	Account as AccountRelation,
	Posting,
	Q,
	type RelationSpec
} from "#test/unit/lower/conservative/fixtures.ts"
import {
	type Account,
	accountKey,
	databases,
	type Evidence,
	existenceOnlyOverCorrelated,
	type Left,
	matched,
	type PostingSource,
	type Reader,
	rewritten,
	type RegionShapeFeature,
	regionShapeSites,
	shapes
} from "#test/unit/lower/rewrite/existence.fixtures.ts"
import { reachEdits } from "#test/unit/lower/rewrite/frame.fixtures.ts"
import { guardSearch, scopedStay } from "#test/unit/lower/rewrite/guarded.ts"
import {
	caseQuery,
	deliversAlikeOn,
	ledgerCatalog,
	passContext,
	queryOf,
	rulesOf,
	runPasses
} from "#test/unit/lower/rewrite/support.ts"

/** An existence-only match becomes a semi-join an occurrence binding nothing of its own becomes a semi-join, its constants with it, the reader's heading and bound tuple kept. */
export const anExistenceOnlyMatchBecomesASemiJoinAnOccurrenceBindingNothingOfItsOwnBecomesASemiJoinItsConstantsWithItTheReadersHeadingAndBoundTupleKept =
	property.exhaust(finite(shapes), {
		needs: {},
		situations: [
			"postings from a scan",
			"postings from its own rule",
			"existence only under a projection",
			"existence only under a projection, shared variable outside the heading",
			"existence only under a root, shared variable outside the heading",
			"existence only under a fold",
			"with a constant under a projection",
			"with a constant under a projection, shared variable outside the heading",
			"with a constant under a root, shared variable outside the heading",
			"with a constant under a fold"
		] satisfies ReadonlyArray<
			Reached<`${Account} under a ${Reader}` | `postings from ${PostingSource}`>
		>,
		check:
			(_, c: Case<`${Account} under a ${Reader}` | `postings from ${PostingSource}`>) =>
			([account, reader, posting]) =>
				Effect.sync(() => {
					c.note(`${account} under a ${reader}`)
					c.note(`postings from ${posting}`)
					const { dag, group } = matched(account, reader, posting)
					const ran = rewritten(dag, [prunePass, existencePass])
					rewritten(dag, [relationalRewrites])
					contains(rulesOf(ran.certificates), "R02.semiJoin")
					for (const g of group) {
						const after = nodesByLabel(ran.query.dag).get(g.id)
						assert.deepEqual(after?.kind === "Group" ? after.bound.columns : [], [
							"id",
							"acct",
							"amount"
						])
					}
				}),
		oracle: {
			kind: "specification",
			name: "an existence-only occurrence becomes a semi-join, the bound tuple unchanged; the reference's delivery on every database"
		},
		box: "each Account occurrence, existence only or with a constant, under each reader, over postings scanned or from a rule of their own",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/existence/index.ts",
				original: "\t\tif (columnReads(o.constants.map((c) => c.expr)).length > 0) {",
				replacement: "\t\tif (o.constants.length > 0) {",
				why: "An occurrence with any constant, a literal among them, is left a match; the existence-semi-join search fails."
			}
		]
	})

/** Set comparisons need a physically unique left input a keyed left input admits the rewrite, its key's premises and context in the certificate. */
export const setComparisonsNeedAPhysicallyUniqueLeftInputAKeyedLeftInputAdmitsTheRewriteItsKeysPremisesAndContextInTheCertificate =
	property.exhaust(
		finite((source) => ({
			op: source.draw(element<"Intersect" | "Difference">(["Intersect", "Difference"])),
			left: source.draw(element<Left>(["account ids", "posting accounts"])),
			evidence: source.draw(element<Evidence>(["snapshot", "transaction"]))
		})),
		{
			needs: {},
			situations: [
				"Intersect rewritten",
				"Intersect kept",
				"Difference rewritten",
				"Difference kept"
			] satisfies ReadonlyArray<Reached<`${"Intersect" | "Difference"} ${"rewritten" | "kept"}`>>,
			check:
				(_, c: Case<`${"Intersect" | "Difference"} ${"rewritten" | "kept"}`>) =>
				({ op, left, evidence }) =>
					Effect.sync(() => {
						const q = new Q()
						const ids = (relation: RelationSpec, column: string) =>
							q.project(
								q.region([
									{
										source: q.base(relation, conservativeMeta),
										bind: { [column]: "id" },
										constants: {}
									}
								]),
								[["id", "id"]],
								conservativeMeta
							)
						const accounts = ids(AccountRelation, "id")
						const postings = ids(Posting, "account")
						const dag = q.build(
							left === "account ids"
								? q.setOp(op, accounts, postings)
								: q.setOp(op, postings, accounts)
						).dag
						const query = queryOf(dag, [])
						const ran = succeeded(
							runPasses(query, [existencePass], passContext({ catalog: ledgerCatalog, evidence }))
						)
						deliversAlikeOn(databases, [Posting, AccountRelation], [], query, ran.query)
						const rule: CertificateRule = op === "Intersect" ? "R02.semiJoin" : "R02.antiJoin"
						const unique = left === "account ids"
						c.note(`${op} ${unique ? "rewritten" : "kept"}`)
						const cert = Arr.findFirst(ran.certificates, (x) => x.rule === rule)
						if (!unique) {
							assert.deepEqual(cert, Option.none())
							return
						}
						const certified = Option.getOrThrowWith(
							cert,
							() => new Error("the set comparison's certificate")
						)
						assert.deepEqual(
							Arr.flatMap(certified.premises, (p) =>
								p.kind === "constraint" ? [p.constraint] : []
							),
							[accountKey]
						)
						assert.equal(certified.context, "immediate")
					}),
			oracle: {
				kind: "specification",
				name: "a set comparison is rewritten exactly over a physically unique left input, certified by its key"
			},
			box: "an intersection or a difference of account ids and posting accounts, either on the left, in a snapshot or a transaction",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/optimize/existence/index.ts",
					original: "\t\t\t\t\t\tphysical.of(left).props,",
					replacement: "\t\t\t\t\t\tphysical.of(right).props,",
					why: "A set comparison is rewritten on the uniqueness of its right input rather than its left; the existence-set-comparison search fails."
				}
			]
		}
	)

/**
 * Scope an occurrence over a correlated source, or whose source another occurrence reads laterally, stays in its
 * region.
 *
 * Budget: 150 runs and 450 steered cases, what its suite stated before it became a property
 * (test/unit/lower/rewrite/existence.test.ts:349 at 8cad5bce, its runs and its coverage's cases).
 */
export const scopeAnOccurrenceOverACorrelatedSourceOrWhoseSourceAnotherOccurrenceReadsLaterallyStaysInItsRegion =
	guardSearch<
		| "a scoped occurrence stayed in its region"
		| "an existence-only occurrence over a correlated source"
	>({
		runs: 150,
		passes: [existencePass],
		evidence: "snapshot",
		situations: [
			"an occurrence over a correlated source",
			"an occurrence whose source another occurrence reads laterally",
			"a scoped occurrence stayed in its region",
			"an existence-only occurrence over a correlated source",
			"R02.semiJoin"
		],
		aims: [["an existence-only occurrence over a correlated source", ["union"]]],
		holds: (_q, input, ran, c) => {
			if (scopedStay(input.dag, ran.query.dag) > 0) {
				c.note("a scoped occurrence stayed in its region")
			}
			if (existenceOnlyOverCorrelated(input.dag)) {
				c.note("an existence-only occurrence over a correlated source")
			}
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/existence/index.ts",
				original: "\t\treturn !DagEditor.correlated(o.source) && !cx.cells.feedback.has(o.source)",
				replacement: "\t\treturn !cx.cells.feedback.has(o.source)",
				why: "An occurrence over a correlated source is moved into a semi-join; the existence-scope search fails."
			}
		]
	})

/**
 * The existence pass works a region's existence-only occurrences out again only where an edit reached its subtree
 * (lower/optimize/existence/index.ts shapedOf): over generated queries and edits at their reached cells (a cell
 * redirected to a copy of itself, a cell emptied to a closed relation of its heading, an emptied cell restored), each
 * measure of the pass's potential at a state works out exactly the regions of the state whose node or a node of whose
 * subtree an edit set since their last, a node set back to what it was among them, and the first time each region is
 * met; the potential is a number at every state.
 *
 * Oracle: a specification, the edit after which each reached cell's node was last set, against each region's subtree
 * at its last working out.
 *
 * Budget: 120 runs and 120 steered cases, the frame-determinism suite's.
 */
export const theExistencePassWorksARegionsShapeOutAgainOnlyWhereAnEditReachedItsSubtree =
	property.explore(
		(s) => ({ query: s.draw(queryCaseGen(defaultGenConfig)), edits: s.draw(reachEdits) }),
		{
			needs: {},
			budget: { runs: 120, steered: 120 },
			situations: [
				"a region an edit reached",
				"a region an edit left as it was"
			] satisfies ReadonlyArray<Reached<RegionShapeFeature>>,
			check: (_, c: Case<RegionShapeFeature>) => (drawn) =>
				Effect.gen(function* () {
					const editor = new DagEditor(caseQuery(drawn.query).dag)
					const ctx = passContext({ catalog: genCatalog(drawn.query.schema), evidence: "snapshot" })
					const cxOf = (): RewriteCx => ({
						editor,
						ctx,
						pass: "existence",
						catalog: ctx.catalog,
						cells: editor.cellState(),
						certify: (input) => {
							ctx.certificates.record(succeeded(makeCertificate(input)))
						}
					})
					/**
					 * The node each cell the states reached held when last reached, the edit after which it was last set, and
					 * the edits so far: a cell an edit takes out of reach and another brings back holds the node it held.
					 */
					const seen = new Map(Arr.map(editor.topoOrder(), (k) => [k, k.current] as const))
					const setAt = new Map<Cell, number>()
					let edits = 0
					/** The edit count at which each region was last worked out. */
					const last = new Map<Cell, number>()
					const measured = Effect.gen(function* () {
						const cx = cxOf()
						const regions = Arr.filter(
							cx.cells.order,
							(cell) => cell.current.kind === "MatchRegion"
						)
						const due = Arr.filter(regions, (cell) => {
							const at = last.get(cell)
							return (
								at === undefined ||
								Arr.some([...DagEditor.subtree(cell)], (k) => (setAt.get(k) ?? 0) > at)
							)
						})
						const [value, counts] = yield* callCounts(
							Effect.sync(() => existencePotential(cx)),
							regionShapeSites
						)
						assert.ok(typeof value === "number", "the existence potential is a number")
						assert.equal(
							counts.shapedExistence,
							due.length,
							`${counts.shapedExistence} regions worked out at a state where ${due.length} of ${regions.length} were reached`
						)
						if (due.length > 0 && last.size > 0) {
							c.note("a region an edit reached")
						}
						if (Arr.some(regions, (cell) => last.has(cell) && !due.includes(cell))) {
							c.note("a region an edit left as it was")
						}
						for (const cell of due) {
							last.set(cell, edits)
						}
					})
					const emptied = new Map<Cell, EditNode>()
					yield* measured
					for (const edit of drawn.edits) {
						const order = editor.topoOrder()
						const cell = defined(order[edit.at % order.length], "a reached cell")
						edits += 1
						const back = Arr.head([...emptied])
						if (edit.kind === "restored" && back._tag === "Some") {
							const [at, node] = back.value
							emptied.delete(at)
							editor.set(at, node)
						} else if (edit.kind === "redirected to a copy") {
							editor.redirect(cell, editor.add(cell.current))
						} else {
							emptied.set(cell, cell.current)
							editor.set(cell, {
								kind: "Closed",
								closed: "_reach",
								rows: [],
								heading: cell.current.heading,
								meta: cell.current.meta,
								loc: cell.current.loc
							})
						}
						for (const k of editor.topoOrder()) {
							if (seen.get(k) !== k.current) {
								setAt.set(k, edits)
								seen.set(k, k.current)
							}
						}
						yield* measured
					}
				}),
			oracle: {
				kind: "specification",
				name: "the edit after which each reached cell's node was last set, against each region's subtree at its last working out"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/optimize/existence/index.ts",
					original: "\tif (known?.node === region && known.at >= cx.cells.stamp(cell)) {\n",
					replacement: "\tif (known?.node === region && known.at > Number.MAX_SAFE_INTEGER) {\n",
					why: "Every measure of the potential works out every region's existence-only occurrences again, as it did at every state before regions kept them."
				}
			]
		}
	)
