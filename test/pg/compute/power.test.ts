import { layer } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, type Gen, int, map, oneOf, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import type { PreconditionKind } from "#compiler/core/errors.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import {
	numericMaxFractionDigits,
	numericMaxPrecision,
	numericMaxScale
} from "#compiler/ir/scalar.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import {
	caseChunk,
	compareAnswers,
	type EvalCase,
	installEvaluator,
	parseAnswer,
	runCases
} from "#test/pg/compute/support.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { constantEnv, evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { digitString, edges, type PowerBatch, powerBatch } from "#test/support/power-pairs.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import {
	baseParams,
	lowerWith,
	testPg,
	plainRender,
	renderSql,
	spelledExpr,
	type TestField,
	v
} from "#test/unit/compute/support.ts"

import { regex } from "arkregex"
/**
 * The field a literal base is typed by, as Compute.literal types one: a literal never stands first, so the base is a
 * literal of a numeric field, whose typmod holds its value exactly, (its digits, its least scale), or NaN, which every
 * typmod admits, at numeric(1, 0). None for an infinity, which no typmod admits, or a value whose digits or scale pass
 * numeric's declarable ones: no declared field holds it, so no literal base is it. The exponent stays a bare literal,
 * typed by the base it meets.
 */
const baseField = (base: Decimal): TestField | undefined => {
	if (base.isNaN()) {
		return testPg.numericOf(1, 0)
	}
	if (!base.isFinite()) {
		return undefined
	}
	const scale = base.parts.minScale
	const digits = base.parts.coefficient === 0n ? 1 : String(base.parts.coefficient).length
	const precision = Math.max(digits, scale, 1)
	return precision > numericMaxPrecision.value || scale > numericMaxScale.value
		? undefined
		: testPg.numericOf(precision, scale)
}

/** Whether a refusal's precondition is power's: its base's sign (powerDomain) or its result's range (powerRange). */
const powerPrecondition = (kind: PreconditionKind): boolean =>
	kind === "powerDomain" || kind === "powerRange"

/**
 * What a case reached: a value both sides agree on; a power compilation refuses, its literal operands outside the
 * domain and range it proves (PartialOperation, precondition powerDomain: zero to a negative power, a negative base;
 * powerRange: a result past numeric's digits); a result that underflows to zero at its display scale, on both sides;
 * and a pair next to power_var's exp(6000) bound on each side of the proof's.
 */
type PowerFeature =
	| "value agreement"
	| "refused at compilation"
	| "underflow to zero"
	| "next to exp(6000), admitted"
	| "next to exp(6000), refused"

/**
 * Escaped: power_var raised 22003 on powers the proof admitted, its range then half numeric's 131072 digits for every
 * exponent, where PostgreSQL bounds a fractional one's result by exp(6000).
 */
const kept: ReadonlyArray<Kept<PowerBatch, PowerFeature>> = [
	{
		note: "a fractional exponent past power_var's exp(6000): power(9.5e400, 60.123456789) and power(5.5e10, 1000.123)",
		sketch: {
			ordinary: [
				["9.5e400", "60.123456789"],
				["5.5e10", "1000.123"]
			],
			near: []
		},
		draws: "",
		reaches: ["refused at compilation"]
	}
]

/** What a guarded power over a base column reached: refused at compilation, or proved and computed at its ends. */
type GuardedFeature = "guarded power refused" | "guarded power proved"

/**
 * A guard over a base column of a computed numeric at numeric's own limits (testPg.computedNumeric): above zero and
 * within [0, high], whose least value is numeric's least positive one, 10^-16383; or within [low, high] with low a power
 * of ten at most one. And the exponent a power raises the guarded base to: a negative integer or fraction, or a positive
 * one.
 */
interface GuardedPower {
	readonly guard:
		| Readonly<{ kind: "positive"; high: string }>
		| Readonly<{ kind: "within"; low: string; high: string }>
	readonly exponent: string
}

/** The least positive value of a numeric of no typmod: 10^-numericMaxFractionDigits, 10^-16383. */
const leastPositive = `1e-${numericMaxFractionDigits.value}`

const guardedPowerGen: Gen<GuardedPower> = (source) => ({
	guard: source.draw(
		weighted<GuardedPower["guard"]>([
			[1, (g) => ({ kind: "positive", high: `${g.draw(int(1, 9))}e${g.draw(int(0, 40))}` })],
			[
				3,
				(g) => ({
					kind: "within",
					low: `1e-${g.draw(int(0, 400))}`,
					high: `${g.draw(int(1, 9))}e${g.draw(int(0, 40))}`
				})
			]
		])
	),
	exponent: source.draw(
		oneOf([
			map(int(-40, -1), String),
			(g) => `-${g.draw(int(0, 60))}.${g.draw(digitString(1, 6))}`,
			map(int(1, 40), String),
			(g) => `${g.draw(int(0, 60))}.${g.draw(digitString(1, 6))}`
		])
	)
})

/**
 * Escaped: a base guarded above zero and within [0, 10] raised to a negative power was proved in range from its
 * interval's ends alone, though such a numeric reaches 10^-16383, so power(1e-16383, -10) raises 22003.
 */
const guardedKept: ReadonlyArray<Kept<ReadonlyArray<GuardedPower>, GuardedFeature>> = [
	{
		note: "a base above zero and within [0, 10] raised to -10: its least value 10^-16383 overflows",
		sketch: [{ guard: { kind: "positive", high: "10" }, exponent: "-10" }],
		draws: "",
		reaches: ["guarded power refused"]
	}
]

