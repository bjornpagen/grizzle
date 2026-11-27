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
import { Array as Arr, Option, pipe, String as Str } from "effect"
import type { Addition } from "#compiler/public/changeset.ts"

import * as P from "#test/support/fixtures/api/platform.ts"
import { type IdValue, toId } from "#test/support/ids.ts"
import {
	type CardM,
	cardAt,
	chargeOf,
	coveredBy,
	type GrantM,
	holds,
	microsPerMillion,
	pricedAt,
	type SpanV,
	settle,
	platformSpan,
	type TokenKind
} from "#test/support/platform/model.ts"

const DAY = 86_400n
/** 2026-01-01T00:00:00Z. */
export const JAN = 1_767_225_600n
/** 2100-01-01T00:00:00Z: the end of a span that has not ended. */
export const FAR = 4_102_444_800n
/** The end of a card's last tier. */
export const TOKENS_MAX = 1n << 40n

const daysIn2026 = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/** A deterministic uuid: the family in the first group, the row number in the last. */
export const uid = (family: number, n: number): IdValue =>
	toId(
		`${pipe(family.toString(16), Str.padStart(8, "0"))}-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`
	)

const spanOf = (s: SpanV) => ({ start: P.toInstant(s.start), end: P.toInstant(s.end) })

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

const keyOf = (...parts: ReadonlyArray<string | number | bigint>): string =>
	Arr.join(
		Arr.map(parts, (part) => `${part}`),
		"|"
	)

interface ModelView {
	readonly months: ReadonlyArray<MonthM>
	readonly workspaceOrg: ReadonlyMap<string, IdValue>
	readonly keyWorkspace: ReadonlyMap<string, IdValue>
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
const monthAt = (months: ReadonlyArray<MonthM>, t: bigint): Option.Option<MonthM> =>
	Arr.findFirst(months, (m) => holds(m.during, t))

export interface UsageRequest {
	readonly id: IdValue
	readonly key: IdValue
	readonly model: IdValue
	readonly provider: IdValue
	readonly during: SpanV
	/** Tokens per kind; a kind left out used none. */
	readonly tokens: ReadonlyArray<{ readonly kind: TokenKind; readonly tokens: bigint }>
}

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
				tokens: P.toTokens(tokensOf(k.kind)),
				amount: P.toMicros(k.amount),
				credited: P.toMicros(k.credited)
			})),
			total: { event: q.id, workspace, month: P.toMonthNo(monthNo), amount: P.toMicros(total) },
			cost: { event: q.id, amount: P.toMicros(cost) },
			debits: Arr.map(settlement.debits, (d) => ({
				grant: d.grant,
				event: q.id,
				kind: d.kind,
				amount: P.toMicros(d.amount),
				during: spanOf(q.during)
			}))
		})
	}
	return { records, refused, left, spent }
}
