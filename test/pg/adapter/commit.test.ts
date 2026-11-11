/**
 * A SERIALIZABLE apply whose COMMIT meets 40001 fails with the CallError `transient` after its one attempt
 * and commits nothing; the caller's second call of the same apply commits, reading the state the concurrent transaction
 * committed. Interruption is interrupt.test.ts's.
 *
 * The worked example's Work installs, every law native, its full world's workload holding the apply as a change
 * member. The apply copies t1's note to t3 through a described member, so it reads t1's note and writes t3's.
 * TaskNote's reference to Task is a deferred foreign key, so the note's insert checks its task at COMMIT, with FOR KEY
 * SHARE on the task row: an owner session holding FOR UPDATE on that row makes the apply's COMMIT wait, observed by the
 * lock barrier without sleeping. While it waits, a concurrent SERIALIZABLE transaction in the app's world runs a subset
 * of {write what the apply read (t1's note), read what the apply wrote (t3's notes)} and commits or rolls back; then the
 * lock is released. The space is exhausted: four subsets by two ends.
 *
 * The oracle is serializability over the two transactions. A committed concurrent transaction that both wrote what the
 * apply read and read what the apply wrote leaves no serial order for the apply, which must then fail with
 * `transient`, safe to retry, and commit nothing. Any other concurrent transaction leaves one, and the apply
 * either commits the note it read, or fails the same way, SSI being free to refuse a serializable pair; a concurrent
 * transaction that rolled back changed nothing, and the apply commits. Whenever the apply failed, the caller's second
 * call commits the note the database then holds for t1.
 *
 * Features: every subset by every end, and 40001 at COMMIT.
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): commit-transient-tag.patch (a 40001 reported as a deadlock).
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Cause, Effect, Exit, Fiber, Formatter, Option } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { CallError } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { query, v } from "#compiler/public/query.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert } from "#test/support/assert.ts"
import { answered } from "#test/support/calls.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { t1, t3, workFacts } from "#test/support/fixtures/golden/work.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { ownerSession, Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** What the concurrent transaction does with what the apply read and wrote, and how it ends. */
const concurrentKinds = ["nothing", "writes the read", "reads the written", "both"] as const
type Concurrent = (typeof concurrentKinds)[number]
const ends = ["commits", "rolls back"] as const
type End = (typeof ends)[number]

/** Every concurrent transaction: what it does, and how it ends. */
const concurrents: Gen<readonly [Concurrent, End]> = (source) =>
	[source.draw(element(concurrentKinds)), source.draw(element(ends))] as const

type CommitFeature = `${Concurrent} ${End}` | "40001 at COMMIT" | "a serializable pair committed"

/** Whether a failure is SERIALIZABLE's refusal: the CallError `transient`, which is safe to retry. */
const serializationRefused = (failure: Option.Option<CallError>): boolean =>
	Option.exists(failure, (error) => error.kind === "transient")

/** t1's note as workFacts stores it, and the one the concurrent transaction writes. */
const stored = "check the feed"
const changed = "changed"

