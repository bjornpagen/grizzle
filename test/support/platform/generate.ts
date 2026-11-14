/**
 * Generated platforms for the platform fixture (test/support/fixtures/api/platform.ts): their facts, built through the
 * host billing model (model.ts), so every generated state is one the laws admit.
 *
 * A platform is built in three steps:
 *
 * 1. Its setup: the calendar, tenancy (organizations under resellers, workspaces with a cap per month, keys with their
 *    active spans and revocations), the catalog (models, providers, routes, provider prices), the rate cards of every
 *    model's kinds over the whole calendar with their tiers, credit grants and Team plan subscriptions with their
 *    priced segments.
 * 2. Its usage: requests in start order, each priced at its start by the card in force, settled from the organization's
 *    grants by earliest expiry, and charged to its workspace's month. A request the laws would refuse (a window outside
 *    its key's active spans, a kind no card prices at its start, a spend past the cap) is not recorded and is reported
 *    with its reason.
 * 3. Its billing: the months closed per organization, invoices paid, refunded, disputed or voided.
 *
 * Three generators build platforms. platformSketchGen draws small platforms whose instants come from a dictionary of
 * the platform's own boundaries (month starts, rate changes, grant expiries, revocations, each with its neighbours),
 * whose token counts come from a dictionary of the tiers' boundaries, and whose features a swarm turns on and off per
 * case; billedSketchGen draws them billed, every month closed for every organization with refunds on. volumePlatform
 * builds one platform of pinned sizes by modular arithmetic over row numbers, for the plan properties: the same rules,
 * at a volume where the planner's choices matter.
 */
import { array, type Gen, int, map, type Size } from "@bjornpagen/testing/gen"
import { keep, type Swarm, swarm, weightOf } from "@bjornpagen/testing/swarm"
import { Array as Arr, Option, Order, pipe, String as Str } from "effect"
import { indices } from "#compiler/core/array.ts"
import type { Addition } from "#compiler/public/changeset.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import { nonEmpty } from "#test/support/assert.ts"
import * as P from "#test/support/fixtures/api/platform.ts"
import { pickFrom, pickGen, pickIndex, pickOf } from "#test/support/pick.ts"
import {
	type CardM,
	cardAt,
	chargeOf,
	coveredBy,
	type GrantM,
	holds,
	microsPerMillion,
	overlapOf,
	piecesOf,
	pricedAt,
	prorated,
	type SpanV,
	settle,
	platformSpan,
	type TokenKind,
	tokenKinds,
	width
} from "#test/support/platform/model.ts"

export const DAY = 86_400n
/** 2026-01-01T00:00:00Z. */
export const JAN = 1_767_225_600n
/** 2100-01-01T00:00:00Z: the end of a span that has not ended. */
export const FAR = 4_102_444_800n
/** The end of a card's last tier. */
export const TOKENS_MAX = 1n << 40n
/** The tiers' boundaries of a tiered card: [0, 1000), [1000, 10000), [10000, TOKENS_MAX). */
export const tierBounds = [1000n, 10_000n] as const

