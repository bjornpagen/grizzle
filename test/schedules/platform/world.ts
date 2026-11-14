import { Array as Arr, Effect, Option } from "effect"
import type { CallError } from "#compiler/live/index.ts"
import type { Addition } from "#compiler/public/changeset.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import type { Fact } from "#compiler/public/schema.ts"
import {
	type Answer,
	amountOf,
	answerOf,
	program,
	type RacesDb,
	stated,
	statementsOf,
	textOf,
	type Write
} from "#test/schedules/platform/support.ts"
import { defined } from "#test/support/assert.ts"
import * as P from "#test/support/fixtures/api/platform.ts"
import {
	calendarOf,
	FAR,
	JAN,
	noFacts,
	type PlatformFacts,
	settleRequests,
	TOKENS_MAX,
	type UsageRequest,
	uid,
	viewOf
} from "#test/support/platform/generate.ts"

import { answered, rowsOf } from "#test/support/calls.ts"
import {
	deleteOp,
	insertOp,
	type PlatformOp,
	putOp,
	type PlatformRow,
	rowsIn,
	type State,
	sameHostValue
} from "#test/support/platform/laws.ts"
import { pricedAt, type SpanV, platformSpan } from "#test/support/platform/model.ts"

/**
 * The platform the races run on, and the application's writes they race (Write), each with its meaning on
 * the host: the operations its program applies to a state (Op).
 *
 * One organization with one workspace and one key active from January on, one model served by one provider on one
 * route, priced by one input card in force from January on whose one tier charges a micro-dollar a token, so a
 * request's charge is its token count; the calendar's first month, and the workspace's cap for it. A race adds what it
 * threatens (grants, an invoice, earlier usage, a second month's cap) and draws the requests, priced and settled by the
 * host billing model (settleRequests) as the application prices and settles them from what it read.
 *
 * A program that reads the state (a settlement, the revocation) states what it applies at each state:
 * a settlement applies only to an invoice in the state its members read, and is unchanged on any other.
 */
export const ids = {
	org: uid(1, 1),
	workspace: uid(2, 1),
	key: uid(3, 1),
	provider: uid(4, 1),
	model: uid(5, 1),
	card: uid(6, 1),
	invoice: uid(9, 1),
	line: uid(10, 1),
	charge: uid(13, 1)
} as const
const eventId = (n: number): Uuid => uid(7, n)
export const grantId = (n: number): Uuid => uid(8, n)
const refundId = (n: number): Uuid => uid(12, n)
export const cardId = (n: number): Uuid => uid(6, n)

const [first, second] = calendarOf(2)
const month = defined(first, "the calendar's first month")
export const nextMonth = defined(second, "the calendar's second month")
const monthNo = P.MonthNo(month.month)
/** A micro-dollar a token, per million tokens. */
export const flatRate = 1_000_000n

export const instants = (s: SpanV) => ({ start: P.Instant(s.start), end: P.Instant(s.end) })

/** The workspace's cap for a calendar month, and for the race's month. */
export const limitIn = (of: typeof month, cap: bigint): Addition<typeof P.WorkspaceLimit> => ({
	workspace: ids.workspace,
	month: P.MonthNo(of.month),
	cap: P.Micros(cap)
})
export const limitOf = (cap: bigint): Addition<typeof P.WorkspaceLimit> => limitIn(month, cap)

const activeOf = (during: SpanV): Fact<typeof P.ApiKeyActive> => ({
	key: ids.key,
	during: instants(during)
})

const cardOf = (id: Uuid, during: SpanV): Fact<typeof P.RateCard> => ({
	id,
	model: ids.model,
	kind: "input",
	during: instants(during)
})

const flatTier = (card: Uuid, rate: bigint): Fact<typeof P.RateTier> => ({
	card,
	tier: { start: P.Tokens(0n), end: P.Tokens(TOKENS_MAX) },
	rate: P.Rate(rate)
})

