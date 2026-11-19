import { assert } from "@bjornpagen/testing/assert"
/**
 * Plan properties of the optimized lowering on PostgreSQL 19 (the R04, R17, R20 and R22 mechanisms).
 *
 * The fixture (fixture.ts) is installed by the fresh-install compiler, filled to pinned sizes and VACUUM ANALYZEd once
 * per test. Each query is compiled by compileQuery (packages/engine/src/program) for the `snapshot` context, and the
 * statements the runtime sends are planned with EXPLAIN (FORMAT JSON), under ANALYZE where a property counts rows, and
 * read by the tree's one EXPLAIN decoder (bench/harness/explain.ts). The properties are the contract; the plan's node
 * order, index names and costs are the planner's:
 *
 * - every take of 1 to 50 over a retained primary key (Posting's, Item's or Account's), ordered by it either way,
 *   deduplicates nothing and sorts nothing and never scans its relation sequentially, while the same statement with
 *   the redundant DISTINCT the elision removed, and the conservative artifact, which deduplicates at every boundary,
 *   each deduplicate, by a Unique node over ordered rows or by a hashed Aggregate, whichever the planner costs lower
 *   (R17: removing it is the observable effect);
 * - a take bound to the rows of a small relation parameter, over drawn parent sets, reads entries in proportion to the
 *   parents times k (at most k + 1 per parent) and never scans entry sequentially (R20);
 * - a pipelined attachment's take of a drawn bound and direction over parent rows the facts do not bound reads entry in
 *   one scan, once (R20);
 * - a relation parameter joined to a keyed relation, over drawn id sets with repeats and absent ids, reads Item only
 *   by index probes, never sequentially, as the arrays the template carries, whose estimate is the input's length
 *   (R22);
 * - a sum or a count over (id, account, amount) folds the scan in one grouping step with no deduplication, while one
 *   over the distinct (account, amount) values deduplicates its contributions first;
 * - a query whose discriminator stays a literal never scans its relation sequentially, under a generic and a custom
 *   prepared plan alike, over drawn parameters (R04: generic and custom plans are tested separately).
 *
 * Oracle: each mechanism's specification, judged on PostgreSQL's own plan of the statement the runtime sends: the
 * grouping steps, scans, loops and rows read it reports.
 *
 * Features: each keyed relation in each direction, each direction of a pipelined take, each fold of each binding, and
 * each query under each plan cache mode. The lateral take and the relation parameter's probe hold for every drawn
 * input; a drawn input's shape is no situation of theirs.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { array, finite, increasing, int, element } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, Array as Arr, Option, String as Str } from "effect"
import {
	type EstimatedNode,
	findNodes,
	groupingSteps,
	parsePlanTree
} from "#bench/harness/explain.ts"
import { type Direction, directions } from "#compiler/core/order.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { sizes, uid } from "#test/pg/plans/fixture.ts"
import {
	accountsWithFirstEntries,
	analyze,
	automaticTask,
	type Bound,
	compiled,
	declared,
	entriesPerAccount,
	estimate,
	estimatedNodes,
	firstBy,
	firstCount,
	type Fold,
	foldCases,
	foldOf,
	itemsById,
	type Keyed,
	nodeTypes,
	only,
	openNote,
	partialCase,
	type PartialFeature,
	plansIn,
	plansTemplate,
	rowsReadOf,
	scansOf,
	sequentialScans,
	takeCaseGen,
	withDistinctBound
} from "#test/pg/plans/plans.fixtures.ts"
import { succeeded } from "#test/support/assert.ts"
import { paramTexts, programAsts } from "#test/support/compile.ts"
import { elementAt } from "#test/support/oracle/pick.ts"
import { Substrate, ownerSession } from "#test/support/substrate/substrate.ts"

/**
 * A retained-PK ordered take deduplicates and sorts nothing, where the unelided forms deduplicate, each case on the worker's seat of the filled plans.
 *
 * Its pre-conversion budget: the box (test/pg/plans/plans.test.ts at af32621da).
 */
