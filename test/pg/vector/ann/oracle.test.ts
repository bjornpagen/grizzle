/**
 * ApproximateNearest rows against the reference evaluator on PostgreSQL 19: over generated cases of the ANN population
 * (test/support/oracle/gen/case.ts annGenConfig), the conservative lowering of an approximateNearest, its exact
 * top-k of the source, delivers exactly the reference evaluator's top-k, ties at the cutoff broken by the key, a source
 * correlated under a boundary evaluated under the outer tuples in scope.
 *
 * Oracle: the brute-force reference evaluator's top-k over the same facts.
 *
 * Plants: vector-conservative-take-off-by-one (the conservative form takes one candidate fewer).
 *
 * Features: an ApproximateNearest node, a tie at the cutoff, a source correlated under a boundary, and a delivered row.
 */
import { drawn } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { NodeOf, RelNode } from "#compiler/ir/rel.ts"
import { defined } from "#test/support/assert.ts"
import { annGenConfig, type QueryCase, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { expectedStatements } from "#test/support/oracle/reference/deliver.ts"
import {
	columnIndex,
	Reference,
	type RelationValue,
	sortRows,
	unobserved
} from "#test/support/oracle/reference/evaluate.ts"
import { compare, ReferenceUnsupported, valueAt } from "#test/support/oracle/reference/values.ts"
import {
	comparisonFailed,
	conservative,
	defaultRunOptions,
	oracleCheck,
	reference,
	runOracle
} from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * What a case reached: an ApproximateNearest node, one whose source ties at the cutoff, one whose source reads an outer
 * tuple through a correlated region, and a conservative run that delivered a row.
 */
type AnnOracleFeature =
	| "approximate nearest"
	| "tie at the cutoff"
	| "correlated under a source boundary"
	| "nonempty"

/**
 * The ANN population draws `approximate` in most of its cases: 300 rotating cases (and the floor's 75) reach the
 * required features.
 */
const cases = 300

/**
 * Whether a source, as the reference evaluated it under the outer tuples then in scope, holds more than `take` tuples
 * whose `take`-th and next least scores are equal: the candidates at the cutoff are then chosen by the tie-break alone.
 */
const tiesAtCutoff = (n: NodeOf<"ApproximateNearest">, source: RelationValue): boolean => {
	const take = Number(n.take)
	if (take < 1 || source.rows.length <= take) {
		return false
	}
	const at = columnIndex(source.heading, n.score, n.id)
	const type = defined(source.heading[at], "the score column").type
	const sorted = sortRows(source.heading, source.rows, { keys: [{ column: n.score, dir: "asc" }] })
	const last = valueAt(defined(sorted[take - 1], "the last candidate"), at)
	const next = valueAt(defined(sorted[take], "the first tuple past the cutoff"), at)
	return compare(last, next, type) === 0
}

/** Whether the subtree under `node` holds a region with a correlated variable: one that reads an outer tuple. */
const correlatedUnder = (node: RelNode): boolean =>
	Arr.some(topoOrder({ roots: [node] }), (n) => n.kind === "MatchRegion" && n.correlated.length > 0)

/**
 * What the case's ApproximateNearest evaluations reach, observed as the reference evaluates the root, each source under
 * the outer tuples in scope (a source read on its own has no value where it reads one). A case the reference does not
 * evaluate notes none here; the oracle run reports it. A case the reference does not state reaches what it observed
 * before; anything else it throws fails the case.
 */
const nearestFeatures = (c: QueryCase): ReadonlyArray<AnnOracleFeature> => {
	const reached = new Set<AnnOracleFeature>()
	const ref = Reference.of(c.query.dag, {
		schema: c.schema,
		facts: c.facts,
		params: c.query.params,
		observer: {
			...unobserved,
			nearest: (n, source) => {
				if (tiesAtCutoff(n, source)) {
					reached.add("tie at the cutoff")
				}
				if (correlatedUnder(n.source)) {
					reached.add("correlated under a source boundary")
				}
			}
		}
	})
	const observed = Result.try(() => expectedStatements(ref, c.query.dag.roots[0]))
	if (Result.isFailure(observed) && !(observed.failure instanceof ReferenceUnsupported)) {
		throw observed.failure
	}
	return [...reached]
}

const agree = Effect.gen(function* () {
	const s = yield* Substrate
	const schema = yield* s.schema({ create: false, label: "annoracle" })
	return yield* oracleCheck(
		drawn(queryCaseGen(annGenConfig)),
		{
			suite: "vector/ann-oracle",
			oracle: {
				kind: "second-implementation",
				name: "the reference evaluator over the same facts"
			},
			literal: Formatter.format,
			coverage: required<AnnOracleFeature>(
				[
					"approximate nearest",
					"tie at the cutoff",
					"correlated under a source boundary",
					"nonempty"
				],
				{ cases: cases, sense: notesOnly }
			),
			kept: [],
			runs: cases,
			shrink: completeShrink,
			perturb: "all"
		},
		(c, k) =>
			Effect.gen(function* () {
				if (Arr.some(topoOrder(c.query.dag), (n) => n.kind === "ApproximateNearest")) {
					k.note("approximate nearest")
				}
				k.noteAll(nearestFeatures(c))
				const outcome = yield* runOracle(c, conservative, reference, {
					...defaultRunOptions,
					schema: { kind: "named", name: schema }
				})
				if (!outcome.comparison.equal) {
					return yield* comparisonFailed(outcome)
				}
				if (Arr.some(outcome.left.run.statements, (st) => st.rows.length > 0)) {
					k.note("nonempty")
				}
			})
	)
})

layer(Substrate.layer)("ApproximateNearest rows against the reference evaluator", (it) => {
	it.effect(
		`the conservative lowering delivers the reference's top-k on ${cases} generated cases`,
		(ctx) => searched(ctx, agree)
	)
})