const daysIn2026 = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/** A deterministic uuid: the family in the first group, the row number in the last. */
export const uid = (family: number, n: number): Uuid =>
	`${pipe(family.toString(16), Str.padStart(8, "0"))}-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

const family = {
	org: 1,
	workspace: 2,
	key: 3,
	provider: 4,
	model: 5,
	card: 6,
	event: 7,
	grant: 8,
	invoice: 9,
	line: 10,
	subscription: 11,
	refund: 12,
	charge: 13
} as const

const instant = (t: bigint) => P.Instant(t)
const spanOf = (s: SpanV) => ({ start: P.Instant(s.start), end: P.Instant(s.end) })
const tokenSpan = (s: SpanV) => ({ start: P.Tokens(s.start), end: P.Tokens(s.end) })

/**
 * A relation's facts as its caller writes them (Addition<R>): grizzle draws every count and accumulates every sum of a
 * counted family, so a fact holds no drawn or accumulated field.
 */
type Facts<R> = ReadonlyArray<Addition<R>>

/** Every stored relation's facts. */
export interface PlatformFacts {
	readonly Org: Facts<typeof P.Org>
	readonly ParentOrg: Facts<typeof P.ParentOrg>
	readonly Workspace: Facts<typeof P.Workspace>
	readonly ApiKey: Facts<typeof P.ApiKey>
	readonly Revocation: Facts<typeof P.Revocation>
	readonly ApiKeyActive: Facts<typeof P.ApiKeyActive>
	readonly Provider: Facts<typeof P.Provider>
	readonly Model: Facts<typeof P.Model>
	readonly Route: Facts<typeof P.Route>
	readonly ProviderPrice: Facts<typeof P.ProviderPrice>
	readonly RateCard: Facts<typeof P.RateCard>
	readonly RateTier: Facts<typeof P.RateTier>
	readonly UsageEvent: Facts<typeof P.UsageEvent>
	readonly UsageCharge: Facts<typeof P.UsageCharge>
	readonly EventCharge: Facts<typeof P.EventCharge>
	readonly ProviderCost: Facts<typeof P.ProviderCost>
	readonly CreditGrant: Facts<typeof P.CreditGrant>
	readonly CreditDebit: Facts<typeof P.CreditDebit>
	readonly WorkspaceLimit: Facts<typeof P.WorkspaceLimit>
	readonly Day: Facts<typeof P.Day>
	readonly Month: Facts<typeof P.Month>
	readonly Invoice: Facts<typeof P.Invoice>
	readonly InvoiceLine: Facts<typeof P.InvoiceLine>
	readonly UsageLine: Facts<typeof P.UsageLine>
	readonly PlanLine: Facts<typeof P.PlanLine>
	readonly Payment: Facts<typeof P.Payment>
	readonly Voiding: Facts<typeof P.Voiding>
	readonly Dispute: Facts<typeof P.Dispute>
	readonly Refund: Facts<typeof P.Refund>
	readonly Subscription: Facts<typeof P.Subscription>
	readonly Segment: Facts<typeof P.Segment>
	readonly Allocation: Facts<typeof P.Allocation>
}

export const noFacts: PlatformFacts = {
	Org: [],
	ParentOrg: [],
	Workspace: [],
	ApiKey: [],
	Revocation: [],
	ApiKeyActive: [],
	Provider: [],
	Model: [],
	Route: [],
	ProviderPrice: [],
	RateCard: [],
	RateTier: [],
	UsageEvent: [],
	UsageCharge: [],
	EventCharge: [],
	ProviderCost: [],
	CreditGrant: [],
	CreditDebit: [],
	WorkspaceLimit: [],
	Day: [],
	Month: [],
	Invoice: [],
	InvoiceLine: [],
	UsageLine: [],
	PlanLine: [],
	Payment: [],
	Voiding: [],
	Dispute: [],
	Refund: [],
	Subscription: [],
	Segment: [],
	Allocation: []
}

/** The relations in the order a load writes them, each after every relation its containments reach. */
export const loadOrder = [
	"Month",
	"Day",
	"Org",
	"ParentOrg",
	"Workspace",
	"WorkspaceLimit",
	"ApiKey",
	"Revocation",
	"ApiKeyActive",
	"Provider",
	"Model",
	"Route",
	"ProviderPrice",
	"RateCard",
	"RateTier",
	"CreditGrant",
	"Subscription",
	"Segment",
	"UsageEvent",
	"EventCharge",
	"UsageCharge",
	"ProviderCost",
	"CreditDebit",
	"Invoice",
	"InvoiceLine",
	"UsageLine",
	"PlanLine",
	"Allocation",
	"Payment",
	"Voiding",
	"Dispute",
	"Refund"
] as const satisfies ReadonlyArray<keyof PlatformFacts>

interface MonthM {
	readonly month: number
	readonly during: SpanV
}

/**
 * The first `months` calendar months of 2026 and their days, UTC: a month numbered yyyymm, a day by its days since
 * the epoch.
 */
export const calendarOf = (months: number): ReadonlyArray<MonthM> => {
	const out: Array<MonthM> = []
	let start = JAN
	for (let m = 0; m < months; m++) {
		const days = BigInt(daysIn2026[m % 12] ?? 30)
		out.push({ month: 202601 + m, during: platformSpan(start, start + days * DAY) })
		start += days * DAY
	}
	return out
}

const calendarFacts = (months: ReadonlyArray<MonthM>): Pick<PlatformFacts, "Month" | "Day"> => ({
	Month: Arr.map(months, (m) => ({ month: P.MonthNo(m.month), during: spanOf(m.during) })),
	Day: Arr.flatMap(months, (m) => {
		const days: Array<Addition<typeof P.Day>> = []
		for (let t = m.during.start; t < m.during.end; t += DAY) {
			days.push({
				day: P.DayNo(Number(t / DAY)),
				during: spanOf(platformSpan(t, t + DAY)),
				month: P.MonthNo(m.month)
			})
		}
		return days
	})
})

const keyOf = (...parts: ReadonlyArray<string | number | bigint>): string =>
	Arr.join(
		Arr.map(parts, (part) => `${part}`),
		"|"
	)

interface ModelView {
	readonly months: ReadonlyArray<MonthM>
	readonly workspaceOrg: ReadonlyMap<string, Uuid>
	readonly keyWorkspace: ReadonlyMap<string, Uuid>
	readonly keyActive: ReadonlyMap<string, ReadonlyArray<SpanV>>
	readonly routes: ReadonlySet<string>
	readonly cards: ReadonlyArray<CardM>
	/** The cards of each model's kind. */
	readonly cardsOf: ReadonlyMap<string, ReadonlyArray<CardM>>
	readonly providerRates: ReadonlyMap<
		string,
		ReadonlyArray<{ readonly during: SpanV; readonly rate: bigint }>
	>
	readonly grants: ReadonlyArray<GrantM>
	readonly caps: ReadonlyMap<string, bigint>
}

const plain = (s: { readonly start: bigint; readonly end: bigint }): SpanV =>
	platformSpan(s.start, s.end)

const group = <A, K>(items: ReadonlyArray<A>, by: (a: A) => K): Map<K, Array<A>> => {
	const out = new Map<K, Array<A>>()
	for (const item of items) {
		const k = by(item)
		const list = out.get(k)
		if (list === undefined) {
			out.set(k, [item])
		} else {
			list.push(item)
		}
	}
	return out
}

export const viewOf = (facts: PlatformFacts): ModelView => {
	const tiers = group(facts.RateTier, (t) => t.card)
	const cards: ReadonlyArray<CardM> = Arr.map(facts.RateCard, (c) => ({
		id: c.id,
		model: c.model,
		kind: c.kind,
		during: plain(c.during),
		tiers: Arr.map(tiers.get(c.id) ?? [], (t) => ({ tier: plain(t.tier), rate: t.rate }))
	}))
	return {
		months: Arr.map(facts.Month, (m) => ({ month: m.month, during: plain(m.during) })),
		workspaceOrg: new Map(Arr.map(facts.Workspace, (w) => [w.id, w.org])),
		keyWorkspace: new Map(Arr.map(facts.ApiKey, (k) => [k.id, k.workspace])),
		keyActive: new Map(
			Arr.map([...group(facts.ApiKeyActive, (a) => a.key)], ([k, spans]) => [
				k,
				Arr.map(spans, (s) => plain(s.during))
			])
		),
		routes: new Set(Arr.map(facts.Route, (r) => keyOf(r.model, r.provider))),
		cards,
		cardsOf: group(cards, (c) => keyOf(c.model, c.kind)),
		providerRates: new Map(
			Arr.map(
				[...group(facts.ProviderPrice, (p) => keyOf(p.provider, p.model, p.kind))],
				([k, prices]) => [k, Arr.map(prices, (p) => ({ during: plain(p.during), rate: p.rate }))]
			)
		),
		grants: Arr.map(facts.CreditGrant, (g) => ({
			id: g.id,
			org: g.org,
			amount: g.amount,
			valid: plain(g.valid)
		})),
		caps: new Map(Arr.map(facts.WorkspaceLimit, (l) => [keyOf(l.workspace, l.month), l.cap]))
	}
}

/** The calendar month holding an instant, if one does. */
export const monthAt = (months: ReadonlyArray<MonthM>, t: bigint): Option.Option<MonthM> =>
	Arr.findFirst(months, (m) => holds(m.during, t))

export interface UsageRequest {
	readonly id: Uuid
	readonly key: Uuid
	readonly model: Uuid
	readonly provider: Uuid
	readonly during: SpanV
	/** Tokens per kind; a kind left out used none. */
	readonly tokens: ReadonlyArray<{ readonly kind: TokenKind; readonly tokens: bigint }>
}

/** Requests by start, then by id. */
const requestOrder: Order.Order<UsageRequest> = Order.combine(
	Order.mapInput(Order.BigInt, (r: UsageRequest) => r.during.start),
	Order.mapInput(Order.String, (r: UsageRequest) => r.id)
)

/**
 * Why the model does not record a request: the laws that would refuse it. "unpriced" is a kind no card of the model
 * prices at the window's start, which pricedByCard refuses (model.ts pricedAt, cardAt).
 */
export type Refusal = "inactive key" | "no route" | "over cap" | "no cap" | "unpriced"

export interface Settled {
	readonly records: ReadonlyArray<P.UsageRecord>
	readonly refused: ReadonlyArray<{
		readonly request: UsageRequest
		readonly reasons: ReadonlyArray<Refusal>
	}>
	/** What each grant has left and each workspace month has spent after the usage. */
	readonly left: ReadonlyMap<string, bigint>
	readonly spent: ReadonlyMap<string, bigint>
}

/**
 * What every usage request costs and how it is settled, in order, against the platform's view; a request the model
 * refuses changes nothing. `spent` and `left` are the spend and grant balances before the first request.
 */
export const settleRequests = (
	view: ModelView,
	requests: ReadonlyArray<UsageRequest>,
	before: {
		readonly left: ReadonlyMap<string, bigint>
		readonly spent: ReadonlyMap<string, bigint>
	}
): Settled => {
	const left = new Map(before.left)
	const spent = new Map(before.spent)
	const grantsOf = group(view.grants, (g) => g.org)
	const records: Array<P.UsageRecord> = []
	const refused: Array<{
		readonly request: UsageRequest
		readonly reasons: ReadonlyArray<Refusal>
	}> = []
	for (const q of requests) {
		const reasons: Array<Refusal> = []
		const workspace = view.keyWorkspace.get(q.key)
		const org = workspace === undefined ? undefined : view.workspaceOrg.get(workspace)
		if (!coveredBy(view.keyActive.get(q.key) ?? [], q.during)) {
			reasons.push("inactive key")
		}
		if (!view.routes.has(keyOf(q.model, q.provider))) {
			reasons.push("no route")
		}
		const at = q.during.start
		const month = monthAt(view.months, at)
		const used = Arr.filter(q.tokens, (t) => t.tokens > 0n)
		const priced = Arr.map(used, (t) => ({
			kind: t.kind,
			amount: Option.map(
				cardAt(view.cardsOf.get(keyOf(q.model, t.kind)) ?? [], q.model, t.kind, at),
				(card) => chargeOf(card.tiers, t.tokens)
			)
		}))
		if (Arr.some(priced, (p) => Option.isNone(p.amount))) {
			reasons.push("unpriced")
		}
		const charges = Arr.flatMap(priced, (p) =>
			Option.toArray(Option.map(p.amount, (amount) => ({ kind: p.kind, amount })))
		)
		const total = Arr.reduce(charges, 0n, (s, c) => s + c.amount)
		const capped = Option.flatMap(
			Option.all({ w: Option.fromUndefinedOr(workspace), m: month }),
			({ w, m }) =>
				Option.map(Option.fromUndefinedOr(view.caps.get(keyOf(w, m.month))), (cap) => ({
					key: keyOf(w, m.month),
					cap
				}))
		)
		if (Option.isNone(capped)) {
			reasons.push("no cap")
		} else if ((spent.get(capped.value.key) ?? 0n) + total > capped.value.cap) {
			reasons.push("over cap")
		}
		if (
			reasons.length > 0 ||
			workspace === undefined ||
			org === undefined ||
			Option.isNone(month)
		) {
			refused.push({ request: q, reasons })
			continue
		}
		const monthNo = month.value.month
		const settlement = settle(charges, grantsOf.get(org) ?? [], (g) => left.get(g) ?? 0n, q.during)
		for (const d of settlement.debits) {
			left.set(d.grant, (left.get(d.grant) ?? 0n) - d.amount)
		}
		spent.set(keyOf(workspace, monthNo), (spent.get(keyOf(workspace, monthNo)) ?? 0n) + total)
		const cost = Arr.reduce(used, 0n, (s, t) =>
			Option.match(
				Arr.findFirst(view.providerRates.get(keyOf(q.provider, q.model, t.kind)) ?? [], (p) =>
					holds(p.during, at)
				),
				{
					onNone: () => s,
					onSome: (rate) => s + (t.tokens * rate.rate + microsPerMillion / 2n) / microsPerMillion
				}
			)
		)
		/** A kind the request does not carry has no tokens. */
		const tokensOf = (kind: TokenKind): bigint =>
			Option.match(
				Arr.findFirst(used, (t) => t.kind === kind),
				{ onNone: () => 0n, onSome: (t) => t.tokens }
			)
		records.push({
			event: {
				id: q.id,
				key: q.key,
				model: q.model,
				provider: q.provider,
				during: spanOf(q.during)
			},
			charges: Arr.map(settlement.kinds, (k) => ({
				event: q.id,
				kind: k.kind,
				model: q.model,
				priced: spanOf(pricedAt(q.during)),
				tokens: P.Tokens(tokensOf(k.kind)),
				amount: P.Micros(k.amount),
				credited: P.Micros(k.credited)
			})),
			total: { event: q.id, workspace, month: P.MonthNo(monthNo), amount: P.Micros(total) },
			cost: { event: q.id, amount: P.Micros(cost) },
			debits: Arr.map(settlement.debits, (d) => ({
				grant: d.grant,
				event: q.id,
				kind: d.kind,
				amount: P.Micros(d.amount),
				during: spanOf(q.during)
			}))
		})
	}
	return { records, refused, left, spent }
}

const grantBalances = (view: ModelView): ReadonlyMap<string, bigint> =>
	new Map(Arr.map(view.grants, (g) => [g.id, g.amount]))

/** The facts of recorded usage. */
const usageFacts = (
	records: ReadonlyArray<P.UsageRecord>
): Pick<
	PlatformFacts,
	"UsageEvent" | "UsageCharge" | "EventCharge" | "ProviderCost" | "CreditDebit"
> => ({
	UsageEvent: Arr.map(records, (r) => r.event),
	UsageCharge: Arr.flatMap(records, (r) => r.charges),
	EventCharge: Arr.map(records, (r) => r.total),
	ProviderCost: Arr.map(records, (r) => r.cost),
	CreditDebit: Arr.flatMap(records, (r) => r.debits)
})

/**
 * What closing months reads, grouped once: each organization's events per month with their models and charges, and its
 * subscriptions with their segments.
 */
interface BillingIndex {
	readonly events: ReadonlyMap<string, ReadonlyArray<Uuid>>
	readonly modelOf: ReadonlyMap<string, Uuid>
	readonly chargesOf: ReadonlyMap<string, ReadonlyArray<Addition<typeof P.UsageCharge>>>
	readonly subscriptionsOf: ReadonlyMap<string, ReadonlyArray<Addition<typeof P.Subscription>>>
	readonly segmentsOf: ReadonlyMap<string, ReadonlyArray<Addition<typeof P.Segment>>>
}

const billingIndex = (facts: PlatformFacts): BillingIndex => {
	const orgOf = new Map(Arr.map(facts.Workspace, (w) => [w.id, w.org]))
	return {
		events: new Map(
			Arr.map(
				[...group(facts.EventCharge, (e) => keyOf(orgOf.get(e.workspace) ?? "", e.month))],
				([k, es]) => [k, Arr.map(es, (e) => e.event)]
			)
		),
		modelOf: new Map(Arr.map(facts.UsageEvent, (e) => [e.id, e.model])),
		chargesOf: group(facts.UsageCharge, (c) => c.event),
		subscriptionsOf: group(facts.Subscription, (s) => s.org),
		segmentsOf: group(facts.Segment, (g) => g.subscription)
	}
}

/**
 * An organization's month closed: a usage line per model and kind of its workspaces' events that month, billing what
 * credits did not pay, and a plan line per subscription with a segment in the month, its allocations each segment's
 * prorated charge over the part of the month it covers. `ids` numbers the invoice and its lines.
 */
const closeMonthOf = (
	index: BillingIndex,
	org: Uuid,
	month: MonthM,
	ids: { readonly invoice: number; readonly firstLine: number }
): P.MonthClose => {
	const invoice = uid(family.invoice, ids.invoice)
	const usage = new Map<string, { model: Uuid; kind: TokenKind; tokens: bigint; amount: bigint }>()
	for (const event of index.events.get(keyOf(org, month.month)) ?? []) {
		const model = index.modelOf.get(event)
		if (model === undefined) {
			continue
		}
		for (const c of index.chargesOf.get(event) ?? []) {
			const k = keyOf(model, c.kind)
			const known = usage.get(k) ?? { model, kind: c.kind, tokens: 0n, amount: 0n }
			usage.set(k, {
				...known,
				tokens: known.tokens + c.tokens,
				amount: known.amount + c.amount - c.credited
			})
		}
	}
	let line = ids.firstLine
	const lines: Array<Addition<typeof P.InvoiceLine>> = []
	const usageLines: Array<Addition<typeof P.UsageLine>> = []
	for (const u of Arr.sort(
		[...usage.values()],
		Order.mapInput(Order.String, (x: { readonly model: string; readonly kind: TokenKind }) =>
			keyOf(x.model, x.kind)
		)
	)) {
		const id = uid(family.line, line++)
		lines.push({ id, invoice, source: "usage", amount: P.Micros(u.amount) })
		usageLines.push({ line: id, model: u.model, kind: u.kind, tokens: P.Tokens(u.tokens) })
	}
	const plans: Array<Addition<typeof P.PlanLine>> = []
	const allocations: Array<Addition<typeof P.Allocation>> = []
	for (const s of index.subscriptionsOf.get(org) ?? []) {
		const segments = Arr.filter(
			index.segmentsOf.get(s.id) ?? [],
			(g) => overlapOf(plain(g.during), month.during) > 0n
		)
		if (segments.length === 0) {
			continue
		}
		const id = uid(family.line, line++)
		const pieces = Arr.map(segments, (g) => {
			const d = plain(g.during)
			const part = platformSpan(
				d.start > month.during.start ? d.start : month.during.start,
				d.end < month.during.end ? d.end : month.during.end
			)
			return { during: part, amount: prorated(g.monthlyPrice, width(part), width(month.during)) }
		})
		lines.push({
			id,
			invoice,
			source: "plan",
			amount: P.Micros(Arr.reduce(pieces, 0n, (sum, p) => sum + p.amount))
		})
		plans.push({ line: id, subscription: s.id })
		for (const p of pieces) {
			allocations.push({
				line: id,
				subscription: s.id,
				during: spanOf(p.during),
				amount: P.Micros(p.amount)
			})
		}
	}
	return {
		invoice: {
			id: invoice,
			org,
			period: spanOf(month.during),
			amount: P.Micros(Arr.reduce(lines, 0n, (sum, l) => sum + l.amount)),
			state: "open"
		},
		lines,
		usage: usageLines,
		plans,
		allocations
	}
}

const closeFacts = (
	closes: ReadonlyArray<P.MonthClose>
): Pick<PlatformFacts, "Invoice" | "InvoiceLine" | "UsageLine" | "PlanLine" | "Allocation"> => ({
	Invoice: Arr.map(closes, (c) => c.invoice),
	InvoiceLine: Arr.flatMap(closes, (c) => c.lines),
	UsageLine: Arr.flatMap(closes, (c) => c.usage),
	PlanLine: Arr.flatMap(closes, (c) => c.plans),
	Allocation: Arr.flatMap(closes, (c) => c.allocations)
})

/**
 * What happens to a closed invoice: it stays open, is paid (and refunded some amounts, each within what is left), is
 * paid and then disputed, or is voided.
 */
type Settlement =
	| { readonly kind: "open" }
	| {
			readonly kind: "paid"
			readonly refunds: ReadonlyArray<{
				readonly amount: bigint
				readonly reason: RefundReasonM
				readonly at: bigint
			}>
	  }
	| { readonly kind: "disputed"; readonly at: bigint }
	| { readonly kind: "void"; readonly at: bigint }

type RefundReasonM = "requested" | "duplicate" | "outage" | "dispute"
const refundReasons: Arr.NonEmptyReadonlyArray<RefundReasonM> = [
	"requested",
	"duplicate",
	"outage",
	"dispute"
]

/**
 * The refunds a paid invoice grants of those requested, in order: each while what the invoice has left covers it, the
 * ids numbered from `firstRefund`.
 */
const grantedRefunds = (
	invoice: Addition<typeof P.Invoice>,
	requested: Extract<Settlement, { readonly kind: "paid" }>["refunds"],
	firstRefund: number
): ReadonlyArray<Addition<typeof P.Refund>> => {
	let left: bigint = invoice.amount
	const refunds: Array<Addition<typeof P.Refund>> = []
	for (const r of requested) {
		if (r.amount > left) {
			continue
		}
		left -= r.amount
		refunds.push({
			id: uid(family.refund, firstRefund + refunds.length),
			invoice: invoice.id,
			amount: P.Micros(r.amount),
			reason: r.reason,
			at: instant(r.at)
		})
	}
	return refunds
}

/**
 * The facts an invoice's settlement adds, and the invoice in its final state; refunds past what is left are dropped.
 */
const settleInvoice = (
	invoice: Addition<typeof P.Invoice>,
	s: Settlement,
	firstRefund: number
): Pick<PlatformFacts, "Invoice" | "Payment" | "Voiding" | "Dispute" | "Refund"> => {
	switch (s.kind) {
		case "open":
			return { Invoice: [invoice], Payment: [], Voiding: [], Dispute: [], Refund: [] }
		case "paid": {
			const refunds = grantedRefunds(invoice, s.refunds, firstRefund)
			return {
				Invoice: [{ ...invoice, state: "paid" }],
				Payment: [
					{
						invoice: invoice.id,
						charge: uid(family.charge, Number.parseInt(Str.slice(-12)(invoice.id), 16))
					}
				],
				Voiding: [],
				Dispute: [],
				Refund: refunds
			}
		}
		case "disputed":
			return {
				Invoice: [{ ...invoice, state: "disputed" }],
				Payment: [],
				Voiding: [],
				Dispute: [{ invoice: invoice.id, at: instant(s.at) }],
				Refund: []
			}
		case "void":
			return {
				Invoice: [{ ...invoice, state: "void" }],
				Payment: [],
				Voiding: [{ invoice: invoice.id, at: instant(s.at) }],
				Dispute: [],
				Refund: []
			}
	}
}

/** A platform's plan: its setup facts, its usage requests in start order, and each closed invoice's settlement. */
interface PlatformPlan {
	readonly months: ReadonlyArray<MonthM>
	readonly setup: PlatformFacts
	readonly requests: ReadonlyArray<UsageRequest>
	/** The organizations' months to close, each with what happens to its invoice. */
	readonly closes: ReadonlyArray<{
		readonly org: Uuid
		readonly month: number
		readonly settlement: Settlement
	}>
}

export interface Platform {
	readonly plan: PlatformPlan
	readonly facts: PlatformFacts
	readonly settled: Settled
}

/** A plan built: the usage settled, the months closed and their invoices settled. */
export const buildPlatform = (plan: PlatformPlan): Platform => {
	const view = viewOf(plan.setup)
	const settled = settleRequests(view, plan.requests, {
		left: grantBalances(view),
		spent: new Map()
	})
	const used: PlatformFacts = { ...plan.setup, ...usageFacts(settled.records) }
	const index = billingIndex(used)
	const ids = { invoice: 0, line: 0, refund: 0 }
	const closed: Array<P.MonthClose> = []
	const settledInvoices: Array<
		Pick<PlatformFacts, "Invoice" | "Payment" | "Voiding" | "Dispute" | "Refund">
	> = []
	for (const c of plan.closes) {
		const found = Arr.findFirst(plan.months, (m) => m.month === c.month)
		if (Option.isNone(found)) {
			continue
		}
		const close = closeMonthOf(index, c.org, found.value, {
			invoice: ids.invoice++,
			firstLine: ids.line
		})
		ids.line += close.lines.length
		closed.push(close)
		const settledInvoice = settleInvoice(close.invoice, c.settlement, ids.refund)
		ids.refund += settledInvoice.Refund.length
		settledInvoices.push(settledInvoice)
	}
	const billed = closeFacts(closed)
	return {
		plan,
		settled,
		facts: {
			...used,
			...billed,
			Invoice: Arr.flatMap(settledInvoices, (s) => s.Invoice),
			Payment: Arr.flatMap(settledInvoices, (s) => s.Payment),
			Voiding: Arr.flatMap(settledInvoices, (s) => s.Voiding),
			Dispute: Arr.flatMap(settledInvoices, (s) => s.Dispute),
			Refund: Arr.flatMap(settledInvoices, (s) => s.Refund)
		}
	}
}

/** A card's tiers: one flat tier, or three graduated ones whose rates fall at each boundary. */
const tiersOf = (card: Uuid, rate: bigint, tiered: boolean): Facts<typeof P.RateTier> =>
	tiered
		? [
				{ card, tier: tokenSpan(platformSpan(0n, tierBounds[0])), rate: P.Rate(rate) },
				{
					card,
					tier: tokenSpan(platformSpan(tierBounds[0], tierBounds[1])),
					rate: P.Rate((rate * 4n) / 5n)
				},
				{ card, tier: tokenSpan(platformSpan(tierBounds[1], TOKENS_MAX)), rate: P.Rate(rate / 2n) }
			]
		: [{ card, tier: tokenSpan(platformSpan(0n, TOKENS_MAX)), rate: P.Rate(rate) }]

/** The cards of one model's kind over [from, FAR), split at each change instant, each with its rate and tiering. */
const cardsOf = (
	model: Uuid,
	kind: TokenKind,
	from: bigint,
	changes: ReadonlyArray<{ readonly at: bigint; readonly rate: bigint; readonly tiered: boolean }>,
	first: { readonly rate: bigint; readonly tiered: boolean },
	nextId: () => Uuid
): Pick<PlatformFacts, "RateCard" | "RateTier"> => {
	const cuts = Arr.sort(
		Arr.filter(changes, (c) => c.at > from && c.at < FAR),
		Order.mapInput(Order.BigInt, (c: { readonly at: bigint }) => c.at)
	)
	const unique = Arr.filter(cuts, (c, i) => i === 0 || cuts[i - 1]?.at !== c.at)
	const segments = [{ at: from, rate: first.rate, tiered: first.tiered }, ...unique]
	const priced = Arr.map(
		segments,
		(
			s,
			i
		): { readonly card: Addition<typeof P.RateCard>; readonly tiers: Facts<typeof P.RateTier> } => {
			const id = nextId()
			return {
				card: { id, model, kind, during: spanOf(platformSpan(s.at, segments[i + 1]?.at ?? FAR)) },
				tiers: tiersOf(id, s.rate, s.tiered)
			}
		}
	)
	return { RateCard: Arr.map(priced, (x) => x.card), RateTier: Arr.flatMap(priced, (x) => x.tiers) }
}

/** Base rates per kind, micro-dollars per million tokens: input, output, cache reads and writes, and batch at half. */
const baseRates: Readonly<Record<TokenKind, bigint>> = {
	input: 3_000_000n,
	output: 15_000_000n,
	cacheRead: 300_000n,
	cacheWrite: 3_750_000n,
	batchInput: 1_500_000n,
	batchOutput: 7_500_000n
}

/** The features a swarm turns on and off per platform. */
const platformFeatures = [
	"rate changes",
	"tiers",
	"grants",
	"revocations",
	"resellers",
	"cache-only usage",
	"zero-token usage",
	"batch usage",
	"team plan",
	"refunds",
	"disputes and voids",
	"exact caps",
	"tight caps",
	"planted boundaries"
] as const

/** A feature a platform's swarm turns on and off: a kept sketch states its swarm as a record of them. */
export type PlatformFeature = (typeof platformFeatures)[number]

/**
 * A small platform as drawn: its swarm, its sizes, and the picks its resolution reads against the lists it builds
 * (test/support/pick.ts), each list known only once the platform's setup is resolved.
 */
export interface PlatformSketch {
	readonly swarm: Swarm<PlatformFeature>
	readonly months: number
	readonly orgs: ReadonlyArray<{ readonly parent: number }>
	readonly workspaces: ReadonlyArray<{ readonly org: number; readonly cap: number }>
	readonly keys: ReadonlyArray<{
		readonly workspace: number
		readonly created: number
		readonly revoked: number
	}>
	readonly models: number
	readonly providers: number
	readonly rateChanges: ReadonlyArray<{
		readonly model: number
		readonly kind: number
		readonly at: number
		readonly rate: number
		readonly tiered: number
	}>
	readonly grants: ReadonlyArray<{
		readonly org: number
		readonly amount: number
		readonly start: number
		readonly end: number
	}>
	readonly subscriptions: ReadonlyArray<{
		readonly org: number
		readonly price: number
		readonly change: number
	}>
	readonly events: ReadonlyArray<{
		readonly key: number
		readonly route: number
		readonly start: number
		readonly latency: number
		readonly tokens: ReadonlyArray<number>
	}>
	readonly closes: ReadonlyArray<{
		readonly settle: number
		readonly refunds: ReadonlyArray<number>
	}>
}

/** Between `min` and `max` items. */
const listGen = <A>(item: Gen<A>, min: number, max: number): Gen<ReadonlyArray<A>> =>
	array(item, { min, max })

/** A closed month's settlement pick and the picks of the refunds its invoice is asked, `refunds` of them. */
const closeGen =
	(refunds: Size): Gen<PlatformSketch["closes"][number]> =>
	(s) => ({
		settle: s.draw(pickGen),
		refunds: s.draw(array(pickGen, refunds))
	})

/** How a sketch draws its swarm, its months, and its closes given how many months and organizations it has. */
interface Billing {
	readonly swarm: Gen<Swarm<PlatformFeature>>
	readonly months: Gen<number>
	readonly closes: (months: number, orgs: number) => Gen<PlatformSketch["closes"]>
}

/** A small platform's sketch, drawn in its fields' order: its swarm first, then its sizes and picks. */
const sketchOf =
	(billing: Billing): Gen<PlatformSketch> =>
	(source) => {
		const drawnSwarm = source.draw(billing.swarm)
		const months = source.draw(billing.months)
		const orgs = source.draw(listGen((s) => ({ parent: s.draw(pickGen) }), 1, 3))
		return {
			swarm: drawnSwarm,
			months,
			orgs,
			workspaces: source.draw(
				listGen((s) => ({ org: s.draw(pickGen), cap: s.draw(pickGen) }), 1, 4)
			),
			keys: source.draw(
				listGen(
					(s) => ({
						workspace: s.draw(pickGen),
						created: s.draw(pickGen),
						revoked: s.draw(pickGen)
					}),
					1,
					4
				)
			),
			models: source.draw(int(1, 2)),
			providers: source.draw(int(1, 2)),
			rateChanges: source.draw(
				listGen(
					(s) => ({
						model: s.draw(pickGen),
						kind: s.draw(pickGen),
						at: s.draw(pickGen),
						rate: s.draw(pickGen),
						tiered: s.draw(pickGen)
					}),
					0,
					4
				)
			),
			grants: source.draw(
				listGen(
					(s) => ({
						org: s.draw(pickGen),
						amount: s.draw(pickGen),
						start: s.draw(pickGen),
						end: s.draw(pickGen)
					}),
					0,
					3
				)
			),
			subscriptions: source.draw(
				listGen(
					(s) => ({ org: s.draw(pickGen), price: s.draw(pickGen), change: s.draw(pickGen) }),
					0,
					2
				)
			),
			events: source.draw(
				listGen(
					(s) => ({
						key: s.draw(pickGen),
						route: s.draw(pickGen),
						start: s.draw(pickGen),
						latency: s.draw(pickGen),
						tokens: s.draw(listGen(pickGen, tokenKinds.length, tokenKinds.length))
					}),
					0,
					10
				)
			),
			closes: source.draw(billing.closes(months, orgs.length))
		}
	}

/** A small platform's sketch: up to four of its organizations' months closed. */
export const platformSketchGen: Gen<PlatformSketch> = sketchOf({
	swarm: swarm(platformFeatures),
	months: int(1, 3),
	closes: () => listGen(closeGen({ min: 0, max: 3 }), 0, 4)
})

/**
 * A billed platform's sketch: two or three months, each closed for every organization, with refunds on and every
 * invoice asked at least one. A small platform's few closes seldom give an organization more invoices than a page
 * holds, or a paid invoice a refund it covers, so the reads suite draws this one.
 */
export const billedSketchGen: Gen<PlatformSketch> = sketchOf({
	swarm: map(swarm(platformFeatures), (drawn): Swarm<PlatformFeature> => ({
		...drawn,
		refunds: 3
	})),
	months: int(2, 3),
	closes: (months, orgs) =>
		array(closeGen({ min: 1, max: 3 }), { min: months * orgs, max: months * orgs })
})

/**
 * The instants a small platform draws from: every boundary its setup states, each with the second before and after,
 * inside the calendar.
 */
const boundaryInstants = (
	months: ReadonlyArray<MonthM>,
	boundaries: ReadonlyArray<bigint>
): ReadonlyArray<bigint> => {
	const first = months[0]?.during.start ?? JAN
	const last = months[months.length - 1]?.during.end ?? JAN + DAY
	const near = Arr.flatMap(
		[first, last - 1n, ...Arr.map(months, (m) => m.during.start), ...boundaries],
		(b) => [b - 1n, b, b + 1n]
	)
	const all = new Set(Arr.filter(near, (t) => t >= first && t < last))
	return Arr.sort([...all], Order.BigInt)
}

/** The token counts a small platform draws from: none, one, and the tiers' boundaries with their neighbours. */
const tokenDictionary: Arr.NonEmptyReadonlyArray<bigint> = [
	0n,
	1n,
	999n,
	1000n,
	1001n,
	4321n,
	9999n,
	10_000n,
	10_001n,
	123_457n
]

const latencies: Arr.NonEmptyReadonlyArray<bigint> = [1n, 2n, 37n, 3600n]

/** None, or one of `options`: the first share of the picks selects none. */
const optionalPick = <A>(options: ReadonlyArray<A>, pick: number): A | undefined => {
	const i = pickIndex(pick, options.length + 1)
	return i === 0 ? undefined : options[i - 1]
}

/**
 * A small platform from its sketch: every pick resolved against what the swarm turns on. The planted requests spend
 * past both planted grants, split across them; start exactly at the planted rate change, crossing the new card's
 * first tier boundary; start when the planted grants expire, and end when they expire; and carry cache tokens only,
 * and no tokens at all. Each drawn request keeps or leaves its cache-only and zero-token forms by the swarm's `keep`,
 * which draws a decision from the source where the swarm weighs the form at one or two thirds; a swarm that turns a
 * form fully on or off draws nothing, so a kept sketch with such a swarm resolves without drawing.
 */
export const resolvePlatform =
	(sketch: PlatformSketch): Gen<PlatformPlan> =>
	(source) => {
		const on = (feature: PlatformFeature): boolean => weightOf(sketch.swarm, feature) > 0
		const months = calendarOf(sketch.months)
		const calendar = calendarFacts(months)
		const start = months[0]?.during.start ?? JAN
		const end = months[months.length - 1]?.during.end ?? JAN + DAY
		const monthInstants = nonEmpty(
			Arr.flatMap(months, (m) => [m.during.start, m.during.start + DAY / 2n, m.during.end - DAY]),
			"month"
		)
		const orgPlan = Arr.map(sketch.orgs, (o, i) => ({
			id: uid(family.org, i),
			parentPick: o.parent
		}))
		const orgs = Arr.map(orgPlan, (o) => o.id)
		const parents = on("resellers")
			? Arr.flatMap(orgPlan, (o, i) => {
					if (i === 0) {
						return []
					}
					const parent = pickFrom<Option.Option<Uuid>>(
						[Option.none(), ...Arr.map(orgs.slice(0, i), Option.some)],
						o.parentPick
					)
					return Option.toArray(Option.map(parent, (of) => ({ child: o.id, parent: of })))
				})
			: []
		const workspaces = Arr.map(sketch.workspaces, (w, i) => ({
			id: uid(family.workspace, i),
			org: pickFrom(nonEmpty(orgs, "organization"), w.org),
			cap: w.cap
		}))
		const providers = Arr.map(indices(sketch.providers), (i) => uid(family.provider, i))
		const models = Arr.map(indices(sketch.models), (i) => uid(family.model, i))
		/** Every model served by the first provider; the second serves the first model too. */
		const routes = Arr.flatMap(models, (m, i) =>
			Arr.map(i === 0 ? providers : providers.slice(0, 1), (p) => ({ model: m, provider: p }))
		)
		let card = 0
		const nextCard = () => uid(family.card, card++)
		/** Planted: the first model's input repriced half a day into the first month, onto graduated tiers. */
		const plantedChange = {
			model: 0,
			kind: 0,
			at: pickOf(1, 3 * sketch.months),
			rate: pickOf(1, 4),
			tiered: pickOf(1, 2)
		}
		const changes = [
			...(on("rate changes") ? sketch.rateChanges : []),
			...(on("planted boundaries") ? [plantedChange] : [])
		]
		const rates = Arr.flatMap(models, (m, mi) =>
			Arr.map(tokenKinds, (kind, ki) => {
				const own = Arr.filter(
					changes,
					(c) =>
						pickFrom(nonEmpty(models, "model"), c.model) === m &&
						pickFrom(tokenKinds, c.kind) === kind
				)
				return cardsOf(
					m,
					kind,
					start,
					Arr.map(own, (c) => ({
						at: pickFrom(monthInstants, c.at) + BigInt(mi + ki),
						rate: baseRates[kind] + BigInt(pickFrom([0, 1, 7, 250_001], c.rate)),
						tiered: (on("tiers") || c === plantedChange) && pickFrom([false, true], c.tiered)
					})),
					{ rate: baseRates[kind], tiered: on("tiers") && (mi + ki) % 2 === 0 },
					nextCard
				)
			})
		)
		const keys = Arr.map(sketch.keys, (k, i) => {
			const workspace = pickFrom(nonEmpty(workspaces, "workspace"), k.workspace)
			const created = pickFrom([start, start, monthInstants[1] ?? start], k.created)
			const revokedAt = on("revocations") ? optionalPick(monthInstants, k.revoked) : undefined
			const revoked = revokedAt !== undefined && revokedAt > created ? revokedAt : undefined
			return { id: uid(family.key, i), workspace: workspace.id, created, revoked }
		})
		/**
		 * Planted: the first active key's organization gets two small grants valid for the first ten days, which one event
		 * spends across both, and events start exactly when they expire and end exactly when they expire.
		 */
		const plantedKey = on("planted boundaries")
			? Arr.findFirst(keys, (k) => k.revoked === undefined && k.created === start)
			: Option.none()
		const plantedOrg = Option.flatMap(plantedKey, (k) =>
			Option.map(
				Arr.findFirst(workspaces, (w) => w.id === k.workspace),
				(w) => w.org
			)
		)
		const plantedEnd = start + 10n * DAY
		/**
		 * A third expires a minute in, before any request it could pay for: an expired grant with its whole amount left.
		 */
		const plantedGrants = Arr.flatMap(Option.toArray(plantedOrg), (org) => [
			...Arr.map([0, 1], (i) => ({
				id: uid(family.grant, 100 + i),
				org,
				amount: 1_000n,
				valid: platformSpan(start, plantedEnd)
			})),
			{ id: uid(family.grant, 102), org, amount: 5_000n, valid: platformSpan(start, start + 60n) }
		])
		const drawnGrants = on("grants")
			? Arr.map(sketch.grants, (g, i) => {
					const from = pickFrom(monthInstants, g.start)
					const to = pickFrom(
						nonEmpty([...Arr.filter(monthInstants, (t) => t > from), end, FAR], "grant end"),
						g.end
					)
					return {
						id: uid(family.grant, i),
						org: pickFrom(nonEmpty(orgs, "organization"), g.org),
						amount: pickFrom([1n, 2_500n, 40_000n, 5_000_000n], g.amount),
						valid: platformSpan(from, to)
					}
				})
			: []
		const grants = [...plantedGrants, ...drawnGrants]
		const subscriptions = on("team plan")
			? Arr.map(sketch.subscriptions, (s, i) => ({
					id: uid(family.subscription, i),
					org: pickFrom(nonEmpty(orgs, "organization"), s.org),
					price: pickFrom([25_000_000n, 30_000_001n, 7n], s.price),
					change: optionalPick(monthInstants, s.change)
				}))
			: []
		const setupOf = (caps: ReadonlyMap<string, bigint>): PlatformFacts => ({
			...noFacts,
			...calendar,
			Org: Arr.map(orgs, (id) => ({ id })),
			ParentOrg: parents,
			Workspace: Arr.map(workspaces, (w) => ({ id: w.id, org: w.org })),
			WorkspaceLimit: Arr.flatMap(workspaces, (w) =>
				Arr.map(months, (m) => ({
					workspace: w.id,
					month: P.MonthNo(m.month),
					cap: P.Micros(caps.get(keyOf(w.id, m.month)) ?? 1_000_000_000_000n)
				}))
			),
			ApiKey: Arr.map(keys, (k) => ({
				id: k.id,
				workspace: k.workspace,
				state: k.revoked === undefined ? "active" : "revoked"
			})),
			Revocation: Arr.flatMap(keys, (k) =>
				k.revoked === undefined ? [] : [{ key: k.id, at: instant(k.revoked) }]
			),
			ApiKeyActive: Arr.map(keys, (k) => ({
				key: k.id,
				during: spanOf(platformSpan(k.created, k.revoked ?? FAR))
			})),
			Provider: Arr.map(providers, (id) => ({ id })),
			Model: Arr.map(models, (id) => ({ id })),
			Route: routes,
			ProviderPrice: Arr.flatMap(routes, (r) =>
				Arr.map(tokenKinds, (kind) => ({
					provider: r.provider,
					model: r.model,
					kind,
					during: spanOf(platformSpan(start, FAR)),
					rate: P.Rate((baseRates[kind] * 3n) / 5n)
				}))
			),
			RateCard: Arr.flatMap(rates, (r) => r.RateCard),
			RateTier: Arr.flatMap(rates, (r) => r.RateTier),
			CreditGrant: Arr.map(grants, (g) => ({
				id: g.id,
				org: g.org,
				amount: P.Micros(g.amount),
				valid: spanOf(g.valid)
			})),
			Subscription: Arr.map(subscriptions, (s) => ({ id: s.id, org: s.org })),
			Segment: Arr.flatMap(subscriptions, (s) =>
				s.change === undefined || s.change <= start
					? [
							{
								subscription: s.id,
								during: spanOf(platformSpan(start, FAR)),
								monthlyPrice: P.Micros(s.price)
							}
						]
					: [
							{
								subscription: s.id,
								during: spanOf(platformSpan(start, s.change)),
								monthlyPrice: P.Micros(s.price)
							},
							{
								subscription: s.id,
								during: spanOf(platformSpan(s.change, FAR)),
								monthlyPrice: P.Micros(s.price * 2n)
							}
						]
			)
		})
		const boundaries = [
			...Arr.flatMap(rates, (r) => Arr.map(r.RateCard, (c) => c.during.start)),
			...Arr.flatMap(grants, (g) => [g.valid.start, g.valid.end]),
			...Arr.flatMap(keys, (k) => (k.revoked === undefined ? [] : [k.revoked]))
		]
		const instants = nonEmpty(boundaryInstants(months, boundaries), "instant")
		const kindsFor = (picks: ReadonlyArray<number>): UsageRequest["tokens"] => {
			const cacheOnly = source.draw(keep(sketch.swarm, "cache-only usage"))
			const zero = source.draw(keep(sketch.swarm, "zero-token usage"))
			const batch = on("batch usage")
			return Arr.flatMap(tokenKinds, (kind, i) => {
				if (zero) {
					return []
				}
				if (cacheOnly && kind !== "cacheRead" && kind !== "cacheWrite") {
					return []
				}
				if (!batch && (kind === "batchInput" || kind === "batchOutput")) {
					return []
				}
				const tokens = pickFrom(tokenDictionary, picks[i] ?? 0)
				return tokens === 0n ? [] : [{ kind, tokens }]
			})
		}
		const planted: ReadonlyArray<UsageRequest> = Arr.flatMap(
			Option.toArray(Option.all({ plantedKey, firstRoute: Arr.head(routes) })),
			({ plantedKey: key, firstRoute }) =>
				Arr.map(
					[
						{
							during: platformSpan(start + 3600n, start + 3601n),
							tokens: [{ kind: "input", tokens: 10_001n }]
						},
						{
							during: platformSpan(
								pickFrom(monthInstants, plantedChange.at),
								pickFrom(monthInstants, plantedChange.at) + 2n
							),
							tokens: [{ kind: "input", tokens: 1001n }]
						},
						{
							during: platformSpan(plantedEnd, plantedEnd + 2n),
							tokens: [{ kind: "output", tokens: 999n }]
						},
						{
							during: platformSpan(plantedEnd - 2n, plantedEnd),
							tokens: [{ kind: "output", tokens: 1000n }]
						},
						{
							during: platformSpan(start + 7200n, start + 7201n),
							tokens: [
								{ kind: "cacheRead", tokens: 999n },
								{ kind: "cacheWrite", tokens: 1000n }
							]
						},
						{ during: platformSpan(start + 7300n, start + 7301n), tokens: [] }
					] satisfies ReadonlyArray<Pick<UsageRequest, "during" | "tokens">>,
					(r, i) => ({
						id: uid(family.event, 1000 + i),
						key: key.id,
						model: firstRoute.model,
						provider: firstRoute.provider,
						during: r.during,
						tokens: r.tokens
					})
				)
		)
		const requests = Arr.sort(
			[
				...planted,
				...Arr.map(sketch.events, (e, i): UsageRequest => {
					const key = pickFrom(nonEmpty(keys, "key"), e.key)
					const route = pickFrom(nonEmpty(routes, "route"), e.route)
					const at = pickFrom(instants, e.start)
					return {
						id: uid(family.event, i),
						key: key.id,
						model: route.model,
						provider: route.provider,
						during: platformSpan(at, at + pickFrom(latencies, e.latency)),
						tokens: kindsFor(e.tokens)
					}
				})
			],
			requestOrder
		)
		/**
		 * Caps: unlimited, unless a swarm sets them to exactly what the workspace spends (a cap hit exactly) or below it.
		 */
		const unlimited = settleRequests(viewOf(setupOf(new Map())), requests, {
			left: new Map(Arr.map(grants, (g) => [g.id, g.amount])),
			spent: new Map()
		})
		const caps = new Map<string, bigint>(
			Arr.flatMap(workspaces, (w) =>
				Arr.flatMap(months, (m) => {
					const at = keyOf(w.id, m.month)
					const spent = unlimited.spent.get(at) ?? 0n
					const exact = on("exact caps") && pickFrom([false, true], w.cap)
					const tight = on("tight caps") && !exact && pickFrom([false, true], w.cap)
					return exact ? [[at, spent] as const] : tight ? [[at, spent / 2n] as const] : []
				})
			)
		)
		const closes = Arr.flatMap(months, (m, mi) =>
			Arr.flatMap(orgs, (org, oi) => {
				const c = sketch.closes[mi * orgs.length + oi]
				if (c === undefined) {
					return []
				}
				const kind = pickFrom(["open", "paid", "paid", "disputed", "void"] as const, c.settle)
				const at = m.during.end + DAY
				const settlement: Settlement =
					kind === "paid"
						? {
								kind,
								refunds: on("refunds")
									? Arr.map(c.refunds, (r) => ({
											amount: pickFrom([1n, 1000n, 250_000n, 3n], r),
											reason: pickFrom(refundReasons, r),
											at
										}))
									: []
							}
						: (kind === "disputed" || kind === "void") && on("disputes and voids")
							? { kind, at }
							: { kind: "open" }
				return [{ org, month: m.month, settlement }]
			})
		)
		return { months, setup: setupOf(caps), requests, closes }
	}

/** The semantic features a built platform reaches: what its required-feature list names. */
export type BuiltFeature =
	| "an event at a rate change"
	| "a grant expiring at an event's start"
	| "a grant expiring at an event's end"
	| "a cap hit exactly"
	| "a zero-token event"
	| "a cache-only event"
	| "a tier boundary crossed within one event"
	| "an event split across grants"
	| "a refused request"
	| "a refund"
	| "a reseller tree"

export const builtFeatures = (p: Platform): ReadonlyArray<BuiltFeature> => {
	const view = viewOf(p.facts)
	const out = new Set<BuiltFeature>()
	const firstStart = new Map<string, bigint>()
	for (const c of view.cards) {
		const k = keyOf(c.model, c.kind)
		const known = firstStart.get(k)
		if (known === undefined || c.during.start < known) {
			firstStart.set(k, c.during.start)
		}
	}
	const changeInstants = new Set(
		Arr.map(
			Arr.filter(view.cards, (c) => firstStart.get(keyOf(c.model, c.kind)) !== c.during.start),
			(c) => c.during.start
		)
	)
	for (const r of p.settled.records) {
		const window = plain(r.event.during)
		if (changeInstants.has(window.start)) {
			out.add("an event at a rate change")
		}
		const org = view.workspaceOrg.get(r.total.workspace)
		const grants = Arr.filter(view.grants, (x) => x.org === org)
		if (Arr.some(grants, (g) => g.valid.end === window.start)) {
			out.add("a grant expiring at an event's start")
		}
		if (Arr.some(grants, (g) => g.valid.end === window.end)) {
			out.add("a grant expiring at an event's end")
		}
		if (r.charges.length === 0) {
			out.add("a zero-token event")
		}
		if (
			r.charges.length > 0 &&
			Arr.every(r.charges, (c) => c.kind === "cacheRead" || c.kind === "cacheWrite")
		) {
			out.add("a cache-only event")
		}
		const crossesTier = Arr.some(r.charges, (c) =>
			Option.exists(
				cardAt(
					view.cardsOf.get(keyOf(r.event.model, c.kind)) ?? [],
					r.event.model,
					c.kind,
					window.start
				),
				(card) => piecesOf(card.tiers, c.tokens).length > 1
			)
		)
		if (crossesTier) {
			out.add("a tier boundary crossed within one event")
		}
		if (new Set(Arr.map(r.debits, (d) => d.grant)).size > 1) {
			out.add("an event split across grants")
		}
	}
	const spent = new Map<string, bigint>()
	for (const e of p.facts.EventCharge) {
		spent.set(
			keyOf(e.workspace, e.month),
			(spent.get(keyOf(e.workspace, e.month)) ?? 0n) + e.amount
		)
	}
	for (const l of p.facts.WorkspaceLimit) {
		if (l.cap > 0n && spent.get(keyOf(l.workspace, l.month)) === l.cap) {
			out.add("a cap hit exactly")
		}
	}
	if (p.settled.refused.length > 0) {
		out.add("a refused request")
	}
	if (p.facts.Refund.length > 0) {
		out.add("a refund")
	}
	if (p.facts.ParentOrg.length > 0) {
		out.add("a reseller tree")
	}
	return Arr.sort([...out], Order.String)
}

export interface VolumeSizes {
	readonly months: number
	readonly orgs: number
	readonly workspacesPerOrg: number
	readonly keysPerWorkspace: number
	readonly models: number
	readonly providers: number
	readonly events: number
	readonly grantsPerOrg: number
}

/** The row number `i` mixed with a salt into 0..m-1: a fixed, well-spread arithmetic sequence, not a random source. */
const mix = (i: number, salt: number, m: number): number =>
	Number((BigInt(i) * 2_654_435_761n + BigInt(salt) * 40_503n + 12_345n) % BigInt(m))

/**
 * One platform of pinned sizes: every model's kinds repriced once a month, half the cards tiered; a reseller over every
 * tenth organization; a key in every fiftieth workspace revoked mid-calendar; grants per organization, each valid for a
 * month; events spread over the calendar and the keys by `mix`, each using input and output, every third cache tokens
 * and every seventh batch tokens; caps far above what any workspace spends; every closed month paid and some refunded.
 */
export const volumePlatform = (sizes: VolumeSizes): PlatformPlan => {
	const months = calendarOf(sizes.months)
	const start = months[0]?.during.start ?? JAN
	const end = months[months.length - 1]?.during.end ?? JAN + DAY
	const orgs = Arr.map(indices(sizes.orgs), (i) => uid(family.org, i))
	const workspaces = Arr.flatMap(orgs, (org, o) =>
		Arr.map(indices(sizes.workspacesPerOrg), (w) => ({
			id: uid(family.workspace, o * sizes.workspacesPerOrg + w),
			org
		}))
	)
	const middle = start + (end - start) / 2n
	const keys = Arr.flatMap(workspaces, (w, wi) =>
		Arr.map(indices(sizes.keysPerWorkspace), (k) => ({
			id: uid(family.key, wi * sizes.keysPerWorkspace + k),
			workspace: w.id,
			revoked: wi % 50 === 0 && k === 0 ? middle : undefined
		}))
	)
	const models = Arr.map(indices(sizes.models), (i) => uid(family.model, i))
	const providers = Arr.map(indices(sizes.providers), (i) => uid(family.provider, i))
	/** Each model routed through two providers in turn, once when there is only one. */
	const routes = Arr.flatMap(models, (m, i) =>
		Arr.map(
			Arr.dedupe([
				Arr.getUnsafe(providers, i % providers.length),
				Arr.getUnsafe(providers, (i + 1) % providers.length)
			]),
			(p) => ({ model: m, provider: p })
		)
	)
	let card = 0
	const nextCard = () => uid(family.card, card++)
	const rates = Arr.flatMap(models, (m, mi) =>
		Arr.map(tokenKinds, (kind, ki) =>
			cardsOf(
				m,
				kind,
				start,
				Arr.map(months.slice(1), (mo, j) => ({
					at: mo.during.start + BigInt((mi * 7 + ki * 3 + j) % 20) * DAY,
					rate: baseRates[kind] + BigInt((mi + j) * 1000),
					tiered: (mi + ki + j) % 2 === 0
				})),
				{ rate: baseRates[kind], tiered: (mi + ki) % 2 === 1 },
				nextCard
			)
		)
	)
	const grants = Arr.flatMap(orgs, (org, o) =>
		Arr.map(indices(sizes.grantsPerOrg), (g) => {
			const m = months[(o + g) % months.length] ?? months[0]
			const from = m?.during.start ?? start
			return {
				id: uid(family.grant, o * sizes.grantsPerOrg + g),
				org,
				amount: P.Micros(BigInt(200_000 + mix(o, g, 400_000))),
				valid: spanOf(platformSpan(from, from + 40n * DAY))
			}
		})
	)
	const subscriptions = Arr.map(
		Arr.flatMap(orgs, (org, o) => (o % 3 === 0 ? [org] : [])),
		(org, s) => ({ id: uid(family.subscription, s), org })
	)
	const setup: PlatformFacts = {
		...noFacts,
		...calendarFacts(months),
		Org: Arr.map(orgs, (id) => ({ id })),
		ParentOrg: Arr.flatMap(orgs, (child, o) => {
			const parent = orgs[o - (o % 10)]
			return o % 10 === 0 || parent === undefined ? [] : [{ child, parent }]
		}),
		Workspace: workspaces,
		WorkspaceLimit: Arr.flatMap(workspaces, (w) =>
			Arr.map(months, (m) => ({
				workspace: w.id,
				month: P.MonthNo(m.month),
				cap: P.Micros(1_000_000_000_000n)
			}))
		),
		ApiKey: Arr.map(keys, (k) => ({
			id: k.id,
			workspace: k.workspace,
			state: k.revoked === undefined ? "active" : "revoked"
		})),
		Revocation: Arr.flatMap(keys, (k) =>
			k.revoked === undefined ? [] : [{ key: k.id, at: instant(k.revoked) }]
		),
		ApiKeyActive: Arr.map(keys, (k) => ({
			key: k.id,
			during: spanOf(platformSpan(start, k.revoked ?? FAR))
		})),
		Provider: Arr.map(providers, (id) => ({ id })),
		Model: Arr.map(models, (id) => ({ id })),
		Route: routes,
		ProviderPrice: Arr.flatMap(routes, (r) =>
			Arr.map(tokenKinds, (kind) => ({
				provider: r.provider,
				model: r.model,
				kind,
				during: spanOf(platformSpan(start, FAR)),
				rate: P.Rate((baseRates[kind] * 3n) / 5n)
			}))
		),
		RateCard: Arr.flatMap(rates, (r) => r.RateCard),
		RateTier: Arr.flatMap(rates, (r) => r.RateTier),
		CreditGrant: grants,
		Subscription: subscriptions,
		Segment: Arr.map(subscriptions, (s, i) => ({
			subscription: s.id,
			during: spanOf(platformSpan(start, FAR)),
			monthlyPrice: P.Micros(BigInt(25_000_000 + i))
		}))
	}
	const seconds = Number(end - start - 3600n)
	const requests = Arr.sort(
		Arr.map(indices(sizes.events), (i): UsageRequest => {
			const key = Arr.getUnsafe(keys, mix(i, 1, keys.length))
			const route = Arr.getUnsafe(routes, mix(i, 2, routes.length))
			const offset = BigInt(Math.floor((i / sizes.events) * seconds) + mix(i, 3, 600))
			/** A revoked key's requests stay inside its active span. */
			const at =
				key.revoked !== undefined && start + offset + 3600n > key.revoked
					? start + (offset % (key.revoked - start - 3600n))
					: start + offset
			const tokens: Array<{ readonly kind: TokenKind; readonly tokens: bigint }> = [
				{ kind: "input", tokens: BigInt(1 + mix(i, 4, 20_000)) },
				{ kind: "output", tokens: BigInt(1 + mix(i, 5, 4_000)) }
			]
			if (i % 3 === 0) {
				tokens.push({ kind: "cacheRead", tokens: BigInt(mix(i, 6, 50_000)) })
			}
			if (i % 7 === 0) {
				tokens.push({ kind: "batchInput", tokens: BigInt(1 + mix(i, 7, 30_000)) })
			}
			return {
				id: uid(family.event, i),
				key: key.id,
				model: route.model,
				provider: route.provider,
				during: platformSpan(at, at + BigInt(1 + mix(i, 8, 90))),
				tokens: Arr.filter(tokens, (t) => t.tokens > 0n)
			}
		}),
		requestOrder
	)
	const closes = Arr.flatMap(months.slice(0, -1), (m) =>
		Arr.map(orgs, (org, o) => {
			const refunded: ReadonlyArray<{
				readonly amount: bigint
				readonly reason: RefundReasonM
				readonly at: bigint
			}> =
				o % 5 === 0
					? [
							{ amount: 1000n, reason: "requested", at: m.during.end + DAY },
							{ amount: 1000n, reason: "outage", at: m.during.end + DAY }
						]
					: []
			const settlement: Settlement =
				o % 4 === 3 ? { kind: "open" } : { kind: "paid", refunds: refunded }
			return { org, month: m.month, settlement }
		})
	)
	return { months, setup, requests, closes }
}
