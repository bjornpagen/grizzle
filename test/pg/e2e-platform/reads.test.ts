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
 *   answers no row, concatenate to its every row, which are in the stated order;
 * - where the contract fully determines a number, it equals the host billing model's (test/support/platform/model.ts),
 *   a second implementation of the arithmetic: each tier piece of an event's charge and its sum per kind, which is what
 *   the model charged when the event was recorded, and a quote's price per kind.
 *
 * The planted platforms reach the features the population must keep reaching: an event exactly at a rate change, a
 * grant expiring exactly at an event's start and at its end, a cap hit exactly, zero-token and cache-only events, a
 * tier boundary crossed within one event, an event split across grants.
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): reads-page-skips.patch (a forward page's seek made inclusive, so its
 * anchor repeats).
 */
import { drawn, explore, type Kept } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, type Gen } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { fullSwarm } from "@bjornpagen/testing/swarm"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { indices } from "#compiler/core/array.ts"
import { isRecord } from "#compiler/core/record.ts"
import type { Anchor, CallError, Window } from "#compiler/live/index.ts"
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

import { oneOf, rowsOf } from "#test/support/calls.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	cardAt,
	chargeOf,
	piecesOf,
	type TokenKind,
	tokenKinds
} from "#test/support/platform/model.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { untilAnswered } from "#test/support/transient.ts"

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

/** The window of a paged member's every row: from its start, as many rows as a window takes. */
const everyRow: Window = { anchor: { kind: "start" }, size: Number.MAX_SAFE_INTEGER }

/**
 * A read: its name, its query (what the reference evaluates), its parameters drawn from a platform, and its run through
 * its workload member's once with those parameters, as its rows.
 */
interface ReadCase {
	readonly name: string
	readonly query: unknown
	readonly at: (
		p: Platform,
		pick: number
	) => {
		readonly params: Readonly<Record<string, unknown>>
		readonly rows: (db: PlatformDb) => Effect.Effect<ReadonlyArray<unknown>, CallError>
	}
}

const read = <A extends Readonly<Record<string, unknown>>>(
	name: string,
	query: unknown,
	params: (pick: number, p: Platform) => A,
	rows: (db: PlatformDb, a: A) => Effect.Effect<ReadonlyArray<unknown>, CallError>
): ReadCase => ({
	name,
	query,
	at: (p, pick) => {
		const a = params(pick, p)
		return { params: a, rows: (db) => rows(db, a) }
	}
})

const kindOf = (pick: number): TokenKind =>
	pickFrom(["input", "output", "cacheRead", "cacheWrite", "batchInput", "batchOutput"], pick)

