/**
 * The platform's plans: every workload read is planned through an index, and law maintenance and every law's probe
 * read through an index, judged by PostgreSQL's planner with the scans that need no index disabled, over relations it
 * plans unanalyzed, which no data size moves.
 *
 * The platform installs with its workload's access paths, as its first migration drafts them, beside an org tenant's
 * login (tenantOf). Each case draws a small volume platform's sizes (test/support/platform/generate.ts volumePlatform),
 * empties the tables, stores the platform through the workload's load, refreshes DailySpend and leaves every relation
 * unanalyzed (test/support/plans.ts unanalyzed): analyzed statistics of a platform of one row a relation estimated each
 * read's restrictions to keep every row, and PostgreSQL read relations sequentially beside the indexes that serve them.
 * It draws which of its entities and windows the reads ask about (the busiest workspace, key, organization and grant,
 * or another). Then:
 *
 * - served: every workload read runs as a served member through a counting executor (test/support/plans.ts
 *   recordingMembers), as billing, whose whole entries are plain views, and as the tenant, its Db opened with a token
 *   naming the drawn organization, through the tenant's security-barrier views over relations under row-level
 *   security; each statement the runtime sent, planned with its parameters, with sequential and index scans disabled
 *   and index-only scans never considered, so that a bitmap scan, which reads only by an index condition, is the one
 *   scan left, reads every relation it restricts by an index condition on an index the installation planned;
 * - law maintenance: each write that fires the platform's laws on the drawn entities (a usage event with its charges
 *   and debits by the busiest key active when it is written, a refund, a month closed with a plan line and its
 *   allocation, an invoice paid, that key revoked with its span cut, and a delete of each relation another references)
 *   runs in one rolled-back transaction with sequential scans disabled, is accepted or refused as the laws say, and
 *   scans no relation its laws count sequentially, read as the scans between two reads of the transaction statistics
 *   within it (pg_stat_xact_user_tables), which also hold an earlier transaction's scans PostgreSQL has not flushed.
 *
 * After the cases every law's probe, as the index engine states it, is EXPLAINed generically with sequential and bitmap
 * scans disabled, and reads through an index scan with an index condition on an index the installation planned. The
 * engine's own serving rule is never consulted: a copy of it would agree with it. The oracle is PostgreSQL's planner and
 * its transaction statistics. That every created index is needed is test/pg/physical/serving.test.ts's: a free plan's
 * choice of index is the cost model's, which only volume decides, so it is judged nowhere here.
 *
 * Features: a read by the busiest entities and by another, a week's window and a whole month's, and a usage event with
 * its charges and debits written.
 */

import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import type { Json } from "#compiler/core/canonical.ts"
import type { AnyLoginRole } from "#compiler/public/schema.ts"
import { applyFacts, openedPlatform } from "#test/pg/e2e-platform/support.ts"
import { readOnce } from "#test/support/calls.ts"
import { pickIndex } from "#test/support/pick.ts"
import { plannedIndexes, recordingMembers, sentProblems, unanalyzed } from "#test/support/plans.ts"
import { buildPlatform, loadOrder, uid, volumePlatform } from "#test/support/platform/generate.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { untilAnswered } from "#test/support/transient.ts"

import {
	billingReads,
	type Reads,
	tenantOf,
	entitiesOf,
	pickedEntity,
	type Probe,
	probes,
	lawWrites,
	runLawWrite,
	lawProbes,
	probeIndex,
	type PlanFeature,
	runs,
	caseGen,
	plansPlatform
} from "#test/pg/e2e-platform/plans.fixtures.ts"

/**
 * The platform's plans: every read through its indexes, and every law's maintenance and probe through an index, on
 * drawn small platforms, each case on the worker's seat of the platform's template; every law's probe, whichever
 * writes reach it, is checked in every case, where the search checked them once after its cases.
 *
 * Its pre-conversion budget: runs 8, coverage cases 8 (test/pg/e2e-platform/plans.test.ts at 3f3571927).
 */
