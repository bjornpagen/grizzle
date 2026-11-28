/**
 * The box of test/pg/derived/canonical-grants.test.ts: a document's places, notes and links under a unit of the
 * document, a join of a place with its note, a query of that unit alone, which a live relation reads at each link's
 * target, across documents, so the join is an anonymous stored canonical relation (analysis/derived/canonical.ts); a
 * full role, holding every relation of the base whole, whose program reads the live relation, and a partial role,
 * holding the places and the links alone; and the facts each case loads.
 */

import { type Gen, map, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, login, relation, role, schema, unit } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { workload } from "#compiler/public/workload.ts"

const Doc = relation("Doc", { doc: int4, at: int4, v: int4 }, ["doc", "at"])
const Note = relation("Note", { doc: int4, at: int4, body: str.regex("^.*$", "su") }, ["doc", "at"])
const Link = relation("Link", { doc: int4, at: int4, toDoc: int4, toAt: int4 }, ["doc", "at"])

/** The schema under `name`, its roles and its login: the full role's workload reads the live relation. */
export const builtOf = (name: string) => {
	const base = schema(name, [Doc, Note, Link], [unit("Document", { doc: int4 })])
	/** A place of a document with a note: a join within one document, a query of its unit alone. */
	const noted = query(base).rule((r) => {
		const { doc, at, v: x } = v(Doc, "place")
		return r.match(Doc, { doc, at, v: x }).match(Note, { doc, at }).find({ doc, at, v: x })
	})
	/** Each link with the value at the noted place it names, in another document: live, its join split. */
	const Linked = derived(
		"Linked",
		query(base).rule((r) => {
			const { doc, at, toDoc, toAt } = v(Link, "link")
			const { v: x } = v(noted, "target")
			return r
				.match(Link, { doc, at, toDoc, toAt })
				.match(noted, { doc: toDoc, at: toAt, v: x })
				.find({ doc, at, v: x })
		})
	)
	const top = schema.extend([base], `${name}_1`, [Linked], [])
	const linked = query(top).rule((r) => {
		const { doc, at, v: x } = v(Linked, "linked")
		return r.match(Linked, { doc, at, v: x }).find({ doc, at, v: x })
	})
	/** Every relation of the base whole: it sees the join's places and notes whole, and reads Linked in full. */
	const full = role(top, "full", { Doc, Note, Link })
	/** The places and the links whole, the notes not at all: it sees the join's notes nowhere. */
	const partial = role(top, "partial", { Doc, Link })
	return {
		schema: top,
		full,
		partial,
		programs: { linked },
		login: login(top, "server", [full, partial], { workload: [workload(full, { linked })] })
	}
}

/** A case: the documents' places, notes and links, each a row of its relation. */
export interface GrantsCase {
	readonly places: ReadonlyArray<readonly [number, number, number]>
	readonly notes: ReadonlyArray<readonly [number, number]>
	readonly links: ReadonlyArray<readonly [number, number, number, number]>
}

/** Three places of two documents, each with its value. */
const places: ReadonlyArray<readonly [number, number, number]> = [
	[1, 1, 10],
	[1, 2, 20],
	[2, 1, 30]
]

/** A link of document 3 to each place. */
const links: ReadonlyArray<readonly [number, number, number, number]> = [
	[3, 1, 1, 1],
	[3, 2, 1, 2],
	[3, 3, 2, 1]
]

/** The cases: the places and their links, and a note at each place of a drawn set of them, none to all three. */
export const grantsCase: Gen<GrantsCase> = map(
	subset(
		Arr.map(places, ([doc, at]) => [doc, at] as const),
		{ min: 0, max: places.length }
	),
	(notes) => ({ places, notes, links })
)

/** A case's facts, by relation. */
export const factsOf = (c: GrantsCase) => ({
	Doc: Arr.map(c.places, ([doc, at, value]) => ({ doc, at, v: value })),
	Note: Arr.map(c.notes, ([doc, at]) => ({ doc, at, body: `note ${doc}.${at}` })),
	Link: Arr.map(c.links, ([doc, at, toDoc, toAt]) => ({ doc, at, toDoc, toAt }))
})

/** A row of the live relation, as text. */
export const rowText = (row: {
	readonly doc: unknown
	readonly at: unknown
	readonly v: unknown
}): string => `${String(row.doc)}.${String(row.at)}=${String(row.v)}`

/** The live relation's rows, the rule restated: each link whose target place has a note, with that place's value. */
export const linkedRows = (c: GrantsCase): ReadonlyArray<string> =>
	Arr.sort(
		Arr.flatMap(c.links, ([doc, at, toDoc, toAt]) =>
			Arr.flatMap(c.places, ([d, a, value]) =>
				d === toDoc && a === toAt && Arr.some(c.notes, ([nd, na]) => nd === d && na === a)
					? [rowText({ doc, at, v: value })]
					: []
			)
		),
		Order.String
	)