const reads: ReadonlyArray<ReadCase> = [
	read(
		"eventCost",
		P.eventCost,
		(k, p) => ({ event: liveOr(ids(p.facts.UsageEvent), absentId, k) }),
		(db, a) => rowsOf(db.workload.eventCost.once({ params: a, facts: {} }))
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
		(db, a) => rowsOf(db.workload.quote.once({ params: a, facts: {} }))
	),
	read(
		"ratesAt",
		P.ratesAt,
		(k, p) => ({
			model: liveOr(ids(p.facts.Model), absentId, k),
			now: unit(pickFrom(instantsOf(p), k))
		}),
		(db, a) => rowsOf(db.workload.ratesAt.once({ params: a, facts: {} }))
	),
	read(
		"rateHistory",
		P.rateHistory,
		(k, p) => ({ model: liveOr(ids(p.facts.Model), absentId, k), kind: kindOf(k) }),
		(db, a) => rowsOf(db.workload.rateHistory.once({ params: a, facts: {} }))
	),
	read(
		"repricedInMonth",
		P.repricedInMonth,
		(k, p) => ({ workspace: liveOr(ids(p.facts.Workspace), absentId, k), month: monthOf(p, k) }),
		(db, a) => rowsOf(db.workload.repricedInMonth.once({ params: a, facts: {} }))
	),
	read(
		"spendByDay",
		P.spendByDay,
		(k, p) => ({ workspace: liveOr(ids(p.facts.Workspace), absentId, k), window: windowOf(p, k) }),
		(db, a) => rowsOf(db.workload.spendByDay.once({ params: a, facts: {} }))
	),
	read(
		"spendByMonth",
		P.spendByMonth,
		(k, p) => ({ workspace: liveOr(ids(p.facts.Workspace), absentId, k) }),
		(db, a) => rowsOf(db.workload.spendByMonth.once({ params: a, facts: {} }))
	),
	read(
		"workspaceMonth",
		P.workspaceMonth,
		(k, p) => ({ workspace: liveOr(ids(p.facts.Workspace), absentId, k), month: monthOf(p, k) }),
		(db, a) => rowsOf(db.workload.workspaceMonth.once({ params: a, facts: {} }))
	),
	read(
		"nearCap",
		P.nearCap,
		(k, p) => ({ org: liveOr(ids(p.facts.Org), absentId, k), month: monthOf(p, k) }),
		(db, a) => rowsOf(db.workload.nearCap.once({ params: a, facts: {} }))
	),
	read(
		"topModels",
		P.topModels,
		(k, p) => ({
			workspace: liveOr(ids(p.facts.Workspace), absentId, k),
			month: monthOf(p, k),
			k: 1 + (k % 3)
		}),
		(db, a) => rowsOf(db.workload.topModels.once({ params: a, facts: {} }))
	),
	read(
		"topProviders",
		P.topProviders,
		(k, p) => ({
			org: liveOr(ids(p.facts.Org), absentId, k),
			month: monthOf(p, k),
			k: 1 + (k % 2)
		}),
		(db, a) => rowsOf(db.workload.topProviders.once({ params: a, facts: {} }))
	),
	read(
		"marginByProvider",
		P.marginByProvider,
		(k, p) => ({ org: liveOr(ids(p.facts.Org), absentId, k), month: monthOf(p, k) }),
		(db, a) => rowsOf(db.workload.marginByProvider.once({ params: a, facts: {} }))
	),
	read(
		"consolidatedSpend",
		P.consolidatedSpend,
		(k, p) => ({ root: liveOr(ids(p.facts.Org), absentId, k), month: monthOf(p, k) }),
		(db, a) => rowsOf(db.workload.consolidatedSpend.once({ params: a, facts: {} }))
	),
	read(
		"balanceAt",
		P.balanceAt,
		(k, p) => ({
			org: liveOr(ids(p.facts.Org), absentId, k),
			now: unit(pickFrom(instantsOf(p), k))
		}),
		(db, a) => rowsOf(db.workload.balanceAt.once({ params: a, facts: {} }))
	),
	read(
		"expiringGrants",
		P.expiringGrants,
		(k, p) => ({ org: liveOr(ids(p.facts.Org), absentId, k), window: windowOf(p, k) }),
		(db, a) => rowsOf(db.workload.expiringGrants.once({ params: a, facts: {} }))
	),
	read(
		"burnDown",
		P.burnDown,
		(k, p) => ({ grant: liveOr(ids(p.facts.CreditGrant), absentId, k) }),
		(db, a) => rowsOf(db.workload.burnDown.once({ params: a, facts: {} }))
	),
	read(
		"keyCard",
		P.keyCard,
		(k, p) => ({ key: liveOr(ids(p.facts.ApiKey), absentId, k) }),
		(db, a) => rowsOf(db.workload.keyCard.once({ params: a, facts: {} }))
	),
	read(
		"usageLog",
		P.usageLog,
		(k, p) => ({ key: liveOr(ids(p.facts.ApiKey), absentId, k) }),
		(db, a) => rowsOf(db.workload.usageLog.once({ params: a, facts: {} }))
	),
	read(
		"idleKeys",
		P.idleKeys,
		(k, p) => ({ workspace: liveOr(ids(p.facts.Workspace), absentId, k), window: windowOf(p, k) }),
		(db, a) => rowsOf(db.workload.idleKeys.once({ params: a, facts: {} }))
	),
	read(
		"rollupVersusLive",
		P.rollupVersusLive,
		(k, p) => ({ workspace: liveOr(ids(p.facts.Workspace), absentId, k), window: windowOf(p, k) }),
		(db, a) => rowsOf(db.workload.rollupVersusLive.once({ params: a, facts: {} }))
	),
	read(
		"invoices",
		P.invoices,
		(k, p) => ({ org: liveOr(ids(p.facts.Org), absentId, k) }),
		(db, a) => rowsOf(db.workload.invoices.once({ params: a, facts: {}, window: everyRow }))
	),
	read(
		"invoiceAt",
		P.invoiceAt,
		(k, p) => ({
			org: liveOr(ids(p.facts.Org), absentId, k),
			now: unit(pickFrom(instantsOf(p), k))
		}),
		(db, a) => rowsOf(db.workload.invoiceAt.once({ params: a, facts: {} }))
	),
	read(
		"overdueInvoices",
		P.overdueInvoices,
		(k, p) => ({
			org: liveOr(ids(p.facts.Org), absentId, k),
			cutoff: P.Instant(pickFrom(instantsOf(p), k))
		}),
		(db, a) => rowsOf(db.workload.overdueInvoices.once({ params: a, facts: {} }))
	),
	read(
		"invoicePreview",
		P.invoicePreview,
		(k, p) => ({ invoice: liveOr(ids(p.facts.Invoice), absentId, k) }),
		(db, a) => rowsOf(db.workload.invoicePreview.once({ params: a, facts: {} }))
	),
	read(
		"refundable",
		P.refundable,
		(k, p) => ({ org: liveOr(ids(p.facts.Org), absentId, k) }),
		(db, a) => rowsOf(db.workload.refundable.once({ params: a, facts: {} }))
	),
	read(
		"refundsByReason",
		P.refundsByReason,
		(k, p) => ({ org: liveOr(ids(p.facts.Org), absentId, k), window: windowOf(p, k) }),
		(db, a) => rowsOf(db.workload.refundsByReason.once({ params: a, facts: {} }))
	),
	read(
		"mostRefunded",
		P.mostRefunded,
		(k) => ({ k: 1 + (k % 3) }),
		(db, a) => rowsOf(db.workload.mostRefunded.once({ params: a, facts: {} }))
	),
	read(
		"segmentsAt",
		P.segmentsAt,
		(k, p) => ({
			subscription: liveOr(ids(p.facts.Subscription), absentId, k),
			now: unit(pickFrom(instantsOf(p), k))
		}),
		(db, a) => rowsOf(db.workload.segmentsAt.once({ params: a, facts: {} }))
	),
	read(
		"prorationFor",
		P.prorationFor,
		(k, p) => ({ invoice: liveOr(ids(p.facts.Invoice), absentId, k) }),
		(db, a) => rowsOf(db.workload.prorationFor.once({ params: a, facts: {} }))
	),
	read(
		"mrrAt",
		P.mrrAt,
		(k, p) => ({
			org: liveOr(ids(p.facts.Org), absentId, k),
			now: unit(pickFrom(instantsOf(p), k))
		}),
		(db, a) => rowsOf(db.workload.mrrAt.once({ params: a, facts: {} }))
	),
	read(
		"recognizedIn",
		P.recognizedIn,
		(k, p) => ({ org: liveOr(ids(p.facts.Org), absentId, k), month: monthOf(p, k) }),
		(db, a) => rowsOf(db.workload.recognizedIn.once({ params: a, facts: {} }))
	),
	read(
		"allocationBreakdown",
		P.allocationBreakdown,
		(k, p) => ({ invoice: liveOr(ids(p.facts.Invoice), absentId, k) }),
		(db, a) => rowsOf(db.workload.allocationBreakdown.once({ params: a, facts: {} }))
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

/**
 * Every invoice of an organization, windowed `size` at a time and concatenated, each window anchored after the key of
 * the last row of the one before, until a window answers no row; each window's call run again after a transient
 * refusal (untilAnswered), `refused` told of each.
 */
const pagedInvoices = (
	db: PlatformDb,
	org: Uuid,
	size: number,
	refused: () => void
): Effect.Effect<ReadonlyArray<unknown>, CallError> => {
	const from = (
		anchor: Anchor,
		paged: ReadonlyArray<unknown>
	): Effect.Effect<ReadonlyArray<unknown>, CallError> =>
		Effect.flatMap(
			untilAnswered(
				db.workload.invoices.once({ params: { org }, facts: {}, window: { anchor, size } }),
				refused
			),
			(window) => {
				const entries = [...window.entries()]
				return Option.match(Arr.last(entries), {
					onNone: () => Effect.succeed(paged),
					onSome: (last) =>
						from({ kind: "after", key: last.key }, [...paged, ...Arr.map(entries, (e) => e.row)])
				})
			}
		)
	return from({ kind: "start" }, [])
}

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
		isRecord(r) && typeof r["amount"] === "bigint"
			? `${String(r["kind"])} ${String(r["tokens"])} ${r["amount"]}`
			: Formatter.format(r)
	)
	assert.deepEqual(Arr.sort(actual, Order.String), Arr.sort(expected, Order.String), "quote")
}

type ReadsFeature =
	| BuiltFeature
	| "a get answered"
	| "a get answered none"
	| "an ordered read paged"
	| "a call run again after a TransientFailure"

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
							oracle: {
								kind: "second-implementation",
								name: "the reference evaluator over each read's checked IR, and the host billing model's arithmetic"
							},
							suite: "pg/e2e-platform/reads",
							draw: drawn(readsSketchGen),
							literal: Formatter.format,
							kept,
							runs: 12,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang,
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
											const paged = yield* pagedInvoices(db, org, size, refused)
											assert.deepEqual(
												paged,
												[...all],
												"the windows concatenate to the ordered rows"
											)
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
