/**
 * Unions (check/checker.ts): a union of one to three arms over a drawn schema, delivered, ordered, taken or matched, is
 * admitted exactly where the union rules admit it, with the heading, the discriminant and the widening they give, and
 * refused otherwise for the rule it breaks: an attachment on a shared heading, incompatible column types, an attached
 * arm widened, no discriminant, constants no arm delivers, or a column the selected arms lack. An order over several
 * headings refuses nothing: it is completed by the union's key where the common columns hold one, else group by group.
 *
 * Oracle: the union rules restated over the drawn arms (test/unit/check/unions.ts verdictOf).
 *
 * Features: each rule refused, and each admitted shape: one heading, headings told apart by Kind or by every literal
 * column, a widened column, an attached arm, a keyed order, an order each group completes by its own key, a narrowed
 * match, a set beside a discriminant of Kind.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { topoOrder } from "#compiler/ir/dag.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { checkAuthored, checking, checkOptions } from "#test/support/policy.ts"
import { schemaDescOf } from "#test/unit/check/drawn.ts"
import {
	admittedFeatures,
	rules,
	unionCaseSpace,
	type UnionFeature
} from "#test/unit/check/unions.fixtures.ts"
import { caseDesc, verdictOf } from "#test/unit/check/unions.ts"

/** A union of rules is grouped by heading, typed per column, told apart by its discriminant, ordered group by group and narrowed by a match's constants, as the model of its rules decides. Its budget is its suite's before it was a property (test/unit/check/unions.test.ts at 4ca3036a): 400 runs and 1200 steered cases. */
export const aUnionOfRulesIsGroupedByHeadingTypedPerColumnToldApartByItsDiscriminantOrderedGroupByGroupAndNarrowedByAMatchsConstantsAsTheModelOfItsRulesDecides =
	property.explore(unionCaseSpace, {
		needs: {},
		budget: { runs: 400, steered: 1200 },
		situations: [
			...rules,
			"one heading",
			"several headings told apart by Kind",
			"several headings told apart by every literal column",
			"a widened column",
			"an attached arm admitted",
			"a keyed order over several headings",
			"an order over several headings, each group by its own key",
			"a match narrowed to some arms",
			"a set column beside a discriminant of Kind"
		] satisfies ReadonlyArray<Reached<UnionFeature>>,
		check: (_, k: Case<UnionFeature>) => (c) =>
			Effect.sync(() => {
				const v = verdictOf(c)
				const result = checkAuthored(
					checking(schemaDescOf(c.schema)),
					caseDesc(c),
					checkOptions("unions")
				)
				if (v.kind === "refused") {
					k.note(v.rule)
					refused(result, v.reason, v.rule)
					return
				}
				k.noteAll(admittedFeatures(c, v))
				const q = succeeded(result, "the union the model admits")
				if (c.consumer.kind === "matched" || c.arms.length === 1) {
					return
				}
				const union = Arr.findFirst(topoOrder(q.dag), (n) => n.kind === "Union")
				assert.deepEqual(
					Option.match(union, {
						onNone: () => ({ groups: 1, discriminant: [] }),
						onSome: (n) => ({ groups: n.groups.length, discriminant: n.discriminant })
					}),
					{ groups: v.groups, discriminant: v.discriminant },
					"the union's heading groups and discriminant"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the union rules restated over the drawn arms (test/unit/check/unions.ts)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\t\t\tif (discriminant.length === 0 || clash) {",
				replacement: "\t\t\tif (discriminant.length === 0) {",
				why: "Discriminant literals that do not tell the heading groups apart are admitted (check/checker.ts union); the property fails."
			}
		]
	})
