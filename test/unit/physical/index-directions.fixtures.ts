/** What the properties of index-directions.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { type Direction, directions, opposite } from "#compiler/core/order.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { paged } from "#compiler/public/workload.ts"
import { Id } from "#test/support/ids.ts"

/** A direction vector over the order's three columns, a, b and id, in that order. */
type Vector = readonly [Direction, Direction, Direction]

const T = relation("T", { id: Id, g: Id, a: int4, b: int4 }, ["id"])

export const Dirs = schema("Dirs", [T], [])

export const reversed = (vector: Vector): Vector => [
	opposite(vector[0]),
	opposite(vector[1]),
	opposite(vector[2])
]

/** The class's key: the one of a vector and its exact reverse whose first key ascends, whichever an index states. */
export const canonical = (vector: Vector): Vector =>
	vector[0] === "asc" ? vector : reversed(vector)

/** An index's three order keys' directions as a vector. */
export const vectorOf = (dirs: ReadonlyArray<Direction>): Vector => [
	defined(dirs[0], "an order key on a"),
	defined(dirs[1], "an order key on b"),
	defined(dirs[2], "an order key on id")
]

export const text = (vector: ReadonlyArray<Direction>): string => Arr.join(vector, " ")

/** The paged program ordering T by `vector`, behind an equality on g when `prefixed`: its pages read the order from an
 * index, forward and backward (program/workload/value.ts pagedMember). */
export const program = (vector: Vector, prefixed: boolean) =>
	paged(
		query(Dirs)
			.rule((r) => {
				const { id, g, a, b } = v(T, "t")
				const matched = r.match(T, { id, g, a, b })
				return (prefixed ? matched.where(r.eq(g, r.param("g", Id))) : matched).find({ id, a, b })
			})
			.orderBy(["a", vector[0]], ["b", vector[1]], ["id", vector[2]])
	)

const dirGen = element(directions)

const vectorGen: Gen<Vector> = (source) =>
	[source.draw(dirGen), source.draw(dirGen), source.draw(dirGen)] as const

/** A family of vectors, each drawn or the exact reverse of an earlier one, and whether every program is prefixed. */
export const caseGen: Gen<{
	readonly vectors: ReadonlyArray<Vector>
	readonly prefixed: boolean
}> = (source) => {
	const drawnVectors = source.draw(
		array((source) => [source.draw(vectorGen), source.draw(boolean)] as const, { min: 1, max: 5 })
	)
	return {
		vectors: Arr.map(drawnVectors, ([vector, reverse], i): Vector => {
			const earlier = drawnVectors[i - 1]
			return reverse && earlier !== undefined ? reversed(earlier[0]) : vector
		}),
		prefixed: source.draw(boolean)
	}
}

export type DirectionFeature =
	| "an exact reverse pair"
	| "a mixed vector"
	| "an all-descending vector"
	| "two classes"
	| "a prefix"
