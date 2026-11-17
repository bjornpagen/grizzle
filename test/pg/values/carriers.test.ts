/**
 * Spans and vectors against PostgreSQL 19 and the pinned pgvector: the host's carriers (scalar/values/span.ts,
 * scalar/values/vector.ts) are PostgreSQL's, value for value.
 *
 * - Span order: PostgreSQL's positions of a batch of int4 spans, every span of bounds within -5..5, under
 *   ORDER BY v::int4range (ties by position) are the host's under compareSpan.
 * - Vector rounding: every binary64 component strictly inside binary32's range, rounding edges among them, rounds as
 *   PostgreSQL's float8-to-real cast rounds it (Float32Array's rounding is the cast's), and pgvector reads the text the
 *   codec writes (Vector.componentText) as exactly those binary32 components.
 * - Vector input: every input, components across and past binary32's range, NaN and the infinities among them, its
 *   length its own or about the storage limit, is refused by pgvector by text, and through real, with the SQLSTATE a
 *   model of vector_in, array_to_vector and float8_to_float4's checks names; the host (Vector.from) refuses exactly
 *   what the text input refuses; and an admitted input reads as each component's binary32 rounding.
 * - Vector order: PostgreSQL's positions of a batch of vectors of up to three components under ORDER BY v::vector
 *   (ties by position) are the host's under Vector.compare.
 *
 * Oracle: PostgreSQL itself: range_cmp, float8_to_float4, pgvector's vector_in, array_to_vector and vector_cmp.
 *
 * Features: the vector input's "admitted", "at the storage limit", "a component past binary32", "a non-finite
 * component", "past the storage limit" and "an underflow read as zero".
 */

import { vectorMaxDimensions } from "@bjornpagen/grizzle-engine/ir/carriers"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Result } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { compareSpan, spanText } from "#compiler/scalar/values/span.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import {
	batchOf,
	binaryVerdict,
	components,
	float8ArrayText,
	hostVector,
	type InputFeature,
	inputGen,
	inputOf,
	oneCellOf,
	pgFloatArray,
	sameComponents,
	span,
	vector,
	vectorTypeOf
} from "#test/pg/values/carriers.fixtures.ts"
import { exactVectorText, vectorInVerdict } from "#test/pg/vector/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { orderOf } from "#test/unit/values/support.ts"

/** Span and vector agreement with PostgreSQL orders spans as range_cmp does. */
export const spanAndVectorAgreementWithPostgreSQLOrdersSpansAsRangeCmpDoes = property.explore(
	batchOf(span, 600),
	{
		needs: { tx: Substrate.transaction },
		situations: [],
		/** Its pre-conversion budget: runs 2, no coverage (carriers.test.ts at 4fbc3e95). */
		budget: { runs: 2, steered: 0 },
		check:
			({ tx }) =>
			(spans) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx

					const payload = jsonText(Arr.map(spans, (s, ord) => ({ ord, v: spanText(s) })))
					const rows = yield* db.values(
						"SELECT c.ord::text FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text) ORDER BY c.v::int4range, c.ord",
						[payload]
					)
					const host = orderOf(spans, compareSpan)
					const rowsOrder: ReadonlyArray<number> = Arr.map(rows, (r) => Number(r[0]))
					assert.deepEqual(rowsOrder, host)
				}),
		oracle: { kind: "postgresql", name: "range_cmp, int4range's ORDER BY" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/span.ts",
				original:
					"\tif (a.start !== b.start) {\n\t\treturn a.start < b.start ? -1 : 1\n\t}\n\tif (a.end !== b.end) {\n\t\treturn a.end < b.end ? -1 : 1",
				replacement:
					"\tif (a.end !== b.end) {\n\t\treturn a.end < b.end ? -1 : 1\n\t}\n\tif (a.start !== b.start) {\n\t\treturn a.start < b.start ? -1 : 1",
				why: "compareSpan compares the upper bounds first; the span order property fails."
			}
		]
	}
)

/** Span and vector agreement with PostgreSQL rounds binary64 components as PostgreSQL's float8-to-real cast does, and pgvector reads the codec text exactly. */
export const spanAndVectorAgreementWithPostgreSQLRoundsBinary64ComponentsAsPostgreSQLsFloat8ToRealCastDoesAndPgvectorReadsTheCodecTextExactly =
	property.explore(batchOf(components, 1000), {
		needs: { tx: Substrate.transaction },
		situations: [],
		/** Its pre-conversion budget: runs 2, no coverage (carriers.test.ts at 4fbc3e95). */
		budget: { runs: 2, steered: 0 },
		check:
			({ tx }) =>
			(inputs) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx
					const { vectorType } = yield* vectorTypeOf(db)

					const vectors = Arr.map(inputs, (xs) => ({
						xs,
						v: Vector.make(Float32Array.from(xs), xs.length)
					}))
					/**
					 * Column 1 is PostgreSQL's own rounding of the original binary64 inputs, handed to pgvector
					 * as real[]; column 2 is pgvector reading the text the codec sends.
					 */
					const rows = yield* db.values(
						`SELECT ((c.xs::float8[]::real[])::${vectorType})::real[]::float8[]::text,
									((c.v::${vectorType})::real[])::float8[]::text
								FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, xs text, v text) ORDER BY c.ord`,
						[
							jsonText(
								Arr.map(vectors, ({ xs, v }, ord) => ({
									ord,
									xs: float8ArrayText(xs),
									v: Vector.componentText(v)
								}))
							)
						]
					)
					assert.equal(rows.length, vectors.length)
					const mismatches = Arr.flatMap(vectors, ({ xs, v }, i) => {
						const host = Array.from(v)
						const rounded = pgFloatArray(rows[i]?.[0])
						const read = pgFloatArray(rows[i]?.[1])
						return sameComponents(rounded, host) && sameComponents(read, host)
							? []
							: [{ input: float8ArrayText(xs), host: Vector.componentText(v), pg: rows[i] }]
					})
					assert.deepEqual(mismatches.slice(0, 5), [])
				}),
		oracle: {
			kind: "postgresql",
			name: "float8_to_float4 over float8[], and pgvector's vector_in of the codec's text"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/vector.ts",
				original: 'const componentTextOf = (x: number): string => (x === 0 ? "0" : String(x))',
				replacement:
					'const componentTextOf = (x: number): string => (x === 0 ? "0" : x.toPrecision(7))',
				why: "componentText writes seven significant digits; the vector rounding property fails."
			}
		]
	})

