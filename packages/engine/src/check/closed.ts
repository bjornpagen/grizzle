import type { ClosedRelation } from "#compiler/check/schema.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import type {
	ClosedHeading,
	ClosedRelations,
	PayloadPatterns
} from "#compiler/scalar/compute/lower.ts"
import { admitMatch, type MatchAdmission } from "#compiler/scalar/regex/admit.ts"
import type { PatternReads } from "#compiler/schema/walk.ts"

/**
 * What a Compute.matches pattern reading the payload field at `position` of `closed`'s rows can be: where every row's
 * value there is a text, each distinct one, in row order, which a lowering batch reading the field as a pattern admits
 * (admittedReads); else a field no pattern reads.
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
	return { kind: "texts", sources: Object.freeze([...sources]) }
}

/** No payload field admitted: the reads before a lowering batch admits the fields its expressions read (admittedReads). */
const noneAdmitted = (): undefined => undefined

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
	return Object.freeze({
		kind: "schema",
		heading: (relation: string) => headings.get(relation),
		admitted: noneAdmitted
	})
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
		heading: (relation: string) => (names.has(relation) ? reads.heading(relation) : undefined),
		admitted: reads.admitted
	})
}

/**
 * `reads` for a lowering batch whose expressions read `patterns` as Compute.matches patterns (schema/walk.ts
 * patternReads): each such text payload field's distinct values admitted once for the batch, in row order
 * (scalar/regex/admit.ts admitMatch), and no other field's. A field `reads` holds no text payload of is the lowering's
 * to refuse, as it refuses any closed read it cannot make.
 */
export const admittedReads = (reads: ClosedRelations, patterns: PatternReads): ClosedRelations => {
	if (reads.kind === "none") {
		return reads
	}
	const admitted = new Map<string, ReadonlyMap<string, ReadonlyArray<MatchAdmission>>>()
	for (const [relation, fields] of patterns) {
		const heading = reads.heading(relation)
		if (heading === undefined) {
			continue
		}
		const byField = new Map<string, ReadonlyArray<MatchAdmission>>()
		for (const field of fields) {
			const read = heading.payload.find((f) => f.name === field)?.patterns
			if (read?.kind === "texts") {
				byField.set(field, Object.freeze(read.sources.map((source) => admitMatch(source))))
			}
		}
		admitted.set(relation, byField)
	}
	return Object.freeze({
		kind: "schema",
		heading: reads.heading,
		admitted: (relation: string, field: string) => admitted.get(relation)?.get(field)
	})
}