/** The platform every race starts from, with the workspace's cap for the month. */
export const world = (cap: bigint): PlatformFacts => ({
	...noFacts,
	Month: [{ month: monthNo, during: instants(month.during) }],
	Org: [{ id: ids.org }],
	Workspace: [{ id: ids.workspace, org: ids.org }],
	ApiKey: [{ id: ids.key, workspace: ids.workspace, state: "active" }],
	ApiKeyActive: [activeOf(platformSpan(JAN, FAR))],
	Provider: [{ id: ids.provider }],
	Model: [{ id: ids.model }],
	Route: [{ model: ids.model, provider: ids.provider }],
	RateCard: [cardOf(ids.card, platformSpan(JAN, FAR))],
	RateTier: [flatTier(ids.card, flatRate)],
	WorkspaceLimit: [limitOf(cap)]
})

/** The calendar's second month added, with the workspace's cap for it. */
export const withNextMonth = (facts: PlatformFacts, cap: bigint): PlatformFacts => ({
	...facts,
	Month: [
		...facts.Month,
		{ month: P.MonthNo(nextMonth.month), during: instants(nextMonth.during) }
	],
	WorkspaceLimit: [...facts.WorkspaceLimit, limitIn(nextMonth, cap)]
})

/** A request of the key over `during` for `tokens` input tokens. */
export const request = (n: number, during: SpanV, tokens: bigint): UsageRequest => ({
	id: eventId(n),
	key: ids.key,
	model: ids.model,
	provider: ids.provider,
	during,
	tokens: [{ kind: "input", tokens }]
})

/**
 * What the application records for a request, priced and settled by the host model against `facts` with what each
 * grant has `left`, whatever the cap: the race decides the cap.
 */
export const recordOf = (
	facts: PlatformFacts,
	left: ReadonlyMap<string, bigint>,
	q: UsageRequest
): P.UsageRecord => {
	const uncapped = viewOf({
		...facts,
		WorkspaceLimit: Arr.map(facts.WorkspaceLimit, (l) => ({ ...l, cap: P.Micros(TOKENS_MAX) }))
	})
	const settled = settleRequests(uncapped, [q], { left, spent: new Map() })
	const [record] = settled.records
	if (record === undefined) {
		throw new Error(
			`the model refuses ${q.id}: ${Arr.join(
				Arr.flatMap(settled.refused, (r) => r.reasons),
				", "
			)}`
		)
	}
	return record
}

/** What each grant of `facts` has left after the debits `facts` holds. */
export const grantsLeft = (facts: PlatformFacts): ReadonlyMap<string, bigint> =>
	new Map(
		Arr.map(facts.CreditGrant, (g): [string, bigint] => [
			g.id,
			g.amount -
				Arr.reduce(
					Arr.filter(facts.CreditDebit, (d) => d.grant === g.id),
					0n,
					(sum: bigint, d) => sum + d.amount
				)
		])
	)

/** A recorded request's facts added to a state. */
export const withUsage = (facts: PlatformFacts, record: P.UsageRecord): PlatformFacts => ({
	...facts,
	UsageEvent: [...facts.UsageEvent, record.event],
	UsageCharge: [...facts.UsageCharge, ...record.charges],
	EventCharge: [...facts.EventCharge, record.total],
	ProviderCost: [...facts.ProviderCost, record.cost],
	CreditDebit: [...facts.CreditDebit, ...record.debits]
})

const usageOps = (record: P.UsageRecord): ReadonlyArray<PlatformOp> => [
	insertOp("UsageEvent", [record.event]),
	insertOp("UsageCharge", record.charges),
	insertOp("EventCharge", [record.total]),
	insertOp("ProviderCost", [record.cost]),
	insertOp("CreditDebit", record.debits)
]

const recordCall = (record: P.UsageRecord) => (db: RacesDb) =>
	Effect.map(
		answered(db.workload.recordUsage.once({ params: {}, facts: P.usageFacts(record) })),
		answerOf
	)

/**
 * One usage event recorded: the fixture's recordUsage, one ChangeSet; a direct writer inserts the same facts. A request
 * submitted again records the same event once more.
 */
export const usageWrite = (
	kind: "usage" | "usage again",
	record: P.UsageRecord,
	label: string
): Write => ({
	kind,
	label,
	grizzle: stated(recordCall(record), usageOps(record)),
	direct: statementsOf(usageOps(record))
})

/**
 * A request priced by the application from the fixture's quote, read just before it records the request: the card in
 * force at the window's start in the quote's snapshot prices it, and its charge is what the quote says. `priced` is the
 * request priced before the race, without credit; a direct writer records it as that.
 */
