/**
 * A connection that can't be had, for a Db already open (README "Errors and outcomes"): a failing `password` Effect or
 * a released layer fails a read and a write alike with the CallError `unavailable`, which is safe to retry: no session
 * was had, so nothing was sent.
 *
 * The box, exhausted: each call that needs a session, a set read's, a key read's and a paged read's once and a write's,
 * against each way its connection can't be had: the password Effect failing for every connection after the Db opened,
 * once the pool's one session closed for idleness, or the Db's layer released. The oracle is the README's sentence,
 * restated per call: the call fails with `unavailable`, its retry `safe`.
 *
 *
 * Features: every call by every way its connection can't be had.
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): acquire-credential-stage.patch (a CredentialError read at stage
 * transport).
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Exit, Formatter, Option } from "effect"
import { CredentialError } from "#adapter/errors/failures.ts"
import { Db } from "#adapter/public/db.ts"
import type { CallError } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { query, v } from "#compiler/public/query.ts"
import { paged } from "#compiler/public/workload.ts"
import { installed } from "#test/pg/reads/support.ts"
import { roleBackends } from "#test/pg/serverless/support.ts"
import { assert } from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a1, t1, t3, workFacts } from "#test/support/fixtures/golden/work.ts"
import { caseHang, nodeTimerMin } from "#test/support/limits.ts"
import { sourcedDbLayer } from "#test/support/live-layer.ts"
import { clusterConnection } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify } from "#test/support/worlds.ts"

type Call = "read" | "key" | "page" | "write"
type Unhad = "the password fails" | "the layer released"

const point: Gen<readonly [Call, Unhad]> = (source) =>
	[
		source.draw(element<Call>(["read", "key", "page", "write"])),
		source.draw(element<Unhad>(["the password fails", "the layer released"]))
	] as const

type AcquireFeature = `${Call}: ${Unhad}`

/**
 * The full world's workload, one member per call that needs a session: a read of an account's automatic tasks, the
 * Task key's read, a page of every task by id, and a note written with the facts each call gives.
 */
const programs = Object.freeze({
	automaticTasksFor: W.workReads(W.Work).automaticTasksFor,
	task: W.Task,
	tasks: paged(
		query(W.Work)
			.rule((r) => {
				const { id } = v(W.Task, "task")
				return r.match(W.Task, { id }).find({ id })
			})
			.orderBy(["id", "asc"])
	),
	note: ChangeSet.empty(W.Work).insert(W.TaskNote, [])
})

/** What a call failed with: its error, or the call's success, which no case here expects. */
const failureOf = <A, E>(
	call: Effect.Effect<A, E>
): Effect.Effect<E | "the call succeeded" | undefined> =>
	Effect.map(Effect.exit(call), (exit) =>
		Exit.isSuccess(exit) ? "the call succeeded" : Option.getOrUndefined(Exit.findErrorOption(exit))
	)

layer(Substrate.layer)("a connection that can't be had", (it) => {
	it.effect(
		"fails a read and a write with the CallError unavailable, safe to retry, whichever way its connection can't be had",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const o = yield* installed(W.Work, workFacts, {
						label: "acquire",
						programs
					})
					const credentials = o.installed.as(o.server)
					return yield* exhaust(
						{
							suite: "serverless/acquire",
							generator: point,
							literal: Formatter.format,
							coverage: requiredInSpace<AcquireFeature>([
								"read: the password fails",
								"read: the layer released",
								"key: the password fails",
								"key: the layer released",
								"page: the password fails",
								"page: the layer released",
								"write: the password fails",
								"write: the layer released"
							]),
							box: "each call that needs a session, against each way its connection can't be had",
							oracle: {
								kind: "specification",
								name: "README: a connection that can't be had fails a read and a write with unavailable, safe to retry"
							},
							caseHang,
							concurrency: 1
						},
						([call, unhad], c) =>
							Effect.scoped(
								Effect.gen(function* () {
									const refusal = new CredentialError({ cause: "the password store refused" })
									const failing = { now: false }
									/**
									 * A pool of one session closed the least while after its release, its password Effect failing
									 * once the case turns it.
									 */
									const opening = Db.open(o.served.login.roles.app, {})
									const dbLayer = sourcedDbLayer(o.installed, {
										...clusterConnection(
											s.cluster,
											s.database,
											Effect.suspend(() =>
												failing.now ? Effect.fail(refusal) : Effect.succeed(credentials.password)
											)
										),
										pool: { max: 1, min: 0, idleTimeoutMs: nodeTimerMin.value },
										login: o.served.login,
										verify: testVerify
									})
									/** The call on an open Db, and what it failed with. */
									const callOn = (
										db: Effect.Success<typeof opening>
									): Effect.Effect<CallError | "the call succeeded" | undefined> => {
										switch (call) {
											case "read":
												return failureOf(
													db.workload.automaticTasksFor.once({ params: { account: a1 }, facts: {} })
												)
											case "key":
												return failureOf(db.workload.task.once({ params: { id: t1 }, facts: {} }))
											case "page":
												return failureOf(
													db.workload.tasks.once({
														params: {},
														facts: {},
														window: { anchor: { kind: "start" }, size: 2 }
													})
												)
											case "write":
												return failureOf(
													db.workload.note.once({
														params: {},
														facts: { insert: { TaskNote: [{ task: t3, note: "acquired" }] } }
													})
												)
										}
									}
									const failure =
										unhad === "the layer released"
											? yield* Effect.flatMap(opening.pipe(withLayer(dbLayer)), callOn)
											: yield* Effect.gen(function* () {
													const db = yield* opening
													for (;;) {
														const backends = yield* roleBackends(credentials.role)
														if (backends === 0) {
															break
														}
														yield* Effect.yieldNow
													}
													failing.now = true
													return yield* callOn(db)
												}).pipe(withLayer(dbLayer))
									assert.ok(
										typeof failure === "object",
										`the call's failure: ${Formatter.format(failure)}`
									)
									assert.deepEqual(
										[failure.kind, failure.retry],
										["unavailable", "safe"],
										`${call}'s failure: ${failure.message}`
									)
									c.note(`${call}: ${unhad}`)
								})
							)
					)
				}).pipe(Effect.scoped)
			)
	)
})
