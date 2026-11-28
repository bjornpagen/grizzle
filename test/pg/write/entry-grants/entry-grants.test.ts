/**
 * A served write through a writable query entry its role is granted column by column reads and writes only what those
 * grants cover, so PostgreSQL never refuses it 42501 (sql/bind.ts `written`): a put's displacing DELETE and an exact
 * deletion are driven by their facts, which bind the target at its key, and the binding reads the target through its
 * index as the inner of a nested loop over them, where it read the target at the tuple ids a probe of it found, a
 * system column PostgreSQL checks against the table's SELECT alone, which a column-granted writer does not hold
 * (test/pg/live/errors, "an edit of a held note": the write failed "permission denied for table note").
 *
 * The box: Note(id, author, body) with ann's note and bob's stored, written by ann (subject 1) through MyNote, whose
 * writer holds SELECT and INSERT of each field, UPDATE of the body and DELETE of the table (entry-grants.fixtures.ts):
 * a put of her note unchanged, one with another body, one of a new note, and a delete of her note.
 *
 * Oracle: the model of each write (entry-grants.fixtures.ts modelOf): its outcome, accepted where it changes a row and
 * unchanged otherwise, and the notes the owner reads back after it.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Result } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	modelOf,
	type NoteRow,
	notesAt,
	notesTemplate,
	storedNotes,
	type Write,
	writeGen
} from "#test/pg/write/entry-grants/entry-grants.fixtures.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { servedFixture } from "#test/support/served-db.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { tokenOf } from "#test/support/worlds.ts"

/** A note as the owner reads it back: its id, author and body, each as text, joined by " | ". */
const rowText = (n: NoteRow): string => `${n.id} | ${n.author} | ${n.body}`

/** A served write through a column-granted query entry reads and writes only what its grants cover. */
export const aWriteThroughAColumnGrantedQueryEntryReadsAndWritesOnlyWhatItsGrantsCover =
	property.exhaust(finite(writeGen), {
		needs: { notes: Substrate.fresh(notesTemplate) },
		situations: [
			"put unchanged",
			"put another body",
			"put a new note",
			"delete her note"
		] satisfies ReadonlyArray<Reached<Write>>,
		check:
			({ notes }, c: Case<Write>) =>
			(write) =>
				Effect.scoped(
					Effect.flatMap(notes, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const m = taken.value
								const notesOf = notesAt(m.declared)
								const s = yield* Substrate
								const owner = yield* s.session({ ...ownerSession(), label: "notes owner" })
								const names = namesOf(m)
								const table = names.table(notesOf.Note)
								const columns = Arr.join(
									Arr.map(["id", "author", "body"] as const, (f) => names.column(notesOf.Note, f)),
									", "
								)
								yield* owner.query(
									`INSERT INTO ${table} (${columns}) VALUES ${Arr.join(
										Arr.map(storedNotes, (n) => `(${n.id}, ${n.author}, ${n.body})`),
										", "
									)}`,
									[]
								)
								const served = yield* servedFixture(m, notesOf.login)
								const model = modelOf(write)
								const applied = yield* Effect.gen(function* () {
									const db = yield* Db.open(served.login.roles.writer, {
										token: tokenOf({ sub: 1 })
									})
									return yield* Effect.result(
										writeAnswerOf(
											model.op === "put"
												? db.workload.put.once({
														params: {},
														facts: { put: { MyNote: [model.fact] } }
													})
												: db.workload.remove.once({
														params: {},
														facts: { delete: { MyNote: [model.fact] } }
													})
										)
									)
								}).pipe(withLayer(served.layer))
								if (Result.isFailure(applied)) {
									return assert.fail(
										`ann's ${write} failed with ${applied.failure._tag}: ${applied.failure.message}`
									)
								}
								c.note(write)
								assert.equal(
									applied.success._tag,
									model.changed ? "accepted" : "unchanged",
									`ann's ${write}: its outcome`
								)
								const after = yield* owner.values(`SELECT ${columns} FROM ${table} ORDER BY 1`, [])
								assert.deepEqual(
									Arr.map(after, (r) => Arr.join(Arr.map(r, String), " | ")),
									Arr.map(model.after, rowText),
									`ann's ${write}: the notes after it`
								)
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "each write's model over ann's and bob's notes (entry-grants.fixtures.ts modelOf): its outcome and the notes after it"
		},
		box: "ann's note and bob's, ann's put of her note unchanged, with another body or of a new note, and her delete of it, through MyNote, granted column by column",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/bind.ts",
				original: "\t\t\tconst drivenWhere = conjunction(where.map((x) => rename.expr(x)))\n",
				replacement:
					"\t\t\tconst drivenWhere = conjunction([eq(col(alias, tupleId), col(alias, tupleId)), ...where.map((x) => rename.expr(x))])\n",
				why: "The target read at its tuple id again, a system column PostgreSQL checks against the table's SELECT, which a column-granted writer does not hold: ann's put of another body and her delete are refused 42501, permission denied for table note, as test/pg/live/errors' edit was."
			}
		]
	})
