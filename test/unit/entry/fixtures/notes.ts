/**
 * A schema module written with the authoring entry's builders: closed values, text refinements (str.regex, whose
 * admission analyzes the pattern and chooses its CHECK as it is built), a containment, a query with a parameter, a
 * ChangeSet, roles and a login with its workloads.
 */
import {
	ChangeSet,
	closed,
	closedId,
	contained,
	login,
	on,
	pg,
	query,
	relation,
	role,
	schema,
	str,
	v,
	wholeEntriesOf,
	workload,
	wholeWritesOf
} from "@bjornpagen/grizzle"

const Slug = str.regex("^[a-z0-9-]{1,96}$")
const Prose = str.regex("^.*$", "su")

export const Status = closed.ordered("Status", ["Draft", "Published"])
export const Note = relation("Note", { slug: Slug, body: Prose, status: closedId(Status) }, [
	"slug"
])
export const Views = relation("Views", { note: Slug, views: pg.bigint }, ["note"])
export const Notes = schema(
	"Notes",
	[Status, Note, Views],
	[contained(on(Views, "note"), on(Note, "slug"))]
)

/** A published note by its slug. */
export const published = query(Notes).rule((r) => {
	const { slug, body } = v(Note, "note")
	return r
		.match(Note, { slug, body, status: "Published" })
		.where(r.eq(slug, r.param("slug", Slug)))
		.find({ slug, body })
})

const reader = role(Notes, "reader", wholeEntriesOf(Notes))
const writer = role(Notes, "writer", wholeEntriesOf(Notes), wholeWritesOf(Notes))

export const Web = login(Notes, "web", [reader, writer], {
	workload: [
		workload(Notes, { published }),
		workload(writer, { addNote: ChangeSet.empty(writer).insert(Note, []) })
	]
})
