/**
 * The host's one comparison of values (scalar/values/identity.ts compareValues) against PostgreSQL 19 and the pinned
 * pgvector: a batch of values of every carrier, ordered by ORDER BY at the carrier's type, is in the order the host's
 * comparison puts it in, under both of the orders its closed ids rank by (ir/codes.ts HandleOrder): a codec's spec,
 * whose closed ids rank by the installation's codes, as a reader's merge and a page's fetch order read it, and the
 * evaluator's (scalar/compute/evaluate.ts evaluatorOrder), whose rank by their roster's declaration, as a contract literal's
 * check, constant folding, a fill's selection and the witness read it, over each value as the evaluator computes with it
 * (scalar/values/identity.ts evaluatedValue): numeric(p, 0)'s bigint as its Decimal.
 *
 * Each case is a carrier and a batch of up to 100 of its values: every carrier the codec round trip sends (numeric
 * with NaN and the infinities, real and double precision with NaN, the infinities and -0, money, text of every plane,
 * uuids in either case, a closed id of an ordered roster with holes, sets of every width, int4 and int8 spans, vectors
 * of 3 and 16 components, a contract), a date, a date span, a bytes value and a closed id of an unordered roster whose
 * codes follow neither its declaration nor its canonical order. An unordered roster's closed ids have no order of the
 * language, so the evaluator's comparison is held to their equality alone, and the codec's to PostgreSQL's order of
 * their codes, which a take's and a page's ties are broken by.
 *
 * Oracle: PostgreSQL itself, each type's B-tree order: the integers', numeric_cmp, float4 and float8's btfloat cmp,
 * cash_cmp through numeric, boolcmp, uuid_cmp, date_cmp, text under pg_c_utf8, byteacmp, int2's over a closed id's
 * code, bitcmp, range_cmp and pgvector's vector_cmp.
 *
 * Features: "orders <carrier>", every case's.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { evaluatorOrder } from "#compiler/scalar/compute/evaluate.ts"
import { compareValues, evaluatedValue } from "#compiler/scalar/values/identity.ts"
import {
	batchGen,
	codecSpecOf,
	hostValueOf,
	orderCaseOf,
	orderCases,
	type OrderFeature,
	orderSetup,
	postgresOrder
} from "#test/pg/values/order.fixtures.ts"
import { at } from "#test/support/oracle/pick.ts"
import { roundTripRuns } from "#test/support/pg/codec/scalar.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { orderOf } from "#test/support/unit/values/support.ts"

/**
 * The host's comparison of values orders every carrier's values as PostgreSQL's ORDER BY does, by a codec's codes and
 * by the evaluator's declared order alike. Its budget is the codec round trip's per carrier (scalar.test.ts
 * roundTripRuns), its runs and steered cases that many times its cases, each case a carrier the steered phase reaches.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/values/order.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/values/order.test.ts` at its budget before, `{
 *   runs: roundTripRuns * orderCases.length, steered: roundTripRuns * orderCases.length }`, each kill's verdict printed
 *   with where its witnesses went red (judgedLine with the red's headline, a local print), in
 *   ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its 4 kills went red on case 16 of its floor stream, case 107 of its floor stream, case 24 of its floor
 *   stream and case 0 of its floor stream, in the order it declares them
 * @decision the least runs whose floor stream, a quarter of them rounded up, holds its first 108 cases: 429; no
 *   headroom: a kill its witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const theHostsComparisonOfValuesOrdersEveryCarriersValuesAsPostgreSQLsOrderByDoesByACodecsCodesAndByTheEvaluatorsDeclaredOrderAlike =
	property.explore(batchGen, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: Arr.map(
			orderCases,
			(c): OrderFeature => `orders ${c.label}`
		) satisfies ReadonlyArray<Reached<OrderFeature>>,
		budget: { runs: 429, steered: roundTripRuns * orderCases.length },
		check:
			({ tx }, c: Case<OrderFeature>) =>
			(batch) =>
				Effect.gen(function* () {
					const { session, schema } = yield* tx
					const { db, names } = yield* orderSetup(session, schema)
					const carrier = orderCaseOf(batch.label)
					const values = Arr.map(batch.values, (v) => hostValueOf(carrier.type, v))
					const postgres = yield* postgresOrder(db, names, carrier.type, batch.values)
					const codec = codecSpecOf(carrier.type)
					assert.deepEqual(
						orderOf(values, (a, b) => compareValues(codec, a, b)),
						postgres,
						`${batch.label}: the codec's order is PostgreSQL's`
					)
					const evaluator = evaluatorOrder(carrier.type)
					const evaluated = Arr.map(values, (v) => evaluatedValue(carrier.type, v))
					switch (carrier.ordered) {
						case "ordered":
							assert.deepEqual(
								orderOf(evaluated, (a, b) => compareValues(evaluator, a, b)),
								postgres,
								`${batch.label}: the evaluator's order is PostgreSQL's`
							)
							break
						case "equality":
							for (const [i, a] of values.entries()) {
								for (const [j, b] of values.entries()) {
									if (j > i) {
										assert.equal(
											compareValues(evaluator, at(evaluated, i), at(evaluated, j)) === 0,
											compareValues(codec, a, b) === 0,
											`${batch.label}: the evaluator's equality is PostgreSQL's`
										)
									}
								}
							}
							break
					}
					c.note(`orders ${batch.label}`)
				}),
		oracle: {
			kind: "postgresql",
			name: "each type's B-tree order, ORDER BY at its wire type, pgvector's vector_cmp among them"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original: "\tvector: (x, y) => Vector.compare(x, y),",
				replacement:
					"\tvector: (x, y) => compareCodePoints(Vector.componentText(x), Vector.componentText(y)),",
				why: "The host orders vectors by their text, not as vector_cmp does; the order property fails over a vector."
			},
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original: "\tbytes: (x, y) => compareBytes(x.bytes, y.bytes),",
				replacement: "\tbytes: (x, y) => compareCodePoints(x.digest, y.digest),",
				why: "The host orders bytes values by their digests, not byte by byte; the order property fails over bytea."
			},
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original:
					"\tcode: (x, y, order) => sign(rankOf(order.roster, x) - rankOf(order.roster, y)),",
				replacement: "\tcode: (x, y) => compareCodePoints(x, y),",
				why: "The host orders closed ids by their handles' text, not their codes; the order property fails over a closed id."
			},
			{
				file: "packages/engine/src/ir/codes.ts",
				original:
					"\t\trank: new Map(roster.handles.map((handle, position) => [handle, position] as const))",
				replacement:
					"\t\trank: new Map(roster.handles.map((handle, position) => [handle, -position] as const))",
				why: "The evaluator ranks an ordered roster's closed ids against their declaration, so not by their codes; the order property fails over a closed id at the evaluator's order."
			}
		]
	})
