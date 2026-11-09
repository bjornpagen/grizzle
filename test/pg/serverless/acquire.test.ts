import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Exit, Formatter, Option } from "effect"
import { compiledOpen } from "#adapter/db/open.ts"
import { ReadFailure, TransportFailure } from "#adapter/errors/execution.ts"
import { CredentialError } from "#adapter/errors/failures.ts"
import { compiledDbLayer } from "#adapter/pool/registry.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { query, v } from "#compiler/public/query.ts"
import { installed } from "#test/pg/reads/support.ts"
import { roleBackends } from "#test/pg/serverless/support.ts"
import { assert } from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a1, t1, t3, workFacts } from "#test/support/fixtures/golden/work.ts"
import { caseHang, nodeTimerMin } from "#test/support/limits.ts"
import { clusterConnection } from "#test/support/pg.ts"
import { snapshotValue } from "#test/support/snapshot-json.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify } from "#test/support/worlds.ts"

/**
 * A connection that can't be had, for a Db already open (README "Errors and outcomes"): a failing `password` Effect or
 * a released layer fails a read with ReadFailure at stage `acquire`, and a write with TransportFailure at stage
 * `acquire`, each carrying the refusal as its reason.
 *
 * The box, exhausted: each call that needs a session, a read through execute, get and page and a write through apply,
 * against each way its connection can't be had: the password Effect failing for every connection after the Db opened,
 * once the pool's one session closed for idleness, or the Db's layer released. The oracle is the README's sentence,
 * restated per call: a read's ReadFailure or a write's TransportFailure, at stage acquire, its reason the
 * CredentialError the password Effect failed with or the pool's LayerReleased.
 */
type Call = "execute" | "get" | "page" | "apply"
type Unhad = "the password fails" | "the layer released"

const point: Gen<readonly [Call, Unhad]> = (source) =>
	[
		source.draw(element<Call>(["execute", "get", "page", "apply"])),
		source.draw(element<Unhad>(["the password fails", "the layer released"]))
	] as const

type AcquireFeature = `${Call}: ${Unhad}`

/** What a call failed with: its error, or the call's success, which no case here expects. */
const failureOf = <A, E>(
	call: Effect.Effect<A, E>
): Effect.Effect<E | "the call succeeded" | undefined> =>
	Effect.map(Effect.exit(call), (exit) =>
		Exit.isSuccess(exit) ? "the call succeeded" : Option.getOrUndefined(Exit.findErrorOption(exit))
	)

layer(Substrate.layer)("a connection that can't be had", (it) => {
	it.effect(
		"fails a read with ReadFailure and a write with TransportFailure, at stage acquire, carrying the refusal",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const o = yield* installed(W.Work, workFacts, {
						label: "acquire",
						extensions: [],
						programs: {}
					})
					const credentials = o.installed.as(o.server)
					const reads = W.workReads(o.schema)
					const ordered = query(o.schema)
						.rule((r) => {
							const { id } = v(W.Task, "task")
							return r.match(W.Task, { id }).find({ id })
						})
						.orderBy(["id", "asc"])
					const note = ChangeSet.empty(o.schema).insert(W.TaskNote, [
						{ task: t3, note: "acquired" }
					])
					return yield* exhaust(
						{
							suite: "serverless/acquire",
							generator: point,
							literal: Formatter.format,
							limit: 8,
							coverage: requiredInSpace<AcquireFeature>([
								"execute: the password fails",
								"execute: the layer released",
								"get: the password fails",
								"get: the layer released",
								"page: the password fails",
								"page: the layer released",
								"apply: the password fails",
								"apply: the layer released"
							]),
							box: "each call that needs a session, against each way its connection can't be had",
							oracle: {
								kind: "specification",
								name: "README: a connection that can't be had fails a read with ReadFailure at stage acquire, and a write with TransportFailure"
							},
							caseHang
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
									const opening = compiledOpen(o.server.roles.app, {})
									const dbLayer = compiledDbLayer({
										...clusterConnection(
											s.cluster,
											s.database,
											Effect.suspend(() =>
												failing.now ? Effect.fail(refusal) : Effect.succeed(credentials.password)
											)
										),
										pool: { max: 1, min: 0, idleTimeoutMs: nodeTimerMin.value },
										login: o.server,
										snapshot: snapshotValue(o.installed.snapshot, o.installed.installation),
										verify: testVerify
									})
									/** The call on an open Db, and what it failed with. */
									const callOn = (db: Effect.Success<typeof opening>): Effect.Effect<unknown> => {
										switch (call) {
											case "execute":
												return failureOf(
													Effect.flatMap(
														db.execute(reads.automaticTasksFor, { account: a1 }),
														(r) => r.collect
													)
												)
											case "get":
												return failureOf(db.get(W.Task, { id: t1 }))
											case "page":
												return failureOf(db.page(ordered, {}, { first: 2 }))
											case "apply":
												return failureOf(db.apply(note, {}))
										}
									}
									const reason: TransportFailure["reason"]["_tag"] & ReadFailure["reason"]["_tag"] =
										unhad === "the password fails" ? "CredentialError" : "LayerReleased"
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
									if (call === "apply") {
										assert.ok(
											failure instanceof TransportFailure,
											`a write's failure: ${Formatter.format(failure)}`
										)
										assert.deepEqual([failure.stage, failure.reason._tag], ["acquire", reason])
									} else {
										assert.ok(
											failure instanceof ReadFailure,
											`a read's failure: ${Formatter.format(failure)}`
										)
										assert.deepEqual([failure.stage, failure.reason._tag], ["acquire", reason])
									}
									if (
										unhad === "the password fails" &&
										(failure instanceof ReadFailure || failure instanceof TransportFailure)
									) {
										assert.deepEqual(
											failure.reason,
											refusal,
											"the reason is the password Effect's CredentialError"
										)
									}
									c.note(`${call}: ${unhad}`)
								})
							)
					)
				}).pipe(Effect.scoped)
			)
	)
})
