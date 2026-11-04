/**
 * Every workload read of the platform against two oracles, on generated platforms through the public runtime.
 *
 * The platform installs once with its workload (support.ts). Each case is a generated platform
 * (test/support/platform/generate.ts), small and drawn under a swarm, its instants from a dictionary of its own
 * boundaries, and billed: two or three months, each closed for every organization, with refunds on. The tables are
 * emptied, the platform's facts are stored by one db.apply, which the laws must accept (a lawful state by
 * construction), and DailySpend is refreshed by db.refresh. Then every read of the workload runs with parameters drawn
 * from the platform (an id it holds, or one it does not):
 *
 * - db.execute's rows, flattened statement by statement, agree with the reference evaluator over the read's checked IR
 *   and the same facts: the root's rows and each attachment's children per parent, as sets, each column by its type's
 *   equality; an arm's child is delivered exactly where its parent's handle selects it;
 * - db.get of the reads proved at most one row answers the reference's row or none, at a workspace's month the platform
 *   charged and at a drawn one;
 * - db.page of the ordered reads, page by page at a drawn size, concatenates to db.execute's rows, which are in the
 *   stated order;
 * - where the contract fully determines a number, it equals the host billing model's (test/support/platform/model.ts),
 *   a second implementation of the arithmetic: each tier piece of an event's charge and its sum per kind, which is what
 *   the model charged when the event was recorded, and a quote's price per kind.
 *
 * The planted platforms reach the features the population must keep reaching: an event exactly at a rate change, a
 * grant expiring exactly at an event's start and at its end, a cap hit exactly, zero-token and cache-only events, a
 * tier boundary crossed within one event, an event split across grants.
 */
import { layer } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { fullSwarm } from "@grizzle/testing/swarm"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, Order } from "effect"
import type { ReadError } from "#adapter/errors/execution.ts"
import type { QueryResult } from "#adapter/types/db.ts"
import { appendAll, indices } from "#compiler/core/array.ts"
import { isRecord } from "#compiler/core/record.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { Uuid } from "#compiler/scalar/values/uuid.ts"
import {
	applyFacts,
	dailySpendRows,
	differences,
	expectedOf,
	flattened,
	hostFacts,
	openPlatform,
	type PlatformDb
} from "#test/pg/e2e-platform/support.ts"
import { assert } from "#test/support/assert.ts"
import * as P from "#test/support/fixtures/api/platform.ts"
import { pickFrom, pickGen, pickIndex } from "#test/support/pick.ts"
import {
	billedSketchGen,
	type BuiltFeature,
	buildPlatform,
	builtFeatures,
	DAY,
	JAN,
	type Platform,
	type PlatformFeature,
	type PlatformSketch,
	resolvePlatform,
	uid,
	viewOf
} from "#test/support/platform/generate.ts"

import {
	cardAt,
	chargeOf,
	piecesOf,
	type TokenKind,
	tokenKinds
} from "#test/support/platform/model.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** One of the platform's values, or a value it does not hold: the last share of the picks selects the absent one. */
const liveOr = <A>(values: ReadonlyArray<A>, absent: A, pick: number): A => {
	const i = pickIndex(pick, values.length + 1)
	return values[i] ?? absent
}

const absentId = uid(0xdead, 1)

/** The instants a read is asked about: every boundary the platform holds, with its neighbours. */
const instantsOf = (p: Platform): Arr.NonEmptyReadonlyArray<bigint> => {
	const all = new Set<bigint>([JAN])
	const add = (t: bigint) => {
		for (const x of [t - 1n, t, t + 1n]) {
			if (x >= JAN) {
				all.add(x)
			}
		}
	}
	for (const e of p.facts.UsageEvent) {
		add(e.during.start)
	}
	for (const c of p.facts.RateCard) {
		add(c.during.start)
	}
	for (const g of p.facts.CreditGrant) {
		add(g.valid.start)
		add(g.valid.end)
	}
	for (const m of p.facts.Month) {
		add(m.during.start)
	}
	const sorted = Arr.sort([...all], Order.BigInt)
	return Arr.isReadonlyArrayNonEmpty(sorted) ? sorted : [JAN]
}

const unit = (t: bigint) => ({ start: P.Instant(t), end: P.Instant(t + 1n) })

