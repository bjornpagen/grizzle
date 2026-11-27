/**
 * A sub-query a rule statement reads at several sites, each rule of a union reading it at the values its own row binds,
 * is computed once for each row that drives it, each site reading that row's carried arrays (lower/shapes/share/
 * copies.ts, share/keyed.ts KeyedLowering carried): the import is one node for each region that binds its values
 * (check/checker.ts importedKey), a copy correlated to each rule's row, which the lowering spelled at each, the limits
 * matched as one definition whole (analysis/theory/query.ts DefinedMatch), never an arm for each choice of a rule.
 * metis's first budget judge read the sitting time limits, a union of 217 KB, in each of five rules, 73% of its 1.36 MB
 * statement, planned five times; computed once, its first COMMIT took 105 ms where it took 312 (METISMEASURE, grizzle
 * 9c5218ed4).
 *
 * The box, exhausted: a check over a derived relation of two or three rules, each a written budget beside its sitting's
 * limit and a fact of its own, its sitting not held (an assignment of a suspended test), a test of existence each rule
 * makes at its own row's values over a join of two relations (a copy of no column, which stays where it stands, read
 * per row through its index), over limits of two or three arms; and one of two rules, reading the limits at the
 * budget's stage and at its resumed sitting, a column of another name and the same domain: a copy is one sub-query
 * whatever the names of the outer columns it reads, by their places (ir/dag-digest.ts positional).
 *
 * Oracle: specification, each judge statement over the budgets written (under the two names, the assignments written)
 * reads Limit's table once for each arm of the limits.
 *
 * Features: two rules and three; limits of two arms and three; read at two columns' names.
 */

import { type Reached as ReachedOf } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { budgetsGen, judgedOnce, type Reached } from "#test/unit/physical/judge-copies.fixtures.ts"

/** A sub-query each rule of a union reads at its own row's values is computed once, never spelled at each rule. */
export const aSubQueryEachRuleReadsAtItsOwnRowsValuesIsComputedOnceForEachRowThatDrivesItNeverSpelledAtEach =
	property.exhaust(finite(budgetsGen), {
		needs: {},
		situations: [
			"two rules",
			"three rules",
			"limits of two arms",
			"limits of three arms",
			"read at two columns' names"
		] satisfies ReadonlyArray<ReachedOf<Reached>>,
		check: (_, c: Case<Reached>) => (budgets) => Effect.sync(() => judgedOnce(budgets, c.note)),
		oracle: {
			kind: "specification",
			name: "each judge statement over the budgets written, or the assignments written under two names, reads Limit's table once for each arm of the limits"
		},
		box: "a check over a derived relation of two or three rules, each a written budget beside its sitting's limit and a fact of its own, its sitting not held, over limits of two or three arms, or two rules reading them at the budget's stage and at its resumed sitting",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\t\t\t\t: inlined.arms.length > 1\n",
				replacement: "\t\t\t\t\t: inlined.arms.length > 1 && inlined.arms.length < 1\n",
				why: "The limits, a definition of several rules each rule matches, are distributed into their arms, a rule for each choice of an arm, where they are one match of the definition whole: no copy is one sub-query of the limits, and a judge over two rules and limits of two arms reads Limit 4 times, past its 2; the property fails."
			},
			{
				file: "packages/engine/src/lower/shapes/index.ts",
				original: "\t\t\tsite === undefined || restrictedUnder(node, env)\n",
				replacement: "\t\t\ttrue\n",
				why: "Every copy is read where it stands: each rule spells the limits again, and a judge reads Limit once for each arm at each rule."
			},
			{
				file: "packages/engine/src/lower/shapes/share/copies.ts",
				original: "\t\t\tnode.heading.length > 0 &&\n",
				replacement: "\t\t\ttrue &&\n",
				why: "A copy of no column, the test of a sitting held each rule makes at its own row, is computed once: its evaluation has no column to read, and the judge is not lowered."
			},
			{
				file: "packages/engine/src/ir/dag-digest.ts",
				original: '\t\tif (this.#outer !== "positional" || !this.outside(id)) {\n',
				replacement: "\t\tif (true) {\n",
				why: "A copy's form names the outer columns it reads by their names: the rule reading the limits at the resumed sitting is a class of its own, and a judge reads Limit twice for each arm."
			}
		]
	})
