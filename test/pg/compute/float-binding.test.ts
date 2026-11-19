import { assert } from "@bjornpagen/testing/assert"
/**
 * A guarded float form binds its compound operands once per row, never in a SubPlan PostgreSQL runs again for every
 * row (lower/conservative/expr/lateral.ts), and computes what the reference evaluator computes.
 *
 * Each case draws a tree of IEEE 754 arithmetic over the double precision and real columns of a ledger, nested so an
 * operand is itself an operation, with casts between the two widths, and reads it where a statement evaluates it for
 * every row: delivered per entry, summed and averaged per group, filtered on, grouped by, tested in the condition of
 * a delivered conditional, which a CASE evaluates for every row as its first WHEN, and tested in the condition of a
 * conditional that keys a filter's closed read, whose dictionary payload the read indexes by an expression of that key.
 * Two fact sets run it:
 *
 * - the edge classes of each float type, NaN and the infinities among them, through the conservative and the optimized
 *   lowering against the reference evaluator, which must agree exactly, or, for the closed read, which the reference
 *   evaluates none of, the optimized lowering against the conservative one;
 * - moderate values, small dyadic fractions none of whose operations leaves the native range of its type
 *   (scalar/compute/native.ts nativeRange), so every guarded form takes its fast path: each statement both lowerings
 *   send is planned under EXPLAIN ANALYZE, and no SubPlan or InitPlan of it runs, since the exact paths, the only
 *   bindings left in a branch, are never taken. A binding a statement evaluated per row in a scalar subquery shows as
 *   a SubPlan that ran once per row.
 *
 * Oracle: the reference evaluator for the edge classes, the conservative lowering for the closed read, and EXPLAIN
 * ANALYZE's SubPlans and InitPlans for the binding.
 *
 * Features: every position a statement evaluates the tree in, and each float width and cast.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	aimedCaseGen,
	exprOf,
	type Feature,
	featuresOf,
	judged,
	ledgerCase,
	lowerings,
	positions,
	queryOf,
	subplansOf
} from "#test/pg/compute/float-binding.fixtures.ts"
import {
	comparisonFailed,
	defaultRunOptions,
	type RunOptions,
	runLabelledOracle
} from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Guarded float forms on PostgreSQL 19 bind their operands once per row and compute the reference's values, over
 * generated terms: each case on a substrate of its own (Substrate.installing), its oracle seat over it as the Vitest
 * suite's OracleSeat.layer gave one (OracleSeat.ofSubstrate), since its EXPLAIN ANALYZE reads the substrate beside it.
 *
 * Its pre-conversion budget: runs 60, coverage cases 60 (test/pg/compute/float-binding.test.ts at c568eb123).
 */
export const guardedFloatFormsBindTheirOperandsOncePerRowAndComputeTheReferencesValues =
	property.explore(aimedCaseGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			"width:float8",
			"width:float4",
			"an operand that is an operation",
			"a cast of an operation",
			"a division",
			...Arr.map(positions, (p): Feature => `position:${p}`)
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate }, cx: Case<Feature>) =>
			(k) =>
				Effect.flatMap(substrate, (taken) =>
					Effect.provideService(
						Effect.provideService(
							Effect.gen(function* () {
								const schema = yield* taken.schema({ create: false, label: "floatbinding" })
								const options: RunOptions = {
									...defaultRunOptions,
									schema: { kind: "named", name: schema }
								}
								cx.noteAll(featuresOf(k))
								const desc = queryOf(exprOf(k.term), k.term.width, k.position)
								const edge = ledgerCase("edge classes", desc, k.edge)
								const moderate = ledgerCase("moderate values", desc, k.moderate)
								for (const [lowering, judge] of judged(k.position)) {
									for (const c of [edge, moderate]) {
										const outcome = yield* runLabelledOracle(c, lowering, judge, options)
										if (!outcome.comparison.equal) {
											return yield* comparisonFailed(outcome)
										}
									}
								}
								for (const lowering of lowerings) {
									const ran = yield* subplansOf(moderate, lowering, schema)
									assert.deepEqual(
										ran,
										[],
										"no SubPlan or InitPlan runs over values every guarded form computes natively"
									)
								}
							}),
							OracleSeat,
							OracleSeat.ofSubstrate(taken)
						),
						Substrate,
						taken
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator, the conservative lowering, and EXPLAIN ANALYZE"
		},
		budget: { runs: 60, steered: 60 },
		kept: [],
		kills: []
	})
