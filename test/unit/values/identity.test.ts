/**
 * A host value's admission and a fact's identity (scalar/values/identity.ts).
 *
 * - Admission: parseValue stores each carrier's value as its documented host type and range say, exactly, and refuses
 *   every other value, near misses and wild values of every kind, by its fault, never throwing: a numeric past its
 *   typmod's scale and a double that is no binary32 value are refused, never rounded; Uuid.parse admits exactly as the
 *   uuid carrier does. Oracle: each carrier's documentation as a judge of the value.
 * - Identity: a fact rewritten as another spelling of its values (a uuid's case, a span's keys or the fact's keys in
 *   another order) keeps its identity, and a fact changed has another. Oracle: universal, a metamorphic relation.
 * - Refusal: a fact that is not exactly its heading is refused as factShape, naming the field a misspelt key stands
 *   for; a value its field cannot hold, by its fault and field, an amount past its scale and a real no binary32 value
 *   holds among them; a heading naming a field twice admits no fact. Oracle: the heading's shape and each carrier's
 *   faults as a checker.
 *
 * Features: each carrier stored and refused; each rewrite and each change; each malformation.
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { boolean, element, int, shuffled } from "@bjornpagen/testing/gen"
import { passed } from "@bjornpagen/testing/lsw"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import type { ValueFault } from "#compiler/core/errors.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { isValueFault } from "#compiler/scalar/values/fault.ts"
import { binary32Max } from "#compiler/scalar/values/float.ts"
import { factIdentity, type HeadingField, parseValue } from "#compiler/scalar/values/identity.ts"
import { Uuid } from "#compiler/scalar/values/uuid.ts"
import { faulted, succeeded } from "#test/support/assert.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import {
	type AdmissionFeature,
	admissionSpace,
	amountType,
	carriers,
	type FactChange,
	factChanges,
	factGen,
	factOf,
	type FactRewrite,
	factRewrites,
	heading,
	keys,
	malformations,
	type Malformed,
	reordered
} from "#test/unit/values/identity.fixtures.ts"

/** ParseValue stores every value of each carrier as its host type and range say, and refuses every other by its fault, never throwing; Uuid.parse admits exactly as the uuid carrier does. Its budget is its suite's before it was a property (test/unit/values/identity.test.ts at 4ca3036a): 3000 runs and 3000 steered cases. */
export const parseValueStoresEveryValueOfEachCarrierAsItsHostTypeAndRangeSayAndRefusesEveryOtherByItsFaultNeverThrowingUuidParseAdmitsExactlyAsTheUuidCarrierDoes =
	property.explore(admissionSpace, {
		needs: {},
		budget: { runs: 3000, steered: 3000 },
		situations: Arr.flatMap(carriers, (c): Arr.NonEmptyReadonlyArray<AdmissionFeature> => [
			`${c.spec.carrier} stored`,
			`${c.spec.carrier} refused`
		]) satisfies ReadonlyArray<Reached<AdmissionFeature>>,
		check:
			(_, c: Case<AdmissionFeature>) =>
			([carrier, drawnValue]) =>
				Effect.sync(() => {
					const value = passed(drawnValue)
					const verdict = carrier.judge(value)
					const result = parseValue(carrier.spec, value)
					c.note(`${carrier.spec.carrier} ${result.ok ? "stored" : "refused"}`)
					if (carrier.spec.carrier === "uuid") {
						assert.deepEqual(
							result,
							Uuid.parse(value),
							"Uuid.parse is the uuid carrier's admission"
						)
					}
					if (verdict === "a fault of the vocabulary") {
						if (!result.ok) {
							assert.ok(isValueFault(result.error))
						}
						return
					}
					if ("stored" in verdict) {
						assert.deepEqual(succeeded(result), verdict.stored)
					} else {
						faulted(result, verdict.fault)
					}
				}),
		oracle: {
			kind: "specification",
			name: "each carrier's documented host type and range, judging the value"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/uuid.ts",
				original: "\treturn Result.ok(upper ? value.toLowerCase() : value)",
				replacement: "\treturn Result.ok(value)",
				why: "An upper-case uuid is stored as written, not lower-cased; the admission and identity properties fail."
			}
		]
	})

