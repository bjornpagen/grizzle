/**
 * Forged carrier inputs against PostgreSQL's own equality: every batch of forged and honest Numeric and Money inputs
 * grizzle admits is sent as a relation input's arrays, and PostgreSQL finds in those arrays exactly as many distinct
 * values as grizzle counted facts, and exactly as many as it finds among the PostgreSQL texts the inputs stand for
 * (test/support/forged.ts). So the arrays of a forged input are a set under PostgreSQL's equality, the premise a
 * relation input's lowering reads them without a DISTINCT on, and two forged values PostgreSQL calls equal are one fact.
 *
 * Oracle: PostgreSQL itself, its DISTINCT under the column's type, over both the arrays grizzle sends and the
 * independent texts of the values the inputs stand for.
 *
 * Features: "a batch holding one value twice", "two values" and "every input refused".
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Result } from "effect"
import { positionalColumns } from "#compiler/codec/recordset.ts"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { parseValue } from "#compiler/scalar/values/identity.ts"
import { type BatchFeature, judged, sqlOf } from "#test/pg/codec/forged.fixtures.ts"
import { arraysEncoder } from "#test/support/arrays.ts"
import { succeeded } from "#test/support/assert.ts"
import { forgedCases } from "#test/support/forged.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * Forged carrier inputs against PostgreSQL send PostgreSQL a set: the arrays hold as many distinct values as facts, and as the inputs stand for.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/codec/forged.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/codec/forged.test.ts` at its budget before, `{
 *   runs: 150, steered: 200 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the
 *   red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path
 *   in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on case 12 of its floor stream
 * @decision the least runs whose floor stream, a quarter of them rounded up, holds its first 13 cases: 49; no headroom:
 *   a kill its witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const forgedCarrierInputsAgainstPostgreSQLSendPostgreSQLASetTheArraysHoldAsManyDistinctValuesAsFactsAndAsTheInputsStandFor =
	property.explore(forgedCases(judged), {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [
			"a batch holding one value twice",
			"two values",
			"every input refused"
		] satisfies ReadonlyArray<Reached<BatchFeature>>,
		budget: { runs: 49, steered: 200 },
		check:
			({ tx }, c: Case<BatchFeature>) =>
			({ carrier, type, inputs }) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx

					if (carrier === "vector(3)") {
						return
					}
					const spec = carrierSpecOf(type, emptyCodebook)
					const admitted = Arr.flatMap(inputs, (one) =>
						Result.isSuccess(one.input) && parseValue(spec, one.input.success).ok
							? [{ input: one.input.success, pg: one.pg }]
							: []
					)
					if (admitted.length === 0) {
						c.note("every input refused")
						return
					}
					const distinct = new Set(Arr.map(admitted, (a) => a.pg))
					c.note(distinct.size < admitted.length ? "a batch holding one value twice" : "two values")
					const { arrays, count } = succeeded(
						arraysEncoder({
							relation: "Forged",
							columns: positionalColumns([{ name: "v", type }]),
							slot: { kind: "none" },
							codes: emptyCodebook
						})(Arr.map(admitted, (a) => ({ v: a.input })))
					)
					const column = sqlOf[carrier].type
					/** The arrays as a relation input's lowering reads them: numeric text elements cast to the column. */
					const input = `(SELECT pg_catalog.unnest($1::numeric[])::${column} AS v) AS r`
					const [row] = yield* db.values(
						`SELECT count(*)::text, (SELECT count(*) FROM (SELECT DISTINCT r.v FROM ${input}) AS q)::text, (SELECT count(DISTINCT t::${column}) FROM pg_catalog.unnest($2::text[]) AS t)::text FROM ${input}`,
						[
							defined(arrays[0], "the one column's array"),
							`{${Arr.join(
								Arr.map([...distinct], (pg) => `"${pg}"`),
								","
							)}}`
						]
					)
					assert.deepEqual(
						row,
						[String(count), String(count), String(distinct.size)],
						`${carrier}: the arrays' rows, their distinct values, and the distinct values the inputs stand for`
					)
					assert.equal(count, distinct.size, "one fact per value PostgreSQL calls distinct")
				}),
		oracle: {
			kind: "postgresql",
			name: "DISTINCT over the arrays sent and over the texts the inputs stand for"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original: '\t\treturn typeof value === "object" && value !== null && #minted in value',
				replacement: '\t\treturn typeof value === "object" && value !== null && "text" in value',
				why: "Numeric's instanceof admits any object with a text, so a prototype object's forged text reaches the arrays and PostgreSQL counts values grizzle never counted as facts."
			}
		]
	})
