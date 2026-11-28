/** What the property of entry-grants.test.ts reads: its schema, its space and its model. */
import { element, type Gen } from "@bjornpagen/testing/gen"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { context, login, mutable, relation, role, schema, unit } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { migratedOnceTemplate } from "#test/support/installed.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"

/**
 * A writer's notes, each its author's while the session's subject is its author (test/pg/live/errors' notebook): Note(id,
 * author, body), mutable in the unit of its id, written by `writer` only through its writable query entry MyNote, which
 * the installation grants it column by column, SELECT and INSERT of each field, UPDATE of the body the entry leaves
 * free and DELETE of the table, under a row policy whose membership is the entry's: a role's least privilege
 * (physical/ddl/roles.ts). Its workload puts and deletes facts of MyNote.
 */
export const notesAt = (name: string) => {
	const Note = relation("Note", { id: int4, author: int4, body: int4 }, ["id"])
	const base = schema(name, [Note], [mutable(Note), unit("Noted", { id: int4 })])
	const Session = context("Session", { sub: int4 })
	const mine = query(base).rule((r) => {
		const { id, author, body } = v(Note, "note")
		return r
			.match(Note, { id, author, body })
			.match(Session, { sub: author })
			.find({ id, author, body })
	})
	const writer = role(base, "writer", { MyNote: mine }, { write: ["MyNote"], contexts: [Session] })
	return {
		Note,
		writer,
		login: login(base, "notes", [writer], {
			workload: [
				workload(writer, {
					put: ChangeSet.empty(writer).put(writer.relations.MyNote, []),
					remove: ChangeSet.empty(writer).delete(writer.relations.MyNote, [])
				})
			]
		}),
		base
	}
}

/** The notes installed once per member through their generated migration, each case's clone of them. */
export const notesTemplate = migratedOnceTemplate({
	declaredIn: import.meta,
	name: "entry grants",
	options: {
		label: "notes",
		first: (name) => {
			const notes = notesAt(name)
			return { schema: notes.base, logins: [notes.login] }
		},
		later: [],
		apply: { kind: "noPlaceholders" },
		declared: () => noDeclarations
	}
})

/** A note as MyNote holds it. */
export interface NoteRow {
	readonly id: number
	readonly author: number
	readonly body: number
}

/** The stored notes every case starts from: ann's (author 1) and bob's (author 2). */
export const storedNotes: ReadonlyArray<NoteRow> = [
	{ id: 1, author: 1, body: 1 },
	{ id: 2, author: 2, body: 1 }
]

/**
 * A write ann (subject 1) makes through MyNote: a put of her note as it stands, which changes nothing; a put of it with
 * another body, which displaces the stored fact at its key (write/put/choose.ts: the DELETE-then-insert pair a mutable
 * relation's put of a fact that differs is, its DELETE driven by the put's facts); a put of a new note; or a delete of
 * her note as it stands, an exact deletion driven by its fact.
 */
export type Write = "put unchanged" | "put another body" | "put a new note" | "delete her note"

export const writeGen: Gen<Write> = element([
	"put unchanged",
	"put another body",
	"put a new note",
	"delete her note"
] as const)

/** What the write states, its op and its one fact, and the notes after it: the model. */
export const modelOf = (
	write: Write
): {
	readonly op: "put" | "delete"
	readonly fact: NoteRow
	readonly changed: boolean
	readonly after: ReadonlyArray<NoteRow>
} => {
	switch (write) {
		case "put unchanged":
			return { op: "put", fact: { id: 1, author: 1, body: 1 }, changed: false, after: storedNotes }
		case "put another body":
			return {
				op: "put",
				fact: { id: 1, author: 1, body: 2 },
				changed: true,
				after: [
					{ id: 1, author: 1, body: 2 },
					{ id: 2, author: 2, body: 1 }
				]
			}
		case "put a new note":
			return {
				op: "put",
				fact: { id: 3, author: 1, body: 1 },
				changed: true,
				after: [...storedNotes, { id: 3, author: 1, body: 1 }]
			}
		case "delete her note":
			return {
				op: "delete",
				fact: { id: 1, author: 1, body: 1 },
				changed: true,
				after: storedNotes.slice(1)
			}
	}
}
