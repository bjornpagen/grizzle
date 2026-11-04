import { Buffer } from "node:buffer"
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, codePoint, element, type Gen, int, oneOf, string } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Duration, Effect, Formatter } from "effect"
import { BudgetMeter, budgetBoundOf, checkBound } from "#compiler/core/budget.ts"
import { formatLoc, sitedLoc } from "#compiler/core/loc.ts"
import { type BudgetKind, budgetKinds } from "#compiler/core/policy.ts"
import { assert, refusalLoc, refused, succeeded } from "#test/support/assert.ts"

/**
 * Compiler resource bounds (core/budget.ts): "Exceeding a compiler resource bound yields a source-located error."
 *
 * A meter is checked against a reference model over drawn limits and drawn charges: each kind's use is the sum of its
 * charges, a charge succeeds exactly while that sum is within the kind's limit, and a refusal is ResourceBound at the
 * charge's own location, naming the kind, its limit and the sum it needed. It never truncates: a refused charge still
 * counts, so the kind stays exhausted and every later charge to it is refused too, while the other kinds go on. A SQL
 * text is charged its UTF-8 bytes, the platform encoder's count. A one-shot bound (checkBound) admits a value exactly up
 * to its limit.
 *
 * One step against a meter: a charge of one kind, a SQL text charged to sqlBytes, or a one-shot bound, each at its own
 * location.
 */
type Step =
	| {
			readonly kind: "charge"
			readonly budget: BudgetKind
			readonly amount: number
			readonly at: number
	  }
	| { readonly kind: "sql"; readonly text: string; readonly at: number }
	| { readonly kind: "bound"; readonly limit: number; readonly value: number; readonly at: number }

type BudgetFeature =
	| "a charge within its limit"
	| "a charge crossing its limit"
	| "a charge after its kind is exhausted"
	| "a charge to another kind after one is exhausted"
	| "a SQL text of multi-byte characters"
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
		kind: "sql",
		text: source.draw(
			string(
				oneOf([codePoint(0x20, 0x7e), codePoint(0xa0, 0xd7_ff), codePoint(0xe0_00, 0x10_ffff)]),
				{ min: 0, max: 4 }
			)
		),
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
	limits: {
		nodes: source.draw(limitGen),
		fields: source.draw(limitGen),
		sqlBytes: source.draw(limitGen),
		params: source.draw(limitGen),
		variants: source.draw(limitGen)
	},
	steps: source.draw(array(stepGen, { min: 1, max: 24 }))
})

describe("BudgetMeter and checkBound", () => {
	it.effect(
		"count every charge, refuse exactly past the limit at the charge's location, and never truncate",
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
								"a charge after its kind is exhausted",
								"a charge to another kind after one is exhausted",
								"a SQL text of multi-byte characters",
								"a one-shot bound met exactly",
								"a one-shot bound exceeded"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						/**
						 * Each case runs up to 24 steps over five kinds at limits of 0 to 12: three hundred cases cross, exhaust
						 * and charge past every kind many times over.
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
							const used: Record<BudgetKind, number> = {
								nodes: 0,
								fields: 0,
								sqlBytes: 0,
								params: 0,
								variants: 0
							}
							const exhausted = new Set<BudgetKind>()
							const charged = (
								budget: BudgetKind,
								amount: number,
								at: number,
								result: ReturnType<BudgetMeter["charge"]>
							) => {
								const before = exhausted.has(budget)
								used[budget] += amount
								const limit: number = limits[budget]
								if (used[budget] <= limit) {
									succeeded(result)
									c.note("a charge within its limit")
									if (exhausted.size > 0) {
										c.note("a charge to another kind after one is exhausted")
									}
								} else {
									const error = refused(result, "ResourceBound")
									assert.equal(formatLoc(refusalLoc(error)), formatLoc(locOf(at)))
									assert.deepEqual(budgetBoundOf(error), {
										kind: "budget",
										budget,
										limit,
										needed: used[budget]
									})
									exhausted.add(budget)
									c.note(
										before ? "a charge after its kind is exhausted" : "a charge crossing its limit"
									)
								}
								assert.equal(meter.used(budget), used[budget])
								assert.equal(meter.remaining(budget), Math.max(0, limit - used[budget]))
							}
							for (const step of steps) {
								switch (step.kind) {
									case "charge":
										charged(
											step.budget,
											step.amount,
											step.at,
											meter.charge(step.budget, step.amount, locOf(step.at))
										)
										break
									case "sql": {
										const bytes = Buffer.byteLength(step.text, "utf8")
										if (bytes > step.text.length) {
											c.note("a SQL text of multi-byte characters")
										}
										charged("sqlBytes", bytes, step.at, meter.chargeSql(step.text, locOf(step.at)))
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
							const usage: Record<BudgetKind, { used: number; limit: number }> = {
								nodes: { used: used.nodes, limit: limits.nodes },
								fields: { used: used.fields, limit: limits.fields },
								sqlBytes: { used: used.sqlBytes, limit: limits.sqlBytes },
								params: { used: used.params, limit: limits.params },
								variants: { used: used.variants, limit: limits.variants }
							}
							assert.deepEqual(meter.usage(), usage)
						})
				)
			)
	)
})
