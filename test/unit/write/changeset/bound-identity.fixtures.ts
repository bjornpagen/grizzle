import { Array as Arr, String as Str } from "effect"
import { maxStringLength } from "#compiler/core/canonical.ts"
import { isRecord } from "#compiler/core/record.ts"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryOver as query, varsOver as v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import { assert } from "#test/support/assert.ts"

/** Note(id, body): a body of a's and b's, keyed by id. */
const Note = relation("Note", { id: pg.int4, body: str.regex("^[ab]*$") }, ["id"])

const Notes = schema("BoundNotes", [Note], [])

/** The notes inserted as the relation parameter `notes` binds them. */
export const inserted = (): ChangeSetValue =>
	ChangeSet.empty(Notes).insert(
		Note,
		query(Notes).rule((r: RuleValue) => {
			const { id, body } = v(Note, "note")
			return r.match(r.relation("notes", Note), { id, body }).find({ id, body })
		})
	)

/** The notes' count, each body's length, and the box's lengths: one small, and the least whose seven bodies pass the
 * longest string. */
export const count = 7

export const lengths = [4, Math.floor(maxStringLength / count) + 1] as const

export interface BoundCase {
	readonly length: (typeof lengths)[number]
	readonly values: "equal" | "different"
	readonly order: "a-ending first" | "b-ending first"
}

/** Seven notes at `length`, the last ending in `last`, every other body one shared string of a's. */
export const notesOf = (
	shared: string,
	last: "a" | "b"
): ReadonlyArray<{ readonly id: number; readonly body: string }> =>
	Arr.makeBy(count, (i) => ({
		id: i + 1,
		body: i === count - 1 ? `${Str.slice(1)(shared)}${last}` : shared
	}))

/** The last letter of the last note's body of a bound relation input. */
export const lastLetter = (value: unknown): string => {
	if (!Arr.isArray(value)) {
		return assert.fail("a relation input's notes")
	}
	const last: unknown = value.at(-1)
	const body = isRecord(last) ? last["body"] : undefined
	return typeof body === "string" ? Str.slice(-1)(body) : assert.fail("a note's body")
}

export type BoundFeature =
	| "past the longest string"
	| "equal values"
	| "different values"
	| "either order"
