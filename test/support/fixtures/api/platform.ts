import { ALLEN } from "#compiler/public/allen.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import {
	closedId,
	contract,
	type Infer,
	pg,
	type Span,
	span as spanOf,
	uuid
} from "#compiler/public/fields.ts"
import { arm, query, v } from "#compiler/public/query.ts"
import {
	alternatives,
	capacity,
	closed,
	contained,
	derived,
	type Fact,
	key as candidateKey,
	login,
	mutable,
	on,
	ref,
	relation,
	role,
	schema,
	select,
	weigh,
	within
} from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"

export const Instant = contract("Instant", pg.bigint)
export const Micros = contract("Micros", pg.bigint, (x) => x.ge(0n))
export const Tokens = contract("Tokens", pg.bigint, (x) => x.ge(0n))
export const Rate = contract("Rate", pg.bigint, (x) => x.ge(0n))
export const DayNo = contract("DayNo", pg.integer)
export const MonthNo = contract("MonthNo", pg.integer)

const TokenKind = closed("TokenKind", [
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"batchInput",
	"batchOutput"
])
const KeyState = closed("KeyState", ["active", "revoked"])
const InvoiceState = closed("InvoiceState", ["open", "paid", "void", "disputed"])
const LineSource = closed("LineSource", ["usage", "plan"])
const RefundReason = closed("RefundReason", ["requested", "duplicate", "outage", "dispute"])

export const Org = relation("Org", { id: uuid }, ["id"])
/** Reseller and consolidated billing: an organization bills through at most one parent. */
export const ParentOrg = relation("ParentOrg", { child: uuid, parent: uuid }, ["child"])
export const Workspace = relation("Workspace", { id: uuid, org: uuid }, ["id"])
export const ApiKey = relation("ApiKey", { id: uuid, workspace: uuid, state: closedId(KeyState) }, [
	"id"
])
export const Revocation = relation("Revocation", { key: uuid, at: Instant }, ["key"])
/** The spans a key may be used in: a span key, so one key's spans never overlap. */
export const ApiKeyActive = relation("ApiKeyActive", { key: uuid, during: spanOf(Instant) }, [
	"key",
	"during"
])

export const Provider = relation("Provider", { id: uuid }, ["id"])
export const Model = relation("Model", { id: uuid }, ["id"])
export const Route = relation("Route", { model: uuid, provider: uuid }, ["model", "provider"])
/** What a provider charges upstream per million tokens of a model's kind, over time. */
export const ProviderPrice = relation(
	"ProviderPrice",
	{ provider: uuid, model: uuid, kind: closedId(TokenKind), during: spanOf(Instant), rate: Rate },
	["provider", "model", "kind", "during"]
)

/**
 * A model's price card for one token kind over a span of time; key(model, kind, during) keeps one in force at a time.
 */
export const RateCard = relation(
	"RateCard",
	{ id: uuid, model: uuid, kind: closedId(TokenKind), during: spanOf(Instant) },
	["id"]
)

/** A card's graduated tiers over token counts: each prices the part of an event's tokens it overlaps. */
export const RateTier = relation("RateTier", { card: uuid, tier: spanOf(Tokens), rate: Rate }, [
	"card",
	"tier"
])

/** The immutable, high-volume stream: one API request over its window. */
export const UsageEvent = relation(
	"UsageEvent",
	{ id: uuid, key: uuid, model: uuid, provider: uuid, during: spanOf(Instant) },
	["id"]
)

/**
 * An event's tokens of one kind, what they cost, and the part prepaid credits paid for. A charge names its event's
 * model and the instant it was priced at, the start of its event's window, as the one-second span [start, start + 1)
 * an instant is everywhere on the platform, so the law pricedByCard reads which card priced it.
 */
export const UsageCharge = relation(
	"UsageCharge",
	{
		event: uuid,
		kind: closedId(TokenKind),
		model: uuid,
		priced: spanOf(Instant),
		tokens: Tokens,
		amount: Micros,
		credited: Micros
	},
	["event", "kind"]
)

/** An event's total charge, attributed to its workspace and calendar month for caps and rollups. */
export const EventCharge = relation(
	"EventCharge",
	{ event: uuid, workspace: uuid, month: MonthNo, amount: Micros },
	["event"]
)
/** What the provider charged upstream for an event. */
export const ProviderCost = relation("ProviderCost", { event: uuid, amount: Micros }, ["event"])

export const CreditGrant = relation(
	"CreditGrant",
	{ id: uuid, org: uuid, amount: Micros, valid: spanOf(Instant) },
	["id"]
)

/**
 * The part of one event's kind a grant paid for; its span is the event's window, which the grant must be valid over.
 */
export const CreditDebit = relation(
	"CreditDebit",
	{ grant: uuid, event: uuid, kind: closedId(TokenKind), amount: Micros, during: spanOf(Instant) },
	["grant", "event", "kind"]
)

/** A workspace's cap for a calendar month, changed in place (mutable). */
export const WorkspaceLimit = relation(
	"WorkspaceLimit",
	{ workspace: uuid, month: MonthNo, cap: Micros },
	["workspace", "month"]
)

export const Day = relation("Day", { day: DayNo, during: spanOf(Instant), month: MonthNo }, ["day"])
export const Month = relation("Month", { month: MonthNo, during: spanOf(Instant) }, ["month"])

export const Invoice = relation(
	"Invoice",
	{ id: uuid, org: uuid, period: spanOf(Instant), amount: Micros, state: closedId(InvoiceState) },
	["id"]
)

export const InvoiceLine = relation(
	"InvoiceLine",
	{ id: uuid, invoice: uuid, source: closedId(LineSource), amount: Micros },
	["id"]
)

/** A usage line's detail: the billed remainder of one model's token kind over the period. */
export const UsageLine = relation(
	"UsageLine",
	{ line: uuid, model: uuid, kind: closedId(TokenKind), tokens: Tokens },
	["line"]
)
/** A Team plan line's detail: one subscription's charge over the period. */
export const PlanLine = relation("PlanLine", { line: uuid, subscription: uuid }, ["line"])
export const Payment = relation("Payment", { invoice: uuid, charge: uuid }, ["invoice"])
export const Voiding = relation("Voiding", { invoice: uuid, at: Instant }, ["invoice"])
export const Dispute = relation("Dispute", { invoice: uuid, at: Instant }, ["invoice"])
export const Refund = relation(
	"Refund",
	{ id: uuid, invoice: uuid, amount: Micros, reason: closedId(RefundReason), at: Instant },
	["id"]
)

