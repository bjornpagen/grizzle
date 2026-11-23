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
	/**
	 * Its search budget: 1 run of its rotating stream, so a floor of 1 (a quarter of the runs, rounded up), and at most 48
	 * steered cases, the phase that runs only while a required situation is unreached. Its witnesses, the floor and the
	 * steered phase, are fixed by its identity, so every run seed reaches its situations and judges its kills alike.
	 *
	 * @limitKind measured
	 * @owner test/pg/recursion/oracle/fixed-length.test.ts's property, its search
	 * @unit cases: the rotating stream's runs, and the steered phase's most
	 * @scope one run of the property, on any run seed: its kept cases, its floor, its steered phase and its rotating
	 *   stream
	 * @evidence ~/.cache/grizzle/CULL-PAGEREC-notes: kills0.log, `toolchain-test kills test/pg/recursion
	 *   test/pg/page/generated-optimized.test.ts` at the pre-conversion budgets, each kill's first red witness printed by
	 *   a local line in the kills command's report, never committed; m1run.log and m2run.log with their run records
	 *   m1run.json and m2run.json, `toolchain-test run` of the module at the budgets in @workload, every kill judged after
	 *   its search and none answered by a cached verdict; final1.log and final1.json, the same at this budget under a
	 *   verdict cache of its own; each run under TEST_SEED=2219874524, its budget rewritten for the run
	 * @observed 2026-11-23 03:27 to 04:39 UTC
	 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, shared with other lanes' runs (1-minute
	 *   load 390 to 550); PostgreSQL 19.0, the in-memory family grizzle-m-cull-pagerec, two members settled by
	 *   toolchain-pg settle; grizzle f87b2aaab with test/pg/page's cull; vendor/toolchain 2cc4817; Node 26.13.1
	 * @workload this property at { runs, steered } of { 800, 800 }, its pre-conversion budget (fixed-length.test.ts
	 *   `cases` at 4fbc3e95), then { 1, 2000 }, { 29, 2000 }
	 * @result At { 800, 800 }, 1000 cases at f1bf91a2f's gate, its kill went red on floor case 0. Green, every required
	 *   situation reached by a witness, and every kill killed at { 1, 2000 } (50 cases, 48 steered); { 29, 2000 } (53
	 *   cases, 16 steered); and at { 1, 48 } again under a verdict cache of its own (final1). Worker CPU is a loaded
	 *   machine's and not compared
	 * @decision runs 1 and steered 48, the fewest cases measured: from a floor of 1 the steered phase reaches every
	 *   situation in 48 cases, from a floor of 8 in 16, three cases more in all; its kill is red on floor case 0 at every
	 *   budget measured. The steered phase stops once every situation is reached, so its cap costs no case beyond those it
	 *   runs. No headroom: a run that reaches fewer situations says which
	 * @revalidate a red naming an unreached situation; a kill added or changed; an edit to the property's identity (its
	 *   file or name), its generator or its situations; the runner's floor and steering (the toolchain's runner/search.ts,
	 *   random.ts and limits.ts)
	 */
	budget: { runs: 1, steered: 48 },
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
