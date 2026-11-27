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
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
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
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * Guarded float forms on PostgreSQL 19 bind their operands once per row and compute the reference's values, over
 * generated terms: each case one owner transaction, rolled back after it (Substrate.rolledBack), its oracle seat over
 * that transaction (OracleSeat.rolledBack), where its EXPLAIN ANALYZE reads the case's own schema.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/compute/float-binding.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/compute/float-binding.test.ts` at its budget
 *   before, `{ runs: 60, steered: 60 }`, each kill's verdict printed with where its witnesses went red (judgedLine with
 *   the red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by
 *   path in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on case 3 of its floor stream
 * @decision the least runs whose floor stream, a quarter of them rounded up, holds its first 4 cases: 13; no headroom:
 *   a kill its witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const guardedFloatFormsBindTheirOperandsOncePerRowAndComputeTheReferencesValues =
	property.explore(aimedCaseGen, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [
			"width:float8",
			"width:float4",
			"an operand that is an operation",
			"a cast of an operation",
			"a division",
			...Arr.map(positions, (p): Feature => `position:${p}`)
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ tx }, cx: Case<Feature>) =>
			(k) =>
				Effect.flatMap(tx, (held) =>
					Effect.provideService(
						Effect.gen(function* () {
							const schema = yield* held.schema("floatbinding")
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
								const ran = yield* subplansOf(moderate, lowering, schema, held)
								assert.deepEqual(
									ran,
									[],
									"no SubPlan or InitPlan runs over values every guarded form computes natively"
								)
							}
						}),
						OracleSeat,
						OracleSeat.rolledBack(held)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator, the conservative lowering, and EXPLAIN ANALYZE"
		},
		budget: { runs: 13, steered: 60 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/compute/float-binding.test.ts#guardedFloatFormsBindTheirOperandsOncePerRowAndComputeTheReferencesValues:fff.1:0.0.0.0.0.1.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.1.1"
				),
				reason:
					"a float8 summed over moderate values (all 0), grouped and delivered in its group's order: the optimized lowering holds the grouped rows in a MATERIALIZED CTE it then sorts (lower/shapes/index.ts #formed), whose plan EXPLAIN reports as an InitPlan named for its CTE, which the plan-shape half read as a subquery expression's that ran (floor seed 0xd3c59360, case 1, at grizzle 26760a21)",
				since: "2026-11-25"
			}
		],
		kills: [
			{
				file: "test/pg/compute/float-binding.fixtures.ts",
				original: "\t\t\t!Option.exists(n.subplanName, (name) => ctes.has(name)) &&\n",
				replacement: "",
				why: "A WITH query's plan counts as a subquery expression's, as before: the summed position's held grouped rows, an InitPlan of the statement named for its CTE, read as a guarded form's exact path run over moderate values; the kept case fails."
			},
			{
				file: "packages/engine/src/lower/conservative/expr/lateral.ts",
				original: "\t\tcore: (c) => bindCore(c, supply, originals),",
				replacement:
					"\t\tcore: ((cores: Map<SelectCore, SelectCore>) => (c: SelectCore, original: SelectCore): SelectCore => { const bound = cores.get(original) ?? bindCore(c, supply, originals); cores.set(original, bound); return bound })(new Map()),",
				why: "A core the term shares between two operations is bound once and that one binding embedded at both, its LATERAL alias defined twice in one statement, which the conservative statement's structural audit refuses."
			}
		]
	})