export const Subscription = relation("Subscription", { id: uuid, org: uuid }, ["id"])
/** A subscription's monthly price over time: a span key, so two segments of one subscription never overlap. */
export const Segment = relation(
	"Segment",
	{ subscription: uuid, during: spanOf(Instant), monthlyPrice: Micros },
	["subscription", "during"]
)

/** A plan line apportioned across the priced segments it bills, to the micro-dollar. */
export const Allocation = relation(
	"Allocation",
	{ line: uuid, subscription: uuid, during: spanOf(Instant), amount: Micros },
	["line", "during"]
)

export const rateInForce = candidateKey(RateCard, ["model", "kind", "during"])
export const invoicePeriods = candidateKey(Invoice, ["org", "period"])
export const dayOfSpan = candidateKey(Day, ["during"])
export const monthOfSpan = candidateKey(Month, ["during"])
export const grantValidity = candidateKey(CreditGrant, ["id", "valid"])

/** Usage only inside its key's active spans: no usage before a key exists or after it is revoked. */
export const usageWhileActive = contained(
	on(UsageEvent, "key", "during"),
	on(ApiKeyActive, "key", "during")
)

/**
 * A charge only where a card of its model and kind is in force at the instant it was priced: no quote from a card that
 * was never in force there, and no card retired from under the charges it priced. The cards of one model's kind never
 * overlap (rateInForce), so the card that holds the instant is the one that priced it.
 */
export const pricedByCard = contained(
	on(UsageCharge, "model", "kind", "priced"),
	on(RateCard, "model", "kind", "during")
)

/** A debit only from a grant valid over the whole request. */
export const debitWhileValid = contained(
	on(CreditDebit, "grant", "during"),
	on(CreditGrant, "id", "valid")
)

/** A Team plan allocation only inside its subscription's priced segments. */
export const allocationCovered = contained(
	on(Allocation, "subscription", "during"),
	on(Segment, "subscription", "during")
)

/** An event's kinds sum to its charge exactly. */
export const chargeExact = capacity(on(EventCharge, "event"), {
	from: on(UsageCharge, "event"),
	weight: weigh("amount"),
	within: within(ref("amount"), ref("amount"))
})

/** A kind's debits sum to its credited part exactly; the rest is billed on the month's invoice. */
export const creditedExact = capacity(on(UsageCharge, "event", "kind"), {
	from: on(CreditDebit, "event", "kind"),
	weight: weigh("amount"),
	within: within(ref("credited"), ref("credited"))
})

/** Credits pay at most a kind's charge. */
export const creditedWithinCharge = capacity(on(UsageCharge, "event", "kind"), {
	from: on(UsageCharge, "event", "kind"),
	weight: weigh("credited"),
	within: within(0n, ref("amount"))
})

/** A grant is debited at most its amount, however many requests spend it at once. */
export const grantWithinAmount = capacity(on(CreditGrant, "id"), {
	from: on(CreditDebit, "grant"),
	weight: weigh("amount"),
	within: within(0n, ref("amount"))
})

/** A workspace spends at most its monthly cap. */
export const spendWithinCap = capacity(on(WorkspaceLimit, "workspace", "month"), {
	from: on(EventCharge, "workspace", "month"),
	weight: weigh("amount"),
	within: within(0n, ref("cap"))
})

/** An invoice's lines sum to its amount exactly. */
export const invoiceExact = capacity(on(Invoice, "id"), {
	from: on(InvoiceLine, "invoice"),
	weight: weigh("amount"),
	within: within(ref("amount"), ref("amount"))
})

/** A plan line's allocations sum to its amount exactly. */
export const allocationExact = capacity(on(select(InvoiceLine, { source: "plan" }), "id"), {
	from: on(Allocation, "line"),
	weight: weigh("amount"),
	within: within(ref("amount"), ref("amount"))
})

/** Refunds never exceed what the invoice charged, even with concurrent refund requests. */
export const refundWithinInvoice = capacity(on(Invoice, "id"), {
	from: on(Refund, "invoice"),
	weight: weigh("amount"),
	within: within(0n, ref("amount"))
})

/** Only a paid invoice is refunded. */
export const refundOnlyPaid = contained(
	on(Refund, "invoice"),
	on(select(Invoice, { state: "paid" }), "id")
)
export const keyRevocation = alternatives(ApiKey, "state", KeyState, { revoked: Revocation })
export const invoiceSettlement = alternatives(Invoice, "state", InvoiceState, {
	paid: Payment,
	void: Voiding,
	disputed: Dispute
})

export const lineDetail = alternatives(InvoiceLine, "source", LineSource, {
	usage: UsageLine,
	plan: PlanLine
})

/**
 * The platform's relations and statements under a schema name: typed by the name as a string, so the platform an
 * installation rebuilds under its own name (platformAt) has the declared platform's type.
 */
