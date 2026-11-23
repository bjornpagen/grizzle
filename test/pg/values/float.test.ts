/**
 * Real and double precision against PostgreSQL 19: the host's floats (scalar/values/float.ts) are PostgreSQL's.
 *
 * - Rounding: every binary64 value the host admits as a real (toReal), binary32 midpoints, the edges of binary32's
 *   range, NaN and the infinities among them, cast float8 to real in one recordset, is the host's real, which is
 *   Math.fround's: the cast rounds once, to nearest even.
 * - Refusal: every binary64 value, near binary32's overflow and underflow edges or anywhere, cast float8 to real alone,
 *   is refused by PostgreSQL with 22003 exactly when the host refuses it, and is the host's real otherwise; a value the
 *   host refuses rounds to an infinity from a finite value (an overflow) or to zero from a nonzero one (an underflow).
 * - Order, for each of float8 and real: PostgreSQL's positions of a batch under ORDER BY ascending and descending (ties
 *   by position) are the host's under compareFloat, NaN last and NaN = NaN, -0 = +0; count(DISTINCT) and SELECT
 *   DISTINCT keep one value per host float text (floatText).
 *
 * Oracle: PostgreSQL itself: float8_to_float4, its refusals, and float8's and float4's comparison.
 *
 * Features: "admitted"; "overflow" and "underflow", an edge value on each side PostgreSQL refuses; "NaN" and "signed
 * zero" in an order batch.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { weighted } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { toReal } from "#compiler/scalar/values/float.ts"
import {
	batchOf,
	castAlone,
	doubles,
	edge,
	type FloatFeature,
	float8Text,
	fromPg,
	ordersAs
} from "#test/pg/values/float.fixtures.ts"
import { succeeded } from "#test/support/assert.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Float agreement with PostgreSQL rounds every binary64 value to the real PostgreSQL's float8-to-float4 cast stores.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/values/float.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/values/float.test.ts` at its budget before, `{
 *   runs: 2, steered: 2 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the red's
 *   headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path in
 *   run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const floatAgreementWithPostgreSQLRoundsEveryBinary64ValueToTheRealPostgreSQLsFloat8ToFloat4CastStores =
	property.explore(batchOf(doubles, 10_000), {
		needs: { tx: Substrate.transaction },
		situations: ["admitted"] satisfies ReadonlyArray<Reached<FloatFeature>>,
		budget: { runs: 1, steered: 2 },
		check:
			({ tx }, c: Case<FloatFeature>) =>
			(doubles) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx
					const admitted = Arr.filter(doubles, (x) => toReal(x).ok)
					if (admitted.length > 0) {
						c.note("admitted")
					}
					const rows = yield* db.values(
						"SELECT c.ord::text, (c.v::float8::real)::float8::text FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text) ORDER BY c.ord",
						[jsonText(Arr.map(admitted, (x, ord) => ({ ord, v: float8Text(x) })))]
					)
					assert.equal(rows.length, admitted.length)
					const mismatches = Arr.flatMap(admitted, (x, i) => {
						const pg = fromPg(rows[i]?.[1])
						const host = succeeded(toReal(x))
						const rounded = Math.fround(x)
						return Object.is(pg, host) && Object.is(pg, rounded) ? [] : [{ x, pg, host, rounded }]
					})
					assert.deepEqual(mismatches.slice(0, 5), [])
				}),
		oracle: { kind: "postgresql", name: "float8_to_float4, the float8-to-real cast" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/float.ts",
				original: "export const fround = (x: number): number => Math.fround(x)",
				replacement:
					"export const fround = (x: number): number => Math.fround(Number(x.toPrecision(7)))",
				why: "fround rounds through seven significant digits first."
			}
		]
	})

/**
 * Float agreement with PostgreSQL refuses exactly the overflows and underflows PostgreSQL refuses.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/values/float.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/values/float.test.ts` at its budget before, `{
 *   runs: 60, steered: 60 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the red's
 *   headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path in
 *   run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const floatAgreementWithPostgreSQLRefusesExactlyTheOverflowsAndUnderflowsPostgreSQLRefuses =
	property.explore(
		batchOf(
			weighted([
				[3, edge],
				[1, doubles]
			]),
			8
		),
		{
			needs: { tx: Substrate.transaction },
			situations: ["admitted", "overflow", "underflow"] satisfies ReadonlyArray<
				Reached<FloatFeature>
			>,
			budget: { runs: 1, steered: 60 },
			check:
				({ tx }, c: Case<FloatFeature>) =>
				(sample) =>
					Effect.gen(function* () {
						const { session: db } = yield* tx
						for (const x of sample) {
							const host = toReal(x)
							const pg = yield* castAlone(db, x)
							if (host.ok) {
								c.note("admitted")
								assert.ok(
									typeof pg === "number" && Object.is(pg, host.value),
									`${float8Text(x)}: PostgreSQL ${pg}, the host ${host.value}`
								)
							} else {
								const overflow = Number.isFinite(x) && !Number.isFinite(Math.fround(x))
								const underflow = x !== 0 && Math.fround(x) === 0
								assert.ok(overflow !== underflow, `${float8Text(x)} is one refusal`)
								c.note(overflow ? "overflow" : "underflow")
								assert.equal(pg, "22003", float8Text(x))
							}
						}
					}),
			oracle: {
				kind: "postgresql",
				name: "float8_to_float4's refusal, 22003, of each value cast alone"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/values/float.ts",
					original:
						'\tif (rounded === 0 && x !== 0) {\n\t\treturn Result.err("realUnderflow")\n\t}\n',
					replacement: "",
					why: "toReal admits a nonzero value that rounds to zero."
				}
			]
		}
	)

/** Float agreement with PostgreSQL orders and deduplicates float8 as PostgreSQL does: NaN last, NaN = NaN, -0 = +0. */
export const floatAgreementWithPostgreSQLOrdersAndDeduplicatesFloat8 = ordersAs("float8")

/** Float agreement with PostgreSQL orders and deduplicates real as PostgreSQL does: NaN last, NaN = NaN, -0 = +0. */
export const floatAgreementWithPostgreSQLOrdersAndDeduplicatesReal = ordersAs("real")
