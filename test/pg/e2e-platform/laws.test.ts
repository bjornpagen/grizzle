/**
 * The platform's laws refuse exactly what they forbid, each named through the naming door.
 *
 * A case is a generated platform, stored by one db.apply, and one write built from it as the application builds it
 * (priced, settled and attributed by the host billing model) with exactly one thing wrong, by a drawn margin of one
 * micro-dollar or second or more. The faulty write must be refused with `invariant-rejected` naming the one law it
 * breaks; then the same write without its fault must be accepted, so the refusal is the fault's and no other law's. The
 * host law model (test/support/platform/laws.ts) judges both writes on the stored platform too, as a second oracle: the
 * faulty write's state after breaks exactly the fault's law and the sound write's none, so the model refuses exactly
 * what grizzle refuses:
 *
 * - spend past a workspace's monthly cap (spendWithinCap): a usage event in a month whose cap the workspace has spent
 *   exactly; without the fault, the same event with no tokens;
 * - a refund past what is left of a paid invoice (refundWithinInvoice); without it, a refund of exactly what is left;
 * - an event's kinds summing past its charge (chargeExact); without it, the event as priced;
 * - a debit from a grant whose validity ended before the request (debitWhileValid); without it, the event paid by none;
 * - usage on a key after its revocation (usageWhileActive); without it, the same usage before the revocation;
 * - a rate card overlapping the one in force for its model and kind (rateInForce); without it, a card that ends where
 *   the first begins;
 * - a refund of an open invoice (refundOnlyPaid); without it, the same refund of a paid one;
 * - a debit past what is left of a grant (grantWithinAmount); without it, a debit of exactly what is left;
 * - an allocation moved outside its subscription's priced segments (allocationCovered); without it, the allocation
 *   split in two inside them;
 * - an invoice marked paid without its payment (invoiceSettlement's reverse law); without it, paid with its payment;
 * - a charge priced at an instant before every card of its model and kind (pricedByCard); without it, the charge priced
 *   at its event's start;
 * - a card retired from under a charge it priced, cut before the charge's instant (pricedByCard); without it, the card
 *   split after the instant, its second part priced alike.
 *
 * Every fault is planted at its boundary on a platform rich enough for all of them, then searched on drawn platforms,
 * where a fault with no place to go (no paid invoice, no revoked key) is noted as such.
 */
