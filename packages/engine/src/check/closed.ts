import type { ClosedRelation } from "#compiler/check/schema.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import type {
	ClosedHeading,
	ClosedRelations,
	PayloadPatterns
} from "#compiler/scalar/compute/lower.ts"
import { admitMatch } from "#compiler/scalar/regex/admit.ts"

/**
 * What a Compute.matches pattern reading the payload field at `position` of `closed`'s rows can be: where every row's
 * value there is a text, each distinct one, in row order, admitted once (scalar/regex/admit.ts admitMatch), so no
 * lowering of a match over the field admits one again; else a field no pattern reads.
 */
const payloadPatterns = (closed: ClosedRelation, position: number): PayloadPatterns => {
	const sources = new Set<string>()
	for (const row of closed.rows) {
		const value = row[position]
		if (value !== undefined) {
			if (value.kind !== "text") {
				return { kind: "other" }
			}
			sources.add(value.value)
		}
	}
	return {
		kind: "texts",
		admitted: Object.freeze([...sources].map((source) => admitMatch(source)))
	}
}

/**
 * A closed relation as C.at, C.row and C.has read it: its key fields, its primary fields in key order, which an
 * application's terms meet one by one, and its payload, every other field of its heading, one of which C.at reads,
 * with what a Compute.matches pattern reading it can be.
 */
const closedHeading = (closed: ClosedRelation): ClosedHeading => {
	const key = closed.relation.primaryFields
	const payload = closed.heading.flatMap((c, position) =>
		key.some((k) => k.name === c.name)
			? []
			: [{ name: c.name, type: c.type, patterns: payloadPatterns(closed, position) }]
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
