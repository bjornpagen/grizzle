/**
 * Every workload read of the platform against two oracles, on generated platforms through the public runtime.
 *
 * The platform installs once with its workload (support.ts). Each case is a generated platform
 * (test/support/platform/generate.ts), small and drawn under a swarm, its instants from a dictionary of its own
 * boundaries, and billed: two or three months, each closed for every organization, with refunds on. The tables are
 * emptied, the platform's facts are stored by one call of the workload's load, which the laws must accept (a lawful
 * state by construction), and DailySpend is refreshed by the workload's refresh member. Then every read of the
 * workload runs, as a member of billing's served workload, with parameters drawn from the platform (an id it holds, or
 * one it does not):
 *
 * - a member's once's rows, flattened statement by statement, agree with the reference evaluator over the read's
 *   checked IR and the same facts: the root's rows and each attachment's children per parent, as sets, each column by
 *   its type's equality; an arm's child is delivered exactly where its parent's handle selects it;
 * - the one row of the reads proved at most one row is the reference's row or none, at a workspace's month the
 *   platform charged and at a drawn one;
 * - windows of the paged member invoices, each anchored after the last row of the one before at a drawn size until one
 *   answers no row, concatenate to its every row, which are in the stated order; a walk reads at most the windows its
 *   rows take, ceil(rows / size) and the empty one after them, so a walk that repeats rows ends there and fails;
 * - where the contract fully determines a number, it equals the host billing model's (test/support/platform/model.ts),
 *   a second implementation of the arithmetic: each tier piece of an event's charge and its sum per kind, which is what
 *   the model charged when the event was recorded, and a quote's price per kind.
 *
 * The planted platforms reach the features the population must keep reaching: an event exactly at a rate change, a
 * grant expiring exactly at an event's start and at its end, a cap hit exactly, zero-token and cache-only events, a
 * tier boundary crossed within one event, an event split across grants.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import {
	absentId,
	absentMonth,
	checkArms,
	checkEventCost,
	checkQuote,
	everyRow,
	ids,
	liveOr,
	monthOf,
	pagedInvoices,
	reads,
	type ReadsFeature,
	readsPlatform,
	readsSketchGen,
	plantedAims
} from "#test/pg/e2e-platform/reads.fixtures.ts"
import {
	applyFacts,
	dailySpendRows,
	differences,
	expectedOf,
	flattened,
	hostFacts,
	openedPlatform
} from "#test/pg/e2e-platform/support.ts"
import { assert } from "#test/support/assert.ts"
import { oneOf, rowsOf } from "#test/support/calls.ts"
import {
	buildPlatform,
	builtFeatures,
	type Platform,
	resolvePlatform
} from "#test/support/platform/generate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { untilAnswered } from "#test/support/transient.ts"

/**
 * The platform's workload reads against the reference and the billing model every workload read agrees with the reference evaluator and the model.
 *
 * Its pre-conversion budget: runs 12, coverage cases 12 (test/pg/e2e-platform/reads.test.ts at d8eed1786).
 */
export const thePlatformsWorkloadReadsAgainstTheReferenceAndTheBillingModelEveryWorkloadReadAgreesWithTheReferenceEvaluatorAndTheModel =
	property.explore(aimed(readsSketchGen, plantedAims), {
		needs: { platform: Substrate.seat(readsPlatform) },
		situations: [
			"an event at a rate change",
			"a grant expiring at an event's start",
			"a grant expiring at an event's end",
			"a cap hit exactly",
			"a zero-token event",
			"a cache-only event",
			"a tier boundary crossed within one event",
			"an event split across grants",
			"a reseller tree",
			"a refund",
			"a get answered",
			"a get answered none",
			"an ordered read paged"
		] satisfies ReadonlyArray<Reached<ReadsFeature>>,
		check:
			({ platform: seat }, cx: Case<ReadsFeature>) =>
			({ platform: sketch, picks }) =>
				Effect.scoped(
					Effect.gen(function* () {
						const taken = yield* seat
						const platform = openedPlatform(taken)

						const p: Platform = buildPlatform(cx.draw(resolvePlatform(sketch)))
						cx.noteAll(builtFeatures(p))
						yield* platform.clear
						const refused = (): void => {
							cx.note("a call run again after a TransientFailure")
						}
						yield* platform.withDb((db) =>
							Effect.gen(function* () {
								yield* untilAnswered(applyFacts(db, p.facts), refused)
								yield* untilAnswered(
									db.workload.refreshDailySpend.once({ params: {}, facts: {} }),
									refused
								)
								const facts = hostFacts(p.facts, dailySpendRows(p.facts))
								for (const [i, r] of reads.entries()) {
									const { params, rows: rowsAt } = r.at(p, picks[i] ?? 0)
									const rows = yield* untilAnswered(rowsAt(db), refused)
									const expected = expectedOf(r.query, facts, params)
									assert.deepEqual(
										differences(expected, flattened(expected, rows)),
										[],
										`${r.name}(${Formatter.format(params)})`
									)
									checkArms(r.name, rows)
									if (r.name === "eventCost") {
										checkEventCost(p, String(params["event"]), rows)
									}
									if (r.name === "quote") {
										checkQuote(p, params, rows)
									}
								}
								/**
								 * The one row of the reads proved at most one row: at a workspace's month the platform charged
								 * (or one it does not hold), and at a drawn workspace and month.
								 */
								const getPick = picks[0] ?? 0
								const asked = [
									liveOr(
										Arr.map(p.facts.EventCharge, (c) => ({
											workspace: c.workspace,
											month: c.month
										})),
										{ workspace: absentId, month: absentMonth },
										getPick
									),
									{
										workspace: liveOr(ids(p.facts.Workspace), absentId, getPick),
										month: monthOf(p, getPick)
									}
								]
								for (const at of asked) {
									const got = yield* untilAnswered(
										oneOf(db.workload.workspaceMonth.once({ params: at, facts: {} })),
										refused
									)
									const executed = yield* untilAnswered(
										rowsOf(db.workload.workspaceMonth.once({ params: at, facts: {} })),
										refused
									)
									assert.deepEqual(
										[...Option.toArray(got)],
										[...executed],
										"the one row is once's one row or none"
									)
									cx.note(Option.isSome(got) ? "a get answered" : "a get answered none")
								}
								/**
								 * Windows over the ordered reads, at a drawn size, concatenate to their every row in order.
								 */
								const size = 1 + (getPick % 3)
								for (const org of ids(p.facts.Org).slice(0, 2)) {
									const all = yield* untilAnswered(
										rowsOf(
											db.workload.invoices.once({
												params: { org },
												facts: {},
												window: everyRow
											})
										),
										refused
									)
									const paged = yield* pagedInvoices(
										db,
										org,
										size,
										Math.ceil(all.length / size) + 1,
										refused
									)
									assert.deepEqual(paged, [...all], "the windows concatenate to the ordered rows")
									assert.ok(
										Arr.every(all, (row, j) => {
											const next = all[j + 1]
											return (
												next === undefined ||
												row.start > next.start ||
												(row.start === next.start && row.id < next.id)
											)
										}),
										"invoices newest period first, then by id"
									)
									if (all.length > size) {
										cx.note("an ordered read paged")
									}
								}
							})
						)
					})
				),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator over each read's checked IR, and the host billing model's arithmetic"
		},
		budget: { runs: 12, steered: 12 },
		kept: [],
		kills: []
	})
