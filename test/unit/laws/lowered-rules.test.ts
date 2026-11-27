import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { compileInstallation, conservativeInstallation } from "#compiler/program/install.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	KEYS,
	caseSpace,
	type Shape,
	brokenConditions,
	schemaOf,
	compiled,
	assertTriggerLaws,
	ruleLaw,
	assertKept,
	assertLowered,
	levelGen,
	levelSchemaOf,
	type LevelFeature
} from "#test/unit/laws/lowered-rules.fixtures.ts"

/** A containment into a key-shaped conjunction of stored relations lowers to one deferred foreign key per match exactly when its definition meets the seven conditions, and the conservative installation keeps the rule for the judge under the same law. Its budget is its suite's before it was a property (test/unit/laws/lowered-rules.test.ts at 4ca3036a): 400 runs and 400 steered cases. */
export const aContainmentIntoAKeyShapedConjunctionOfStoredRelationsLowersToOneDeferredForeignKeyPerMatchExactlyWhenItsDefinitionMeetsTheSevenConditionsAndTheConservativeInstallationKeepsTheRuleForTheJudgeUnderTheSameLaw =
	property.explore(caseSpace, {
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: [
			"lowered",
			"kept",
			"two matches",
			"a constant column",
			"a superkey's UNIQUE",
			["lowered", "two matches"],
			["lowered", "a constant column"],
			["lowered", "a superkey's UNIQUE"],
			"condition 1",
			"condition 2",
			"condition 3",
			"condition 4",
			"condition 5",
			"condition 6",
			"condition 7",
			"the level rule"
		] satisfies ReadonlyArray<Reached<Shape>>,
		check: (_, k: Case<Shape>) => (c) =>
			Effect.sync(() => {
				const broken = brokenConditions(c)
				const desc = schemaOf(c)
				const lowered = succeeded(compiled(desc, compileInstallation))
				const conservative = succeeded(compiled(desc, conservativeInstallation))
				const law = ruleLaw(lowered)
				assert.equal(ruleLaw(conservative), law, "both installations name the rule by one law")
				assertKept(c, conservative, law)
				if (c.matches.length > 1) {
					k.note("two matches")
				}
				const [only, ...more] = broken
				if (only !== undefined && more.length === 0) {
					k.note(only)
				}
				assertTriggerLaws(c, desc, law, only !== undefined)
				if (only !== undefined) {
					k.note("kept")
					assertKept(c, lowered, law)
					return
				}
				k.note("lowered")
				if (c.matches.length > 1) {
					k.pair("lowered", "two matches")
				}
				for (const shape of assertLowered(c, lowered, law)) {
					k.note(shape)
					k.pair("lowered", shape)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the seven conditions restated over the drawn definition, and the catalog of foreign keys, UNIQUEs, constant columns and captures each implies"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/laws/lowered-rules.test.ts#aContainmentIntoAKeyShapedConjunctionOfStoredRelationsLowersToOneDeferredForeignKeyPerMatchExactlyWhenItsDefinitionMeetsTheSevenConditionsAndTheConservativeInstallationKeepsTheRuleForTheJudgeUnderTheSameLaw:-:1.2.1.1.0.0.3.0.0.0.3.0.2.0.0.0.0"
				),
				reason:
					"Two matches of R1 keyed by id, each binding id to the first head term: R1(id = x, a = y, k = v) and R1(id = x, a = v, k = 7), v fixed to a literal by a condition. Both lower to a foreign key from S into R1 over (id, a, k), from (x, y, the constant of v) and from (x, the constant of v, the constant of 7), so a match's key told by its target, its leading paired column and its referenced columns alone was either; the oracle took the first match's key for the second's and read y as its constant column (TEST_SEED=2391469403, rotating case 92)",
				since: "2026-11-15"
			}
		],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/laws.ts",
				original: "\t\tif ([...existentials.values()].some((n) => n > 1)) {",
				replacement: "\t\tif ([...existentials.values()].some((n) => n > 2)) {",
				why: "Condition 4 ignored for a variable of their own two matches share (analysis/theory/laws.ts lowering); the lowering box fails."
			}
		]
	})

/** A containment across levels reaches a relation of the other level exactly through a side holding a key it declares, selected by constants or not, from a source above it or below it. */
export const aContainmentAcrossLevelsReachesARelationOfTheOtherLevelExactlyThroughASideHoldingAKeyItDeclaresSelectedByConstantsOrNotFromASourceAboveItOrBelowIt =
	property.exhaust(finite(levelGen), {
		needs: {},
		situations: ["admitted", "refused", "a superkey", "constants"] satisfies ReadonlyArray<
			Reached<LevelFeature>
		>,
		check: (_, k: Case<LevelFeature>) => (c) =>
			Effect.sync(() => {
				const held = [...c.terms, ...c.fixed]
				const keyed = Arr.some(KEYS.R0, (key) => Arr.every(key, (field) => held.includes(field)))
				const admitted = keyed
				if (c.fixed.length > 0) {
					k.note("constants")
				}
				if (
					keyed &&
					!Arr.some(
						KEYS.R0,
						(key) => key.length === held.length && Arr.every(key, (field) => held.includes(field))
					)
				) {
					k.note("a superkey")
				}
				const result = compiled(levelSchemaOf(c), compileInstallation)
				k.note(admitted ? "admitted" : "refused")
				if (admitted) {
					succeeded(result)
					return
				}
				assert.ok(
					!result.ok && result.error.reason._tag === "LevelRefused",
					"the containment is LevelRefused"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the level rule: a side whose fields and constants hold a key R0 declares, from a source above it or below it, its constants columns of the source's table"
		},
		box: "every target side of R0 over one to three of its fields, selected by constants on any of the others, from S on the level above R0 and on the level below it",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/own.ts",
				original: "(target !== undefined || !fieldSide(d.left, source) || !keyed)",
				replacement:
					"(target !== undefined || d.right.selection.conjuncts.length > 0 || !fieldSide(d.left, source) || !keyed)",
				why: "A source on the level below refused into a selected target, its constants columns of the lower table (schema/own.ts checkLevels); the level rule's box fails."
			}
		]
	})
