/**
 * The witnesses of a rule over a query (analysis/theory/query.ts witnesses) are the shapes its violation takes, by the
 * occurrences of the relations it reads, and they name exactly the writes its triggers fire on (query.ts touches,
 * physical/ddl/rules.ts eventsOf), which the isolation certifier reads them for (analysis/isolation/certify.ts laws).
 *
 * The box: rules of each kind, a check, a containment and a key, drawn as their arms over three relations, R0 to R2,
 * one or two breaking arms and, for a containment, one or two target arms, each arm one to three matches, so one
 * relation may stand twice in an arm (a self-join), and none to two negated arms of one or two matches each.
 *
 * Oracle: the drawn plan itself, read apart from query.ts:
 *
 * - Witnesses: a check has one per breaking arm, its rows the arm's matches, every occurrence, its absences its negated
 *   arms' matches; a containment one per source arm, its rows the arm's matches, its absences the arm's negated
 *   matches then every target arm's matches, its presences every target arm's negated matches; a key one per pair of
 *   breaking arms, an arm with itself and with every later arm, its rows both arms' matches, its absences both arms'
 *   negated matches. Each list is a multiset in the plan's order, so an occurrence counted once for two fails.
 * - Touches agreement: for each relation, an INSERT of it can break the rule (Touches `news` or `both`) exactly when it
 *   stands among some witness's rows or presences, and a DELETE (`olds` or `both`) exactly when it stands among some
 *   witness's absences; neither when no witness reads it, where touches gives none.
 *
 * Features: each rule kind; a match, a negated match, a target match and a target negation; a self-join; a relation
 * both inserted and deleted into breaking (`both`); and a relation the rule never reads.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { touches, witnesses } from "#compiler/analysis/theory/query.ts"
import { assert } from "#test/support/assert.ts"
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

/** A rule over a query's witnesses are the shapes its arms give its violation, every occurrence counted, and name exactly the writes its triggers fire on. */
export const aRuleOverAQuerysWitnessesAreTheShapesItsArmsGiveItsViolationEveryOccurrenceCountedAndNameExactlyTheWritesItsTriggersFireOn =
	property.explore(planGen, {
		needs: {},
		situations: [
			"a check",
			"a contained",
			"a key",
			"a match",
			"a negated match",
			"a target match",
			"a target negation",
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
				if (plan.kind === "contained") {
					k.note("a target match")
					if (Arr.some(plan.target, (a) => a.negated.length > 0)) {
						k.note("a target negation")
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
					const t = touches(rule, name)
					assert.equal(
						t !== undefined && (t.kind === "news" || t.kind === "both"),
						added,
						`an INSERT of ${name} can break the rule exactly where a witness reads it as a row or a presence`
					)
					assert.equal(
						t !== undefined && (t.kind === "olds" || t.kind === "both"),
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
		kills: []
	})
