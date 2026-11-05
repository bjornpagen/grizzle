import { type NonEmptyReadonlyArray, isNonEmpty } from "#compiler/core/nonempty.ts"
import type { LawField, RelationInfo, SpanField } from "#compiler/ir/law.ts"
import { isCarried, isSerialField } from "#compiler/write/insert/statement.ts"

/** A relation's fields its facts carry outside its primary key, in heading order (insert/statement.ts isCarried): none
 * for a pure set, whose primary key is every field its facts carry. A generated field is no payload: PostgreSQL writes
 * it from the row's written fields, so no UPDATE assigns it and two facts equal at those are equal at it. Nor is a
 * drawn or accumulated field: grizzle draws it (rows-first.md §1), so a put of an owner leaves its families as they
 * are. A pure set has no payload: its insert is ON CONFLICT DO NOTHING, and its put displaces nothing and updates
 * nothing in place. */
export type Payload =
	| { readonly kind: "pureSet" }
	| { readonly kind: "keyed"; readonly fields: NonEmptyReadonlyArray<LawField> }

/** The handles of a relation's primary key, as a list of its fields. */
const primaryOf = (relation: RelationInfo): ReadonlyArray<LawField> => relation.primaryFields

export const payloadOf = (relation: RelationInfo): Payload => {
	const fields = relation.heading.filter((f) => !primaryOf(relation).includes(f) && isCarried(f))
	return isNonEmpty(fields) ? { kind: "keyed", fields } : { kind: "pureSet" }
}

/** Whether a serial field lies outside the primary key. Such a field may change with a put's payload, and no UPDATE
 * assigns a serial field, so such a relation's put is the DELETE-then-insert pair. */
export const serialOutsideKey = (relation: RelationInfo): boolean =>
	relation.heading.some((f) => isSerialField(f) && !primaryOf(relation).includes(f))

/** A relation's primary key: scalar, or holding a span field, which makes the key an exclusion constraint, PRIMARY KEY
 * (<scalars>, <span> WITHOUT OVERLAPS), which no inferred ON CONFLICT arbiter and no ON CONFLICT DO UPDATE accepts: its
 * insert is the named-arbiter insert, and its put is never ON CONFLICT DO UPDATE or MERGE. */
export type PrimaryKeyShape =
	| { readonly kind: "scalar" }
	| { readonly kind: "span"; readonly span: SpanField }

export const primaryKeyShape = (relation: RelationInfo): PrimaryKeyShape => {
	const { span } = relation.keyNames[0]
	return span === undefined ? { kind: "scalar" } : { kind: "span", span }
}
