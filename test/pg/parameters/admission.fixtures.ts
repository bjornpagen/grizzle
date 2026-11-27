/** What the properties of admission.test.ts read: its spaces, models and helpers. */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed, codePoint, element, type Gen, oneOf, string } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"

import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import { Id, toId } from "#test/support/ids.ts"
import { upTo } from "#test/support/up-to.ts"

/** A pattern a stored field declares. */
const Code = str.regex("^[a-z]{1,4}$", "u")

const Item = relation("Item", { id: Id, code: Code }, ["id"])

const Pick = relation("Pick", { item: Id, code: Code }, ["item"])

export const Admit = schema("Admit", [Item, Pick], [])

/** The first stratum of each staged write: the items of the relation parameter `fresh`. */
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

/**
 * Each fact of the relation parameter `named`, an item, picked with the code `p`: the one statement that reads `p` is
 * sent only where `named` holds a fact, and every case passes it none, so `p` is read by a statement the runtime leaves
 * out.
 */
const guarded = ChangeSet.sequence(
	freshItems,
	ChangeSet.empty(Admit).insert(
		Pick,
		query(Admit).rule((r) => {
			const named = r.relation("named", { item: Item.fields.id })
			const { item } = v(named, "named")
			return r.match(named, { item }).find({ item, code: r.param("p", Code) })
		})
	)
)

/**
 * A ChangeSet of reads alone, which holds no statement of its own: the stored items whose code is `p`, filtered by the
 * constant false, which leaves `p` unread, so its one read-back, the first statement a call sends, admits `p` as its own
 * (lower/conservative/types.ts ReadBackAdmission `own`).
 */
const scanned = ChangeSet.empty(Admit).read("coded", () =>
	query(Admit).rule((r) => {
		const { id } = v(Item, "item")
		return r
			.match(Item, { id, code: r.param("p", Code) })
			.where(r.or([]))
			.find({ id })
	})
)

export const stored = [
	{ id: toId("00000000-0000-4000-8000-000000000001"), code: "abc" },
	{ id: toId("00000000-0000-4000-8000-000000000002"), code: "de" }
] as const

export const freshId = toId("00000000-0000-4000-8000-000000000003")

/** The first stratum's item that collides with no stored one. */
export const freshItem = { id: freshId, code: "xyz" } as const

/** The first stratum's item that collides with the first stored one: its key, another code. */
export const collidingItem = {
	id: toId("00000000-0000-4000-8000-000000000001"),
	code: "zz"
} as const

/** A text inside Code: one to four lowercase letters. */
const insideGen: Gen<string> = string(codePoint(0x61, 0x7a), { min: 1, max: 4 })

/** A text inside Code about half the time: lowercase letters, or printable ASCII of any length up to six. */
const textGen: Gen<string> = oneOf([insideGen, string(codePoint(0x20, 0x7e), { min: 0, max: 6 })])

/** Whether a text is one to four ASCII lowercase letters, the language of Code. */
export const isCode = (text: string): boolean =>
	text.length >= 1 &&
	text.length <= 4 &&
	Arr.every(
		upTo(text.length, (i) => i),
		(i) => Option.exists(Str.charCodeAt(text, i), (unit) => unit >= 0x61 && unit <= 0x7a)
	)

/**
 * The first stratum's items: none, so its statement is not sent; one that collides with no stored item; or one that
 * collides with the first stored item.
 */
export type First = "none" | "fresh" | "colliding"

/** A write of two strata, whose first inserts `fresh`. */
export type Staged = "picked" | "listed" | "guarded"

/** A case: a write of two strata after its first stratum's items, or `scanned`, which has no stratum; and its code. */
export type Case =
	| { readonly write: Staged; readonly first: First; readonly code: string }
	| { readonly write: "scanned"; readonly code: string }

const caseGen: Gen<Case> = (source) => {
	const write = source.draw(element(["picked", "listed", "guarded", "scanned"] as const))
	return write === "scanned"
		? { write, code: source.draw(textGen) }
		: {
				write,
				first: source.draw(element(["none", "fresh", "colliding"] as const)),
				code: source.draw(textGen)
			}
}

/** A text outside Code: five or six printable ASCII characters, past its length. */
const outsideGen: Gen<string> = string(codePoint(0x20, 0x7e), { min: 5, max: 6 })

/** A case of `write` after a first stratum of `first`, its code drawn by `code`. */
const caseAt =
	(write: Staged, first: First, code: Gen<string>): Gen<Case> =>
	(source) => ({ write, first, code: source.draw(code) })

/** A case of `scanned`, its code drawn by `code`. */
const scannedAt =
	(code: Gen<string>): Gen<Case> =>
	(source) => ({ write: "scanned", code: source.draw(code) })

export type Feature =
	| "a scalar parameter read only by a statement after one that fails"
	| "a relation parameter's field read only by a statement after one that fails"
	| "a scalar parameter read only by a statement the runtime leaves out, no statement sent for the write's facts"
	| "a scalar parameter of a ChangeSet of reads alone that no statement reads"
	| `${Staged} refused by the first stratum's key`
	| `${Staged} accepted`
	| "scanned answered"

/**
 * The cases, each turn that aims at a situation drawing a case that reaches it: a code outside Code after picked's and
 * listed's colliding first stratum, after guarded's none and in scanned, and each staged write's code inside Code after
 * a colliding first stratum and after one that collides with nothing, and scanned's.
 */
export const caseSpace = aimed(caseGen, [
	[
		"a scalar parameter read only by a statement after one that fails",
		caseAt("picked", "colliding", outsideGen)
	],
	[
		"a relation parameter's field read only by a statement after one that fails",
		caseAt("listed", "colliding", outsideGen)
	],
	[
		"a scalar parameter read only by a statement the runtime leaves out, no statement sent for the write's facts",
		caseAt("guarded", "none", outsideGen)
	],
	[
		"a scalar parameter of a ChangeSet of reads alone that no statement reads",
		scannedAt(outsideGen)
	],
	["picked refused by the first stratum's key", caseAt("picked", "colliding", insideGen)],
	["picked accepted", caseAt("picked", "fresh", insideGen)],
	["listed refused by the first stratum's key", caseAt("listed", "colliding", insideGen)],
	["listed accepted", caseAt("listed", "fresh", insideGen)],
	["guarded refused by the first stratum's key", caseAt("guarded", "colliding", insideGen)],
	["guarded accepted", caseAt("guarded", "fresh", insideGen)],
	["scanned answered", scannedAt(insideGen)]
] satisfies ReadonlyArray<readonly [Reached<Feature>, Gen<Case>]>)

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const admitInstall = Object.freeze({
	label: "admission",
	programs: { picked, listed, guarded, scanned }
})

/** Admit installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const admitTemplate = fixtureTemplate(import.meta, Admit, admitInstall)
