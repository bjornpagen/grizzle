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
 * Plants: compute-when-unguarded (Compute.when lowers to its proved branch alone, so a zero divisor raises 22012).
 *
 * Features: each plan with each bound, "custom plan, zero" to "generic plan, a divisor".
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Formatter } from "effect"
import { int8Max, int8Min } from "#compiler/core/limits.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { textCell } from "#test/pg/compute/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import {
	baseParams,
	lowerWith,
	param,
	plainRender,
	renderSql,
	spelledExpr,
	testPg,
	v
} from "#test/unit/compute/support.ts"

type Plan = "custom" | "generic"
type Bound = "zero" | "a divisor"

/** A case: the plan forced, the dividend, and the divisor bound to d, zero or a nonzero bigint. */
interface GuardCase {
	readonly plan: Plan
	readonly dividend: bigint
	readonly divisor: bigint
}

/** A nonzero bigint: its magnitude from 1 to int8's greatest, either sign, so int8's least is never its quotient's. */
const nonzero: Gen<bigint> = (source) => {
	const magnitude = source.draw(bigint(1n, int8Max.value))
	return source.draw(boolean) ? -magnitude : magnitude
}

const caseGen: Gen<GuardCase> = (source) => ({
	plan: source.draw(element<Plan>(["custom", "generic"])),
	dividend: source.draw(bigint(int8Min.value + 1n, int8Max.value)),
	divisor: source.draw(boolean) ? 0n : source.draw(nonzero)
})

/** The guarded quotient's SQL over the literal dividend and the parameter $1, the guarded subject. */
const guardedSql = (dividend: bigint): string => {
	const lowered = lowerWith(
		"query",
		spelledExpr(
			Compute.when(
				Compute.nonzero(param("d", testPg.bigint)),
				(d: ScalarTerm) => Compute.div(v("x", testPg.bigint), d),
				0n
			).expr
		),
		{ x: { kind: "literal", field: testPg.bigint, value: dividend } },
		false,
		baseParams
	)
	return renderSql(succeeded(lowered).root.expr, plainRender)
}

layer(Substrate.layer)("a guard over a parameter on PostgreSQL 19", (it) => {
	it.effect(
		"delivers the otherwise value for a zero divisor and the quotient for another, under a custom and a generic plan",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { session } = yield* Substrate
					const db = yield* session(ownerSession())
					return yield* explore(
						{
							oracle: {
								kind: "specification",
								name: "the otherwise value at zero, the quotient truncated toward zero elsewhere"
							},
							suite: "pg/compute/guard-param",
							draw: drawn(caseGen),
							literal: Formatter.format,
							coverage: required<`${Plan} plan, ${Bound}`>(
								[
									"custom plan, zero",
									"custom plan, a divisor",
									"generic plan, zero",
									"generic plan, a divisor"
								],
								{ cases: 16, sense: notesOnly }
							),
							kept: [],
							runs: 16,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 4,
							caseHang
						},
						({ plan, dividend, divisor }, c) =>
							Effect.gen(function* () {
								c.note(`${plan} plan, ${divisor === 0n ? "zero" : "a divisor"}`)
								const name = `guard_param_${plan}`
								yield* db.query(`SET plan_cache_mode = force_${plan}_plan`, [])
								yield* db.query(
									`PREPARE ${name}(bigint) AS SELECT (${guardedSql(dividend)})::text`,
									[]
								)
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
							})
					)
				})
			)
	)
})
