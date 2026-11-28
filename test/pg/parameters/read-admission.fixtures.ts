/** What the properties of read-admission.test.ts read: its spaces, models and helpers. */

import { codePoint, element, type Gen, oneOf, string } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"

import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Id, toId } from "#test/support/ids.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"
import { upTo } from "#test/support/up-to.ts"

/** A pattern a stored field declares. */
const Code = str.regex("^[a-z]{1,4}$", "u")

const Item = relation("Item", { id: Id, code: Code }, ["id"])

export const Unread = schema("Unread", [Item], [])

/** What filters a read's rule: nothing, or the constant false, which leaves its parameter unread. */
type Filter = "none" | "false"

/** The items whose code is the scalar parameter `p`, filtered by `filter`. */
const scalarRead = (filter: Filter) =>
	query(Unread).rule((r) => {
		const { id } = v(Item, "item")
		const matched = r.match(Item, { id, code: r.param("p", Code) })
		return (filter === "false" ? matched.where(r.or([])) : matched).find({ id })
	})

/** The rows of the relation parameter `named`, an item and a code, filtered by `filter`. */
const relationRead = (filter: Filter) =>
	query(Unread).rule((r) => {
		const named = r.relation("named", { item: Item.fields.id, code: Code })
		const { item, code } = v(named, "named")
		const matched = r.match(named, { item, code })
		return (filter === "false" ? matched.where(r.or([])) : matched).find({ item, code })
	})

export const stored = [
	{ id: toId("00000000-0000-4000-8000-000000000001"), code: "abc" },
	{ id: toId("00000000-0000-4000-8000-000000000002"), code: "de" }
] as const

/** A text inside Code about half the time, a stored item's code among them: lowercase letters, or printable ASCII. */
const textGen: Gen<string> = oneOf([
	element(["abc", "de"]),
	string(codePoint(0x61, 0x7a), { min: 1, max: 4 }),
	string(codePoint(0x20, 0x7e), { min: 0, max: 6 })
])

/** Whether a text is one to four ASCII lowercase letters, the language of Code. */
export const isCode = (text: string): boolean =>
	text.length >= 1 &&
	text.length <= 4 &&
	Arr.every(
		upTo(text.length, (i) => i),
		(i) => Option.exists(Str.charCodeAt(text, i), (unit) => unit >= 0x61 && unit <= 0x7a)
	)

interface Case {
	readonly via: "scalar" | "relation"
	readonly filter: Filter
	readonly code: string
}

export const caseGen: Gen<Case> = (source) => ({
	via: source.draw(element(["scalar", "relation"] as const)),
	filter: source.draw(element(["none", "false"] as const)),
	code: source.draw(textGen)
})

export type Feature =
	| `${Case["via"]} outside Code refused, filtered by ${Filter}`
	| `${Case["via"]} answered, filtered by ${Filter}`

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const readsInstall = Object.freeze({
	label: "unread",
	programs: {
		scalarNone: scalarRead("none"),
		scalarFalse: scalarRead("false"),
		relationNone: relationRead("none"),
		relationFalse: relationRead("false")
	}
})

/** Unread installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const readsTemplate = fixtureTemplate(import.meta, Unread, readsInstall)