layer(Substrate.layer, { excludeTestServices: true })(
	"a COMMIT that meets a serialization failure",
	(it) => {
		it.effect(
			"a SERIALIZABLE apply whose COMMIT meets 40001 fails as transient, and the caller's second call commits",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const o = yield* installed(W.Work, workFacts, {
							label: "real",
							extensions: [],
							programs: {
								/** A described member over a stored relation: a note at the target task copying the source's note. */
								copy: ChangeSet.empty(W.Work).insert(
									W.TaskNote,
									query(W.Work).rule((r) => {
										const { note } = v(W.TaskNote, "taskNote")
										return r
											.match(W.TaskNote, {
												task: r.param("source", W.TaskNote.fields.task),
												note
											})
											.find({ task: r.param("target", W.TaskNote.fields.task), note })
									})
								)
							}
						})
						const s = yield* Substrate
						const names = namesOf(o.installed)
						/** The login the apply's backend logs in as, which pg_stat_activity names it by. */
						const writer = o.installed.as(o.server).role
						const notes = names.table(W.TaskNote)
						const task = names.column(W.TaskNote, "task")
						const noteColumn = names.column(W.TaskNote, "note")
						const noteOf = (id: string) =>
							Effect.map(tableState(o.installed, W.TaskNote), (rows) =>
								Arr.map(
									Arr.filter(rows, (row) => row["task"] === id),
									(row) => row["note"]
								)
							)
						return yield* Effect.gen(function* () {
							/**
							 * One attempt, and it committed nothing; the caller's second call commits t1's note as it
							 * now stands.
							 *
							 * workFacts' notes: t1's as stored, none at t3.
							 */
							const db = yield* Db.open(o.served.login.roles.app, {})
							return yield* exhaust(
								{
									box: "what a concurrent transaction does with the apply's read and write set, by how it ends",
									oracle: {
										kind: "specification",
										name: "serializability of the apply and the concurrent transaction"
									},
									suite: "adapter/commit",
									generator: concurrents,
									literal: Formatter.format,
									coverage: requiredInSpace<CommitFeature>([
										...Arr.flatMap(concurrentKinds, (c) =>
											Arr.map(ends, (e): CommitFeature => `${c} ${e}`)
										),
										"40001 at COMMIT"
									]),
									caseHang
								},
								([concurrent, end], c) =>
									Effect.gen(function* () {
										yield* s.admin.query(`DELETE FROM ${notes} WHERE ${task} = $1::uuid`, [t3])
										yield* s.admin.query(
											`UPDATE ${notes} SET ${noteColumn} = $1::text WHERE ${task} = $2::uuid`,
											[stored, t1]
										)
										const locker = yield* s.session({ ...ownerSession(), label: "locker" })
										yield* locker.begin
										yield* locker.query(
											`SELECT 1 FROM ${names.table(W.Task)} WHERE ${names.column(W.Task, "id")} = $1::uuid FOR UPDATE`,
											[t3]
										)
										const other = yield* s.session({
											...worldSession(o.installed.world(o.app)),
											label: "concurrent"
										})
										const applying = yield* Effect.forkChild(
											answered(
												db.workload.copy.once({ params: { source: t1, target: t3 }, facts: {} })
											)
										)
										/**
										 * The apply read t1's note and wrote t3's, and its COMMIT waits on the deferred reference's
										 * lock, which the locker holds. An apply that ends before it waits never meets the
										 * concurrent transaction: that is the case's failure, never a wait without end.
										 */
										const holder = locker.pid
										yield* Effect.raceFirst(
											s.awaitBlockedBy(holder, writer),
											Effect.flatMap(Fiber.await(applying), (exit) =>
												Effect.die(
													new Error(`the apply ended before its COMMIT waited: ${String(exit)}`)
												)
											)
										)
										yield* other.begin
										if (concurrent === "writes the read" || concurrent === "both") {
											yield* other.query(
												`UPDATE ${notes} SET ${noteColumn} = $1::text WHERE ${task} = $2::uuid`,
												[changed, t1]
											)
										}
										if (concurrent === "reads the written" || concurrent === "both") {
											yield* other.query(`SELECT count(*) FROM ${notes} WHERE ${task} = $1::uuid`, [
												t3
											])
										}
										if (end === "commits") {
											yield* other.commit
										} else {
											yield* other.rollback
										}
										yield* locker.commit
										const exit = yield* Fiber.await(applying)
										const read =
											end === "commits" &&
											concurrent !== "reads the written" &&
											concurrent !== "nothing"
												? changed
												: stored
										/**
										 * Nothing concurrent committed: the apply commits the note it read.
										 *
										 * No serial order: the apply fails at its COMMIT and commits nothing.
										 */
										const failure = Exit.isFailure(exit)
											? Cause.findErrorOption(exit.cause)
											: Option.none()
										c.note(`${concurrent} ${end}`)
										if (concurrent === "both" && end === "commits") {
											assert.ok(
												serializationRefused(failure),
												`transient at COMMIT: ${String(exit)}`
											)
											c.note("40001 at COMMIT")
										} else if (end === "rolls back" || concurrent === "nothing") {
											assert.ok(Exit.isSuccess(exit), `the apply commits: ${String(exit)}`)
										} else if (Exit.isSuccess(exit)) {
											c.note("a serializable pair committed")
										} else {
											assert.ok(
												serializationRefused(failure),
												`transient at COMMIT: ${String(exit)}`
											)
										}
										if (Exit.isSuccess(exit)) {
											assert.equal(exit.value.kind, "accepted")
											const committedNote = yield* noteOf(t3)
											assert.deepEqual(committedNote, [stored])
											return
										}
										const refusedNote = yield* noteOf(t3)
										assert.deepEqual(refusedNote, [])
										const again = yield* answered(
											db.workload.copy.once({ params: { source: t1, target: t3 }, facts: {} })
										)
										assert.equal(again.kind, "accepted")
										const retriedNote = yield* noteOf(t3)
										assert.deepEqual(retriedNote, [read])
									})
							)
						}).pipe(Effect.scoped, withLayer(o.served.layer))
					}).pipe(Effect.scoped)
				)
		)
	}
)
