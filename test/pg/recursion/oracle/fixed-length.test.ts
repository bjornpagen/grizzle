import { layer } from "@effect/vitest"
import { drawn } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { type RecursionOracleFeature, recursiveForm } from "#test/pg/recursion/oracle/support.ts"
import {
	defaultGraphLimits,
	fixedLengthCaseGen,
	graphShapes,
	type RecursiveFeature
} from "#test/support/oracle/gen/recursive.ts"

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
 * Fixed-length connected matches give the same set through joins and through recursive CTEs.
 *
 * Each case is one DAG with two roots over a generated graph. Its first root is a connected match of k directed E steps
 * through joins, k from 1 to 6 (gen/recursive.ts): start, k - 1 bound intermediate vertices and
 * end, each optionally matched in V, the start a parameter or every vertex (then carried as origin), the direction
 * forward or reversed. Its second root is the same set through a recursive relation whose state counts hops, seeded
 * with one step and bounded at k, filtered to hops = k and projected (the upper bound belongs to the transition, the
 * exact length to a result predicate). Both lowerings run on PostgreSQL and agree as raw text multisets with no
 * repeated row on either side: distinct middles and repeated walks collapse at the projection, and walks may revisit
 * vertices, through self-loops and cycles, in both forms alike. The recursive form also agrees with the joins
 * evaluated by definition.
 *
 * @cpu-bound
 */

const cases = 800

const situations = [
	...Arr.map(graphShapes, (s): RecursiveFeature => `shape:${s}`),
	"length:1",
	"length:2",
	"length:3",
	"roots:param",
	"multiple roots carrying origin",
	"existence match",
	"direction:reverse",
	"self-loop",
	"parallel edges",
	"cycle",
	"diamond",
	"dangling edges"
] as const satisfies ReadonlyArray<RecursionOracleFeature>

layer(Substrate.layer)("fixed-length connected matches: joins against recursive CTEs", (it) => {
	it.effect(
		`give the same set on ${cases} generated graphs, and the recursive form equals the joins by definition`,
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema({ create: false, label: "fixedlength" })
					return yield* oracleCheck(
						drawn(fixedLengthCaseGen(defaultGraphLimits)),
						{
							suite: "recursion/fixed-length",
							literal: Formatter.format,
							coverage: required<RecursionOracleFeature>([...situations, "nonempty"], {
								cases: cases,
								sense: notesOnly
							}),
							kept: [],
							runs: cases,
							shrink: completeShrink,
							perturb: "all"
						},
						(c, notes) =>
							Effect.gen(function* () {
								notes.noteAll(c.features)
								/** The joins (conservative lowering of the first root) against the recursive CTE (of the second). */
								const joins = yield* runOracle(c, conservative, recursiveForm, {
									...defaultRunOptions,
									schema: { kind: "named", name: schema }
								})
								const cmp = joins.comparison
								if (!cmp.equal || cmp.leftDuplicates > 0 || cmp.rightDuplicates > 0) {
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
					)
				})
			)
	)
})
