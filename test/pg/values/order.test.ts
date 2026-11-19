import { assert } from "@bjornpagen/testing/assert"
/**
 * The host's one comparison of values (scalar/values/identity.ts compareValues) against PostgreSQL 19 and the pinned
 * pgvector: a batch of values of every carrier, ordered by ORDER BY at the carrier's type, is in the order the host's
 * comparison puts it in, under both of the orders its closed ids rank by (ir/codes.ts HandleOrder): a codec's spec,
 * whose closed ids rank by the installation's codes, as a reader's merge and a page's fetch order read it, and the
 * evaluator's (scalar/compute/evaluate.ts evaluatorOrder), whose rank by their roster's declaration, as a contract literal's
 * check, constant folding, a fill's selection and the witness read it.
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
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { evaluatorOrder } from "#compiler/scalar/compute/evaluate.ts"
import { compareValues } from "#compiler/scalar/values/identity.ts"
import { roundTripRuns } from "#test/pg/codec/scalar.fixtures.ts"
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
import { Substrate } from "#test/support/substrate/substrate.ts"
import { orderOf } from "#test/unit/values/support.ts"

/**
 * The host's comparison of values orders every carrier's values as PostgreSQL's ORDER BY does, by a codec's codes and
 * by the evaluator's declared order alike. Its budget is the codec round trip's per carrier (scalar.test.ts
 * roundTripRuns), its runs and steered cases that many times its cases, each case a carrier the steered phase reaches.
 */
export const theHostsComparisonOfValuesOrdersEveryCarriersValuesAsPostgreSQLsOrderByDoesByACodecsCodesAndByTheEvaluatorsDeclaredOrderAlike =
	property.explore(batchGen, {
		needs: { tx: Substrate.transaction },
		situations: Arr.map(
			orderCases,
			(c): OrderFeature => `orders ${c.label}`
		) satisfies ReadonlyArray<Reached<OrderFeature>>,
		budget: { runs: roundTripRuns * orderCases.length, steered: roundTripRuns * orderCases.length },
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
					switch (carrier.ordered) {
						case "ordered":
							assert.deepEqual(
								orderOf(values, (a, b) => compareValues(evaluator, a, b)),
								postgres,
								`${batch.label}: the evaluator's order is PostgreSQL's`
							)
							break
						case "equality":
							for (const [i, a] of values.entries()) {
								for (const b of values.slice(i + 1)) {
									assert.equal(
										compareValues(evaluator, a, b) === 0,
										compareValues(codec, a, b) === 0,
										`${batch.label}: the evaluator's equality is PostgreSQL's`
									)
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