export const thePlatformsPlansEveryReadThroughItsIndexesAndEveryLawsMaintenanceAndProbeThroughAnIndexOnDrawnSmallPlatforms =
	property.explore(caseGen, {
		needs: { platform: Substrate.seat(plansPlatform) },
		situations: [
			"a read by the busiest entities",
			"a read by another",
			"a whole month's window",
			"a week's window",
			"a usage event with its charges and debits written"
		] satisfies ReadonlyArray<Reached<PlanFeature>>,
		check:
			({ platform }, cx: Case<PlanFeature>) =>
			({ sizes, pick }) =>
				Effect.scoped(
					Effect.provideServiceEffect(
						Effect.gen(function* () {
							const s = yield* Substrate
							const taken = yield* platform
							const o = openedPlatform(taken)
							const { tenants, reads: tenantReads } = tenantOf(o.schema)
							const planned = plannedIndexes(o.installed.installation)
							const refused = (): void => undefined
							cx.note(
								pickIndex(pick, 3) === 0 ? "a read by the busiest entities" : "a read by another"
							)
							cx.note(pickIndex(pick, 2) === 0 ? "a week's window" : "a whole month's window")
							const p = buildPlatform(volumePlatform(sizes))
							yield* o.withDb((db) =>
								Effect.andThen(
									untilAnswered(applyFacts(db, p.facts), refused),
									untilAnswered(
										db.workload.refreshDailySpend.once({ params: {}, facts: {} }),
										refused
									)
								)
							)
							yield* unanalyzed(
								s.admin,
								Arr.map([...loadOrder, "DailySpend"], (r) => o.installed.names.relation(r))
							)
							const e = entitiesOf(p)
							const problems: Array<string> = []
							/** One read's statements as `who` sent them, judged under disabled scans. */
							const review = (who: string, pr: Probe, sent: Parameters<typeof sentProblems>[2]) =>
								Effect.map(sentProblems(s.admin, `${pr.name} as ${who}`, sent, planned), (judged) =>
									appendAll(problems, judged)
								)
							const asked = probes(e, pick)
							/**
							 * Every probe read as `who`, through a Db of `role` opened with a token of `payload`: the role's
							 * reads loaded as members of its workload, each probe's run through the counting executor.
							 */
							const reviewAs = (who: string, role: AnyLoginRole, payload: Json, reads: Reads) =>
								Effect.scoped(
									withServedDb(o.installed, role, payload, ({ ctx, load }) =>
										Effect.gen(function* () {
											const loaded = yield* load(reads)
											const { calls, counts } = recordingMembers(ctx)
											for (const pr of asked) {
												const before = counts.sent.length
												yield* untilAnswered(
													readOnce(calls(member(loaded, pr.name)))({
														params: pr.params,
														facts: {}
													}),
													refused
												)
												yield* review(who, pr, counts.sent.slice(before))
											}
										})
									)
								)
							yield* reviewAs("billing", o.schema.server.roles.billing, {}, billingReads)
							yield* reviewAs(
								"the tenant",
								tenants.roles.tenant,
								{ org: pickedEntity(e.orgs, pick, uid(0xdead, 2)) },
								tenantReads
							)
							for (const w of lawWrites(o, p, e)) {
								if (w.name === "a usage event with its charges and debits") {
									cx.note("a usage event with its charges and debits written")
								}
								const ran = yield* runLawWrite(o, w)
								if (ran.accepted !== w.accepted) {
									problems.push(
										`${w.name}: ${ran.refusal === undefined ? "accepted" : `refused: ${ran.refusal}`}`
									)
								}
								appendAll(
									problems,
									Arr.map(
										Arr.filter(
											Arr.map(w.counted, (c) => o.installed.names.relation(c).name),
											(table) => (ran.seqScans.get(table) ?? 0) > 0
										),
										(table) => `${w.name}: a sequential scan of ${table}`
									)
								)
							}
							assert.deepEqual(
								problems,
								[],
								"every read is planned through its indexes as billing and as the tenant, and law maintenance reads every counted relation by an index"
							)
							const probeProblems: Array<string> = []
							for (const probe of lawProbes(o)) {
								const index = yield* probeIndex(probe)
								if (Option.isNone(index)) {
									probeProblems.push(`${probe.label}: no index scan`)
								} else if (!planned.has(index.value)) {
									probeProblems.push(
										`${probe.label}: read through ${index.value}, which the installation did not plan`
									)
								}
							}
							assert.deepEqual(
								probeProblems,
								[],
								"every law's probe reads through an index the installation planned"
							)
						}),
						Substrate,
						Effect.map(platform, (taken) => taken.substrate)
					)
				),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's plans with sequential and index scans disabled, and its transaction statistics"
		},
		budget: { runs, steered: runs },
		kept: [],
		kills: []
	})
