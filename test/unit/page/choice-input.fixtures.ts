/** What the properties of choice-input.test.ts read: its spaces, models and helpers. */

import { Array as Arr, pipe, String as Str } from "effect"
import { indices } from "#compiler/core/array.ts"
import { query, v } from "#compiler/public/query.ts"
import { Account, Task, Work } from "#test/support/fixtures/api/work.ts"

/** An account's first two tasks by id. */
const firstTwo = query(Work)
	.rule((r) => {
		const { id } = v(Task, "task")
		return r.match(Task, { id, account: r.param("acct", Task.fields.account) }).find({ id })
	})
	.orderBy(["id", "asc"])
	.take(2)

/** The accounts the relation parameter `name` names, each with its first two tasks. */
export const namedAccounts = (name: string) =>
	query(Work).rule((r) => {
		const wanted = r.relation(name, { id: Account.fields.id })
		const { id: account } = v(wanted, "wanted")
		const top = firstTwo.bind({ acct: account })
		const { id } = v(top, "top")
		return r.match(wanted, { id: account }).match(top, { id }).find({ account, id })
	})

/** `count` distinct account facts. */
export const accounts = (count: number): ReadonlyArray<{ readonly id: string }> =>
	Arr.map(indices(count), (i) => ({
		id: `00000000-0000-4000-8000-${pipe(i.toString(16), Str.padStart(12, "0"))}`
	}))

export type Count = "at lateralParentMax" | "one past lateralParentMax"
