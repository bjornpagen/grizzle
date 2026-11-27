/**
 * A float's zero costs work only where a value is a float (check/merge.ts, scalar/aggregate.ts, ir/compare.ts): over
 * every field type a merge, an aggregate or a write branches on, real and double precision, the integers, numeric,
 * money and text, each statement a value of the type reaches, a projection that drops its key, a union of two keyed
 * heads, a group keyed by it, a join variable bound by two relations' fields, each aggregate the type has, a put, an
 * insert and an exact deletion, holds the work its shape asks at a float, a canonical zero, a sum of the zeros or a
 * zero's sign byte, and at every other type none of any kind, under both lowerings.
 *
 * A float's min, max, sum and mean do the zero's work exactly where their argument may hold -0: none where its own form
 * proves it holds none (lower/conservative/group/index.ts argumentZeros), a contract that excludes zero, an integer's
 * cast, a Logic.cond of two such values, whose native extreme is IEEE 754-2019's and whose zero total is +0.
 *
 * Oracle: the specification, each shape's work at a float (zero-work.fixtures.ts workAtFloat) and none elsewhere; each
 * argument form's zeros (argumentForms).
 *
 * Features: each kind of work at a float, and no work at each other type; each float aggregate over an argument of
 * each zeros, and each argument form.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import {
	type ArgumentFeature,
	argumentCaseGen,
	argumentFeatures,
	argumentStatementsOf,
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
				original: "\t\tconst carrier = nonIdentityCarrierOf(sides.typeOf(field))",
				replacement: '\t\tconst carrier = nonIdentityCarrierOf(sides.typeOf(field)) ?? "float8"',
				why: "Every field of a written fact compares its zero's sign byte, as a float's does; a write of any other type does the work, and the property fails."
			},
			{
				file: "packages/engine/src/ir/scalar.ts",
				original: "\t!equalityIsIdentityOf[carrier]",
				replacement: "\ttrue",
				why: "Every carrier's equality reads as no identity, as a float's does: every merged value takes the canonical form, and a merge of any other type asks a canonical form no type but a float's has, and the property fails."
			}
		]
	})

/** A float aggregate does its zero's work exactly where its argument may hold -0: the IEEE extreme or the sum of the rows' zeros there, and none where the argument's own form proves it holds no -0. */
export const aFloatAggregateDoesItsZerosWorkExactlyWhereItsArgumentMayHoldMinus0AndNoneWhereItsFormProvesItHoldsNone =
	property.exhaust(finite(argumentCaseGen), {
		needs: {},
		situations: argumentFeatures satisfies ReadonlyArray<Reached<ArgumentFeature>>,
		check: (_, k: Case<ArgumentFeature>) => (c) =>
			Effect.sync(() => {
				const work = workIn(argumentStatementsOf(c))
				const at = `the ${c.aggregate} of ${c.form.name}`
				if (c.form.zeros === "signed") {
					assert.ok(
						work["zero sum"] > 0,
						`${at} reads its zero off its rows: ${Formatter.format(work)}`
					)
				} else {
					assert.equal(work["zero sum"], 0, `${at} sums no zeros: ${Formatter.format(work)}`)
				}
				k.note(`${c.form.zeros} ${c.aggregate}`)
				k.note(`form ${c.form.name}`)
			}),
		oracle: {
			kind: "specification",
			name: "each argument form's zeros (zero-work.fixtures.ts argumentForms): the zero's work where it may hold -0, none where it holds none"
		},
		box: "every float aggregate over every argument form, under both lowerings",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/group/index.ts",
				original: '\tif (zeros === "unsigned") {\n\t\treturn native\n\t}\n',
				replacement: "",
				why: "A min or max over an argument that holds no -0 reads its zero off its rows still; its IEEE form does the work, and the property fails."
			},
			{
				file: "packages/engine/src/lower/conservative/group/index.ts",
				original:
					"\t\t? zeroOf(float, false)\n\t\t: zerosSum(float, arg, arg, zeroOf(float, false), window)",
				replacement:
					"\t\t? zerosSum(float, arg, arg, zeroOf(float, false), window)\n\t\t: zerosSum(float, arg, arg, zeroOf(float, false), window)",
				why: "A sum or mean over an argument that holds no -0 sums its rows' zeros still, and the property fails."
			},
			{
				file: "packages/engine/src/lower/conservative/group/index.ts",
				original: "\tif (excludesZero(e.type)) {",
				replacement: '\tif (excludesZero(e.type) && e.kind === "param") {',
				why: "A contract that excludes zero proves nothing; an aggregate over a double above zero or never zero does the work, and the property fails."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: '\t\t(bounds !== undefined && boundsHave(bounds, "nonzero")) ||',
				replacement: '\t\t(bounds !== undefined && boundsHave(bounds, "nonnegative")) ||',
				why: "A contract at or above zero is taken to exclude zero, which -0 >= 0 meets; its aggregate does no work, and the property fails."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original:
					'\t\t\t\tc.predicate !== undefined && predicateAtoms(c.predicate).some((a) => a.kind === "nonzero")',
				replacement:
					'\t\t\t\tc.predicate !== undefined && predicateAtoms(c.predicate).some((a) => a.kind === "within")',
				why: "A contract's VALUE <> 0 proves nothing; an aggregate over a double never zero does the work, and the property fails."
			},
			{
				file: "packages/engine/src/lower/conservative/group/index.ts",
				original: "\t\treturn integerCarriers.has(baseOf(e.args[0].type).carrier)",
				replacement: "\t\treturn true",
				why: "Every cast to a float is taken to hold no -0; a real's cast keeps its -0 yet does no work, and the property fails."
			},
			{
				file: "packages/engine/src/lower/conservative/group/index.ts",
				original: '\t\treturn !(e.value.kind === "floatSpecial" && e.value.value === "-0")',
				replacement: "\t\treturn true",
				why: "A -0 literal is taken to hold no -0; a cond of an integer's cast and -0 does no work, and the property fails."
			},
			{
				file: "packages/engine/src/lower/conservative/group/index.ts",
				original:
					'\treturn e.kind === "cond" && holdsNoNegativeZero(e.args[1]) && holdsNoNegativeZero(e.args[2])',
				replacement: '\treturn e.kind === "cond" && holdsNoNegativeZero(e.args[2])',
				why: "A cond is judged by its otherwise alone; a cond of a double and 0 does no work, and the property fails."
			}
		]
	})
