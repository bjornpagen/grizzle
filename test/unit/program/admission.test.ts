/**
 * rowEvaluator's admission (program/evaluate.ts admitted): a row is read as its relation's column types before any
 * domain, so a value its type's input function refuses, an integer that is none or past its type's range, a text
 * holding NUL, a date no calendar holds or a numeric past its typmod, is the admission's typed refusal, ValueRefused at
 * its field by the codec's fault, never a throw, and the row every field of which its type admits is admitted. Each bad
 * input is drawn at each site a value sits: each integer type, a text, a date and a numeric, plainly and under a
 * contract whose predicate the host judges, a refined field the domain loop reads.
 *
 * The oracle is the column's own admission elsewhere, the codec's read of a value of the field's declared type
 * (codec/scalar.ts hostText over schema/relation.ts describeDeclared), codecText's, the input function PostgreSQL's types
 * state: its refusal's fault is the admission's, one vocabulary.
 *
 * Features: the fault each case is refused by.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Result } from "effect"
import { rowEvaluator } from "#adapter/public/host.ts"
import { hostText } from "#compiler/codec/scalar.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { describeDeclared } from "#compiler/schema/relation.ts"
import {
	Admissions,
	admittedRow,
	badInputGen,
	Cells,
	cellFields
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
				const expected = hostText(
					describeDeclared(cellFields[input.site], SourceLoc("admission", [])).scalar
				)(input.value)
				assert.ok(!expected.ok, `the codec refuses ${input.label} at ${input.site}`)
				const verdict = evaluator.admit(Cells, { ...admittedRow, [input.site]: input.value })
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
			name: "the codec's read of the field's declared type, codecText's, its refusal's fault"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/evaluate.ts",
				original: "\tfor (const field of relation.stated) {",
				replacement: "\tfor (const field of relation.stated.slice(0, 0)) {",
				why: "Admission reads no field as its column's type (program/evaluate.ts admitted), so a plain field's refused value is admitted and a refined one's throws from its domain judgment (scalar/values/identity.ts hostOf); the property fails at each."
			}
		]
	})