/** A window: a calendar month, a run of days, or a span between two of the platform's instants. */
const windowOf = (p: Platform, pick: number) => {
	const instants = instantsOf(p)
	const months = p.facts.Month
	const choice = pickIndex(pick, 3)
	if (choice === 0 && months.length > 0) {
		return pickFrom(
			Arr.isReadonlyArrayNonEmpty(months) ? months : [months[0] ?? { during: unit(JAN) }],
			pick
		).during
	}
	const a = pickFrom(instants, pick)
	const b = pickFrom(instants, (pick * 7919) % 0x10000)
	const start = a < b ? a : b
	const end = a < b ? b : a + (choice === 1 ? 7n * DAY : 1n)
	return { start: P.Instant(start), end: P.Instant(end) }
}

/** A month the platform's calendar does not hold. */
const absentMonth = P.MonthNo(202612)

const monthOf = (p: Platform, pick: number) =>
	liveOr(
		Arr.map(p.facts.Month, (m) => m.month),
		absentMonth,
		pick
	)
const ids = (rows: ReadonlyArray<{ readonly id: Uuid }>) => Arr.map(rows, (r) => r.id)

/**
 * A read: its name, its query (what the reference evaluates), its parameters drawn from a platform, and its run through
 * db.execute with those parameters.
 */
interface ReadCase {
	readonly name: string
	readonly query: unknown
	readonly at: (
		p: Platform,
		pick: number
	) => {
		readonly params: Readonly<Record<string, unknown>>
		readonly execute: (db: PlatformDb) => Effect.Effect<QueryResult<unknown>, ReadError>
	}
}

const read = <A extends Readonly<Record<string, unknown>>>(
	name: string,
	query: unknown,
	params: (pick: number, p: Platform) => A,
	execute: (db: PlatformDb, a: A) => Effect.Effect<QueryResult<unknown>, ReadError>
): ReadCase => ({
	name,
	query,
	at: (p, pick) => {
		const a = params(pick, p)
		return { params: a, execute: (db) => execute(db, a) }
	}
})

const kindOf = (pick: number): TokenKind =>
	pickFrom(["input", "output", "cacheRead", "cacheWrite", "batchInput", "batchOutput"], pick)