export const quotedUsageWrite = (priced: P.UsageRecord, tokens: bigint, label: string): Write => {
	const window = platformSpan(priced.event.during.start, priced.event.during.end)
	return {
		kind: "quoted usage",
		label,
		grizzle: {
			kind: "read",
			read: (db) =>
				Effect.map(
					rowsOf(
						db.workload.quote.once({
							params: {
								model: ids.model,
								now: instants(pricedAt(window)),
								usage: [{ kind: "input", tokens: P.Tokens(tokens) }]
							},
							facts: {}
						})
					),
					(rows) => {
						const charges = Arr.map(rows, (row) => ({
							event: priced.event.id,
							kind: row.kind,
							model: ids.model,
							priced: instants(pricedAt(window)),
							tokens: row.tokens,
							amount: P.Micros(row.amount),
							credited: P.Micros(0n)
						}))
						const total = Arr.reduce(charges, 0n, (sum: bigint, c) => sum + c.amount)
						const record: P.UsageRecord = {
							...priced,
							charges,
							total: { ...priced.total, amount: P.Micros(total) }
						}
						return { apply: recordCall(record), ops: usageOps(record) }
					}
				)
		},
		direct: statementsOf(usageOps(priced))
	}
}

const rateChangeWrite = (kind: string, label: string, change: P.RateChange): Write => {
	const ops = [
		deleteOp("RateTier", change.retired.tiers),
		deleteOp("RateCard", [change.retired.card]),
		insertOp("RateCard", change.cards),
		insertOp("RateTier", change.tiers)
	]
	return {
		kind,
		label,
		grizzle: stated(
			(db) =>
				Effect.map(
					answered(db.workload.changeRate.once({ params: {}, facts: P.rateChangeFacts(change) })),
					answerOf
				),
			ops
		),
		direct: statementsOf(ops)
	}
}

/**
 * The card in force split at an instant: the fixture's changeRate, its first part keeping its id and tier and the new
 * card taking `rate` from the instant on.
 */
export const splitWrite = (kind: string, at: bigint, card: Uuid, rate: bigint): Write =>
	rateChangeWrite(kind, `the rate split at ${at} to ${rate}`, {
		retired: {
			card: cardOf(ids.card, platformSpan(JAN, FAR)),
			tiers: [flatTier(ids.card, flatRate)]
		},
		cards: [cardOf(ids.card, platformSpan(JAN, at)), cardOf(card, platformSpan(at, FAR))],
		tiers: [flatTier(ids.card, flatRate), flatTier(card, rate)]
	})

/** The card in force ended at an instant with no card after it: the model's input priced no longer from then on. */
export const retireWrite = (at: bigint): Write =>
	rateChangeWrite("card retired", `the card retired at ${at}`, {
		retired: {
			card: cardOf(ids.card, platformSpan(JAN, FAR)),
			tiers: [flatTier(ids.card, flatRate)]
		},
		cards: [cardOf(ids.card, platformSpan(JAN, at))],
		tiers: [flatTier(ids.card, flatRate)]
	})

/**
 * The workspace's cap for the month changed in place: the fixture's setCap, a put; a direct writer puts the limit too,
 * its cap in place, its month's charges kept.
 */
export const capWrite = (from: bigint, to: bigint): Write => ({
	kind: from === to ? "cap put again" : "cap put",
	label: `cap ${from} to ${to}`,
	grizzle: stated(
		(db) =>
			Effect.map(
				answered(
					db.workload.setCap.once({ params: {}, facts: { put: { WorkspaceLimit: [limitOf(to)] } } })
				),
				answerOf
			),
		[putOp("WorkspaceLimit", [limitOf(to)])]
	),
	direct: statementsOf([putOp("WorkspaceLimit", [limitOf(to)])])
})

/**
 * The workspace's caps for the months `caps` gives: the fixture's setCaps, a put of each given month's cap from a
 * relation parameter, every other month left as it is; a direct writer puts the given limits too, their months'
 * charges kept.
 */
export const capsGivenWrite = (caps: ReadonlyArray<Addition<typeof P.WorkspaceLimit>>): Write => ({
	kind: "caps given",
	label: `caps to [${Arr.join(
		Arr.map(caps, (c) => `${c.month}: ${c.cap}`),
		", "
	)}]`,
	grizzle: stated(
		(db) =>
			Effect.map(answered(db.workload.setCaps.once({ params: { caps }, facts: {} })), answerOf),
		[putOp("WorkspaceLimit", caps)]
	),
	direct: statementsOf([putOp("WorkspaceLimit", caps)])
})

