/** What the properties of text-keys.test.ts read: its spaces, models and helpers. */

import { awaitFact } from "@bjornpagen/testing/fact"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { Effect, Option } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { Registration } from "#test/support/live/system.ts"
import { probeAtMember, probeRelation } from "#test/support/live/world.ts"
import { fullWorld } from "#test/support/worlds.ts"

export const BYTE_ORDER_MARK = "\uFEFF"

/** The scalars a drawn text is made of: the byte order mark, one of each UTF-8 length. */
const palette = [BYTE_ORDER_MARK, "a", "é", "€", "😀"] as const

/** A case: each text's scalars. */
type TextsCase = ReadonlyArray<ReadonlyArray<string>>

export const caseGen: Gen<TextsCase> = array(array(element(palette), { min: 1, max: 3 }), {
	min: 1,
	max: 3
})

export type Feature =
	| "a text that begins with U+FEFF"
	| "a text holding U+FEFF after its start"
	| "a text of U+FEFF alone"
	| "a text with no U+FEFF"
	| "several texts in one commit"

/** The login every case serves. */
export const login = "server"

/**
 * A text of up to eight of any scalar PostgreSQL stores (every one but NUL, which no text holds): a drawn text has at
 * most three, and a bound on its length lets `tagged` look a note up by its text through an index.
 */
const Text = str.regex("^.{0,8}$", "su")

/** The schema of a case and its login: notes by a text, the fence's probe, and the reads and the write above. */
export const notebook = (name: string) => {
	const Note = relation("Note", { id: pg.integer, tag: Text }, ["id"])
	const Probe = relation(probeRelation, { id: pg.integer }, ["id"])
	const base = schema(name, [Note, Probe], [])
	const world = fullWorld(
		base,
		{
			tagged: query(base).rule((r) => {
				const { id } = v(Note, "note")
				return r.match(Note, { id, tag: r.param("tag", Text) }).find({ id })
			}),
			all: query(base).rule((r) => {
				const { id, tag } = v(Note, "note")
				return r.match(Note, { id, tag }).find({ id, tag })
			}),
			[probeAtMember]: query(base).rule((r) => {
				const id = r.param("id", pg.integer)
				return r.match(Probe, { id }).find({ id })
			}),
			add: ChangeSet.empty(base).insert(Note, [])
		},
		[]
	)
	return { schema: base, world }
}

/** Whether a registration's subscription is marked, none until it is. */
export const marked = (registration: Registration) =>
	awaitFact(
		Effect.map(registration.state, (state) =>
			state === "marked" ? Option.some(undefined) : Option.none()
		)
	)
