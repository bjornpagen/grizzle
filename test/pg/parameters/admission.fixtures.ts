/** What the properties of admission.test.ts read: its spaces, models and helpers. */

import { boolean, codePoint, element, type Gen, oneOf, string } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"

import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import { Id } from "#test/support/ids.ts"
import { upTo } from "#test/support/up-to.ts"

/** A pattern a stored field declares. */
const Code = str.regex("^[a-z]{1,4}$", "u")

const Item = relation("Item", { id: Id, code: Code }, ["id"])

const Pick = relation("Pick", { item: Id, code: Code }, ["item"])

export const Admit = schema("Admit", [Item, Pick], [])

/** The first stratum of both writes: the items of the relation parameter `fresh`. */
const freshItems = ChangeSet.empty(Admit).insert(
	Item,
	query(Admit).rule((r) => {
		const fresh = r.relation("fresh", { id: Item.fields.id, code: Code })
		const { id, code } = v(fresh, "fresh")
		return r.match(fresh, { id, code }).find({ id, code })
	})
)

/** Each stored item picked with the code `p`. */
const picked = ChangeSet.sequence(
	freshItems,
	ChangeSet.empty(Admit).insert(
		Pick,
		query(Admit).rule((r) => {
			const { id } = v(Item, "item")
			return r.match(Item, { id }).find({ item: id, code: r.param("p", Code) })
		})
	)
)

/** The one fact of the relation parameter `named` picked. */
const listed = ChangeSet.sequence(
	freshItems,
	ChangeSet.empty(Admit).insert(
		Pick,
		query(Admit).rule((r) => {
			const named = r.relation("named", { item: Item.fields.id, code: Code })
			const { item, code } = v(named, "named")
			return r.match(named, { item, code }).find({ item, code })
		})
	)
)

export const stored = [
	{ id: Id("00000000-0000-4000-8000-000000000001"), code: "abc" },
	{ id: Id("00000000-0000-4000-8000-000000000002"), code: "de" }
] as const

export const freshId = Id("00000000-0000-4000-8000-000000000003")

/** The first stratum's item that collides with no stored one. */
export const freshItem = { id: freshId, code: "xyz" } as const

/** The first stratum's item that collides with the first stored one: its key, another code. */
export const collidingItem = { id: Id("00000000-0000-4000-8000-000000000001"), code: "zz" } as const

/** A text inside Code about half the time: lowercase letters, or printable ASCII of any length up to six. */
const textGen: Gen<string> = oneOf([
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
	readonly write: "picked" | "listed"
	readonly collides: boolean
	readonly code: string
}

export const caseGen: Gen<Case> = (source) => ({
	write: source.draw(element(["picked", "listed"] as const)),
	collides: source.draw(boolean),
	code: source.draw(textGen)
})

export type Feature =
	| "a scalar parameter read only by a statement after one that fails"
	| "a relation parameter's field read only by a statement after one that fails"
	| `${Case["write"]} refused by the first stratum's key`
	| `${Case["write"]} accepted`

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const admitInstall = Object.freeze({ label: "admission", programs: { picked, listed } })

/** Admit installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const admitTemplate = fixtureTemplate(import.meta, Admit, admitInstall)
