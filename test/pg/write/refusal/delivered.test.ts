import { assert, failureOf } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Layer, Option } from "effect"
import { Db } from "#adapter/public/db.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import {
	Account,
	type Artifact,
	attachments,
	Badge,
	type DeliveredFeature,
	deliveredOf,
	type Drawn,
	drawnGen,
	Note,
	type NoteFact,
	Notes,
	notesInstall,
	notesTemplate,
	Profile,
	rowsAt,
	Tag
} from "#test/pg/write/refusal/delivered.fixtures.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { conservativeServedJson, servedFixtureOf } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A read-back attachment's delivered type, checked inside its statement a breach of any delivered type in any form aborts the write, in both artifacts, and every other state commits and delivers its proved types.
 *
 * Its pre-conversion budget: runs 48, coverage cases 96 (test/pg/write/refusal/delivered.test.ts at d8eed1786).
 */
export const aReadBackAttachmentsDeliveredTypeCheckedInsideItsStatementABreachOfAnyDeliveredTypeInAnyFormAbortsTheWriteInBothArtifactsAndEveryOtherStateCommitsAndDeliversItsProvedTypes =
	property.explore(drawnGen, {
		needs: { notes: Substrate.seat(notesTemplate) },
		situations: [
			"holder breached",
			"marker breached",
			"badge breached",
			"profile breached",
			"a stored note's attachment breached",
			"no holder, committed",
			"optimized: every delivered type proved, committed",
			"conservative: every delivered type proved, committed",
			"optimized: a breach aborts the write",
			"conservative: a breach aborts the write"
		] satisfies ReadonlyArray<Reached<DeliveredFeature>>,
		check:
			({ notes }, c: Case<DeliveredFeature>) =>
			(d) =>
				Effect.gen(function* () {
					const seat = yield* notes
					const sub = seat.substrate
					const o = yield* openedIn(Notes, {}, notesInstall, seat)
					const conservativeJson = yield* conservativeServedJson(
						o.installed,
						o.server,
						o.server.workload
					)
					const conservative = servedFixtureOf(o.installed, o.server, conservativeJson)
					const names = namesOf(o.installed)
					const sql = (text: string) => sub.admin.queryValues(text, [])
					const stored = (id: number) =>
						Effect.map(
							sql(
								`SELECT count(*)::text FROM ${names.table(Note)} WHERE ${names.column(Note, "id")} = ${id}`
							),
							(rows) => Number(rows[0]?.[0])
						)
					/** Writes a drawn state whole, every table emptied first. */
					const stateOf = (d: Drawn) => {
						const values = (rows: ReadonlyArray<string>): string => Arr.join(rows, ", ")
						const accountRows = Arr.flatMap(d.accounts, (a, i) =>
							Arr.map(a.names, (name) => `(${i + 1}, '${name}', 'c', 's', 'z', 'k')`)
						)
						const badgeRows = Arr.flatMap(d.accounts, (a, i) =>
							Arr.map(a.badges, (label) => `(${i + 1}, '${label}')`)
						)
						const profileRows = Arr.flatMap(d.accounts, (a, i) =>
							Arr.map(a.profiles, (x) => `(${i + 1}, '${x}', 'b', 'c', 'd', 'e')`)
						)
						const tagRows = Arr.map(d.tags, (id) => `(${id})`)
						const noteRows = Arr.map(d.stored, (n) => `(${n.id}, ${n.account}, ${n.tag})`)
						const insert = (
							table: string,
							columns: ReadonlyArray<string>,
							rows: ReadonlyArray<string>
						): ReadonlyArray<string> =>
							Arr.isReadonlyArrayNonEmpty(rows)
								? [`INSERT INTO ${table} (${Arr.join(columns, ", ")}) VALUES ${values(rows)}`]
								: []
						return [
							`TRUNCATE ${Arr.join(Arr.map([Note, Account, Tag, Badge, Profile], names.table), ", ")}`,
							...insert(
								names.table(Account),
								Arr.map(["id", "name", "city", "street", "zip", "country"] as const, (f) =>
									names.column(Account, f)
								),
								accountRows
							),
							...insert(names.table(Tag), [names.column(Tag, "id")], tagRows),
							...insert(
								names.table(Badge),
								Arr.map(["account", "label"] as const, (f) => names.column(Badge, f)),
								badgeRows
							),
							...insert(
								names.table(Profile),
								Arr.map(["account", "a", "b", "c", "d", "e"] as const, (f) =>
									names.column(Profile, f)
								),
								profileRows
							),
							...insert(
								names.table(Note),
								Arr.map(["id", "account", "tag"] as const, (f) => names.column(Note, f)),
								noteRows
							)
						]
					}
					return yield* Effect.gen(function* () {
						const optimizedContext = yield* Layer.build(o.served.layer)
						const optimizedDb = yield* Db.open(o.served.login.roles.app, {}).pipe(
							Effect.provideContext(optimizedContext)
						)
						const conservativeContext = yield* Layer.build(conservative.layer)
						const conservativeDb = yield* Db.open(conservative.login.roles.app, {}).pipe(
							Effect.provideContext(conservativeContext)
						)
						/** The write of `note` by the artifact's served file: the optimized one, or the conservative one. */
						const run = (artifact: Artifact, note: NoteFact) =>
							(artifact === "optimized" ? optimizedDb : conservativeDb).workload.write.once({
								params: {},
								facts: { insert: { Note: [note] } }
							})
						for (const statement of stateOf(d)) {
							yield* sql(statement)
						}
						const every = [...d.stored, d.note]
						const delivered = Arr.map(every, (note) => ({ note, by: deliveredOf(d, note) }))
						const breached = Arr.flatMap(delivered, ({ note, by }) =>
							Arr.flatMap(attachments, (attachment) => {
								const one = by[attachment]
								return one.kind === "breached" ? [{ note, attachment, type: one.type }] : []
							})
						)
						const label = `${d.artifact}: ${Formatter.format(d)}`
						if (Arr.isReadonlyArrayNonEmpty(breached)) {
							const failure = yield* failureOf(run(d.artifact, d.note))
							assert.equal(
								failure.kind,
								"failed",
								`${label}: the server's failure of the write, got ${Formatter.format(failure)}`
							)
							const kept = yield* stored(d.note.id)
							assert.equal(kept, 0, `${label}: nothing committed`)
							for (const b of breached) {
								c.note(`${b.attachment} breached`)
								if (b.note.id !== d.note.id) {
									c.note("a stored note's attachment breached")
								}
							}
							c.note(`${d.artifact}: a breach aborts the write`)
							return
						}
						const outcome = yield* writeAnswerOf(run(d.artifact, d.note))
						if (outcome.kind !== "accepted") {
							return assert.fail(`${label}: a state with no breach answered ${outcome.kind}`)
						}
						for (const { note, by } of delivered) {
							const row = Option.getOrThrowWith(
								Arr.findFirst(outcome.reads.notes, (r) => r.id === note.id),
								() => new Error(`${label}: note ${note.id} read back`)
							)
							for (const attachment of attachments) {
								const expected = by[attachment]
								const got: Option.Option<unknown> = row[attachment]
								const want: Option.Option<unknown> =
									expected.kind === "delivered" ? expected.value : Option.none()
								assert.deepEqual(got, want, `${label}: note ${note.id}'s ${attachment}`)
							}
						}
						assert.equal(outcome.reads.notes.length, every.length, `${label}: every note`)
						const committed = yield* stored(d.note.id)
						assert.equal(committed, 1, `${label}: the note committed`)
						if (rowsAt(d, d.note.account, (a) => a.names).length === 0) {
							c.note("no holder, committed")
						}
						c.note(`${d.artifact}: every delivered type proved, committed`)
					}).pipe(Effect.scoped)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "specification",
			name: "the delivered types' model: a bare child breaks without a child, an option with two, over every note read back"
		},
		budget: { runs: 48, steered: 96 },
		kept: [],
		kills: []
	})