const platformOf = (name: string) =>
	schema(
		name,
		{
			TokenKind,
			KeyState,
			InvoiceState,
			LineSource,
			RefundReason,
			Org,
			ParentOrg,
			Workspace,
			ApiKey,
			Revocation,
			ApiKeyActive,
			Provider,
			Model,
			Route,
			ProviderPrice,
			RateCard,
			RateTier,
			UsageEvent,
			UsageCharge,
			EventCharge,
			ProviderCost,
			CreditGrant,
			CreditDebit,
			WorkspaceLimit,
			Day,
			Month,
			Invoice,
			InvoiceLine,
			UsageLine,
			PlanLine,
			Payment,
			Voiding,
			Dispute,
			Refund,
			Subscription,
			Segment,
			Allocation
		},
		[
			rateInForce,
			invoicePeriods,
			dayOfSpan,
			monthOfSpan,
			grantValidity,
			contained(on(ParentOrg, "child"), on(Org, "id")),
			contained(on(ParentOrg, "parent"), on(Org, "id")),
			contained(on(Workspace, "org"), on(Org, "id")),
			contained(on(ApiKey, "workspace"), on(Workspace, "id")),
			contained(on(ApiKeyActive, "key"), on(ApiKey, "id")),
			contained(on(Route, "model"), on(Model, "id")),
			contained(on(Route, "provider"), on(Provider, "id")),
			contained(on(ProviderPrice, "model", "provider"), on(Route, "model", "provider")),
			contained(on(RateCard, "model"), on(Model, "id")),
			contained(on(RateTier, "card"), on(RateCard, "id")),
			contained(on(UsageEvent, "model", "provider"), on(Route, "model", "provider")),
			usageWhileActive,
			pricedByCard,
			contained(on(UsageCharge, "event"), on(EventCharge, "event")),
			contained(on(EventCharge, "event"), on(UsageEvent, "id")),
			contained(on(EventCharge, "workspace"), on(Workspace, "id")),
			contained(on(EventCharge, "workspace", "month"), on(WorkspaceLimit, "workspace", "month")),
			contained(on(ProviderCost, "event"), on(UsageEvent, "id")),
			contained(on(CreditGrant, "org"), on(Org, "id")),
			contained(on(CreditDebit, "grant"), on(CreditGrant, "id")),
			contained(on(CreditDebit, "event", "kind"), on(UsageCharge, "event", "kind")),
			debitWhileValid,
			contained(on(WorkspaceLimit, "workspace"), on(Workspace, "id")),
			contained(on(WorkspaceLimit, "month"), on(Month, "month")),
			contained(on(Day, "month"), on(Month, "month")),
			contained(on(Invoice, "org"), on(Org, "id")),
			contained(on(InvoiceLine, "invoice"), on(Invoice, "id")),
			contained(on(UsageLine, "model"), on(Model, "id")),
			contained(on(PlanLine, "subscription"), on(Subscription, "id")),
			contained(on(Subscription, "org"), on(Org, "id")),
			contained(on(Segment, "subscription"), on(Subscription, "id")),
			contained(on(Refund, "invoice"), on(Invoice, "id")),
			contained(on(Allocation, "line", "subscription"), on(PlanLine, "line", "subscription")),
			contained(on(Allocation, "line"), on(select(InvoiceLine, { source: "plan" }), "id")),
			allocationCovered,
			chargeExact,
			creditedExact,
			creditedWithinCharge,
			grantWithinAmount,
			spendWithinCap,
			invoiceExact,
			allocationExact,
			refundWithinInvoice,
			refundOnlyPaid,
			keyRevocation,
			invoiceSettlement,
			lineDetail,
			mutable(WorkspaceLimit)
		]
	)

/**
 * The usage-billing platform of an LLM API company, in public-API form: organizations with reseller trees, workspaces
 * and API keys whose usage must lie inside the key's active spans, a model catalog served by providers on routes, rate
 * cards over time with graduated token tiers, the immutable usage stream priced per token kind, prepaid credit grants
 * debited by earliest expiry, monthly spend caps, monthly invoices with usage and Team plan lines, payments, refunds,
 * disputes and voids, and a daily spend rollup as a derived relation.
 *
 * Units. An instant is epoch seconds; money is micro-dollars (`Micros`); a rate is micro-dollars per million tokens. A
 * usage event happens over its request window, a half-open span, and is priced at the window's start. The charge of an
 * event and token kind is graduated: each tier of the rate card in force at the start, a half-open span of token
 * counts, prices the part of [0, tokens) it overlaps, and each piece rounds half up to the micro-dollar.
 *
 * The laws, each stated where it is declared: span keys (a model's rates per kind, a card's tiers, a key's active
 * spans, an organization's invoice periods, a subscription's priced segments never overlap); span coverage (a usage
 * window inside its key's active spans, a usage charge priced by a card of its model and kind in force when it was
 * priced, a credit debit inside its grant's validity, a Team plan allocation inside its subscription's priced
 * segments); exact sums (an event's kinds sum to its charge, a kind's debits to its credited part, an invoice's lines
 * to its amount, a plan line's allocations to its amount); upper bounds (a grant's debits, a kind's credited part, a
 * workspace's monthly spend, an invoice's refunds); and alternatives (a revoked key has its revocation; a paid, void or
 * disputed invoice its payment, voiding or dispute; a usage or plan line its detail). A workspace's monthly caps are
 * the one mutable relation: a cap changes in place.
 *
 * A fact states what the application computed from what it references, and the laws check it against what it
 * references: an event's total names its workspace and calendar month, a debit its event's window, a charge its event's
 * model and the instant it was priced at.
 *
 * A write that depends on what the database holds says so with query members, which read the state the ChangeSet starts
 * from in its own transaction: an invoice is paid only while it is open, disputed only while it is paid, voided only
 * while it is open, and a key revoked only while it is active; otherwise every member is empty and the outcome is
 * no-change. The other writes carry facts the application computed: a usage event's charges and debits from a quote and
 * the organization's balances, a month's invoice from its usage and plan prorations, and the spans a rate change or a
 * plan change splits. The laws hold either way, whatever the application computed.
 */
export const Platform = platformOf("Platform")

/** The daily spend rollup: a workspace's charges per calendar day, the day the request started in. */
export const dailySpendDefinition = query(Platform).rule((r) => {
	const { event, workspace, amount } = v(EventCharge)
	const { during } = v(UsageEvent)
	const { day, during: span } = v(Day)
	return r
		.match(EventCharge, { event, workspace, amount })
		.match(UsageEvent, { id: event, during })
		.match(Day, { day, during: span })
		.where(r.pointIn(Compute.lower(during, Instant), span))
		.find({ workspace, day, amount: r.sum(amount) })
})
const DailySpend = derived("DailySpend", dailySpendDefinition)

/**
 * What the billing role writes: every stored relation of the platform.
 * Every stored relation of the platform: what its full roles write.
 */
export const platformWrites = [
	"Org",
	"ParentOrg",
	"Workspace",
	"ApiKey",
	"Revocation",
	"ApiKeyActive",
	"Provider",
	"Model",
	"Route",
	"ProviderPrice",
	"RateCard",
	"RateTier",
	"UsageEvent",
	"UsageCharge",
	"EventCharge",
	"ProviderCost",
	"CreditGrant",
	"CreditDebit",
	"WorkspaceLimit",
	"Day",
	"Month",
	"Invoice",
	"InvoiceLine",
	"UsageLine",
	"PlanLine",
	"Payment",
	"Voiding",
	"Dispute",
	"Refund",
	"Subscription",
	"Segment",
	"Allocation"
] as const

export const Billing = schema.extend(Platform, { DailySpend }, [])

/**
 * The platform and its Billing extension rebuilt under another name, as a test installs them, with Billing's world: a
 * full role writing every stored relation and refreshing DailySpend, in its login.
 */
export const platformAt = (name: string) => {
	const base = platformOf(name)
	const extended = schema.extend(base, { DailySpend }, [])
	const billing = role(extended, "billing", extended.relations, {
		write: platformWrites,
		refresh: ["DailySpend"]
	})
	return {
		Platform: base,
		Billing: extended,
		billing,
		server: login(extended, "server", [billing])
	}
}

