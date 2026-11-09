import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Layer,
	Option,
	Order,
	Record as Rec,
	Result
} from "effect"
import type { TestContext } from "vitest"
import { openDbContext } from "#adapter/db/open.ts"
/**
 * The platform's plans at volume: every workload read is planned through an index, and law maintenance never scans the
 * relation it counts.
 *
 * The file runs with the cluster to itself (`.exclusive`, vitest.network.config.ts): its load at volume holds SERIALIZABLE
 * transactions for tens of seconds (100,000-fact db.apply batches and db.refresh, 20 to 59 s each in a sampled
 * default-tier run), and SSI retains every transaction that commits meanwhile, which summarizes other files' own.
 *
 * The platform installs with its workload's access paths, as its first migration drafts them, beside an org tenant's
 * login (tenantOf), and loads a volume platform (test/support/platform/generate.ts volumePlatform) through db.apply in
 * batches within the input limit, then VACUUM ANALYZE. Its sizes: a thousand organizations under resellers, five
 * thousand workspaces with ten thousand keys, ten models on four providers repriced monthly, six months of calendar, and
 * 100,000 usage events (about half a million usage facts). Each case draws, per read, which of the platform's entities
 * and windows it reads (the busiest workspace, key, organization and grant, or another), runs every workload read
 * through the runtime with a counting executor twice, as billing, whose whole entries are plain views, and as the
 * tenant, its Db opened with a token naming the drawn organization, so the read goes through the tenant's
 * security-barrier views of its own organization over relations under row-level security, and EXPLAINs each statement
 * the runtime sent with its parameters:
 *
 * - a read is one statement for its rows and one for each attachment it declares, at every depth: over exact parents
 *   every attachment is a statement of its own in the read's flight (R36, lower/shapes/index.ts rowsStatement);
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
import type { RowDecoder } from "#compiler/core/decoder.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type { QueryDesc, QueryStageDesc, RuleDesc } from "#compiler/ir/desc.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { type Uuid, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { context, login, role } from "#compiler/public/schema.ts"
import { isOrderedValue, isQueryValue } from "#compiler/query/build/index.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import {
	loadPlatform,
	type OpenedPlatform,
	openPlatformWith
} from "#test/pg/e2e-platform/support.ts"
import { directSql, literal } from "#test/schedules/platform/support.ts"
import { assert } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import * as P from "#test/support/fixtures/api/platform.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { has, shapeOf } from "#test/support/kernel/shape.ts"
import { caseHang } from "#test/support/limits.ts"
import { messageOf } from "#test/support/message.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"
import { plannedIndexes, recordingReader, relationRows, sentProblems } from "#test/support/plans.ts"
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
import { Substrate } from "#test/support/substrate/substrate.ts"
import { loginLayer, tokenOf } from "#test/support/worlds.ts"

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
const deduplicating: ReadonlyArray<string> = ["repricedInMonth"]

/**
 * The attachments a query declares, at every depth: each attach stage's and each arm's own, with every attachment
 * their children declare. Read off the query's Description, the caller's statement of it, never off the compiled
 * program, whose count it checks.
 */
const declaredAttachments = (q: QueryDesc): number => {
	const ofArms = (arms: ReadonlyArray<RuleDesc>): number =>
		Arr.reduce(arms, 0, (n, arm) =>
			Arr.reduce(arm.attach, n, (m, a) => m + 1 + declaredAttachments(a.child))
		)
	const ofStage = (stage: QueryStageDesc): number => {
		switch (stage.kind) {
			case "rules":
				return ofArms(stage.arms)
			case "recursive":
				return 0
			case "union":
				return ofStage(stage.input) + ofArms(stage.arms)
			case "attach":
				return ofStage(stage.input) + 1 + declaredAttachments(stage.attach.child)
			case "named":
			case "order":
			case "take":
			case "approx":
				return ofStage(stage.input)
		}
	}
	return ofStage(q.stage)
}

