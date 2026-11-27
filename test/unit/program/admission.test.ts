/**
 * rowEvaluator's admission (program/evaluate.ts admission): a row is read as its relation's column types before any
 * domain, so a value its type's input function refuses, an integer that is none or past its type's range, a text
 * holding NUL, a date no calendar holds, a numeric past its typmod or a bytes value that is no Uint8Array, is the
 * admission's typed refusal, ValueRefused at its field by the codec's fault, never a throw, and the row every field of
 * which its type admits is admitted, a bytes field among them. Each bad input is drawn at each site a value sits: each
 * integer type, a text, a date, a numeric and a bytes value, plainly and under a contract whose predicate the host
 * judges, a refined field the domain loop reads; and at every site a NULL, an undefined and a row that lacks the field,
 * which a write's fact refuses as factShape at it: qti-pie's PUBFACTS lane admitted pantry's import rows of Node, a
 * tree's nested rows as an insert states them, without the `start`, `at` and `attrs` grizzle draws and accumulates or
 * the `package` the call computes, and admit died on "grizzle internal invariant: the type of a field at the row
 * states", having named the refused field by the row's own keys, where R's reading names it.
 *
 * The oracle is the column's own admission elsewhere, a write's: its member's fact of the field alone, read by the
 * normalizer every ChangeSet member's facts are read by (codec/recordset.ts relationNormalizer, its heading the field's
 * declared type, schema/relation.ts describeDeclared), the input function PostgreSQL's types state: its refusal's fault
 * is the admission's, one vocabulary.
 *
 * Features: the fault each case is refused by.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Result } from "effect"
import { rowEvaluator } from "#adapter/public/host.ts"
import { positionalColumns, relationNormalizer } from "#compiler/codec/recordset.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { describeDeclared } from "#compiler/schema/relation.ts"
import {
	Admissions,
	admittedRow,
	badInputGen,
	Cells,
	cellFields,
	factWith,
	rowWith
} from "#test/unit/program/admission.fixtures.ts"

/** The evaluator every case admits through, the schema compiled once. */
const evaluator = Result.getOrThrow(rowEvaluator(Admissions))

/**
 * Admission refuses every value its field's type refuses, at its field, by the fault codecText refuses it by, and admits
 * the row its every field's type and domain admit.
 */
export const admissionRefusesEveryValueItsColumnsTypeRefusesAtItsFieldByTheCodecsFaultNeverThrowing =
	property.exhaust(finite(badInputGen), {
		box: "every bad input of every class (a fraction, an integer of the other host, one past and one below an integer type's range, a NUL, an impossible date, a numeric past its scale and its precision) at every site (each integer type, a text, a date and a numeric, plainly and under a refined contract)",
		needs: {},
		situations: [],
		check: (_, c: Case<string>) => (input) =>
			Effect.sync(() => {
				assert.ok(
					Result.isSuccess(evaluator.admit(Cells, admittedRow)),
					"the row every field of which its type and domain admit"
				)
				const read = relationNormalizer({
					relation: "Cells",
					columns: positionalColumns([
						{
							name: input.site,
							type: describeDeclared(cellFields[input.site], SourceLoc("admission", [])).scalar
						}
					]),
					slot: { kind: "none" },
					codes: emptyCodebook
				}).readRow(factWith(input.site, input.input))
				if (read.ok) {
					return assert.fail(`a write's fact refuses ${input.label} at ${input.site}`)
				}
				const expected = { error: read.error.fault }
				const verdict = evaluator.admit(Cells, rowWith(input.site, input.input))
				if (!Result.isFailure(verdict)) {
					return assert.fail(`${input.label} at ${input.site} admitted`)
				}
				const refusal = verdict.failure
				assert.deepEqual(
					[
						refusal._tag,
						String(refusal.field),
						refusal._tag === "ValueRefused" ? refusal.fault : undefined
					],
					["ValueRefused", input.site, expected.error],
					`${input.label} at ${input.site}`
				)
				c.note(expected.error)
			}),
		oracle: {
			kind: "second-implementation",
			name: "a write's read of a fact of the field alone, its refusal's fault"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/evaluate.ts",
				original: "\tfor (const field of relation.stated) {",
				replacement: "\tfor (const field of relation.stated.slice(0, 0)) {",
				why: "Admission reads no field as its column's type (program/evaluate.ts admission), so a plain field's refused value is admitted and a refined one's throws from its domain judgment (scalar/values/identity.ts hostOf); the property fails at each."
			},
			{
				file: "packages/engine/src/program/evaluate.ts",
				original: "\t\tconst read = readField(field.spec, row, field.name)",
				replacement:
					'\t\tconst read = field.spec.carrier === "bytes" ? (() => { throw defect("a bytes value travels in binary, never as a parameter text") })() : readField(field.spec, row, field.name)',
				why: "Admission reads a stated field as the codec writes its parameter text (codec/scalar.ts hostText), not as the write reads a fact's field (scalar/values/identity.ts readField): a bytes value has no parameter text, so admitting a row of a relation with a bytes field throws a defect, and the admitted row fails."
			},
			{
				file: "packages/engine/src/program/evaluate.ts",
				original: "\t\tconst read = readField(field.spec, row, field.name)",
				replacement:
					'\t\tif (!Object.hasOwn(row, field.name)) {\n\t\t\tthrow defect("the type of a field the row states")\n\t\t}\n\t\tconst read = readField(field.spec, row, field.name)',
				why: "Admission names a refused field by the row's own keys, as before PUBFACTS' report: a row that lacks a field of R, as a write's fact of a tree's node lacks its drawn start, dies on the internal invariant where a write's fact is refused as factShape at the field."
			}
		]
	})
