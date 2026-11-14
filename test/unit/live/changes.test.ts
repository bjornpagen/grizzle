/**
 * The live leader's reading of a replication stream into route keys (packages/grizzle/src/adapter/live/changes.ts):
 * drawn pgoutput messages of one transaction over a routed table, a whole-read table, an unread table, the
 * installation's migrations ledger and the installation's announcements, read by the transaction reader, against the
 * coverage rule restated over the drawn changes.
 *
 * - Each change of a routed table is, for each side it carries, the keyed key at that side's value of the routed column
 *   where the side says it, and the table's key where it does not: a NULL, a TOASTed value left unchanged, a column a
 *   key-only old image leaves out, an update's old side with no old image beyond its key. A change of a table read whole
 *   is its table's key; of an unread table, nothing; of the ledger, whatever row it writes, `migrated`, a migration.
 *   Oracle: the rule, restated over the drawn change, a second implementation.
 * - An announcement is untrusted: of a message under the installation's prefix only the table keys of the installation's
 *   views are taken; a stored table's key, a keyed key, `invalidated`, `migrated`, an unknown view and malformed text are
 *   dropped, as is every message under another prefix. Oracle: the views among the announced keys.
 *
 * Features: an insert, an update with a whole old image, one with a key-only image, one with none, a delete, a NULL
 * routed value, an unchanged TOASTed value, a change of a whole-read table, of an unread table, of the ledger, an
 * announced view, an announced stored table's key, `invalidated` announced, `migrated` announced, malformed announcement
 * text, and another prefix.
 *
 * Plants (~/.cache/grizzle-release/LIVE-SUBSCRIBE/plants): announcement-accepts-table-key.patch (the reader takes any
 * table key an announcement names, so a forged announcement re-runs every read of a stored table); ledger-unread.patch
 * (the ledger read as a table no program reads, so a migration ends no live read).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, boolean, constant, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Order, Result, String as Str } from "effect"
import { transactionReader } from "#adapter/live/changes.ts"
import type { Cell, Message, OldImage, Tuple } from "#adapter/live/pgoutput.ts"
import {
	admittedIdentifier,
	type Notification,
	notificationText,
	type RouteKey
} from "#compiler/plan/runtime.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

const prefix = "__live_app_0"

/** The relations of the stream: a routed table, by `g`; a table read whole; and a table no program reads. */
const routedId = 1
const wholeId = 2
const unreadId = 3
const ledgerId = 4

/** The installed name of the installation's migrations ledger (served/forms.ts ServedLive `ledger`). */
const ledger = "__ledger"

/** Every relation's columns: its key `id`, and `g`, the routed table's routed column. */
const columns = [
	{ name: "id", key: true },
	{ name: "g", key: false }
] as const

const relationMessages: ReadonlyArray<Message> = [
	{ kind: "relation", relation: routedId, namespace: "app", name: "routed", columns },
	{ kind: "relation", relation: wholeId, namespace: "app", name: "whole", columns },
	{ kind: "relation", relation: unreadId, namespace: "app", name: "unread", columns },
	{ kind: "relation", relation: ledgerId, namespace: "app", name: ledger, columns }
]

const tables: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
	["routed", ["g"]],
	["whole", []]
])

const views: ReadonlySet<string> = new Set(["view"])

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

/** A drawn change: its relation, its kind, and its sides' routed values. */
type Change =
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

