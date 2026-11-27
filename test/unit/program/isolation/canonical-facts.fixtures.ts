/** What canonical-facts.test.ts reads: its drawn login, compiled for READ COMMITTED as generate compiles it. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	derived,
	login,
	on,
	relation,
	role,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { workload } from "#compiler/public/workload.ts"
import { changeLogin } from "#test/support/change-login.ts"

/**
 * A change member of the writer: an insert of a place or of a note, each a relation the stored canonical relation's
 * definition reads, so its upkeep writes the canonical relation's table in the member's own statements; or an insert of
 * a link that reads Linked back, whose lowering reads the canonical relation's table in Linked's join.
 */
export type Write = "a place" | "a note" | "a link read back through Linked"

const writes = [
	"a place",
	"a note",
	"a link read back through Linked"
] as const satisfies ReadonlyArray<Write>

/** A case: the change member the writer's workload holds. */
export const writeGen: Gen<Write> = (source) => source.draw(element(writes))

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

/**
 * The login of a case as its change members compile (test/support/change-login.ts changeLogin), the schema of
 * test/pg/derived/canonical-grants.fixtures.ts: a document's places, notes and links under a unit of the document; a
 * join of a place with its note, a query of that unit alone, which the live relation Linked imports at each link's
 * target, across documents, so the join is an anonymous stored canonical relation (analysis/derived/canonical.ts),
 * `__canonical_<digest>`, read by reference; and one role writing every base relation by the member `write` names,
 * holding each whole, so a read-back over the schema is its own and reads the join through its whole view.
 */
export const canonicalLoginOf = (write: Write) => {
	const base = schema("CanonicalFacts", [Doc, Note, Link], [unit("Document", { doc: pg.integer })])
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
	/** Every linked place's link has a note of its own: a rule over Linked, which reads the join by its name. */
	const top = schema.extend(
		[base],
		"CanonicalFacts_1",
		[Linked],
		[contained(on(Linked, "doc", "at"), on(Note, "doc", "at"))]
	)
	const writer = role(top, "writer", { Doc, Note, Link }, { insert: ["Doc", "Note", "Link"] })
	const member = (() => {
		switch (write) {
			case "a place":
				return ChangeSet.empty(writer).insert(Doc, [])
			case "a note":
				return ChangeSet.empty(writer).insert(Note, [])
			case "a link read back through Linked":
				return ChangeSet.empty(writer)
					.insert(Link, [])
					.read("linked", () =>
						query(top).rule((r) => {
							const { doc, at, v: x } = v(Linked, "linked")
							return r.match(Linked, { doc, at, v: x }).find({ doc, at, v: x })
						})
					)
		}
	})()
	const value = login(top, "app", [writer], { workload: [workload(writer, { member })] })
	return changeLogin(value)
}
