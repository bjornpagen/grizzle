import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Duration, Effect, Formatter } from "effect"
import { BudgetMeter, checkBound } from "#compiler/core/budget.ts"
import { formatLoc, sitedLoc } from "#compiler/core/loc.ts"
import { type BudgetKind, budgetKinds } from "#compiler/core/policy.ts"
import { assert, refusalLoc, refused, succeeded } from "#test/support/assert.ts"
import { budgetBoundOf } from "#test/support/kernel/policy.ts"

/**
 * Compiler resource bounds (core/budget.ts): "Exceeding a compiler resource bound yields a source-located error."
 *
 * A meter is checked against a reference model over drawn limits and drawn charges: each kind's use is the sum of its
 * charges, a charge succeeds exactly while that sum is within the kind's limit, and the first that crosses it is
 * ResourceBound at the charge's own location, naming the kind, its limit and the sum it needed. It never truncates and
 * stops at that first refusal: every later charge returns the same refusal and counts nothing, so the use stays what it
 * was before the refused charge. A one-shot bound (checkBound) admits a value exactly up to its limit.
 *
 * One step against a meter: a charge of one kind, or a one-shot bound, each at its own location.
 */
type Step =
	| {
			readonly kind: "charge"
			readonly budget: BudgetKind
			readonly amount: number
			readonly at: number
	  }
	| { readonly kind: "bound"; readonly limit: number; readonly value: number; readonly at: number }

type BudgetFeature =
	| "a charge within its limit"
	| "a charge crossing its limit"
	| "a charge after the meter refused"
	| "a one-shot bound met exactly"
	| "a one-shot bound exceeded"

/**
 * A step's location: a declaration at a call site, distinct per step, so a refusal located at another step's charge is
 * told apart.
 */
const locOf = (at: number) =>
	sitedLoc("query q", ["workload", "q", "arms", at], {
		file: "/app/queries.ts",
		line: at + 1,
		column: 5
	})

/** Limits around the charges drawn: zero, so a kind is exhausted by its first charge, up to a few charges' worth. */
const limitGen = int(0, 12)

const stepGen: Gen<Step> = oneOf<Step>([
	(source) => ({
		kind: "charge",
		budget: source.draw(element(budgetKinds)),
		amount: source.draw(int(0, 5)),
		at: source.draw(int(0, 63))
	}),
	(source) => ({
		kind: "bound",
		limit: source.draw(int(0, 6)),
		value: source.draw(int(0, 8)),
		at: source.draw(int(0, 63))
	})
])

const caseGen: Gen<{
	readonly limits: Readonly<Record<BudgetKind, number>>
	readonly steps: ReadonlyArray<Step>
}> = (source) => ({
	limits: { nodes: source.draw(limitGen) },
	steps: source.draw(array(stepGen, { min: 1, max: 24 }))
})

describe("BudgetMeter and checkBound", () => {
	it.effect(
		"count every charge, refuse exactly past the limit at the charge's location, and stop at that first refusal",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/core/budget",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<BudgetFeature>(
							[
								"a charge within its limit",
								"a charge crossing its limit",
								"a charge after the meter refused",
								"a one-shot bound met exactly",
								"a one-shot bound exceeded"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						/**
						 * Each case runs up to 24 steps at limits of 0 to 12: three hundred cases cross the limit and charge past
						 * a refusal many times over.
						 */
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					({ limits, steps }, c) =>
						Effect.sync(() => {
							const meter = new BudgetMeter(limits)
							const used: Record<BudgetKind, number> = { nodes: 0 }
							/** The first refusal's location and bound, once a charge crossed its limit. */
							let first:
								| { readonly at: number; readonly budget: BudgetKind; readonly needed: number }
								| undefined
							for (const step of steps) {
								switch (step.kind) {
									case "charge": {
										const result = meter.charge(step.budget, step.amount, locOf(step.at))
										const limit: number = limits[step.budget]
										if (first !== undefined) {
											const error = refused(result, "ResourceBound")
											assert.equal(formatLoc(refusalLoc(error)), formatLoc(locOf(first.at)))
											assert.deepEqual(budgetBoundOf(error), {
												kind: "budget",
												budget: first.budget,
												limit: limits[first.budget],
												needed: first.needed
											})
											c.note("a charge after the meter refused")
										} else if (used[step.budget] + step.amount <= limit) {
											succeeded(result)
											used[step.budget] += step.amount
											c.note("a charge within its limit")
										} else {
											const needed = used[step.budget] + step.amount
											const error = refused(result, "ResourceBound")
											assert.equal(formatLoc(refusalLoc(error)), formatLoc(locOf(step.at)))
											assert.deepEqual(budgetBoundOf(error), {
												kind: "budget",
												budget: step.budget,
												limit,
												needed
											})
											first = { at: step.at, budget: step.budget, needed }
											c.note("a charge crossing its limit")
										}
										assert.equal(meter.used(step.budget), used[step.budget])
										break
									}
									case "bound": {
										const result = checkBound("demand", step.limit, step.value, locOf(step.at))
										if (step.value <= step.limit) {
											succeeded(result)
											if (step.value === step.limit) {
												c.note("a one-shot bound met exactly")
											}
										} else {
											const crossed = refused(result, "ResourceBound")
											assert.deepEqual(crossed.reason, {
												_tag: "ResourceBound",
												at: locOf(step.at),
												bound: {
													kind: "rewriteSteps",
													rewrite: "demand",
													limit: step.limit,
													needed: step.value
												}
											})
											c.note("a one-shot bound exceeded")
										}
										break
									}
								}
							}
						})
				)
			)
	)
})
