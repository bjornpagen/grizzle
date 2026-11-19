/** What the properties of workload-index.test.ts read: its spaces, models and helpers. */

import { array, type Gen, int } from "@bjornpagen/testing/gen"
import { pipe, String as Str } from "effect"
import { pg, type Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import * as W from "#test/support/fixtures/api/work.ts"

/**
 * Workload indexes on a derived relation on PostgreSQL 19.
 *
 * A workload program that reads AccountBudget, the account budgets, by a range on its `tasks` column justifies a
 * non-unique index on the `tasks` column, beside the view's key index, which the installation's first migration creates
 * on the materialized view. The index is a plain B-tree on the view, survives a plain refresh and a concurrent one, and
 * serves the program's own optimized statement: over drawn accounts, each with its drawn number of automatic tasks
 * written inside the case's transaction, and a drawn threshold, PostgreSQL plans the statement through it once the
 * view's key index is dropped in that transaction and sequential scans are off, so the plan shows whether the index
 * matches the statement's range, whatever the view's size makes cheapest; and the statement returns the accounts whose
 * automatic tasks number at least the threshold.
 *
 * Oracle: the accounts at or past the threshold, counted on the host, and PostgreSQL's planner as the judge of whether
 * the index serves the range. Features: an account selected, an account below the threshold, one at it, none
 * selected.
 */
export const busyAccounts = query(W.Reports).rule((r) => {
	const { account, tasks, budget } = v(W.AccountBudget, "accountBudget")
	return r
		.match(W.AccountBudget, { account, tasks, budget })
		.where(r.ge(tasks, r.param("least", pg.bigint)))
		.find({ account, budget })
})

export const id = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

/**
 * A case: the least task count the program asks for, and each account's automatic tasks beyond its first, one to
 * eight accounts, all written inside the case's transaction.
 */
interface BusyCase {
	readonly least: number
	readonly more: ReadonlyArray<number>
}

export const busyCaseGen: Gen<BusyCase> = (source) => ({
	least: source.draw(int(2, 5)),
	more: source.draw(array(int(0, 4), { min: 1, max: 8 }))
})

export type BusyFeature =
	| "an account selected"
	| "an account below the least"
	| "an account at the least"
	| "no account selected"

/** Each index of the view as (name, unique, valid, kind of the indexed relation, its key columns joined by commas). */
export type IndexRow = readonly [
	name: string,
	unique: string,
	valid: string,
	kind: string,
	columns: string
]
