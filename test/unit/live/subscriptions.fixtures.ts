/** What the properties of subscriptions.test.ts read: its spaces, models and helpers. */

import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { type LiveAnswer } from "#adapter/live/subscriptions.ts"
import {
	diffList,
	fold,
	type KeyedList,
	keyOf,
	type ListEvent,
	opening
} from "#compiler/live/index.ts"
import { admittedIdentifier, type RouteKey } from "#compiler/plan/runtime.ts"

/** A row of the model table: its key, its group, its payload. */
export interface Row {
	readonly id: number
	readonly g: number
	readonly v: number
}

/** One change of a commit: a row put, inserted or updated in place, or the row of an id deleted. */
type Change =
	| { readonly kind: "put"; readonly row: Row }
	| { readonly kind: "delete"; readonly id: number }

/** One commit: its changes, and whether the leader fails closed, sending the table's key for it. */
interface Commit {
	readonly changes: ReadonlyArray<Change>
	readonly wide: boolean
}

/** A step of a history: a commit, then for each subscription whether its consumer pulls, and the runs refused first. */
export interface Step {
	readonly commit: Commit
	readonly pulls: ReadonlyArray<{ readonly pull: boolean; readonly refused: number }>
}

export const table = admittedIdentifier<"table">("t")
export const column = admittedIdentifier<"column">("g")
const groups = [0, 1, 2] as const

/** A subscription's reach: one group's rows, or the whole table. */
type Reach = { readonly kind: "group"; readonly g: number } | { readonly kind: "whole" }

export const reachGen: Gen<Reach> = (source) =>
	source.draw(int(0, 3)) === 0
		? { kind: "whole" }
		: { kind: "group", g: source.draw(element(groups)) }

export const rowGen: Gen<Row> = (source) => ({
	id: source.draw(int(0, 5)),
	g: source.draw(element(groups)),
	v: source.draw(int(0, 2))
})

export const changeGen: Gen<Change> = (source) =>
	source.draw(int(0, 3)) === 0
		? { kind: "delete", id: source.draw(int(0, 5)) }
		: { kind: "put", row: source.draw(rowGen) }

/** The keys a subscription of `reach` registers under. */
export const keysOf = (reach: Reach): ReadonlyArray<RouteKey> =>
	reach.kind === "whole"
		? [{ kind: "table", table }]
		: [{ kind: "keyed", table, column, value: String(reach.g) }]

/** Whether a key sent reaches a key registered (unit/live/router's rule). */
export const matches = (registered: RouteKey, sent: RouteKey): boolean =>
	registered.table === sent.table &&
	(registered.kind === "table" ||
		sent.kind === "table" ||
		(registered.column === sent.column && registered.value === sent.value))

/** The model's rows a subscription of `reach` reads, by id. */
export const readOf = (model: ReadonlyMap<number, Row>, reach: Reach): ReadonlyArray<Row> =>
	Arr.sort(
		Arr.filter([...model.values()], (row) => reach.kind === "whole" || row.g === reach.g),
		Order.mapInput(Order.Number, (row: Row) => row.id)
	)

/** A value's rows, in its order. */
export const rowsOf = (value: KeyedList<Row>): ReadonlyArray<Row> => [...value]

/** The upserts of a run's rows, in their order, each after the row before it by its id, null first. */
export const upsertsOf = (rows: ReadonlyArray<Row>): ReadonlyArray<ListEvent<Row>> =>
	Arr.map(rows, (row, n) => {
		const before = rows[n - 1]
		return { _tag: "upsert", row, after: before === undefined ? null : keyOf(["id"], before) }
	})

/** `commit` applied to `model`, and the keys a leader sends for it. */
export const applied = (model: Map<number, Row>, commit: Commit): ReadonlyArray<RouteKey> => {
	const keys: Array<RouteKey> = []
	const keyed = (g: number): RouteKey => ({ kind: "keyed", table, column, value: String(g) })
	for (const change of commit.changes) {
		const id = change.kind === "put" ? change.row.id : change.id
		const before = model.get(id)
		if (before !== undefined) {
			keys.push(keyed(before.g))
		}
		if (change.kind === "put") {
			keys.push(keyed(change.row.g))
			model.set(id, change.row)
		} else {
			model.delete(id)
		}
	}
	return commit.wide && commit.changes.length > 0 ? [{ kind: "table", table }] : keys
}

/** How a live read's answer is made, as db/handles.ts makes it over the test's rows. */
export const answer: LiveAnswer<Row, ListEvent<Row>> = {
	settle: (events) => fold(opening<Row>(), events),
	diff: diffList,
	ready: { _tag: "ready" },
	error: (error) => ({ _tag: "error", error }),
	end: { _tag: "end" }
}

/** The features a case shows. */
export type Feature =
	| "a keyed subscription reached"
	| "a table-wide subscription reached"
	| "a commit reaching no subscription"
	| "a fail-closed table key"
	| "a pull after several commits"
	| "a refused run run again"
	| "a batch removing a row"
	| "a marked subscription whose value stayed"

/** The features an expiry case shows. */
export type Expiring = "a change sent before the expiry" | "no change before the expiry"