/** Span and vector agreement with PostgreSQL refuses what pgvector refuses, by text and through real, reads every admitted component as its binary32 rounding, and the host refuses alike. */
export const spanAndVectorAgreementWithPostgreSQLRefusesWhatPgvectorRefusesByTextAndThroughRealReadsEveryAdmittedComponentAsItsBinary32RoundingAndTheHostRefusesAlike =
	property.explore(inputGen, {
		needs: { tx: Substrate.transaction },
		situations: [
			"admitted",
			"at the storage limit",
			"a component past binary32",
			"a non-finite component",
			"past the storage limit",
			"an underflow read as zero"
		] satisfies ReadonlyArray<Reached<InputFeature>>,
		/** Its pre-conversion budget: runs 60, coverage cases 60 (carriers.test.ts at 4fbc3e95). */
		budget: { runs: 60, steered: 60 },
		check:
			({ tx }, c: Case<InputFeature>) =>
			(sketch) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx
					const { vectorType } = yield* vectorTypeOf(db)
					/** PostgreSQL's answer to an input: the SQLSTATE it refused it with, or the value it read. */
					const answer = (sql: string, text: string) =>
						Effect.map(Effect.result(db.values(sql, [text])), (rows) =>
							Result.isSuccess(rows)
								? { verdict: "admitted" as const, read: oneCellOf(rows.success)[0][0] }
								: {
										verdict: defined(pgErrorFields(rows.failure), "a server error").code,
										read: undefined
									}
						)

					const xs = inputOf(sketch)
					const expected = vectorInVerdict(xs, Option.none())
					const text = yield* answer(
						`SELECT (($1::text::${vectorType})::real[])::float8[]::text`,
						exactVectorText(xs)
					)
					assert.equal(text.verdict, expected, "the text input")
					const binary = yield* answer(
						`SELECT (($1::text::float8[]::real[])::${vectorType})::text`,
						float8ArrayText(xs)
					)
					assert.equal(binary.verdict, binaryVerdict(xs), "the input through real")
					const host = hostVector(xs)
					const hostRefuses =
						!host.ok &&
						(host.error.reason._tag === "vectorDimensions" ||
							host.error.reason._tag === "vectorNonFinite")
					assert.equal(hostRefuses, expected !== "admitted", "the host refuses alike")
					switch (expected) {
						case "admitted": {
							c.note("admitted")
							assert.deepEqual(
								pgFloatArray(text.read),
								Arr.map(xs, Math.fround),
								"pgvector reads each component as its binary32 rounding"
							)
							if (xs.length === vectorMaxDimensions) {
								c.note("at the storage limit")
							}
							if (Arr.some(xs, (x) => x !== 0 && Math.fround(x) === 0)) {
								c.note("an underflow read as zero")
							}
							return
						}
						case "22003":
							c.note("a component past binary32")
							return
						case "22000":
							c.note("a non-finite component")
							return
						case "54000":
							c.note("past the storage limit")
							return
					}
				}),
		oracle: {
			kind: "postgresql",
			name: "pgvector's vector_in and array_to_vector, and float8_to_float4, against a model of their checks"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/vector.ts",
				original: "\t\tif (!Number.isFinite(x)) {",
				replacement: "\t\tif (Number.isNaN(x)) {",
				why: "The component check refuses NaN alone, so an infinity reaches the norm check; the vector input property fails."
			}
		]
	})

/** Span and vector agreement with PostgreSQL orders vectors as vector_cmp does. */
export const spanAndVectorAgreementWithPostgreSQLOrdersVectorsAsVectorCmpDoes = property.explore(
	batchOf(vector, 400),
	{
		needs: { tx: Substrate.transaction },
		situations: [],
		/** Its pre-conversion budget: runs 2, no coverage (carriers.test.ts at 4fbc3e95). */
		budget: { runs: 2, steered: 0 },
		check:
			({ tx }) =>
			(vectors) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx
					const { vectorType } = yield* vectorTypeOf(db)

					const rows = yield* db.values(
						`SELECT c.ord::text FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text) ORDER BY c.v::${vectorType}, c.ord`,
						[jsonText(Arr.map(vectors, (v, ord) => ({ ord, v: Vector.componentText(v) })))]
					)
					const host = orderOf(vectors, Vector.compare)
					const rowsOrder: ReadonlyArray<number> = Arr.map(rows, (r) => Number(r[0]))
					assert.deepEqual(rowsOrder, host)
				}),
		oracle: { kind: "postgresql", name: "pgvector's vector_cmp, the vector's ORDER BY" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/vector.ts",
				original: "const compare = (a: Float32Array, b: Float32Array): -1 | 0 | 1 => {",
				replacement:
					"const compare = (a: Float32Array, b: Float32Array): -1 | 0 | 1 => {\n\tif (a.length !== b.length) {\n\t\treturn a.length < b.length ? -1 : 1\n\t}",
				why: "Vector.compare orders by dimension count first; the vector order property fails."
			}
		]
	}
)
