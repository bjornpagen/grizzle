/**
 * Tiny platforms, exhausted: inside the box, FIFO apportionment and exact sums are a theorem.
 *
 * The box is one organization with one workspace and one key, one model on one provider, the model's input repriced
 * at an instant C onto graduated tiers, two grants of the organization, and three requests. Every point of it is
 * checked: each grant's amount (1 or 3,000 micro-dollars) and the end of its validity (C, or never), and each request's
 * start (the second before C, or C itself) and input tokens (1, or 1,001, which crosses the new card's first tier):
 * 16 grant pairs times 64 request triples. Each point's requests are priced and settled by the host billing model
 * (credits by earliest expiry, largest remainder across kinds) and recorded one call each of the workload's load, on
 * the static platform stored once:
 *
 * - every record is accepted: the laws (an event's kinds summing to its charge, its debits to its credited parts,
 *   credits within charges, each grant within its amount, each debit inside its grant's validity, each charge priced by
 *   the card in force at its event's start) admit every settlement the model makes, the grant ending exactly at a
 *   request's start paying nothing and the one ending exactly at its end paying in full;
 * - each recorded event's tier pieces, read by eventCost, sum to what the model charged, and each grant's debits, read
 *   by burnDown, sum to what the model debited it;
 * - every grant pays only what it holds and only over requests inside its validity, credits pay as much of each
 *   charge as the valid grants hold, and an earlier-expiring grant is spent before a later one is touched.
 */

import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { applyFacts, openedPlatform } from "#test/pg/e2e-platform/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { rowsOf } from "#test/support/calls.ts"
import * as P from "#test/support/fixtures/api/platform.ts"
import {
	JAN,
	noFacts,
	type PlatformFacts,
	settleRequests,
	type UsageRequest,
	uid,
	viewOf
} from "#test/support/platform/generate.ts"
import { covers, platformSpan } from "#test/support/platform/model.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { untilAnswered } from "#test/support/transient.ts"

import {
	C,
	org,
	key,
	provider,
	model,
	grantIds,
	staticFacts,
	box,
	type BoxFeature,
	spentInOrder,
	grantOrder,
	recordFacts,
	unnoted,
	decided,
	boxPlatform
} from "#test/pg/e2e-platform/box.fixtures.ts"

/**
 * Tiny platforms, exhausted: every settlement the model makes in the box is lawful, exact and recorded, each point on
 * the worker's seat of the platform's template with the static platform stored first, where the search stored it once
 * and cleared the usage, grants and limits before each point.
 */
