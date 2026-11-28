/**
 * Forged carrier instances against the one mint: everything a JavaScript caller can build that looks like a Numeric, a
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
 *
 * Features: each way an input ends (refused at admission, thrown out at construction, admitted as its value), a batch
 * holding one value twice, a buffer written after admission, and every carrier's every forgery.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Result } from "effect"
import {
	normalArray,
	parameterNormalizer,
	positionalColumns,
	type RelationSpec
} from "#compiler/codec/recordset.ts"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import { isValueFault } from "#compiler/scalar/values/fault.ts"
import { canonicalText, parseValue } from "#compiler/scalar/values/identity.ts"
import { readArrayLiteral } from "#test/support/arrays.ts"
import { succeeded } from "#test/support/assert.ts"
import { carriers, type Feature, forgedCases, pairOf, pairs } from "#test/support/forged.ts"
import { kindCodes } from "#test/support/unit/codec/support.ts"
import { textOfParam } from "#test/support/wire.ts"

/** A forged carrier instance is refused, or admitted as the PostgreSQL value it holds, so one value is one fact whatever its caller writes later. Its budget is its suite's before it was a property (test/unit/values/forged.test.ts at 4ca3036a): 1500 runs and 3000 steered cases. */
export const aForgedCarrierInstanceIsRefusedOrAdmittedAsThePostgreSQLValueItHoldsSoOneValueIsOneFactWhateverItsCallerWritesLater =
	property.explore(forgedCases(carriers), {
		needs: {},
		budget: { runs: 1500, steered: 3000 },
		situations: [
			"refused at admission",
			"thrown out at construction",
			"admitted as its value",
			"a batch holding one value twice",
			"a buffer written after admission",
			...pairs
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			(_, c: Case<Feature>) =>
			({ carrier, type, inputs }) =>
				Effect.sync(() => {
					const spec = carrierSpecOf(type, kindCodes)
					const admitted: Array<{ readonly input: unknown; readonly pg: string }> = []
					for (const one of inputs) {
						c.note(pairOf(carrier, one.forgery))
						const made = one.input
						if (Result.isFailure(made)) {
							c.note("thrown out at construction")
							assert.ok(
								isCompileError(made.failure) && made.failure.reason._tag === "MalformedDescription",
								`${carrier}, ${one.forgery}: construction threw something other than MalformedDescription`
							)
							assert.notEqual(one.forgery, "honest", "an honest construction threw")
							continue
						}
						const verdict = parseValue(spec, made.success)
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
						parameterNormalizer(relation)(Arr.map(admitted, (a) => ({ v: a.input })))
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
						new Set(readArrayLiteral(textOfParam(succeeded(normalArray(relation)(normal, 0))))),
						distinct,
						"the array the facts travel as carries the admitted values"
					)
					assert.deepEqual(
						Arr.map(normal.entries, (e) => e.identity),
						identities,
						"the identities stay the admitted ones"
					)
				}),
		oracle: {
			kind: "specification",
			name: "each input's PostgreSQL text, stated apart from grizzle (test/support/forged.ts)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original: '\t\treturn typeof value === "object" && value !== null && #minted in value',
				replacement:
					'\t\treturn typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Numeric.prototype',
				why: "A Numeric is recognized by its prototype, so an object built on Numeric.prototype passes as one; the forged-carrier property fails."
			},
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original: "\tconst units = exactUnits(d, typmod.scale)",
				replacement: "\tconst units = exactUnits(d, typmod.scale - 1)",
				why: "parseNumeric reads a typmod's scale one less, so a numeric at its column's full scale is refused; the forged-carrier property fails."
			}
		]
	})
