/**
 * Fixed-length connected matches give the same set through joins and through recursive CTEs.
 *
 * Each case is one DAG with two roots over a generated graph. Its first root is a connected match of k directed E steps
 * through joins, k from 1 to 6 (gen/recursive.ts): start, k - 1 bound intermediate vertices and
 * end, each optionally matched in V, the start a parameter or every vertex (then carried as origin), the direction
 * forward or reversed. Its second root is the same set through a recursive relation whose state counts hops, seeded
 * with one step and bounded at k, filtered to hops = k and projected (the upper bound belongs to the transition, the
 * exact length to a result predicate). Both lowerings run on PostgreSQL and agree as raw text sets with no
 * repeated row on either side: distinct middles and repeated walks collapse at the projection, and walks may revisit
 * vertices, through self-loops and cycles, in both forms alike. The recursive form also agrees with the joins
 * evaluated by definition.

 */

import type { Reached } from "@bjornpagen/testing/features"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { fixedLengthSituations } from "#test/pg/recursion/oracle/fixed-length.fixtures.ts"
import { type RecursionOracleFeature, recursiveForm } from "#test/pg/recursion/oracle/support.ts"
import { defaultGraphLimits, fixedLengthCaseGen } from "#test/support/oracle/gen/recursive.ts"
import {
	comparisonFailed,
	conservative,
	defaultRunOptions,
	oracleProperty,
	reference,
	runOracle
} from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"

/** Fixed-length matches give the same set through joins and recursive CTEs, and the recursive form equals the joins by definition. */
export const fixedLength = oracleProperty(fixedLengthCaseGen(defaultGraphLimits), {
	situations: fixedLengthSituations satisfies ReadonlyArray<Reached<RecursionOracleFeature>>,
	perturb: "all",
	oracle: {
		kind: "universal",
		name: "a fixed-length match through joins and through a hop-counting recursive CTE are one set"
	},
	kept: [],
	/** Its pre-conversion budget: runs 800, coverage cases 800 (fixed-length.test.ts `cases` at 4fbc3e95). */
	budget: { runs: 800, steered: 800 },
	kills: [
		{
			file: "packages/engine/src/lower/conservative/recursive/index.ts",
			original: '\tconst body: Select = select({ kind: "setOp", op: "UNION", arms: [base, step] })',
			replacement:
				'\tconst body: Select = select({ kind: "setOp", op: "UNION", arms: [base, base] })',
			why: "The conservative lowering's recursive CTE unions its base with itself where its step belongs (lower/conservative/recursive), so it never steps past its seeds."
		}
	],
	show: Formatter.format,
	check: (notes: Case<RecursionOracleFeature>) => (c) =>
		Effect.gen(function* () {
			const seat = yield* OracleSeat
			const schema = yield* seat.schema("fixedlength")
			notes.noteAll(c.features)
			/** The joins (conservative lowering of the first root) against the recursive CTE (of the second). */
			const joins = yield* runOracle(c, conservative, recursiveForm, {
				...defaultRunOptions,
				schema: { kind: "named", name: schema }
			})
			const cmp = joins.comparison
			if (!cmp.equal) {
				return yield* comparisonFailed(joins)
			}
			/** The recursive CTE against the joins' answer by definition. */
			const defined = yield* runOracle(c, recursiveForm, reference, {
				...defaultRunOptions,
				schema: { kind: "named", name: schema }
			})
			if (!defined.comparison.equal) {
				return yield* comparisonFailed(defined)
			}
			if (Arr.some(joins.left.run.statements, (st) => st.rows.length > 0)) {
				notes.note("nonempty")
			}
		})
})
