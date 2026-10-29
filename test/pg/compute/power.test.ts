import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import {
	array,
	boolean,
	codePoint,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string
} from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, String as Str } from "effect"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import {
	allowedFailures,
	caseChunk,
	compareAnswers,
	type EvalCase,
	installEvaluator,
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
 * What a case reached: a value both sides agree on, overflow (22003), zero to a negative power or a negative base to a
 * non-integer power (2201F), and a result that underflows to zero at its display scale, on both sides.
 */
type PowerFeature = "value agreement" | "failure 22003" | "failure 2201F" | "underflow to zero"

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
								array((source) => [source.draw(bases), source.draw(exponents)] as const, {
									min: 1,
									max: 1000
								})
							),
							literal: Formatter.format,
							features: features<PowerFeature>([
								"value agreement",
								"failure 22003",
								"failure 2201F",
								"underflow to zero"
							]),
							kept: [],
							runs: 4,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							steering: { kind: "none" },
							caseHang: Duration.minutes(2)
						},
						(batch, c) =>
							Effect.gen(function* () {
								const cases: Array<EvalCase> = Arr.map([...edges, ...batch], ([a, b], ord) => {
									const lowered = lowerWith(
										"query",
										expr,
										{
											a: { kind: "literal", type: testPg.numeric.scalar, value: Decimal.of(a) },
											b: { kind: "literal", type: testPg.numeric.scalar, value: Decimal.of(b) }
										},
										false,
										baseParams
									)
									if (!lowered.ok) {
										throw new Error(`power(${a}, ${b}): ${String(lowered.error)}`)
									}
									const { root } = lowered.value
									const sql = renderSql(root.expr, plainRender)
									return {
										ord,
										label: `power(${a}, ${b})`,
										sql,
										valueSql: sql,
										type: root.actual,
										host: evaluate(root.expr, constantEnv),
										allowed: allowedFailures(root.expr)
									}
								})
								const answers = yield* runCases(db, s, cases, caseChunk)
								const result = compareAnswers(cases, answers)
								assert.deepEqual(result.mismatches.slice(0, 10), [])
								assert.equal(result.typedOnly, 0)
								if (result.values > 0) {
									c.note("value agreement")
								}
								/** The only failures are overflow and the two 2201F refusals. */
								const failures = new Set(
									Arr.map([...result.failures.keys()], (k) =>
										Option.match(Str.lastIndexOf(":")(k), {
											onNone: () => k,
											onSome: (at) => Str.slice(at + 1)(k)
										})
									)
								)
								assert.deepEqual(
									Arr.filter([...failures], (code) => code !== "22003" && code !== "2201F"),
									[]
								)
								if (failures.has("22003")) {
									c.note("failure 22003")
								}
								if (failures.has("2201F")) {
									c.note("failure 2201F")
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
})