/**
 * The workload: reads
 * ----------------------------------------------------------------------------------------------------
 *
 * An instant a read is asked about ("now") is a one-second span parameter [t, t + 1): a span containing it, in any of
 * the four ways a span holds a point's second (contains, startedBy, finishedBy, equals), holds t. A window is a span
 * parameter; a span lies inside it in one of the four ways a span lies inside another.
 */
const holdsPoint = ALLEN.contains | ALLEN.startedBy | ALLEN.finishedBy | ALLEN.equals
const insideOf = ALLEN.during | ALLEN.starts | ALLEN.finishes | ALLEN.equals

/**
 * The pieces of an event's charge: for each kind, each tier of the card in force at the window's start that its
 * tokens reach, the tokens it prices and their cost, rounded half up to the micro-dollar.
 */
export const eventCost = query(Platform).rule((r) => {
	const { model, during } = v(UsageEvent)
	const { kind, tokens } = v(UsageCharge)
	const { id: card, during: inForce } = v(RateCard)
	const { tier, rate } = v(RateTier)
	const priced = Compute.sub(
		Compute.least(Compute.base(Compute.upper(tier, Tokens)), Compute.base(tokens)),
		Compute.base(Compute.lower(tier, Tokens))
	)
	return r
		.match(UsageEvent, { id: r.param("event", uuid), model, during })
		.match(UsageCharge, { event: r.param("event", uuid), kind, tokens })
		.match(RateCard, { id: card, model, kind, during: inForce })
		.match(RateTier, { card, tier, rate })
		.where(
			r.pointIn(Compute.lower(during, Instant), inForce),
			r.lt(Compute.lower(tier, Tokens), tokens)
		)
		.find({
			kind,
			tier,
			tokens: priced,
			amount: Compute.div(
				Compute.add(Compute.mul(priced, Compute.base(rate)), 500_000n),
				1_000_000n
			)
		})
})

/** A price quote: what the given tokens per kind of a model cost at an instant, per kind. */
export const quote = query(Platform).rule((r) => {
	const usage = r.relation("usage", {
		kind: UsageCharge.fields.kind,
		tokens: UsageCharge.fields.tokens
	})
	const { kind, tokens } = v(usage)
	const { id: card, during } = v(RateCard)
	const { tier, rate } = v(RateTier)
	const priced = Compute.sub(
		Compute.least(Compute.base(Compute.upper(tier, Tokens)), Compute.base(tokens)),
		Compute.base(Compute.lower(tier, Tokens))
	)
	return r
		.match(usage, { kind, tokens })
		.match(RateCard, { id: card, model: r.param("model", uuid), kind, during })
		.match(RateTier, { card, tier, rate })
		.where(
			r.allen(during, holdsPoint, r.param("now", RateCard.fields.during)),
			r.lt(Compute.lower(tier, Tokens), tokens)
		)
		.find({
			kind,
			tokens,
			amount: r.sum(
				Compute.div(Compute.add(Compute.mul(priced, Compute.base(rate)), 500_000n), 1_000_000n)
			)
		})
})

/** A model's cards in force at an instant, with their tiers. */
export const ratesAt = query(Platform)
	.rule((r) => {
		const { id, kind, during } = v(RateCard)
		return r
			.match(RateCard, { id, model: r.param("model", uuid), kind, during })
			.where(r.allen(during, holdsPoint, r.param("now", RateCard.fields.during)))
			.find({ id, kind, during })
	})
	.attach(
		"tiers",
		(c) =>
			query(Platform).rule((r) => {
				const { tier, rate } = v(RateTier)
				return r.match(RateTier, { card: c.id, tier, rate }).find({ tier, rate })
			}),
		"array"
	)

/** A model's rate history for one kind: each pair of consecutive cards, the first meeting the second. */
export const rateHistory = query(Platform).rule((r) => {
	const { id: before, during: was } = v(RateCard)
	const { id: after, during: is } = v(RateCard)
	return r
		.match(RateCard, {
			id: before,
			model: r.param("model", uuid),
			kind: r.param("kind", RateCard.fields.kind),
			during: was
		})
		.match(RateCard, {
			id: after,
			model: r.param("model", uuid),
			kind: r.param("kind", RateCard.fields.kind),
			during: is
		})
		.where(r.allen(was, ALLEN.meets, is))
		.find({ before, after, at: Compute.upper(was, Instant) })
})

/**
 * The usage events of a workspace's month whose rate changed after the month began: a card of the event's model and
 * kind starting inside the month, after its first second.
 */
export const repricedInMonth = query(Platform).rule((r) => {
	const { event } = v(EventCharge)
	const { model, during } = v(UsageEvent)
	const { kind } = v(UsageCharge)
	const { during: month } = v(Month)
	const { during: card } = v(RateCard)
	return r
		.match(EventCharge, {
			event,
			workspace: r.param("workspace", uuid),
			month: r.param("month", MonthNo)
		})
		.match(Month, { month: r.param("month", MonthNo), during: month })
		.match(UsageEvent, { id: event, model, during })
		.match(UsageCharge, { event, kind })
		.match(RateCard, { model, kind, during: card })
		.where(
			r.pointIn(Compute.lower(card, Instant), month),
			r.gt(Compute.lower(card, Instant), Compute.lower(month, Instant))
		)
		.find({ event, kind })
})

/** A workspace's spend per day over a window: each event's charge on the calendar day its request started. */
export const spendByDay = query(Platform).rule((r) => {
	const { event, amount } = v(EventCharge)
	const { during } = v(UsageEvent)
	const { day, during: span } = v(Day)
	return r
		.match(EventCharge, { event, workspace: r.param("workspace", uuid), amount })
		.match(UsageEvent, { id: event, during })
		.match(Day, { day, during: span })
		.where(
			r.pointIn(Compute.lower(during, Instant), span),
			r.allen(span, insideOf, r.param("window", Day.fields.during))
		)
		.find({ day, spend: r.sum(amount) })
})

/** A workspace's spend per month. */
export const spendByMonth = query(Platform).rule((r) => {
	const { event, month, amount } = v(EventCharge)
	return r
		.match(EventCharge, { event, workspace: r.param("workspace", uuid), month, amount })
		.find({ month, spend: r.sum(amount) })
})

/** One workspace's month: its events and spend. */
export const workspaceMonth = query(Platform).rule((r) => {
	const { event, amount } = v(EventCharge)
	return r
		.match(EventCharge, {
			event,
			workspace: r.param("workspace", uuid),
			month: r.param("month", MonthNo),
			amount
		})
		.find({ events: r.count(), spend: r.sum(amount) })
})

