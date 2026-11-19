/** What the properties of oracle.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Result } from "effect"
import { topoOrder } from "#compiler/ir/dag.ts"
import { type NodeOf, type RelNode } from "#compiler/ir/rel.ts"
import { type QueryCase } from "#test/support/oracle/gen/case.ts"
import { expectedStatements } from "#test/support/oracle/reference/deliver.ts"
import {
	columnIndex,
	Reference,
	type RelationValue,
	sortRows,
	unobserved
} from "#test/support/oracle/reference/evaluate.ts"
import { compare, ReferenceUnsupported, valueAt } from "#test/support/oracle/reference/values.ts"

/**
 * What a case reached: an ApproximateNearest node, one whose source ties at the cutoff, one whose source reads an outer
 * tuple through a correlated region, and a conservative run that delivered a row.
 */
export type AnnOracleFeature =
	| "approximate nearest"
	| "tie at the cutoff"
	| "correlated under a source boundary"
	| "nonempty"

/**
 * The ANN population draws `approximate` in most of its cases: 300 rotating cases (and the floor's 75) reach the
 * required features.
 */
export const cases = 300

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
export const nearestFeatures = (c: QueryCase): ReadonlyArray<AnnOracleFeature> => {
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
