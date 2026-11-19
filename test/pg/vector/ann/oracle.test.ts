/**
 * ApproximateNearest rows against the reference evaluator on PostgreSQL 19: over generated cases of the ANN population
 * (test/support/oracle/gen/case.ts annGenConfig), the conservative lowering of an approximateNearest, its exact
 * top-k of the source, delivers exactly the reference evaluator's top-k, ties at the cutoff broken by the key, a source
 * correlated under a boundary evaluated under the outer tuples in scope.
 *
 * Oracle: the brute-force reference evaluator's top-k over the same facts.
 *
 * Features: an ApproximateNearest node, a tie at the cutoff, a source correlated under a boundary, and a delivered row.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { topoOrder } from "#compiler/ir/dag.ts"
import { annGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import {
	comparisonFailed,
	conservative,
	defaultRunOptions,
	oracleProperty,
	reference,
	runOracle
} from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"

import {
	type AnnOracleFeature,
	cases,
	nearestFeatures
} from "#test/pg/vector/ann/oracle.fixtures.ts"

/**
 * ApproximateNearest rows against the reference evaluator: the conservative lowering delivers the reference's top-k on
 * generated cases, each case in its one rolled-back transaction on the worker's own clone (oracleProperty).
 *
 * Its pre-conversion budget: runs 300, coverage cases 300 (test/pg/vector/ann/oracle.test.ts at df895895a).
 */
export const approximateNearestRowsAgainstTheReferenceEvaluatorTheConservativeLoweringDeliversTheReferencesTopK =
	oracleProperty(queryCaseGen(annGenConfig), {
		situations: [
			"approximate nearest",
			"tie at the cutoff",
			"correlated under a source boundary",
			"nonempty"
		] satisfies ReadonlyArray<Reached<AnnOracleFeature>>,
		perturb: "all",
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator over the same facts"
		},
		budget: { runs: cases, steered: cases },
		kept: [],
		kills: [],
		show: Formatter.format,
		check: (k: Case<AnnOracleFeature>) => (c) =>
			Effect.gen(function* () {
				const seat = yield* OracleSeat
				const schema = yield* seat.schema("annoracle")
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
	})