/** FactIdentity gives two spellings of one fact one identity, and a changed fact another. Its budget is its suite's before it was a property (test/unit/values/identity.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const factIdentityGivesTwoSpellingsOfOneFactOneIdentityAndAChangedFactAnother =
	property.explore(
		(source) => ({
			fact: source.draw(factGen),
			same: source.draw(boolean),
			pick: source.draw(pickGen),
			order: source.draw(shuffled(keys, { min: keys.length, max: keys.length }))
		}),
		{
			needs: {},
			budget: { runs: 300, steered: 300 },
			situations: [
				...Arr.map(factRewrites, (r) => `same: ${r}` as const),
				...Arr.map(factChanges, (r) => `changed: ${r}` as const)
			] satisfies ReadonlyArray<Reached<`same: ${FactRewrite}` | `changed: ${FactChange}`>>,
			check:
				(_, c: Case<`same: ${FactRewrite}` | `changed: ${FactChange}`>) =>
				({ fact: drawnFact, same, pick, order }) =>
					Effect.sync(() => {
						const fact = factOf(drawnFact)
						const admitted = succeeded(factIdentity(heading, fact))
						assert.ok(Object.isFrozen(admitted.fact))
						if (same) {
							const rewrite = pickFrom(factRewrites, pick)
							c.note(`same: ${rewrite}`)
							const rewritten =
								rewrite === "uuid case"
									? { ...fact, id: Str.toUpperCase(fact.id) }
									: rewrite === "span keys reordered"
										? { ...fact, during: { end: fact.during.end, start: fact.during.start } }
										: reordered(fact, order)
							assert.deepEqual(
								succeeded(factIdentity(heading, rewritten)).identity,
								admitted.identity,
								rewrite
							)
						} else {
							const change = pickFrom(factChanges, pick)
							c.note(`changed: ${change}`)
							const changedFact =
								change === "another amount"
									? { ...fact, amount: Decimal.of(`${drawnFact.cents + 1n}e-2`) }
									: change === "another span"
										? { ...fact, during: { start: fact.during.start, end: fact.during.end + 1n } }
										: { ...fact, ratio: fact.ratio === 0 ? 1 : -fact.ratio }
							assert.notDeepEqual(
								succeeded(factIdentity(heading, changedFact)).identity,
								admitted.identity,
								change
							)
						}
					}),
			oracle: {
				kind: "universal",
				name: "metamorphic: a respelling of the fact's values keeps the identity, a change moves it"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/values/uuid.ts",
					original: "\treturn Result.ok(upper ? value.toLowerCase() : value)",
					replacement: "\treturn Result.ok(value)",
					why: "An upper-case uuid is stored as written, not lower-cased; the admission and identity properties fail."
				},
				{
					file: "packages/engine/src/scalar/values/identity.ts",
					original: "\t\t\t: canonicalText(spec, value)",
					replacement: "\t\t\t: String(value)",
					why: "A field's part of the identity is its value's own text rather than its canonical one; the identity property fails."
				}
			]
		}
	)

/** FactIdentity refuses facts that are not exactly the heading, naming the field when there is one. Its budget is its suite's before it was a property (test/unit/values/identity.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const factIdentityRefusesFactsThatAreNotExactlyTheHeadingNamingTheFieldWhenThereIsOne =
	property.explore(
		(source) => ({
			fact: source.draw(factGen),
			malformed: source.draw(element(malformations)),
			extra: source.draw(boolean),
			digits: source.draw(int(0, 4)),
			fraction: source.draw(int(1, 9))
		}),
		{
			needs: {},
			budget: { runs: 300, steered: 300 },
			situations: malformations satisfies ReadonlyArray<Reached<Malformed>>,
			check:
				(_2, c: Case<Malformed>) =>
				({ fact: drawnFact, malformed, extra, digits, fraction }) =>
					Effect.sync(() => {
						c.note(malformed)
						const fact = factOf(drawnFact)
						const { ratio: _, ...missing } = fact
						const duplicated = [...heading, { name: "id", spec: { carrier: "uuid" } } as const]
						const [h, value, refusal]: readonly [
							ReadonlyArray<HeadingField>,
							unknown,
							{ readonly fault: ValueFault; readonly field: string | undefined }
						] =
							malformed === "an extra key"
								? [heading, { ...fact, extra: 1 }, { fault: "factShape", field: undefined }]
								: malformed === "a missing key"
									? [heading, missing, { fault: "factShape", field: undefined }]
									: malformed === "a misspelt key"
										? [
												heading,
												{ ...missing, ratoi: fact.ratio },
												{ fault: "factShape", field: "ratio" }
											]
										: malformed === "an array"
											? [heading, [fact], { fault: "factShape", field: undefined }]
											: malformed === "null"
												? [heading, null, { fault: "factShape", field: undefined }]
												: malformed === "a real past the range"
													? [
															heading,
															{ ...fact, ratio: binary32Max * 2 },
															{ fault: "realInexact", field: "ratio" }
														]
													: malformed === "a real no binary32 value holds"
														? [
																heading,
																{
																	...fact,
																	ratio: fact.ratio === 0 ? 0.1 : fact.ratio * (1 + Number.EPSILON)
																},
																{ fault: "realInexact", field: "ratio" }
															]
														: malformed === "an amount past the scale"
															? [
																	heading,
																	{
																		...fact,
																		amount: Decimal.of(`${drawnFact.cents}${fraction}e-3`)
																	},
																	{ fault: "numericScale", field: "amount" }
																]
															: malformed === "an amount past the precision"
																? [
																		heading,
																		{
																			...fact,
																			amount: Decimal.of(
																				`1e${amountType.precision - amountType.scale + digits}`
																			)
																		},
																		{ fault: "numericOverflow", field: "amount" }
																	]
																: [
																		duplicated,
																		extra ? { ...fact, extra: 1 } : fact,
																		{ fault: "factShape", field: undefined }
																	]
						assert.deepEqual(factIdentity(h, value), Result.err(refusal))
					}),
			oracle: {
				kind: "specification",
				name: "a fact's shape against its heading, and each field's carrier fault, named by its field"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/values/identity.ts",
					original: "\t\t\treturn Result.err({ fault: value.error, field: field.name })",
					replacement: "\t\t\treturn Result.err({ fault: value.error, field: undefined })",
					why: "A field's fault names no field; the refusal property fails."
				}
			]
		}
	)
