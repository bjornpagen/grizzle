/**
 * A cast into an exact integer (scalar/compute/registry.ts castOverloads, numeric's and text's exactInteger) is
 * admitted exactly where its preconditions are proved, never by rounding: a text's parse in xs:integer's lexical form of
 * at most the exact integer's digits in bytes (scalar/lexical.ts, an exact integer's target), proved by the integer
 * guard's language and the text's byte bound, its type's or an octetLength guard's; a numeric finite, of no fraction
 * digits and within the exact integer's digits (integralNarrowing), proved by its type's bounds, numeric(p, 0)'s.
 * Before, neither cast was registered, so Type.cast refused both: "PostgreSQL has no cast between these types that
 * grizzle admits", qti-pie's ledger at 7ea6419c (lane LEDGER-VALUECELL, QtiValue's integer arm on exactInteger).
 *
 * The box: the parse in one step of a bounded text under qti-pie's integer guard; the parse of a text of no byte bound
 * under the form's guard and an octetLength bound; the same under the integer guard alone, its bytes unproved; qti-pie's
 * parseDecimal form, a guarded text read by Text.parseDecimal, bounded by Num.within and cast, whose fraction digits
 * nothing bounds; and numeric(30, 0) widened; each a relation's generated field, checked as a schema compiles.
 *
 * Oracle: the specification: each shape admitted, or refused as the PartialOperation of the precondition it leaves
 * unproved, naming the cast (Type.cast) as the operation.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, String as Str } from "effect"
import { checkedIn } from "#test/support/policy.ts"
import {
	schemaOf,
	type Shape,
	shapeNames,
	shapes
} from "#test/unit/compute/exact-casts.fixtures.ts"

/** A cast into an exact integer is admitted exactly where its preconditions are proved, and refused naming the cast. */
export const aCastIntoAnExactIntegerIsAdmittedExactlyWhereItsPreconditionsAreProved =
	property.exhaust(
		finite((source) => source.draw(element(shapeNames))),
		{
			needs: {},
			situations: shapeNames satisfies ReadonlyArray<Reached<Shape>>,
			check: (_, c: Case<Shape>) => (shape: Shape) =>
				Effect.sync(() => {
					c.note(shape)
					const checked = checkedIn(schemaOf(shape))
					const verdict = shapes[shape].verdict
					if (verdict.kind === "admitted") {
						assert.ok(
							checked.ok,
							`${shape}: admitted${checked.ok ? "" : `, not ${checked.error.message}`}`
						)
						return
					}
					if (checked.ok) {
						return assert.fail(`${shape}: refused for ${verdict.precondition}`)
					}
					const reason = checked.error.reason
					if (reason._tag !== "PartialOperation") {
						return assert.fail(`${shape}: a PartialOperation, not ${reason._tag}`)
					}
					assert.equal(reason.precondition, verdict.precondition, shape)
					assert.ok(
						Str.startsWith("Type.cast(")(reason.operation),
						`${shape}: the refusal names the cast, not ${reason.operation}`
					)
				}),
			oracle: {
				kind: "specification",
				name: "the cast's preconditions: a parse's lexical form within its bytes, a numeric finite, of no fraction digits and within the exact integer's digits"
			},
			box: "the parse in one step of a bounded text under the integer guard, of an unbounded text under the form's guard and an octetLength bound and under the integer guard alone, the consumer's parseDecimal form, and numeric(30, 0) widened",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/compute/registry.ts",
					original:
						"const integralNarrowing: Totality = requires([finite(0), integral(0), fits])\n",
					replacement: "const integralNarrowing: Totality = requires([finite(0), fits])\n",
					why: "A numeric into an exact integer needs no integrality, as numeric into an integer rounds: the consumer's parseDecimal form is admitted, its fractions cast into an exact integer no cast rounds into; the property fails."
				},
				{
					file: "packages/engine/src/scalar/compute/registry.ts",
					original:
						'\t\texactInteger: fromNumeric("exactInteger", integralNarrowing, "immutable")\n',
					replacement: "",
					why: "No cast from numeric into an exact integer, as before: numeric(30, 0) widened is refused at compile, PostgreSQL having no cast between these types that grizzle admits; the property fails."
				},
				{
					file: "packages/engine/src/scalar/compute/registry.ts",
					original: '\t\texactInteger: fromText("exactInteger")\n',
					replacement: "",
					why: "No parse of a text into an exact integer, as before: the guarded parse in one step is refused at compile; the property fails."
				}
			]
		}
	)
