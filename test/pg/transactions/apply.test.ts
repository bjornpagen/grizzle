/**
 * A change member's apply on a served Db: what it decides before and around its one transaction, over drawn cases,
 * every ChangeSet a member of the role's workload, served through the login's served file, and each call's facts drawn.
 * The outcome mapping over generated ChangeSets is the three-way write oracle's (test/support/oracle/write); this space
 * holds what it does not drive:
 *
 * - the empty ChangeSet is no-change, its read-backs an empty record, once its transaction, its frame alone, committed;
 * - a ChangeSet whose relation parameter is a call's Stream collects the Stream anew at each application: applied
 *   twice with the same Stream of drawn wanted tasks, its notes deleted between, it adds a note for each that a Task
 *   holds both times;
 * - a ChangeSet over a base level of the Db's schema applies the call's drawn notes;
 * - a ChangeSet writing a relation outside the role's write list is refused where the login's served file is compiled,
 *   at its member, with the CompileError OutsideRole; one over a sibling with Work's relations and other statements, or
 *   over an extension of the Db's schema, is refused where its workload is built, MalformedDescription, as its schema
 *   is no level of the role's; and the stored state is as it was;
 * - a failed acquisition is TransportFailure{stage: "acquire"}, from a member loaded while the credential still worked.
 *
 * The Db runs on a tapped pool whose first session is warmed, so a window of the tap holds one call's traffic. Every
 * refusal leaves the stored state as it was.
 *
 * - Oracle: the specification turned into a checker, the outcome the drawn facts and the role's write list decide.
 * - Features: each kind of ChangeSet, both tasks noted, a wanted task no Task holds, and an empty note.
 * - Plant: ~/.cache/grizzle-release/BR08/plants/apply-stream-read-once.patch, a Stream parameter read once and empty
 *   after, must turn the property red.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Result, Stream } from "effect"
import { memberOps } from "#adapter/db/handles.ts"
import type { ServedOps } from "#adapter/db/ops.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import { CredentialError } from "#adapter/errors/failures.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import type { ParamMap } from "#compiler/plan/common.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { type Uuid, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { login, relation, role, schema, wholeEntriesOf } from "#compiler/public/schema.ts"
import { defaultPool, poolFor, rowsOn } from "#test/pg/adapter/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import {
	assert,
	assertVariant,
	bareRecord,
	failureOf,
	throwsRefused,
	unorderedEqual
} from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { t3, t4, tMissing, workFacts } from "#test/support/fixtures/golden/work.ts"
import { installMigrated as install, loadMigrated as load } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang, testIdleTimeout } from "#test/support/limits.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { type StateRow, tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { makeTap } from "#test/support/wire-tap.ts"
import { stringsOver } from "#test/unit/text/generators.ts"

const counts = (relation: string, added: bigint, deleted: bigint, put: bigint) => ({
	relation,
	added,
	deleted,
	put
})

/**
 * The worked example's Work under `name`, and an extension of it by a relation of its own: a Db opened on the extension
 * has Work as its base level.
 */
const levels = (name: string) => {
	const Base = schema(name, W.Work.relations, W.Work.statements)
	const Label = relation("Label", { task: uuid }, ["task"])
	const Extended = schema.extend(Base, `${name}_1`, { Label }, [])
	/**
	 * The app: a full role over Extended writing Work's stored relations but Account, so a write of Account is outside
	 * its write list, in its login.
	 */
	const app = role(Extended, "app", wholeEntriesOf(Extended), {
		write: ["Task", "AutomaticTask", "ManualTask", "TaskNote"]
	})
	return { Base, Extended, app, server: login(Extended, "server", [app]) }
}

/** The ChangeSet a value applies. */
type Change =
	| "empty"
	| "a Stream parameter, twice"
	| "a base level"
	| "outside the write list"
	| "a sibling"
	| "an extension"
	| "acquisition fails"

const changes: Arr.NonEmptyReadonlyArray<Change> = [
	"empty",
	"a Stream parameter, twice",
	"a base level",
	"outside the write list",
	"a sibling",
	"an extension",
	"acquisition fails"
]

/** A note of a task: TaskNote's fact, keyed by its task. */
interface Note {
	readonly task: Uuid
	readonly note: string
}

/** A note as TaskNote's stored state reads it. */
const stored = (n: Note): StateRow => ({ task: n.task, note: n.note })

/**
 * A value of the space: its ChangeSet, and what its call states, each drawn: the base level's notes, of t3, t4 or
 * both, the Stream's wanted tasks, t3, t4 or both and maybe tMissing, which no Task holds, and the note the Stream's
 * member writes for each wanted task that exists.
 */
interface ApplyCase {
	readonly change: Change
	readonly notes: Arr.NonEmptyReadonlyArray<Note>
	readonly wanted: Arr.NonEmptyReadonlyArray<Uuid>
	readonly note: string
}

type ApplyFeature = Change | "both tasks noted" | "a wanted task no Task holds" | "an empty note"