import { layer } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { constant, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { fullSwarm } from "@grizzle/testing/swarm"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import type { ApplyOutcome } from "#adapter/public/db.ts"
import type { ApplyError } from "#adapter/public/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import type { Fact } from "#compiler/public/schema.ts"
import { applyFacts, openPlatform, type PlatformDb } from "#test/pg/e2e-platform/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import * as P from "#test/support/fixtures/api/platform.ts"
import { installationNamesOf, installationOf, lawNamesOf } from "#test/support/kernel/naming.ts"

import {
	buildPlatform,
	DAY,
	JAN,
	monthAt,
	type Platform,
	type PlatformSketch,
	platformSketchGen,
	resolvePlatform,
	settleRequests,
	uid,
	viewOf
} from "#test/support/platform/generate.ts"

import { caseHang } from "#test/support/limits.ts"
import {
	decideSet,
	deleteOp,
	insertOp,
	lawsById,
	type PlatformOp,
	putOp,
	stateOf
} from "#test/support/platform/laws.ts"
import { coveredBy, platformSpan, type TokenKind } from "#test/support/platform/model.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The platform's law names, through the naming door. */
const billing = lawNamesOf(P.Billing)

/** The laws, read through the naming door. */
const law = {
	spendWithinCap: billing.lawOf(P.spendWithinCap),
	refundWithinInvoice: billing.lawOf(P.refundWithinInvoice),
	chargeExact: billing.lawOf(P.chargeExact),
	debitWhileValid: billing.lawOf(P.debitWhileValid),
	usageWhileActive: billing.lawOf(P.usageWhileActive),
	rateInForce: billing.lawOf(P.rateInForce),
	refundOnlyPaid: billing.lawOf(P.refundOnlyPaid),
	grantWithinAmount: billing.lawOf(P.grantWithinAmount),
	allocationCovered: billing.lawOf(P.allocationCovered),
	paidWithoutPayment: billing.alternativesOf(P.invoiceSettlement).reverse,
	pricedByCard: billing.lawOf(P.pricedByCard)
} as const satisfies Readonly<Record<string, LawId>>

/** Each fault and the one law it breaks. */
const faults = [
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
const faultLaw: Readonly<Record<Fault, keyof typeof law>> = {
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
const hostLaws = lawsById(billing)

/** The platform's installed names: an outcome's law read back to its LawId. */
const platformNames = installationNamesOf(installationOf(P.Billing, { kind: "declared" }))

/**
 * What an apply decided, as the property reads it: an outcome without its counts, witness and read-backs. The full
 * role writes every stored relation, so an outside-world outcome fails every expectation.
 */
type Decided =
	| { readonly kind: "accepted" | "no-change" }
	| { readonly kind: "invariant-rejected"; readonly law: LawId }
	| { readonly kind: "outside-world"; readonly relation: string }

const decided = (outcome: ApplyOutcome<unknown>): Decided => {
	switch (outcome.kind) {
		case "invariant-rejected":
			return { kind: outcome.kind, law: platformNames.reported(outcome.law) }
		case "outside-world":
			return { kind: outcome.kind, relation: outcome.relation }
		case "accepted":
		case "no-change":
			return { kind: outcome.kind }
	}
}

/** A write of a planted case: its ChangeSet applied to the stored platform, and its operations on the host. */
interface Attempt {
	readonly apply: (db: PlatformDb) => Effect.Effect<Decided, ApplyError>
	readonly ops: ReadonlyArray<PlatformOp>
}

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
	apply: (db) => Effect.map(db.apply(P.recordUsage(r), {}), decided),
	ops: usageOps(r)
})

const refunding = (r: Fact<typeof P.Refund>): Attempt => ({
	apply: (db) => Effect.map(db.apply(P.refund([r]), {}), decided),
	ops: [insertOp("Refund", [r])]
})

const rateChange = (c: P.RateChange): Attempt => ({
	apply: (db) => Effect.map(db.apply(P.changeRate(c), {}), decided),
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

let serial = 0
const nextEvent = () => uid(0x7e57, ++serial)

/**
 * A usage request on `key` at `t` for `tokens` input tokens, priced and settled by the model against the platform with
 * every cap lifted, so the record is the one the application would write whatever the cap: none when the model still
 * refuses it (an inactive key, an unpriced kind, a month outside the calendar) or the platform has no route.
 */
const recordAt = (
	p: Platform,
	key: Uuid,
	t: bigint,
	tokens: ReadonlyArray<{ readonly kind: TokenKind; readonly tokens: bigint }>
): Option.Option<P.UsageRecord> => {
	const view = viewOf(p.facts)
	const lifted = { ...view, caps: new Map(Arr.map([...view.caps], ([k]) => [k, 10n ** 15n])) }
	return Option.flatMap(Arr.head(p.facts.Route), (route) =>
		Arr.head(
			settleRequests(
				lifted,
				[
					{
						id: nextEvent(),
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
	readonly key: Uuid
	readonly t: bigint
	readonly workspace: Uuid
	readonly org: Uuid
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

/** Plants spendWithinCap: a month whose cap its workspace spent exactly, and a key of that workspace active in it. */
const plantSpendWithinCap = (p: Platform, margin: bigint): Option.Option<Planted> =>
	firstSome(
		Arr.filter(slotsOf(p), (slot) => slot.cap > 0n && slot.spent === slot.cap),
		(slot) =>
			Option.flatMap(
				Option.all({
					over: recordAt(p, slot.key, slot.t, [{ kind: "input", tokens: margin }]),
					none: recordAt(p, slot.key, slot.t, [])
				}),
				(at) =>
					at.over.total.amount === 0n
						? Option.none()
						: Option.some({ faulty: usage(at.over), sound: usage(at.none) })
			)
	)

/** Plants refundWithinInvoice: a refund of a paid invoice `margin` past what it has left. */
const plantRefundWithinInvoice = (p: Platform, margin: bigint): Option.Option<Planted> =>
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
				id: nextEvent(),
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
	tokens: ReadonlyArray<{ readonly kind: TokenKind; readonly tokens: bigint }>
): Option.Option<P.UsageRecord> =>
	Option.filter(
		recordAt(p, slot.key, slot.t, tokens),
		(record) => slot.spent + record.total.amount <= slot.cap
	)

/** Plants chargeExact: a usage record whose first charge is `margin` more than its pieces. */
const plantChargeExact = (p: Platform, margin: bigint): Option.Option<Planted> =>
	firstSome(slotsOf(p), (slot) =>
		Option.flatMap(
			recordWithinCap(p, slot, [{ kind: "input", tokens: 1000n + margin }]),
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
	g: Fact<typeof P.CreditGrant>,
	rest: bigint
): Option.Option<Planted> => {
	const expired = g.valid.end <= slot.t
	const valid = g.valid.start <= slot.t && slot.t + 1n <= g.valid.end
	if (fault === "debitWhileValid" ? !expired || rest < 1n : !valid) {
		return Option.none()
	}
	const debit = fault === "debitWhileValid" ? 1n : rest + margin
	const sound = fault === "debitWhileValid" ? 0n : rest
	return Option.flatMap(
		recordWithinCap(p, slot, [{ kind: "input", tokens: 10_000n + debit * 10n }]),
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
 * Plants debitWhileValid or grantWithinAmount: a grant of the key's organization, expired before the request or valid
 * over it with something left, and a request whose charge covers the debit, credits paying exactly the debit, all on
 * the input kind.
 */
const plantDebit = (
	fault: "debitWhileValid" | "grantWithinAmount",
	p: Platform,
	margin: bigint
): Option.Option<Planted> => {
	const { left } = balances(p)
	return firstSome(slotsOf(p), (slot) =>
		firstSome(
			Arr.filter(p.facts.CreditGrant, (x) => x.org === slot.org),
			(g) => debitOf(fault, p, margin, slot, g, left.get(g.id) ?? 0n)
		)
	)
}

/**
 * Plants usageWhileActive: the event paid by no credit, so moving it moves nothing a grant's validity covers; the model
 * refuses usage after the revocation, and the application's record is the same event moved past it, priced at its new
 * start, in the same month, whose cap has room for it.
 */
const plantUsageWhileActive = (p: Platform, margin: bigint): Option.Option<Planted> => {
	const months = viewOf(p.facts).months
	return firstSome(
		Arr.filter(p.facts.Revocation, (r) => Option.isSome(monthAt(months, r.at + margin))),
		(revoked) =>
			firstSome(
				Arr.filter(slotsOf(p), (slot) => slot.key === revoked.key),
				(slot) =>
					Option.flatMap(recordWithinCap(p, slot, [{ kind: "output", tokens: 10n }]), (settled) => {
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
					})
			)
	)
}

/** Plants rateInForce: a card of the first card's model and kind overlapping it by `margin`. */
const plantRateInForce = (p: Platform, margin: bigint): Option.Option<Planted> =>
	Option.map(Arr.head(p.facts.RateCard), (card) => {
		const at = card.during.start
		const insert = (start: bigint, end: bigint): Attempt => {
			const added: Fact<typeof P.RateCard> = {
				id: nextEvent(),
				model: card.model,
				kind: card.kind,
				during: { start: P.Instant(start), end: P.Instant(end) }
			}
			return {
				apply: (db) =>
					Effect.map(
						db.apply(ChangeSet.empty(P.Platform).insert(P.RateCard, [added]), {}),
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

/** Plants refundOnlyPaid: a refund of an open invoice, and the same of a paid one. */
const plantRefundOnlyPaid = (p: Platform, margin: bigint): Option.Option<Planted> =>
	Option.map(
		Option.all({
			open: Arr.findFirst(p.facts.Invoice, (i) => i.state === "open"),
			paid: Arr.findFirst(p.facts.Invoice, (i) => i.state === "paid")
		}),
		(at) => {
			const refund = (invoice: Uuid): Fact<typeof P.Refund> => ({
				id: nextEvent(),
				invoice,
				amount: P.Micros(0n),
				reason: "duplicate",
				at: P.Instant(JAN + margin)
			})
			return { faulty: refunding(refund(at.open.id)), sound: refunding(refund(at.paid.id)) }
		}
	)

/** Plants allocationCovered: an allocation moved `margin` before every segment of its subscription, or split in two. */
const plantAllocationCovered = (p: Platform, margin: bigint): Option.Option<Planted> =>
	Option.map(
		Arr.findFirst(p.facts.Allocation, (x) => x.during.end - x.during.start >= 2n),
		(a) => {
			const first = Arr.reduce(
				Arr.filter(p.facts.Segment, (s) => s.subscription === a.subscription),
				a.during.start,
				(m, s) => (s.during.start < m ? s.during.start : m)
			)
			const middle = a.during.start + (a.during.end - a.during.start) / 2n
			const half = a.amount / 2n
			const moved: Fact<typeof P.Allocation> = {
				...a,
				during: {
					start: P.Instant(first - margin - (a.during.end - a.during.start)),
					end: P.Instant(first - margin)
				}
			}
			const split: ReadonlyArray<Fact<typeof P.Allocation>> = [
				{ ...a, during: { start: a.during.start, end: P.Instant(middle) }, amount: P.Micros(half) },
				{
					...a,
					during: { start: P.Instant(middle), end: a.during.end },
					amount: P.Micros(a.amount - half)
				}
			]
			const replace = (by: ReadonlyArray<Fact<typeof P.Allocation>>): Attempt => ({
				apply: (db) =>
					Effect.map(
						db.apply(
							ChangeSet.empty(P.Platform).delete(P.Allocation, [a]).insert(P.Allocation, by),
							{}
						),
						decided
					),
				ops: [deleteOp("Allocation", [a]), insertOp("Allocation", by)]
			})
			return { faulty: replace([moved]), sound: replace(split) }
		}
	)

/** Plants paidWithoutPayment: an open invoice put paid without its payment, and paid with it. */
const plantPaidWithoutPayment = (p: Platform): Option.Option<Planted> =>
	Option.map(
		Arr.findFirst(p.facts.Invoice, (i) => i.state === "open"),
		(open) => {
			const paid: Fact<typeof P.Invoice> = { ...open, state: "paid" }
			const charge = nextEvent()
			return {
				faulty: {
					apply: (db) =>
						Effect.map(db.apply(ChangeSet.empty(P.Platform).put(P.Invoice, [paid]), {}), decided),
					ops: [putOp("Invoice", [paid])]
				},
				sound: {
					apply: (db) => Effect.map(db.apply(P.payInvoice, { invoice: open.id, charge }), decided),
					ops: [putOp("Invoice", [paid]), insertOp("Payment", [{ invoice: open.id, charge }])]
				}
			}
		}
	)

/** Plants pricedOutsideCards: a usage record whose first charge is priced `margin` seconds before every card of its model and kind. */
const plantPricedOutsideCards = (p: Platform, margin: bigint): Option.Option<Planted> =>
	firstSome(slotsOf(p), (slot) =>
		Option.flatMap(recordWithinCap(p, slot, [{ kind: "input", tokens: 100n }]), (record) =>
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
 * Plants cardRetiredUnderCharges: the card that priced a stored charge cut `margin` seconds before the charge's instant;
 * the sound change splits the card `margin` seconds after the instant instead.
 */
const plantCardRetiredUnderCharges = (p: Platform, margin: bigint): Option.Option<Planted> =>
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
				const successor = nextEvent()
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
 * Plants `fault` in `p`, `margin` past its boundary: the faulty write and the sound one, or none where the platform
 * offers no place for it. spendWithinCap takes a month whose cap its workspace spent exactly and a key of that
 * workspace active in it; debitWhileValid and grantWithinAmount take a grant of the key's organization, expired before
 * the request or valid over it with something left, and a request whose charge covers the debit, credits paying
 * exactly the debit, all on the input kind; pricedOutsideCards prices a usage record's first charge `margin` seconds
 * before every card of its model and kind; cardRetiredUnderCharges cuts the card that priced a stored charge `margin`
 * seconds before the charge's instant, and its sound change splits the card `margin` seconds after the instant
 * instead.
 */
const plant = (fault: Fault, p: Platform, margin: bigint): Option.Option<Planted> => {
	switch (fault) {
		case "spendWithinCap":
			return plantSpendWithinCap(p, margin)
		case "refundWithinInvoice":
			return plantRefundWithinInvoice(p, margin)
		case "chargeExact":
			return plantChargeExact(p, margin)
		case "debitWhileValid":
		case "grantWithinAmount":
			return plantDebit(fault, p, margin)
		case "usageWhileActive":
			return plantUsageWhileActive(p, margin)
		case "rateInForce":
			return plantRateInForce(p, margin)
		case "refundOnlyPaid":
			return plantRefundOnlyPaid(p, margin)
		case "allocationCovered":
			return plantAllocationCovered(p, margin)
		case "paidWithoutPayment":
			return plantPaidWithoutPayment(p)
		case "pricedOutsideCards":
			return plantPricedOutsideCards(p, margin)
		case "cardRetiredUnderCharges":
			return plantCardRetiredUnderCharges(p, margin)
	}
}

/** A case as drawn: a platform's sketch, the fault planted in it, and the fault's margin past its boundary. */
interface LawSketch {
	readonly platform: PlatformSketch
	readonly fault: Fault
	/** One micro-dollar or second at the boundary, up to a thousand beyond it. */
	readonly margin: number
}

type LawFeature = `refused by ${Fault}` | `no place for ${Fault}`

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
const lawSketchGen: Gen<LawSketch> = (source) => ({
	platform: source.draw(
		weighted<PlatformSketch>([
			[1, platformSketchGen],
			[1, constant(rich)]
		])
	),
	fault: source.draw(element(faults)),
	margin: source.draw(int(1, 1000))
})

/** The kept platforms' swarms turn each form fully on or off, so they resolve without drawing. */
const kept: ReadonlyArray<Kept<LawSketch, LawFeature>> = [
	...Arr.map(faults, (fault): Kept<LawSketch, LawFeature> => ({
		note: `${fault} at its boundary`,
		sketch: { platform: rich, fault, margin: 1 },
		draws: "",
		reaches: [`refused by ${fault}`]
	})),
	{
		note: "usageWhileActive in a month whose cap is spent has no place: its write would break spendWithinCap too",
		sketch: { platform: spentCap, fault: "usageWhileActive", margin: 1 },
		draws: "",
		reaches: ["no place for usageWhileActive"]
	}
]

layer(Substrate.layer)("the platform's laws refuse exactly what they forbid", (it) => {
	it.effect(
		"each planted fault is refused by its one law, and the write without it accepted",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const platform = yield* openPlatform("platform_laws")
					return yield* explore(
						{
							suite: "pg/e2e-platform/laws",
							draw: drawn(lawSketchGen),
							literal: Formatter.format,
							coverage: required<LawFeature>(
								Arr.map(faults, (f): LawFeature => `refused by ${f}`),
								{ cases: 200, sense: notesOnly }
							),
							kept,
							runs: 20,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(sketch, cx) =>
							Effect.gen(function* () {
								const c = {
									platform: buildPlatform(cx.draw(resolvePlatform(sketch.platform))),
									fault: sketch.fault,
									margin: BigInt(sketch.margin)
								}
								const placed = plant(c.fault, c.platform, c.margin)
								if (Option.isNone(placed)) {
									cx.note(`no place for ${c.fault}`)
									return
								}
								const planted = placed.value
								const broken = law[faultLaw[c.fault]]
								/**
								 * The host law model on the stored platform: the faulty write breaks exactly the fault's
								 * law, the sound one none.
								 */
								const stored = stateOf(c.platform.facts)
								const modelFaulty = decideSet(stored, planted.faulty.ops)
								assert.ok(
									modelFaulty.kind === "refused",
									`the model judges ${c.fault} by ${c.margin}: ${modelFaulty.kind}`
								)
								assert.deepEqual(
									Arr.map(modelFaulty.laws, (l) => l.name),
									[defined(hostLaws.get(broken), `the model's ${broken}`).name],
									`the model judges ${c.fault} by ${c.margin}`
								)
								assert.equal(
									decideSet(stored, planted.sound.ops).kind,
									"accepted",
									`the model judges ${c.fault} without its fault`
								)
								yield* platform.clear
								yield* platform.withDb((db) =>
									Effect.gen(function* () {
										yield* applyFacts(db, c.platform.facts)
										const faulty = yield* planted.faulty.apply(db)
										assert.deepEqual(
											faulty,
											{ kind: "invariant-rejected", law: broken },
											`${c.fault} by ${c.margin}`
										)
										cx.note(`refused by ${c.fault}`)
										const sound = yield* planted.sound.apply(db)
										assert.deepEqual(sound, { kind: "accepted" }, `${c.fault} without its fault`)
									})
								)
							})
					)
				})
			)
	)
})
