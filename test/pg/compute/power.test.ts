/**
 * computeCore.power on PostgreSQL 19.
 *
 * - Numeric: every generated power, its base and exponent drawn about the values power_var turns on (underflow to
 *   zero, a result next to exp(6000)), agrees with PostgreSQL on its value, its display scale and its failure: a power
 *   compilation proves is one PostgreSQL computes, and one it refuses is one whose operands' bounds admit a failure.
 * - Guarded: a power over a base a guard bounds is never proved where PostgreSQL fails at the guard's ends.
 * - Float: a double power over bases of every binary exponent is never proved where PostgreSQL's dpow fails.
 *
 * Oracle: PostgreSQL itself, power's value or failure, beside the reference evaluator's value.
 *
 * Features: value agreement, a refusal at compilation, an underflow to zero, each side of exp(6000), a guarded power
 * refused and proved, and each float refusal.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array, recorded } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { type ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import {
	baseField,
	expr,
	floatPowerExpr,
	floatBaseGen,
	floatExponentGen,
	type FloatFeature,
	type FloatPower,
	type GuardedFeature,
	guardedPowerGen,
	leastNormal,
	leastPositive,
	type PowerFeature,
	powerPrecondition,
	powerEvaluator,
	overflowingGuardedPowers,
	pastExpPowers,
	underflowingFloatPowers
} from "#test/pg/compute/power.fixtures.ts"
import { constantEnv, evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import {
	caseChunk,
	compareAnswers,
	type EvalCase,
	parseAnswer,
	runCases
} from "#test/support/pg/compute/support.ts"
import { edges, powerBatch } from "#test/support/power-pairs.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	baseParams,
	lowerWith,
	plainRender,
	renderSql,
	spelledExpr,
	testPg,
	v
} from "#test/support/unit/compute/support.ts"

/**
 * Numeric power against PostgreSQL 19 agrees on the value, display scale and failure of every generated power.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/compute/power.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/compute/power.test.ts` at its budget before,
 *   `{ runs: 4, steered: 8 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the red's
 *   headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path in
 *   run-budgets.log there
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
export const numericPowerAgainstPostgreSQL19AgreesOnTheValueDisplayScaleAndFailureOfEveryGeneratedPower =
	property.explore(recorded(powerBatch, pastExpPowers), {
		needs: { evaluator: Substrate.rolledBack(powerEvaluator) },
		situations: [
			"value agreement",
			"refused at compilation",
			"underflow to zero",
			"next to exp(6000), admitted",
			"next to exp(6000), refused"
		] satisfies ReadonlyArray<Reached<PowerFeature>>,
		check:
			({ evaluator }, c: Case<PowerFeature>) =>
			(batch) =>
				Effect.scoped(
					Effect.flatMap(evaluator, ({ session: db, value: s }) =>
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
				),
		oracle: {
			kind: "postgresql",
			name: "power's value or failure, beside the reference evaluator"
		},
		budget: { runs: 1, steered: 8 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/compute/power.test.ts#numericPowerAgainstPostgreSQL19AgreesOnTheValueDisplayScaleAndFailureOfEveryGeneratedPower:-:1"
				),
				reason:
					"a fractional exponent past power_var's exp(6000): power(9.5e400, 60.123456789) and power(5.5e10, 1000.123), recorded (pastExpPowers)",
				since: "2026-11-04"
			}
		],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/lower.ts",
				original:
					"return integral ? weight < numericMaxIntegerDigits : weight * Math.LN10 < powerExpLimit",
				replacement: "return weight < numericMaxIntegerDigits",
				why: "e7fd8b323's fix reverted: a power whose exponent is no integer is proved within numeric's integer digits alone, never held below power_var's exp(6000), so power(9.5e400, 60.123456789) is proved where PostgreSQL raises 22003."
			}
		]
	})

/**
 * Numeric power against PostgreSQL 19 never proves a power over a guarded base that PostgreSQL fails at its guard's ends.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/compute/power.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/compute/power.test.ts` at its budget before,
 *   `{ runs: 4, steered: 4 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the red's
 *   headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path in
 *   run-budgets.log there
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
export const numericPowerAgainstPostgreSQL19NeverProvesAPowerOverAGuardedBaseThatPostgreSQLFailsAtItsGuardsEnds =
	property.explore(
		recorded(array(guardedPowerGen, { min: 1, max: 200 }), overflowingGuardedPowers),
		{
			needs: { evaluator: Substrate.rolledBack(powerEvaluator) },
			situations: ["guarded power refused", "guarded power proved"] satisfies ReadonlyArray<
				Reached<GuardedFeature>
			>,
			check:
				({ evaluator }, c: Case<GuardedFeature>) =>
				(batch) =>
					Effect.scoped(
						Effect.flatMap(evaluator, ({ session: db, value: s }) =>
							Effect.gen(function* () {
								const proved = Arr.flatMap(batch, (g) => {
									const x = v("x", testPg.computedNumeric)
									const power = (base: ScalarTerm) =>
										computeCore.power(base, Decimal.of(g.exponent))
									const zero = Decimal.of("0")
									const guard = g.guard
									const term =
										guard.kind === "positive"
											? computeCore.when(
													computeCore.positive(x),
													(y: ScalarTerm) =>
														computeCore.when(
															computeCore.within(y, zero, Decimal.of(guard.high)),
															power,
															zero
														),
													zero
												)
											: computeCore.when(
													computeCore.within(x, Decimal.of(guard.low), Decimal.of(guard.high)),
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
					),
			oracle: { kind: "postgresql", name: "power's failure at the guard's ends" },
			budget: { runs: 1, steered: 4 },
			kept: [
				{
					token: ReplayToken(
						"test/pg/compute/power.test.ts#numericPowerAgainstPostgreSQL19NeverProvesAPowerOverAGuardedBaseThatPostgreSQLFailsAtItsGuardsEnds:-:1"
					),
					reason:
						"a base above zero and within [0, 10] raised to -10: its least value 10^-16383 overflows, recorded (overflowingGuardedPowers)",
					since: "2026-11-04"
				}
			],
			kills: [
				{
					file: "packages/engine/src/scalar/compute/typing.ts",
					original: "\treturn Math.max(rising, falling)\n",
					replacement: "\treturn rising\n",
					why: "e7fd8b323's fix reverted: a power's weight counts its largest base raised to its largest exponent alone, never its least base raised to its most negative one, so a base within (0, 10] raised to -10 is proved where its least value, 10^-16383, overflows."
				}
			]
		}
	)

/**
 * Numeric power against PostgreSQL 19 never proves a float power over bases of every binary exponent that PostgreSQL's dpow fails.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/compute/power.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/compute/power.test.ts` at its budget before,
 *   `{ runs: 4, steered: 4 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the red's
 *   headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path in
 *   run-budgets.log there
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
export const numericPowerAgainstPostgreSQL19NeverProvesAFloatPowerOverBasesOfEveryBinaryExponentThatPostgreSQLsDpowFails =
	property.explore(
		recorded(
			array(
				(source): FloatPower => ({
					base: source.draw(floatBaseGen),
					exponent: source.draw(floatExponentGen)
				}),
				{ min: 1, max: 200 }
			),
			underflowingFloatPowers
		),
		{
			needs: { evaluator: Substrate.rolledBack(powerEvaluator) },
			situations: [
				"admitted",
				"admitted over a subnormal base",
				"refused where dpow underflows",
				"refused where dpow overflows"
			] satisfies ReadonlyArray<Reached<FloatFeature>>,
			check:
				({ evaluator }, c: Case<FloatFeature>) =>
				(batch) =>
					Effect.scoped(
						Effect.flatMap(evaluator, ({ session: db, value: s }) =>
							Effect.gen(function* () {
								const expr = floatPowerExpr

								const runs: Array<{
									readonly pair: FloatPower
									readonly admitted: boolean
									readonly q: string
								}> = []
								for (const pair of batch) {
									yield* Effect.yieldNow
									const lowered = lowerWith(
										"query",
										expr,
										{
											a: { kind: "literal", field: testPg.double, value: pair.base },
											b: { kind: "literal", field: testPg.double, value: pair.exponent }
										},
										false,
										baseParams
									)
									if (lowered.ok) {
										runs.push({
											pair,
											admitted: true,
											q: renderSql(lowered.value.root.expr, plainRender)
										})
										continue
									}
									const reason = lowered.error.reason
									assert.ok(
										reason._tag === "PartialOperation" && powerPrecondition(reason.precondition),
										`${Formatter.format(pair)}: ${String(lowered.error)}`
									)
									runs.push({
										pair,
										admitted: false,
										q: `"pg_catalog"."power"('${pair.base}'::float8, '${pair.exponent}'::float8)`
									})
								}
								const rows = yield* db.values(
									`SELECT "${s}".try_eval(c.q, c.q) FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, q text) ORDER BY c.ord`,
									[jsonText(Arr.map(runs, (k, ord) => ({ ord, q: k.q })))]
								)
								const failed = Arr.flatMap(runs, (k, i) => {
									const answer = parseAnswer(String(rows[i]?.[0]))
									const { base, exponent } = k.pair
									if (k.admitted) {
										if (answer.kind === "error") {
											return [`power(${base}, ${exponent}): ${answer.sqlstate}`]
										}
										c.note("admitted")
										if (base > 0 && base < leastNormal) {
											c.note("admitted over a subnormal base")
										}
										return []
									}
									if (answer.kind === "error" && answer.sqlstate === "22003") {
										c.note(
											Math.log2(base) * exponent < 0
												? "refused where dpow underflows"
												: "refused where dpow overflows"
										)
									}
									return []
								})
								assert.deepEqual(failed, [])
							})
						)
					),
			oracle: {
				kind: "postgresql",
				name: "dpow's 22003 on a zero result of a nonzero base or an infinite one (float.c)"
			},
			budget: { runs: 1, steered: 4 },
			kept: [
				{
					token: ReplayToken(
						"test/pg/compute/power.test.ts#numericPowerAgainstPostgreSQL19NeverProvesAFloatPowerOverBasesOfEveryBinaryExponentThatPostgreSQLsDpowFails:-:1"
					),
					reason:
						"power(1.6466997816706438e-110, 9.5) and power(1.6466997816706438e-110, 527076835) underflow to zero, recorded (underflowingFloatPowers)",
					since: "2026-11-07"
				}
			],
			kills: [
				{
					file: "packages/engine/src/scalar/compute/lower.ts",
					original: "Math.max(Math.abs(log2Magnitude(bLow)), Math.abs(log2Magnitude(bHigh)))",
					replacement: "Math.max(log2Magnitude(bLow), log2Magnitude(bHigh))",
					why: "73360caa6's catch again: a float power's reach reads each base's binary exponent with its sign, so a base below 1 never counts toward the underflow, and power(1.6466997816706438e-110, 9.5) is proved where dpow raises 22003 on its zero result."
				}
			]
		}
	)