/** A note's text: letters, a space, a line feed, a Latin-1 and a supplementary code point, the empty text among them. */
const noteText: Gen<string> = stringsOver([0x61, 0x7a, 0x20, 0x0a, 0xe9, 0x1f600], 6)

const applyCase: Gen<ApplyCase> = (source) => {
	const tasks = source.draw(element<Arr.NonEmptyReadonlyArray<Uuid>>([[t3], [t4], [t3, t4]]))
	const found = source.draw(element<Arr.NonEmptyReadonlyArray<Uuid>>([[t3], [t4], [t3, t4]]))
	return {
		change: source.draw(element(changes)),
		notes: Arr.map(tasks, (task): Note => ({ task, note: source.draw(noteText) })),
		wanted: source.draw(element([found, Arr.append(found, tMissing)])),
		note: source.draw(noteText)
	}
}

/** A change member of array members, applied with the call's facts. */
const applied = (change: ServedOps<unknown>, facts: unknown) => {
	assertVariant(change, "kind", "facts", "a change member of array members takes its call's facts")
	return change.ops.apply(facts, {})
}

/** A change member of no array member, applied with `params`. */
const appliedWith = (change: ServedOps<unknown>, params: ParamMap) => {
	assertVariant(
		change,
		"kind",
		"program",
		"a change member of no array member takes its parameters alone"
	)
	return change.ops.apply(params)
}