const reads: ReadonlyArray<ReadCase> = [
	read(
		"eventCost",
		P.eventCost,
		(k, p) => ({ event: liveOr(ids(p.facts.UsageEvent), absentId, k) }),
		(db, a) => db.execute(P.eventCost, a)
	),
	read(
		"quote",
		P.quote,
		(k, p) => ({
			model: liveOr(ids(p.facts.Model), absentId, k),
			now: unit(pickFrom(instantsOf(p), k)),
			usage: Arr.dedupeWith(
				[
					{ kind: kindOf(k), tokens: P.Tokens(BigInt(k % 20_000)) },
					{ kind: kindOf((k + 0x4000) % 0x10000), tokens: P.Tokens(1001n) }
				],
				(a, b) => a.kind === b.kind
			)
		}),
		(db, a) => db.execute(P.quote, a)
	),
	read(
		"ratesAt",
		P.ratesAt,
		(k, p) => ({
			model: liveOr(ids(p.facts.Model), absentId, k),
			now: unit(pickFrom(instantsOf(p), k))
		}),
		(db, a) => db.execute(P.ratesAt, a)
	),
	read(
		"rateHistory",
		P.rateHistory,
		(k, p) => ({ model: liveOr(ids(p.facts.Model), absentId, k), kind: kindOf(k) }),
		(db, a) => db.execute(P.rateHistory, a)
	),
	read(
		"repricedInMonth",
		P.repricedInMonth,
		(k, p) => ({ workspace: liveOr(ids(p.facts.Workspace), absentId, k), month: monthOf(p, k) }),
		(db, a) => db.execute(P.repricedInMonth, a)
	),
	read(
		"spendByDay",
		P.spendByDay,
		(k, p) => ({ workspace: liveOr(ids(p.facts.Workspace), absentId, k), window: windowOf(p, k) }),
		(db, a) => db.execute(P.spendByDay, a)
	),
	read(
		"spendByMonth",
		P.spendByMonth,
		(k, p) => ({ workspace: liveOr(ids(p.facts.Workspace), absentId, k) }),
		(db, a) => db.execute(P.spendByMonth, a)
	),
	read(
		"workspaceMonth",
		P.workspaceMonth,
		(k, p) => ({ workspace: liveOr(ids(p.facts.Workspace), absentId, k), month: monthOf(p, k) }),
		(db, a) => db.execute(P.workspaceMonth, a)
	),
	read(
		"nearCap",
		P.nearCap,
		(k, p) => ({ org: liveOr(ids(p.facts.Org), absentId, k), month: monthOf(p, k) }),
		(db, a) => db.execute(P.nearCap, a)
	),
	read(
		"topModels",
		P.topModels,
		(k, p) => ({
			workspace: liveOr(ids(p.facts.Workspace), absentId, k),
			month: monthOf(p, k),
			k: 1 + (k % 3)
		}),
		(db, a) => db.execute(P.topModels, a)
	),
	read(
		"topProviders",
		P.topProviders,
		(k, p) => ({
			org: liveOr(ids(p.facts.Org), absentId, k),
			month: monthOf(p, k),
			k: 1 + (k % 2)
		}),
		(db, a) => db.execute(P.topProviders, a)
	),
	read(
		"marginByProvider",
		P.marginByProvider,
		(k, p) => ({ org: liveOr(ids(p.facts.Org), absentId, k), month: monthOf(p, k) }),
		(db, a) => db.execute(P.marginByProvider, a)
	),
	read(
		"consolidatedSpend",
		P.consolidatedSpend,
		(k, p) => ({ root: liveOr(ids(p.facts.Org), absentId, k), month: monthOf(p, k) }),
		(db, a) => db.execute(P.consolidatedSpend, a)
	),
	read(
		"balanceAt",
		P.balanceAt,
		(k, p) => ({
			org: liveOr(ids(p.facts.Org), absentId, k),
			now: unit(pickFrom(instantsOf(p), k))
		}),
		(db, a) => db.execute(P.balanceAt, a)
	),
	read(
		"expiringGrants",
		P.expiringGrants,
		(k, p) => ({ org: liveOr(ids(p.facts.Org), absentId, k), window: windowOf(p, k) }),
		(db, a) => db.execute(P.expiringGrants, a)
	),
	read(
		"burnDown",
		P.burnDown,
		(k, p) => ({ grant: liveOr(ids(p.facts.CreditGrant), absentId, k) }),
		(db, a) => db.execute(P.burnDown, a)
	),
	read(
		"keyCard",
		P.keyCard,
		(k, p) => ({ key: liveOr(ids(p.facts.ApiKey), absentId, k) }),
		(db, a) => db.execute(P.keyCard, a)
	),
	read(
		"usageLog",
		P.usageLog,
		(k, p) => ({ key: liveOr(ids(p.facts.ApiKey), absentId, k) }),
		(db, a) => db.execute(P.usageLog, a)
	),
	read(
		"idleKeys",
		P.idleKeys,
		(k, p) => ({ workspace: liveOr(ids(p.facts.Workspace), absentId, k), window: windowOf(p, k) }),
		(db, a) => db.execute(P.idleKeys, a)
	),
	read(
		"rollupVersusLive",
		P.rollupVersusLive,
		(k, p) => ({ workspace: liveOr(ids(p.facts.Workspace), absentId, k), window: windowOf(p, k) }),
		(db, a) => db.execute(P.rollupVersusLive, a)
	),
	read(
		"invoices",
		P.invoices,
		(k, p) => ({ org: liveOr(ids(p.facts.Org), absentId, k) }),
		(db, a) => db.execute(P.invoices, a)
	),
	read(
		"invoiceAt",
		P.invoiceAt,
		(k, p) => ({
			org: liveOr(ids(p.facts.Org), absentId, k),
			now: unit(pickFrom(instantsOf(p), k))
		}),
		(db, a) => db.execute(P.invoiceAt, a)
	),
	read(
		"overdueInvoices",
		P.overdueInvoices,
		(k, p) => ({
			org: liveOr(ids(p.facts.Org), absentId, k),
			cutoff: P.Instant(pickFrom(instantsOf(p), k))
		}),
		(db, a) => db.execute(P.overdueInvoices, a)
	),
	read(
		"invoicePreview",
		P.invoicePreview,
		(k, p) => ({ invoice: liveOr(ids(p.facts.Invoice), absentId, k) }),
		(db, a) => db.execute(P.invoicePreview, a)
	),
	read(
		"refundable",
		P.refundable,
		(k, p) => ({ org: liveOr(ids(p.facts.Org), absentId, k) }),
		(db, a) => db.execute(P.refundable, a)
	),
	read(
		"refundsByReason",
		P.refundsByReason,
		(k, p) => ({ org: liveOr(ids(p.facts.Org), absentId, k), window: windowOf(p, k) }),
		(db, a) => db.execute(P.refundsByReason, a)
	),
	read(
		"mostRefunded",
		P.mostRefunded,
		(k) => ({ k: 1 + (k % 3) }),
		(db, a) => db.execute(P.mostRefunded, a)
	),
	read(
		"segmentsAt",
		P.segmentsAt,
		(k, p) => ({
			subscription: liveOr(ids(p.facts.Subscription), absentId, k),
			now: unit(pickFrom(instantsOf(p), k))
		}),
		(db, a) => db.execute(P.segmentsAt, a)
	),
	read(
		"prorationFor",
		P.prorationFor,
		(k, p) => ({ invoice: liveOr(ids(p.facts.Invoice), absentId, k) }),
		(db, a) => db.execute(P.prorationFor, a)
	),
	read(
		"mrrAt",
		P.mrrAt,
		(k, p) => ({
			org: liveOr(ids(p.facts.Org), absentId, k),
			now: unit(pickFrom(instantsOf(p), k))
		}),
		(db, a) => db.execute(P.mrrAt, a)
	),
	read(
		"recognizedIn",
		P.recognizedIn,
		(k, p) => ({ org: liveOr(ids(p.facts.Org), absentId, k), month: monthOf(p, k) }),
		(db, a) => db.execute(P.recognizedIn, a)
	),
	read(
		"allocationBreakdown",
		P.allocationBreakdown,
		(k, p) => ({ invoice: liveOr(ids(p.facts.Invoice), absentId, k) }),
		(db, a) => db.execute(P.allocationBreakdown, a)
	)
]