/**
 * The statements a read is, by the R36 rule (lower/shapes/index.ts rowsStatement): its rows' statement and one per
 * attachment it declares, at every depth, since no platform read's parents are an approximate search, the one case
 * an attachment fuses. invoicePreview is seven: the invoice, its lines, each line's usage and plan detail, its
 * refunds, its payment and its dispute.
 */
const statementsOf = (read: unknown): number => {
	const input = queryInput(read)
	if (!input.ok) {
		return assert.fail("a workload read's query value")
	}
	return 1 + declaredAttachments(input.value.desc)
}

/** A workload read's Description: what the tenant's Db compiles against the tenant's own world, by relation name. */
const descriptionOf = (read: unknown): QueryDesc => {
	const input = queryInput(read)
	return input.ok ? input.value.desc : assert.fail("a workload read's query value")
}

/** A workload read's own rows decoder, which reads the tenant's rows of it: the tenant's relations keep every field. */
const rowsOf = (read: unknown): RowDecoder<unknown> =>
	isQueryValue(read) || isOrderedValue(read)
		? read.rows
		: assert.fail("a workload read's query value")

const unit = (t: bigint) => ({ start: P.Instant(t), end: P.Instant(t + 1n) })

/**
 * The platform's org tenant over `world`, the platform built under a name (P.platformAt): a token's Tenant claim names one
 * organization, and the tenant reads every relation of it through a query entry its claim filters, each keeping the
 * relation's name and every field, along the relation's path to the organization: its workspaces, their keys and
 * the keys' usage, charges, costs, debits and limits, its grants, invoices with their lines, payments and refunds, and
 * its subscriptions with their segments, beside the catalogue every organization reads whole (rosters, providers,
 * models, routes, prices, rate cards, days and months). It writes its workspaces, keys and revocations through those
 * entries, so each of those relations is under row-level security. A read of the platform's workload, its Description
 * compiled against the tenant's world (program/compile.ts querySchema), reads the tenant's views by the relations' names.
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
	return { tenants: login(billing, "tenants", [tenant]) }
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

interface Probe {
	readonly name: string
	readonly query: unknown
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
		{ name: "eventCost", query: P.eventCost, params: { event: pickOf(e.events, pick, none) } },
		{
			name: "quote",
			query: P.quote,
			params: {
				model,
				now,
				usage: [
					{ kind: "input", tokens: P.Tokens(1500n) },
					{ kind: "output", tokens: P.Tokens(20n) }
				]
			}
		},
		{ name: "ratesAt", query: P.ratesAt, params: { model, now } },
		{ name: "rateHistory", query: P.rateHistory, params: { model, kind: "input" } },
		{ name: "repricedInMonth", query: P.repricedInMonth, params: { workspace, month } },
		{ name: "spendByDay", query: P.spendByDay, params: { workspace, window } },
		{ name: "spendByMonth", query: P.spendByMonth, params: { workspace } },
		{ name: "workspaceMonth", query: P.workspaceMonth, params: { workspace, month } },
		{ name: "nearCap", query: P.nearCap, params: { org, month } },
		{ name: "topModels", query: P.topModels, params: { workspace, month, k: 3 } },
		{ name: "topProviders", query: P.topProviders, params: { org, month, k: 3 } },
		{ name: "marginByProvider", query: P.marginByProvider, params: { org, month } },
		{
			name: "consolidatedSpend",
			query: P.consolidatedSpend,
			params: { root: pickOf(e.orgs, pick, none), month }
		},
		{ name: "balanceAt", query: P.balanceAt, params: { org, now } },
		{ name: "expiringGrants", query: P.expiringGrants, params: { org, window } },
		{ name: "burnDown", query: P.burnDown, params: { grant: pickOf(e.grants, pick, none) } },
		{ name: "keyCard", query: P.keyCard, params: { key } },
		{ name: "usageLog", query: P.usageLog, params: { key } },
		{ name: "idleKeys", query: P.idleKeys, params: { workspace, window } },
		{ name: "rollupVersusLive", query: P.rollupVersusLive, params: { workspace, window } },
		{ name: "invoices", query: P.invoices, params: { org } },
		{ name: "invoiceAt", query: P.invoiceAt, params: { org, now } },
		{
			name: "overdueInvoices",
			query: P.overdueInvoices,
			params: { org, cutoff: P.Instant(m.end) }
		},
		{ name: "invoicePreview", query: P.invoicePreview, params: { invoice } },
		{ name: "refundable", query: P.refundable, params: { org } },
		{
			name: "refundsByReason",
			query: P.refundsByReason,
			params: { org, window: { start: P.Instant(m.start), end: P.Instant(m.end + 40n * DAY) } }
		},
		{ name: "mostRefunded", query: P.mostRefunded, params: { k: 5 } },
		{
			name: "segmentsAt",
			query: P.segmentsAt,
			params: { subscription: pickOf(e.subscriptions, pick, none), now }
		},
		{ name: "prorationFor", query: P.prorationFor, params: { invoice } },
		{ name: "mrrAt", query: P.mrrAt, params: { org, now } },
		{ name: "recognizedIn", query: P.recognizedIn, params: { org, month } },
		{ name: "allocationBreakdown", query: P.allocationBreakdown, params: { invoice } }
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
			const { tenants } = tenantOf(o.schema)
			const p = buildPlatform(volumePlatform(volume(events)))
			yield* o.withDb((db) =>
				Effect.andThen(
					loadPlatform(db, p.facts, 100_000),
					db.refresh(o.schema.Billing.relations.DailySpend)
				)
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
				const template = compileTemplate(pr.query, P.Billing, testCompile)
				if (!template.ok) {
					return assert.fail(`${pr.name} does not compile`)
				}
				return Arr.some(
					flight(template.value.programs.optimized.roots),
					(st) => has(shapeOf(st.ast), "distinct") || has(shapeOf(st.ast), "distinct on")
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
						/** One read's statements as it sent them as `who`, judged, the indexes their free plans read used. */
						const review = (who: string, pr: Probe, sent: Parameters<typeof sentProblems>[2]) =>
							Effect.gen(function* () {
								const expected = statementsOf(pr.query)
								if (sent.length !== expected) {
									problems.push(`${pr.name} as ${who}: ${sent.length} statements, not ${expected}`)
								}
								const judged = yield* sentProblems(s.admin, `${pr.name} as ${who}`, sent, judge)
								appendAll(problems, judged.problems)
								for (const index of judged.read) {
									used.add(index)
								}
							})
						yield* o.withDb((...[, dbCtx]) =>
							Effect.gen(function* () {
								const { reader, counts } = yield* recordingReader(dbCtx)
								for (const pr of probes(e, pick)) {
									const before = counts.sent.length
									yield* (yield* reader.execute(pr.query, pr.params)).collect
									yield* review("billing", pr, counts.sent.slice(before))
								}
							})
						)
						yield* Effect.gen(function* () {
							const { ctx: dbCtx } = yield* openDbContext(tenants.roles.tenant, {
								token: tokenOf({ org: pickOf(e.orgs, pick, uid(0xdead, 2)) })
							})
							const { compileWith, counts } = yield* recordingReader(dbCtx)
							for (const pr of probes(e, pick)) {
								const before = counts.sent.length
								const read = yield* compileWith(descriptionOf(pr.query), () => rowsOf(pr.query))
								yield* (yield* read.execute(pr.params)).collect
								yield* review("the tenant", pr, counts.sent.slice(before))
							}
						}).pipe(
							Effect.scoped,
							(body) =>
								Effect.flatMap(Layer.build(loginLayer(o.installed, tenants)), (context) =>
									Effect.provideContext(body, context)
								),
							Effect.scoped
						)
						assert.deepEqual(
							problems,
							[],
							"every read is its rows' statement and its attachments', each planned through its indexes, as billing and as the tenant"
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
