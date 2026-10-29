import { Compute } from "#compiler/public/compute.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"

const Person = relation("Person", { id: uuid, name: str.regex("^.*$", "su") }, ["id"])
const Follows = relation("Follows", { from: uuid, to: uuid }, ["from", "to"])

/**
 * Recursion and graphs in public-API form: the Network schema, the Walks
 * recursive relation with computed hop state, the Reachable import that binds its parameter, and the same reachability
 * to two hops as connected matches.
 */
export const Network = schema("Network", { Person, Follows }, [
	contained(on(Follows, "from"), on(Person, "id")),
	contained(on(Follows, "to"), on(Person, "id"))
])

/**
 * The (person, hops) states reachable in zero through four steps. Exported because the compile profile
 * (scripts/dev/profile/phases.ts) lowers every query a fixture module exports.
 */
export const Walks = query(Network).recursive("Walks", {
	row: { person: uuid, hops: pg.integer },
	base: [
		(r) => {
			const { id } = v(Person)
			return r
				.match(Person, { id })
				.where(r.eq(id, r.param("start", uuid)))
				.find({ person: id, hops: Compute.literal(pg.integer, 0) })
		}
	],
	rec: [
		(r, self) => {
			const { person, hops } = v(self)
			const { to } = v(Follows)
			return r
				.match(self, { person, hops })
				.match(Follows, { from: person, to })
				.match(Person, { id: to })
				.where(r.lt(hops, 4))
				.find({ person: to, hops: Compute.add(hops, Compute.literal(pg.integer, 1)) })
		}
	]
})

/** The parameter bound explicitly at the import. */
export const Reachable = query(Network).rule((r) => {
	const source = Walks.bind({ start: r.param("person", uuid) })
	const { person } = v(source)
	return r.match(source, { person }).find({ person })
})

/** The people within two steps as connected matches, the join form a recursive lowering is compared with. */
export const withinTwoFollows = query(Network)
	.rule((r) => {
		const { to } = v(Follows)
		return r
			.match(Follows, { from: r.param("person", Follows.fields.from), to })
			.find({ person: to })
	})
	.rule((r) => {
		const { to: middle } = v(Follows)
		const { to } = v(Follows)
		return r
			.match(Follows, { from: r.param("person", Follows.fields.from), to: middle })
			.match(Follows, { from: middle, to })
			.find({ person: to })
	})