/** The arms of the workload: the attachment, the parent field and the handle that selects it. */
const arms: ReadonlyArray<{
	readonly read: string
	readonly path: ReadonlyArray<string>
	readonly field: string
	readonly handle: string
}> = [
	{ read: "keyCard", path: ["revocation"], field: "state", handle: "revoked" },
	{ read: "invoicePreview", path: ["payment"], field: "state", handle: "paid" },
	{ read: "invoicePreview", path: ["dispute"], field: "state", handle: "disputed" },
	{ read: "invoicePreview", path: ["lines", "usage"], field: "source", handle: "usage" },
	{ read: "invoicePreview", path: ["lines", "plan"], field: "source", handle: "plan" }
]

/** Every row at the end of `path` below the rows, each with the parent it is attached under. */
const armRows = (
	rows: ReadonlyArray<unknown>,
	path: ReadonlyArray<string>
): ReadonlyArray<{
	readonly parent: Readonly<Record<string, unknown>>
	readonly delivered: unknown
}> => {
	const [head, ...rest] = path
	if (head === undefined) {
		return []
	}
	return Arr.flatMap(rows, (row) => {
		if (!isRecord(row)) {
			return []
		}
		if (rest.length === 0) {
			return [{ parent: row, delivered: row[head] }]
		}
		const children = row[head]
		return armRows(Arr.isArray(children) ? children : [], rest)
	})
}

/** Each arm of a read's rows delivers Some exactly where its parent's field holds the arm's handle. */
const checkArms = (readName: string, rows: ReadonlyArray<unknown>): void => {
	for (const a of Arr.filter(arms, (x) => x.read === readName)) {
		for (const { parent, delivered } of armRows(rows, a.path)) {
			assert.equal(
				Option.isOption(delivered) && Option.isSome(delivered),
				parent[a.field] === a.handle,
				`${readName}: the arm ${Arr.join(a.path, "/")} is Some exactly where ${a.field} is ${a.handle}`
			)
		}
	}
}

/** Every invoice of an organization, paged `size` at a time and concatenated, following each page's end cursor. */
const pagedInvoices = (db: PlatformDb, org: Uuid, size: number) =>
	Effect.gen(function* () {
		const paged: Array<unknown> = []
		let page = yield* db.page(P.invoices, { org }, { first: size })
		for (;;) {
			appendAll(
				paged,
				Arr.map(page.edges, (e) => e.node)
			)
			const next = page.pageInfo.endCursor
			if (!page.pageInfo.hasNextPage || Option.isNone(next)) {
				return paged
			}
			page = yield* db.page(P.invoices, { org }, { first: size, after: next.value })
		}
	})

