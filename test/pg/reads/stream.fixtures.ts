/** What the properties of stream.test.ts read: its spaces, models and helpers. */

import { type Gen, int } from "@bjornpagen/testing/gen"
import { String as Str } from "effect"
import type { DecodedRow } from "#adapter/reader/stream.ts"
import type { SetEvent } from "#compiler/live/index.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"

export const Note = relation("Note", { id: pg.integer, body: str.regex("^[a-z]*$") }, ["id"])

export const Notes = schema("Notes", [Note], [])

/** Every note: the one read of the login's workload, a member of its full world's role. */
export const all = query(Notes).rule((r) => {
	const { id, body } = v(Note, "note")
	return r.match(Note, { id, body }).find({ id, body })
})

/** A case: the table's rows, n of them, each a text of `width` characters. */
interface Case {
	readonly n: number
	readonly width: number
}

export const caseGen: Gen<Case> = (source) => ({
	n: source.draw(int(2, 12)),
	width: source.draw(int(0, 64))
})

/** The row of id `id` in a case of `width`: its text a letter of its own, `width` times. */
export const rowOf = (
	id: number,
	width: number
): { readonly id: number; readonly body: string } => ({
	id,
	body: Str.repeat(width)(String.fromCharCode(97 + (id % 26)))
})

/** What a consumer of a read's events saw: their kinds in order, its upserts' rows, and its resets' key fields. */
export interface Seen {
	readonly kinds: Array<SetEvent<DecodedRow>["kind"]>
	readonly rows: Array<DecodedRow>
	readonly resetKey: Array<ReadonlyArray<string>>
}
