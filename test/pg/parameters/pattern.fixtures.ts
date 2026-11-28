/** What the properties of pattern.test.ts read: its spaces, models and helpers. */

import { array, codePoint, element, type Gen, oneOf, string } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import type { ParamPlace } from "#compiler/core/identity.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Id } from "#test/support/ids.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"
import { upTo } from "#test/support/up-to.ts"

/** A pattern no stored field of the schema declares, so the installation holds no domain of it. */
const Slug = str.regex("^[a-z]{1,8}$", "u")

/** A pattern a stored field declares, so the installation holds its domain. */
const Code = str.regex("^[a-z]{1,4}$", "u")

/** A schema whose one stored relation declares Code and no field of Slug. */
const Note = relation("Note", { id: Id, code: Code }, ["id"])

export const Notes = schema("Notes", [Note], [])

/** The slugs and codes a relation parameter carries, each with its position, delivered as they are. */
const echoed = query(Notes).rule((r) => {
	const rows = r.relation("rows", { slug: Slug, code: Code, n: pg.integer })
	const { slug, code, n } = v(rows, "row")
	return r.match(rows, { slug, code, n }).find({ slug, code, n })
})

/** The slug and the code two scalar parameters carry, delivered beside each note's id. */
const tagged = query(Notes).rule((r) => {
	const { id } = v(Note, "note")
	return r
		.match(Note, { id })
		.find({ id, slug: r.param("slug", Slug), code: r.param("code", Code) })
})

/** A text inside a pattern about half the time: lowercase letters, or printable ASCII of any length up to twelve. */
const textGen: Gen<string> = oneOf([
	string(codePoint(0x61, 0x7a), { min: 1, max: 6 }),
	string(codePoint(0x20, 0x7e), { min: 0, max: 12 })
])

/** Whether a text is one to `most` ASCII lowercase letters, the language of ^[a-z]{1,most}$. */
const lowercaseOf =
	(most: number) =>
	(text: string): boolean =>
		text.length >= 1 &&
		text.length <= most &&
		Arr.every(
			upTo(text.length, (i) => i),
			(i) => Option.exists(Str.charCodeAt(text, i), (unit) => unit >= 0x61 && unit <= 0x7a)
		)

export const isSlug = lowercaseOf(8)

export const isCode = lowercaseOf(4)

/** One row a case binds: a slug, of no stored field's pattern, and a code, of a stored field's. */
interface Bound {
	readonly slug: string
	readonly code: string
}

interface Case {
	readonly via: "relation" | "scalar"
	readonly rows: ReadonlyArray<Bound>
}

/**
 * The places `rows` bind a value outside its pattern at, as a refusal names each (ParamRejected): a scalar parameter,
 * `slug` or `code`, or the relation parameter `rows`'s field, `slug` or `code`.
 */
export const outsideOf = (
	via: Case["via"],
	rows: ReadonlyArray<Bound>
): ReadonlyArray<ParamPlace> => {
	const named = (field: keyof Bound): ParamPlace =>
		via === "relation" ? { kind: "field", name: "rows", field } : { kind: "scalar", name: field }
	return [
		...(Arr.every(rows, (b) => isSlug(b.slug)) ? [] : [named("slug")]),
		...(Arr.every(rows, (b) => isCode(b.code)) ? [] : [named("code")])
	]
}

const boundGen: Gen<Bound> = (source) => ({
	slug: source.draw(textGen),
	code: source.draw(textGen)
})

export const caseGen: Gen<Case> = (source) => ({
	via: source.draw(element(["relation", "scalar"] as const)),
	rows: source.draw(array(boundGen, { min: 1, max: 4 }))
})

export type Feature =
	| `${Case["via"]} delivered`
	| `${Case["via"]} refused at bind`
	| `${Case["via"]} refused for a slug alone`

export const noteId = "00000000-0000-4000-8000-000000000001"

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const patternsInstall = Object.freeze({ label: "real", programs: { echoed, tagged } })

/** Notes installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const patternsTemplate = fixtureTemplate(import.meta, Notes, patternsInstall)
