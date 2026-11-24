/** What the properties of served-levels.test.ts read: its spaces, models and helpers. */

import { type Gen, subarray, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { query, v } from "#compiler/public/query.ts"
import { role, wholeEntriesOf, wholeWritesOf } from "#compiler/public/schema.ts"
import {
	Budget,
	Node,
	Order,
	Pool,
	Reports,
	Tag,
	Task,
	TaskCount,
	Ticket,
	Work
} from "#test/support/agreement/changeset-schema.ts"
import { repoRoot } from "#test/support/files.ts"

/** A writer of Work's every writable relation over Work, built for one case: a role is in one login. */
export const workWriter = () => role(Work, "writer", wholeEntriesOf(Work), wholeWritesOf(Work))

/** A writer of Work's every writable relation over Reports, built for one case. */
export const reportsWriter = () =>
	role(Reports, "reportsWriter", wholeEntriesOf(Reports), wholeWritesOf(Work))

type Writer = ReturnType<typeof workWriter> | ReturnType<typeof reportsWriter>

/** One ChangeSet of the menu over a writer of Work or of Reports: its program's name and its value. */
interface Member {
	readonly name: string
	readonly kind: Feature
	readonly over: (writer: Writer) => unknown
}

export type Feature =
	| "a closed id, a set and texts"
	| "a contract"
	| "a serial"
	| "an immutable owner"
	| "a counted family's owner"
	| "a tree"
	| "a delete"
	| "a ChangeSet over the level below"
	| "a ChangeSet over the configured level"

/** The menu of ChangeSets, each over a writer of Work or of Reports, every member supplied by the call. */
const menu: Arr.NonEmptyReadonlyArray<Member> = [
	{
		name: "addTag",
		kind: "a closed id, a set and texts",
		over: (w) => ChangeSet.empty(w).insert(Tag, [])
	},
	{ name: "putBudget", kind: "a contract", over: (w) => ChangeSet.empty(w).put(Budget, []) },
	{ name: "addTicket", kind: "a serial", over: (w) => ChangeSet.empty(w).insert(Ticket, []) },
	{
		name: "addOrder",
		kind: "an immutable owner",
		over: (w) => ChangeSet.empty(w).insert(Order, [])
	},
	{
		name: "addPool",
		kind: "a counted family's owner",
		over: (w) => ChangeSet.empty(w).insert(Pool, [])
	},
	{ name: "addNode", kind: "a tree", over: (w) => ChangeSet.empty(w).insert(Node, []) },
	{ name: "dropTask", kind: "a delete", over: (w) => ChangeSet.empty(w).delete(Task, []) }
]

/** A case: the ChangeSets the login over Work runs, a nonempty set, and those the login over Reports runs. */
interface Case {
	readonly below: ReadonlyArray<Member>
	readonly above: ReadonlyArray<Member>
}

export const caseGen: Gen<Case> = (source) => ({
	below: source.draw(subset(menu, { min: 1, max: menu.length })),
	above: source.draw(subarray(menu))
})

export const counts = query(Reports).rule((r) => {
	const { account, tasks } = v(TaskCount, "count")
	return r.match(TaskCount, { account, tasks }).find({ account, tasks })
})

/** The programs of a writer's workload: each member's ChangeSet over it, under its name. */
export const programsOf = (
	members: ReadonlyArray<Member>,
	writer: Writer
): Readonly<Record<string, unknown>> =>
	Rec.fromEntries(Arr.map(members, (m) => [m.name, m.over(writer)] as const))

export const file = `${repoRoot}app/grizzle.config.ts`