/** Each workspace's spend per month: the stage nearCap compares with the cap. */
const monthSpend = query(Platform).rule((r) => {
	const { event, workspace, month, amount } = v(EventCharge)
	return r
		.match(EventCharge, { event, workspace, month, amount })
		.find({ workspace, month, spend: r.sum(amount) })
})

/** An organization's workspaces at 90% or more of their cap in a month. */
export const nearCap = query(Platform).rule((r) => {
	const { id: workspace } = v(Workspace)
	const { spend } = v(monthSpend)
	const { cap } = v(WorkspaceLimit)
	return r
		.match(Workspace, { id: workspace, org: r.param("org", uuid) })
		.match(monthSpend, { workspace, month: r.param("month", MonthNo), spend })
		.match(WorkspaceLimit, { workspace, month: r.param("month", MonthNo), cap })
		.where(
			r.ge(Compute.mul(spend, 10n), Compute.mul(Compute.cast(Compute.base(cap), pg.numeric), 9n))
		)
		.find({ workspace, spend, cap })
})

/** A workspace's top models by spend in a month. */
export const topModels = query(Platform)
	.rule((r) => {
		const { event, amount } = v(EventCharge)
		const { model } = v(UsageEvent)
		return r
			.match(EventCharge, {
				event,
				workspace: r.param("workspace", uuid),
				month: r.param("month", MonthNo),
				amount
			})
			.match(UsageEvent, { id: event, model })
			.find({ model, spend: r.sum(amount) })
	})
	.orderBy(["spend", "desc"], ["model", "asc"])
	.take("k")

/** An organization's top providers by spend in a month. */
export const topProviders = query(Platform)
	.rule((r) => {
		const { id: workspace } = v(Workspace)
		const { event, amount } = v(EventCharge)
		const { provider } = v(UsageEvent)
		return r
			.match(Workspace, { id: workspace, org: r.param("org", uuid) })
			.match(EventCharge, { event, workspace, month: r.param("month", MonthNo), amount })
			.match(UsageEvent, { id: event, provider })
			.find({ provider, spend: r.sum(amount) })
	})
	.orderBy(["spend", "desc"], ["provider", "asc"])
	.take("k")

/** An organization's margin per provider in a month: what was billed against what the providers charged. */
export const marginByProvider = query(Platform).rule((r) => {
	const { id: workspace } = v(Workspace)
	const { event, amount } = v(EventCharge)
	const { provider } = v(UsageEvent)
	const { amount: cost } = v(ProviderCost)
	return r
		.match(Workspace, { id: workspace, org: r.param("org", uuid) })
		.match(EventCharge, { event, workspace, month: r.param("month", MonthNo), amount })
		.match(UsageEvent, { id: event, provider })
		.match(ProviderCost, { event, amount: cost })
		.find({ provider, billed: r.sum(amount), cost: r.sum(cost) })
})

/** Every organization below a reseller, the reseller included. */
const Descendants = query(Platform).recursive("Descendants", {
	row: { org: uuid },
	base: [
		(r) => {
			const { id } = v(Org)
			return r
				.match(Org, { id })
				.where(r.eq(id, r.param("root", uuid)))
				.find({ org: id })
		}
	],
	rec: [
		(r, self) => {
			const { org } = v(self)
			const { child } = v(ParentOrg)
			return r.match(self, { org }).match(ParentOrg, { child, parent: org }).find({ org: child })
		}
	]
})

/** A reseller's consolidated spend in a month, per organization of its tree. */
export const consolidatedSpend = query(Platform).rule((r) => {
	const tree = Descendants.bind({ root: r.param("root", uuid) })
	const { org } = v(tree)
	const { id: workspace } = v(Workspace)
	const { event, amount } = v(EventCharge)
	return r
		.match(tree, { org })
		.match(Workspace, { id: workspace, org })
		.match(EventCharge, { event, workspace, month: r.param("month", MonthNo), amount })
		.find({ org, spend: r.sum(amount) })
})

/** An organization's grants valid at an instant, each with what it has been debited. */
export const balanceAt = query(Platform)
	.rule((r) => {
		const { id, amount, valid } = v(CreditGrant)
		return r
			.match(CreditGrant, { id, org: r.param("org", uuid), amount, valid })
			.where(r.allen(valid, holdsPoint, r.param("now", CreditGrant.fields.valid)))
			.find({ id, amount, valid })
	})
	.attach(
		"debited",
		(g) =>
			query(Platform).rule((r) => {
				const { event, kind, amount } = v(CreditDebit)
				return r
					.match(CreditDebit, { grant: g.id, event, kind, amount })
					.find({ total: r.sum(amount) })
			}),
		"option"
	)

/** An organization's grants expiring within a window. */
export const expiringGrants = query(Platform).rule((r) => {
	const { id, amount, valid } = v(CreditGrant)
	return r
		.match(CreditGrant, { id, org: r.param("org", uuid), amount, valid })
		.where(r.pointIn(Compute.upper(valid, Instant), r.param("window", CreditGrant.fields.valid)))
		.find({ id, amount, valid })
})

/** A grant's burn-down: what it paid for per calendar day. */
export const burnDown = query(Platform).rule((r) => {
	const { event, kind, amount, during } = v(CreditDebit)
	const { day, during: span } = v(Day)
	return r
		.match(CreditDebit, { grant: r.param("grant", uuid), event, kind, amount, during })
		.match(Day, { day, during: span })
		.where(r.pointIn(Compute.lower(during, Instant), span))
		.find({ day, debited: r.sum(amount) })
})

/** A key's card: its workspace and state, its active spans, and its revocation when it is revoked. */
export const keyCard = query(Platform)
	.rule((r) => {
		const { id, workspace, state } = v(ApiKey)
		return r
			.match(ApiKey, { id, workspace, state })
			.where(r.eq(id, r.param("key", uuid)))
			.find({ id, workspace, state })
	})
	.attach(
		"active",
		(k) =>
			query(Platform).rule((r) => {
				const { during } = v(ApiKeyActive)
				return r.match(ApiKeyActive, { key: k.id, during }).find({ during })
			}),
		"array"
	)
	.attach(
		"revocation",
		(k) =>
			query(Platform).rule((r) => {
				const { at } = v(Revocation)
				return r.match(Revocation, { key: k.id, at }).find({ at })
			}),
		arm("state", "revoked")
	)

/** A key's usage log, newest request first: what the console pages through. */
export const usageLog = query(Platform)
	.rule((r) => {
		const { id, model, provider, during } = v(UsageEvent)
		return r
			.match(UsageEvent, { id, key: r.param("key", uuid), model, provider, during })
			.find({ id, model, provider, during, start: Compute.lower(during, Instant) })
	})
	.orderBy(["start", "desc"], ["id", "asc"])

