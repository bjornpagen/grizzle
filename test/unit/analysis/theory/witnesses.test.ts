/**
 * The witnesses of a rule over a query (analysis/theory/query.ts witnesses) are the shapes its violation takes, by the
 * occurrences of the relations it reads, and they name exactly the writes its triggers fire on (query.ts touches,
 * physical/ddl/rules.ts eventsOf), which the isolation certifier reads them for (analysis/isolation/certify.ts laws).
 *
 * The box: rules of each kind, a check, a containment and a key, drawn as their arms over three relations, R0 to R2,
 * one or two breaking arms and, for a containment, one or two target arms, each arm one to three matches, so one
 * relation may stand twice in an arm (a self-join), and none to two negated arms of one or two matches each, each
 * negating none or one arm of one or two matches in turn, a match under two negations.
 *
 * Oracle: the drawn plan itself, read apart from query.ts:
 *
 * - Witnesses: a check has one per breaking arm, its rows the arm's matches, every occurrence, its absences its negated
 *   arms' matches, its presences the matches under two negations; a containment one per source arm, its rows the arm's
 *   matches, its absences the arm's negated matches then every target arm's matches and its matches under two
 *   negations, its presences every target arm's negated matches then the arm's matches under two negations; a key one
 *   per pair of breaking arms, an arm with itself and with every later arm, its rows both arms' matches, its absences
 *   both arms' negated matches, its presences both arms' matches under two negations. Each list is a multiset in the
 *   plan's order, so an occurrence counted once for two fails.
 * - Touches agreement: for each relation, an INSERT of it can break the rule (Touches `added` or `both`) exactly when it
 *   stands among some witness's rows or presences, and a DELETE (`removed` or `both`) exactly when it stands among some
 *   witness's absences; neither when no witness reads it, where touches gives none.
 *
 * Features: each rule kind; a match, a negated match, a match under two negations, a target match, a target negation
 * and a target's match under two negations; a self-join; a relation both inserted and deleted into breaking (`both`);
 * and a relation the rule never reads.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { touches, witnesses } from "#compiler/analysis/theory/query.ts"
import {
	byName,
	expectedWitnesses,
	type Feature,
	type Named,
	nameOf,
	planGen,
	RELATIONS,
	ruleOf
} from "#test/unit/analysis/theory/witnesses.fixtures.ts"

/**
 * A rule over a query's witnesses are the shapes its arms give its violation, every occurrence counted, and name
 * exactly the writes its triggers fire on.
 *
 * Budget: 200 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/theory/witnesses.test.ts:191 at 8cad5bce, its runs and its coverage's cases).
 */
export const aRuleOverAQuerysWitnessesAreTheShapesItsArmsGiveItsViolationEveryOccurrenceCountedAndNameExactlyTheWritesItsTriggersFireOn =
	property.explore(planGen, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: [
			"a check",
			"a contained",
			"a key",
			"a match",
			"a negated match",
			"a match under two negations",
			"a target match",
			"a target negation",
			"a target's match under two negations",
			"a self-join",
			"a relation an insert and a delete can both break",
			"a relation the rule never reads"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, k: Case<Feature>) => (plan) =>
			Effect.sync(() => {
				k.note(`a ${plan.kind}`)
				k.note("a match")
				if (Arr.some(plan.arms, (a) => a.negated.length > 0)) {
					k.note("a negated match")
				}
				if (Arr.some(plan.arms, (a) => Arr.some(a.negated, (n) => n.negated.length > 0))) {
					k.note("a match under two negations")
				}
				if (plan.kind === "contained") {
					k.note("a target match")
					if (Arr.some(plan.target, (a) => a.negated.length > 0)) {
						k.note("a target negation")
					}
					if (Arr.some(plan.target, (a) => Arr.some(a.negated, (n) => n.negated.length > 0))) {
						k.note("a target's match under two negations")
					}
				}
				if (Arr.some(plan.arms, (a) => new Set(a.matches).size < a.matches.length)) {
					k.note("a self-join")
				}
				const rule = ruleOf(plan)
				const ws = witnesses(rule)
				const actual: ReadonlyArray<Named> = Arr.map(ws, byName)
				const expected: ReadonlyArray<Named> = Arr.map(expectedWitnesses(plan), (w) => ({
					rows: Arr.map(w.rows, nameOf),
					present: Arr.map(w.present, nameOf),
					absent: Arr.map(w.absent, nameOf)
				}))
				assert.deepEqual(actual, expected, "the witnesses, every occurrence")
				for (let r = 0; r < RELATIONS; r += 1) {
					const name = nameOf(r)
					const added = Arr.some(ws, (w) => w.rows.includes(name) || w.present.includes(name))
					const withdrawn = Arr.some(ws, (w) => w.absent.includes(name))
					const t = touches(rule, name, { kind: "none" })
					assert.equal(
						t !== undefined && (t.kind === "added" || t.kind === "both"),
						added,
						`an INSERT of ${name} can break the rule exactly where a witness reads it as a row or a presence`
					)
					assert.equal(
						t !== undefined && (t.kind === "removed" || t.kind === "both"),
						withdrawn,
						`a DELETE of ${name} can break the rule exactly where a witness reads it as an absence`
					)
					if (t === undefined) {
						k.note("a relation the rule never reads")
					} else if (t.kind === "both") {
						k.note("a relation an insert and a delete can both break")
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the drawn plan's arms read as a rule's violation shapes, and Touches"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					'\t\t...breaking.flatMap((a) => occurrencesOf(breaking, a, "positive", undefined, relation, memo)),\n',
				replacement: "",
				why: "A write that adds or removes a breaking arm's facts read as breaking nothing (query.ts ruleOccurrences, probedTouches): its matches' writes are never captured."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					'const flipped = (p: Polarity): Polarity => (p === "positive" ? "negative" : "positive")',
				replacement:
					'const flipped = (p: Polarity): Polarity => (p === "positive" ? "negative" : "negative")',
				why: "A negation under a negation read negatively, as one negation is: a relation under two negations, whose insert brings back the breaking facts its row held out, is read as an absence."
			}
		]
	})
