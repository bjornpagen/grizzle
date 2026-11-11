import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec, Result } from "effect"
import type { TestContext } from "vitest"
/**
 * The platform's plans at volume: every workload read is planned through an index, and law maintenance never scans the
 * relation it counts.
 *
 * The file runs with the cluster to itself (`.exclusive`, vitest.network.config.ts): its load at volume holds SERIALIZABLE
 * transactions for tens of seconds (100,000-fact load batches and DailySpend's refresh, 20 to 59 s each in a sampled
 * default-tier run), and SSI retains every transaction that commits meanwhile, which summarizes other files' own.
 *
 * The platform installs with its workload's access paths, as its first migration drafts them, beside an org tenant's
 * login (tenantOf), and loads a volume platform (test/support/platform/generate.ts volumePlatform) through the
 * workload's load in batches within the input limit, then VACUUM ANALYZE. Its sizes: a thousand organizations under resellers, five
 * thousand workspaces with ten thousand keys, ten models on four providers repriced monthly, six months of calendar, and
 * 100,000 usage events (about half a million usage facts). Each case draws, per read, which of the platform's entities
 * and windows it reads (the busiest workspace, key, organization and grant, or another), runs every workload read as a
 * served member through a counting executor twice (test/support/plans.ts recordingMembers): as billing, whose whole
 * entries are plain views, and as the tenant, its Db opened with a token naming the drawn organization, the read written
 * over the tenant's own entries (tenantOf), so it goes through the tenant's security-barrier views of its own
 * organization over relations under row-level security; and EXPLAINs each statement the runtime sent with its
 * parameters:
 *
 * - a read is one statement, its rows and each attachment it declares, at every depth, parts of it (lower/shapes/index.ts
 *   OptimizedDelivery optimizedProgram);
 * - served: planned with sequential and index scans disabled, so that a bitmap scan, which reads only by an index
 *   condition, is the one scan left, every scan of a relation a statement restricts reads by an index condition on an
 *   index the installation planned (test/support/plans.ts);
 * - chosen at volume: no free plan scans a relation of more than 20,000 rows, neither sequentially nor as a nested
 *   loop's inner side without an index condition; over a smaller relation, the rate cards' few pages above all, the
 *   scan is the planner's choice;
 * - exactly the read named below deduplicates (DISTINCT), the one whose rows repeat;
 * - every index the installation created is read by some workload read's free plan here or by a law's maintenance below.
 *
 * Law maintenance runs as the triggers and native constraints fire on writes, read from the transaction's own
 * statistics (pg_stat_xact_user_tables and each index's pg_stat_get_xact_numscans) in one rolled-back transaction per
 * write, planned with sequential scans disabled (runLawWrite): a usage event with its charges and a debit, a refund, a
 * month closed with a plan line and its allocations, an invoice paid, a key revoked with its span cut, and a delete of
 * each relation another references (organizations, months, models, providers, routes, subscriptions, plan lines,
 * workspaces, grants, usage charges), whose reverse checks probe the referencing relations. No such write scans a
 * relation its laws count sequentially, and the indexes they read count as used. A refused write stops at its first
 * refusing law, so every law's probe is also EXPLAINed as the index engine states it, generically, with sequential and
 * bitmap scans disabled: PostgreSQL itself judges whether the installation serves it, and it must read through an index
 * scan with an index condition on an index the installation planned (the one the engine merged it into, or another
 * PostgreSQL finds cheaper), which counts as used. The engine's own serving rule is never consulted: a copy of it would
 * agree with it.
 */
import { parsePlanTree, planNodes } from "#bench/harness/explain.ts"
import { appendAll } from "#compiler/core/array.ts"
import type { Json } from "#compiler/core/canonical.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { ALLEN } from "#compiler/public/allen.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg, type Uuid, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { type AnyLoginRole, context, login, role } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import {
	loadPlatform,
	type OpenedPlatform,
	openPlatformWith
} from "#test/pg/e2e-platform/support.ts"
import { directSql, literal } from "#test/schedules/platform/support.ts"
import { assert } from "#test/support/assert.ts"
import { compileTemplate, programAsts, testCompile } from "#test/support/compile.ts"
import * as P from "#test/support/fixtures/api/platform.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { has, shapeOf } from "#test/support/kernel/shape.ts"
import { caseHang } from "#test/support/limits.ts"
import { messageOf } from "#test/support/message.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"
import {
	plannedIndexes,
	recordingMembers,
	relationRows,
	sentProblems
} from "#test/support/plans.ts"
import {
	buildPlatform,
	DAY,
	loadOrder,
	type Platform,
	settleRequests,
	uid,
	type VolumeSizes,
	viewOf,
	volumePlatform
} from "#test/support/platform/generate.ts"
import type { DirectStatement, RelationName } from "#test/support/platform/laws.ts"
import { platformSpan } from "#test/support/platform/model.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const volume = (events: number): VolumeSizes => ({
	months: 6,
	orgs: 1000,
	workspacesPerOrg: 5,
	keysPerWorkspace: 2,
	models: 10,
	providers: 4,
	events,
	grantsPerOrg: 3
})

/**
 * The reads whose statements deduplicate (DISTINCT), each with why. Every other read is unique by a key the compiler
 * proves, and deduplicates nothing: eventCost by RateCard's span key (model, kind, during), at most one card in force
 * per model and kind at the event's instant, so (kind, tier) is unique per event; invoicePreview's nested statements,
 * each line's usage and plan detail, by the detail's primary key on `line`, the line's id the parent column correlates.
 * - repricedInMonth: the card that starts inside the month is existential, one (event, kind) per such card.
 */
const deduplicating: ReadonlyArray<ReadName> = ["repricedInMonth"]

const unit = (t: bigint) => ({ start: P.Instant(t), end: P.Instant(t + 1n) })

/** The platform's workload reads, by name, as billing runs them: the fixture's own, over the platform. */
const billingReads = {
	eventCost: P.eventCost,
	quote: P.quote,
	ratesAt: P.ratesAt,
	rateHistory: P.rateHistory,
	repricedInMonth: P.repricedInMonth,
	spendByDay: P.spendByDay,
	spendByMonth: P.spendByMonth,
	workspaceMonth: P.workspaceMonth,
	nearCap: P.nearCap,
	topModels: P.topModels,
	topProviders: P.topProviders,
	marginByProvider: P.marginByProvider,
	consolidatedSpend: P.consolidatedSpend,
	balanceAt: P.balanceAt,
	expiringGrants: P.expiringGrants,
	burnDown: P.burnDown,
	keyCard: P.keyCard,
	usageLog: P.usageLog,
	idleKeys: P.idleKeys,
	rollupVersusLive: P.rollupVersusLive,
	invoices: P.invoices,
	invoiceAt: P.invoiceAt,
	overdueInvoices: P.overdueInvoices,
	invoicePreview: P.invoicePreview,
	refundable: P.refundable,
	refundsByReason: P.refundsByReason,
	mostRefunded: P.mostRefunded,
	segmentsAt: P.segmentsAt,
	prorationFor: P.prorationFor,
	mrrAt: P.mrrAt,
	recognizedIn: P.recognizedIn,
	allocationBreakdown: P.allocationBreakdown
} as const

type ReadName = keyof typeof billingReads

/** The platform's workload reads as one role runs them, by name: billing's, or the tenant's. */
type Reads = { readonly [K in ReadName]: unknown }

/**
 * The platform's org tenant over `world`, the platform built under a name (P.platformAt): a token's Tenant claim names one
 * organization, and the tenant reads every relation of it through a query entry its claim filters, each keeping the
 * relation's name and every field, along the relation's path to the organization: its workspaces, their keys and
 * the keys' usage, charges, costs, debits and limits, its grants, invoices with their lines, payments and refunds, and
 * its subscriptions with their segments, beside the catalogue every organization reads whole (rosters, providers,
 * models, routes, prices, rate cards, days and months). It writes its workspaces, keys and revocations through those
 * entries, so each of those relations is under row-level security.
 *
 * Its reads are the platform's workload reads written over the tenant by one rule: each is the fixture's read with
 * query(tenant) for query(Platform) and query(Billing), and every relation it matches, binds or negates the tenant's
 * relation of that name (`own`), its parameters typed by the base's fields, which the entries keep. An arm delivery is
 * the Option of the same child: a role keeps the base's laws only among its whole entries (types/schema/world.ts), so
 * the tenant's query entries keep no alternatives law to prove an arm, and the child, keyed by its parent's key, is at
 * most one per parent. A delivery is the decoder's, so the child's statement is the one it was.
 */
