/**
 * The worked example's golden values: the facts the fixture loads.
 *
 * The facts are chosen so each query's stated property is visible: three automatic tasks of account a1 share the
 * budget 1500, so the aggregate's bound-variable contribution identity counts each; a1 has four automatic tasks, one
 * more than take(3) keeps, and three of them tie at 1500 for the last two places, so only the retained task id,
 * ascending, decides which are kept; one account has no task, so an attachment's task list is empty and its aggregate
 * is no row; and the prefix search over [Ac, Ad) meets an account named exactly "Ac" (included), one named "Ad"
 * (excluded) and "acme", which code point order excludes and a linguistic collation would admit.
 */
import { id } from "#test/support/fixtures/golden/types.ts"

export const a1 = id(1, 1)
export const a2 = id(1, 2)
export const a3 = id(1, 3)
const a4 = id(1, 4)
const a5 = id(1, 5)
const a6 = id(1, 6)
export const t1 = id(2, 1)
export const t2 = id(2, 2)
export const t3 = id(2, 3)
export const t4 = id(2, 4)
export const t5 = id(2, 5)
const t6 = id(2, 6)
export const t7 = id(2, 7)
/** A task id no fact has. */
export const tMissing = id(2, 0x99)

/**
 * A lawful state of Work: every Task selecting a handle has its arm and nothing else, every task's
 * account exists, every note's task exists.
 */
export const workFacts = {
	Account: [
		{ id: a1, name: "Acme" },
		{ id: a2, name: "Acorn" },
		{ id: a3, name: "Bolt" },
		{ id: a4, name: "Ac" },
		{ id: a5, name: "Ad" },
		{ id: a6, name: "acme" }
	],
	Task: [
		{ id: t1, account: a1, kind: "Automatic" },
		{ id: t2, account: a1, kind: "Manual" },
		{ id: t3, account: a1, kind: "Automatic" },
		{ id: t4, account: a2, kind: "Automatic" },
		{ id: t5, account: a1, kind: "Automatic" },
		{ id: t6, account: a1, kind: "Automatic" },
		{ id: t7, account: a2, kind: "Manual" }
	],
	AutomaticTask: [
		{ task: t1, budget: 1500n },
		{ task: t3, budget: 1500n },
		{ task: t4, budget: 700n },
		{ task: t5, budget: 1500n },
		{ task: t6, budget: 2000n }
	],
	ManualTask: [
		{ task: t2, operator: "Ruth" },
		{ task: t7, operator: "Sam" }
	],
	TaskNote: [
		{ task: t1, note: "check the feed" },
		{ task: t2, note: "call back" }
	]
} as const
