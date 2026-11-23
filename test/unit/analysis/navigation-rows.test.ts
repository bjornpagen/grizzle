/**
 * A rule over the rows a call binds a relation parameter to (ChangeSetDesc `boundRows`, read by the parameter's name),
 * a source navigation reads where it stands, reads each definition beside it that navigation reads apart as a chain of
 * its own restricted to the rows' values (analysis/theory/navigate.ts navigatedRule, Navigator.restrictedApart):
 * correlated to the rows, the definition restricted inside to parameters its bind map binds to the rows' variables, so
 * its chain's first step is a lookup at the call's row. Before, the definition was navigated apart from no value:
 * edullm's ledger finalize, the call's sittings settled, read SettledSitting's chain from a step over every ended
 * sitting, fenced, the call's sitting joined outside it, and the NOT EXISTS of its pending attempts ran for each of
 * 82,526 ended sittings at 1x where the call has one. A definition navigation reads no part of apart, one whose pending
 * query reads one relation, stays where it stands, a join PostgreSQL plans with the rows.
 *
 * Oracle: second implementation, the member as written, checked and evaluated by the reference over the checked IR
 * beside its navigation; and the plan's shape, stated: every relation a step reads is bound to a channel or a
 * parameter, TestEnd read by a step at both of its key columns wherever the pending query joins.
 *
 * Features: a negated query that joins, or of one relation; a member negation beside the definition; the call's rows
 * read from a stored relation; a sitting the definition keeps, and one it drops.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	answerOf,
	calledOf,
	type Feature,
	memberOf,
	navigatedOf,
	rowsCaseGen,
	situations,
	stepReads
} from "#test/unit/analysis/navigation-rows.fixtures.ts"

/**
 * A member over the call's rows reads each definition beside them by them: a step keyed by the call's row at TestEnd's
 * key, no step reading a relation whole, and the facts it derives the member's as written.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aMemberOverTheCallsRowsReadsEachDefinitionBesideThemByThemAndDerivesWhatItDerivesAsWritten =
	property.explore(rowsCaseGen, {
		needs: {},
		situations: situations satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, k: Case<Feature>) => (c) =>
			Effect.sync(() => {
				const member = memberOf(c.shape)
				const navigated = navigatedOf(member)
				const reads = stepReads(navigated)
				const shown = `${Formatter.format(c.shape)}: the steps read ${Formatter.format(reads)}`
				const ends = Arr.filter(reads, (r) => r.relation === "TestEnd")
				assert.ok(
					(c.shape.pending === "one relation" || Arr.isReadonlyArrayNonEmpty(ends)) &&
						Arr.every(ends, (r) => r.keyed.includes("child") && r.keyed.includes("stage")),
					`${shown}\nTestEnd is read by a step keyed by the call's row at child and stage wherever the pending query joins`
				)
				assert.deepEqual(
					Arr.filter(reads, (r) => r.keyed.length === 0),
					[],
					`${shown}\nno step reads a relation whole`
				)
				const asWritten = answerOf(c, member)
				assert.deepEqual(
					answerOf(c, navigated),
					asWritten,
					`${Formatter.format(c)}: the navigated member derives what it derives as written`
				)
				k.note(
					c.shape.pending === "a join of two relations"
						? "a negated query that joins"
						: "a negated query of one relation"
				)
				if (c.shape.negated) {
					k.note("a member negation beside the definition")
				}
				const called = Arr.map(calledOf(c), (row) => Arr.join(Arr.map(row, String), ","))
				if (c.shape.rows === "the call's child's sittings" && called.length > 1) {
					k.note("the call's rows read from a stored relation")
				}
				if (asWritten.length > 0) {
					k.note("a sitting the definition keeps")
				}
				if (Arr.some(called, (row) => !asWritten.includes(row))) {
					k.note("a sitting the definition drops")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the member as written, checked and evaluated by the reference beside its navigation; and every relation a step reads bound to a channel or a parameter, TestEnd read by a step at both key columns wherever the pending query joins"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\t\t? navigator.restrictedApart(m, source, bound)\n",
				replacement: "\t\t\t? undefined\n",
				why: "An import navigation reads apart is never restricted where it stands, as before: SettledSitting's chain, where its pending query joins, starts at a step over every ended sitting, fenced, the call's sitting joined outside it."
			}
		]
	})