/** A workspace's active keys with no request overlapping a window. */
const keysUsedIn = query(Platform).rule((r) => {
	const { key, during } = v(UsageEvent)
	return r
		.match(UsageEvent, { key, during })
		.where(r.allen(during, ALLEN.intersects, r.param("window", UsageEvent.fields.during)))
		.find({ key })
})

export const idleKeys = query(Platform).rule((r) => {
	const { id } = v(ApiKey)
	return r
		.match(ApiKey, { id, workspace: r.param("workspace", uuid), state: "active" })
		.where(
			r.not(keysUsedIn.bind({ window: r.param("window", UsageEvent.fields.during) }), { key: id })
		)
		.find({ key: id })
})

/** The daily rollup of a workspace over a window, each day with the live sum it must equal. */
export const rollupVersusLive = query(Billing)
	.rule((r) => {
		const { workspace, day, amount } = v(DailySpend)
		const { during } = v(Day)
		return r
			.match(DailySpend, { workspace, day, amount })
			.match(Day, { day, during })
			.where(
				r.eq(workspace, r.param("workspace", uuid)),
				r.allen(during, insideOf, r.param("window", Day.fields.during))
			)
			.find({ workspace, day, rolled: amount })
	})
	.attach(
		"live",
		(d) =>
			query(Platform).rule((r) => {
				const { event, amount } = v(EventCharge)
				const { during } = v(UsageEvent)
				const { during: span } = v(Day)
				return r
					.match(EventCharge, { event, workspace: d.workspace, amount })
					.match(UsageEvent, { id: event, during })
					.match(Day, { day: d.day, during: span })
					.where(r.pointIn(Compute.lower(during, Instant), span))
					.find({ total: r.sum(amount) })
			}),
		"option"
	)

/** An organization's invoices, newest period first: what the billing page pages through. */
export const invoices = query(Platform)
	.rule((r) => {
		const { id, period, amount, state } = v(Invoice)
		return r
			.match(Invoice, { id, org: r.param("org", uuid), period, amount, state })
			.find({ id, period, amount, state, start: Compute.lower(period, Instant) })
	})
	.orderBy(["start", "desc"], ["id", "asc"])

/** The invoice whose period holds an instant. */
export const invoiceAt = query(Platform).rule((r) => {
	const { id, period, amount, state } = v(Invoice)
	return r
		.match(Invoice, { id, org: r.param("org", uuid), period, amount, state })
		.where(r.allen(period, holdsPoint, r.param("now", Invoice.fields.period)))
		.find({ id, period, amount, state })
})

/** An organization's open invoices whose period ended by a cutoff. */
export const overdueInvoices = query(Platform).rule((r) => {
	const { id, period, amount } = v(Invoice)
	return r
		.match(Invoice, { id, org: r.param("org", uuid), period, amount, state: "open" })
		.where(r.le(Compute.upper(period, Instant), r.param("cutoff", Instant)))
		.find({ id, period, amount })
})

/** An invoice with its lines, each line's detail by its source, its refunds, and its settlement by its state. */
export const invoicePreview = query(Platform)
	.rule((r) => {
		const { id, org, period, amount, state } = v(Invoice)
		return r
			.match(Invoice, { id, org, period, amount, state })
			.where(r.eq(id, r.param("invoice", uuid)))
			.find({ id, org, period, amount, state })
	})
	.attach(
		"lines",
		(i) =>
			query(Platform)
				.rule((r) => {
					const { id, source, amount } = v(InvoiceLine)
					return r
						.match(InvoiceLine, { id, invoice: i.id, source, amount })
						.find({ id, source, amount })
				})
				.attach(
					"usage",
					(l) =>
						query(Platform).rule((r) => {
							const { model, kind, tokens } = v(UsageLine)
							return r
								.match(UsageLine, { line: l.id, model, kind, tokens })
								.find({ model, kind, tokens })
						}),
					arm("source", "usage")
				)
				.attach(
					"plan",
					(l) =>
						query(Platform).rule((r) => {
							const { subscription } = v(PlanLine)
							return r.match(PlanLine, { line: l.id, subscription }).find({ subscription })
						}),
					arm("source", "plan")
				),
		"array"
	)
	.attach(
		"refunds",
		(i) =>
			query(Platform).rule((r) => {
				const { id, amount, reason, at } = v(Refund)
				return r
					.match(Refund, { id, invoice: i.id, amount, reason, at })
					.find({ id, amount, reason, at })
			}),
		"array"
	)
	.attach(
		"payment",
		(i) =>
			query(Platform).rule((r) => {
				const { charge } = v(Payment)
				return r.match(Payment, { invoice: i.id, charge }).find({ charge })
			}),
		arm("state", "paid")
	)
	.attach(
		"dispute",
		(i) =>
			query(Platform).rule((r) => {
				const { at } = v(Dispute)
				return r.match(Dispute, { invoice: i.id, at }).find({ at })
			}),
		arm("state", "disputed")
	)

/**
 * What is left to refund on each paid invoice of an organization: charged, and refunded so far. The refund's id is
 * bound, so two refunds of one amount are two contributions: a set of (amount) alone would fold them into one.
 */
export const refundable = query(Platform)
	.rule((r) => {
		const { id, amount } = v(Invoice)
		const { id: refund, amount: refunded } = v(Refund)
		return r
			.match(Invoice, { id, org: r.param("org", uuid), amount, state: "paid" })
			.match(Refund, { id: refund, invoice: id, amount: refunded })
			.find({ invoice: id, amount, refunded: r.sum(refunded) })
	})
	.rule((r) => {
		const { id, amount } = v(Invoice)
		return r
			.match(Invoice, { id, org: r.param("org", uuid), amount, state: "paid" })
			.where(r.not(Refund, { invoice: id }))
			.find({ invoice: id, amount, refunded: Compute.literal(pg.numeric, 0n) })
	})

/** An organization's refunds in a window, per reason. */
export const refundsByReason = query(Platform).rule((r) => {
	const { id, invoice, amount, reason, at } = v(Refund)
	return r
		.match(Invoice, { id: invoice, org: r.param("org", uuid) })
		.match(Refund, { id, invoice, amount, reason, at })
		.where(r.pointIn(at, r.param("window", Invoice.fields.period)))
		.find({ reason, refunds: r.count(), refunded: r.sum(amount) })
})

