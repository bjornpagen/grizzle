/**
 * Forged carrier inputs against PostgreSQL's own equality: every batch of forged and honest Decimal and Money inputs
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
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Forged carrier inputs against PostgreSQL send PostgreSQL a set: the arrays hold as many distinct values as facts, and as the inputs stand for. */
export const forgedCarrierInputsAgainstPostgreSQLSendPostgreSQLASetTheArraysHoldAsManyDistinctValuesAsFactsAndAsTheInputsStandFor =
	property.explore(forgedCases(judged), {
		needs: { tx: Substrate.transaction },
		situations: [
			"a batch holding one value twice",
			"two values",
			"every input refused"
		] satisfies ReadonlyArray<Reached<BatchFeature>>,
		/** Its pre-conversion budget: runs 150, coverage cases 200 (forged.test.ts at 4fbc3e95). */
		budget: { runs: 150, steered: 200 },
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
				why: "Decimal's instanceof admits any object with a text, so a prototype object's forged text reaches the arrays and PostgreSQL counts values grizzle never counted as facts."
			}
		]
	})
