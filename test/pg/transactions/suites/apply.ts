import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Result, Stream } from "effect"
import { makeDb } from "#adapter/db/db.ts"
import { CredentialError } from "#adapter/errors/failures.ts"
import { Db } from "#adapter/public/db.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { login, relation, role, schema } from "#compiler/public/schema.ts"
import { defaultPool, poolFor, rowsOn } from "#test/pg/adapter/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, failureOf, bareRecord, unorderedEqual } from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { t3, t4, workFacts } from "#test/support/fixtures/golden/work.ts"
import { installMigrated as install, loadMigrated as load } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { applyRuntime, compileRuntime, contextOf } from "#test/support/runtime-db.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { makeTap } from "#test/support/wire-tap.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { loginLayer } from "#test/support/worlds.ts"

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
	const Extended = schema.extend(Base, { Label }, [])
	/**
	 * The app: a full role over Extended writing Work's stored relations but Account, so a write of Account is outside
	 * its write list, in its login.
	 */
	const app = role(Extended, "app", Extended.relations, {
		write: ["Task", "AutomaticTask", "ManualTask", "TaskNote"]
	})
	return { Base, Extended, app, server: login(Extended, "server", [app]) }
}

/** The ChangeSet a value applies. */
type Change =
	| "empty"
	| "a bound Stream, twice"
	| "a base level"
	| "outside the write list"
	| "a sibling"
	| "an extension"
	| "acquisition fails"
type Entry = "apply" | "compiled"

const changes: Arr.NonEmptyReadonlyArray<Change> = [
	"empty",
	"a bound Stream, twice",
	"a base level",
	"outside the write list",
	"a sibling",
	"an extension",
	"acquisition fails"
]

const entries: Arr.NonEmptyReadonlyArray<Entry> = ["apply", "compiled"]

/** Every ChangeSet through every entry, the ChangeSet outermost. */
const space: Gen<readonly [Change, Entry]> = (source) =>
	[source.draw(element(changes)), source.draw(element(entries))] as const

type ApplyFeature = `${Change} through ${Entry}`

/** Every value of the space, each reached. */
const everyValue: Arr.NonEmptyReadonlyArray<ApplyFeature> = Arr.flatMap(changes, (change) =>
	Arr.map(entries, (entry): ApplyFeature => `${change} through ${entry}`)
)

/**
 * db.apply and db.compile(changes) through Db.open: what each entry point decides before and around its one
 * transaction, as one finite space exhausted, every ChangeSet through both entries (db.apply, and db.compile then
 * the compiled handle's apply). The outcome mapping over generated ChangeSets is the three-way write oracle's
 * (test/support/oracle/write); this space holds what it does not drive:
 *
 * - the empty ChangeSet is no-change, its read-backs an empty record, once its transaction, its frame alone, committed;
 * - a ChangeSet whose relation parameter is bound to a Stream collects the Stream anew at each application: applied
 *   twice with its notes deleted between, it adds them both times;
 * - a ChangeSet over a base level of the Db's schema applies;
 * - a ChangeSet that does not compile for the Db (one writing a relation outside the role's write list; one over a
 *   sibling with Work's relations and other statements; one over an extension of the Db's schema) is refused before
 *   any SQL: from db.apply an ExecutionFailure raised by the compiler at its compile stage, carrying the CompileError,
 *   and from db.compile that CompileError: OutsideRole for the relation outside the write list and
 *   MalformedDescription for a schema that is no level of the Db's;
 * - a failed acquisition is TransportFailure{stage: "acquire"}, from db.apply and from an apply of a handle compiled
 *   while the credential still worked.
 *
 * The Db runs on a tapped pool whose first session is warmed, so a window of the tap holds one call's traffic: a
 * refusal before SQL sends no frontend message. Every refusal leaves the stored state as it was.
 */
