/**
 * The closed monoids (ir/monoid.ts): each one's combine and identity against the monoid laws, and its carriers.
 *
 * - The laws, universal: from the identity, one step is the step's value alone; two steps commute, so a fold over a
 *   counted family, whose order is hidden, has one value, for every monoid that says it is commutative; concat's two
 *   steps are one step of their concatenation, its associativity, and the box holds two steps it does not commute,
 *   so its flag is no lie; or's step is idempotent; and twos holds, after two steps, the codes both of them set (the
 *   two-plane model), so a set stepped twice is twice.
 * - The combine is evaluated over host values: bigints for count, sum and max over natural, Sets of handles for or and
 *   twos, handles in roster order for max over a closed id, and strings for concat.
 * - `admits`, against the validators its construction must pass, over every generated field type: a monoid admits a
 *   carrier exactly when its identity there is one value of the carrier per plane (literalProblem) and the CHECK that
 *   proves its combine types over it (check/fold.ts combineRule), but count, which reads no step value and counts in
 *   natural alone.
 *
 * The box, exhausted: accumulators and steps over naturals 0 to 4, over every subset of a five-code roster with a
 * hole (a twos state's twos plane within its ones plane, as every fold's is), over its live codes, and over five texts:
 * the empty text, two letters, their concatenation and a supplementary-plane character.
 *
 * Features: every monoid's laws, and concat's two steps that do not commute; every monoid admitting and refusing.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { aimed, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { monoidNames } from "#compiler/ir/desc.ts"
import { monoidSpecs } from "#compiler/ir/monoid.ts"
import {
	admitsCaseGen,
	type AdmitsFeature,
	admitsAims,
	constructs,
	isNatural,
	isPgNumeric,
	laws,
	type LawCase,
	patterns
} from "#test/unit/ir/monoid.fixtures.ts"

/** The closed monoids keep the monoid laws on every admitted carrier. */
export const theClosedMonoidsKeepTheMonoidLawsOnEveryAdmittedCarrier = property.exhaust(
	finite(patterns),
	{
		needs: {},
		situations: [
			"count",
			"sum",
			"or",
			"twos",
			"maxNatural",
			"maxCode",
			"concat",
			"concat noncommuting"
		] satisfies ReadonlyArray<Reached<LawCase["monoid"] | "concat noncommuting">>,
		check: (_, c: Case<LawCase["monoid"] | "concat noncommuting">) => (value) => laws(value, c),
		oracle: { kind: "universal", name: "the monoid laws and the two-plane model" },
		box: "naturals 0 to 4, every subset of a five-code roster with a hole, its live codes, five texts",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/monoid.ts",
				original: "\tcommutative: false,",
				replacement: "\tcommutative: true,",
				why: "concat claims to commute, so the laws' two steps it does not commute break its flag."
			}
		]
	}
)

/**
 * The closed monoids admit exactly the carriers whose identity and combine their validators admit, count natural
 * alone.
 *
 * Budget: 400 runs and 2000 steered cases, what its suite stated before it became a property
 * (test/unit/ir/monoid.test.ts:328 at 8cad5bce, its runs and its coverage's cases).
 */
export const theClosedMonoidsAdmitExactlyTheCarriersWhoseIdentityAndCombineTheirValidatorsAdmitCountNaturalAlone =
	property.explore(aimed(admitsCaseGen, admitsAims), {
		needs: {},
		budget: { runs: 400, steered: 2000 },
		situations: [
			...Arr.flatMap(monoidNames, (name): Arr.NonEmptyReadonlyArray<AdmitsFeature> => [
				`${name} admits`,
				`${name} refuses`
			]),
			"sum admits numeric"
		] satisfies ReadonlyArray<Reached<AdmitsFeature>>,
		check:
			(_, c: Case<AdmitsFeature>) =>
			([name, carrier]) =>
				Effect.sync(() => {
					const spec = monoidSpecs[name]
					const admitted = spec.admits(carrier)
					c.note(`${name} ${admitted ? "admits" : "refuses"}`)
					if (admitted && name === "sum" && isPgNumeric(carrier)) {
						c.note("sum admits numeric")
					}
					if (admitted) {
						assert.ok(
							constructs(spec, carrier) && (spec.step === "value" || isNatural(carrier)),
							`${name} constructs over what it admits`
						)
						return
					}
					assert.ok(
						spec.step === "none" ? !isNatural(carrier) : !constructs(spec, carrier),
						`${name} refuses only a carrier its construction has no valid identity or combine over`
					)
				}),
		oracle: {
			kind: "second-implementation",
			name: "the literal validator and the combine's CHECK typing over the monoid's construction"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/monoid.ts",
				original: '\t\tcase "money":\n\t\t\treturn { kind: "money"',
				replacement: '\t\tcase "money":\n\t\tcase "numeric":\n\t\t\treturn { kind: "money"',
				why: "max admits a numeric, which has no least value to start from; `admits` disagrees with the validators."
			},
			{
				file: "packages/engine/src/ir/monoid.ts",
				original:
					'const summable = (t: ScalarType): boolean => {\n\tswitch (baseOf(t).carrier) {\n\t\tcase "int2":\n\t\tcase "int4":\n\t\tcase "int8":\n\t\tcase "numeric":\n\t\t\treturn true',
				replacement:
					'const summable = (t: ScalarType): boolean => {\n\tconst base = baseOf(t)\n\tswitch (base.carrier) {\n\t\tcase "int2":\n\t\tcase "int4":\n\t\tcase "int8":\n\t\t\treturn true\n\t\tcase "numeric":\n\t\t\treturn base.typmod !== undefined',
				why: "sum refuses numeric of no typmod, numeric's, whose identity its literal validator and whose combine its CHECK admit: summable as it stood before numeric was a declared type."
			}
		]
	})
