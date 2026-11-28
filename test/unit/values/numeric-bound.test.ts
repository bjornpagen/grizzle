/**
 * A computed numeric's bound as a stored field holds it (numeric.within, ir/scalar.ts NumericBound), at the codec's
 * door (values/identity.ts parseValue, values/decimal.ts withinBound): numeric of no typmod within the bound.
 *
 * - Admission: over drawn bounds, below one among them, and values at and about their edges, of a fraction digit more or
 *   fewer and a digit more or fewer, and the specials, a value is admitted as itself exactly where it is NaN, an
 *   infinity, or a finite value of at most the bound's scale fraction digits below 10^digits in magnitude, and refused
 *   as numericBound otherwise, never rounded; at numeric's own limits every value is admitted. Oracle: the bound in
 *   exact rational arithmetic, c / 10^m within it where m is at most its scale and c < 10^(digits + m), apart from the
 *   digit count withinBound reads (numeric-bound.fixtures.ts modelWithin).
 *
 * - Casts: over drawn numeric(p, s) operands and bounds about them, Type.cast into numeric.within(digits, scale)
 *   stands exactly where the operand's values are proved within the bound, p - s at most its digits and s at most its
 *   scale, and is refused otherwise, since nothing rounds into it. Oracle: numeric(p, s)'s values, as its typmod bounds
 *   them.
 *
 * Features: a finite value within, one at the greatest it holds, one of too many fraction digits, one too great, zero, a
 * special, a bound below one and numeric's own limits; a cast proved within, and one past the bound.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { Type } from "#compiler/public/compute.ts"
import { generated, int4, numeric } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { parseValue } from "#compiler/scalar/values/identity.ts"
import { faulted, succeeded, throwsRefused } from "#test/support/assert.ts"
import { checkedIn } from "#test/support/policy.ts"
import {
	type BoundFeature,
	boundFeatures,
	boundSpace,
	type CastFeature,
	castSpace,
	modelWithin
} from "#test/unit/values/numeric-bound.fixtures.ts"

/** A numeric within its computed bound is admitted as itself, NaN and the infinities among them, and every other refused as past the bound, never rounded. */
export const aNumericWithinItsComputedBoundIsAdmittedAsItselfNaNAndTheInfinitiesAmongThemAndEveryOtherRefusedAsPastTheBoundNeverRounded =
	property.explore(boundSpace, {
		needs: {},
		budget: { runs: 800, steered: 200 },
		situations: [
			"a finite value within admitted",
			"a value just below 10^digits admitted",
			"a value of too many fraction digits refused",
			"a value too great refused",
			"zero admitted",
			"a special admitted",
			"a bound below one",
			"numeric's own limits admitted"
		] satisfies ReadonlyArray<Reached<BoundFeature>>,
		check:
			(_, c: Case<BoundFeature>) =>
			({ bound, value }) =>
				Effect.sync(() => {
					c.noteAll(boundFeatures({ bound, value }))
					const admitted = parseValue({ carrier: "numeric", typmod: undefined, bound }, value)
					if (modelWithin(value, bound)) {
						assert.ok(
							succeeded(admitted).equals(value),
							"a value within its bound is admitted as itself"
						)
					} else {
						faulted(admitted, "numericBound")
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "the bound in exact rational arithmetic, apart from the digit count withinBound reads"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original: "\treturn p.minScale <= bound.scale && integerDigits <= bound.digits",
				replacement: "\treturn integerDigits <= bound.digits",
				why: "A value of more fraction digits than its bound's scale is admitted, a value the column's CHECK refuses."
			},
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original: "\treturn p.minScale <= bound.scale && integerDigits <= bound.digits",
				replacement: "\treturn p.minScale <= bound.scale && integerDigits <= bound.digits + 1",
				why: "A value of 10^digits in magnitude is admitted, past its bound."
			},
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original: "\t\t\t\t? withinBound(value, spec.bound)",
				replacement: "\t\t\t\t? Result.ok(value)",
				why: "The codec's door admits every Numeric at a computed numeric's bound, sending one its column refuses."
			}
		]
	})

/** A cast into a computed numeric's bound stands exactly where its operand's bounds prove every value within it. */
export const aCastIntoAComputedNumericsBoundStandsExactlyWhereItsOperandsBoundsProveEveryValueWithinIt =
	property.explore(castSpace, {
		needs: {},
		budget: { runs: 120, steered: 40 },
		situations: [
			"a cast proved within admitted",
			"a cast past the bound refused"
		] satisfies ReadonlyArray<Reached<CastFeature>>,
		check:
			(_, c: Case<CastFeature>) =>
			({ precision, scale, target }) =>
				Effect.sync(() => {
					const within = precision - scale <= target.digits && scale <= target.scale
					c.note(within ? "a cast proved within admitted" : "a cast past the bound refused")
					const bounded = numeric.within(target.digits, target.scale)
					const casts = () =>
						schema(
							"Casts",
							[
								relation.generated(
									"T",
									{ id: int4, x: numeric(precision, scale) },
									["id"],
									(r) => ({ g: generated(bounded, Type.cast(r.x, bounded)) })
								)
							],
							[]
						)
					if (within) {
						succeeded(checkedIn(casts()), "a cast proved within the bound is admitted")
					} else {
						throwsRefused(
							casts,
							"UnsupportedOperation",
							"a cast past the bound is refused where it is built"
						)
					}
				}),
		oracle: {
			kind: "specification",
			name: "numeric(p, s)'s values lie below 10^(p - s) at s fraction digits: within a bound of at least those digits and that scale"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: "\t\t\t\targ.bounds.scale <= bound.scale",
				replacement: "\t\t\t\targ.bounds.scale <= bound.scale + 1",
				why: "A cast into a bound of fewer fraction digits than its operand's is admitted, typing a value past the bound as within it."
			}
		]
	})