/** The organizations refunded most. */
export const mostRefunded = query(Platform)
	.rule((r) => {
		const { id, invoice, amount } = v(Refund)
		const { org } = v(Invoice)
		return r
			.match(Refund, { id, invoice, amount })
			.match(Invoice, { id: invoice, org })
			.find({ org, refunded: r.sum(amount) })
	})
	.orderBy(["refunded", "desc"], ["org", "asc"])
	.take("k")

/** A subscription's priced segments in force at an instant. */
export const segmentsAt = query(Platform).rule((r) => {
	const { during, monthlyPrice } = v(Segment)
	return r
		.match(Segment, { subscription: r.param("subscription", uuid), during, monthlyPrice })
		.where(r.allen(during, holdsPoint, r.param("now", Segment.fields.during)))
		.find({ during, monthlyPrice })
})

/**
 * The segments an invoice's period touches for one of its organization's subscriptions, with the overlap's length and
 * the prorated charge: price times overlap over the period's length, rounded to the micro-dollar.
 */
export const prorationFor = query(Platform).rule((r) => {
	const { org, period } = v(Invoice)
	const { id: subscription } = v(Subscription)
	const { during, monthlyPrice } = v(Segment)
	const overlap = Compute.sub(
		Compute.least(
			Compute.base(Compute.upper(during, Instant)),
			Compute.base(Compute.upper(period, Instant))
		),
		Compute.greatest(
			Compute.base(Compute.lower(during, Instant)),
			Compute.base(Compute.lower(period, Instant))
		)
	)
	return r
		.match(Invoice, { id: r.param("invoice", uuid), org, period })
		.match(Subscription, { id: subscription, org })
		.match(Segment, { subscription, during, monthlyPrice })
		.where(r.allen(during, ALLEN.intersects, period))
		.find({
			subscription,
			during,
			overlap,
			prorated: Compute.round(
				Compute.div(
					Compute.mul(
						Compute.cast(Compute.base(monthlyPrice), pg.numeric),
						Compute.cast(overlap, pg.numeric)
					),
					Compute.cast(Compute.base(Compute.width(period, Instant)), pg.numeric)
				)
			)
		})
})

/** Monthly recurring revenue of an organization's subscriptions at an instant. */
export const mrrAt = query(Platform).rule((r) => {
	const { id } = v(Subscription)
	const { during, monthlyPrice } = v(Segment)
	return r
		.match(Subscription, { id, org: r.param("org", uuid) })
		.match(Segment, { subscription: id, during, monthlyPrice })
		.where(r.allen(during, holdsPoint, r.param("now", Segment.fields.during)))
		.find({ mrr: r.sum(monthlyPrice) })
})

/**
 * Revenue an organization's plan allocations recognize in a calendar month: each allocation's amount prorated by its
 * overlap with the month.
 */
export const recognizedIn = query(Platform).rule((r) => {
	const { id: subscription } = v(Subscription)
	const { line, during, amount } = v(Allocation)
	const { during: month } = v(Month)
	const overlap = Compute.sub(
		Compute.least(
			Compute.base(Compute.upper(during, Instant)),
			Compute.base(Compute.upper(month, Instant))
		),
		Compute.greatest(
			Compute.base(Compute.lower(during, Instant)),
			Compute.base(Compute.lower(month, Instant))
		)
	)
	return r
		.match(Subscription, { id: subscription, org: r.param("org", uuid) })
		.match(Month, { month: r.param("month", MonthNo), during: month })
		.match(Allocation, { line, subscription, during, amount })
		.where(r.allen(during, ALLEN.intersects, month))
		.find({
			line,
			during,
			recognized: Compute.round(
				Compute.div(
					Compute.mul(
						Compute.cast(Compute.base(amount), pg.numeric),
						Compute.cast(overlap, pg.numeric)
					),
					Compute.cast(Compute.base(Compute.width(during, Instant)), pg.numeric)
				)
			)
		})
})

/** An invoice's plan lines with their allocations. */
export const allocationBreakdown = query(Platform)
	.rule((r) => {
		const { id, amount } = v(InvoiceLine)
		const { subscription } = v(PlanLine)
		return r
			.match(InvoiceLine, { id, invoice: r.param("invoice", uuid), source: "plan", amount })
			.match(PlanLine, { line: id, subscription })
			.find({ id, subscription, amount })
	})
	.attach(
		"allocations",
		(l) =>
			query(Platform).rule((r) => {
				const { during, amount } = v(Allocation)
				return r.match(Allocation, { line: l.id, during, amount }).find({ during, amount })
			}),
		"array"
	)

/**
 * An open invoice paid by a charge: the state change and its payment in one ChangeSet, as the alternatives law holds at
 * commit.
 */
export const payInvoice = ChangeSet.empty(Platform)
	.put(
		Invoice,
		query(Platform).rule((r) => {
			const { org, period, amount } = v(Invoice)
			return r
				.match(Invoice, {
					id: r.param("invoice", Invoice.fields.id),
					org,
					period,
					amount,
					state: "open"
				})
				.find({
					id: r.param("invoice", Invoice.fields.id),
					org,
					period,
					amount,
					state: r.literal("paid")
				})
		})
	)
	.insert(
		Payment,
		query(Platform).rule((r) =>
			r.match(Invoice, { id: r.param("invoice", Invoice.fields.id), state: "open" }).find({
				invoice: r.param("invoice", Payment.fields.invoice),
				charge: r.param("charge", Payment.fields.charge)
			})
		)
	)

/** A paid invoice disputed: its payment gives way to the dispute. */
export const disputeInvoice = ChangeSet.empty(Platform)
	.put(
		Invoice,
		query(Platform).rule((r) => {
			const { org, period, amount } = v(Invoice)
			return r
				.match(Invoice, {
					id: r.param("invoice", Invoice.fields.id),
					org,
					period,
					amount,
					state: "paid"
				})
				.find({
					id: r.param("invoice", Invoice.fields.id),
					org,
					period,
					amount,
					state: r.literal("disputed")
				})
		})
	)
	.delete(
		Payment,
		query(Platform).rule((r) => {
			const { charge } = v(Payment)
			return r
				.match(Payment, { invoice: r.param("invoice", Payment.fields.invoice), charge })
				.match(Invoice, { id: r.param("invoice", Invoice.fields.id), state: "paid" })
				.find({ invoice: r.param("invoice", Payment.fields.invoice), charge })
		})
	)
	.insert(
		Dispute,
		query(Platform).rule((r) =>
			r.match(Invoice, { id: r.param("invoice", Invoice.fields.id), state: "paid" }).find({
				invoice: r.param("invoice", Dispute.fields.invoice),
				at: r.param("at", Dispute.fields.at)
			})
		)
	)

