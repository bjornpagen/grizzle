import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { positionalColumns } from "#compiler/codec/recordset.ts"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { admitValue } from "#compiler/scalar/values/identity.ts"
/**
 * Forged carrier inputs against PostgreSQL's own equality: every batch of forged and honest Decimal and Money inputs
 * grizzle admits is sent as a relation input's arrays, and PostgreSQL finds in those arrays exactly as many distinct
 * values as grizzle counted facts, and exactly as many as it finds among the PostgreSQL texts the inputs stand for
 * (test/support/forged.ts). So the arrays of a forged input are a set under PostgreSQL's equality, the premise a
 * relation input's lowering reads them without a DISTINCT on, and two forged values PostgreSQL calls equal are one fact.
 *
 * Oracle: PostgreSQL itself, its DISTINCT under the column's type, over both the arrays grizzle sends and the
 * independent texts of the values the inputs stand for.
 */
import { arraysEncoder } from "#test/support/arrays.ts"
import { assert, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { type CarrierName, carriers, forgedCases } from "#test/support/forged.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** The forged carriers whose arrays PostgreSQL reads without an extension: numeric at two typmods, and money. */
const judged = nonEmpty(
	Arr.filter(carriers, (c) => c.host !== "vector"),
	"the carriers PostgreSQL judges"
)

/** Each judged carrier's SQL: the element type its array is read as, and the column type its values are compared at. */
const sqlOf: { readonly [C in Exclude<CarrierName, "vector(3)">]: { readonly type: string } } = {
	numeric: { type: "numeric" },
	"numeric(5,2)": { type: "numeric(5,2)" },
	money: { type: "money" }
}

type Feature = "a batch holding one value twice" | "two values" | "every input refused"

layer(Substrate.layer)("forged carrier inputs against PostgreSQL", (it) => {
	it.effect(
		"send PostgreSQL a set: the arrays hold as many distinct values as facts, and as the inputs stand for",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { session } = yield* Substrate
					const db = yield* session(ownerSession())
					return yield* explore(
						{
							oracle: { kind: "unstated" },
							suite: "codec/forged",
							draw: drawn(forgedCases(judged)),
							literal: Formatter.format,
							coverage: required<Feature>(
								["a batch holding one value twice", "two values", "every input refused"],
								{ cases: 200, sense: notesOnly }
							),
							kept: [],
							/** One round trip a case. */
							runs: 150,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ carrier, type, inputs }, c) =>
							Effect.gen(function* () {
								if (carrier === "vector(3)") {
									return
								}
								const spec = carrierSpecOf(type, emptyCodebook)
								const admitted = Arr.flatMap(inputs, (one) =>
									Result.isSuccess(one.input) && admitValue(spec, one.input.success).ok
										? [{ input: one.input.success, pg: one.pg }]
										: []
								)
								if (admitted.length === 0) {
									c.note("every input refused")
									return
								}
								const distinct = new Set(Arr.map(admitted, (a) => a.pg))
								c.note(
									distinct.size < admitted.length ? "a batch holding one value twice" : "two values"
								)
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
							})
					)
				})
			)
	)
})
