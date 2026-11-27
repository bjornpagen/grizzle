/**
 * A derived relation's columns hold the dependency a relation's key gives them where every rule of its definition draws
 * them, jointly, from one row of that relation or of one its declared containments carry into it, and only there
 * (analysis/derived/drawn.ts viewDependencies): a view whose every rule draws a learner and a number from an assignment,
 * keyed by its number, or from an event of it, contained in its assignment, has its number determine its learner, as
 * metis's stored AssignmentStatus does, so a read of it at a sitting's number seeks the key prefix (child, number); a view
 * one of whose rules draws them from loose marks, which no number keys, has no such dependency, though every other rule's
 * rows hold it: two rules' rows may agree on a number and differ in the learner.
 *
 * The box, exhausted: each view of one or two rules over an assignment, an event and a loose mark
 * (view-dependencies.fixtures.ts).
 *
 * Oracle: specification, the number determines the learner exactly where every rule is keyed.
 *
 * Features: every rule keyed or a rule unkeyed, of one rule or two.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	boxGen,
	dependenciesOf,
	everyRuleKeyed,
	type Feature,
	type UnionFeature,
	unionDraws,
	unionGen
} from "#test/unit/analysis/derived/view-dependencies.fixtures.ts"

/** A view's number determines its learner exactly where every rule draws them from a relation a number keys. */
export const aViewsNumberDeterminesItsLearnerExactlyWhereEveryRuleDrawsThemFromAKeyedRow =
	property.exhaust(finite(boxGen), {
		needs: {},
		situations: [
			"every rule keyed, 1 rules",
			"every rule keyed, 2 rules",
			"a rule unkeyed, 1 rules",
			"a rule unkeyed, 2 rules"
		] satisfies ReadonlyArray<Feature>,
		check: (_, k: Case<Feature>) => (box) =>
			Effect.sync(() => {
				const keyed = everyRuleKeyed(box)
				k.note(
					`${keyed ? "every rule keyed" : "a rule unkeyed"}, ${box.sources.length === 1 ? 1 : 2} rules`
				)
				const determined = Arr.some(
					dependenciesOf(box),
					(d) => Arr.join(d.by, ",") === "number" && d.fields.includes("child")
				)
				assert.equal(
					determined,
					keyed,
					`${Formatter.format(box.sources)}: the view's number ${determined ? "determines" : "does not determine"} its learner`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the view's number determines its learner exactly where every rule draws them from an assignment or an event of it"
		},
		box: "each view of one or two rules, each drawing a learner and a number from an assignment, an event of it or a loose mark",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/derived/analyze.ts",
				original: "\t\t\t\t\tread: { heading, keys, determined: viewDependencies(owned, root) }\n",
				replacement: "\t\t\t\t\tread: { heading, keys, determined: [] }\n",
				why: "A view's columns inherit no containment: a view of a sitting's status, every rule of which draws its learner and its number from an assignment or an event of it, holds no dependency of its learner on its number, and a read of it at a number is keyed by nothing."
			},
			{
				file: "packages/engine/src/analysis/derived/drawn.ts",
				original: "\t\t\tconst [first, ...rest] = unionArms(node.groups)\n",
				replacement:
					"\t\t\treturn unionArms(node.groups).flatMap((arm) => drawn(arm, drawing))\n\t\t\tconst [first, ...rest] = unionArms(node.groups)\n",
				why: "A union draws what any arm draws: a view one of whose rules reads loose marks inherits its keyed rule's containment, and its number determines its learner where two rules' rows may differ in the learner at one number."
			},
			{
				file: "packages/engine/src/analysis/derived/drawn.ts",
				original: "\t\tfor (const c of containments.get(at.relation) ?? []) {\n",
				replacement: '\t\tfor (const c of containments.get("") ?? []) {\n',
				why: "No declared containment carries a draw into its target: an event's learner and number are drawn from the event alone, which no number keys, and a view over events and assignments loses the dependency its every rule holds."
			}
		]
	})

/**
 * A union's draws are a set, one for each relation and columns it draws from, however many arms meet them and however
 * many paths each arm reaches a relation by (analysis/derived/drawn.ts drawSet): a union of `arms` arms, each reading
 * the root's value through `paths` relations contained in the root, draws the root once and each relation once, `paths`
 * + 1 draws, where draws differing only in the containments they ride on multiplied across the arms, paths^arms of the
 * root's, and a 4-arm union of metis's ops role held 6,098 draws, 34 distinct, its compile out of memory.
 *
 * The box, exhausted: unions of one to six arms, each over one to three paths.
 *
 * Oracle: specification, the distinct draws, `paths` + 1.
 *
 * Features: one arm or several, over one path or several.
 */
export const aUnionsDrawsAreItsDistinctDrawsWhateverItsArmsAndPaths = property.exhaust(
	finite(unionGen),
	{
		needs: {},
		situations: [
			"one arm, one path",
			"one arm, several paths",
			"several arms, one path",
			"several arms, several paths"
		] satisfies ReadonlyArray<UnionFeature>,
		check: (_, k: Case<UnionFeature>) => (box) =>
			Effect.sync(() => {
				k.note(
					`${box.arms === 1 ? "one arm" : "several arms"}, ${box.paths === 1 ? "one path" : "several paths"}`
				)
				const draws = unionDraws(box)
				assert.equal(
					draws.length,
					box.paths + 1,
					`${Formatter.format(box)}: the union draws ${Arr.join(draws, "; ")}`
				)
				assert.equal(new Set(draws).size, draws.length, `${Formatter.format(box)}: each draw once`)
			}),
		oracle: {
			kind: "specification",
			name: "the union draws the root and each relation it reads once, paths + 1 draws, at any number of arms"
		},
		box: "unions of one to six arms, each reading a root's value through one to three relations contained in it",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/derived/drawn.ts",
				original: "const drawSet = (draws: ReadonlyArray<Draw>): ReadonlyArray<Draw> => {\n",
				replacement:
					"const drawSet = (draws: ReadonlyArray<Draw>): ReadonlyArray<Draw> => {\n\treturn draws\n",
				why: "Draws are a list again: a union meets each arm's draws of the root, one per path, with every one its arms before kept, paths^arms draws of one root, and a union of many arms over many paths runs its compile out of memory."
			}
		]
	}
)
