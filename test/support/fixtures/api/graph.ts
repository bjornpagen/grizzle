import { Num, Type } from "#compiler/public/compute.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Id } from "#test/support/ids.ts"

const Person = relation("Person", { id: Id, name: str.regex("^.*$", "su") }, ["id"])
const Follows = relation("Follows", { from: Id, to: Id }, ["from", "to"])

/**
 * Recursion and graphs in public-API form: the Network schema, the Walks
 * recursive relation with computed hop state, the Reachable import that binds its parameter, and the same reachability
 * to two hops as connected matches.
 */
export const Network = schema(
	"Network",
	[Person, Follows],
	[contained(on(Follows, "from"), on(Person, "id")), contained(on(Follows, "to"), on(Person, "id"))]
)

/**
 * The (person, hops) states reachable in zero through four steps. Exported because the compile profile
 * (scripts/dev/profile/phases.ts) lowers every query a fixture module exports.
 */
export const Walks = query(Network).recursive("Walks", {
	row: { person: Id, hops: int4 },
	base: [
		(r) => {
			const { id } = v(Person, "person")
			return r
				.match(Person, { id })
				.where(r.eq(id, r.param("start", Id)))
				.find({ person: id, hops: Type.literal(int4, 0) })
		}
	],
	rec: [
		(r, self) => {
			const { person, hops } = v(self, "self")
			const { to } = v(Follows, "follows")
			return r
				.match(self, { person, hops })
				.match(Follows, { from: person, to })
				.match(Person, { id: to })
				.where(r.lt(hops, 4))
				.find({ person: to, hops: Num.add(hops, Type.literal(int4, 1)) })
		}
	]
})

/** The parameter bound explicitly at the import. */
export const Reachable = query(Network).rule((r) => {
	const source = Walks.bind({ start: r.param("person", Id) })
	const { person } = v(source, "source")
	return r.match(source, { person }).find({ person })
})

/** The people within two steps as connected matches, the join form a recursive lowering is compared with. */
export const withinTwoFollows = query(Network)
	.rule((r) => {
		const { to } = v(Follows, "follows")
		return r
			.match(Follows, { from: r.param("person", Follows.fields.from), to })
			.find({ person: to })
	})
	.rule((r) => {
		const { to: middle } = v(Follows, "middle")
		const { to } = v(Follows, "follows")
		return r
			.match(Follows, { from: r.param("person", Follows.fields.from), to: middle })
			.match(Follows, { from: middle, to })
			.find({ person: to })
	})
