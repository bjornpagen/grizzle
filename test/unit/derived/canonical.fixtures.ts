/**
 * The box of test/unit/derived/canonical.test.ts: a document's places and notes under a unit of the document, a join of
 * a place with its note, a query of that unit alone, and a derived relation that reads it at a link's target, across
 * documents, so it is live; beside it no other derived relation, one whose definition is that very query, or one whose
 * definition is the same join spelled anew under other scope names, alpha-equivalent to it.
 */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import type { InferredQuery } from "#compiler/ir/desc.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema, unit } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { decodedQuery } from "#test/support/fixtures/ir/desc.ts"

const Doc = relation("Doc", { doc: pg.integer, at: pg.integer, v: pg.integer }, ["doc", "at"])
const Note = relation("Note", { doc: pg.integer, at: pg.integer, body: str.regex("^.*$", "su") }, [
	"doc",
	"at"
])
const Link = relation(
	"Link",
	{ doc: pg.integer, at: pg.integer, toDoc: pg.integer, toAt: pg.integer },
	["doc", "at"]
)
const documentUnit = unit("Document", { doc: pg.integer })

const base = schema("CanonicalForms", [Doc, Note, Link], [documentUnit])

/** A place of a document with a note: a join within one document, a query of its unit alone. */
const noted = query(base).rule((r) => {
	const { doc, at, v: x } = v(Doc, "place")
	return r.match(Doc, { doc, at, v: x }).match(Note, { doc, at }).find({ doc, at, v: x })
})

/** `noted` spelled anew, its scopes named otherwise: alpha-equivalent to it, another Description. */
const notedAnew = query(base).rule((r) => {
	const { doc: d, at: a, v: y } = v(Doc, "located")
	return r
		.match(Doc, { doc: d, at: a, v: y })
		.match(Note, { doc: d, at: a })
		.find({ doc: d, at: a, v: y })
})

/** The derived relation that reads `noted` at each link's target, across documents: live, its join split. */
export const linkedName = "Linked"

const linked = derived(
	linkedName,
	query(base).rule((r) => {
		const { doc, at, toDoc, toAt } = v(Link, "link")
		const { v: x } = v(noted, "target")
		return r
			.match(Link, { doc, at, toDoc, toAt })
			.match(noted, { doc: toDoc, at: toAt, v: x })
			.find({ doc, at, v: x })
	})
)

/** The name of the derived relation whose definition is the join where the case names one. */
export const joinedName = "Joined"

/**
 * Beside the live relation, which derived relation states the join: `none`; `same`, one whose definition is `noted`,
 * the query the live relation imports; or `alpha`, one whose definition is `notedAnew`.
 */
export type Naming = "none" | "same" | "alpha"

const namings = ["none", "same", "alpha"] as const satisfies ReadonlyArray<Naming>

export const namingCase: Gen<Naming> = (s) => s.draw(element(namings))

/** The case's schema, the base and above it the live relation and the named join where the case states one. */
export const canonicalSchemaOf = (naming: Naming) => {
	switch (naming) {
		case "none":
			return schema.extend([base], "CanonicalFormsTop", [linked], [])
		case "same":
			return schema.extend([base], "CanonicalFormsTop", [linked, derived(joinedName, noted)], [])
		case "alpha":
			return schema.extend(
				[base],
				"CanonicalFormsTop",
				[linked, derived(joinedName, notedAnew)],
				[]
			)
	}
}

/** A read of every row of the live relation: one rule matching it, each field bound and delivered by its name. */
export const linkedRead = (): InferredQuery => {
	const fields = ["at", "doc", "v"]
	return decodedQuery({
		kind: "rules",
		arms: [
			{
				vars: Arr.map(fields, (field) => ({ id: field, origin: { relation: linkedName, field } })),
				matches: [
					{
						source: { kind: "relation", name: linkedName },
						bindings: Rec.fromEntries(
							Arr.map(fields, (field) => [field, { kind: "var" as const, var: field }] as const)
						)
					}
				],
				where: [],
				head: Rec.fromEntries(
					Arr.map(fields, (field) => [field, { kind: "var" as const, var: field }] as const)
				),
				interiors: [],
				attach: []
			}
		]
	})
}