export const tinyPlatformsExhaustedEverySettlementTheModelMakesInTheBoxIsLawfulExactAndRecorded =
	property.exhaust(finite(box), {
		box: "two grants of 1 or 3,000 micro-dollars ending at C or never, by three requests starting the second before C or at C with 1 or 1,001 input tokens",
		needs: { platform: Substrate.seat(boxPlatform) },
		situations: [
			"an event exactly at the rate change",
			"a grant expiring at an event's start",
			"a grant expiring at an event's end",
			"a tier boundary crossed within one event",
			"an event split across grants"
		],
		check:
			({ platform }, cx: Case<BoxFeature>) =>
			(point) =>
				Effect.scoped(
					Effect.gen(function* () {
						const taken = yield* platform
						const o = openedPlatform(taken)
						yield* o.withDb((db) =>
							Effect.gen(function* () {
								yield* untilAnswered(applyFacts(db, staticFacts), unnoted)
								const grants = Arr.map(point.grants, (g, i) => ({
									id: defined(grantIds[i], "a grant's id"),
									org,
									amount: P.Micros(g.amount),
									valid: { start: P.Instant(JAN), end: P.Instant(g.end) }
								}))
								const setup: PlatformFacts = { ...staticFacts, CreditGrant: grants }
								const requests = Arr.map(point.requests, (r, i): UsageRequest => ({
									id: uid(7, i),
									key,
									model,
									provider,
									during: platformSpan(r.start, r.start + 1n),
									tokens: [{ kind: "input", tokens: r.tokens }]
								}))
								const view = viewOf(setup)
								const settled = settleRequests(view, requests, {
									left: new Map(Arr.map(grants, (g) => [g.id, g.amount])),
									spent: new Map()
								})
								assert.equal(
									settled.refused.length,
									0,
									"the model records every request of the box"
								)
								for (const r of settled.records) {
									if (Arr.some(grants, (g) => g.valid.end === r.event.during.start)) {
										cx.note("a grant expiring at an event's start")
									}
									if (Arr.some(grants, (g) => g.valid.end === r.event.during.end)) {
										cx.note("a grant expiring at an event's end")
									}
								}
								const grantFacts = {
									...noFacts,
									CreditGrant: grants,
									WorkspaceLimit: staticFacts.WorkspaceLimit
								}
								const grantsDecision = yield* decided(db, grantFacts)
								assert.equal(grantsDecision, "accepted", "the grants and limits are stored")
								for (const record of settled.records) {
									const f = recordFacts(record)
									const decision = yield* decided(db, f)
									assert.equal(decision, "accepted", `${record.event.id} is recorded`)
									/** Its tier pieces sum to what the model charged. */
									const pieces = yield* untilAnswered(
										rowsOf(
											db.workload.eventCost.once({
												params: {
													event: record.event.id
												},
												facts: {}
											})
										),
										unnoted
									)
									const charged = Arr.reduce(record.charges, 0n, (sum, c) => sum + c.amount)
									assert.equal(
										Arr.reduce(pieces, 0n, (sum, piece) => sum + piece.amount),
										charged,
										`${record.event.id}'s pieces sum to its charge`
									)
									if (pieces.length > 1) {
										cx.note("a tier boundary crossed within one event")
									}
									if (record.event.during.start === C) {
										cx.note("an event exactly at the rate change")
									}
									if (new Set(Arr.map(record.debits, (d) => d.grant)).size > 1) {
										cx.note("an event split across grants")
									}
								}
								for (const g of grants) {
									const days = yield* untilAnswered(
										rowsOf(
											db.workload.burnDown.once({
												params: {
													grant: g.id
												},
												facts: {}
											})
										),
										unnoted
									)
									const debited = Arr.filter(
										Arr.flatMap(settled.records, (r) => r.debits),
										(d) => d.grant === g.id
									)
									assert.equal(
										Arr.reduce(days, 0n, (sum, d) => sum + BigInt(d.debited.toString())),
										Arr.reduce(debited, 0n, (sum, d) => sum + d.amount),
										`${g.id}'s debits`
									)
									assert.ok(
										Arr.reduce(debited, 0n, (sum, d) => sum + d.amount) <= g.amount,
										`${g.id} within its amount`
									)
									for (const d of debited) {
										assert.ok(
											covers(
												platformSpan(g.valid.start, g.valid.end),
												platformSpan(d.during.start, d.during.end)
											),
											`${g.id} valid over its debits`
										)
									}
								}
								const left = new Map<string, bigint>(Arr.map(grants, (g) => [g.id, g.amount]))
								for (const r of settled.records) {
									const window = platformSpan(r.event.during.start, r.event.during.end)
									const eligible = Arr.sort(
										Arr.filter(grants, (g) =>
											covers(platformSpan(g.valid.start, g.valid.end), window)
										),
										grantOrder
									)
									const charge = Arr.reduce(r.charges, 0n, (sum, c) => sum + c.amount)
									const credited = Arr.reduce(r.charges, 0n, (sum, c) => sum + c.credited)
									const held = Arr.reduce(eligible, 0n, (sum, g) => sum + (left.get(g.id) ?? 0n))
									assert.equal(
										credited,
										charge < held ? charge : held,
										`${r.event.id} credited as much as the valid grants hold`
									)
									spentInOrder(r, eligible, left)
									for (const d of r.debits) {
										left.set(d.grant, (left.get(d.grant) ?? 0n) - d.amount)
									}
								}
							})
						)
					})
				),
		oracle: {
			kind: "second-implementation",
			name: "the host billing model: FIFO apportionment by earliest expiry, largest remainder across kinds"
		},
		kept: [],
		kills: []
	})
