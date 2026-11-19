/**
 * A guard over a parameter on PostgreSQL 19: Compute.when(Compute.nonzero(d), (d) => Compute.div(x, d), 0n) over a
 * bigint parameter d and a drawn bigint dividend x, prepared and executed under a custom or a generic plan with d bound
 * to zero or to a drawn divisor. PostgreSQL drops the result of a WHEN that folds to false at plan time before it
 * simplifies that result, and a custom plan's parameter is such a constant; a generic plan evaluates the result only
 * where its WHEN holds.
 *
 * - Neither plan raises: zero delivers the otherwise value, 0, and a divisor the quotient truncated toward zero.
 * - The plan PostgreSQL used is the one forced (pg_prepared_statements' counts), the premise of the property.
 *
 * Oracle: the guard's specification, the otherwise value at zero and BigInt's truncated quotient elsewhere.
 *
 * Features: each plan with each bound, "custom plan, zero" to "generic plan, a divisor".
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import {
	type Bound,
	caseGen,
	guardedSql,
	type Plan
} from "#test/pg/compute/guard-param.fixtures.ts"
import { textCell } from "#test/pg/compute/support.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A guard over a parameter on PostgreSQL 19 delivers the otherwise value for a zero divisor and the quotient for another, under a custom and a generic plan.
 *
 * Its pre-conversion budget: runs 16, coverage cases 16 (test/pg/compute/guard-param.test.ts at c568eb123).
 */
export const aGuardOverAParameterOnPostgreSQL19DeliversTheOtherwiseValueForAZeroDivisorAndTheQuotientForAnotherUnderACustomAndAGenericPlan =
	property.explore(caseGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			"custom plan, zero",
			"custom plan, a divisor",
			"generic plan, zero",
			"generic plan, a divisor"
		] satisfies ReadonlyArray<Reached<`${Plan} plan, ${Bound}`>>,
		check:
			({ substrate }, c: Case<`${Plan} plan, ${Bound}`>) =>
			({ plan, dividend, divisor }) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const { session } = yield* Substrate
						const db = yield* session(ownerSession())

						c.note(`${plan} plan, ${divisor === 0n ? "zero" : "a divisor"}`)
						const name = `guard_param_${plan}`
						yield* db.query(`SET plan_cache_mode = force_${plan}_plan`, [])
						yield* db.query(`PREPARE ${name}(bigint) AS SELECT (${guardedSql(dividend)})::text`, [])
						const rows = yield* db.values(`EXECUTE ${name}(${divisor})`, [])
						const counts = yield* db.values(
							`SELECT generic_plans::text, custom_plans::text FROM pg_catalog.pg_prepared_statements WHERE name = '${name}'`,
							[]
						)
						yield* db.query(`DEALLOCATE ${name}`, [])
						yield* db.query("RESET plan_cache_mode", [])
						assert.deepEqual(
							counts[0],
							plan === "generic" ? ["1", "0"] : ["0", "1"],
							`the plan PostgreSQL used under force_${plan}_plan`
						)
						const text = textCell(defined(rows[0], "the guarded quotient's row"), 0)
						const expected = divisor === 0n ? 0n : dividend / divisor
						assert.ok(
							Decimal.of(text).equals(Decimal.of(String(expected))),
							`the guarded quotient is ${expected}, not ${text}`
						)
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "the otherwise value at zero, the quotient truncated toward zero elsewhere"
		},
		budget: { runs: 16, steered: 16 },
		kept: [],
		kills: []
	})