/** eventCost's pieces are the model's, and their sum per kind is what the model charged when the event was recorded. */
const checkEventCost = (p: Platform, event: string, rows: ReadonlyArray<unknown>) => {
	const view = viewOf(p.facts)
	const recorded = Arr.findFirst(p.facts.UsageEvent, (x) => x.id === event)
	const charges = Arr.filter(p.facts.UsageCharge, (c) => c.event === event)
	const expected = Arr.flatMap(charges, (c) => {
		const card = Option.flatMap(recorded, (e) =>
			cardAt(view.cardsOf.get(`${e.model}|${c.kind}`) ?? [], e.model, c.kind, e.during.start)
		)
		return Arr.map(
			Option.match(card, { onNone: () => [], onSome: (found) => piecesOf(found.tiers, c.tokens) }),
			(piece) => `${c.kind} [${piece.tier.start},${piece.tier.end}) ${piece.tokens} ${piece.amount}`
		)
	})
	const actual = Arr.map(rows, (r) =>
		isRecord(r) && isRecord(r["tier"])
			? `${String(r["kind"])} [${String(r["tier"]["start"])},${String(r["tier"]["end"])}) ${String(r["tokens"])} ${String(r["amount"])}`
			: String(r)
	)
	assert.deepEqual(
		Arr.sort(actual, Order.String),
		Arr.sort(expected, Order.String),
		`eventCost(${event})`
	)
	for (const c of charges) {
		const sum = Arr.reduce(rows, 0n, (s: bigint, r) =>
			isRecord(r) && r["kind"] === c.kind && typeof r["amount"] === "bigint" ? s + r["amount"] : s
		)
		assert.equal(sum, c.amount, `the pieces of ${event}'s ${c.kind} sum to what it was charged`)
	}
}

/** A quote prices each kind the model prices: its tokens, and the sum of its tier pieces. */
const checkQuote = (
	p: Platform,
	params: Readonly<Record<string, unknown>>,
	rows: ReadonlyArray<unknown>
) => {
	const view = viewOf(p.facts)
	const model = String(params["model"])
	const now =
		isRecord(params["now"]) && typeof params["now"]["start"] === "bigint"
			? params["now"]["start"]
			: JAN
	const usage = Arr.isArray(params["usage"]) ? params["usage"] : []
	const expected = Arr.flatMap(usage, (u: unknown) => {
		if (!isRecord(u) || typeof u["tokens"] !== "bigint") {
			return []
		}
		const named = Arr.findFirst(tokenKinds, (k) => k === u["kind"])
		if (Option.isNone(named)) {
			return []
		}
		const kind = named.value
		const tokens = u["tokens"]
		return Option.toArray(
			Option.map(
				Option.filter(
					cardAt(view.cardsOf.get(`${model}|${kind}`) ?? [], model, kind, now),
					(card) => piecesOf(card.tiers, tokens).length > 0
				),
				(card) => `${kind} ${tokens} ${chargeOf(card.tiers, tokens)}`
			)
		)
	})
	const actual = Arr.map(rows, (r) =>
		isRecord(r) && r["amount"] instanceof Decimal
			? `${String(r["kind"])} ${String(r["tokens"])} ${r["amount"].toString()}`
			: String(r)
	)
	assert.deepEqual(Arr.sort(actual, Order.String), Arr.sort(expected, Order.String), "quote")
}

type ReadsFeature =
	| BuiltFeature
	| "a get answered"
	| "a get answered none"
	| "an ordered read paged"

/**
 * A case as drawn: a billed platform's sketch, so its organizations hold invoices to page and refund, and one pick per
 * read for its parameters, drawn beside the platform.
 */
interface ReadsSketch {
	readonly platform: PlatformSketch
	readonly picks: ReadonlyArray<number>
}

const readsSketchGen: Gen<ReadsSketch> = (source) => ({
	platform: source.draw(billedSketchGen),
	picks: source.draw(array(pickGen, { min: reads.length, max: reads.length }))
})

const keptPicks: ReadonlyArray<number> = Arr.map(indices(reads.length), (i) => (i * 9973) % 0x10000)