export const aRetainedPkOrderedTakeDeduplicatesAndSortsNothingWhereTheUnelidedFormsDeduplicate =
	property.exhaust(finite(takeCaseGen), {
		needs: { plans: Substrate.seat(plansTemplate) },
		situations: [
			"Posting asc",
			"Posting desc",
			"Item asc",
			"Item desc",
			"Account asc",
			"Account desc"
		] satisfies ReadonlyArray<Reached<`${Keyed} ${Direction}`>>,
		check:
			({ plans }, k: Case<`${Keyed} ${Direction}`>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(plans, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const { schema, relation } = plansIn(seat.value)
								const q = firstBy(c.relation, c.direction, c.k)
								const template = compiled(q, schema)
								const optimized = only(template.optimized, "optimized statement")
								const plan = yield* estimate(
									optimized.sql,
									paramTexts(optimized, {}, declared(q, template))
								)
								assert.deepEqual(
									groupingSteps(nodeTypes(plan)),
									[],
									"the take deduplicates nothing"
								)
								assert.equal(nodeTypes(plan).includes("Sort"), false)
								assert.deepEqual(sequentialScans(plan, relation(c.relation)), [])
								const redundant = withDistinctBound(
									only(programAsts(template.programs.optimized), "program statement")
								)
								const kept = yield* estimate(printStatement(redundant), [])
								assert.notDeepEqual(
									groupingSteps(nodeTypes(kept)),
									[],
									"the elided DISTINCT deduplicates"
								)
								const conservative = only(template.conservative, "conservative statement")
								const plain = yield* estimate(
									conservative.sql,
									paramTexts(conservative, {}, declared(q, template))
								)
								assert.notDeepEqual(
									groupingSteps(nodeTypes(plain)),
									[],
									"the conservative artifact deduplicates"
								)
								k.note(`${c.relation} ${c.direction}`)
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "R17: a take over a retained key needs no deduplication, which the unelided forms keep"
		},
		show: Formatter.format,
		box: "every take of 1 to 50 of Posting, Item and Account, ordered by its key either way",
		kept: [],
		kills: []
	})

/**
 * A take bound to a small relation parameter reads entries in proportion to parents times k, never sequentially, each case on the worker's seat of the filled plans.
 *
 * Its pre-conversion budget: runs 20, coverage cases 20 (test/pg/plans/plans.test.ts at af32621da).
 */
export const aTakeBoundToASmallRelationParameterReadsEntriesInProportionToParentsTimesKNeverSequentially =
	property.explore(increasing(0, sizes.accounts - 1, { min: 1, max: 8 }), {
		needs: { plans: Substrate.seat(plansTemplate) },
		situations: [] satisfies ReadonlyArray<Reached<never>>,
		check:
			({ plans }) =>
			(parents) =>
				Effect.scoped(
					Effect.flatMap(plans, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const { schema, relation } = plansIn(seat.value)
								const template = compiled(entriesPerAccount, schema)
								const spec = only(template.optimized, "optimized statement")
								const entry = relation("Entry")
								const accounts = Arr.map(parents, (n) => ({ id: uid(1, n) }))
								const plan = yield* analyze(
									spec.sql,
									paramTexts(spec, { accounts }, declared(entriesPerAccount, template))
								)
								assert.deepEqual(
									findNodes(
										plan,
										(n) => n.nodeType === "Seq Scan" && Option.contains(n.relation, entry)
									),
									[]
								)
								assert.ok(
									rowsReadOf(plan, entry) <= (firstCount + 1) * parents.length,
									`${rowsReadOf(plan, entry)} entries read for ${parents.length} parents`
								)
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "R20: a take bound to a small parent set reads at most k + 1 entries per parent, never sequentially"
		},
		show: Formatter.format,
		budget: { runs: 20, steered: 20 },
		kept: [],
		kills: []
	})

/**
 * A pipelined attachment's take over parent rows the facts do not bound reads entry in one scan, once, each case on the worker's seat of the filled plans.
 *
 * Its pre-conversion budget: runs 6, coverage cases 8 (test/pg/plans/plans.test.ts at af32621da).
 */
export const aPipelinedAttachmentsTakeOverParentRowsTheFactsDoNotBoundReadsEntryInOneScanOnce =
	property.explore(
		(source) =>
			[source.draw(element(directions)), source.draw(int(1, sizes.entriesPerAccount + 2))] as const,
		{
			needs: { plans: Substrate.seat(plansTemplate) },
			situations: directions satisfies ReadonlyArray<Reached<Direction>>,
			check:
				({ plans }, cx: Case<Direction>) =>
				([direction, k]) =>
					Effect.scoped(
						Effect.flatMap(plans, (seat) =>
							Effect.provideService(
								Effect.gen(function* () {
									const { schema, relation } = plansIn(seat.value)
									const q = accountsWithFirstEntries(direction, k)
									const template = compiled(q, schema)
									if (
										!Arr.some(
											flight(template.programs.optimized.roots),
											(s) => s.role.kind === "attachment"
										)
									) {
										return yield* Effect.die(new Error("the attachment part"))
									}
									/**
									 * The read's one statement: its rows part reads accounts alone, so every scan of entry is the
									 * take's.
									 */
									const statement = only(template.optimized, "the optimized statement")
									const plan = yield* analyze(
										statement.sql,
										paramTexts(statement, {}, declared(q, template))
									)
									const scans = scansOf(plan, relation("Entry"))
									assert.equal(scans.length, 1, "one scan of entry")
									assert.equal(
										only(scans, "scan of entry").actualLoops,
										1,
										"entry scanned once, not once per parent"
									)
									cx.note(direction)
								}),
								Substrate,
								seat.substrate
							)
						)
					),
			oracle: {
				kind: "specification",
				name: "R20: a take per delivered parent over unbounded parents is one scan of its relation"
			},
			show: Formatter.format,
			budget: { runs: 6, steered: 8 },
			kept: [],
			kills: []
		}
	)

/**
 * A relation-parameter join reads Item only by index probes, as the arrays the template carries, each case on the worker's seat of the filled plans.
 *
 * Its pre-conversion budget: runs 20, coverage cases 20 (test/pg/plans/plans.test.ts at af32621da).
 */
export const aRelationParameterJoinReadsItemOnlyByIndexProbesAsTheArraysTheTemplateCarries =
	property.explore(array(int(0, sizes.items + 999), { min: 1, max: 12 }), {
		needs: { plans: Substrate.seat(plansTemplate) },
		situations: [] satisfies ReadonlyArray<Reached<never>>,
		check:
			({ plans }) =>
			(drawnIds) =>
				Effect.scoped(
					Effect.flatMap(plans, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const { schema, relation } = plansIn(seat.value)
								const template = compiled(itemsById, schema)
								const spec = only(template.optimized, "optimized statement")
								const item = relation("Item")
								/** Every scan of Item is an index scan with an index condition: a probe by the key. */
								const probesOnly = (plan: EstimatedNode, transport: string) => {
									const scans = Arr.filter(estimatedNodes(plan), (n) =>
										Option.contains(n.relation, item)
									)
									assert.ok(scans.length > 0, `${transport}: Item is read`)
									for (const n of scans) {
										assert.ok(
											n.nodeType === "Bitmap Heap Scan"
												? Option.isSome(n.recheckCond)
												: Option.isSome(n.indexCond),
											`${transport}: ${n.nodeType} reads Item without an index condition`
										)
									}
									assert.equal(
										nodeTypes(plan).includes("Seq Scan"),
										false,
										`${transport}: no sequential scan`
									)
								}
								const ids = Arr.map(drawnIds, (n) => ({ id: uid(6, n) }))
								const plan = yield* estimate(
									spec.sql,
									paramTexts(spec, { ids }, declared(itemsById, template))
								)
								probesOnly(plan, "arrays")
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "R22: a relation parameter joined to a keyed relation reads it by index probes alone"
		},
		show: Formatter.format,
		budget: { runs: 20, steered: 20 },
		kept: [],
		kills: []
	})

/**
 * An aggregate over a base key folds in one step, and one over distinct (account, amount) values deduplicates first, each case on the worker's seat of the filled plans.
 *
 * Its pre-conversion budget: the box (test/pg/plans/plans.test.ts at af32621da).
 */
export const anAggregateOverABaseKeyFoldsInOneStepAndOneOverDistinctValuesDeduplicatesFirst =
	property.exhaust(finite(foldCases), {
		needs: { plans: Substrate.seat(plansTemplate) },
		situations: [
			"sum of the key",
			"sum of the values",
			"count of the key",
			"count of the values"
		] satisfies ReadonlyArray<Reached<`${Fold} of ${Bound}`>>,
		check:
			({ plans }, k: Case<`${Fold} of ${Bound}`>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(plans, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const { schema } = plansIn(seat.value)
								const statement = only(
									compiled(foldOf(c.bound, c.fold), schema).optimized,
									"optimized statement"
								)
								const plan = yield* estimate(statement.sql, [])
								if (c.bound === "the key") {
									assert.deepEqual(
										groupingSteps(nodeTypes(plan)),
										["Aggregate"],
										"one fold, nothing deduplicated"
									)
								} else {
									assert.equal(
										groupingSteps(nodeTypes(plan)).length,
										2,
										"a deduplication, then the fold"
									)
								}
								k.note(`${c.fold} of ${c.bound}`)
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "a fold over a base key's bindings reads distinct rows; one over values deduplicates them first"
		},
		show: Formatter.format,
		box: "a sum and a count per account, of a match binding Posting's key and of its distinct values",
		kept: [],
		kills: []
	})

/**
 * A query whose discriminator is a literal never scans its relation sequentially, under generic and custom plans, each case on the worker's seat of the filled plans.
 *
 * Its pre-conversion budget: runs 16, coverage cases 16 (test/pg/plans/plans.test.ts at af32621da).
 */
export const aQueryWhoseDiscriminatorIsALiteralNeverScansItsRelationSequentiallyUnderGenericAndCustomPlans =
	property.explore(partialCase, {
		needs: { plans: Substrate.seat(plansTemplate) },
		situations: [
			"openNote force_generic_plan",
			"openNote force_custom_plan",
			"automaticTask force_generic_plan",
			"automaticTask force_custom_plan"
		] satisfies ReadonlyArray<Reached<PartialFeature>>,
		check:
			({ plans }, cx: Case<PartialFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(plans, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const s = yield* Substrate
								const { schema, relation } = plansIn(seat.value)
								const queries = [
									{
										label: "openNote",
										q: openNote,
										relation: relation("Note"),
										param: "ticket",
										family: 4,
										size: sizes.tickets
									},
									{
										label: "automaticTask",
										q: automaticTask,
										relation: relation("Task"),
										param: "account",
										family: 1,
										size: sizes.accounts
									}
								] as const
								const chosen = elementAt(queries, c.query, "the drawn query")
								const template = compiled(chosen.q, schema)
								const spec = only(template.optimized, "optimized statement")
								const texts = paramTexts(
									spec,
									{ [chosen.param]: uid(chosen.family, c.value % (2 * chosen.size)) },
									declared(chosen.q, template)
								)
								const session = yield* s.session({
									...ownerSession(),
									label: `plans_${chosen.label}`
								})
								yield* session.query(`SET plan_cache_mode = ${c.mode}`, [])
								yield* session.query(`PREPARE p AS ${spec.sql}`, [])
								const args = Arr.join(
									Arr.map(texts, (text) => `'${Str.replaceAll("'", "''")(text)}'`),
									", "
								)
								const rows = yield* session.values(`EXPLAIN (FORMAT JSON) EXECUTE p(${args})`, [])
								const plan = succeeded(parsePlanTree(rows[0]?.[0]), "one EXPLAIN plan")
								assert.deepEqual(
									sequentialScans(plan, chosen.relation),
									[],
									`${chosen.label} ${c.mode}`
								)
								cx.note(`${chosen.label} ${c.mode}`)
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "R04: a read whose discriminator is a literal never scans its relation sequentially, under either plan cache mode"
		},
		show: Formatter.format,
		budget: { runs: 16, steered: 16 },
		kept: [],
		kills: []
	})
