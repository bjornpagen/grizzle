/**
 * The aggregate order arm: every sum and mean is a function of its arguments' multiset (scalar/aggregate.ts), whatever
 * the order the rows are stored and scanned in, the plan, a parallel worker's partial aggregate, a window frame or a
 * second aggregate in the same head.
 *
 * Each case draws a ledger of up to forty entries over three groups, each a double precision, a real and a money amount
 * from the classes whose IEEE sums depend on their order (gen/domain.ts edge classes: 0.1, 0.2, 0.3, ±1e20 beside 1,
 * ±DBL_MAX, subnormals, money at and a few steps from its int8 bounds), stored in the drawn order, and a perturbation:
 * the planner settings and fact copies of perturb.ts, or every plan forced parallel. The reference states each exact
 * sum once, with no order in it, and every lowering must deliver it exactly (compare.ts, canonical cells): the
 * conservative lowering of each grouped sum and mean, alone and all in one head, and the catalog's window for R41's
 * running total over double precision scores of the same classes.
 *
 * The situations are computed here from the drawn values, never by the system under test: two sequential IEEE sums of
 * a group, forward and backward, that differ; a money or double total that one of those orders overflows and the
 * exact total does not.
 *
 * Oracle: the reference evaluator's exact sums and means, which state each total once, with no order in it.
 *
 * Features: the order situations below, each computed from the drawn values, and forced parallel plans.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import * as Q from "#test/pg/catalog/queries.ts"
import {
	type Facts,
	appliedRules,
	catalogLowering,
	labOptions,
	oracleCase
} from "#test/pg/catalog/support.ts"
import {
	accumulationCases,
	judged,
	ledgerCase,
	ledgerQueries,
	type OrderSituation,
	situationsOf
} from "#test/pg/compute/accumulation.fixtures.ts"
import { CurrentPerturbation } from "#test/support/oracle/perturb.ts"
import { conservative } from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * Every float and money sum and mean is delivered as the exact reference states it, in any order and plan, each case in
 * its own rolled-back transaction on the worker's clone (Substrate.rolledBack, OracleSeat.rolledBack).
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/compute/accumulation.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/compute/accumulation.test.ts` at its budget
 *   before, `{ runs: 12, steered: 12 }`, each kill's verdict printed with where its witnesses went red (judgedLine with
 *   the red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by
 *   path in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on its kept case
 * @decision 1, the least a generative search draws: no declared kill needs a floor or a rotating case; no headroom: a
 *   kill its witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const deliversEveryFloatAndMoneySumAndMeanAsTheExactReferenceStatesItInAnyOrderAndPlan =
	property.explore(accumulationCases, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [
			"float sum whose IEEE orders disagree",
			"float mean whose IEEE orders disagree",
			"money sum overflowing in some order but not in total",
			"float sum overflowing in some order but not in total",
			"aggregate under forced parallel plans"
		] satisfies ReadonlyArray<Reached<OrderSituation>>,
		check:
			({ tx }, c: Case<OrderSituation>) =>
			(k) =>
				Effect.flatMap(tx, (held) =>
					Effect.provideService(
						Effect.gen(function* () {
							c.noteAll(situationsOf(k))
							const schema = yield* held.schema("accumulation")
							for (const [label, desc] of ledgerQueries) {
								yield* judged(
									label,
									ledgerCase(label, desc, k.entries),
									conservative,
									k.perturbation,
									schema
								)
							}
							const side = catalogLowering(labOptions())
							const facts: Facts = { sittings: k.sittings, prices: [], points: [] }
							yield* judged(
								"R41 running total",
								oracleCase("R41 running total", Q.running(Q.plainSelfMatch), facts),
								side,
								k.perturbation,
								schema
							)
							assert.ok(appliedRules(side.last()).includes("R41"), "R41 rewrote the running total")
						}).pipe(Effect.provideService(CurrentPerturbation, k.perturbation)),
						OracleSeat,
						OracleSeat.rolledBack(held)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator's exact sums and means"
		},
		show: Formatter.format,
		budget: { runs: 1, steered: 12 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/compute/accumulation.test.ts#deliversEveryFloatAndMoneySumAndMeanAsTheExactReferenceStatesItInAnyOrderAndPlan:-:1"
				),
				reason:
					"the issue's double sum whose IEEE orders disagree, in storage order: 1.6 and 0.26666666666666666 from every side (b35c479bb)",
				since: "2026-11-04"
			},
			{
				token: ReplayToken(
					"test/pg/compute/accumulation.test.ts#deliversEveryFloatAndMoneySumAndMeanAsTheExactReferenceStatesItInAnyOrderAndPlan:-:2"
				),
				reason: "the issue's group stored in reverse, its plans forced parallel (b35c479bb)",
				since: "2026-11-04"
			},
			{
				token: ReplayToken(
					"test/pg/compute/accumulation.test.ts#deliversEveryFloatAndMoneySumAndMeanAsTheExactReferenceStatesItInAnyOrderAndPlan:-:3"
				),
				reason:
					"the issue's money at its upper bound, a cent past it and back: 92233720368547758.07, never 22003 (b35c479bb)",
				since: "2026-11-04"
			}
		],
		kills: [
			{
				file: "test/support/oracle/gen/domain.ts",
				original: "\tfloat4: canonicalOnly,\n\tfloat8: canonicalOnly,",
				replacement:
					'\tfloat4: { kind: "twins", of: (literal) => (literal.kind === "float" && literal.value === 0 ? ["-0"] : []) },\n\tfloat8: { kind: "twins", of: (literal) => (literal.kind === "float" && literal.value === 0 ? ["-0"] : []) },',
				why: "A float's 0 is respelled -0 as a twin of one value, as before c067533e8 made -0 a value of its own: the kept money case stores a 0 as -0, its second reading another fact, and its sums deliver otherwise; this property fails."
			}
		]
	})