/**
 * A grant given another payload at its key: a put of the grant, by grizzle or a direct writer, its debits kept.
 */
export const grantWrite = (
	kind: string,
	to: Addition<typeof P.CreditGrant>,
	label: string
): Write => ({
	kind,
	label,
	grizzle: stated(
		(db) =>
			Effect.map(
				answered(db.workload.putGrant.once({ params: {}, facts: { put: { CreditGrant: [to] } } })),
				answerOf
			),
		[putOp("CreditGrant", [to])]
	),
	direct: statementsOf([putOp("CreditGrant", [to])])
})

type InvoiceState = "open" | "paid" | "void" | "disputed"

const invoiceOf = (amount: bigint, state: InvoiceState): Addition<typeof P.Invoice> => ({
	id: ids.invoice,
	org: ids.org,
	period: instants(month.during),
	amount: P.Micros(amount),
	state
})
const payment: Fact<typeof P.Payment> = { invoice: ids.invoice, charge: ids.charge }

/**
 * The month's invoice of `amount`, one usage line of it, in `state` with its settlement: paid with its payment, or
 * open.
 */
export const invoiced = (
	facts: PlatformFacts,
	amount: bigint,
	state: "open" | "paid"
): PlatformFacts => ({
	...facts,
	Invoice: [invoiceOf(amount, state)],
	InvoiceLine: [{ id: ids.line, invoice: ids.invoice, source: "usage", amount: P.Micros(amount) }],
	UsageLine: [{ line: ids.line, model: ids.model, kind: "input", tokens: P.Tokens(amount) }],
	Payment: state === "paid" ? [payment] : []
})

export const refundOf = (n: number, amount: bigint): Fact<typeof P.Refund> => ({
	id: refundId(n),
	invoice: ids.invoice,
	amount: P.Micros(amount),
	reason: "requested",
	at: P.Instant(month.during.start + 86_400n)
})

/** A refund: the fixture's refund, an insertion. */
export const refundWrite = (r: Fact<typeof P.Refund>, label: string): Write => {
	const ops = [insertOp("Refund", [r])]
	return {
		kind: "refund",
		label,
		grizzle: stated(
			(db) =>
				Effect.map(
					answered(db.workload.refund.once({ params: {}, facts: { insert: { Refund: [r] } } })),
					answerOf
				),
			ops
		),
		direct: statementsOf(ops)
	}
}

const settledAt = P.Instant(month.during.start + 2n * 86_400n)

/** The invoice as the state holds it, when it is in `state`. */
const invoiceIn = (s: State, state: InvoiceState): Option.Option<PlatformRow> =>
	Arr.findFirst(rowsIn(s, "Invoice"), (row) => row["id"] === ids.invoice && row["state"] === state)

/**
 * An invoice settlement: a workload program whose members read the invoice's state (payInvoice, disputeInvoice,
 * voidInvoice; its put and its arm's insertion read one sub-query), applied with its parameters, and on the host the
 * invoice moved from `from` to `to` with its arm when the state holds it in `from`, and nothing otherwise. A direct
 * writer settles the invoice it read before the race, in `from`: it puts the invoice in `to`, its lines and refunds
 * kept, removes its payment where it gives way, and inserts the arm.
 */
const settlementWrite = (
	kind: "pay" | "dispute" | "void",
	amount: bigint,
	from: "open" | "paid",
	to: "paid" | "disputed" | "void",
	apply: (db: RacesDb) => Effect.Effect<Answer, CallError>
): Write => {
	const arm: PlatformOp =
		to === "paid"
			? insertOp("Payment", [payment])
			: to === "void"
				? insertOp("Voiding", [{ invoice: ids.invoice, at: settledAt }])
				: insertOp("Dispute", [{ invoice: ids.invoice, at: settledAt }])
	const payments = from === "paid" ? [payment] : []
	return {
		kind,
		label: `the invoice ${from} to ${to}`,
		grizzle: program(apply, (s) => {
			if (Option.isNone(invoiceIn(s, from))) {
				return []
			}
			const givingWay =
				from === "paid" ? Arr.filter(rowsIn(s, "Payment"), (p) => p["invoice"] === ids.invoice) : []
			return [
				putOp("Invoice", [invoiceOf(amount, to)]),
				{ kind: "delete", relation: "Payment", facts: givingWay },
				arm
			]
		}),
		direct: statementsOf([
			deleteOp("Payment", payments),
			putOp("Invoice", [invoiceOf(amount, to)]),
			arm
		])
	}
}