const changeGen: Gen<Change> = (source) => {
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

/** A drawn announcement: its prefix and its text. */
interface Announcement {
	readonly prefix: string
	readonly text: string
}

const announcedGen: Gen<string> = element([
	"view:",
	"unknown_view:",
	"routed:",
	"routed:g=1",
	":invalidated",
	":migrated",
	"not a key"
])

const announcementGen: Gen<Announcement> = (source) => ({
	prefix: source.draw(
		weighted([
			[2, constant(prefix)],
			[1, constant("other")]
		])
	),
	text: Arr.join(source.draw(array(announcedGen, { min: 1, max: 3 })), "\u0000")
})

/** A step of the transaction: a change, or an announcement. */
type Step =
	| { readonly kind: "change"; readonly change: Change }
	| { readonly kind: "announce"; readonly announcement: Announcement }

const cellOf = (value: Value): Cell =>
	value.kind === "text" ? { kind: "text", text: value.text } : { kind: value.kind }

const tupleOf = (g: Value): Tuple => [{ kind: "text", text: "7" }, cellOf(g)]

const imageOf = (image: "whole" | "key", value: Value): OldImage =>
	image === "whole"
		? { whole: true, tuple: tupleOf(value) }
		: { whole: false, tuple: [{ kind: "text", text: "7" }, { kind: "null" }] }

/** The pgoutput message of a drawn step. */
const messageOf = (step: Step): Message => {
	if (step.kind === "announce") {
		return { kind: "message", prefix: step.announcement.prefix, content: step.announcement.text }
	}
	const change = step.change
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

/** The keys the rule gives a drawn step (see the header). */
const expectedOf = (step: Step): ReadonlyArray<Notification> => {
	if (step.kind === "announce") {
		if (step.announcement.prefix !== prefix) {
			return []
		}
		const texts = Str.split(step.announcement.text, "\u0000")
		return Arr.some(
			texts,
			(text) =>
				!["view:", "unknown_view:", "routed:", "routed:g=1", ":invalidated", ":migrated"].includes(
					text
				)
		)
			? []
			: Arr.flatMap(texts, (text): ReadonlyArray<Notification> =>
					text === "view:" ? [{ kind: "table", table: admittedIdentifier<"table">("view") }] : []
				)
	}
	const change = step.change
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

const textsOf = (notifications: ReadonlyArray<Notification>): ReadonlyArray<string> =>
	Arr.sort([...new Set(Arr.map(notifications, notificationText))], Order.String)

/** The features a case shows. */
type Feature =
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
	| "an announced view"
	| "an announced stored table's key"
	| "invalidated announced"
	| "migrated announced"
	| "malformed announcement text"
	| "another prefix"

describe("the live leader's reading of a replication stream", () => {
	it.effect(
		"a transaction's keys are the coverage rule's, and an announcement names only views",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "the coverage rule over the drawn changes"
						},
						suite: "unit/live/changes",
						draw: drawn((s) => ({
							steps: s.draw(
								array(
									(t): Step =>
										t.draw(boolean)
											? { kind: "change", change: t.draw(changeGen) }
											: { kind: "announce", announcement: t.draw(announcementGen) },
									{ min: 1, max: 6 }
								)
							)
						})),
						literal: Formatter.format,
						kept: [],
						runs: 500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						coverage: required<Feature>(
							[
								"an insert",
								"an update with a whole old image",
								"an update with a key-only image",
								"an update with none",
								"a delete",
								"a NULL routed value",
								"an unchanged TOASTed value",
								"a change of a whole-read table",
								"a change of an unread table",
								"a change of the ledger",
								"an announced view",
								"an announced stored table's key",
								"invalidated announced",
								"migrated announced",
								"malformed announcement text",
								"another prefix"
							],
							{ cases: 500, sense: notesOnly }
						)
					},
					({ steps }, c) =>
						Effect.sync(() => {
							const reader = transactionReader(tables, views, prefix, ledger)
							const messages: ReadonlyArray<Message> = [
								...relationMessages,
								{ kind: "begin", xid: 9 },
								...Arr.map(steps, messageOf),
								{ kind: "commit", endLsn: 42n }
							]
							const read = Arr.flatMap(messages, (message) => {
								const transaction = reader.read(message)
								assert.ok(Result.isSuccess(transaction), "every drawn message is read")
								return transaction.success === undefined ? [] : [transaction.success]
							})
							assert.equal(read.length, 1, "the stream holds one transaction")
							const [transaction] = read
							assert.ok(transaction !== undefined, "one transaction")
							assert.equal(transaction.xid, 9)
							assert.equal(transaction.endLsn, 42n)
							assert.deepEqual(
								textsOf(transaction.notifications),
								textsOf(Arr.flatMap(steps, expectedOf)),
								"the transaction's keys are the rule's"
							)
							for (const step of steps) {
								if (step.kind === "announce") {
									const texts = Str.split(step.announcement.text, "\u0000")
									if (step.announcement.prefix !== prefix) {
										c.note("another prefix")
									} else if (texts.includes("view:")) {
										c.note("an announced view")
									}
									if (texts.includes("routed:")) {
										c.note("an announced stored table's key")
									}
									if (texts.includes(":invalidated")) {
										c.note("invalidated announced")
									}
									if (texts.includes(":migrated")) {
										c.note("migrated announced")
									}
									if (texts.includes("not a key")) {
										c.note("malformed announcement text")
									}
									continue
								}
								const change = step.change
								if (change.relation === wholeId) {
									c.note("a change of a whole-read table")
								}
								if (change.relation === unreadId) {
									c.note("a change of an unread table")
								}
								if (change.relation === ledgerId) {
									c.note("a change of the ledger")
								}
								switch (change.kind) {
									case "insert":
										c.note("an insert")
										break
									case "update":
										c.note(
											change.old.image === "whole"
												? "an update with a whole old image"
												: change.old.image === "key"
													? "an update with a key-only image"
													: "an update with none"
										)
										break
									case "delete":
										c.note("a delete")
										break
								}
								const next = change.kind === "delete" ? undefined : change.next
								if (next?.kind === "null") {
									c.note("a NULL routed value")
								}
								if (next?.kind === "unchanged") {
									c.note("an unchanged TOASTed value")
								}
							}
						})
				)
			)
	)
})
