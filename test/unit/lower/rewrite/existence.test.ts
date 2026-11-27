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

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, contains, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { type CertificateRule, makeCertificate } from "#compiler/ir/certificate.ts"
import { nodesByLabel, topoOrder } from "#compiler/ir/dag.ts"
import { type Cell, conservativeMeta, type EditNode } from "#compiler/ir/rel.ts"
import { DagEditor } from "#compiler/lower/optimize/demand/editor.ts"
import type { RewriteCx } from "#compiler/lower/optimize/demand/frame.ts"
import { relationalRewrites } from "#compiler/lower/optimize/demand/phases.ts"
import { linkedColumns, restrictionKept } from "#compiler/lower/optimize/demand/restriction.ts"
import { existencePass, existencePotential } from "#compiler/lower/optimize/existence/index.ts"
import { prunePass } from "#compiler/lower/optimize/prune/index.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
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
	type Beside,
	type CarriedSource,
	carried,
	carriedShapes,
	checked,
	checkedFacts,
	driving,
	drivingFacts,
	databases,
	type Dominated,
	edgeFacts,
	type Evidence,
	existenceOnlyOverCorrelated,
	type Left,
	ledgerFacts,
	matched,
	type PostingSource,
	type Reader,
	rewritten,
	type RegionShapeFeature,
	regionShapeSites,
	type CorrelatedReader,
	correlatedReaders,
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
					const ran = rewritten(dag, [prunePass, existencePass], ledgerFacts)
					rewritten(dag, [relationalRewrites], ledgerFacts)
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

/**
 * The only occurrence relating a column of another to the rest of its region stays in the region, a join edge at that
 * column (existence/index.ts shapedExistence, demand/restriction.ts): an edge s → p, the carrier p → c, the carried
 * c → s or c → x, a loop at c beside them or none. The carrier binds only what the others bind, an existence-only
 * occurrence by R02's own reading, and where the carried edge shares s with the first its removal leaves the region
 * connected, so R02 once made it an EXISTS and read the carried source at every c, as metis's sitting read each item's
 * attempts in force over its test's every member, the member that carries the item to its place an EXISTS above. The
 * loop at c binds only the carried source's column, relates nothing to it, and is an existence test still. Every
 * rewritten query keeps the restriction reaching each occurrence's read and delivers what its original does.
 */
export const theOnlyOccurrenceRelatingAColumnOfAnotherToTheRestStaysInItsRegion = property.exhaust(
	finite(carriedShapes),
	{
		needs: {},
		situations: [
			"joined beside the carrier",
			"joined through the carrier alone",
			"with a test of the carried column alone",
			"with no other test",
			"carried from a scan",
			"carried from its own rule"
		] satisfies ReadonlyArray<Reached<Beside | Dominated | `carried from ${CarriedSource}`>>,
		check:
			(_, c: Case<Beside | Dominated | `carried from ${CarriedSource}`>) =>
			([beside, dominated, source]) =>
				Effect.sync(() => {
					c.note(beside)
					c.note(dominated)
					c.note(`carried from ${source}`)
					const shape = carried(beside, dominated, source)
					const ran = rewritten(shape.dag, [prunePass, existencePass], edgeFacts)
					/** The source each existence test R02 made reads, its certificate's first input. */
					const tested = new Set(
						Arr.flatMap(ran.certificates, (x) =>
							x.rule === "R02.semiJoin" ? Arr.take(x.inputs, 1) : []
						)
					)
					assert.ok(
						!tested.has(shape.carrier.id),
						`${beside}, ${dominated}: the carrier became an existence test`
					)
					for (const t of shape.tests) {
						assert.ok(tested.has(t.id), `${beside}: the loop at c stayed in the region`)
					}
					const restricted = (dag: typeof shape.dag) =>
						new Map(
							Arr.flatMap(topoOrder(dag), (node) =>
								node.kind === "MatchRegion" ? [...linkedColumns(node)] : []
							)
						)
					assert.ok(
						restrictionKept(restricted(shape.dag), restricted(ran.query.dag)),
						`${beside}, ${dominated}: an occurrence lost a column of its restriction`
					)
				}),
		oracle: {
			kind: "specification",
			name: "the carrier stays in its region, a loop at the carried column becomes an existence test, every occurrence keeps its restriction; the reference's delivery on every database"
		},
		box: "an edge, its carrier and the edge it carries to, joined beside the carrier or through it alone, with a loop at the carried column or none, carried from a scan or from a rule of its own",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/existence/index.ts",
				original: "\t\tconst keeping = connected.filter((o) => keepsRestriction(node, o))\n",
				replacement: "\t\tconst keeping = connected\n",
				why: "R02 asks only that the region stay connected, as before: the carrier, whose removal leaves the edges joined at s, becomes an EXISTS, and the carried edge is read at every c."
			}
		]
	}
)

