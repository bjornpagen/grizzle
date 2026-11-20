/** What the properties of guard-param.test.ts read: its spaces, models and helpers. */

import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { bigint } from "@bjornpagen/testing/values"
import { int8Max, int8Min } from "#compiler/ir/carriers.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { succeeded } from "#test/support/assert.ts"
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

export type Plan = "custom" | "generic"

export type Bound = "zero" | "a divisor"

/** A case: the plan forced, the dividend, and the divisor bound to d, zero or a nonzero bigint. */
interface GuardCase {
	readonly plan: Plan
	readonly dividend: bigint
	readonly divisor: bigint
}

/** A nonzero bigint: its magnitude from 1 to int8's greatest, either sign, so int8's least is never its quotient's. */
const nonzero: Gen<bigint> = (source) => {
	const magnitude = source.draw(bigint(1n, int8Max))
	return source.draw(boolean) ? -magnitude : magnitude
}

export const caseGen: Gen<GuardCase> = (source) => ({
	plan: source.draw(element<Plan>(["custom", "generic"])),
	dividend: source.draw(bigint(int8Min + 1n, int8Max)),
	divisor: source.draw(boolean) ? 0n : source.draw(nonzero)
})

/** The guarded quotient's SQL over the literal dividend and the parameter $1, the guarded subject. */
export const guardedSql = (dividend: bigint): string => {
	const lowered = lowerWith(
		"query",
		spelledExpr(
			computeCore.when(
				computeCore.nonzero(param("d", testPg.bigint)),
				(d: ScalarTerm) => computeCore.div(v("x", testPg.bigint), d),
				0n
			).expr
		),
		{ x: { kind: "literal", field: testPg.bigint, value: dividend } },
		false,
		baseParams
	)
	return renderSql(succeeded(lowered).root.expr, plainRender)
}
