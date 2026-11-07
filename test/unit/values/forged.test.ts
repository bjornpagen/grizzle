/**
 * Forged carrier instances against the one mint: everything a JavaScript caller can build that looks like a Decimal, a
 * Money or a Vector without the checked constructors is refused, at construction or at admission, or is admitted as the
 * canonical PostgreSQL value it holds. So one PostgreSQL value is one host fact, and a relation input is a set without
 * a DISTINCT.
 *
 * Oracle: the specification turned into a checker. Every input stands for a PostgreSQL value the case states apart from
 * grizzle (test/support/forged.ts), as PostgreSQL's own text of it: numeric_out of trim_scale for a numeric,
 * money::numeric for a money, vector_out for a vector. An input is refused with a word of the vocabulary, or thrown out
 * at construction with CompileError MalformedDescription, or admitted with exactly that text. A batch of admitted inputs
 * normalizes to as many facts as the distinct values it holds, and a vector's buffer written by its caller after
 * admission changes neither the batch's identities nor any row its arrays carry. The PostgreSQL differential
 * (test/pg/codec/forged.test.ts) judges the same batches by PostgreSQL's DISTINCT.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import {
	normalArray,
	positionalColumns,
	type RelationSpec,
	relationNormalizer
} from "#compiler/codec/recordset.ts"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import { isValueFault } from "#compiler/scalar/values/fault.ts"
import { admitValue, canonicalText } from "#compiler/scalar/values/identity.ts"
import { readArrayLiteral } from "#test/support/arrays.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { carriers, type Feature, forgedCases, pairOf, pairs } from "#test/support/forged.ts"
import { caseHang } from "#test/support/limits.ts"
import { kindCodes } from "#test/unit/codec/support.ts"

describe("a forged carrier instance", () => {
	it.effect(
		"is refused, or admitted as the PostgreSQL value it holds, so one value is one fact whatever its caller writes later",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/values/forged",
						draw: drawn(forgedCases(carriers)),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"refused at admission",
								"thrown out at construction",
								"admitted as its value",
								"a batch holding one value twice",
								"a buffer written after admission",
								...pairs
							],
							{ cases: 3000, sense: notesOnly }
						),
						kept: [],
						runs: 1500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ carrier, type, inputs }, c) =>
						Effect.sync(() => {
							const spec = carrierSpecOf(type, kindCodes)
							const admitted: Array<{ readonly input: unknown; readonly pg: string }> = []
							for (const one of inputs) {
								c.note(pairOf(carrier, one.forgery))
								const made = one.input
								if (Result.isFailure(made)) {
									c.note("thrown out at construction")
									assert.ok(
										isCompileError(made.failure) &&
											made.failure.reason._tag === "MalformedDescription",
										`${carrier}, ${one.forgery}: construction threw something other than MalformedDescription`
									)
									assert.notEqual(one.forgery, "honest", "an honest construction threw")
									continue
								}
								const verdict = admitValue(spec, made.success)
								if (!verdict.ok) {
									c.note("refused at admission")
									assert.ok(isValueFault(verdict.error), `refused with ${verdict.error}`)
									assert.notEqual(one.forgery, "honest", "an honest value was refused")
									continue
								}
								c.note("admitted as its value")
								assert.equal(
									canonicalText(spec, verdict.value),
									one.pg,
									`${carrier}, ${one.forgery}: admitted as another text than PostgreSQL's`
								)
								admitted.push({ input: made.success, pg: one.pg })
							}
							const relation: RelationSpec = {
								relation: "Forged",
								columns: positionalColumns([{ name: "v", type }]),
								slot: { kind: "none" },
								codes: kindCodes
							}
							const distinct = new Set(Arr.map(admitted, (a) => a.pg))
							if (distinct.size < admitted.length) {
								c.note("a batch holding one value twice")
							}
							const normal = succeeded(
								relationNormalizer(relation)(Arr.map(admitted, (a) => ({ v: a.input })))
							)
							assert.equal(normal.count, distinct.size, "one fact per PostgreSQL value")
							assert.deepEqual<ReadonlySet<string>>(
								new Set(Arr.flatten(normal.rows)),
								distinct,
								"every row carries its value's PostgreSQL text"
							)
							const buffers = Arr.filter(
								Arr.map(admitted, (a) => a.input),
								(input): input is Float32Array => input instanceof Float32Array
							)
							if (buffers.length === 0) {
								return
							}
							c.note("a buffer written after admission")
							const identities = Arr.map(normal.entries, (e) => e.identity)
							for (const buffer of buffers) {
								buffer.fill(7)
							}
							assert.deepEqual<ReadonlySet<string | null>>(
								new Set(readArrayLiteral(succeeded(normalArray(relation)(normal, 0)))),
								distinct,
								"the array the facts travel as carries the admitted values"
							)
							assert.deepEqual(
								Arr.map(normal.entries, (e) => e.identity),
								identities,
								"the identities stay the admitted ones"
							)
						})
				)
			)
	)
})
