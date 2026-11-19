import { timerMinMs } from "@bjornpagen/grizzle/runtime"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { CredentialError } from "#adapter/errors/failures.ts"
import { Db } from "#adapter/public/db.ts"
import type { CallError } from "#compiler/live/index.ts"
import { installed } from "#test/pg/reads/support.ts"
import {
	type AcquireFeature,
	failureOf,
	point,
	programs,
	statedOf,
	unhadError
} from "#test/pg/serverless/acquire.fixtures.ts"
import { roleBackends } from "#test/pg/serverless/support.ts"
import { assert } from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a1, t1, t3, workFacts } from "#test/support/fixtures/golden/work.ts"
import { sourcedDbLayer } from "#test/support/live-layer.ts"
import { clusterConnection } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify } from "#test/support/worlds.ts"

/**
 * A connection that can't be had fails a read and a write with the CallError its way names, whichever way its connection can't be had.
 */
export const aConnectionThatCantBeHadFailsAReadAndAWriteWithTheCallErrorItsWayNamesWhicheverWayItsConnectionCantBeHad =
	property.exhaust(finite(point), {
		needs: { substrate: Substrate.installing },
		situations: [
			"read: the password fails",
			"read: the layer released",
			"key: the password fails",
			"key: the layer released",
			"page: the password fails",
			"page: the layer released",
			"write: the password fails",
			"write: the layer released"
		] satisfies ReadonlyArray<Reached<AcquireFeature>>,
		check:
			({ substrate }, c: Case<AcquireFeature>) =>
			([call, unhad]) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const o = yield* installed(W.Work, workFacts, {
							label: "acquire",
							programs
						})
						const credentials = o.installed.as(o.server)
						return yield* Effect.scoped(
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
									pool: { max: 1, min: 0, idleTimeoutMs: timerMinMs },
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
									statedOf(failure),
									unhadError[unhad],
									`${call}'s failure: ${failure.message}`
								)
								c.note(`${call}: ${unhad}`)
							})
						)
					}).pipe(Effect.scoped),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "README: a failing password fails a read and a write with credentialRefused, a released layer with unavailable"
		},
		box: "each call that needs a session, against each way its connection can't be had",
		kept: [],
		kills: []
	})
