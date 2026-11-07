import type { ClosedRelation } from "#compiler/check/schema.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import type { ClosedHeading, ClosedRelations } from "#compiler/scalar/compute/lower.ts"

/**
 * A closed relation as C.at, C.row and C.has read it: its key fields, its primary fields in key order, which an
 * application's terms meet one by one, and its payload, every other field of its heading, one of which C.at reads,
 * with each row's value there, which a Compute.matches pattern reading it can be.
 */
const closedHeading = (closed: ClosedRelation): ClosedHeading => {
	const key = closed.relation.primaryFields
	const payload = closed.heading.flatMap((c, position) =>
		key.some((k) => k.name === c.name)
			? []
			: [
					{
						name: c.name,
						type: c.type,
						values: closed.rows.flatMap((row) => {
							const value = row[position]
							return value === undefined ? [] : [value]
						})
					}
				]
	)
	return { key: mapNonEmpty(key, (f) => ({ name: f.name, type: f.type })), payload }
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

/**
 * The closed relations of `reads`, a schema's, that an expression may apply when it may apply only `readable` of them:
 * a generated field's, those of its own level or below. Each heading is the one `reads` read once for the schema, so
 * no relation's heading is read again for each relation that reads it.
 */
export const closedReadsAmong = (
	reads: ClosedRelations,
	readable: ReadonlyArray<ClosedRelation>
): ClosedRelations => {
	if (reads.kind === "none") {
		return reads
	}
	const names = new Set(readable.map((c) => c.name))
	return Object.freeze({
		kind: "schema",
		heading: (relation: string) => (names.has(relation) ? reads.heading(relation) : undefined)
	})
}
