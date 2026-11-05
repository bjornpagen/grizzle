import type { ClosedRelation } from "#compiler/check/schema.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import type { ClosedHeading, ClosedRelations } from "#compiler/scalar/compute/lower.ts"

/**
 * A closed relation as C.at and C.row read it: its key fields, its primary fields in key order, which an application's
 * terms meet one by one, and its payload, every other field of its heading, one of which C.at reads.
 */
const closedHeading = (closed: ClosedRelation): ClosedHeading => {
	const key = closed.relation.primaryFields
	const payload = closed.heading.filter((c) => !key.some((k) => k.name === c.name))
	return {
		key: mapNonEmpty(key, (f) => ({ name: f.name, type: f.type })),
		payload: payload.map((c) => ({ name: c.name, type: c.type }))
	}
}

/**
 * The closed relations an expression may apply (scalar/compute/lower.ts ClosedRelations): `readable`, by name, each
 * read by its key and its payload. Its caller chooses them: a query reads every closed relation of its schema, a
 * generated field those of its own level or below.
 */
export const closedReads = (readable: ReadonlyArray<ClosedRelation>): ClosedRelations => {
	const headings = new Map<string, ClosedHeading>(
		readable.map((c) => [c.name, closedHeading(c)] as const)
	)
	return Object.freeze({ kind: "schema", heading: (relation: string) => headings.get(relation) })
}