export const applySuite = () => {
	layer(Substrate.layer)("db.apply and db.compile(changes)", (it) => {
		it.effect(
			"each entry point answers the empty, a Stream-bound and a base-level ChangeSet, refuses one that does not compile before any SQL, and a failed acquisition",
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
						return yield* Effect.gen(function* () {
							const db = yield* Db.open(rebuilt.server.roles.app, {})
							/**
							 * The Db's runtime on a tapped pool, its first session warmed, so a window holds one call's traffic.
							 */
							const tap = makeTap(s.cluster)
							const pool = yield* poolFor(credentials, {
								...defaultPool,
								password: { kind: "given", password },
								transport: { kind: "given", transport: { _tag: "stream", open: tap.open } },
								pool: { idleTimeoutMs: 60_000, min: 1, max: 2 }
							})
							yield* Effect.scoped(
								Effect.flatMap(pool.lease, (session) => rowsOn(session, "SELECT 'warm'::text", []))
							)
							const tapped = makeDb<typeof rebuilt.app, unknown>({ ...contextOf(db), pool }, {})
							const s0 = rebuilt.Extended
							/**
							 * A described insert over a relation parameter bound to a Stream: one note per wanted task that exists.
							 */
							const notesFor = query(s0).rule((r) => {
								const wanted = r.relation("wanted", { task: uuid })
								const { id } = v(W.Task, "task")
								return r
									.match(wanted, { task: id })
									.match(W.Task, { id })
									.find({ task: id, note: r.param("note", W.TaskNote.fields.note) })
							})
							const streamed = ChangeSet.empty(s0)
								.insert(W.TaskNote, notesFor)
								.bind({
									wanted: Stream.fromIterable([{ task: t3 }, { task: t4 }]),
									note: "streamed"
								})
							/**
							 * A sibling under the installed name with Work's relations alone, and an extension of the Db's schema:
							 * neither's content is a level of the Db's. The types refuse both, and a write outside the role's
							 * write list, at db.apply, so every value goes to the runtime it runs.
							 */
							const sibling = schema(done.schema, W.Work.relations, [])
							const extension = schema.extend(
								s0,
								{ Extra: relation("Extra", { id: uuid }, ["id"]) },
								[]
							)
							/** workFacts' notes: none at t3 or t4. */
							const changeOf = (change: Change): unknown => {
								switch (change) {
									case "empty":
										return ChangeSet.empty(s0)
									case "a bound Stream, twice":
										return streamed
									case "a base level":
										return ChangeSet.empty(rebuilt.Base).insert(W.TaskNote, [
											{ task: t3, note: "base level" }
										])
									case "outside the write list":
										return ChangeSet.empty(s0).insert(W.Account, [
											{ id: t4, name: "outside the write list" }
										])
									case "a sibling":
										return ChangeSet.empty(sibling).insert(W.TaskNote, [
											{ task: t3, note: "sibling" }
										])
									case "an extension":
										return ChangeSet.empty(extension).insert(W.TaskNote, [
											{ task: t3, note: "extension" }
										])
									case "acquisition fails":
										return ChangeSet.empty(s0).insert(W.TaskNote, [{ task: t3, note: "never" }])
								}
							}
							return yield* exhaust(
								{
									suite: "transactions/apply",
									generator: space,
									literal: Formatter.format,
									limit: 14,
									coverage: requiredInSpace<ApplyFeature>(everyValue),
									caseHang: Duration.minutes(2)
								},
								([change, entry], c) =>
									Effect.gen(function* () {
										yield* s.admin.query(
											`DELETE FROM ${names.table(W.TaskNote)} WHERE ${names.column(W.TaskNote, "task")} = ANY ($1::uuid[])`,
											[`{${t3},${t4}}`]
										)
										credential.ok = true
										const before = yield* state
										const changes = changeOf(change)
										/**
										 * One application through the value's entry: a compiled handle is compiled once, while the
										 * credential works, and applied at each call.
										 */
										const handle =
											entry === "compiled"
												? ({
														kind: "compiled",
														result: yield* Effect.result(compileRuntime(tapped, changes))
													} as const)
												: ({ kind: "apply" } as const)
										/**
										 * A held lease takes the warm session, so the apply needs a new one, whose credential
										 * fails.
										 *
										 * Read-backs are an assembled record, null-prototyped like every decoded record.
										 */
										const applyOnce =
											handle.kind === "apply"
												? applyRuntime(tapped, changes, {})
												: Result.isSuccess(handle.result)
													? handle.result.success.apply({})
													: Effect.die(
															new Error(`the handle was refused: ${String(handle.result.failure)}`)
														)
										switch (change) {
											case "empty": {
												const outcome = yield* applyOnce
												assert.ok(outcome.kind === "no-change", outcome.kind)
												assert.deepEqual(outcome.reads, bareRecord({}))
												const after = yield* state
												unorderedEqual(after.notes, before.notes)
												break
											}
											case "a bound Stream, twice": {
												const added = [counts("TaskNote", 2n, 0n, 0n)]
												const first = yield* applyOnce
												assert.ok(first.kind === "accepted", first.kind)
												assert.deepEqual(first.counts, added)
												const after = yield* state
												unorderedEqual(after.notes, [
													...before.notes,
													{ task: t3, note: "streamed" },
													{ task: t4, note: "streamed" }
												])
												/**
												 * With the notes deleted again, the second application adds them again only if it
												 * collects the Stream anew: a Stream read once would add nothing.
												 */
												const removed = yield* db.apply(
													ChangeSet.empty(s0).delete(W.TaskNote, [
														{ task: t3, note: "streamed" },
														{ task: t4, note: "streamed" }
													]),
													{}
												)
												assert.ok(removed.kind === "accepted", removed.kind)
												assert.deepEqual(removed.counts, [counts("TaskNote", 0n, 2n, 0n)])
												const second = yield* applyOnce
												assert.ok(second.kind === "accepted", second.kind)
												assert.deepEqual(second.counts, added)
												break
											}
											case "a base level": {
												const outcome = yield* applyOnce
												assert.ok(outcome.kind === "accepted", outcome.kind)
												assert.deepEqual(outcome.counts, [counts("TaskNote", 1n, 0n, 0n)])
												const after = yield* state
												unorderedEqual(after.notes, [
													...before.notes,
													{ task: t3, note: "base level" }
												])
												break
											}
											case "outside the write list":
											case "a sibling":
											case "an extension": {
												/**
												 * The compiler's refusal, carried as the reason, is the handle's.
												 */
												const mark = tap.mark()
												if (handle.kind === "apply") {
													const applied = yield* failureOf(applyOnce)
													assert.ok(
														applied._tag === "ExecutionFailure" &&
															applied.reason._tag === "CompileError",
														String(applied)
													)
													assert.equal(
														applied.reason.reason._tag,
														change === "outside the write list"
															? "OutsideRole"
															: "MalformedDescription"
													)
												} else {
													assert.ok(Result.isFailure(handle.result), "the handle is refused")
													const refused = handle.result.failure
													assert.ok(isCompileError(refused), String(refused))
													assert.equal(
														refused.reason._tag,
														change === "outside the write list"
															? "OutsideRole"
															: "MalformedDescription"
													)
												}
												assert.equal(
													tap.since(mark).frontend.length,
													0,
													"no statement before the refusal"
												)
												const after = yield* state
												unorderedEqual(after.notes, before.notes)
												unorderedEqual(after.accounts, before.accounts)
												break
											}
											case "acquisition fails": {
												yield* Effect.scoped(
													Effect.gen(function* () {
														yield* pool.lease
														credential.ok = false
														const applied = yield* failureOf(applyOnce)
														assert.ok(applied._tag === "TransportFailure", String(applied))
														assert.equal(applied.stage, "acquire")
													})
												)
												credential.ok = true
												const after = yield* state
												unorderedEqual(after.notes, before.notes)
												break
											}
										}
										c.note(`${change} through ${entry}`)
									})
							)
						}).pipe(Effect.scoped, withLayer(loginLayer(done, rebuilt.server)))
					}).pipe(Effect.scoped)
				)
		)
	})
}