const tenantOf = (world: ReturnType<typeof P.platformAt>) => {
	const billing = world.Billing
	const Tenant = context("Tenant", { org: uuid })
	const { Org, ParentOrg, Workspace, ApiKey, Revocation, ApiKeyActive, UsageEvent, UsageCharge } = P
	const { EventCharge, ProviderCost, CreditGrant, CreditDebit, WorkspaceLimit, Invoice } = P
	const { InvoiceLine, UsageLine, PlanLine, Payment, Voiding, Dispute, Refund } = P
	const { Subscription, Segment, Allocation } = P
	const { DailySpend } = billing.relations
	const orgsEntry = query(billing).rule((r) => {
		const { id } = v(Org, "org")
		return r.match(Org, { id }).match(Tenant, { org: id }).find({ id })
	})
	const parentsEntry = query(billing).rule((r) => {
		const { child, parent } = v(ParentOrg, "parentOrg")
		return r
			.match(ParentOrg, { child, parent })
			.match(Tenant, { org: child })
			.find({ child, parent })
	})
	const workspacesEntry = query(billing).rule((r) => {
		const { id, org } = v(Workspace, "workspace")
		return r.match(Workspace, { id, org }).match(Tenant, { org }).find({ id, org })
	})
	const keysEntry = query(billing).rule((r) => {
		const { id, workspace, state } = v(ApiKey, "apiKey")
		const { org } = v(Workspace, "workspace")
		return r
			.match(ApiKey, { id, workspace, state })
			.match(Workspace, { id: workspace, org })
			.match(Tenant, { org })
			.find({ id, workspace, state })
	})
	const revocationsEntry = query(billing).rule((r) => {
		const { key, at } = v(Revocation, "revocation")
		const { workspace } = v(ApiKey, "apiKey")
		const { org } = v(Workspace, "workspace")
		return r
			.match(Revocation, { key, at })
			.match(ApiKey, { id: key, workspace })
			.match(Workspace, { id: workspace, org })
			.match(Tenant, { org })
			.find({ key, at })
	})
	const activeEntry = query(billing).rule((r) => {
		const { key, during } = v(ApiKeyActive, "apiKeyActive")
		const { workspace } = v(ApiKey, "apiKey")
		const { org } = v(Workspace, "workspace")
		return r
			.match(ApiKeyActive, { key, during })
			.match(ApiKey, { id: key, workspace })
			.match(Workspace, { id: workspace, org })
			.match(Tenant, { org })
			.find({ key, during })
	})
	const eventsEntry = query(billing).rule((r) => {
		const { id, key, model, provider, during } = v(UsageEvent, "usageEvent")
		const { workspace } = v(ApiKey, "apiKey")
		const { org } = v(Workspace, "workspace")
		return r
			.match(UsageEvent, { id, key, model, provider, during })
			.match(ApiKey, { id: key, workspace })
			.match(Workspace, { id: workspace, org })
			.match(Tenant, { org })
			.find({ id, key, model, provider, during })
	})
	const usageChargesEntry = query(billing).rule((r) => {
		const { event, kind, model, priced, tokens, amount, credited, debits, debited } = v(
			UsageCharge,
			"usageCharge"
		)
		const { key } = v(UsageEvent, "usageEvent")
		const { workspace } = v(ApiKey, "apiKey")
		const { org } = v(Workspace, "workspace")
		return r
			.match(UsageCharge, { event, kind, model, priced, tokens, amount, credited, debits, debited })
			.match(UsageEvent, { id: event, key })
			.match(ApiKey, { id: key, workspace })
			.match(Workspace, { id: workspace, org })
			.match(Tenant, { org })
			.find({ event, kind, model, priced, tokens, amount, credited, debits, debited })
	})
	const eventChargesEntry = query(billing).rule((r) => {
		const { event, workspace, month, amount, charges, charged } = v(EventCharge, "eventCharge")
		const { org } = v(Workspace, "workspace")
		return r
			.match(EventCharge, { event, workspace, month, amount, charges, charged })
			.match(Workspace, { id: workspace, org })
			.match(Tenant, { org })
			.find({ event, workspace, month, amount, charges, charged })
	})
	const costsEntry = query(billing).rule((r) => {
		const { event, amount } = v(ProviderCost, "providerCost")
		const { key } = v(UsageEvent, "usageEvent")
		const { workspace } = v(ApiKey, "apiKey")
		const { org } = v(Workspace, "workspace")
		return r
			.match(ProviderCost, { event, amount })
			.match(UsageEvent, { id: event, key })
			.match(ApiKey, { id: key, workspace })
			.match(Workspace, { id: workspace, org })
			.match(Tenant, { org })
			.find({ event, amount })
	})
	const grantsEntry = query(billing).rule((r) => {
		const { id, org, amount, valid, debits, debited } = v(CreditGrant, "creditGrant")
		return r
			.match(CreditGrant, { id, org, amount, valid, debits, debited })
			.match(Tenant, { org })
			.find({ id, org, amount, valid, debits, debited })
	})
	const debitsEntry = query(billing).rule((r) => {
		const { grant, event, kind, amount, during } = v(CreditDebit, "creditDebit")
		const { org } = v(CreditGrant, "creditGrant")
		return r
			.match(CreditDebit, { grant, event, kind, amount, during })
			.match(CreditGrant, { id: grant, org })
			.match(Tenant, { org })
			.find({ grant, event, kind, amount, during })
	})
	const limitsEntry = query(billing).rule((r) => {
		const { workspace, month, cap, charges, spent } = v(WorkspaceLimit, "workspaceLimit")
		const { org } = v(Workspace, "workspace")
		return r
			.match(WorkspaceLimit, { workspace, month, cap, charges, spent })
			.match(Workspace, { id: workspace, org })
			.match(Tenant, { org })
			.find({ workspace, month, cap, charges, spent })
	})
	const invoicesEntry = query(billing).rule((r) => {
		const { id, org, period, amount, state, lines, billed, refunds, refunded } = v(
			Invoice,
			"invoice"
		)
		return r
			.match(Invoice, { id, org, period, amount, state, lines, billed, refunds, refunded })
			.match(Tenant, { org })
			.find({ id, org, period, amount, state, lines, billed, refunds, refunded })
	})
	const linesEntry = query(billing).rule((r) => {
		const { id, invoice, source, amount, allocations, allocated } = v(InvoiceLine, "invoiceLine")
		const { org } = v(Invoice, "invoice")
		return r
			.match(InvoiceLine, { id, invoice, source, amount, allocations, allocated })
			.match(Invoice, { id: invoice, org })
			.match(Tenant, { org })
			.find({ id, invoice, source, amount, allocations, allocated })
	})
	const usageLinesEntry = query(billing).rule((r) => {
		const { line, model, kind, tokens } = v(UsageLine, "usageLine")
		const { invoice } = v(InvoiceLine, "invoiceLine")
		const { org } = v(Invoice, "invoice")
		return r
			.match(UsageLine, { line, model, kind, tokens })
			.match(InvoiceLine, { id: line, invoice })
			.match(Invoice, { id: invoice, org })
			.match(Tenant, { org })
			.find({ line, model, kind, tokens })
	})
	const planLinesEntry = query(billing).rule((r) => {
		const { line, subscription } = v(PlanLine, "planLine")
		const { invoice } = v(InvoiceLine, "invoiceLine")
		const { org } = v(Invoice, "invoice")
		return r
			.match(PlanLine, { line, subscription })
			.match(InvoiceLine, { id: line, invoice })
			.match(Invoice, { id: invoice, org })
			.match(Tenant, { org })
			.find({ line, subscription })
	})
	const paymentsEntry = query(billing).rule((r) => {
		const { invoice, charge } = v(Payment, "payment")
		const { org } = v(Invoice, "invoice")
		return r
			.match(Payment, { invoice, charge })
			.match(Invoice, { id: invoice, org })
			.match(Tenant, { org })
			.find({ invoice, charge })
	})
	const voidingsEntry = query(billing).rule((r) => {
		const { invoice, at } = v(Voiding, "voiding")
		const { org } = v(Invoice, "invoice")
		return r
			.match(Voiding, { invoice, at })
			.match(Invoice, { id: invoice, org })
			.match(Tenant, { org })
			.find({ invoice, at })
	})
	const disputesEntry = query(billing).rule((r) => {
		const { invoice, at } = v(Dispute, "dispute")
		const { org } = v(Invoice, "invoice")
		return r
			.match(Dispute, { invoice, at })
			.match(Invoice, { id: invoice, org })
			.match(Tenant, { org })
			.find({ invoice, at })
	})
	const refundsEntry = query(billing).rule((r) => {
		const { id, invoice, amount, reason, at } = v(Refund, "refund")
		const { org } = v(Invoice, "invoice")
		return r
			.match(Refund, { id, invoice, amount, reason, at })
			.match(Invoice, { id: invoice, org })
			.match(Tenant, { org })
			.find({ id, invoice, amount, reason, at })
	})
	const subscriptionsEntry = query(billing).rule((r) => {
		const { id, org } = v(Subscription, "subscription")
		return r.match(Subscription, { id, org }).match(Tenant, { org }).find({ id, org })
	})
	const segmentsEntry = query(billing).rule((r) => {
		const { subscription, during, monthlyPrice } = v(Segment, "segment")
		const { org } = v(Subscription, "subscription")
		return r
			.match(Segment, { subscription, during, monthlyPrice })
			.match(Subscription, { id: subscription, org })
			.match(Tenant, { org })
			.find({ subscription, during, monthlyPrice })
	})
	const allocationsEntry = query(billing).rule((r) => {
		const { line, subscription, during, amount } = v(Allocation, "allocation")
		const { invoice } = v(InvoiceLine, "invoiceLine")
		const { org } = v(Invoice, "invoice")
		return r
			.match(Allocation, { line, subscription, during, amount })
			.match(InvoiceLine, { id: line, invoice })
			.match(Invoice, { id: invoice, org })
			.match(Tenant, { org })
			.find({ line, subscription, during, amount })
	})
	const spendEntry = query(billing).rule((r) => {
		const { workspace, day, amount } = v(DailySpend, "dailySpend")
		const { org } = v(Workspace, "workspace")
		return r
			.match(DailySpend, { workspace, day, amount })
			.match(Workspace, { id: workspace, org })
			.match(Tenant, { org })
			.find({ workspace, day, amount })
	})
	const whole = billing.relations
	const tenant = role(
		billing,
		"tenant",
		{
			TokenKind: whole.TokenKind,
			KeyState: whole.KeyState,
			InvoiceState: whole.InvoiceState,
			LineSource: whole.LineSource,
			RefundReason: whole.RefundReason,
			Provider: whole.Provider,
			Model: whole.Model,
			Route: whole.Route,
			ProviderPrice: whole.ProviderPrice,
			RateCard: whole.RateCard,
			RateTier: whole.RateTier,
			Day: whole.Day,
			Month: whole.Month,
			Org: orgsEntry,
			ParentOrg: parentsEntry,
			Workspace: workspacesEntry,
			ApiKey: keysEntry,
			Revocation: revocationsEntry,
			ApiKeyActive: activeEntry,
			UsageEvent: eventsEntry,
			UsageCharge: usageChargesEntry,
			EventCharge: eventChargesEntry,
			ProviderCost: costsEntry,
			CreditGrant: grantsEntry,
			CreditDebit: debitsEntry,
			WorkspaceLimit: limitsEntry,
			Invoice: invoicesEntry,
			InvoiceLine: linesEntry,
			UsageLine: usageLinesEntry,
			PlanLine: planLinesEntry,
			Payment: paymentsEntry,
			Voiding: voidingsEntry,
			Dispute: disputesEntry,
			Refund: refundsEntry,
			Subscription: subscriptionsEntry,
			Segment: segmentsEntry,
			Allocation: allocationsEntry,
			DailySpend: spendEntry
		},
		{ write: ["Workspace", "ApiKey", "Revocation"] }
	)
	const own = tenant.relations
	const eventCost = query(tenant).rule((r) => {
		const { model, during } = v(own.UsageEvent, "usageEvent")
		const { kind, tokens } = v(own.UsageCharge, "usageCharge")
		const { id: card, during: inForce } = v(own.RateCard, "rateCard")
		const { tier, rate } = v(own.RateTier, "rateTier")
		const priced = Compute.sub(
			Compute.least(Compute.base(Compute.upper(tier, P.Tokens)), Compute.base(tokens)),
			Compute.base(Compute.lower(tier, P.Tokens))
		)
		return r
			.match(own.UsageEvent, { id: r.param("event", uuid), model, during })
			.match(own.UsageCharge, { event: r.param("event", uuid), kind, tokens })
			.match(own.RateCard, { id: card, model, kind, during: inForce })
			.match(own.RateTier, { card, tier, rate })
			.where(
				r.pointIn(Compute.lower(during, P.Instant), inForce),
				r.lt(Compute.lower(tier, P.Tokens), tokens)
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

	const quote = query(tenant).rule((r) => {
		const usage = r.relation("usage", {
			kind: P.UsageCharge.fields.kind,
			tokens: P.UsageCharge.fields.tokens
		})
		const { kind, tokens } = v(usage, "usage")
		const { id: card, during } = v(own.RateCard, "rateCard")
		const { tier, rate } = v(own.RateTier, "rateTier")
		const priced = Compute.sub(
			Compute.least(Compute.base(Compute.upper(tier, P.Tokens)), Compute.base(tokens)),
			Compute.base(Compute.lower(tier, P.Tokens))
		)
		return r
			.match(usage, { kind, tokens })
			.match(own.RateCard, { id: card, model: r.param("model", uuid), kind, during })
			.match(own.RateTier, { card, tier, rate })
			.where(
				r.allen(during, P.holdsPoint, r.param("now", P.RateCard.fields.during)),
				r.lt(Compute.lower(tier, P.Tokens), tokens)
			)
			.find({
				kind,
				tokens,
				amount: r.sum(
					Compute.div(Compute.add(Compute.mul(priced, Compute.base(rate)), 500_000n), 1_000_000n)
				)
			})
	})

	const ratesAt = query(tenant)
		.rule((r) => {
			const { id, kind, during } = v(own.RateCard, "rateCard")
			return r
				.match(own.RateCard, { id, model: r.param("model", uuid), kind, during })
				.where(r.allen(during, P.holdsPoint, r.param("now", P.RateCard.fields.during)))
				.find({ id, kind, during })
		})
		.attach(
			"tiers",
			(c) =>
				query(tenant).rule((r) => {
					const { tier, rate } = v(own.RateTier, "rateTier")
					return r.match(own.RateTier, { card: c.id, tier, rate }).find({ tier, rate })
				}),
			"array"
		)

	const rateHistory = query(tenant).rule((r) => {
		const { id: before, during: was } = v(own.RateCard, "before")
		const { id: after, during: is } = v(own.RateCard, "after")
		return r
			.match(own.RateCard, {
				id: before,
				model: r.param("model", uuid),
				kind: r.param("kind", P.RateCard.fields.kind),
				during: was
			})
			.match(own.RateCard, {
				id: after,
				model: r.param("model", uuid),
				kind: r.param("kind", P.RateCard.fields.kind),
				during: is
			})
			.where(r.allen(was, ALLEN.meets, is))
			.find({ before, after, at: Compute.upper(was, P.Instant) })
	})

	const repricedInMonth = query(tenant).rule((r) => {
		const { event } = v(own.EventCharge, "eventCharge")
		const { model, during } = v(own.UsageEvent, "usageEvent")
		const { kind } = v(own.UsageCharge, "usageCharge")
		const { during: month } = v(own.Month, "month")
		const { during: card } = v(own.RateCard, "rateCard")
		return r
			.match(own.EventCharge, {
				event,
				workspace: r.param("workspace", uuid),
				month: r.param("month", P.MonthNo)
			})
			.match(own.Month, { month: r.param("month", P.MonthNo), during: month })
			.match(own.UsageEvent, { id: event, model, during })
			.match(own.UsageCharge, { event, kind })
			.match(own.RateCard, { model, kind, during: card })
			.where(
				r.pointIn(Compute.lower(card, P.Instant), month),
				r.gt(Compute.lower(card, P.Instant), Compute.lower(month, P.Instant))
			)
			.find({ event, kind })
	})

	const spendByDay = query(tenant).rule((r) => {
		const { event, amount } = v(own.EventCharge, "eventCharge")
		const { during } = v(own.UsageEvent, "usageEvent")
		const { day, during: span } = v(own.Day, "day")
		return r
			.match(own.EventCharge, { event, workspace: r.param("workspace", uuid), amount })
			.match(own.UsageEvent, { id: event, during })
			.match(own.Day, { day, during: span })
			.where(
				r.pointIn(Compute.lower(during, P.Instant), span),
				r.allen(span, P.insideOf, r.param("window", P.Day.fields.during))
			)
			.find({ day, spend: r.sum(amount) })
	})

	const spendByMonth = query(tenant).rule((r) => {
		const { event, month, amount } = v(own.EventCharge, "eventCharge")
		return r
			.match(own.EventCharge, { event, workspace: r.param("workspace", uuid), month, amount })
			.find({ month, spend: r.sum(amount) })
	})

	const workspaceMonth = query(tenant).rule((r) => {
		const { event, amount } = v(own.EventCharge, "eventCharge")
		return r
			.match(own.EventCharge, {
				event,
				workspace: r.param("workspace", uuid),
				month: r.param("month", P.MonthNo),
				amount
			})
			.find({ events: r.count(), spend: r.sum(amount) })
	})

	const monthSpend = query(tenant).rule((r) => {
		const { event, workspace, month, amount } = v(own.EventCharge, "eventCharge")
		return r
			.match(own.EventCharge, { event, workspace, month, amount })
			.find({ workspace, month, spend: r.sum(amount) })
	})

	const nearCap = query(tenant).rule((r) => {
		const { id: workspace } = v(own.Workspace, "workspace")
		const { spend } = v(monthSpend, "monthSpend")
		const { cap } = v(own.WorkspaceLimit, "workspaceLimit")
		return r
			.match(own.Workspace, { id: workspace, org: r.param("org", uuid) })
			.match(monthSpend, { workspace, month: r.param("month", P.MonthNo), spend })
			.match(own.WorkspaceLimit, { workspace, month: r.param("month", P.MonthNo), cap })
			.where(r.ge(Compute.mul(spend, 10n), Compute.mul(Compute.numeric(Compute.base(cap)), 9n)))
			.find({ workspace, spend, cap })
	})

	const topModels = query(tenant)
		.rule((r) => {
			const { event, amount } = v(own.EventCharge, "eventCharge")
			const { model } = v(own.UsageEvent, "usageEvent")
			return r
				.match(own.EventCharge, {
					event,
					workspace: r.param("workspace", uuid),
					month: r.param("month", P.MonthNo),
					amount
				})
				.match(own.UsageEvent, { id: event, model })
				.find({ model, spend: r.sum(amount) })
		})
		.orderBy(["spend", "desc"], ["model", "asc"])
		.take("k")

	const topProviders = query(tenant)
		.rule((r) => {
			const { id: workspace } = v(own.Workspace, "workspace")
			const { event, amount } = v(own.EventCharge, "eventCharge")
			const { provider } = v(own.UsageEvent, "usageEvent")
			return r
				.match(own.Workspace, { id: workspace, org: r.param("org", uuid) })
				.match(own.EventCharge, { event, workspace, month: r.param("month", P.MonthNo), amount })
				.match(own.UsageEvent, { id: event, provider })
				.find({ provider, spend: r.sum(amount) })
		})
		.orderBy(["spend", "desc"], ["provider", "asc"])
		.take("k")

	const marginByProvider = query(tenant).rule((r) => {
		const { id: workspace } = v(own.Workspace, "workspace")
		const { event, amount } = v(own.EventCharge, "eventCharge")
		const { provider } = v(own.UsageEvent, "usageEvent")
		const { amount: cost } = v(own.ProviderCost, "providerCost")
		return r
			.match(own.Workspace, { id: workspace, org: r.param("org", uuid) })
			.match(own.EventCharge, { event, workspace, month: r.param("month", P.MonthNo), amount })
			.match(own.UsageEvent, { id: event, provider })
			.match(own.ProviderCost, { event, amount: cost })
			.find({ provider, billed: r.sum(amount), cost: r.sum(cost) })
	})

	const Descendants = query(tenant).recursive("Descendants", {
		row: { org: uuid },
		base: [
			(r) => {
				const { id } = v(own.Org, "org")
				return r
					.match(own.Org, { id })
					.where(r.eq(id, r.param("root", uuid)))
					.find({ org: id })
			}
		],
		rec: [
			(r, self) => {
				const { org } = v(self, "self")
				const { child } = v(own.ParentOrg, "parentOrg")
				return r
					.match(self, { org })
					.match(own.ParentOrg, { child, parent: org })
					.find({ org: child })
			}
		]
	})

	const consolidatedSpend = query(tenant).rule((r) => {
		const tree = Descendants.bind({ root: r.param("root", uuid) })
		const { org } = v(tree, "tree")
		const { id: workspace } = v(own.Workspace, "workspace")
		const { event, amount } = v(own.EventCharge, "eventCharge")
		return r
			.match(tree, { org })
			.match(own.Workspace, { id: workspace, org })
			.match(own.EventCharge, { event, workspace, month: r.param("month", P.MonthNo), amount })
			.find({ org, spend: r.sum(amount) })
	})

	const balanceAt = query(tenant)
		.rule((r) => {
			const { id, amount, valid } = v(own.CreditGrant, "creditGrant")
			return r
				.match(own.CreditGrant, { id, org: r.param("org", uuid), amount, valid })
				.where(r.allen(valid, P.holdsPoint, r.param("now", P.CreditGrant.fields.valid)))
				.find({ id, amount, valid })
		})
		.attach(
			"debited",
			(g) =>
				query(tenant).rule((r) => {
					const { event, kind, amount } = v(own.CreditDebit, "creditDebit")
					return r
						.match(own.CreditDebit, { grant: g.id, event, kind, amount })
						.find({ total: r.sum(amount) })
				}),
			"option"
		)

	const expiringGrants = query(tenant).rule((r) => {
		const { id, amount, valid } = v(own.CreditGrant, "creditGrant")
		return r
			.match(own.CreditGrant, { id, org: r.param("org", uuid), amount, valid })
			.where(
				r.pointIn(Compute.upper(valid, P.Instant), r.param("window", P.CreditGrant.fields.valid))
			)
			.find({ id, amount, valid })
	})

	const burnDown = query(tenant).rule((r) => {
		const { event, kind, amount, during } = v(own.CreditDebit, "creditDebit")
		const { day, during: span } = v(own.Day, "day")
		return r
			.match(own.CreditDebit, { grant: r.param("grant", uuid), event, kind, amount, during })
			.match(own.Day, { day, during: span })
			.where(r.pointIn(Compute.lower(during, P.Instant), span))
			.find({ day, debited: r.sum(amount) })
	})

	const keyCard = query(tenant)
		.rule((r) => {
			const { id, workspace, state } = v(own.ApiKey, "apiKey")
			return r
				.match(own.ApiKey, { id, workspace, state })
				.where(r.eq(id, r.param("key", uuid)))
				.find({ id, workspace, state })
		})
		.attach(
			"active",
			(k) =>
				query(tenant).rule((r) => {
					const { during } = v(own.ApiKeyActive, "apiKeyActive")
					return r.match(own.ApiKeyActive, { key: k.id, during }).find({ during })
				}),
			"array"
		)
		.attach(
			"revocation",
			(k) =>
				query(tenant).rule((r) => {
					const { at } = v(own.Revocation, "revocation")
					return r.match(own.Revocation, { key: k.id, at }).find({ at })
				}),
			"option"
		)

	const usageLog = query(tenant)
		.rule((r) => {
			const { id, model, provider, during } = v(own.UsageEvent, "usageEvent")
			return r
				.match(own.UsageEvent, { id, key: r.param("key", uuid), model, provider, during })
				.find({ id, model, provider, during, start: Compute.lower(during, P.Instant) })
		})
		.orderBy(["start", "desc"], ["id", "asc"])

	const keysUsedIn = query(tenant).rule((r) => {
		const { key, during } = v(own.UsageEvent, "usageEvent")
		return r
			.match(own.UsageEvent, { key, during })
			.where(r.allen(during, ALLEN.intersects, r.param("window", P.UsageEvent.fields.during)))
			.find({ key })
	})

	const idleKeys = query(tenant).rule((r) => {
		const { id } = v(own.ApiKey, "apiKey")
		return r
			.match(own.ApiKey, { id, workspace: r.param("workspace", uuid), state: "active" })
			.where(
				r.not(keysUsedIn.bind({ window: r.param("window", P.UsageEvent.fields.during) }), {
					key: id
				})
			)
			.find({ key: id })
	})

	const rollupVersusLive = query(tenant)
		.rule((r) => {
			const { workspace, day, amount } = v(own.DailySpend, "dailySpend")
			const { during } = v(own.Day, "day")
			return r
				.match(own.DailySpend, { workspace, day, amount })
				.match(own.Day, { day, during })
				.where(
					r.eq(workspace, r.param("workspace", uuid)),
					r.allen(during, P.insideOf, r.param("window", P.Day.fields.during))
				)
				.find({ workspace, day, rolled: amount })
		})
		.attach(
			"live",
			(d) =>
				query(tenant).rule((r) => {
					const { event, amount } = v(own.EventCharge, "eventCharge")
					const { during } = v(own.UsageEvent, "usageEvent")
					const { during: span } = v(own.Day, "day")
					return r
						.match(own.EventCharge, { event, workspace: d.workspace, amount })
						.match(own.UsageEvent, { id: event, during })
						.match(own.Day, { day: d.day, during: span })
						.where(r.pointIn(Compute.lower(during, P.Instant), span))
						.find({ total: r.sum(amount) })
				}),
			"option"
		)

	const invoices = query(tenant)
		.rule((r) => {
			const { id, period, amount, state } = v(own.Invoice, "invoice")
			return r
				.match(own.Invoice, { id, org: r.param("org", uuid), period, amount, state })
				.find({ id, period, amount, state, start: Compute.lower(period, P.Instant) })
		})
		.orderBy(["start", "desc"], ["id", "asc"])

	const invoiceAt = query(tenant).rule((r) => {
		const { id, period, amount, state } = v(own.Invoice, "invoice")
		return r
			.match(own.Invoice, { id, org: r.param("org", uuid), period, amount, state })
			.where(r.allen(period, P.holdsPoint, r.param("now", P.Invoice.fields.period)))
			.find({ id, period, amount, state })
	})

	const overdueInvoices = query(tenant).rule((r) => {
		const { id, period, amount } = v(own.Invoice, "invoice")
		return r
			.match(own.Invoice, { id, org: r.param("org", uuid), period, amount, state: "open" })
			.where(r.le(Compute.upper(period, P.Instant), r.param("cutoff", P.Instant)))
			.find({ id, period, amount })
	})

	const invoicePreview = query(tenant)
		.rule((r) => {
			const { id, org, period, amount, state } = v(own.Invoice, "invoice")
			return r
				.match(own.Invoice, { id, org, period, amount, state })
				.where(r.eq(id, r.param("invoice", uuid)))
				.find({ id, org, period, amount, state })
		})
		.attach(
			"lines",
			(i) =>
				query(tenant)
					.rule((r) => {
						const { id, source, amount } = v(own.InvoiceLine, "invoiceLine")
						return r
							.match(own.InvoiceLine, { id, invoice: i.id, source, amount })
							.find({ id, source, amount })
					})
					.attach(
						"usage",
						(l) =>
							query(tenant).rule((r) => {
								const { model, kind, tokens } = v(own.UsageLine, "usageLine")
								return r
									.match(own.UsageLine, { line: l.id, model, kind, tokens })
									.find({ model, kind, tokens })
							}),
						"option"
					)
					.attach(
						"plan",
						(l) =>
							query(tenant).rule((r) => {
								const { subscription } = v(own.PlanLine, "planLine")
								return r.match(own.PlanLine, { line: l.id, subscription }).find({ subscription })
							}),
						"option"
					),
			"array"
		)
		.attach(
			"refunds",
			(i) =>
				query(tenant).rule((r) => {
					const { id, amount, reason, at } = v(own.Refund, "refund")
					return r
						.match(own.Refund, { id, invoice: i.id, amount, reason, at })
						.find({ id, amount, reason, at })
				}),
			"array"
		)
		.attach(
			"payment",
			(i) =>
				query(tenant).rule((r) => {
					const { charge } = v(own.Payment, "payment")
					return r.match(own.Payment, { invoice: i.id, charge }).find({ charge })
				}),
			"option"
		)
		.attach(
			"dispute",
			(i) =>
				query(tenant).rule((r) => {
					const { at } = v(own.Dispute, "dispute")
					return r.match(own.Dispute, { invoice: i.id, at }).find({ at })
				}),
			"option"
		)

	const refundable = query(tenant)
		.rule((r) => {
			const { id, amount } = v(own.Invoice, "invoice")
			const { id: refund, amount: refunded } = v(own.Refund, "refund")
			return r
				.match(own.Invoice, { id, org: r.param("org", uuid), amount, state: "paid" })
				.match(own.Refund, { id: refund, invoice: id, amount: refunded })
				.find({ invoice: id, amount, refunded: r.sum(refunded) })
		})
		.rule((r) => {
			const { id, amount } = v(own.Invoice, "invoice")
			return r
				.match(own.Invoice, { id, org: r.param("org", uuid), amount, state: "paid" })
				.where(r.not(own.Refund, { invoice: id }))
				.find({ invoice: id, amount, refunded: Compute.literal(pg.numeric(1, 0), 0n) })
		})

	const refundsByReason = query(tenant).rule((r) => {
		const { id, invoice, amount, reason, at } = v(own.Refund, "refund")
		return r
			.match(own.Invoice, { id: invoice, org: r.param("org", uuid) })
			.match(own.Refund, { id, invoice, amount, reason, at })
			.where(r.pointIn(at, r.param("window", P.Invoice.fields.period)))
			.find({ reason, refunds: r.count(), refunded: r.sum(amount) })
	})

	const mostRefunded = query(tenant)
		.rule((r) => {
			const { id, invoice, amount } = v(own.Refund, "refund")
			const { org } = v(own.Invoice, "invoice")
			return r
				.match(own.Refund, { id, invoice, amount })
				.match(own.Invoice, { id: invoice, org })
				.find({ org, refunded: r.sum(amount) })
		})
		.orderBy(["refunded", "desc"], ["org", "asc"])
		.take("k")

	const segmentsAt = query(tenant).rule((r) => {
		const { during, monthlyPrice } = v(own.Segment, "segment")
		return r
			.match(own.Segment, { subscription: r.param("subscription", uuid), during, monthlyPrice })
			.where(r.allen(during, P.holdsPoint, r.param("now", P.Segment.fields.during)))
			.find({ during, monthlyPrice })
	})

	const prorationFor = query(tenant).rule((r) => {
		const { org, period } = v(own.Invoice, "invoice")
		const { id: subscription } = v(own.Subscription, "subscription")
		const { during, monthlyPrice } = v(own.Segment, "segment")
		const overlap = Compute.sub(
			Compute.least(
				Compute.base(Compute.upper(during, P.Instant)),
				Compute.base(Compute.upper(period, P.Instant))
			),
			Compute.greatest(
				Compute.base(Compute.lower(during, P.Instant)),
				Compute.base(Compute.lower(period, P.Instant))
			)
		)
		return r
			.match(own.Invoice, { id: r.param("invoice", uuid), org, period })
			.match(own.Subscription, { id: subscription, org })
			.match(own.Segment, { subscription, during, monthlyPrice })
			.where(r.allen(during, ALLEN.intersects, period))
			.find({
				subscription,
				during,
				overlap,
				prorated: Compute.round(
					Compute.when(
						Compute.nonzero(Compute.numeric(Compute.base(Compute.width(period, P.Instant)))),
						(width) =>
							Compute.div(
								Compute.mul(Compute.numeric(Compute.base(monthlyPrice)), Compute.numeric(overlap)),
								width
							),
						0n
					)
				)
			})
	})

	const mrrAt = query(tenant).rule((r) => {
		const { id } = v(own.Subscription, "subscription")
		const { during, monthlyPrice } = v(own.Segment, "segment")
		return r
			.match(own.Subscription, { id, org: r.param("org", uuid) })
			.match(own.Segment, { subscription: id, during, monthlyPrice })
			.where(r.allen(during, P.holdsPoint, r.param("now", P.Segment.fields.during)))
			.find({ mrr: r.sum(monthlyPrice) })
	})

	const recognizedIn = query(tenant).rule((r) => {
		const { id: subscription } = v(own.Subscription, "subscription")
		const { line, during, amount } = v(own.Allocation, "allocation")
		const { during: month } = v(own.Month, "month")
		const overlap = Compute.sub(
			Compute.least(
				Compute.base(Compute.upper(during, P.Instant)),
				Compute.base(Compute.upper(month, P.Instant))
			),
			Compute.greatest(
				Compute.base(Compute.lower(during, P.Instant)),
				Compute.base(Compute.lower(month, P.Instant))
			)
		)
		return r
			.match(own.Subscription, { id: subscription, org: r.param("org", uuid) })
			.match(own.Month, { month: r.param("month", P.MonthNo), during: month })
			.match(own.Allocation, { line, subscription, during, amount })
			.where(r.allen(during, ALLEN.intersects, month))
			.find({
				line,
				during,
				recognized: Compute.round(
					Compute.when(
						Compute.nonzero(Compute.numeric(Compute.base(Compute.width(during, P.Instant)))),
						(width) =>
							Compute.div(
								Compute.mul(Compute.numeric(Compute.base(amount)), Compute.numeric(overlap)),
								width
							),
						0n
					)
				)
			})
	})

	const allocationBreakdown = query(tenant)
		.rule((r) => {
			const { id, amount } = v(own.InvoiceLine, "invoiceLine")
			const { subscription } = v(own.PlanLine, "planLine")
			return r
				.match(own.InvoiceLine, { id, invoice: r.param("invoice", uuid), source: "plan", amount })
				.match(own.PlanLine, { line: id, subscription })
				.find({ id, subscription, amount })
		})
		.attach(
			"allocations",
			(l) =>
				query(tenant).rule((r) => {
					const { during, amount } = v(own.Allocation, "allocation")
					return r.match(own.Allocation, { line: l.id, during, amount }).find({ during, amount })
				}),
			"array"
		)
	const reads: Reads = {
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
		allocationBreakdown
	}
	return { tenants: login(billing, "tenants", [tenant]), reads }
}

/** The entities a read is asked about, busiest first: what each pick chooses among. */
interface Entities {
	readonly workspaces: ReadonlyArray<Uuid>
	readonly orgs: ReadonlyArray<Uuid>
	readonly keys: ReadonlyArray<Uuid>
	readonly events: ReadonlyArray<Uuid>
	readonly models: ReadonlyArray<Uuid>
	readonly grants: ReadonlyArray<Uuid>
	readonly invoices: ReadonlyArray<Uuid>
	readonly subscriptions: ReadonlyArray<Uuid>
	readonly months: ReadonlyArray<{
		readonly month: number
		readonly start: bigint
		readonly end: bigint
	}>
}

const busiest = <A, K extends string>(
	rows: ReadonlyArray<A>,
	by: (a: A) => K
): ReadonlyArray<K> => {
	const count = new Map<K, number>()
	for (const r of rows) {
		count.set(by(r), (count.get(by(r)) ?? 0) + 1)
	}
	return Arr.map(
		Arr.sort(
			[...count],
			Order.combine(
				Order.mapInput(Order.flip(Order.Number), ([, n]: readonly [K, number]) => n),
				Order.mapInput(Order.String, ([k]: readonly [K, number]) => k)
			)
		),
		([k]) => k
	)
}

const entitiesOf = (p: Platform): Entities => ({
	workspaces: busiest(p.facts.EventCharge, (e) => e.workspace),
	orgs: busiest(p.facts.Invoice, (i) => i.org),
	keys: busiest(p.facts.UsageEvent, (e) => e.key),
	events: Arr.map(p.facts.UsageEvent, (e) => e.id),
	models: busiest(p.facts.UsageEvent, (e) => e.model),
	grants: busiest(p.facts.CreditDebit, (d) => d.grant),
	invoices: busiest(p.facts.Refund, (r) => r.invoice),
	subscriptions: Arr.map(p.facts.Subscription, (s) => s.id),
	months: Arr.map(p.plan.months, (m) => ({
		month: m.month,
		start: m.during.start,
		end: m.during.end
	}))
})

/** One of `values`, the busiest a third of the time and otherwise spread over the rest. */
const pickOf = <A>(values: ReadonlyArray<A>, pick: number, absent: A): A =>
	values[pickIndex(pick, 3) === 0 ? 0 : pickIndex(pick, Math.max(1, values.length))] ?? absent

/** A workload read asked about by name, with its parameters, which each role runs as its own read of that name. */
interface Probe {
	readonly name: ReadName
	readonly params: ParamMap
}

/** Every workload read with its parameters for one pick. */
const probes = (e: Entities, pick: number): ReadonlyArray<Probe> => {
	const none = uid(0xdead, 2)
	const workspace = pickOf(e.workspaces, pick, none)
	const org = pickOf(e.orgs, pick, none)
	const key = pickOf(e.keys, pick, none)
	const model = pickOf(e.models, pick, none)
	const m = e.months[pickIndex(pick, e.months.length)] ?? { month: 202601, start: 0n, end: 1n }
	const month = P.MonthNo(m.month)
	/** A week inside the month, or the whole month. */
	const window =
		pickIndex(pick, 2) === 0
			? { start: P.Instant(m.start + 3n * DAY), end: P.Instant(m.start + 10n * DAY) }
			: { start: P.Instant(m.start), end: P.Instant(m.end) }
	const now = unit(m.start + 5n * DAY)
	const invoice = pickOf(e.invoices, pick, none)
	return [
		{ name: "eventCost", params: { event: pickOf(e.events, pick, none) } },
		{
			name: "quote",
			params: {
				model,
				now,
				usage: [
					{ kind: "input", tokens: P.Tokens(1500n) },
					{ kind: "output", tokens: P.Tokens(20n) }
				]
			}
		},
		{ name: "ratesAt", params: { model, now } },
		{ name: "rateHistory", params: { model, kind: "input" } },
		{ name: "repricedInMonth", params: { workspace, month } },
		{ name: "spendByDay", params: { workspace, window } },
		{ name: "spendByMonth", params: { workspace } },
		{ name: "workspaceMonth", params: { workspace, month } },
		{ name: "nearCap", params: { org, month } },
		{ name: "topModels", params: { workspace, month, k: 3 } },
		{ name: "topProviders", params: { org, month, k: 3 } },
		{ name: "marginByProvider", params: { org, month } },
		{
			name: "consolidatedSpend",
			params: { root: pickOf(e.orgs, pick, none), month }
		},
		{ name: "balanceAt", params: { org, now } },
		{ name: "expiringGrants", params: { org, window } },
		{ name: "burnDown", params: { grant: pickOf(e.grants, pick, none) } },
		{ name: "keyCard", params: { key } },
		{ name: "usageLog", params: { key } },
		{ name: "idleKeys", params: { workspace, window } },
		{ name: "rollupVersusLive", params: { workspace, window } },
		{ name: "invoices", params: { org } },
		{ name: "invoiceAt", params: { org, now } },
		{
			name: "overdueInvoices",
			params: { org, cutoff: P.Instant(m.end) }
		},
		{ name: "invoicePreview", params: { invoice } },
		{ name: "refundable", params: { org } },
		{
			name: "refundsByReason",
			params: { org, window: { start: P.Instant(m.start), end: P.Instant(m.end + 40n * DAY) } }
		},
		{ name: "mostRefunded", params: { k: 5 } },
		{
			name: "segmentsAt",
			params: { subscription: pickOf(e.subscriptions, pick, none), now }
		},
		{ name: "prorationFor", params: { invoice } },
		{ name: "mrrAt", params: { org, now } },
		{ name: "recognizedIn", params: { org, month } },
		{ name: "allocationBreakdown", params: { invoice } }
	]
}

/**
 * A law write's statements as the platform's direct writer runs them (test/schedules/platform/support.ts directSql):
 * each fact with every column grizzle's filler writes for it, a member its slot, its owner's count and each fold's
 * accumulators, an owner its counts and ends, a closed id its code, and an owner put in place, its families kept. A
 * statement of no facts states nothing and is no statement: a usage record that no grant paid for has no debits.
 */
const directStatements = (
	o: OpenedPlatform,
	statements: ReadonlyArray<DirectStatement>
): ReadonlyArray<string> =>
	directSql(
		namesOf(o.installed),
		Arr.filter(statements, (st) => st.facts.length > 0)
	)

/**
 * A delete of the facts of `relation` at `where`, each value as its column spells it. A direct writer deletes no member
 * of a family, which only grizzle's planner edits, so these deletes are statements of their own: each one a law
 * refuses, which is what it is written for.
 */
const deletes = (
	o: OpenedPlatform,
	relation: RelationName,
	where: Readonly<Record<string, unknown>>
): string =>
	`DELETE FROM ${o.table(relation)} WHERE ${Arr.join(
		Arr.map(
			Rec.toEntries(where),
			([f, v]) =>
				`${quoteIdent(o.installed.names.column(relation, f))} = ${literal(namesOf(o.installed), relation, f, v)}`
		),
		" AND "
	)}`

/** A write that fires laws, the relations its laws count, and whether the laws must accept it. */
interface LawWrite {
	readonly name: string
	readonly statements: ReadonlyArray<string>
	readonly counted: ReadonlyArray<string>
	readonly accepted: boolean
}

/** A relation, the key values of one of its facts, and the relations a delete of that fact makes its laws read. */
type Referenced = readonly [RelationName, Readonly<Record<string, unknown>>, ReadonlyArray<string>]

/**
 * The writes that fire the platform's laws on the entities a case drew: each lawful write the platform has a place for,
 * then a delete of one referenced fact of each relation that has one, which its containments refuse.
 */
const lawWrites = (o: OpenedPlatform, p: Platform, e: Entities): ReadonlyArray<LawWrite> => {
	const view = viewOf(p.facts)
	const key = Arr.head(e.keys)
	const route = Option.orElse(
		Arr.findFirst(p.facts.Route, (r) =>
			Arr.some(
				p.facts.UsageEvent,
				(u) => Option.exists(key, (k) => k === u.key) && u.model === r.model
			)
		),
		() => Arr.head(p.facts.Route)
	)
	const month = Arr.get(p.plan.months, 2)
	const left = new Map<string, bigint>(Arr.map(p.facts.CreditGrant, (g) => [g.id, g.amount]))
	for (const d of p.facts.CreditDebit) {
		left.set(d.grant, (left.get(d.grant) ?? 0n) - d.amount)
	}
	const spent = new Map<string, bigint>()
	for (const c of p.facts.EventCharge) {
		spent.set(
			`${c.workspace}|${c.month}`,
			(spent.get(`${c.workspace}|${c.month}`) ?? 0n) + c.amount
		)
	}
	const instant = Option.map(month, (m) => m.during.start + 7n * DAY + 11n)
	const record = Option.flatMap(Option.all({ key, route, instant }), (at) =>
		Arr.head(
			settleRequests(
				view,
				[
					{
						id: uid(0x7e57, 1),
						key: at.key,
						model: at.route.model,
						provider: at.route.provider,
						during: platformSpan(at.instant, at.instant + 3n),
						tokens: [{ kind: "input", tokens: 1234n }]
					}
				],
				{ left, spent }
			).records
		)
	)
	/** A paid invoice refunded before, with a micro-dollar left to refund. */
	const paid = Arr.findFirst(p.facts.Invoice, (i) => {
		const refunds = Arr.filter(p.facts.Refund, (r) => r.invoice === i.id)
		return (
			i.state === "paid" &&
			refunds.length > 0 &&
			Arr.reduce(refunds, 0n, (sum, r) => sum + r.amount) < i.amount
		)
	})
	const open = Arr.findFirst(p.facts.Invoice, (i) => i.state === "open")
	const subscription = Arr.head(p.facts.Subscription)
	const lastMonth = Arr.last(p.plan.months)
	const line = uid(0x7e57, 2)
	const invoice = uid(0x7e57, 3)
	const activeKey = Option.flatMap(key, (k) =>
		Arr.findFirst(p.facts.ApiKey, (x) => x.state === "active" && x.id === k)
	)
	const span0 = Option.flatMap(key, (k) => Arr.findFirst(p.facts.ApiKeyActive, (a) => a.key === k))
	const usage = Option.map(record, (r): LawWrite => ({
		name: "a usage event with its charges and debits",
		statements: directStatements(o, [
			{ kind: "insert", relation: "UsageEvent", facts: [r.event] },
			{ kind: "insert", relation: "EventCharge", facts: [r.total] },
			{ kind: "insert", relation: "UsageCharge", facts: r.charges },
			{ kind: "insert", relation: "ProviderCost", facts: [r.cost] },
			{ kind: "insert", relation: "CreditDebit", facts: r.debits }
		]),
		counted: ["UsageCharge", "EventCharge", "CreditDebit", "UsageEvent"],
		accepted: true
	}))
	const refund = Option.map(Option.all({ paid, instant }), (at): LawWrite => ({
		name: "a refund",
		statements: directStatements(o, [
			{
				kind: "insert",
				relation: "Refund",
				facts: [
					{
						id: uid(0x7e57, 4),
						invoice: at.paid.id,
						amount: 1n,
						reason: "requested",
						at: at.instant
					}
				]
			}
		]),
		counted: ["Refund"],
		accepted: true
	}))
	const closing = Option.map(Option.all({ subscription, lastMonth }), (at): LawWrite => {
		const start = Option.match(
			Arr.findFirst(p.facts.Segment, (s) => s.subscription === at.subscription.id),
			{ onNone: () => at.lastMonth.during.start, onSome: (s) => s.during.start }
		)
		const amount = 1000n
		/** The month after the platform's last, which no invoice of the organization's covers. */
		const after = at.lastMonth.during.end
		const period = { start: after, end: after + (after - at.lastMonth.during.start) }
		return {
			name: "a month closed with a plan line and its allocation",
			statements: directStatements(o, [
				{
					kind: "insert",
					relation: "Invoice",
					facts: [{ id: invoice, org: at.subscription.org, period, amount, state: "open" }]
				},
				{
					kind: "insert",
					relation: "InvoiceLine",
					facts: [{ id: line, invoice, source: "plan", amount }]
				},
				{
					kind: "insert",
					relation: "PlanLine",
					facts: [{ line, subscription: at.subscription.id }]
				},
				{
					kind: "insert",
					relation: "Allocation",
					facts: [
						{ line, subscription: at.subscription.id, during: { start, end: start + DAY }, amount }
					]
				}
			]),
			counted: ["InvoiceLine", "Allocation", "PlanLine", "Segment"],
			accepted: true
		}
	})
	const paying = Option.map(open, (i): LawWrite => ({
		name: "an invoice paid",
		statements: directStatements(o, [
			{ kind: "put", relation: "Invoice", facts: [{ ...i, state: "paid" }] },
			{ kind: "insert", relation: "Payment", facts: [{ invoice: i.id, charge: uid(0x7e57, 5) }] }
		]),
		counted: ["Payment", "Refund", "InvoiceLine"],
		accepted: true
	}))
	/** Its usage after the cut is outside every active span, which the coverage law refuses. */
	const revoking = Option.map(Option.all({ activeKey, span0 }), (at): LawWrite => {
		const cut = at.span0.during.start + 10n
		const id = at.activeKey.id
		return {
			name: "a key revoked with its span cut",
			statements: directStatements(o, [
				{ kind: "put", relation: "ApiKey", facts: [{ ...at.activeKey, state: "revoked" }] },
				{ kind: "insert", relation: "Revocation", facts: [{ key: id, at: cut }] },
				{ kind: "delete", relation: "ApiKeyActive", facts: [{ key: id, during: at.span0.during }] },
				{
					kind: "insert",
					relation: "ApiKeyActive",
					facts: [{ key: id, during: { start: at.span0.during.start, end: cut } }]
				}
			]),
			counted: ["UsageEvent", "Revocation"],
			accepted: false
		}
	})
	const referenced: ReadonlyArray<Referenced> = Arr.getSomes([
		Option.map(Arr.head(e.orgs), (id): Referenced => [
			"Org",
			{ id },
			["ParentOrg", "Workspace", "CreditGrant", "Subscription", "Invoice"]
		]),
		Option.map(month, (m): Referenced => ["Month", { month: m.month }, ["Day", "WorkspaceLimit"]]),
		Option.map(Arr.head(e.models), (id): Referenced => [
			"Model",
			{ id },
			["Route", "RateCard", "UsageLine"]
		]),
		Option.map(route, (r): Referenced => ["Provider", { id: r.provider }, ["Route"]]),
		Option.map(route, (r): Referenced => [
			"Route",
			{ model: r.model, provider: r.provider },
			["UsageEvent", "ProviderPrice"]
		]),
		Option.map(subscription, (s): Referenced => [
			"Subscription",
			{ id: s.id },
			["PlanLine", "Segment"]
		]),
		Option.map(Arr.head(p.facts.PlanLine), (l): Referenced => [
			"PlanLine",
			{ line: l.line },
			["Allocation"]
		]),
		Option.map(Arr.head(e.workspaces), (id): Referenced => [
			"Workspace",
			{ id },
			["ApiKey", "EventCharge", "WorkspaceLimit"]
		]),
		Option.map(Arr.head(e.grants), (id): Referenced => ["CreditGrant", { id }, ["CreditDebit"]]),
		Option.map(Arr.head(p.facts.CreditDebit), (d): Referenced => [
			"UsageCharge",
			{ event: d.event, kind: d.kind },
			["CreditDebit"]
		])
	])
	return [
		...Arr.getSomes([usage, refund, closing, paying, revoking]),
		...Arr.map(referenced, ([relation, where, counted]): LawWrite => ({
			name: `a referenced ${relation} deleted`,
			statements: [deletes(o, relation, where)],
			counted,
			accepted: false
		}))
	]
}

/** A row of three text columns, as the transaction statistics are read. */
type XactRow = readonly [string, string, string]

/**
 * Runs a law write in one rolled-back transaction: every deferred law judged at SET CONSTRAINTS ALL IMMEDIATE, then the
 * transaction's statistics read; the outcome is whether the laws accepted it. The transaction plans with sequential
 * scans disabled, so a law's probe reads a relation by an index exactly when one serves it: at the volume's sizes the
 * calendar, the routes, the rate cards and the provider prices are a few pages each, which PostgreSQL rightly reads
 * whole when it may choose, and the property is that an index serves every probe, not the planner's choice on a small
 * relation. The law's plans are made in these transactions alone: no other statement on this connection fires them.
 *
 * A refused write's statistics are read again from a replay with each statement in a savepoint: the counters
 * PostgreSQL keeps per transaction survive into the abort only as pending totals.
 */
const runLawWrite = (o: OpenedPlatform, w: LawWrite) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const begin = Effect.andThen(
			admin.query("BEGIN", []),
			admin.query("SET LOCAL enable_seqscan = off", [])
		)
		yield* begin
		const applied = yield* Effect.result(
			Effect.gen(function* () {
				for (const st of w.statements) {
					yield* admin.query(st, [])
				}
				yield* admin.query("SET CONSTRAINTS ALL IMMEDIATE", [])
			})
		)
		if (Result.isFailure(applied)) {
			yield* admin.query("ROLLBACK", [])
			yield* begin
			for (const st of w.statements) {
				yield* admin.query("SAVEPOINT s", [])
				const one = yield* Effect.result(
					Effect.andThen(admin.query(st, []), admin.query("SET CONSTRAINTS ALL IMMEDIATE", []))
				)
				yield* admin.query(
					Result.isFailure(one) ? "ROLLBACK TO SAVEPOINT s" : "RELEASE SAVEPOINT s",
					[]
				)
			}
		}
		const tableRows = yield* admin.queryValues(
			"SELECT relname::text, seq_scan::text, idx_scan::text FROM pg_catalog.pg_stat_xact_user_tables WHERE schemaname = $1::text",
			[o.installed.schema]
		)
		const tables = trusted<ReadonlyArray<XactRow>>(tableRows)
		/**
		 * PostgreSQL has no per-transaction view of index statistics: an index's scans in this transaction are
		 * pg_stat_get_xact_numscans of the index, the counter pg_stat_xact_user_tables sums into idx_scan.
		 */
		const indexRows = yield* admin.queryValues(
			"SELECT indexrelname::text, relname::text, pg_catalog.pg_stat_get_xact_numscans(indexrelid)::text FROM pg_catalog.pg_stat_user_indexes WHERE schemaname = $1::text",
			[o.installed.schema]
		)
		const indexes = trusted<ReadonlyArray<XactRow>>(indexRows)
		yield* admin.query("ROLLBACK", [])
		return {
			accepted: Result.isSuccess(applied),
			/** Why the laws refused it, read off PostgreSQL's error; none for an accepted write. */
			refusal: Result.isFailure(applied) ? messageOf(applied.failure) : undefined,
			seqScans: new Map(Arr.map(tables, ([t, seq]) => [t, Number(seq)])),
			usedIndexes: Arr.map(
				Arr.filter(indexes, ([, , n]) => Number(n) > 0),
				([i]) => i
			)
		}
	})

/**
 * Each law's probe as the index engine states it (physical/indexes/engine.ts): a B-tree request's an equality on every
 * requested column, a GiST request's an equality on each scalar column and an overlap on each span, a field's kind read
 * off its relation's heading. A law column (an alternatives arm's tagged key, say) is probed by equality in a B-tree
 * request; no platform law asks for one in a GiST request, where its kind would decide the operator. Every platform
 * probe reads every row. Labelled, with its request.
 */
const lawProbes = (
	o: OpenedPlatform
): ReadonlyArray<{
	readonly label: string
	readonly sql: string
	readonly params: number
}> =>
	Arr.flatMap(o.installed.installation.indexes, (i) =>
		Arr.flatMap(i.requests, (r) => {
			if (r.role !== "lawMaintenance") {
				return []
			}
			const fields = Arr.map(r.keys, (k) =>
				k.column.kind === "field" ? k.column.field.name : k.column.column
			)
			const label = `${r.use} on ${r.relation}(${Arr.join(fields, ", ")})`
			const relation = Option.getOrThrowWith(
				Option.fromUndefinedOr(o.installed.installation.laws.theory.relations[r.relation]),
				() => new Error(`${label}: no relation ${r.relation}`)
			)
			const conditions = Arr.map(r.keys, (k, at) => {
				if (k.column.kind === "law") {
					if (r.method === "gist") {
						return assert.fail(`${label} asks GiST for the law column ${k.column.column}`)
					}
					return `${quoteIdent(k.column.column)} = $${at + 1}`
				}
				const field = k.column.field.name
				const column = Option.getOrThrowWith(
					Arr.findFirst(relation.heading, (h) => h.name === field),
					() => new Error(`${label}: ${r.relation} has no ${field}`)
				)
				const span = column.type.carrier === "range4" || column.type.carrier === "range8"
				const op = r.method === "gist" && span ? "&&" : "="
				return `${quoteIdent(o.installed.names.column(r.relation, field))} ${op} $${at + 1}`
			})
			return [
				{
					label,
					sql: `SELECT 1 FROM ${o.table(r.relation)} WHERE ${Arr.join(conditions, " AND ")}`,
					params: fields.length
				}
			]
		})
	)

/**
 * The index scan that reads a law's probe with sequential and bitmap scans disabled, in its generic plan (prepared and
 * executed under force_generic_plan, so no parameter's value shapes it): the index of the first index scan with an
 * index condition, or none, when PostgreSQL can run the probe through no index.
 */
const probeIndex = (probe: { readonly sql: string; readonly params: number }) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		yield* admin.query("BEGIN", [])
		yield* admin.query("SET LOCAL enable_seqscan = off", [])
		yield* admin.query("SET LOCAL enable_bitmapscan = off", [])
		yield* admin.query("SET LOCAL plan_cache_mode = force_generic_plan", [])
		yield* admin.query(`PREPARE law_probe AS ${probe.sql}`, [])
		const explained = yield* admin.queryValues(
			`EXPLAIN (FORMAT JSON) EXECUTE law_probe(${Arr.join(
				Array.from({ length: probe.params }, () => "NULL"),
				", "
			)})`,
			[]
		)
		yield* admin.query("DEALLOCATE law_probe", [])
		yield* admin.query("ROLLBACK", [])
		const plan = parsePlanTree(explained[0]?.[0])
		if (Result.isFailure(plan)) {
			return assert.fail(`no plan for ${probe.sql}`)
		}
		return Option.flatMap(
			Arr.findFirst(
				[...planNodes(plan.success)],
				(n) =>
					(n.nodeType === "Index Scan" || n.nodeType === "Index Only Scan") &&
					Option.isSome(n.indexCond)
			),
			(scan) => scan.index
		)
	})