/**
 * A check of a row the region's keys single out stays an existence test, whatever restriction it relates
 * (existence/index.ts onlyFilters, demand/restriction.ts roots): a posting, the posting its account names, read at
 * that posting's key, and the named posting again at the first posting's amount. The check alone relates the named
 * posting to that amount, but the first posting binds the named posting's key, a root of the region left, and the check
 * binds no key of it, so it can only filter, one probe at its key per row, as pantry's operands check their operator's
 * placement. Held in the join, a flat fill of UnknownOperandBase read 174M buffers where the test read 66.5M.
 */
export const aCheckOfARowTheKeysSingleOutStaysAnExistenceTest = property.exhaust(
	finite((source) => source.draw(element<CarriedSource>(["a scan", "its own rule"]))),
	{
		needs: {},
		situations: ["checked beside a scan", "checked beside its own rule"] satisfies ReadonlyArray<
			Reached<`checked beside ${CarriedSource}`>
		>,
		check: (_, c: Case<`checked beside ${CarriedSource}`>) => (source) =>
			Effect.sync(() => {
				c.note(`checked beside ${source}`)
				const shape = checked(source)
				const ran = rewritten(shape.dag, [prunePass, existencePass], checkedFacts)
				assert.ok(
					Arr.some(
						ran.certificates,
						(x) => x.rule === "R02.semiJoin" && x.inputs[0] === shape.check.id
					),
					`${source}: the check of the named posting's amount stayed in the region`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the check of a row the keys single out is an existence test; the reference's delivery on every database"
		},
		box: "a posting, the posting its account names, and the check of the named posting's amount, beside a scan or a rule of its own",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/existence/index.ts",
				original: "\t\t\t\t\t(keeping.includes(o) || onlyFilters(physical, node, o))\n",
				replacement: "\t\t\t\t\tkeeping.includes(o)\n",
				why: "R02 refuses any removal that takes a restriction, as xptrsrzy did: the check stays in the join, and a flat fill of pantry's UnknownOperandBase read 174M buffers where the test read 66.5M."
			}
		]
	}
)

/**
 * A check that binds its root's key stays a join operand (existence/index.ts onlyFilters): a posting, the account its
 * account names, and an account whose id is the posting's own. Its removal leaves the posting a root, but the check
 * binds the posting's key, so it may be the smaller side the region is read from, the postings looked up by it, as an
 * operand's Expression binds its Node's key: as an existence test a fill of pantry's ExpressionOperand read every node
 * and probed its expression, 14.62M buffers, where read first the expressions drove it in 1.73M.
 */
