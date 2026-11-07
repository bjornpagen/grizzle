import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Formatter } from "effect"
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

/**
 * A guard over a parameter on PostgreSQL 19: Compute.when(Compute.nonzero(d), (d) => Compute.div(x, d), 0n) over a
 * bigint parameter d, prepared and executed under a custom and a generic plan with d bound to zero and to a divisor.
 * PostgreSQL drops the result of a WHEN that folds to false at plan time before it simplifies that result, and a custom
 * plan's parameter is such a constant; a generic plan evaluates the result only where its WHEN holds. Neither raises:
 * zero delivers the otherwise value, a divisor the quotient, and the plan PostgreSQL used is the one forced.
 */

type Plan = "custom" | "generic"
type Bound = "zero" | "a divisor"

const dividend = 84n
const divisor = 4n

/** The guarded quotient's SQL over the literal dividend and the parameter $1, the guarded subject. */
const guardedSql = (): string => {
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
				exhaust(
					{
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
						suite: "pg/compute/guard-param",
						literal: Formatter.format,
						generator: (source) =>
							[
								source.draw(element<Plan>(["custom", "generic"])),
								source.draw(element<Bound>(["zero", "a divisor"]))
							] as const,
						limit: 4,
						coverage: requiredInSpace<`${Plan} plan, ${Bound}`>([
							"custom plan, zero",
							"custom plan, a divisor",
							"generic plan, zero",
							"generic plan, a divisor"
						]),
						caseHang
					},
					([plan, bound], c) =>
						Effect.gen(function* () {
							c.note(`${plan} plan, ${bound}`)
							const { session } = yield* Substrate
							const db = yield* session(ownerSession())
							const name = `guard_param_${plan}_${bound === "zero" ? "zero" : "divisor"}`
							yield* db.query(`SET plan_cache_mode = force_${plan}_plan`, [])
							yield* db.query(`PREPARE ${name}(bigint) AS SELECT (${guardedSql()})::text`, [])
							const rows = yield* db.values(
								`EXECUTE ${name}(${bound === "zero" ? "0" : String(divisor)})`,
								[]
							)
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
							const expected = bound === "zero" ? 0n : dividend / divisor
							assert.ok(
								Decimal.of(text).equals(Decimal.of(String(expected))),
								`the guarded quotient is ${expected}, not ${text}`
							)
						})
				)
			)
	)
})
