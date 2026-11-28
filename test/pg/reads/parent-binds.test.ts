/**
 * An attachment child's import whose parameter is bound to a parent variable reads, on PostgreSQL 19, the rows the
 * parent's value selects, whichever match of the child's rule binds that variable (check/checker.ts RuleCheck
 * #bindValue): where the import's own match or a later one binds it, the import reads the parent's own column, carried
 * in the attachment statement's parent key; where an earlier one does, the region's variable that match binds; where
 * none does, the variable the region correlates to its parent column. edullm's marks attachments (judged.ts marksOf),
 * whose import's own match binds the parent variables its bind map reads, were refused at generate before.
 *
 * Each case draws the facts, attempts of two children at two items and marks of those items, and reads every read of
 * the box over them through the installed login: each of the four binders (test/support/unit/check/parent-binds.fixtures.ts
 * binders) with each of the two bindings, a scalar parameter or a relation parameter bound to a query's rows, edullm's
 * shape. Every read delivers each attempt with the marks of its child at its item.
 *
 * - Property: every read delivers exactly the model's attempts, each with exactly the model's marks.
 * - Oracle: the reads restated over the facts on the host, each attempt with the marks of its key.
 * - Features: each binder and binding read, an attempt with no mark, and an attempt whose child has marks of another
 *   item, which an import bound to the child alone reads and the match's `n` leaves out.
 */

import { defined, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	type BindFeature,
	bindReads,
	type Delivered,
	expected,
	factsGen,
	featuresOf,
	parentBindsInstall,
	parentBindsTemplate
} from "#test/pg/reads/parent-binds.fixtures.ts"
import { rowsOf } from "#test/support/calls.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { ParentBinds } from "#test/support/unit/check/parent-binds.fixtures.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** A delivered child row's mark, as a number: the one cell of each element of an attempt's `marks` array. */
const markOf = (m: unknown): number =>
	Number(typeof m === "object" && m !== null ? Reflect.get(m, "mark") : undefined)

/** A delivered attempt's cells as numbers, its marks ascending. */
const deliveredOf = (row: Readonly<Record<string, unknown>>): Delivered => ({
	child: Number(row["child"]),
	n: Number(row["n"]),
	at: Number(row["at"]),
	marks: Arr.sort(Arr.map(Arr.isArray(row["marks"]) ? row["marks"] : [], markOf), Order.Number)
})

/**
 * An attachment child's import bound to a parent variable reads the rows the parent's value selects, whichever match
 * binds the variable.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const anAttachmentChildsImportBoundToAParentVariableReadsTheRowsTheParentsValueSelectsWhicheverMatchBindsTheVariable =
	property.explore(factsGen, {
		needs: { fixture: Substrate.fresh(parentBindsTemplate) },
		situations: [
			"the import's own match, a scalar parameter",
			"the import's own match, a relation parameter's rows",
			"an earlier match, a scalar parameter",
			"an earlier match, a relation parameter's rows",
			"a later match, a scalar parameter",
			"a later match, a relation parameter's rows",
			"no match, a scalar parameter",
			"no match, a relation parameter's rows",
			"an attempt with no mark",
			"an attempt whose child has marks of another item"
		] satisfies ReadonlyArray<Reached<BindFeature>>,
		check:
			({ fixture }, c: Case<BindFeature>) =>
			(facts) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const o = yield* openedIn(
								ParentBinds,
								{
									Attempt: Arr.map(facts.attempts, (f) => ({ child: f.child, n: f.n, at: f.at })),
									Mark: Arr.map(facts.marks, (f) => ({ child: f.child, n: f.n, mark: f.mark }))
								},
								parentBindsInstall,
								taken
							)
							return yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								const model = expected(facts)
								for (const read of bindReads) {
									const rows = yield* rowsOf(
										defined(db.workload[read.name], `the read ${read.name}`).once({
											params: {},
											facts: {}
										})
									)
									unorderedEqual(
										Arr.map(rows, deliveredOf),
										model,
										`${read.binder}, ${read.form}: each attempt with its child's marks at its item, over ${Formatter.format(facts)}`
									)
									c.note(`${read.binder}, ${read.form}`)
								}
								c.noteAll(featuresOf(facts))
							}).pipe(Effect.scoped, withLayer(o.served.layer))
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "the reads restated over the facts on the host: each attempt with the marks of its child at its item"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original: '\t\t\treturn { kind: "column", ...slot.outer, node: slot.head }\n',
				replacement: "\t\t\treturn this.#slotValue(slot, node)\n",
				why: "A bind map reads a parent variable as the region's variable, a match binding it or not, so the reads whose import's own match binds it have a region with no order, and the installation refuses their workload."
			}
		]
	})