/** An open invoice voided. */
export const voidInvoice = ChangeSet.empty(Platform)
	.put(
		Invoice,
		query(Platform).rule((r) => {
			const { org, period, amount } = v(Invoice)
			return r
				.match(Invoice, {
					id: r.param("invoice", Invoice.fields.id),
					org,
					period,
					amount,
					state: "open"
				})
				.find({
					id: r.param("invoice", Invoice.fields.id),
					org,
					period,
					amount,
					state: r.literal("void")
				})
		})
	)
	.insert(
		Voiding,
		query(Platform).rule((r) =>
			r.match(Invoice, { id: r.param("invoice", Invoice.fields.id), state: "open" }).find({
				invoice: r.param("invoice", Voiding.fields.invoice),
				at: r.param("at", Voiding.fields.at)
			})
		)
	)

/**
 * An active key revoked at an instant: its state and revocation by query members, and its active span cut at the
 * instant, which the application read from the key's card. Usage after the cut is then outside every active span.
 */
export const revokeKey = (
	key: string,
	at: Infer<typeof Instant>,
	active: Span<Infer<typeof Instant>>
) =>
	ChangeSet.empty(Platform)
		.put(
			ApiKey,
			query(Platform).rule((r) => {
				const { workspace } = v(ApiKey)
				return r
					.match(ApiKey, { id: r.param("key", ApiKey.fields.id), workspace, state: "active" })
					.find({ id: r.param("key", ApiKey.fields.id), workspace, state: r.literal("revoked") })
			})
		)
		.insert(
			Revocation,
			query(Platform).rule((r) =>
				r.match(ApiKey, { id: r.param("key", ApiKey.fields.id), state: "active" }).find({
					key: r.param("key", Revocation.fields.key),
					at: r.param("at", Revocation.fields.at)
				})
			)
		)
		.delete(ApiKeyActive, [{ key, during: active }])
		.insert(
			ApiKeyActive,
			active.start < at ? [{ key, during: { start: active.start, end: at } }] : []
		)

/**
 * One usage event as the application records it: the event, its charge per kind with the part credits paid, its total
 * against its workspace's month, the provider's cost, and its debits per grant and kind, in one ChangeSet.
 */
export interface UsageRecord {
	readonly event: Fact<typeof UsageEvent>
	readonly charges: ReadonlyArray<Fact<typeof UsageCharge>>
	readonly total: Fact<typeof EventCharge>
	readonly cost: Fact<typeof ProviderCost>
	readonly debits: ReadonlyArray<Fact<typeof CreditDebit>>
}

export const recordUsage = (u: UsageRecord) =>
	ChangeSet.empty(Platform)
		.insert(UsageEvent, [u.event])
		.insert(UsageCharge, u.charges)
		.insert(EventCharge, [u.total])
		.insert(ProviderCost, [u.cost])
		.insert(CreditDebit, u.debits)

/** A workspace's cap for a month, set or changed in place. */
export const setCap = (limits: ReadonlyArray<Fact<typeof WorkspaceLimit>>) =>
	ChangeSet.empty(Platform).put(WorkspaceLimit, limits)

/**
 * A workspace's caps replaced by the months given: each given month's cap set, and every other month of the workspace's
 * caps removed. The removal is the workspace's caps whose key the given caps do not hold, read from the same relation
 * parameter as the put, so the two members are one MERGE whose NOT MATCHED BY SOURCE action removes the rest of the
 * workspace's months. A month the workspace has spent in keeps its cap: its charges are contained in it.
 */
export const setCaps = ChangeSet.empty(Platform)
	.put(
		WorkspaceLimit,
		query(Platform).rule((r) => {
			const { workspace, month, cap } = v(WorkspaceLimit)
			return r
				.match(r.relation("caps", WorkspaceLimit), { workspace, month, cap })
				.find({ workspace, month, cap })
		})
	)
	.delete(
		WorkspaceLimit,
		query(Platform).rule((r) => {
			const { workspace, month, cap } = v(WorkspaceLimit)
			return r
				.match(WorkspaceLimit, { workspace, month, cap })
				.where(r.eq(workspace, r.param("workspace", WorkspaceLimit.fields.workspace)))
				.where(r.not(r.relation("caps", WorkspaceLimit), { workspace, month }))
				.find({ workspace, month, cap })
		})
	)

/**
 * A rate change at an instant: the card in force is split there, its first part keeping its tiers and the new card
 * taking the new ones from the instant on.
 */
export interface RateChange {
	readonly retired: {
		readonly card: Fact<typeof RateCard>
		readonly tiers: ReadonlyArray<Fact<typeof RateTier>>
	}
	readonly cards: ReadonlyArray<Fact<typeof RateCard>>
	readonly tiers: ReadonlyArray<Fact<typeof RateTier>>
}

export const changeRate = (c: RateChange) =>
	ChangeSet.empty(Platform)
		.delete(RateTier, c.retired.tiers)
		.delete(RateCard, [c.retired.card])
		.insert(RateCard, c.cards)
		.insert(RateTier, c.tiers)

/**
 * A month closed for an organization: its invoice, the usage lines with their details, and the Team plan lines with
 * their allocations.
 */
export interface MonthClose {
	readonly invoice: Fact<typeof Invoice>
	readonly lines: ReadonlyArray<Fact<typeof InvoiceLine>>
	readonly usage: ReadonlyArray<Fact<typeof UsageLine>>
	readonly plans: ReadonlyArray<Fact<typeof PlanLine>>
	readonly allocations: ReadonlyArray<Fact<typeof Allocation>>
}

export const refund = (refunds: ReadonlyArray<Fact<typeof Refund>>) =>
	ChangeSet.empty(Platform).insert(Refund, refunds)

/** The workload the platform's migrations are generated with: every read, and the writes whose query members read. */
const platformPrograms = {
	eventCost,
	quote,
	ratesAt,
	rateHistory,
	repricedInMonth,
	spendByDay,
	spendByMonth,
	workspaceMonth,
	nearCap,
	topModels,
	topProviders,
	marginByProvider,
	consolidatedSpend,
	balanceAt,
	expiringGrants,
	burnDown,
	keyCard,
	usageLog,
	idleKeys,
	rollupVersusLive,
	invoices,
	invoiceAt,
	overdueInvoices,
	invoicePreview,
	refundable,
	refundsByReason,
	mostRefunded,
	segmentsAt,
	prorationFor,
	mrrAt,
	recognizedIn,
	allocationBreakdown,
	payInvoice,
	disputeInvoice,
	voidInvoice,
	setCaps
} as const
export const platformWorkload = workload(Billing, platformPrograms)