layer(Substrate.layer)("numeric power against PostgreSQL 19", (it) => {
	it.effect("agrees on the value, display scale and failure of every generated power", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { session, schema } = yield* Substrate
				const db = yield* session(ownerSession())
				const s = yield* schema(freshSchema)
				yield* installEvaluator(db, s)
				const expr: ExprDesc = spelledExpr(
					Compute.power(v("a", testPg.computedNumeric), v("b", testPg.computedNumeric)).expr
				)
				return yield* explore(
					{
						oracle: { kind: "unstated" },
						suite: "pg/compute/power",
						draw: drawn(powerBatch),
						literal: Formatter.format,
						coverage: required<PowerFeature>(
							[
								"value agreement",
								"refused at compilation",
								"underflow to zero",
								"next to exp(6000), admitted",
								"next to exp(6000), refused"
							],
							{ cases: 8, sense: notesOnly }
						),
						kept,
						runs: 4,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(batch, c) =>
						Effect.gen(function* () {
							let refused = 0
							const cases: Array<EvalCase> = []
							const pairs = [
								...Arr.map([...edges, ...batch.ordinary], (pair) => ({ pair, near: false })),
								...Arr.map(batch.near, (pair) => ({ pair, near: true }))
							]
							for (const [ord, { pair, near }] of pairs.entries()) {
								yield* Effect.yieldNow
								const [a, b] = pair
								const base = Decimal.of(a)
								const field = baseField(base)
								if (field === undefined) {
									continue
								}
								const lowered = lowerWith(
									"query",
									expr,
									{
										a: { kind: "literal", field, value: base },
										b: { kind: "bare", value: Decimal.of(b) }
									},
									false,
									baseParams
								)
								if (!lowered.ok) {
									const reason = lowered.error.reason
									if (
										reason._tag !== "PartialOperation" ||
										!powerPrecondition(reason.precondition)
									) {
										throw new Error(`power(${a}, ${b}): ${String(lowered.error)}`)
									}
									refused++
									if (near) {
										c.note("next to exp(6000), refused")
									}
									continue
								}
								if (near) {
									c.note("next to exp(6000), admitted")
								}
								const { root } = lowered.value
								const sql = renderSql(root.expr, plainRender)
								cases.push({
									ord,
									label: `power(${a}, ${b})`,
									sql,
									valueSql: sql,
									type: root.actual,
									host: evaluate(root.expr, constantEnv)
								})
							}
							const answers = yield* runCases(db, s, cases, caseChunk)
							const result = compareAnswers(cases, answers)
							assert.deepEqual(result.mismatches.slice(0, 10), [])
							assert.equal(result.typedOnly, 0)
							if (result.values > 0) {
								c.note("value agreement")
							}
							if (refused > 0) {
								c.note("refused at compilation")
							}
							if (
								Arr.some(answers, (a) => a.kind === "value" && regex("^-?0(\\.0+)?$").test(a.text))
							) {
								c.note("underflow to zero")
							}
						})
				)
			})
		)
	)

	it.effect(
		"never proves a power over a guarded base that PostgreSQL fails at its guard's ends",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { session, schema } = yield* Substrate
					const db = yield* session(ownerSession())
					const s = yield* schema(freshSchema)
					yield* installEvaluator(db, s)
					return yield* explore(
						{
							oracle: { kind: "unstated" },
							suite: "pg/compute/power/guarded",
							draw: drawn(array(guardedPowerGen, { min: 1, max: 200 })),
							literal: Formatter.format,
							coverage: required<GuardedFeature>(
								["guarded power refused", "guarded power proved"],
								{
									cases: 4,
									sense: notesOnly
								}
							),
							kept: guardedKept,
							runs: 4,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(batch, c) =>
							Effect.gen(function* () {
								const proved = Arr.flatMap(batch, (g) => {
									const x = v("x", testPg.computedNumeric)
									const power = (base: ScalarTerm) => Compute.power(base, Decimal.of(g.exponent))
									const zero = Decimal.of("0")
									const guard = g.guard
									const term =
										guard.kind === "positive"
											? Compute.when(
													Compute.positive(x),
													(y: ScalarTerm) =>
														Compute.when(
															Compute.within(y, zero, Decimal.of(guard.high)),
															power,
															zero
														),
													zero
												)
											: Compute.when(
													Compute.within(x, Decimal.of(guard.low), Decimal.of(guard.high)),
													power,
													zero
												)
									const lowered = lowerWith(
										"query",
										spelledExpr(term.expr),
										{ x: { kind: "column", type: testPg.computedNumeric.scalar } },
										false,
										baseParams
									)
									if (!lowered.ok) {
										const reason = lowered.error.reason
										assert.ok(
											reason._tag === "PartialOperation" && powerPrecondition(reason.precondition),
											`${Formatter.format(g)}: ${String(lowered.error)}`
										)
										c.note("guarded power refused")
										return []
									}
									c.note("guarded power proved")
									const ends = [guard.kind === "positive" ? leastPositive : guard.low, guard.high]
									return Arr.map(ends, (end) => ({
										label: `power(${end}, ${g.exponent}) under ${Formatter.format(g.guard)}`,
										q: `"pg_catalog"."power"(${end}::numeric, (${g.exponent})::numeric)`
									}))
								})
								const rows = yield* db.values(
									`SELECT "${s}".try_eval(c.q, c.q) FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, q text) ORDER BY c.ord`,
									[jsonText(Arr.map(proved, (k, ord) => ({ ord, q: k.q })))]
								)
								const failed = Arr.flatMap(proved, (k, i) => {
									const answer = parseAnswer(String(rows[i]?.[0]))
									return answer.kind === "error" ? [`${k.label}: ${answer.sqlstate}`] : []
								})
								assert.deepEqual(failed, [])
							})
					)
				})
			)
	)
})