type PlanFeature =
	| "a read by the busiest entities"
	| "a read by another"
	| "a whole month's window"
	| "a week's window"

const planSuite = (events: number, runs: number) => (ctx: TestContext) =>
	searched(
		ctx,
		Effect.gen(function* () {
			const s = yield* Substrate
			const o = yield* openPlatformWith("platform_plans", (world) => [tenantOf(world).tenants])
			const { tenants, reads: tenantReads } = tenantOf(o.schema)
			const p = buildPlatform(volumePlatform(volume(events)))
			yield* o.withDb((db) =>
				Effect.andThen(loadPlatform(db, p.facts, 100_000), db.workload.refreshDailySpend.refresh)
			)
			for (const r of [...loadOrder, "DailySpend"]) {
				yield* s.admin.query(`VACUUM (ANALYZE) ${o.table(r)}`, [])
			}
			const judge = {
				rows: yield* relationRows(o.installed.schema),
				planned: plannedIndexes(o.installed.installation)
			}
			const e = entitiesOf(p)
			const used = new Set<string>()
			/** Exactly the named reads deduplicate: the compiler's own statements, by their structure. */
			const distinct = Arr.flatMap(probes(e, 0), (pr) => {
				const template = compileTemplate(billingReads[pr.name], P.Billing, testCompile)
				if (!template.ok) {
					return assert.fail(`${pr.name} does not compile`)
				}
				return Arr.some(
					programAsts(template.value.programs.optimized),
					(st) => has(shapeOf(st), "distinct") || has(shapeOf(st), "distinct on")
				)
					? [pr.name]
					: []
			})
			assert.deepEqual(distinct, [...deduplicating], "the reads that deduplicate")
			const explored = yield* explore(
				{
					suite: `pg/e2e-platform/plans ${events}`,
					oracle: { kind: "unstated" },
					draw: drawn(pickGen),
					literal: Formatter.format,
					kept: [],
					runs,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang,
					coverage: required<PlanFeature>(
						[
							"a read by the busiest entities",
							"a read by another",
							"a whole month's window",
							"a week's window"
						],
						{ cases: runs, sense: notesOnly }
					)
				},
				(pick, cx) =>
					Effect.gen(function* () {
						cx.note(
							pickIndex(pick, 3) === 0 ? "a read by the busiest entities" : "a read by another"
						)
						cx.note(pickIndex(pick, 2) === 0 ? "a week's window" : "a whole month's window")
						const problems: Array<string> = []
						/** One read's statements as `who` sent them, judged, the indexes their free plans read used. */
						const review = (who: string, pr: Probe, sent: Parameters<typeof sentProblems>[2]) =>
							Effect.gen(function* () {
								if (sent.length !== 1) {
									problems.push(`${pr.name} as ${who}: ${sent.length} statements, not one`)
								}
								const judged = yield* sentProblems(s.admin, `${pr.name} as ${who}`, sent, judge)
								appendAll(problems, judged.problems)
								for (const index of judged.read) {
									used.add(index)
								}
							})
						const asked = probes(e, pick)
						/**
						 * Every probe read as `who`, through a Db of `role` opened with a token of `payload`: the role's
						 * reads loaded as members of its workload, each probe's run through the counting executor.
						 */
						const reviewAs = (who: string, role: AnyLoginRole, payload: Json, reads: Reads) =>
							Effect.scoped(
								withServedDb(o.installed, role, payload, ({ ctx, load }) =>
									Effect.gen(function* () {
										const loaded = yield* load(reads)
										const { ops, counts } = recordingMembers(ctx)
										for (const pr of asked) {
											const before = counts.sent.length
											yield* (yield* ops(member(loaded, pr.name)).execute(pr.params)).collect
											yield* review(who, pr, counts.sent.slice(before))
										}
									})
								)
							)
						yield* reviewAs("billing", o.schema.server.roles.billing, {}, billingReads)
						yield* reviewAs(
							"the tenant",
							tenants.roles.tenant,
							{ org: pickOf(e.orgs, pick, uid(0xdead, 2)) },
							tenantReads
						)
						assert.deepEqual(
							problems,
							[],
							"every read is one statement, planned through its indexes, as billing and as the tenant"
						)
					})
			)
			/** Law maintenance. */
			const lawProblems: Array<string> = []
			for (const w of lawWrites(o, p, e)) {
				const ran = yield* runLawWrite(o, w)
				if (ran.accepted !== w.accepted) {
					lawProblems.push(
						`${w.name}: ${ran.refusal === undefined ? "accepted" : `refused: ${ran.refusal}`}`
					)
				}
				appendAll(
					lawProblems,
					Arr.map(
						Arr.filter(
							Arr.map(w.counted, (c) => o.installed.names.relation(c).name),
							(table) => (ran.seqScans.get(table) ?? 0) > 0
						),
						(table) => `${w.name}: a sequential scan of ${table}`
					)
				)
				for (const i of ran.usedIndexes) {
					used.add(i)
				}
			}
			assert.deepEqual(lawProblems, [], "law maintenance reads every counted relation by an index")
			/**
			 * Every law's probe, whichever writes reach it: a refused write stops at its first refusing law, so the writes
			 * above probe only the relations up to it. PostgreSQL may read a probe through another index than the one the
			 * engine merged it into when several serve it; the one it reads must be one the installation planned, and a
			 * created index no probe or read chooses fails below.
			 */
			const probeProblems: Array<string> = []
			for (const probe of lawProbes(o)) {
				const index = yield* probeIndex(probe)
				if (Option.isNone(index)) {
					probeProblems.push(`${probe.label}: no index scan`)
					continue
				}
				if (judge.planned.has(index.value)) {
					used.add(index.value)
				} else {
					probeProblems.push(
						`${probe.label}: read through ${index.value}, which the installation did not plan`
					)
				}
			}
			assert.deepEqual(
				probeProblems,
				[],
				"every law's probe reads through an index the installation planned"
			)
			/** Every index the installation created is read. */
			const created = Arr.flatMap(o.installed.installation.indexes, (i) =>
				i.index.kind === "created" ? [i.index.name] : []
			)
			assert.deepEqual(
				Arr.filter(created, (i) => !used.has(i)),
				[],
				"every created index is read by a workload read or a law"
			)
			return explored
		})
	)

layer(Substrate.layer)("the platform's plans at volume", (it) => {
	it.effect(
		"100,000 usage events: every read through its indexes, every index read",
		planSuite(100_000, 6)
	)
})
