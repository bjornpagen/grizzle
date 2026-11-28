/**
 * PostgreSQL's equality on the host (scalar/compute/evaluate.ts comparison, staged once where its expression compiles):
 * `=`, `<>` and IN of two values of one type agree with the type's order, equal exactly where it orders them 0
 * (scalar/values/identity.ts compareValues), and over a carrier equal by identity (identity.ts equalByIdentity), an
 * integer, a text and a closed id among them, they read no order at all: a closed id's equality ranks no handle and a
 * text's compares no code point.
 *
 * The count is work, never time: V8's precise coverage counts each function's calls (kernel/calls.ts callCounts), the
 * order's here. Box: every two values of one type of the dictionary, each of the three comparisons; the dictionary
 * holds integers, a bigint, texts that share a prefix, a closed id of each handle of its roster, booleans, uuids, and
 * double precision values with NaN, which PostgreSQL's order takes as equal to itself and the host's identity as equal
 * to nothing, so its equality is its order's.
 *
 * Oracle: the type's order (compareValues), a second reading of equality: a value equals another exactly where the
 * order of the two is 0.
 *
 * Features: each comparison equal and unequal; a type equal by identity and one equal by its order.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite, oneOf } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { comparisonHolds, evaluatorOrder } from "#compiler/scalar/compute/evaluate.ts"
import { compareValues, type HostValue, hostOf } from "#compiler/scalar/values/identity.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { T } from "#test/support/unit/lower/conservative/fixtures.ts"

/**
 * A type of the dictionary, with values of it and how its equality is decided: by its values' identity, each value one
 * host value, or by its order.
 */
interface Typed {
	readonly name: string
	readonly type: ScalarType
	readonly values: Arr.NonEmptyReadonlyArray<HostValue>
	readonly equality: "identity" | "order"
}

/** The dictionary: each type with a few of its values, equal ones among every two drawn. */
const dictionary: Arr.NonEmptyReadonlyArray<Typed> = [
	{ name: "int4", type: T.int4, values: [0, 1, -1], equality: "identity" },
	{ name: "int8", type: T.int8, values: [0n, 7n, -7n], equality: "identity" },
	{ name: "text", type: T.text, values: ["", "a", "ab", "b"], equality: "identity" },
	{ name: "closed id", type: T.kind, values: ["Automatic", "Manual"], equality: "identity" },
	{ name: "bool", type: T.bool, values: [true, false], equality: "identity" },
	{
		name: "uuid",
		type: T.uuid,
		values: ["018f0000-0000-7000-8000-000000000000", "018f0000-0000-7000-8000-000000000001"],
		equality: "identity"
	},
	{
		name: "float8",
		type: T.float8,
		values: [Number.NaN, 0, 1.5, Number.POSITIVE_INFINITY],
		equality: "order"
	}
]

/** The comparisons an equality decides. */
type Equality = "eq" | "ne" | "in"

/** A case: a type of the dictionary, two of its values, and a comparison of them. */
interface EqualityCase {
	readonly typed: Typed
	readonly a: HostValue
	readonly b: HostValue
	readonly op: Equality
}

const space = finite(
	oneOf(
		Arr.map(dictionary, (typed) => (source): EqualityCase => ({
			typed,
			a: source.draw(element(typed.values)),
			b: source.draw(element(typed.values)),
			op: source.draw(element<Equality>(["eq", "ne", "in"]))
		}))
	)
)

type EqualityFeature =
	| `${Equality} of equal values`
	| `${Equality} of unequal values`
	| "a type equal by identity"
	| "a type equal by its order"

/** The order whose calls are an equality's work. */
const orderSites = Object.freeze({
	order: { file: "packages/engine/src/scalar/values/identity.ts", name: "compareValues" }
})

/** An equality of two values agrees with their type's order, and of a carrier equal by identity reads no order. */
export const anEqualityOfTwoValuesAgreesWithTheirTypesOrderAndOfACarrierEqualByIdentityReadsNoOrder =
	property.exhaust(space, {
		needs: {},
		situations: [
			"eq of equal values",
			"eq of unequal values",
			"ne of equal values",
			"ne of unequal values",
			"in of equal values",
			"in of unequal values",
			"a type equal by identity",
			"a type equal by its order"
		] satisfies ReadonlyArray<Reached<EqualityFeature>>,
		check:
			(_, k: Case<EqualityFeature>) =>
			({ typed, a, b, op }: EqualityCase) =>
				Effect.gen(function* () {
					const order = evaluatorOrder(typed.type)
					const equal =
						compareValues(order, hostOf(order.carrier, a), hostOf(order.carrier, b)) === 0
					const [holds, counts] = yield* callCounts(
						Effect.sync(() => comparisonHolds(op, [a, b], typed.type)),
						orderSites
					)
					assert.equal(
						holds,
						op === "ne" ? !equal : equal,
						`${op} of ${Formatter.format(a)} and ${Formatter.format(b)} of ${typed.name}, its order ${equal ? "0" : "not 0"}`
					)
					if (typed.equality === "identity") {
						assert.equal(
							counts.order,
							0,
							`${op} over ${typed.name}, equal by identity, reads no order`
						)
					}
					k.note(`${op} of ${equal ? "equal" : "unequal"} values`)
					k.note(
						typed.equality === "identity" ? "a type equal by identity" : "a type equal by its order"
					)
				}),
		oracle: {
			kind: "second-implementation",
			name: "the type's order (identity.ts compareValues): a value equals another exactly where their order is 0"
		},
		box: "every two values of one type of the dictionary (int4, int8, text, a closed id, bool, uuid, float8 with NaN), each of =, <> and IN",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original: "\tcode: true,",
				replacement: "\tcode: false,",
				why: "A closed id's equality reads its roster's order, ranking both handles at every comparison, where their identity decides it: the count of the order's calls over a closed id is past 0."
			},
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original: "\tfloat8: false,",
				replacement: "\tfloat8: true,",
				why: "A double's equality is its host identity, so NaN equals no value, itself among them, where PostgreSQL's order takes NaN as equal to itself: = of NaN and NaN is false against the order's 0."
			}
		]
	})
