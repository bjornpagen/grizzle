import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Order, Result } from "effect"
import { NodeId } from "#compiler/core/ids.ts"
import { nodesByLabel, relNode, rooted } from "#compiler/ir/dag.ts"
import type { EvidenceCatalog, TemplateContext } from "#compiler/ir/evidence.ts"
import { deliveredInput, metaSpecOf, type RelDag } from "#compiler/ir/rel.ts"
import { placeDeduplication } from "#compiler/lower/optimize/dedup/place.ts"
import { edgeFold } from "#compiler/lower/optimize/dedup/policy.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import {
	closureRoot,
	existsOverTakeRoot,
	fanoutJoinRoot,
	groupRoot,
	keyedJoinRoot,
	noninjectiveKeyCaseGen,
	projectGroupRoot,
	projectRoot,
	rootedCaseGen,
	taggedUnionRoot,
	untaggedUnionRoot,
	witnessRoot
} from "#test/support/oracle/mutants/cases.ts"

import {
	noBindings,
	Reference,
	type ReferenceInput,
	unobserved
} from "#test/support/oracle/reference/evaluate.ts"
import { ReferenceUnsupported, rowKey } from "#test/support/oracle/reference/values.ts"
import { verifyMultiplicity } from "#test/support/oracle/verify/multiplicity.ts"
import { BagReference, uniqueOn } from "#test/unit/analysis/physical/support.ts"
import { present } from "#test/unit/lower/support.ts"

/**
 * Placement is sound on the rows themselves.
 *
 * Over generated cases (the oracle generator and the counterexample suite's rooted and hand-built cases), the plan's
 * realization is evaluated by the bag evaluator, which keeps exactly the repeats each fragment's SQL would deliver
 * (test/unit/analysis/physical/support.ts BagReference), and checked against the brute-force reference, which
 * deduplicates every node as the conservative lowering does:
 *
 * - the program's result has no repeated row and is exactly the reference set;
 * - every consumer that observes repeats, a fold, a bound, a page, an attachment, sees an input with one row per value
 *   of the heading it needs, unless it is a fold deduplicating its own contributions;
 * - the kernel verification's recomputation (oracle/verify/multiplicity.ts) finds no problem in the plan.
 *
 * "Unknown evidence gets conservative duplicate elimination, never guessed uniqueness": one
 * counterexample fails the suite.
 */

interface Env {
	readonly context: TemplateContext
	readonly catalog: EvidenceCatalog
	readonly roots: "result"
}

/** A case read in a snapshot, under its schema's own catalog. */
const snapshotOf = (input: ReferenceInput): Env => ({
	context: "snapshot",
	catalog: genCatalog(input.schema),
	roots: "result"
})

/**
 * What a checked case reached: a placed duplicate elimination, an elided one, and a delivery the reference evaluated,
 * so a suite that silently checks nothing fails.
 */
type DedupFeature =
	| "a duplicate elimination placed"
	| "a duplicate elimination elided"
	| "a delivery evaluated"

const sound = (dag: RelDag, input: ReferenceInput, env: Env, c: Case<DedupFeature>): void => {
	const plan = succeeded(placeDeduplication(dag, env), "the placement")
	const verified = succeeded(verifyMultiplicity(dag, plan, env), "the verification")
	assert.deepEqual(verified.problems, [])
	if (plan.placements.length > 0) {
		c.note("a duplicate elimination placed")
	}
	if (Arr.some(plan.decisions, (d) => d.status === "elided")) {
		c.note("a duplicate elimination elided")
	}
	/**
	 * The repeats the emitted SQL delivers: a node that only delivers another node's rows (an attachment, a law query,
	 * an ordered result) lowers as that node, so a DISTINCT realized on it is never emitted.
	 */
	const bag = BagReference.bag(dag, input, (node) =>
		deliveredInput(node) !== undefined ? "plain" : (plan.realization[node.id] ?? "plain")
	)
	const reference = Reference.of(dag, input)
	const evaluated = Result.try({
		try: (): void => {
			for (const root of dag.roots) {
				if (root.kind === "Forbid" || !bag.closed(root)) {
					continue
				}
				const delivered = bag.eval(root, noBindings)
				const columns = Arr.map(delivered.heading, (h) => h.name)
				if (!uniqueOn(delivered.heading, delivered.rows, columns)) {
					throw new Error(`repeated rows delivered at ${root.id}`)
				}
				const expected = reference.eval(root, noBindings)
				const keys = (rows: typeof delivered.rows) =>
					Arr.sort(
						Arr.map(rows, (r) => rowKey(r, delivered.heading)),
						Order.String
					)
				assert.deepEqual(keys(delivered.rows), keys(expected.rows))
			}
			for (const o of plan.analysis.obligations) {
				const fold = edgeFold(o.edge)
				if (fold !== undefined && plan.folds[fold.id]?.input === "distinct") {
					continue
				}
				if (o.edge.consumer.kind === "result" || !bag.closed(o.edge.input)) {
					continue
				}
				const rel = bag.eval(o.edge.input, noBindings)
				if (!uniqueOn(rel.heading, rel.rows, o.heading)) {
					throw new Error(
						`${o.edge.consumer.node.id} observes repeats of ${o.edge.input.id} on (${Arr.join(o.heading, ", ")})`
					)
				}
			}
			c.note("a delivery evaluated")
		},
		catch: (thrown): unknown => thrown
	})
	if (Result.isFailure(evaluated) && !(evaluated.failure instanceof ReferenceUnsupported)) {
		throw evaluated.failure
	}
}

