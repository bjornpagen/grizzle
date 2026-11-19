/** What the properties of laws.test.ts read: its spaces, models and helpers. */

import { type Reached } from "@bjornpagen/testing/features"
import { constant, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { fullSwarm } from "@bjornpagen/testing/swarm"
import { Array as Arr, Effect, Option, Order } from "effect"
import { type LawId } from "#compiler/core/ids.ts"
import { type CallError, type WriteOutcome } from "#compiler/live/index.ts"
import { type Addition } from "#compiler/public/changeset.ts"

import { defined } from "@bjornpagen/testing/assert"
import { type Fact } from "#compiler/public/schema.ts"
import { type PlatformDb, platformTemplate } from "#test/pg/e2e-platform/support.ts"
import { type WriteAnswer, answered } from "#test/support/calls.ts"
import * as P from "#test/support/fixtures/api/platform.ts"
import { type IdValue } from "#test/support/ids.ts"
import { installationNamesOf, installationOf, lawNamesOf } from "#test/support/kernel/naming.ts"
import {
	DAY,
	JAN,
	monthAt,
	type Platform,
	type PlatformSketch,
	platformSketchGen,
	settleRequests,
	uid,
	viewOf
} from "#test/support/platform/generate.ts"
import {
	deleteOp,
	insertOp,
	lawsById,
	type PlatformOp,
	putOp
} from "#test/support/platform/laws.ts"
import { coveredBy, platformSpan, type TokenKind } from "#test/support/platform/model.ts"

/** The platform's law names, through the naming door. */
const billing = lawNamesOf(P.Billing)

/** The laws, read through the naming door. */
export const law = {
	spendWithinCap: billing.lawOf(P.spendWithinCap),
	refundWithinInvoice: billing.lawOf(P.refundWithinInvoice),
	chargeExact: billing.lawOf(P.chargeExact),
	debitWhileValid: billing.lawOf(P.debitWhileValid),
	usageWhileActive: billing.lawOf(P.usageWhileActive),
	rateInForce: billing.lawOf(P.rateInForce),
	refundOnlyPaid: billing.lawOf(P.refundOnlyPaid),
	grantWithinAmount: billing.lawOf(P.grantWithinAmount),
	allocationCovered: billing.lawOf(P.allocationCovered),
	paidWithoutPayment: defined(
		billing.alternativesOf(P.invoiceSettlement).reverse["paid"],
		"invoiceSettlement's reverse law for paid"
	),
	pricedByCard: billing.lawOf(P.pricedByCard)
} as const satisfies Readonly<Record<string, LawId>>

/** Each fault and the one law it breaks. */
export const faults = [
	"spendWithinCap",
	"refundWithinInvoice",
	"chargeExact",
	"debitWhileValid",
	"usageWhileActive",
	"rateInForce",
	"refundOnlyPaid",
	"grantWithinAmount",
	"allocationCovered",
	"paidWithoutPayment",
	"pricedOutsideCards",
	"cardRetiredUnderCharges"
] as const

type Fault = (typeof faults)[number]

export const faultLaw: Readonly<Record<Fault, keyof typeof law>> = {
	spendWithinCap: "spendWithinCap",
	refundWithinInvoice: "refundWithinInvoice",
	chargeExact: "chargeExact",
	debitWhileValid: "debitWhileValid",
	usageWhileActive: "usageWhileActive",
	rateInForce: "rateInForce",
	refundOnlyPaid: "refundOnlyPaid",
	grantWithinAmount: "grantWithinAmount",
	allocationCovered: "allocationCovered",
	paidWithoutPayment: "paidWithoutPayment",
	pricedOutsideCards: "pricedByCard",
	cardRetiredUnderCharges: "pricedByCard"
}

/** The host law model's laws by id. */
export const hostLaws = lawsById(billing)

/** The platform's installed names: an outcome's law read back to its LawId. */
const platformNames = installationNamesOf(installationOf(P.Billing, { kind: "declared" }))

/**
 * What an apply decided, as the property reads it: an outcome without its counts, witness and read-backs. The full
 * role writes every stored relation, so an outside-world outcome fails every expectation.
 */
type Decided =
	| { readonly kind: "accepted" | "unchanged" }
	| { readonly kind: "refused"; readonly laws: Arr.NonEmptyReadonlyArray<LawId> }
	| { readonly kind: "outsideWorld"; readonly relation: string }

const decided = (outcome: WriteAnswer<WriteOutcome<unknown>>): Decided => {
	switch (outcome.kind) {
		case "refused":
			return {
				kind: outcome.kind,
				laws: Arr.map(outcome.refused.laws, (law) => platformNames.reported(law))
			}
		case "outsideWorld":
			return { kind: outcome.kind, relation: outcome.relation }
		case "accepted":
		case "unchanged":
			return { kind: outcome.kind }
	}
}

/** A write of a planted case: its ChangeSet applied to the stored platform, and its operations on the host. */
interface Attempt {
	readonly apply: (db: PlatformDb) => Effect.Effect<Decided, CallError>
	readonly ops: ReadonlyArray<PlatformOp>
}

/**
 * A transient refusal, which the case runs its call again after (untilAnswered), as grizzle's contract asks of a `safe`
 * one: it changed nothing, so the case notes nothing of it.
 */
export const unnoted = (): void => undefined

/** A fault planted in a platform: the faulty write and the sound one. */
interface Planted {
	readonly faulty: Attempt
	readonly sound: Attempt
}

const usageOps = (r: P.UsageRecord): ReadonlyArray<PlatformOp> => [
	insertOp("UsageEvent", [r.event]),
	insertOp("UsageCharge", r.charges),
	insertOp("EventCharge", [r.total]),
	insertOp("ProviderCost", [r.cost]),
	insertOp("CreditDebit", r.debits)
]

const usage = (r: P.UsageRecord): Attempt => ({
	apply: (db) =>
		Effect.map(
			answered(db.workload.recordUsage.once({ params: {}, facts: P.usageFacts(r) })),
			decided
		),
	ops: usageOps(r)
})

const refunding = (r: Fact<typeof P.Refund>): Attempt => ({
	apply: (db) =>
		Effect.map(
			answered(db.workload.refund.once({ params: {}, facts: { insert: { Refund: [r] } } })),
			decided
		),
	ops: [insertOp("Refund", [r])]
})

const rateChange = (c: P.RateChange): Attempt => ({
	apply: (db) =>
		Effect.map(
			answered(db.workload.changeRate.once({ params: {}, facts: P.rateChangeFacts(c) })),
			decided
		),
	ops: [
		deleteOp("RateTier", c.retired.tiers),
		deleteOp("RateCard", [c.retired.card]),
		insertOp("RateCard", c.cards),
		insertOp("RateTier", c.tiers)
	]
})

/** The platform's state as the model reads it: what each grant has left and each workspace month has spent. */
const balances = (p: Platform) => {
	const left = new Map<string, bigint>(Arr.map(p.facts.CreditGrant, (g) => [g.id, g.amount]))
	for (const d of p.facts.CreditDebit) {
		left.set(d.grant, (left.get(d.grant) ?? 0n) - d.amount)
	}
	const spent = new Map<string, bigint>()
	for (const e of p.facts.EventCharge) {
		const k = `${e.workspace}|${e.month}`
		spent.set(k, (spent.get(k) ?? 0n) + e.amount)
	}
	return { left, spent }
}

/** A source of event ids no generated platform holds, each new: a family of their own, counted within one plant. */
const eventIds = (): (() => IdValue) => {
	let serial = 0
	return () => {
		serial += 1
		return uid(0x7e57, serial)
	}
}

/**
 * A usage request on `key` at `t` for `tokens` input tokens, priced and settled by the model against the platform with
 * every cap lifted, so the record is the one the application would write whatever the cap: none when the model still
 * refuses it (an inactive key, an unpriced kind, a month outside the calendar) or the platform has no route.
 */
const recordAt = (
	p: Platform,
	key: IdValue,
	t: bigint,
	tokens: ReadonlyArray<{ readonly kind: TokenKind; readonly tokens: bigint }>,
	next: () => IdValue
): Option.Option<P.UsageRecord> => {
	const view = viewOf(p.facts)
	const lifted = { ...view, caps: new Map(Arr.map([...view.caps], ([k]) => [k, 10n ** 15n])) }
	return Option.flatMap(Arr.head(p.facts.Route), (route) =>
		Arr.head(
			settleRequests(
				lifted,
				[
					{
						id: next(),
						key,
						model: route.model,
						provider: route.provider,
						during: platformSpan(t, t + 1n),
						tokens
					}
				],
				balances(p)
			).records
		)
	)
}

/**
 * The instants of the calendar a key is active over [t, t + 1) at: the seventh second of each active span, a day into
 * each month, and the second before each active span ends, those the calendar and the key's spans hold.
 */
const activeAt = (p: Platform, key: string): ReadonlyArray<bigint> => {
	const months = viewOf(p.facts).months
	const spans = Arr.map(
		Arr.filter(p.facts.ApiKeyActive, (a) => a.key === key),
		(a) => platformSpan(a.during.start, a.during.end)
	)
	const candidates = [
		...Arr.flatMap(spans, (s) => [s.start + 7n, s.end - 2n]),
		...Arr.map(months, (m) => m.during.start + DAY)
	]
	return Arr.sort(
		Arr.filter(
			[...new Set(candidates)],
			(t) => Option.isSome(monthAt(months, t)) && coveredBy(spans, platformSpan(t, t + 1n))
		),
		Order.BigInt
	)
}

/**
 * A place usage may be recorded: an active key at an instant, its workspace and organization, the calendar month, the
 * workspace's cap that month and what it has spent of it.
 */
interface Slot {
	readonly key: IdValue
	readonly t: bigint
	readonly workspace: IdValue
	readonly org: IdValue
	readonly month: number
	readonly cap: bigint
	readonly spent: bigint
}

/** Every slot of the platform, keys in platform order, each where its workspace, its month and its cap exist. */
const slotsOf = (p: Platform): ReadonlyArray<Slot> => {
	const { spent } = balances(p)
	const months = viewOf(p.facts).months
	return Arr.flatMap(p.facts.ApiKey, (k) =>
		Arr.flatMap(activeAt(p, k.id), (t) =>
			Option.toArray(
				Option.gen(function* () {
					const workspace = yield* Arr.findFirst(p.facts.Workspace, (w) => w.id === k.workspace)
					const month = yield* monthAt(months, t)
					const limit = yield* Arr.findFirst(
						p.facts.WorkspaceLimit,
						(l) => l.workspace === workspace.id && l.month === month.month
					)
					return {
						key: k.id,
						t,
						workspace: workspace.id,
						org: workspace.org,
						month: month.month,
						cap: limit.cap,
						spent: spent.get(`${workspace.id}|${month.month}`) ?? 0n
					}
				})
			)
		)
	)
}

/** The first result of `f` over `xs` that holds a value, in order. */
const firstSome = <A, B>(xs: ReadonlyArray<A>, f: (a: A) => Option.Option<B>): Option.Option<B> => {
	for (const x of xs) {
		const found = f(x)
		if (Option.isSome(found)) {
			return found
		}
	}
	return Option.none()
}

/** The spendWithinCap fault: a month whose cap its workspace spent exactly, and a key of that workspace active in it. */
const plantSpendWithinCap = (
	p: Platform,
	margin: bigint,
	next: () => IdValue
): Option.Option<Planted> =>
	firstSome(
		Arr.filter(slotsOf(p), (slot) => slot.cap > 0n && slot.spent === slot.cap),
		(slot) =>
			Option.flatMap(
				Option.all({
					over: recordAt(p, slot.key, slot.t, [{ kind: "input", tokens: margin }], next),
					none: recordAt(p, slot.key, slot.t, [], next)
				}),
				(at) =>
					at.over.total.amount === 0n
						? Option.none()
						: Option.some({ faulty: usage(at.over), sound: usage(at.none) })
			)
	)

/** The refundWithinInvoice fault: a refund of a paid invoice `margin` past what it has left. */
const plantRefundWithinInvoice = (
	p: Platform,
	margin: bigint,
	next: () => IdValue
): Option.Option<Planted> =>
	Option.map(
		Arr.findFirst(p.facts.Invoice, (i) => i.state === "paid"),
		(invoice) => {
			const refunded = Arr.reduce(
				Arr.filter(p.facts.Refund, (r) => r.invoice === invoice.id),
				0n,
				(sum, r) => sum + r.amount
			)
			const rest = invoice.amount - refunded
			const refund = (amount: bigint): Fact<typeof P.Refund> => ({
				id: next(),
				invoice: invoice.id,
				amount: P.Micros(amount),
				reason: "requested",
				at: P.Instant(JAN)
			})
			return { faulty: refunding(refund(rest + margin)), sound: refunding(refund(rest)) }
		}
	)

/** The usage records of a slot's key and instant that fit under its cap. */
const recordWithinCap = (
	p: Platform,
	slot: Slot,
	tokens: ReadonlyArray<{ readonly kind: TokenKind; readonly tokens: bigint }>,
	next: () => IdValue
): Option.Option<P.UsageRecord> =>
	Option.filter(
		recordAt(p, slot.key, slot.t, tokens, next),
		(record) => slot.spent + record.total.amount <= slot.cap
	)

/** The chargeExact fault: a usage record whose first charge is `margin` more than its pieces. */
const plantChargeExact = (
	p: Platform,
	margin: bigint,
	next: () => IdValue
): Option.Option<Planted> =>
	firstSome(slotsOf(p), (slot) =>
		Option.flatMap(
			recordWithinCap(p, slot, [{ kind: "input", tokens: 1000n + margin }], next),
			(record) =>
				Arr.matchLeft(record.charges, {
					onEmpty: () => Option.none(),
					onNonEmpty: (first, rest) => {
						const off = {
							...record,
							charges: [{ ...first, amount: P.Micros(first.amount + margin) }, ...rest]
						}
						return Option.some({ faulty: usage(off), sound: usage(record) })
					}
				})
		)
	)

/**
 * The debit of grant `g` that plants debitWhileValid (one micro-dollar from an expired grant with something left) or
 * grantWithinAmount (`margin` past what a valid grant has left) on a request in `slot`; none when the grant or the
 * request cannot carry it. A request's tokens are enough that its input charge covers the debit at any input rate the
 * platform states.
 */
const debitOf = (
	fault: "debitWhileValid" | "grantWithinAmount",
	p: Platform,
	margin: bigint,
	slot: Slot,
	g: Addition<typeof P.CreditGrant>,
	rest: bigint,
	next: () => IdValue
): Option.Option<Planted> => {
	const expired = g.valid.end <= slot.t
	const valid = g.valid.start <= slot.t && slot.t + 1n <= g.valid.end
	if (fault === "debitWhileValid" ? !expired || rest < 1n : !valid) {
		return Option.none()
	}
	const debit = fault === "debitWhileValid" ? 1n : rest + margin
	const sound = fault === "debitWhileValid" ? 0n : rest
	return Option.flatMap(
		recordWithinCap(p, slot, [{ kind: "input", tokens: 10_000n + debit * 10n }], next),
		(record) => {
			const covers = Arr.some(record.charges, (c) => c.kind === "input" && c.amount >= debit)
			if (!covers) {
				return Option.none()
			}
			const paying = (amount: bigint): P.UsageRecord => ({
				...record,
				charges: Arr.map(record.charges, (c) => ({
					...c,
					credited: P.Micros(c.kind === "input" ? amount : 0n)
				})),
				debits:
					amount === 0n
						? []
						: [
								{
									grant: g.id,
									event: record.event.id,
									kind: "input",
									amount: P.Micros(amount),
									during: record.event.during
								}
							]
			})
			return Option.some({ faulty: usage(paying(debit)), sound: usage(paying(sound)) })
		}
	)
}

/**
 * The debitWhileValid or grantWithinAmount fault: a grant of the key's organization, expired before the request or
 * valid over it with something left, and a request whose charge covers the debit, credits paying exactly the debit, all
 * on the input kind.
 */
const plantDebit = (
	fault: "debitWhileValid" | "grantWithinAmount",
	p: Platform,
	margin: bigint,
	next: () => IdValue
): Option.Option<Planted> => {
	const { left } = balances(p)
	return firstSome(slotsOf(p), (slot) =>
		firstSome(
			Arr.filter(p.facts.CreditGrant, (x) => x.org === slot.org),
			(g) => debitOf(fault, p, margin, slot, g, left.get(g.id) ?? 0n, next)
		)
	)
}

/**
 * The usageWhileActive fault: the event paid by no credit, so moving it moves nothing a grant's validity covers; the
 * model refuses usage after the revocation, and the application's record is the same event moved past it, priced at its
 * new start, in the same month, whose cap has room for it.
 */
const plantUsageWhileActive = (
	p: Platform,
	margin: bigint,
	next: () => IdValue
): Option.Option<Planted> => {
	const months = viewOf(p.facts).months
	return firstSome(
		Arr.filter(p.facts.Revocation, (r) => Option.isSome(monthAt(months, r.at + margin))),
		(revoked) =>
			firstSome(
				Arr.filter(slotsOf(p), (slot) => slot.key === revoked.key),
				(slot) =>
					Option.flatMap(
						recordWithinCap(p, slot, [{ kind: "output", tokens: 10n }], next),
						(settled) => {
							const lifted: P.UsageRecord = {
								...settled,
								charges: Arr.map(settled.charges, (c) => ({ ...c, credited: P.Micros(0n) })),
								debits: []
							}
							const window = {
								start: P.Instant(revoked.at + margin - 1n),
								end: P.Instant(revoked.at + margin)
							}
							const moved: P.UsageRecord = {
								...lifted,
								event: { ...lifted.event, during: window },
								charges: Arr.map(lifted.charges, (c) => ({ ...c, priced: window }))
							}
							const sameMonth = Option.exists(
								monthAt(months, revoked.at + margin - 1n),
								(m) => m.month === moved.total.month
							)
							return sameMonth
								? Option.some({ faulty: usage(moved), sound: usage(lifted) })
								: Option.none()
						}
					)
			)
	)
}

/** The rateInForce fault: a card of the first card's model and kind overlapping it by `margin`. */
const plantRateInForce = (
	p: Platform,
	margin: bigint,
	next: () => IdValue
): Option.Option<Planted> =>
	Option.map(Arr.head(p.facts.RateCard), (card) => {
		const at = card.during.start
		const insert = (start: bigint, end: bigint): Attempt => {
			const added: Fact<typeof P.RateCard> = {
				id: next(),
				model: card.model,
				kind: card.kind,
				during: { start: P.Instant(start), end: P.Instant(end) }
			}
			return {
				apply: (db) =>
					Effect.map(
						answered(
							db.workload.addRateCard.once({ params: {}, facts: { insert: { RateCard: [added] } } })
						),
						decided
					),
				ops: [insertOp("RateCard", [added])]
			}
		}
		return {
			faulty: insert(at + margin - 1n, at + margin + DAY),
			sound: insert(at - DAY - margin, at)
		}
	})

/** The refundOnlyPaid fault: a refund of an open invoice, and the same of a paid one. */
const plantRefundOnlyPaid = (
	p: Platform,
	margin: bigint,
	next: () => IdValue
): Option.Option<Planted> =>
	Option.map(
		Option.all({
			open: Arr.findFirst(p.facts.Invoice, (i) => i.state === "open"),
			paid: Arr.findFirst(p.facts.Invoice, (i) => i.state === "paid")
		}),
		(at) => {
			const refund = (invoice: IdValue): Fact<typeof P.Refund> => ({
				id: next(),
				invoice,
				amount: P.Micros(0n),
				reason: "duplicate",
				at: P.Instant(JAN + margin)
			})
			return { faulty: refunding(refund(at.open.id)), sound: refunding(refund(at.paid.id)) }
		}
	)

/**
 * The allocationCovered fault: a plan change that cuts the segment an allocation lies in `margin` seconds before the
 * allocation ends, the segment's rest retired; without it, the same change splitting the segment there, its second part
 * priced alike. The fault is planted on the segments, never on the allocation: an allocation is a member of its plan
 * line's family, fixed when the line is inserted (InvoiceLine is immutable), since a month's close apportions each plan
 * line once and allocationExact holds its allocations to the line's amount, which never changes.
 */
const plantAllocationCovered = (p: Platform, margin: bigint): Option.Option<Planted> =>
	firstSome(p.facts.Allocation, (a) =>
		Option.flatMap(
			Arr.findFirst(
				p.facts.Segment,
				(g) =>
					g.subscription === a.subscription &&
					g.during.start <= a.during.start &&
					a.during.end <= g.during.end
			),
			(segment) => {
				const cut = a.during.end - margin
				if (cut <= segment.during.start) {
					return Option.none()
				}
				const part = (start: bigint, end: bigint): Fact<typeof P.Segment> => ({
					...segment,
					during: { start: P.Instant(start), end: P.Instant(end) }
				})
				const change = (by: ReadonlyArray<Fact<typeof P.Segment>>): Attempt => ({
					apply: (db) =>
						Effect.map(
							answered(
								db.workload.resegment.once({
									params: {},
									facts: { delete: { Segment: [segment] }, insert: { Segment: by } }
								})
							),
							decided
						),
					ops: [deleteOp("Segment", [segment]), insertOp("Segment", by)]
				})
				return Option.some({
					faulty: change([part(segment.during.start, cut)]),
					sound: change([part(segment.during.start, cut), part(cut, segment.during.end)])
				})
			}
		)
	)

/** The paidWithoutPayment fault: an open invoice put paid without its payment, and paid with it. */
const plantPaidWithoutPayment = (p: Platform, next: () => IdValue): Option.Option<Planted> =>
	Option.map(
		Arr.findFirst(p.facts.Invoice, (i) => i.state === "open"),
		(open) => {
			const paid: Addition<typeof P.Invoice> = { ...open, state: "paid" }
			const charge = next()
			return {
				faulty: {
					apply: (db) =>
						Effect.map(
							answered(
								db.workload.putInvoice.once({ params: {}, facts: { put: { Invoice: [paid] } } })
							),
							decided
						),
					ops: [putOp("Invoice", [paid])]
				},
				sound: {
					apply: (db) =>
						Effect.map(
							answered(
								db.workload.payInvoice.once({ params: { invoice: open.id, charge }, facts: {} })
							),
							decided
						),
					ops: [putOp("Invoice", [paid]), insertOp("Payment", [{ invoice: open.id, charge }])]
				}
			}
		}
	)

/** The pricedOutsideCards fault: a usage record whose first charge is priced `margin` seconds before every card of its model and kind. */
const plantPricedOutsideCards = (
	p: Platform,
	margin: bigint,
	next: () => IdValue
): Option.Option<Planted> =>
	firstSome(slotsOf(p), (slot) =>
		Option.flatMap(recordWithinCap(p, slot, [{ kind: "input", tokens: 100n }], next), (record) =>
			Arr.matchLeft(record.charges, {
				onEmpty: () => Option.none(),
				onNonEmpty: (first, rest) => {
					const earliest = Arr.reduce(
						Arr.filter(p.facts.RateCard, (c) => c.model === first.model && c.kind === first.kind),
						first.priced.start,
						(m, c) => (c.during.start < m ? c.during.start : m)
					)
					const unpriced = {
						...record,
						charges: [
							{
								...first,
								priced: {
									start: P.Instant(earliest - margin),
									end: P.Instant(earliest - margin + 1n)
								}
							},
							...rest
						]
					}
					return Option.some({ faulty: usage(unpriced), sound: usage(record) })
				}
			})
		)
	)

/**
 * The cardRetiredUnderCharges fault: the card that priced a stored charge cut `margin` seconds before the charge's
 * instant; the sound change splits the card `margin` seconds after the instant instead.
 */
const plantCardRetiredUnderCharges = (
	p: Platform,
	margin: bigint,
	next: () => IdValue
): Option.Option<Planted> =>
	firstSome(p.facts.UsageCharge, (charge) =>
		Option.flatMap(
			Arr.findFirst(
				p.facts.RateCard,
				(c) =>
					c.model === charge.model &&
					c.kind === charge.kind &&
					c.during.start <= charge.priced.start &&
					charge.priced.start < c.during.end
			),
			(card) => {
				const cut = charge.priced.start - margin + 1n
				const after = charge.priced.start + margin
				if (after >= card.during.end) {
					return Option.none()
				}
				const tiers = Arr.filter(p.facts.RateTier, (x) => x.card === card.id)
				const successor = next()
				const retired = { card, tiers }
				const part = (start: bigint, end: bigint): Fact<typeof P.RateCard> => ({
					...card,
					during: { start: P.Instant(start), end: P.Instant(end) }
				})
				return Option.some({
					faulty: rateChange({
						retired,
						cards: cut > card.during.start ? [part(card.during.start, cut)] : [],
						tiers: cut > card.during.start ? tiers : []
					}),
					sound: rateChange({
						retired,
						cards: [
							part(card.during.start, after),
							{ ...part(after, card.during.end), id: successor }
						],
						tiers: [...tiers, ...Arr.map(tiers, (x) => ({ ...x, card: successor }))]
					})
				})
			}
		)
	)

/**
 * Puts `fault` in `p`, `margin` past its boundary: the faulty write and the sound one, or none where the platform
 * offers no place for it. spendWithinCap takes a month whose cap its workspace spent exactly and a key of that
 * workspace active in it; debitWhileValid and grantWithinAmount take a grant of the key's organization, expired before
 * the request or valid over it with something left, and a request whose charge covers the debit, credits paying
 * exactly the debit, all on the input kind; pricedOutsideCards prices a usage record's first charge `margin` seconds
 * before every card of its model and kind; cardRetiredUnderCharges cuts the card that priced a stored charge `margin`
 * seconds before the charge's instant, and its sound change splits the card `margin` seconds after the instant
 * instead; allocationCovered cuts the segment an allocation lies in `margin` seconds before the allocation ends, and
 * its sound change splits the segment there.
 */
export const plant = (fault: Fault, p: Platform, margin: bigint): Option.Option<Planted> => {
	const next = eventIds()
	switch (fault) {
		case "spendWithinCap":
			return plantSpendWithinCap(p, margin, next)
		case "refundWithinInvoice":
			return plantRefundWithinInvoice(p, margin, next)
		case "chargeExact":
			return plantChargeExact(p, margin, next)
		case "debitWhileValid":
		case "grantWithinAmount":
			return plantDebit(fault, p, margin, next)
		case "usageWhileActive":
			return plantUsageWhileActive(p, margin, next)
		case "rateInForce":
			return plantRateInForce(p, margin, next)
		case "refundOnlyPaid":
			return plantRefundOnlyPaid(p, margin, next)
		case "allocationCovered":
			return plantAllocationCovered(p, margin)
		case "paidWithoutPayment":
			return plantPaidWithoutPayment(p, next)
		case "pricedOutsideCards":
			return plantPricedOutsideCards(p, margin, next)
		case "cardRetiredUnderCharges":
			return plantCardRetiredUnderCharges(p, margin, next)
	}
}

/** A case as drawn: a platform's sketch, the fault planted in it, and the fault's margin past its boundary. */
interface LawSketch {
	readonly platform: PlatformSketch
	readonly fault: Fault
	/** One micro-dollar or second at the boundary, up to a thousand beyond it. */
	readonly margin: number
}

export type LawFeature = `refused by ${Fault}` | `no place for ${Fault}`

/**
 * A platform with a place for every fault: planted boundaries (an expired grant with its amount left), an exact cap,
 * grants, a revoked key, a Team plan changed mid-month with its allocations, and invoices open and paid.
 */
const rich: PlatformSketch = {
	swarm: fullSwarm([
		"planted boundaries",
		"tiers",
		"rate changes",
		"grants",
		"exact caps",
		"revocations",
		"team plan",
		"refunds"
	]),
	months: 2,
	orgs: [{ parent: 0 }, { parent: 0xffff }],
	/** The first organization's first workspace spends its caps exactly; its second has room, as has the other's. */
	workspaces: [
		{ org: 0, cap: 0xffff },
		{ org: 0xffff, cap: 0 },
		{ org: 0, cap: 0 }
	],
	keys: [
		{ workspace: 0, created: 0, revoked: 0 },
		{ workspace: 0x8000, created: 0, revoked: 0x8000 },
		{ workspace: 0xffff, created: 0, revoked: 0 }
	],
	models: 2,
	providers: 2,
	rateChanges: [],
	grants: [{ org: 0xffff, amount: 0xffff, start: 0, end: 0xffff }],
	subscriptions: [
		{ org: 0, price: 0, change: 0x8000 },
		{ org: 0xffff, price: 0, change: 0 }
	],
	events: [
		{ key: 0xffff, route: 0, start: 0x3000, latency: 0, tokens: [0x4000, 0x8000, 0, 0, 0, 0] }
	],
	closes: [
		{ settle: 0x4000, refunds: [0x4000] },
		{ settle: 0, refunds: [] },
		{ settle: 0x4000, refunds: [] },
		{ settle: 0, refunds: [] }
	]
}

/** One workspace whose one month's cap is exactly what it spent, nothing, and a key revoked within that month. */
const spentCap: PlatformSketch = {
	swarm: fullSwarm(["revocations", "exact caps"]),
	months: 1,
	orgs: [{ parent: 0 }],
	workspaces: [{ org: 0, cap: 0x8000 }],
	keys: [
		{ workspace: 0, created: 0, revoked: 0x8000 },
		{ workspace: 0, created: 0, revoked: 0 }
	],
	models: 1,
	providers: 1,
	rateChanges: [],
	grants: [],
	subscriptions: [],
	events: [],
	closes: []
}

/**
 * A drawn platform half the time, the rich platform the other half: a drawn platform seldom has a place for a fault
 * that needs an exact cap, a refund or an expired grant, and the rich one has a place for every fault.
 */
export const lawSketchGen: Gen<LawSketch> = (source) => ({
	platform: source.draw(
		weighted<PlatformSketch>([
			[1, platformSketchGen],
			[1, constant(rich)]
		])
	),
	fault: source.draw(element(faults)),
	margin: source.draw(int(1, 1000))
})

/**
 * The planted faults the search kept by value, each at its boundary, and the cap spent so usageWhileActive has no place:
 * each the aim of the situation it reaches (aimed), which they reached on every run; none ever caught a bug (git log -S
 * on the module, 65203c443). Their swarms turn each form fully on or off, so they resolve without drawing.
 */
export const faultAims: ReadonlyArray<readonly [Reached<LawFeature>, Gen<LawSketch>]> = [
	...Arr.map(
		faults,
		(fault) => [`refused by ${fault}`, constant({ platform: rich, fault, margin: 1 })] as const
	),
	[
		"no place for usageWhileActive",
		constant({ platform: spentCap, fault: "usageWhileActive", margin: 1 })
	]
]

/** The platform with billing's workload, installed once per member: the template every case's seat clones. */
export const lawsPlatform = platformTemplate(import.meta, "platform_laws", () => [])