layer(Substrate.layer)("a change member's apply", (it) => {
	it.effect(
		"answers the empty, a Stream-parameter and a base-level ChangeSet, refuses one that does not compile where it is compiled, and a failed acquisition",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const declared = levels("Levels")
					const done = yield* install(declared.Extended, {
						ambient: ordinarySession,
						extensions: [],
						label: "apply_levels",
						logins: [declared.server]
					})
					yield* load(done, workFacts)
					const rebuilt = levels(done.schema)
					const credentials = done.as(rebuilt.server)
					const names = namesOf(done)
					/** The login's credential, which a value turns off to fail an acquisition. */
					const credential = { ok: true }
					const password = Effect.suspend(() =>
						credential.ok
							? Effect.succeed(credentials.password)
							: Effect.fail(new CredentialError({ cause: "the test turned the credential off" }))
					)
					const state = Effect.all({
						notes: tableState(done, W.TaskNote),
						accounts: tableState(done, W.Account)
					})
					const s0 = rebuilt.Extended
					/**
					 * A sibling under the installed name with Work's relations alone, and an extension of the Db's schema:
					 * neither's content is a level of the Db's. The types refuse both, and a write outside the role's
					 * write list, at workload(...); the workload builder refuses the first two where it is called, and the
					 * compile of the served file the third.
					 */
					const sibling = schema(done.schema, W.Work.relations, [])
					const extension = schema.extend(
						s0,
						"Extended",
						{ Extra: relation("Extra", { id: uuid }, ["id"]) },
						[]
					)
					/** The ChangeSets the compile refuses, by the value that draws them. */
					const refusedOf = (
						change: "outside the write list" | "a sibling" | "an extension"
					): unknown => {
						switch (change) {
							case "outside the write list":
								return ChangeSet.empty(s0).insert(W.Account, [])
							case "a sibling":
								return ChangeSet.empty(sibling).insert(W.TaskNote, [])
							case "an extension":
								return ChangeSet.empty(extension).insert(W.TaskNote, [])
						}
					}
					return yield* withServedDb(
						done,
						rebuilt.server.roles.app,
						{},
						({ ctx: opened, load: loaded, serve }) =>
							Effect.gen(function* () {
								/**
								 * The members' runtime on a tapped pool, its first session warmed, so a window holds one call's
								 * traffic.
								 */
								const tap = makeTap(s.cluster)
								const pool = yield* poolFor(credentials, {
									...defaultPool,
									password: { kind: "given", password },
									transport: { kind: "given", transport: tap.transport },
									pool: { idleTimeoutMs: testIdleTimeout.value, min: 1, max: 2 }
								})
								yield* Effect.scoped(
									Effect.flatMap(pool.lease, (session) =>
										rowsOn(session, "SELECT 'warm'::text", [])
									)
								)
								const tapped = { ...opened, pool }
								const members = yield* loaded({
									empty: ChangeSet.empty(s0),
									/** A described insert over a relation parameter, a call's Stream: one note per wanted task that exists. */
									streamed: ChangeSet.empty(s0).insert(
										W.TaskNote,
										query(s0).rule((r) => {
											const wanted = r.relation("wanted", { task: uuid })
											const { id } = v(W.Task, "task")
											return r
												.match(wanted, { task: id })
												.match(W.Task, { id })
												.find({ task: id, note: r.param("note", W.TaskNote.fields.note) })
										})
									),
									base: ChangeSet.empty(rebuilt.Base).insert(W.TaskNote, []),
									remove: ChangeSet.empty(s0).delete(W.TaskNote, [])
								})
								const run = (name: string) => memberOps(tapped, member(members, name))
								return yield* explore(
									{
										oracle: {
											kind: "specification",
											name: "the outcome the drawn facts and the role's write list decide"
										},
										suite: "transactions/apply",
										draw: drawn(applyCase),
										literal: Formatter.format,
										kept: [],
										runs: 56,
										shrink: completeShrink,
										concurrency: 1,
										steerEvery: 16,
										caseHang,
										coverage: required<ApplyFeature>(
											[
												...changes,
												"both tasks noted",
												"a wanted task no Task holds",
												"an empty note"
											],
											{ cases: 56, sense: notesOnly }
										)
									},
									({ change, notes, wanted, note }, c) =>
										Effect.gen(function* () {
											yield* s.admin.query(
												`DELETE FROM ${names.table(W.TaskNote)} WHERE ${names.column(W.TaskNote, "task")} = ANY ($1::uuid[])`,
												[`{${t3},${t4}}`]
											)
											credential.ok = true
											const before = yield* state
											switch (change) {
												case "empty": {
													const outcome = yield* appliedWith(run("empty"), {})
													assert.ok(outcome.kind === "no-change", outcome.kind)
													assert.deepEqual(outcome.reads, bareRecord({}))
													const after = yield* state
													unorderedEqual(after.notes, before.notes)
													break
												}
												case "a Stream parameter, twice": {
													const stream = Stream.fromIterable(Arr.map(wanted, (task) => ({ task })))
													const written = Arr.map(
														Arr.filter(wanted, (task) => task !== tMissing),
														(task): Note => ({ task, note })
													)
													const added = [counts("TaskNote", BigInt(written.length), 0n, 0n)]
													const first = yield* appliedWith(run("streamed"), {
														wanted: stream,
														note
													})
													assert.ok(first.kind === "accepted", first.kind)
													assert.deepEqual(first.counts, added)
													const after = yield* state
													unorderedEqual(after.notes, [
														...before.notes,
														...Arr.map(written, stored)
													])
													/**
													 * With the notes deleted again, the second application adds them again only if it
													 * collects the Stream anew: a Stream read once would add nothing.
													 */
													const removed = yield* applied(run("remove"), {
														delete: { TaskNote: written }
													})
													assert.ok(removed.kind === "accepted", removed.kind)
													assert.deepEqual(removed.counts, [
														counts("TaskNote", 0n, BigInt(written.length), 0n)
													])
													const second = yield* appliedWith(run("streamed"), {
														wanted: stream,
														note
													})
													assert.ok(second.kind === "accepted", second.kind)
													assert.deepEqual(second.counts, added)
													break
												}
												case "a base level": {
													const outcome = yield* applied(run("base"), {
														insert: { TaskNote: notes }
													})
													assert.ok(outcome.kind === "accepted", outcome.kind)
													assert.deepEqual(outcome.counts, [
														counts("TaskNote", BigInt(notes.length), 0n, 0n)
													])
													const after = yield* state
													unorderedEqual(after.notes, [...before.notes, ...Arr.map(notes, stored)])
													break
												}
												case "outside the write list": {
													const refused = yield* Effect.result(
														serve({ refused: refusedOf(change) })
													)
													assert.ok(Result.isFailure(refused), "the compile refuses the member")
													assert.ok(
														!(refused.failure instanceof OpenError),
														Formatter.format(refused.failure)
													)
													const error = refused.failure.error
													assert.ok(isCompileError(error), Formatter.format(error))
													assert.deepEqual(
														[refused.failure.place, error.reason._tag],
														[{ kind: "program", role: "app", program: "refused" }, "OutsideRole"]
													)
													const after = yield* state
													unorderedEqual(after.notes, before.notes)
													unorderedEqual(after.accounts, before.accounts)
													break
												}
												case "a sibling":
												case "an extension": {
													throwsRefused(
														() => workload(rebuilt.app, { refused: refusedOf(change) }),
														"MalformedDescription",
														change
													)
													const after = yield* state
													unorderedEqual(after.notes, before.notes)
													break
												}
												case "acquisition fails": {
													yield* Effect.scoped(
														Effect.gen(function* () {
															yield* pool.lease
															credential.ok = false
															const failed = yield* failureOf(
																applied(run("base"), { insert: { TaskNote: notes } })
															)
															assert.ok(failed._tag === "TransportFailure", String(failed))
															assert.equal(failed.stage, "acquire")
														})
													)
													credential.ok = true
													const after = yield* state
													unorderedEqual(after.notes, before.notes)
													break
												}
											}
											c.note(change)
											if (notes.length > 1) {
												c.note("both tasks noted")
											}
											if (Arr.contains(wanted, tMissing)) {
												c.note("a wanted task no Task holds")
											}
											if (note === "" || Arr.some(notes, (n) => n.note === "")) {
												c.note("an empty note")
											}
										})
								)
							})
					)
				}).pipe(Effect.scoped)
			)
	)
})
