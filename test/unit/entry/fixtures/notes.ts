/**
 * A schema module written with the authoring entry's builders: closed values, text refinements (str.regex, whose
 * admission analyzes the pattern and chooses its CHECK as it is built), a containment, a query with a parameter, a
 * ChangeSet, roles and a login with its workloads.
 */
import * as g from "@bjornpagen/grizzle"

const Slug = g.str.regex("^[a-z0-9-]{1,96}$")
const Prose = g.str.regex("^.*$", "su")

export const Status = g.closed.ordered("Status", ["Draft", "Published"])
export const Note = g.relation("Note", { slug: Slug, body: Prose, status: g.closedId(Status) }, [
	"slug"
])
export const Views = g.relation("Views", { note: Slug, views: g.int8 }, ["note"])
export const Notes = g.schema(
	"Notes",
	[Status, Note, Views],
	[g.contained(g.on(Views, "note"), g.on(Note, "slug"))]
)

/** A published note by its slug. */
export const published = g.query(Notes).rule((r) => {
	const { slug, body } = g.v(Note, "note")
	return r
		.match(Note, { slug, body, status: "Published" })
		.where(r.eq(slug, r.param("slug", Slug)))
		.find({ slug, body })
})

const reader = g.role(Notes, "reader", g.wholeEntriesOf(Notes))
const writer = g.role(Notes, "writer", g.wholeEntriesOf(Notes), g.wholeWritesOf(Notes))

export const Web = g.login(Notes, "web", [reader, writer], {
	workload: [
		g.workload(Notes, { published }),
		g.workload(writer, { addNote: g.ChangeSet.empty(writer).insert(Note, []) })
	]
})
