/**
 * A rule over the rows a call binds a relation parameter to (ChangeSetDesc `boundRows`, read by the parameter's name),
 * a source navigation reads where it stands, reads each definition beside it that navigation reads apart as a chain of
 * its own restricted to the rows' values (analysis/theory/navigate.ts navigatedRule, Navigator.restrictedApart):
 * correlated to the rows, the definition restricted inside to parameters its bind map binds to the rows' variables, so
 * its chain's first step is a lookup at the call's row. Before, the definition was navigated apart from no value:
 * edullm's ledger finalize, the call's sittings settled, read SettledSitting's chain from a step over every ended
 * sitting, fenced, the call's sitting joined outside it, and the NOT EXISTS of its pending attempts ran for each of
 * 82,526 ended sittings at 1x where the call has one. A definition navigation reads no part of apart, one whose pending
 * query reads one relation, stays where it stands, a join PostgreSQL plans with the rows. A definition that joins is
 * navigated apart from the columns the call's rows bind it at, each received through a channel bound to the rows'
 * variable (navigatedRule `inputs`, boundInside), so its chain starts at the call's row, once for each set of columns
 * they bind; navigated from no value, the sittings attempted led with every ended sitting (CARRYKEY's finding 5:
 * held-drives' sessions read last beside every learner's snapshots).
 *
 * Oracle: second implementation, the member as written, checked and evaluated by the reference over the checked IR
 * beside its navigation; and the plan's shape, stated: every relation a step reads is bound to a channel or a
 * parameter, TestEnd read by a step at both of its key columns wherever the pending query joins.
 *
 * Features: a definition that joins; a negated query that joins, or of one relation; a member negation beside the
 * definition; the call's rows
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
	atParameterGen,
	atParameterOf,
	navigatedOf,
	navigationsOf,
	patternsGen,
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
					(c.shape.definition === "the sittings attempted" ||
						c.shape.pending === "one relation" ||
						Arr.isReadonlyArrayNonEmpty(ends)) &&
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
				if (c.shape.definition === "the sittings attempted") {
					k.note("a definition that joins")
				}
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
				original: "\t\t\tchainedApart(source, interned) ? bound : passes ? inputs : noVariables,\n",
				replacement: "\t\t\tchainedApart(source, interned) ? bound : noVariables,\n",
				why: "An import that joins is navigated blind to the columns the call's rows bind it at, as before: the sittings attempted lead with a step over every ended sitting, keyed by nothing, the call's sitting joined outside it."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\tconst restricted = navigator.restrictedApart(\n",
				replacement: "\t\tconst restricted = undefined && navigator.restrictedApart(\n",
				why: "No import navigation reads apart is restricted where it stands, as before: SettledSitting's chain, where its pending query joins, and the sittings attempted start at a step over every ended sitting, fenced, the call's sitting joined outside it."
			}
		]
	})

/**
 * A definition the call's rows bind is navigated once for each set of its columns they bind, however many members of a
 * write read it so: each binding pattern's import of it one query (its channels named by place, never by the reader's
 * variable, navigate.ts Passing), which the write's one navigation navigates once (Navigation `navigated`).
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aDefinitionTheCallsRowsBindIsNavigatedOnceForEachSetOfColumnsTheyBind =
	property.explore(patternsGen, {
		needs: {},
		situations: [
			"a pattern read once",
			"a pattern read twice",
			"two patterns"
		] satisfies ReadonlyArray<
			Reached<"a pattern read once" | "a pattern read twice" | "two patterns">
		>,
		check:
			(_, k: Case<"a pattern read once" | "a pattern read twice" | "two patterns">) => (patterns) =>
				Effect.gen(function* () {
					const distinct = Arr.dedupe(patterns)
					const one = yield* navigationsOf(["child and stage"])
					const all = yield* navigationsOf(patterns)
					assert.ok(one > 0, "one pattern's read navigates the definition")
					assert.equal(
						all,
						distinct.length * one,
						`${Formatter.format(patterns)}: navigation navigates ${String(all)} joining rules, ${String(distinct.length)} patterns of ${String(one)}`
					)
					k.note(
						distinct.length > 1
							? "two patterns"
							: patterns.length > 1
								? "a pattern read twice"
								: "a pattern read once"
					)
				}),
		oracle: {
			kind: "universal",
			name: "one navigation per binding pattern: the joining rules navigated over a write's members are the distinct patterns' count times one pattern's"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\tconst known = navigations.get(identity)",
				replacement: "\t\tconst known = undefined",
				why: "Every read of a definition at a pattern navigates it again: two members reading the sittings attempted at the call's sittings navigate it twice."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\t\tchainedApart(source, interned) ? bound : passes ? inputs : noVariables,\n",
				replacement: "\t\t\tchainedApart(source, interned) ? bound : noVariables,\n",
				why: "A definition is navigated blind to the columns the call's rows bind it at: the sittings read at (child, stage) and at (child) are one unrestricted query, navigated once for both patterns."
			}
		]
	})

/**
 * An import a member reads at a parameter, bound to it or at a variable the member's rule equates with it, is navigated
 * from it (navigate.ts navigatedRule boundInside, fixedTerms): the child's attempted items at stage 1, a join whose one
 * literal binds ItemSession, start at the child's item sessions, never at every child's of stage 1, keyed by nothing,
 * which navigated from no value they did; and the member derives what it derives as written.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const anImportAMemberReadsAtAParameterIsNavigatedFromIt = property.explore(
	(s) => ({ how: s.draw(atParameterGen), c: s.draw(rowsCaseGen) }),
	{
		needs: {},
		situations: ["bound to the parameter", "equated with the parameter"] satisfies ReadonlyArray<
			Reached<"bound to the parameter" | "equated with the parameter">
		>,
		check:
			(_, k: Case<"bound to the parameter" | "equated with the parameter">) =>
			({ how, c }) =>
				Effect.sync(() => {
					const member = atParameterOf(how)
					const navigated = navigatedOf(member)
					const reads = stepReads(navigated)
					assert.deepEqual(
						Arr.filter(reads, (r) => r.keyed.length === 0),
						[],
						`${how}: the steps read ${Formatter.format(reads)}\nno step reads a relation whole`
					)
					assert.deepEqual(
						answerOf(c, navigated),
						answerOf(c, member),
						`${how}, ${Formatter.format(c)}: the navigated member derives what it derives as written`
					)
					k.note(how)
				}),
		oracle: {
			kind: "second-implementation",
			name: "the member as written, checked and evaluated by the reference beside its navigation; and every relation a step reads bound to a channel or a parameter"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\tconst inside = boundInside(source, m.bindings, fixed, columns)",
				replacement: "\t\tconst inside = source",
				why: "An import read at a parameter is navigated apart from it, the binding left outside the import, so its chain starts at every item session of stage 1, keyed by nothing."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original:
					'\treturn (term) => (term.kind === "var" ? fixed(term.var) : isFixed(term) ? term : undefined)',
				replacement:
					'\treturn (term) => (term.kind === "var" ? undefined : isFixed(term) ? term : undefined)',
				why: "A variable the member's rule equates with the parameter is no fixed term, so the import is read at the variable outside it and its chain starts at every item session of stage 1, keyed by nothing."
			}
		]
	}
)
