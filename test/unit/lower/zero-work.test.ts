/**
 * A float's zero costs work only where a value is a float (check/merge.ts, scalar/aggregate.ts, ir/compare.ts): over
 * every field type a merge, an aggregate or a write branches on, real and double precision, the integers, numeric,
 * money and text, each statement a value of the type reaches, a projection that drops its key, a union of two keyed
 * heads, a group keyed by it, a join variable bound by two relations' fields, each aggregate the type has, a put, an
 * insert and an exact deletion, holds the work its shape asks at a float, a canonical zero, a sum of the zeros or a
 * zero's sign byte, and at every other type none of any kind, under both lowerings.
 *
 * Oracle: the specification, each shape's work at a float (zero-work.fixtures.ts workAtFloat) and none elsewhere.
 *
 * Features: each kind of work at a float, and no work at each other type.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import {
	type Feature,
	features,
	noWork,
	statementsOf,
	workAtFloat,
	workCaseGen,
	workIn
} from "#test/unit/lower/zero-work.fixtures.ts"

/** A float's zero costs a statement work exactly where its value is a float: the work its shape asks there, and none of any kind at every other type. */
export const aFloatsZeroCostsAStatementWorkExactlyWhereItsValueIsAFloatTheWorkItsShapeAsksThereAndNoneOfAnyKindAtEveryOtherType =
	property.exhaust(finite(workCaseGen), {
		needs: {},
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, k: Case<Feature>) => (c) =>
			Effect.sync(() => {
				const work = workIn(statementsOf(c))
				const at = `the ${c.shape} over ${c.type.name}`
				if (c.type.float) {
					const asked = workAtFloat(c.shape)
					assert.ok(work[asked] > 0, `${at} does the ${asked}'s work: ${Formatter.format(work)}`)
					k.note(`${asked} at a float`)
					return
				}
				assert.deepEqual(work, noWork, `${at} does no float zero's work`)
				k.note(`none at ${c.type.name}`)
			}),
		oracle: {
			kind: "specification",
			name: "each shape's work at a float (zero-work.fixtures.ts workAtFloat), and none at every other type"
		},
		box: "every field type a merge, an aggregate or a write branches on, under every shape it is defined on",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/aggregate.ts",
				original: "\t\tlowering: float === undefined ? native : signedExtreme(name, float)",
				replacement: '\t\tlowering: signedExtreme(name, float ?? "float8")',
				why: "Every type's min and max read their zero off a sum of zeros, as a float's do; the integers', numeric's, money's and text's do the work, and the property fails."
			},
			{
				file: "packages/engine/src/ir/compare.ts",
				original: "\t\tconst carrier = floatCarrierOf(sides.typeOf(field))",
				replacement: '\t\tconst carrier = floatCarrierOf(sides.typeOf(field)) ?? "float8"',
				why: "Every field of a written fact compares its zero's sign byte, as a float's does; a write of any other type does the work, and the property fails."
			},
			{
				file: "packages/engine/src/ir/scalar.ts",
				original:
					"export const isFloat = (t: ScalarType): boolean => floatCarrierOf(t) !== undefined",
				replacement: "export const isFloat = (_t: ScalarType): boolean => true",
				why: "Every merged value takes the canonical zero, as a float's does; a merge of any other type asks a canonical zero no type but a float's has, and the property fails."
			}
		]
	})
