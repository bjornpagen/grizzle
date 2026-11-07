/**
 * Tiny platforms, exhausted: inside the box, FIFO apportionment and exact sums are a theorem.
 *
 * The box is one organization with one workspace and one key, one model on one provider, the model's input repriced
 * at an instant C onto graduated tiers, two grants of the organization, and three requests. Every point of it is
 * checked: each grant's amount (1 or 3,000 micro-dollars) and the end of its validity (C, or never), and each request's
 * start (the second before C, or C itself) and input tokens (1, or 1,001, which crosses the new card's first tier):
 * 16 grant pairs times 64 request triples. Each point's requests are priced and settled by the host billing model
 * (credits by earliest expiry, largest remainder across kinds) and recorded one ChangeSet each through db.apply, on
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
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import type { ApplyError } from "#adapter/public/errors.ts"
import {
	applyFacts,
	insertAll,
	openPlatform,
	type PlatformDb
} from "#test/pg/e2e-platform/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import * as P from "#test/support/fixtures/api/platform.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	calendarOf,
	DAY,
	FAR,
	JAN,
	noFacts,
	type PlatformFacts,
	settleRequests,
	TOKENS_MAX,
	tierBounds,
	type UsageRequest,
	uid,
	viewOf
} from "#test/support/platform/generate.ts"
import { covers, platformSpan } from "#test/support/platform/model.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const C = JAN + 10n * DAY
const org = uid(1, 0)
const workspace = uid(2, 0)
const key = uid(3, 0)
const provider = uid(4, 0)
const model = uid(5, 0)
const grantIds = [uid(8, 0), uid(8, 1)] as const

/**
 * The static platform: the calendar month, the tenancy, the catalog, and the cards: input at 3 dollars per million
 * tokens until C and graduated from C, output flat.
 */
const months = calendarOf(1)
const staticFacts: PlatformFacts = {
	...noFacts,
	Month: Arr.map(months, (m) => ({
		month: P.MonthNo(m.month),
		during: { start: P.Instant(m.during.start), end: P.Instant(m.during.end) }
	})),
	Day: Arr.flatMap(months, (m) => {
		const days: Array<PlatformFacts["Day"][number]> = []
		for (let t = m.during.start; t < m.during.end; t += DAY) {
			days.push({
				day: P.DayNo(Number(t / DAY)),
				during: { start: P.Instant(t), end: P.Instant(t + DAY) },
				month: P.MonthNo(m.month)
			})
		}
		return days
	}),
	Org: [{ id: org }],
	Workspace: [{ id: workspace, org }],
	WorkspaceLimit: Arr.map(months, (m) => ({
		workspace,
		month: P.MonthNo(m.month),
		cap: P.Micros(10n ** 12n)
	})),
	ApiKey: [{ id: key, workspace, state: "active" }],
	ApiKeyActive: [{ key, during: { start: P.Instant(JAN), end: P.Instant(FAR) } }],
	Provider: [{ id: provider }],
	Model: [{ id: model }],
	Route: [{ model, provider }],
	ProviderPrice: [
		{
			provider,
			model,
			kind: "input",
			during: { start: P.Instant(JAN), end: P.Instant(FAR) },
			rate: P.Rate(1_800_000n)
		}
	],
	RateCard: [
		{ id: uid(6, 0), model, kind: "input", during: { start: P.Instant(JAN), end: P.Instant(C) } },
		{ id: uid(6, 1), model, kind: "input", during: { start: P.Instant(C), end: P.Instant(FAR) } }
	],
	RateTier: [
		{
			card: uid(6, 0),
			tier: { start: P.Tokens(0n), end: P.Tokens(TOKENS_MAX) },
			rate: P.Rate(3_000_000n)
		},
		{
			card: uid(6, 1),
			tier: { start: P.Tokens(0n), end: P.Tokens(tierBounds[0]) },
			rate: P.Rate(3_000_001n)
		},
		{
			card: uid(6, 1),
			tier: { start: P.Tokens(tierBounds[0]), end: P.Tokens(TOKENS_MAX) },
			rate: P.Rate(2_000_000n)
		}
	]
}

interface Grant {
	readonly amount: bigint
	readonly end: bigint
}

interface Request {
	readonly start: bigint
	readonly tokens: bigint
}

interface Point {
	readonly grants: readonly [Grant, Grant]
	readonly requests: readonly [Request, Request, Request]
}

const amounts: Arr.NonEmptyReadonlyArray<bigint> = [1n, 3000n]
const ends: Arr.NonEmptyReadonlyArray<bigint> = [C, FAR]
const starts: Arr.NonEmptyReadonlyArray<bigint> = [C - 1n, C]
const inputs: Arr.NonEmptyReadonlyArray<bigint> = [1n, 1001n]

