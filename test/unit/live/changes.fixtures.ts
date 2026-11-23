/** What the properties of changes.test.ts read: its spaces, models and helpers. */

import { constant, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import type { Cell, Message, OldImage, Tuple } from "#adapter/live/pgoutput.ts"
import {
	admittedIdentifier,
	type Notification,
	notificationText,
	type RouteKey
} from "#compiler/plan/runtime.ts"

/** The relations of the stream: a routed table, by `g`; a table read whole; and a table no program reads. */
export const routedId = 1

export const wholeId = 2

export const unreadId = 3

export const ledgerId = 4

/** The installed name of the installation's migrations ledger (served/forms.ts ServedLive `ledger`). */
export const ledger = "__ledger"

/** Every relation's columns: its key `id`, and `g`, the routed table's routed column. */
const columns = [
	{ name: "id", key: true },
	{ name: "g", key: false }
] as const

export const relationMessages: ReadonlyArray<Message> = [
	{ kind: "relation", relation: routedId, namespace: "app", name: "routed", columns },
	{ kind: "relation", relation: wholeId, namespace: "app", name: "whole", columns },
	{ kind: "relation", relation: unreadId, namespace: "app", name: "unread", columns },
	{ kind: "relation", relation: ledgerId, namespace: "app", name: ledger, columns }
]

export const tables: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
	["routed", ["g"]],
	["whole", []]
])

/** A drawn routed column's value: a text, NULL, or a TOASTed value left unchanged. */
type Value =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "null" }
	| { readonly kind: "unchanged" }

const valueGen: Gen<Value> = (source) => {
	const at = source.draw(int(0, 5))
	return at === 0
		? { kind: "null" }
		: at === 1
			? { kind: "unchanged" }
			: { kind: "text", text: source.draw(element(["0", "1", "a=b:c", ""])) }
}

/** A drawn change, a step of the transaction: its relation, its kind, and its sides' routed values. */
export type Change =
	| { readonly kind: "insert"; readonly relation: number; readonly next: Value }
	| {
			readonly kind: "update"
			readonly relation: number
			readonly next: Value
			readonly old: { readonly image: "whole" | "key" | "none"; readonly value: Value }
	  }
	| {
			readonly kind: "delete"
			readonly relation: number
			readonly old: { readonly image: "whole" | "key"; readonly value: Value }
	  }

const relationGen: Gen<number> = weighted([
	[2, constant(routedId)],
	[1, constant(wholeId)],
	[1, constant(unreadId)],
	[1, constant(ledgerId)]
])

export const changeGen: Gen<Change> = (source) => {
	const relation = source.draw(relationGen)
	switch (source.draw(int(0, 2))) {
		case 0:
			return { kind: "insert", relation, next: source.draw(valueGen) }
		case 1:
			return {
				kind: "update",
				relation,
				next: source.draw(valueGen),
				old: {
					image: source.draw(element(["whole", "key", "none"] as const)),
					value: source.draw(valueGen)
				}
			}
		default:
			return {
				kind: "delete",
				relation,
				old: {
					image: source.draw(element(["whole", "key"] as const)),
					value: source.draw(valueGen)
				}
			}
	}
}

const cellOf = (value: Value): Cell =>
	value.kind === "text" ? { kind: "text", text: value.text } : { kind: value.kind }

const tupleOf = (g: Value): Tuple => [{ kind: "text", text: "7" }, cellOf(g)]

const imageOf = (image: "whole" | "key", value: Value): OldImage =>
	image === "whole"
		? { whole: true, tuple: tupleOf(value) }
		: { whole: false, tuple: [{ kind: "text", text: "7" }, { kind: "null" }] }

/** The pgoutput message of a drawn change. */
export const messageOf = (change: Change): Message => {
	switch (change.kind) {
		case "insert":
			return { kind: "insert", relation: change.relation, next: tupleOf(change.next) }
		case "update":
			return {
				kind: "update",
				relation: change.relation,
				previous:
					change.old.image === "none" ? undefined : imageOf(change.old.image, change.old.value),
				next: tupleOf(change.next)
			}
		case "delete":
			return {
				kind: "delete",
				relation: change.relation,
				previous: imageOf(change.old.image, change.old.value)
			}
	}
}

const routedTable = admittedIdentifier<"table">("routed")

const routedColumn = admittedIdentifier<"column">("g")

/** A side's routed value as the rule reads it: its text, or none where the side does not say it. */
const said = (value: Value): string | undefined => (value.kind === "text" ? value.text : undefined)

/** The keys the rule gives a drawn change (see the header). */
export const expectedOf = (change: Change): ReadonlyArray<Notification> => {
	if (change.relation === unreadId) {
		return []
	}
	if (change.relation === ledgerId) {
		return [{ kind: "migrated" }]
	}
	if (change.relation === wholeId) {
		return [{ kind: "table", table: admittedIdentifier<"table">("whole") }]
	}
	const sides: Array<string | undefined> = []
	switch (change.kind) {
		case "insert":
			sides.push(said(change.next))
			break
		case "update":
			sides.push(said(change.next))
			sides.push(change.old.image === "whole" ? said(change.old.value) : undefined)
			break
		case "delete":
			sides.push(change.old.image === "whole" ? said(change.old.value) : undefined)
			break
	}
	return Arr.map(sides, (value): RouteKey =>
		value === undefined
			? { kind: "table", table: routedTable }
			: { kind: "keyed", table: routedTable, column: routedColumn, value }
	)
}

export const textsOf = (notifications: ReadonlyArray<Notification>): ReadonlyArray<string> =>
	Arr.sort([...new Set(Arr.map(notifications, notificationText))], Order.String)

/** The features a case shows. */
export type Feature =
	| "an insert"
	| "an update with a whole old image"
	| "an update with a key-only image"
	| "an update with none"
	| "a delete"
	| "a NULL routed value"
	| "an unchanged TOASTed value"
	| "a change of a whole-read table"
	| "a change of an unread table"
	| "a change of the ledger"