const planted = (on: ReadonlyArray<PlatformFeature>, months: number): PlatformSketch => ({
	swarm: fullSwarm(on),
	months,
	orgs: [{ parent: 0 }, { parent: 0xffff }],
	workspaces: [
		{ org: 0, cap: 0xffff },
		{ org: 0xffff, cap: 0 }
	],
	keys: [
		{ workspace: 0, created: 0, revoked: 0 },
		{ workspace: 0xffff, created: 0, revoked: 0x8000 }
	],
	models: 2,
	providers: 2,
	rateChanges: [{ model: 0xffff, kind: 0x4000, at: 0x6000, rate: 0xffff, tiered: 0xffff }],
	grants: [{ org: 0xffff, amount: 0xffff, start: 0, end: 0xffff }],
	subscriptions: [{ org: 0, price: 0, change: 0x8000 }],
	events: [
		{ key: 0, route: 0, start: 0x3000, latency: 0, tokens: [0x4000, 0x8000, 0, 0, 0, 0] },
		{
			key: 0xffff,
			route: 0xffff,
			start: 0x5000,
			latency: 0x8000,
			tokens: [0xffff, 0x2000, 0x9000, 0, 0x8000, 0]
		}
	],
	closes: [
		{ settle: 0x4000, refunds: [0, 0x4000, 0x4000] },
		{ settle: 0x9999, refunds: [] },
		{ settle: 0xd000, refunds: [] },
		{ settle: 0xffff, refunds: [] }
	]
})

/** The kept platforms' swarms turn each form fully on or off, so they resolve without drawing. */
const kept: ReadonlyArray<Kept<ReadsSketch, ReadsFeature>> = [
	{
		note: "boundaries planted: a rate change, grants expiring at an event's start and end, a split across grants, a cap hit exactly",
		sketch: {
			platform: planted(["planted boundaries", "tiers", "rate changes", "grants", "exact caps"], 2),
			picks: keptPicks
		},
		draws: "",
		reaches: [
			"an event at a rate change",
			"a grant expiring at an event's start",
			"a grant expiring at an event's end",
			"an event split across grants",
			"a tier boundary crossed within one event",
			"a cache-only event",
			"a zero-token event",
			"a cap hit exactly"
		]
	},
	{
		note: "billing planted: a reseller tree, a Team plan changed mid-month, refunds, disputes and voids",
		sketch: {
			platform: planted(
				[
					"planted boundaries",
					"resellers",
					"team plan",
					"refunds",
					"disputes and voids",
					"revocations"
				],
				2
			),
			picks: keptPicks
		},
		draws: "",
		reaches: ["a reseller tree", "a refund"]
	}
]

layer(Substrate.layer)(
	"the platform's workload reads against the reference and the billing model",
	(it) => {
		it.effect("every workload read agrees with the reference evaluator and the model", (ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const platform = yield* openPlatform("platform_reads")
					return yield* explore(
						{
							suite: "pg/e2e-platform/reads",
							draw: drawn(readsSketchGen),
							literal: Formatter.format,
							kept,
							runs: 12,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang: Duration.minutes(2),
							coverage: required<ReadsFeature>(
								[
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
								],
								{ cases: 12, sense: notesOnly }
							)
						},
						({ platform: sketch, picks }, cx) =>
							Effect.gen(function* () {
								const p: Platform = buildPlatform(cx.draw(resolvePlatform(sketch)))
								cx.noteAll(builtFeatures(p))
								yield* platform.clear
								yield* platform.withDb((db) =>
									Effect.gen(function* () {
										yield* applyFacts(db, p.facts)
										yield* db.refresh(platform.schema.Billing.relations.DailySpend)
										const facts = hostFacts(p.facts, dailySpendRows(p.facts))
										for (const [i, r] of reads.entries()) {
											const { params, execute } = r.at(p, picks[i] ?? 0)
											const rows = yield* (yield* execute(db)).collect
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
										 * get over the reads proved at most one row: at a workspace's month the platform charged (or
										 * one it does not hold), and at a drawn workspace and month.
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
											const got = yield* db.get(P.workspaceMonth, at)
											const executed = yield* (yield* db.execute(P.workspaceMonth, at)).collect
											assert.deepEqual(
												[...Option.toArray(got)],
												[...executed],
												"get answers execute's one row or none"
											)
											cx.note(Option.isSome(got) ? "a get answered" : "a get answered none")
										}
										/**
										 * page over the ordered reads, at a drawn size, concatenates to execute's ordered rows.
										 */
										const size = 1 + (getPick % 3)
										for (const org of ids(p.facts.Org).slice(0, 2)) {
											const all = yield* (yield* db.execute(P.invoices, { org })).collect
											const paged = yield* pagedInvoices(db, org, size)
											assert.deepEqual(paged, [...all], "the pages concatenate to the ordered rows")
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
					)
				})
			)
		)
	}
)
