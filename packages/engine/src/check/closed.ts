import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import type { ClosedRelation, ClosedRelationDesc } from "#compiler/check/schema.ts"
import { unwrap } from "#compiler/core/canonical.ts"
import { childLoc } from "#compiler/core/loc.ts"
import { type ScalarType, textOf } from "#compiler/ir/scalar.ts"
import type {
	ClosedHeading,
	ClosedRelations,
	PayloadPatterns
} from "#compiler/scalar/compute/typing.ts"
import { type MatchAdmission, matchAdmission, matchValueAt } from "#compiler/scalar/regex/admit.ts"
import type { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"

/**
 * The one place check state attaches to a closed relation's description (check/schema.ts ClosedRelation `desc`): the
 * admission of each str.pattern payload field's distinct values, by the field, made where a checked schema first reads
 * the field, in that schema's table (scalar/regex/patterns.ts CompilePatterns spelling), which keeps each pattern's
 * parse and automaton for what its compile reads of it after. A description is immutable and one value however many
 * schemas hold it, every level of a generate's installation and every slice of it among them, so the checked schemas
 * over it share each pattern's one admission and its language, where each checked schema admitted every pattern again.
 * A WeakMap holds nothing alive and is never enumerated: it is the description's state.
 */
const payloadAdmissions = new WeakMap<
	ClosedRelationDesc,
	Map<string, ReadonlyArray<MatchAdmission>>
>()

/**
 * A str.pattern payload field's distinct values in row order, each admitted in `patterns`, once for its description.
 */
const admittedPayload = (
	closed: ClosedRelation,
	field: string,
	position: number,
	patterns: CompilePatterns
): ReadonlyArray<MatchAdmission> => {
	const fields =
		payloadAdmissions.get(closed.desc) ?? new Map<string, ReadonlyArray<MatchAdmission>>()
	payloadAdmissions.set(closed.desc, fields)
	const known = fields.get(field)
	if (known !== undefined) {
		return known
	}
	const sources = new Set<string>()
	for (const row of closed.rows) {
		const value = row[position]
		if (value?.kind === "text") {
			sources.add(value.value)
		}
	}
	const admitted = Object.freeze(
		[...sources].map((source) => matchAdmission(source, patterns.spelling(source)))
	)
	fields.set(field, admitted)
	return admitted
}

/**
 * What a Text.matches pattern reading the payload field `field` at `position` of `closed`'s rows can be: a
 * str.pattern field's distinct values, in row order, each admitted once for the relation's description
 * (admittedPayload), a value no admission admits refused at the relation's rows; any other field's none, which no
 * pattern reads.
 */
const payloadPatterns = (
	closed: ClosedRelation,
	field: string,
	position: number,
	type: ScalarType,
	patterns: CompilePatterns
): PayloadPatterns => {
	if (textOf(type) !== "pattern") {
		return { kind: "other" }
	}
	const admitted = admittedPayload(closed, field, position, patterns)
	const at = childLoc(closed.loc, "rows")
	for (const admission of admitted) {
		unwrap(matchValueAt(admission, at))
	}
	return { kind: "patterns", admitted }
}

/**
 * A closed relation as C.at, C.row and C.has read it: its key fields, its primary fields in key order, which an
 * application's terms meet one by one, and its payload, every other field of its heading, one of which C.at reads,
 * with what a Text.matches pattern reading it can be.
 */
const closedHeading = (closed: ClosedRelation, patterns: CompilePatterns): ClosedHeading => {
	const key = closed.relation.primaryFields
	const payload = closed.heading.flatMap((c, position) =>
		key.some((k) => k.name === c.name)
			? []
			: [
					{
						name: c.name,
						type: c.type,
						patterns: payloadPatterns(closed, c.name, position, c.type, patterns)
					}
				]
	)
	return { key: mapNonEmpty(key, (f) => ({ name: f.name, type: f.type })), payload }
}

/**
 * The closed relations an expression may apply (scalar/compute/typing.ts ClosedRelations): `readable`, by name, each
 * read by its key and its payload, its pattern payloads admitted in `patterns`, the table of the schema's compile. Its
 * caller chooses them: a query reads every closed relation of its schema, a generated field those of its own level or
 * below.
 */
export const closedReads = (
	readable: ReadonlyArray<ClosedRelation>,
	patterns: CompilePatterns
): ClosedRelations => {
	const headings = new Map<string, ClosedHeading>(
		readable.map((c) => [c.name, closedHeading(c, patterns)] as const)
	)
	return Object.freeze({
		kind: "schema",
		heading: (relation: string) => headings.get(relation)
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
		heading: (relation: string) => (names.has(relation) ? reads.heading(relation) : undefined)
	})
}