const grantGen: Gen<Grant> = (source) => ({
	amount: source.draw(element(amounts)),
	end: source.draw(element(ends))
})

const requestGen: Gen<Request> = (source) => ({
	start: source.draw(element(starts)),
	tokens: source.draw(element(inputs))
})

/** Every point of the box: the grants outermost, then the requests. */
const box: Gen<Point> = (source) => ({
	grants: [source.draw(grantGen), source.draw(grantGen)],
	requests: [source.draw(requestGen), source.draw(requestGen), source.draw(requestGen)]
})

type BoxFeature =
	| "an event exactly at the rate change"
	| "a grant expiring at an event's start"
	| "a grant expiring at an event's end"
	| "an event split across grants"
	| "a tier boundary crossed within one event"

/** A grant that paid part of a record is reached only once every earlier-expiring eligible grant is spent. */
const spentInOrder = (
	r: P.UsageRecord,
	eligible: ReadonlyArray<{ readonly id: string }>,
	left: ReadonlyMap<string, bigint>
): void => {
	const paidBy = (grant: string): bigint =>
		Arr.reduce(
			Arr.filter(r.debits, (d) => d.grant === grant),
			0n,
			(sum: bigint, d) => sum + d.amount
		)
	for (const [i, g] of eligible.entries()) {
		if (paidBy(g.id) <= 0n) {
			continue
		}
		for (const earlier of eligible.slice(0, i)) {
			assert.equal(
				left.get(earlier.id) ?? 0n,
				paidBy(earlier.id),
				`${earlier.id} is spent before ${g.id}`
			)
		}
	}
}

/** A grant as the spending order reads it: its id and the end of its validity. */
interface Expiring {
	readonly id: string
	readonly valid: { readonly end: bigint }
}

/** Grants by the end of their validity, then by id: the order credits are spent in. */
const grantOrder: Order.Order<Expiring> = Order.combine(
	Order.mapInput(Order.BigInt, (g: Expiring) => g.valid.end),
	Order.mapInput(Order.String, (g: Expiring) => g.id)
)

const recordFacts = (r: P.UsageRecord): PlatformFacts => ({
	...noFacts,
	UsageEvent: [r.event],
	EventCharge: [r.total],
	UsageCharge: r.charges,
	ProviderCost: [r.cost],
	CreditDebit: r.debits
})

const decided = (db: PlatformDb, f: PlatformFacts): Effect.Effect<string, ApplyError> =>
	Effect.map(db.apply(insertAll(f), {}), (o) =>
		o.kind === "invariant-rejected" ? `refused by ${Formatter.format(o.refused.laws)}` : o.kind
	)

layer(Substrate.layer)("tiny platforms, exhausted", (it) => {
	it.effect("every settlement the model makes in the box is lawful, exact and recorded", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const s = yield* Substrate
				const o = yield* openPlatform("platform_box")
				/**
				 * A point's usage and grants cleared, with the workspace's monthly limits: a limit owns its month's
				 * event totals, a counted family whose count and sum it holds, so it is cleared with them and stored
				 * again beside the point's grants.
				 */
				const clear = s.admin.query(
					`TRUNCATE ${Arr.join(Arr.map(["CreditDebit", "UsageCharge", "EventCharge", "ProviderCost", "UsageEvent", "CreditGrant", "WorkspaceLimit"], o.table), ", ")}`,
					[]
				)
				/** One Db for the static platform and the whole box. */
				const exhausted = yield* o.withDb((db) =>
					Effect.gen(function* () {
						yield* applyFacts(db, staticFacts)
						return yield* exhaust(
							{
								box: { kind: "unstated" },
								oracle: { kind: "unstated" },
								suite: "pg/e2e-platform/box",
								generator: box,
								literal: Formatter.format,
								limit: 1024,
								caseHang,
								coverage: requiredInSpace<BoxFeature>([
									"an event exactly at the rate change",
									"a grant expiring at an event's start",
									"a grant expiring at an event's end",
									"a tier boundary crossed within one event",
									"an event split across grants"
								])
							},
							(point, cx) =>
								Effect.gen(function* () {
									yield* clear
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
										const pieces = yield* (yield* db.execute(P.eventCost, {
											event: record.event.id
										})).collect
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
										const days = yield* (yield* db.execute(P.burnDown, {
											grant: g.id
										})).collect
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
				)
				assert.equal(exhausted.cases, 1024)
				return exhausted
			})
		)
	)
})
