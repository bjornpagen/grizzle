/**
 * A sub-query each rule of a union reads at its own row's values, a copy in each rule's statement, is computed once for
 * each row that drives it and read there by every rule (lower/shapes/share/copies.ts, share/keyed.ts KeyedLowering
 * carried): each rule's site reads its own driver row's arrays, no lookup and no scan, so a judge's work grows with the
 * rows a write touches, never with their square. Read from one evaluation of every touched row's keys at each row's
 * values, a CTE no index reads, each rule scanned the whole evaluation for each touched row, O(k * |E|) for k rows written
 * (DECIDE5's compute-once, 242459f67), where a write's batch is a hot path (Bjorn's ruling: batching mandatory). A
 * driver is a node the statement holds whole, so the one evaluation is never of a stored relation's every row.
 *
 * On PostgreSQL 19, metis's first budget in small (rule-copies.fixtures.ts): a check over a derived relation of two or
 * three rules, each a budget written beside its sitting's limits, a union of two or three arms, and a fact of its own,
 * over a few hundred sittings, one budget written, then two, then twenty to sixty; and a read of one child's budgets,
 * each rule beside the limits bound to its budget's stage, beside a few dozen children and then a few hundred.
 *
 * Oracle: a bound, the judge's scans at k budgets written read at most k times their rows at one; and invariance, the
 * read's scans read the same rows however many children stand beside it: stored relations' rows, delta reads' and CTE
 * scans' with what their filters removed.
 *
 * Features: two rules and three; limits of two arms and three; a read beside a few children and beside many.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type CopiesFeature,
	copiesGen,
	copiesTemplates,
	type ReadFeature,
	readGen,
	readTemplate,
	runCopies,
	runRead
} from "#test/pg/laws/rule-copies.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The judge of a write of k budgets, each rule reading the limits at its budget's sitting, reads at most k times the
 * rows it reads for one budget.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aSubQueryEveryRuleReadsAtItsRowIsComputedOnceForEachTouchedRowSoTheJudgeGrowsWithTheWriteNeverItsSquare =
	property.explore(copiesGen, {
		needs: {
			"2 2": Substrate.rolledBack(copiesTemplates["2 2"]),
			"2 3": Substrate.rolledBack(copiesTemplates["2 3"]),
			"3 2": Substrate.rolledBack(copiesTemplates["3 2"]),
			"3 3": Substrate.rolledBack(copiesTemplates["3 3"])
		},
		situations: [
			"two rules",
			"three rules",
			"limits of two arms",
			"limits of three arms"
		] satisfies ReadonlyArray<Reached<CopiesFeature>>,
		check: (needs, c) => (drawn) =>
			Effect.gen(function* () {
				const { connection, value } = yield* needs[drawn.shape]
				yield* runCopies(value, connection, drawn, c)
			}),
		oracle: {
			kind: "universal",
			name: "bound: the judge's scans over k budgets written read at most k times their rows over one, stored relations' rows, delta reads' and CTE scans' with what their filters removed"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/keyed.ts",
				original:
					'\t\t\tquery: cteRead(cx.relationAlias({ kind: "node", node: driving.driver.id }), cte),\n',
				replacement:
					'\t\t\tquery: ((at: string, inner: string, width: number) => operandSelect(core([...cte.columns.slice(0, width).map((c) => target(col(at, c))), ...cte.columns.slice(width).map((c) => target({ kind: "subquery", query: operandSelect(core([target(col(inner, c))], [cteRefAs(cte.name, inner)], conjunction(cte.columns.slice(0, width).map((k) => ({ kind: "binary", op: "=", left: col(inner, k), right: col(at, k), schema: undefined }))))) }))], [cteRefAs(cte.name, at)], undefined)))(cx.relationAlias({ kind: "node", node: driving.driver.id }), cx.relationAlias({ kind: "node", node: driving.driver.id }), driving.driver.heading.length),\n',
				why: "Each driver row reads its copies' arrays from the one evaluation at its own values, a CTE no index reads, as each site read it at 242459f67: the evaluation scanned whole for each touched sitting, each budget adding more than the one before it."
			}
		]
	})

/**
 * A read of one child's budgets, each rule reading the limits bound to its budget's stage, reads the same rows however
 * many children the store holds beside it: a copy whose driver the statement does not hold whole, a stored relation it
 * reads at the child, stays where it stands, each read at its own row's values, never computed once beside every stored
 * row of the driver.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aCopyReadAtAStoredRowsValueStaysWhereItStandsSoAReadOfOneChildReadsItsOwnRowsHoweverManyStandBeside =
	property.explore(readGen, {
		needs: { stored: Substrate.rolledBack(readTemplate) },
		situations: ["read beside a few children", "read beside many children"] satisfies ReadonlyArray<
			Reached<ReadFeature>
		>,
		check:
			({ stored }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { connection, value } = yield* stored
					yield* runRead(value, connection, drawn, c)
				}),
		oracle: {
			kind: "universal",
			name: "invariance: the read's scans read the same rows, stored relations' and CTE scans' with what their filters removed, beside a few dozen children and beside a few hundred"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/copies.ts",
				original: "\t\t\t!heldWhole(first.node) ||\n",
				replacement: "\t\t\tfalse ||\n",
				why: "A driver the statement does not hold whole drives its copies' one evaluation: Budget's every stored row beside the limits at its stage, read whole however few budgets the child holds, so the read's work grows with every child stored beside it."
			}
		]
	})
