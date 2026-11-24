/** What the properties of unions.test.ts read: its spaces, models and helpers. */

import { aimed, type Aimed } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import {
	attachedWidenedCaseGen,
	keyedOrderCaseGen,
	keyedOverCommon,
	type UnionCase,
	unionCaseGen,
	type UnionRule,
	verdictOf
} from "#test/unit/check/unions.ts"

/** What a case reached: the rule a refusal enforced, or the shape of what the checker admitted. */
export type UnionFeature =
	| UnionRule
	| "one heading"
	| "several headings told apart by Kind"
	| "several headings told apart by every literal column"
	| "a widened column"
	| "an attached arm admitted"
	| "a keyed order over several headings"
	| "an order over several headings, each group by its own key"
	| "a match narrowed to some arms"
	| "a set column beside a discriminant of Kind"

export const rules: Arr.NonEmptyReadonlyArray<UnionRule> = [
	"an attachment on a shared heading",
	"incompatible column types",
	"an attached arm widened",
	"no discriminant",
	"constants no arm delivers",
	"a column the selected arms lack"
]

/** The admitted shapes a case reached, read off the model's verdict and the case. */
export const admittedFeatures = (
	c: UnionCase,
	v: Extract<ReturnType<typeof verdictOf>, { readonly kind: "admitted" }>
): ReadonlyArray<UnionFeature> => [
	...(v.groups === 1 ? ["one heading" as const] : []),
	...(v.chosen === "of Kind" ? ["several headings told apart by Kind" as const] : []),
	...(v.chosen === "of every literal column"
		? ["several headings told apart by every literal column" as const]
		: []),
	...(v.widened ? ["a widened column" as const] : []),
	...(Arr.some(c.arms, (a) => a.attached) ? ["an attached arm admitted" as const] : []),
	...((c.consumer.kind === "ordered" || c.consumer.kind === "taken") && v.groups > 1
		? [
				keyedOverCommon(c, v.heading)
					? ("a keyed order over several headings" as const)
					: ("an order over several headings, each group by its own key" as const)
			]
		: []),
	...(v.narrowed ? ["a match narrowed to some arms" as const] : []),
	...(v.chosen === "of Kind" && Arr.contains(v.heading, "marks")
		? ["a set column beside a discriminant of Kind" as const]
		: [])
]

/**
 * The union cases, aimed at the two situations a free draw seldom reaches: an attached arm widened, and a keyed order
 * over several headings.
 */
export const unionCaseSpace: Aimed<UnionCase, UnionFeature> = aimed(unionCaseGen, [
	["an attached arm widened", attachedWidenedCaseGen],
	["a keyed order over several headings", keyedOrderCaseGen]
])
