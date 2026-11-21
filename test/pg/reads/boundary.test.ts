import { program, runProgram } from "@bjornpagen/testing/commands"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { fullSwarm } from "@bjornpagen/testing/swarm"
import { Effect, Exit, Scope, Struct } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import { query, v } from "#compiler/public/query.ts"
import { paged } from "#compiler/public/workload.ts"
import { defaultPool, poolFor, rowsOn } from "#test/pg/adapter/support.ts"
import {
	type BoundaryFeature,
	boundaryMachine,
	foreignKeyOf,
	stepsOf,
	type Subject
} from "#test/pg/reads/boundary.fixtures.ts"
import { openedIn, workSeatInstall, workSeatTemplate } from "#test/pg/reads/support.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { workFacts } from "#test/support/fixtures/golden/work.ts"
import { testIdleTimeout } from "#test/support/limits.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { makeTap } from "#test/support/wire-tap.ts"

/**
 * A served Db's handles at their boundary answer live, stale and wild values by their contract, refuse before SQL without sending, and leak no session.
 *
 * Its pre-conversion budget: runs 40, coverage cases 40 (test/pg/reads/boundary.test.ts at 8ad8d5b2c).
 */
export const aServedDbsHandlesAtTheirBoundaryAnswerLiveStaleAndWildValuesByTheirContractRefuseBeforeSQLWithoutSendingAndLeakNoSession =
	property.explore(
		program(boundaryMachine, { min: 0, max: 12 }, fullSwarm(Struct.keys(boundaryMachine.commands))),
		{
			needs: { seated: Substrate.seat(workSeatTemplate) },
			situations: [
				"refused before SQL: input",
				"window foreign anchor",
				"live after dispose",
				"disposed"
			] satisfies ReadonlyArray<Reached<BoundaryFeature>>,
			check:
				({ seated }, c: Case<BoundaryFeature>) =>
				(commands) =>
					Effect.flatMap(seated, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(W.Work, workFacts, workSeatInstall, taken)
								const s = o.schema
								const ordered = query(s)
									.rule((r) => {
										const { id } = v(W.Task, "task")
										const { budget } = v(W.AutomaticTask, "automaticTask")
										return r
											.match(W.Task, {
												id,
												account: r.param("account", W.Task.fields.account),
												kind: "Automatic"
											})
											.match(W.AutomaticTask, { task: id, budget })
											.find({ id, budget })
									})
									.orderBy(["budget", "desc"])
								const other = query(s)
									.rule((r) => {
										const { id } = v(W.Task, "task")
										return r.match(W.Task, { id }).find({ id })
									})
									.orderBy(["id", "asc"])
								const { ctx: context, load } = yield* openServedDb(
									o.installed,
									o.server.roles.app,
									{}
								)
								const loaded = yield* load({
									live: W.workReads(s).automaticTasksFor,
									task: W.Task,
									ordered: paged(ordered),
									other: paged(other)
								})
								return yield* Effect.scoped(
									Effect.gen(function* () {
										const substrate = yield* Substrate
										const tap = makeTap(substrate.cluster)
										const poolScope = yield* Scope.make()
										yield* Effect.addFinalizer(() => Scope.close(poolScope, Exit.void))
										const pool = yield* poolFor(o.installed.as(o.server), {
											...defaultPool,
											transport: { kind: "given", transport: tap.transport },
											pool: { idleTimeoutMs: testIdleTimeout, min: 1, max: 1 }
										}).pipe(Scope.provide(poolScope))
										yield* Effect.scoped(
											Effect.flatMap(pool.lease, (session) =>
												rowsOn(session, "SELECT 'warm'::text", [])
											)
										)
										const tapped = { ...context, pool }
										const callsOf = (name: string) => memberCalls(tapped, member(loaded, name))
										const real: Subject = {
											reads: {
												live: callsOf("live"),
												task: callsOf("task"),
												ordered: callsOf("ordered")
											},
											tap,
											pool,
											dispose: Scope.close(poolScope, Exit.void),
											foreignKey: yield* foreignKeyOf(callsOf("other")),
											note: c.note
										}
										yield* runProgram(boundaryMachine, stepsOf(real), commands)
									})
								)
							}).pipe(Effect.scoped),
							Substrate,
							taken.substrate
						)
					),
			oracle: {
				kind: "specification",
				name: "each call's contract: an answer or a typed refusal, nothing sent before SQL, no lease left"
			},
			budget: { runs: 40, steered: 40 },
			kept: [],
			kills: []
		}
	)