export const payWrite = (amount: bigint): Write =>
	settlementWrite("pay", amount, "open", "paid", (db) =>
		Effect.map(
			answered(
				db.workload.payInvoice.once({
					params: { invoice: ids.invoice, charge: ids.charge },
					facts: {}
				})
			),
			answerOf
		)
	)

export const disputeWrite = (amount: bigint): Write =>
	settlementWrite("dispute", amount, "paid", "disputed", (db) =>
		Effect.map(
			answered(
				db.workload.disputeInvoice.once({
					params: { invoice: ids.invoice, at: settledAt },
					facts: {}
				})
			),
			answerOf
		)
	)

export const voidWrite = (amount: bigint): Write =>
	settlementWrite("void", amount, "open", "void", (db) =>
		Effect.map(
			answered(
				db.workload.voidInvoice.once({ params: { invoice: ids.invoice, at: settledAt }, facts: {} })
			),
			answerOf
		)
	)

/**
 * The key revoked at `at`: the fixture's revokeKey, its state and revocation by query members that read the key active,
 * and its active span cut at the instant, enumerated, so on the host the cut applies whatever the key's state and the
 * state and revocation only while it is active. A direct writer replaces the key and its active span.
 */
export const revokeWrite = (at: bigint, active: SpanV): Write => {
	const revoked: Fact<typeof P.ApiKey> = { id: ids.key, workspace: ids.workspace, state: "revoked" }
	const revocation: Fact<typeof P.Revocation> = { key: ids.key, at: P.Instant(at) }
	const cut = active.start < at ? [activeOf(platformSpan(active.start, at))] : []
	const spans = [deleteOp("ApiKeyActive", [activeOf(active)]), insertOp("ApiKeyActive", cut)]
	return {
		kind: "revoke",
		label: `the key revoked at ${at}`,
		grizzle: program(
			(db) =>
				Effect.map(
					answered(
						db.workload.revokeKey.once({
							params: {
								key: ids.key,
								at: P.Instant(at)
							},
							facts: P.revokeFacts(ids.key, P.Instant(at), instants(active))
						})
					),
					answerOf
				),
			(s) => {
				const keyActive = Arr.some(
					rowsIn(s, "ApiKey"),
					(row) => row["id"] === ids.key && row["state"] === "active"
				)
				return keyActive
					? [putOp("ApiKey", [revoked]), insertOp("Revocation", [revocation]), ...spans]
					: spans
			}
		),
		direct: statementsOf([
			deleteOp("ApiKey", [{ id: ids.key, workspace: ids.workspace, state: "active" }]),
			insertOp("ApiKey", [revoked]),
			insertOp("Revocation", [revocation]),
			...spans
		])
	}
}

/** What the workspace spent in the month, and its cap there. */
export const spentIn = (s: State): bigint =>
	Arr.reduce(
		Arr.filter(
			rowsIn(s, "EventCharge"),
			(f) => f["workspace"] === ids.workspace && sameHostValue(f["month"], monthNo)
		),
		0n,
		(sum, f) => sum + amountOf(f, "amount")
	)

/** The workspace's cap for the month, when the state holds one: a merge may have removed it. */
export const capIn = (s: State): Option.Option<bigint> =>
	Option.map(
		Arr.findFirst(
			rowsIn(s, "WorkspaceLimit"),
			(f) => f["workspace"] === ids.workspace && sameHostValue(f["month"], monthNo)
		),
		(limit) => amountOf(limit, "cap")
	)

export const refundedIn = (s: State): bigint =>
	Arr.reduce(rowsIn(s, "Refund"), 0n, (sum, r) => sum + amountOf(r, "amount"))

export const invoiceStateIn = (s: State): string =>
	textOf(defined(rowsIn(s, "Invoice")[0], "the invoice"), "state")