export const aCheckThatBindsItsRootsKeyStaysAJoinOperand = property.exhaust(
	finite((source) => source.draw(element<CarriedSource>(["a scan", "its own rule"]))),
	{
		needs: {},
		situations: ["driving a scan", "driving its own rule"] satisfies ReadonlyArray<
			Reached<`driving ${CarriedSource}`>
		>,
		check: (_, c: Case<`driving ${CarriedSource}`>) => (source) =>
			Effect.sync(() => {
				c.note(`driving ${source}`)
				const shape = driving(source)
				const ran = rewritten(shape.dag, [prunePass, existencePass], drivingFacts)
				assert.ok(
					!Arr.some(
						ran.certificates,
						(x) => x.rule === "R02.semiJoin" && x.inputs[0] === shape.check.id
					),
					`${source}: the check that binds the posting's key became an existence test`
				)
			}),
		oracle: {
			kind: "specification",
			name: "a check that binds its root's key stays a join operand; the reference's delivery on every database"
		},
		box: "a posting, the account its account names, and the account at the posting's own id, the posting read as stored or through a rule of its own",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/existence/index.ts",
				original: "\tconst checked = new Set(o.bindings.map((b) => classOf(b.var)))\n",
				replacement: "\tconst checked = new Set<VarId>()\n",
				why: "A check whose removal leaves a root is an existence test whether or not it binds the root's key, as R02 v2 had it: pantry's ExpressionOperand fill read every node and probed its expression, 14.62M buffers where 1.73M drove it from the expressions."
			}
		]
	}
)

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
					original: "\t\t\t\t\t\tphysical.props(left),",
					replacement: "\t\t\t\t\t\tphysical.props(right),",
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

/**
 * A correlated source binds none of a class it reads, and reads the kept member of a class whose variable the semi-join
 * rewrite replaces (existence/index.ts unreadBindings, redirectReads): an item beside Owned, bound at one of the item's
 * variables a `where` equates to another occurrence's (existence.fixtures.ts correlatedReaders). Where another occurrence
 * binds the class without reading it, the item's match is an existence test and Owned reads that occurrence's variable,
 * where it read the item's, which the region no longer binds, so the region had no order in which Owned follows what it
 * reads (the agreement's #reordered red, seed 0x437f2318); where Owned is the class's only other binder, there is no kept
 * member, and the item's match stays the class's one binder (#faults, seed 0xc0714ea1). Each compiles, its semi-joins as
 * the shape says.
 */
export const aCorrelatedSourceReadsTheKeptMemberOfAClassItsRewriteReplacesAndBindsNoneOfAClassItReads =
	property.exhaust(
		finite((source) =>
			source.draw(element<CorrelatedReader>(nonEmpty(Rec.keys(correlatedReaders), "a shape")))
		),
		{
			needs: {},
			situations: [],
			check: () => (shape: CorrelatedReader) =>
				Effect.sync(() => {
					const { item, build } = correlatedReaders[shape]
					const template = succeeded(
						Result.flatMap(
							catchCompileError(() => build()),
							(q) => compileTemplate(q, undefined, testCompile)
						),
						`${shape}: compiles`
					)
					assert.equal(
						Arr.some(template.certificates, (c) => c.rule === "R02.semiJoin")
							? "an existence test"
							: "a join operand",
						item,
						`${shape}: the item's match`
					)
				}),
			oracle: {
				kind: "specification",
				name: "a correlated source reads the kept member of a class the rewrite replaces, and a class with no kept member keeps its binder"
			},
			box: "an item beside Owned bound at one of its variables a where equates to another occurrence's, from either side: Slot's item, a kept member, or Owned's own id, none",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/optimize/existence/index.ts",
					original: "\tconst redirected = redirectReads(ed, cell, rest, renamed)\n",
					replacement: "\tconst redirected = redirectReads(ed, cell, rest, new Map())\n",
					why: "No remaining source's read is redirected: Owned reads the item's owner, which the rewrite replaced by Slot's item, and the region has no order in which Owned follows what it reads (UnsupportedOperation)."
				},
				{
					file: "packages/engine/src/lower/optimize/existence/index.ts",
					original:
						"\treturn new Set(o.bindings.map((b) => classOf(b.var)).filter((c) => !read.has(c)))\n",
					replacement:
						"\treturn new Set(o.bindings.filter((b) => !reads.has(b.var.name)).map((b) => classOf(b.var)))\n",
					why: "Reads are told apart from bindings by name, so the rewrite fires with no kept member: Owned passes for a binder of the id's class it reads, the item's match becomes an existence test, and Owned is left reading itself (UnsupportedOperation)."
				}
			]
		}
	)