/** The same query delivered in order: its root under an OrderedResult over the whole heading, a total order. */
const orderedRoot = (dag: RelDag): RelDag => {
	const input = present(dag.roots[0], "the root")
	const labels = nodesByLabel(dag)
	let k = labels.size
	while (labels.has(NodeId(`n${k}`))) {
		k++
	}
	const node = relNode(NodeId(`n${k}`), {
		kind: "OrderedResult",
		input,
		order: { keys: Arr.map(input.heading, (c) => ({ column: c.name, dir: "asc" as const })) },
		heading: input.heading,
		meta: metaSpecOf(input.meta),
		loc: undefined
	})
	return validateDag(rooted([node]))
}

describe("placement delivers the reference set with no repeats", () => {
	it.effect("generated cases", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/lower/dedup/soundness-1",
					literal: Formatter.format,
					kept: [],
					draw: drawn(queryCaseGen(defaultGenConfig)),
					runs: 400,
					shrink: completeShrink,
					coverage: required<DedupFeature>(
						[
							"a duplicate elimination placed",
							"a duplicate elimination elided",
							"a delivery evaluated"
						],
						{ cases: 400, sense: notesOnly }
					),
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(2)
				},
				(q, c) =>
					Effect.sync(() => {
						const input = {
							schema: q.schema,
							facts: q.facts,
							params: q.query.params,
							observer: unobserved
						}
						sound(q.query.dag, input, snapshotOf(input), c)
					})
			)
		)
	)

	it.effect("generated cases delivered as an ordered result", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/lower/dedup/soundness-2",
					literal: Formatter.format,
					kept: [],
					draw: drawn(queryCaseGen(defaultGenConfig)),
					runs: 200,
					shrink: completeShrink,
					coverage: required<DedupFeature>(["a duplicate elimination placed"], {
						cases: 200,
						sense: notesOnly
					}),
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(2)
				},
				(q, c) =>
					Effect.sync(() => {
						const input = {
							schema: q.schema,
							facts: q.facts,
							params: q.query.params,
							observer: unobserved
						}
						sound(orderedRoot(q.query.dag), input, snapshotOf(input), c)
					})
			)
		)
	)

	it.effect("generated cases compiled for the transaction context", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/lower/dedup/soundness-3",
					literal: Formatter.format,
					kept: [],
					draw: drawn(queryCaseGen(defaultGenConfig)),
					runs: 150,
					shrink: completeShrink,
					coverage: noCoverage,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(2)
				},
				(q, c) =>
					Effect.sync(() => {
						sound(
							q.query.dag,
							{ schema: q.schema, facts: q.facts, params: q.query.params, observer: unobserved },
							{ context: "transaction", catalog: genCatalog(q.schema), roots: "result" },
							c
						)
					})
			)
		)
	)

	it.effect(
		"the counterexample roots: projections, joins, witnesses, groups, unions, bounds under EXISTS, closures",
		(ctx) =>
			Effect.forEach(
				[
					projectRoot,
					keyedJoinRoot,
					fanoutJoinRoot,
					witnessRoot,
					groupRoot,
					projectGroupRoot,
					taggedUnionRoot,
					untaggedUnionRoot,
					existsOverTakeRoot,
					closureRoot(false),
					closureRoot(true)
				],
				(root, i) =>
					searched(
						ctx,
						explore(
							{
								suite: `unit/lower/dedup/soundness-4-${i}`,
								literal: Formatter.format,
								kept: [],
								draw: drawn(rootedCaseGen(root, defaultGenConfig)),
								runs: 80,
								shrink: completeShrink,
								coverage: noCoverage,
								concurrency: 1,
								steerEvery: 16,
								caseHang: Duration.minutes(2)
							},
							(q, c) =>
								Effect.sync(() => {
									const input = {
										schema: q.schema,
										facts: q.facts,
										params: q.query.params,
										observer: unobserved
									}
									sound(q.query.dag, input, snapshotOf(input), c)
								})
						)
					),
				{ discard: true }
			)
	)

	it.effect("noninjective key expressions", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/lower/dedup/soundness-5",
					literal: Formatter.format,
					kept: [],
					draw: drawn(noninjectiveKeyCaseGen),
					runs: 100,
					shrink: completeShrink,
					coverage: noCoverage,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(2)
				},
				(q, c) =>
					Effect.sync(() => {
						const input = {
							schema: q.schema,
							facts: q.facts,
							params: q.query.params,
							observer: unobserved
						}
						sound(q.query.dag, input, snapshotOf(input), c)
					})
			)
		)
	)
})
