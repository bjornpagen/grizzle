import { layer } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	codePoint,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, String as Str } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
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
import { constantEnv, evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import {
	baseParams,
	lowerWith,
	testPg,
	plainRender,
	renderSql,
	spelled,
	v
} from "#test/unit/compute/support.ts"

import { regex } from "arkregex"
/**
 * What a case reached: a value both sides agree on; a power compilation refuses, its literal operands outside the
 * domain and range it proves (PartialOperation, precondition powerDomain: zero to a negative power, a negative base, a
 * result past numeric's digits); and a result that underflows to zero at its display scale, on both sides.
 */
type PowerFeature = "value agreement" | "refused at compilation" | "underflow to zero"

const digitString = (min: number, max: number): Gen<string> =>
	string(codePoint(0x30, 0x39), { min, max })

const signed =
	(body: Gen<string>): Gen<string> =>
	(source) =>
		`${source.draw(element(["", "", "-"] as const))}${source.draw(body)}`

const fraction =
	(max: number): Gen<string> =>
	(source) => {
		const i = source.draw(int(0, 999))
		const f = source.draw(digitString(0, max))
		return f === "" ? `${i}` : `${i}.${f}`
	}

/** Bases: small decimals, values near one, wide magnitudes, small integers, and long significands. */
const bases: Gen<string> = oneOf([
	signed(fraction(24)),
	(source) => {
		const zeros = source.draw(int(1, 30))
		const tail = source.draw(digitString(1, 20))
		const above = source.draw(boolean)
		return above ? `1.${Str.repeat(zeros)("0")}${tail}` : `0.${Str.repeat(zeros)("9")}${tail}`
	},
	signed(
		(source) =>
			`${source.draw(int(1, 9))}.${source.draw(digitString(0, 12))}e${source.draw(int(-400, 400))}`
	),
	signed(map(int(2, 20), String)),
	signed((source) => `${source.draw(int(1, 99))}.${source.draw(digitString(30, 70))}`)
])

/**
 * Exponents: small integers (some with a display scale), int32 extremes, integers beyond int32, fractions with short
 * and long display scales, and tiny magnitudes.
 */
const exponents: Gen<string> = oneOf([
	map(int(-40, 40), String),
	(source) => `${source.draw(int(-12, 12))}.${Str.repeat(source.draw(int(1, 40)))("0")}`,
	map(int(-2147483648, 2147483647), String),
	map(bigint(2147483648n, 10n ** 15n), (n) => (n % 2n === 0n ? `${n}` : `-${n}`)),
	signed((source) => `${source.draw(int(0, 60))}.${source.draw(digitString(1, 30))}`),
	signed((source) => `${source.draw(int(0, 3))}.${source.draw(digitString(40, 60))}`),
	signed((source) => `${source.draw(int(1, 9))}e${source.draw(int(-40, -1))}`)
])

/**
 * PostgreSQL's bound on power_var for an exponent that is no integer (numeric.c): y · ln x below
 * NUMERIC_MAX_RESULT_SCALE · 3 = 6000, at which it raises 22003; in decimal weight, log10 x^y below 6000 / ln 10.
 */
const expLimitWeight = 6000 / Math.LN10

/**
 * A pair near that bound, where a proof that over-counts nothing meets PostgreSQL's own limit: a base of nine and a
 * long significand at a drawn power of ten, so its decimal weight is within a digit of its integer digits, and a
 * fractional exponent putting log10 x^y within one percent of the bound on either side; or the same weight reached by a
 * base below one and a negative exponent.
 */
const nearLimit: Gen<readonly [string, string]> = (source) => {
	const k = source.draw(int(0, 400))
	const significand = `9.${source.draw(digitString(1, 12))}`
	const below = source.draw(boolean)
	const exponent = below ? -k - 1 : k
	const weight = Math.abs(Math.log10(Number(significand)) + exponent)
	const y = (expLimitWeight / weight) * (1 + source.draw(int(-100, 100)) / 10000)
	return [`${significand}e${exponent}`, (below ? -y : y).toFixed(9)]
}

/**
 * Escaped: power_var raised 22003 on powers the proof admitted, its range then half numeric's 131072 digits for every
 * exponent, where PostgreSQL bounds a fractional one's result by exp(6000).
 */
const kept: ReadonlyArray<Kept<ReadonlyArray<readonly [string, string]>, PowerFeature>> = [
	{
		note: "a fractional exponent past power_var's exp(6000): power(9.5e400, 60.123456789) and power(5.5e10, 1000.123)",
		sketch: [
			["9.5e400", "60.123456789"],
			["5.5e10", "1000.123"]
		],
		draws: "",
		reaches: ["refused at compilation"]
	}
]

/** What a guarded power over a base column reached: refused at compilation, or proved and computed at its ends. */
type GuardedFeature = "guarded power refused" | "guarded power proved"

/**
 * A guard over a base column of bare numeric: above zero and within [0, high], whose least value is bare numeric's
 * least positive one, 10^-16383; or within [low, high] with low a power of ten at most one. And the exponent a power
 * raises the guarded base to: a negative integer or fraction, or a positive one.
 */
interface GuardedPower {
	readonly guard:
		| Readonly<{ kind: "positive"; high: string }>
		| Readonly<{ kind: "within"; low: string; high: string }>
	readonly exponent: string
}

/** The least positive value of a bare numeric: 10^-16383, numeric's largest display scale. */
const leastPositive = "1e-16383"

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
 * interval's ends alone, though such a bare numeric reaches 10^-16383, so power(1e-16383, -10) raises 22003.
 */
const guardedKept: ReadonlyArray<Kept<ReadonlyArray<GuardedPower>, GuardedFeature>> = [
	{
		note: "a base above zero and within [0, 10] raised to -10: its least value 10^-16383 overflows",
		sketch: [{ guard: { kind: "positive", high: "10" }, exponent: "-10" }],
		draws: "",
		reaches: ["guarded power refused"]
	}
]

const edges: ReadonlyArray<readonly [string, string]> = [
	["0", "0"],
	["0", "1"],
	["0", "-1"],
	["0", "0.5"],
	["0", "-0.5"],
	["0.000", "3"],
	["2", "0"],
	["2.50", "0.000"],
	["2", "1"],
	["2.123456", "1"],
	["2", "-1"],
	["3", "-1"],
	["7", "-1.0"],
	["2", "2"],
	["1.5", "2"],
	["2", "10"],
	["2", "-10"],
	["10", "131071"],
	["10", "131072"],
	["10", "-1000"],
	["10", "-1001"],
	["10", "-1017"],
	["0.1", "2000"],
	["9999", "32768"],
	["-2", "3"],
	["-2", "4"],
	["-2", "-3"],
	["-2", "2147483647"],
	["-2", "2147483648"],
	["-1", "2147483649"],
	["-1", "9223372036854775808"],
	["-1.0000001", "4294967296"],
	["-8", "0.333333333333"],
	["-8", "1.5"],
	["1", "123456.789"],
	["1.000", "-0.5"],
	["4", "0.5"],
	["2", "0.5"],
	["2", "1e-30"],
	["1e-300", "0.5"],
	["1e300", "-0.5"],
	["1.00000000000000000001", "1e15"],
	["0.99999999999999999999", "1e18"],
	["123.456", "7.89"],
	["123.456", "-7.89"],
	["1.234567890123456789012345678901234567890123456789", "-7"],
	["1.234567890123456789012345678901234567890123456789", "-13"],
	[
		"3.14159265358979323846264338327950288419716939937510",
		"2.71828182845904523536028747135266249775724709369995"
	],
	["9999999999999999.99999999", "3"],
	["9999999999999999.99999999", "-3"],
	["0.00000000000000000000000000000001234567", "-5"],
	["1e-16383", "1"],
	["1e-16383", "0.5"],
	["NaN", "0"],
	["NaN", "1"],
	["1", "NaN"],
	["2", "NaN"],
	["NaN", "NaN"],
	["Infinity", "2"],
	["Infinity", "-2"],
	["Infinity", "0"],
	["-Infinity", "3"],
	["-Infinity", "4"],
	["-Infinity", "-3"],
	["-Infinity", "2.5"],
	["2", "Infinity"],
	["0.5", "Infinity"],
	["2", "-Infinity"],
	["0.5", "-Infinity"],
	["-1", "Infinity"],
	["-1", "-Infinity"],
	["1", "Infinity"],
	["0", "Infinity"],
	["0", "-Infinity"],
	["-2", "Infinity"],
	["-0.5", "-Infinity"],
	["Infinity", "Infinity"],
	["-Infinity", "-Infinity"],
	["-2", "0.5"],
	["-Infinity", "0.5"]
]

layer(Substrate.layer)("numeric power against PostgreSQL 19", (it) => {
	it.effect(
		"agrees on the value, display scale and failure of every generated power",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { session, schema } = yield* Substrate
					const db = yield* session(ownerSession())
					const s = yield* schema(freshSchema)
					yield* installEvaluator(db, s)
					const expr: ExprDesc = spelled(
						Compute.power(v("a", testPg.numeric), v("b", testPg.numeric)).expr
					)
					return yield* explore(
						{
							suite: "pg/compute/power",
							draw: drawn(
								array(
									oneOf<readonly [string, string]>([
										(source) => [source.draw(bases), source.draw(exponents)] as const,
										nearLimit
									]),
									{ min: 1, max: 1000 }
								)
							),
							literal: Formatter.format,
							coverage: required<PowerFeature>(
								["value agreement", "refused at compilation", "underflow to zero"],
								{ cases: 4, sense: notesOnly }
							),
							kept,
							runs: 4,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang: Duration.minutes(2)
						},
						(batch, c) =>
							Effect.gen(function* () {
								let refused = 0
								const cases: Array<EvalCase> = Arr.flatMap([...edges, ...batch], ([a, b], ord) => {
									const lowered = lowerWith(
										"query",
										expr,
										{
											a: { kind: "literal", field: testPg.numeric, value: Decimal.of(a) },
											b: { kind: "literal", field: testPg.numeric, value: Decimal.of(b) }
										},
										false,
										baseParams
									)
									if (!lowered.ok) {
										const reason = lowered.error.reason
										if (
											reason._tag !== "PartialOperation" ||
											reason.precondition !== "powerDomain"
										) {
											throw new Error(`power(${a}, ${b}): ${String(lowered.error)}`)
										}
										refused++
										return []
									}
									const { root } = lowered.value
									const sql = renderSql(root.expr, plainRender)
									return [
										{
											ord,
											label: `power(${a}, ${b})`,
											sql,
											valueSql: sql,
											type: root.actual,
											host: evaluate(root.expr, constantEnv)
										}
									]
								})
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
									Arr.some(
										answers,
										(a) => a.kind === "value" && regex("^-?0(\\.0+)?$").test(a.text)
									)
								) {
									c.note("underflow to zero")
								}
							})
					)
				})
			),
		300_000
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
							caseHang: Duration.minutes(2)
						},
						(batch, c) =>
							Effect.gen(function* () {
								const proved = Arr.flatMap(batch, (g) => {
									const x = v("x", testPg.numeric)
									const power = (base: ScalarTerm) =>
										Compute.power(base, Compute.literal(testPg.numeric, Decimal.of(g.exponent)))
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
										spelled(term.expr),
										{ x: { kind: "column", type: testPg.numeric.scalar } },
										false,
										baseParams
									)
									if (!lowered.ok) {
										const reason = lowered.error.reason
										assert.ok(
											reason._tag === "PartialOperation" && reason.precondition === "powerDomain",
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
			),
		300_000
	)
})
