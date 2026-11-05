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
	Option,
	Order,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import type { TestContext } from "vitest"
import { parsePlanTree, planNodes } from "#bench/harness/explain.ts"
/**
 * The platform's plans at volume: every workload read is planned through an index, and law maintenance never scans the
 * relation it counts.
 *
 * The file runs with the cluster to itself (`.exclusive`, vitest.network.config.ts): its load at volume holds SERIALIZABLE
 * transactions for tens of seconds (100,000-fact db.apply batches and db.refresh, 20 to 59 s each in a sampled
 * default-tier run), and SSI retains every transaction that commits meanwhile, which summarizes other files' own.
 *
 * The platform installs with its workload's access paths, as its first migration drafts them, and loads a volume
 * platform (test/support/platform/generate.ts volumePlatform) through db.apply in batches within the input limit, then
 * VACUUM ANALYZE. Its sizes: a thousand organizations under resellers, five thousand workspaces with ten thousand keys,
 * ten models on four providers repriced monthly, six months of calendar, and 100,000 usage events (about half a million
 * usage facts). Each case draws, per read, which of the platform's
 * entities and windows it reads (the busiest workspace, key, organization and grant, or another), runs every workload read
 * through the runtime with a counting executor, and EXPLAINs each statement the runtime sent with its parameters:
 *
 * - a read is one statement, its attachments fused into it, but for the attachments the fusion rule pipelines (below);
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
import { appendAll } from "#compiler/core/array.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { loadPlatform, type OpenedPlatform, openPlatform } from "#test/pg/e2e-platform/support.ts"
import { assert } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import * as P from "#test/support/fixtures/api/platform.ts"
import { has, shapeOf } from "#test/support/kernel/shape.ts"
import { caseHang } from "#test/support/limits.ts"
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
import { platformSpan } from "#test/support/platform/model.ts"
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
const deduplicating: ReadonlyArray<string> = ["repricedInMonth"]

/**
 * The statements each read is, by the fusion rule (lower/shapes/attach): one, its attachments fused into it, except an
 * attachment with attachments of its own, which is pipelined as a statement of its own, and so is each attachment
 * under it. invoicePreview's lines carry their usage and plan details: the read, its lines, and each detail.
 */
const statementsOf = (name: string): number => (name === "invoicePreview" ? 4 : 1)

const unit = (t: bigint) => ({ start: P.Instant(t), end: P.Instant(t + 1n) })

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
	readonly params: Readonly<Record<string, unknown>>
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

/** A literal in SQL: a span as its range text, a string quoted, a number or bigint as is. */
const sqlLiteral = (v: unknown): string => {
	if (typeof v === "bigint" || typeof v === "number") {
		return String(v)
	}
	if (typeof v === "string") {
		return `'${Str.replaceAll("'", "''")(v)}'`
	}
	if (typeof v === "object" && v !== null && "start" in v && "end" in v) {
		return `'[${String(v.start)},${String(v.end)})'`
	}
	throw new Error(`no SQL literal for ${String(v)}`)
}

/** INSERT statements of facts, through the installation's names. */
const inserts = (
	o: OpenedPlatform,
	relation: string,
	rows: ReadonlyArray<Readonly<Record<string, unknown>>>
): ReadonlyArray<string> =>
	Arr.map(rows, (row) => {
		const fields = Rec.keys(row)
		return `INSERT INTO ${o.table(relation)} (${Arr.join(
			Arr.map(fields, (f) => quoteIdent(o.installed.names.column(relation, f))),
			", "
		)}) VALUES (${Arr.join(
			Arr.map(fields, (f) => sqlLiteral(row[f])),
			", "
		)})`
	})

const deletes = (
	o: OpenedPlatform,
	relation: string,
	where: Readonly<Record<string, unknown>>
): string =>
	`DELETE FROM ${o.table(relation)} WHERE ${Arr.join(
		Arr.map(
			Rec.toEntries(where),
			([f, v]) => `${quoteIdent(o.installed.names.column(relation, f))} = ${sqlLiteral(v)}`
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
type Referenced = readonly [string, Readonly<Record<string, unknown>>, ReadonlyArray<string>]

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
	const paid = Arr.findFirst(
		p.facts.Invoice,
		(i) => i.state === "paid" && Arr.some(p.facts.Refund, (r) => r.invoice === i.id)
	)
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
		statements: [
			...inserts(o, "UsageEvent", [r.event]),
			...inserts(o, "EventCharge", [r.total]),
			...inserts(o, "UsageCharge", r.charges),
			...inserts(o, "ProviderCost", [r.cost]),
			...inserts(o, "CreditDebit", r.debits)
		],
		counted: ["UsageCharge", "EventCharge", "CreditDebit", "UsageEvent"],
		accepted: true
	}))
	const refund = Option.map(Option.all({ paid, instant }), (at): LawWrite => ({
		name: "a refund",
		statements: inserts(o, "Refund", [
			{ id: uid(0x7e57, 4), invoice: at.paid.id, amount: 1n, reason: "requested", at: at.instant }
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
		return {
			name: "a month closed with a plan line and its allocation",
			statements: [
				...inserts(o, "Invoice", [
					{
						id: invoice,
						org: at.subscription.org,
						period: at.lastMonth.during,
						amount,
						state: "open"
					}
				]),
				...inserts(o, "InvoiceLine", [{ id: line, invoice, source: "plan", amount }]),
				...inserts(o, "PlanLine", [{ line, subscription: at.subscription.id }]),
				...inserts(o, "Allocation", [
					{ line, subscription: at.subscription.id, during: { start, end: start + DAY }, amount }
				])
			],
			counted: ["InvoiceLine", "Allocation", "PlanLine", "Segment"],
			accepted: true
		}
	})
	const paying = Option.map(open, (i): LawWrite => ({
		name: "an invoice paid",
		statements: [
			deletes(o, "Invoice", { id: i.id }),
			...inserts(o, "Invoice", [{ ...i, state: "paid" }]),
			...inserts(o, "Payment", [{ invoice: i.id, charge: uid(0x7e57, 5) }])
		],
		counted: ["Payment", "Refund", "InvoiceLine"],
		accepted: true
	}))
	/** Its usage after the cut is outside every active span, which the coverage law refuses. */
	const revoking = Option.map(Option.all({ activeKey, span0 }), (at): LawWrite => {
		const cut = at.span0.during.start + 10n
		const id = at.activeKey.id
		return {
			name: "a key revoked with its span cut",
			statements: [
				deletes(o, "ApiKey", { id }),
				...inserts(o, "ApiKey", [{ ...at.activeKey, state: "revoked" }]),
				...inserts(o, "Revocation", [{ key: id, at: cut }]),
				deletes(o, "ApiKeyActive", { key: id, during: at.span0.during }),
				...inserts(o, "ApiKeyActive", [
					{ key: id, during: { start: at.span0.during.start, end: cut } }
				])
			],
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
			seqScans: new Map(Arr.map(tables, ([t, seq]) => [t, Number(seq)])),
			usedIndexes: Arr.map(
				Arr.filter(indexes, ([, , n]) => Number(n) > 0),
				([i]) => i
			)
		}
	})

/**
 * Each law's probe as the index engine states it (physical/indexes/engine.ts): a B-tree request's an equality on every
 * requested column, a GiST request's an equality on each scalar column and an overlap on each span, the column's kind
 * read off its relation's heading; every platform probe reads every row. Labelled, with its request.
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
			if (r.rows.kind === "selected") {
				return assert.fail(`${label} reads selected rows, which no platform law probes`)
			}
			const relation = Option.getOrThrowWith(
				Option.fromUndefinedOr(o.installed.installation.laws.theory.relations[r.relation]),
				() => new Error(`${label}: no relation ${r.relation}`)
			)
			const conditions = Arr.map(fields, (field, at) => {
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
			const o = yield* openPlatform("platform_plans")
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
					o.withDb((db) =>
						Effect.gen(function* () {
							cx.note(
								pickIndex(pick, 3) === 0 ? "a read by the busiest entities" : "a read by another"
							)
							cx.note(pickIndex(pick, 2) === 0 ? "a week's window" : "a whole month's window")
							const { reader, counts } = yield* recordingReader(db)
							const problems: Array<string> = []
							for (const pr of probes(e, pick)) {
								const before = counts.sent.length
								yield* (yield* reader.execute(pr.query, pr.params)).collect
								const sent = counts.sent.slice(before)
								if (sent.length !== statementsOf(pr.name)) {
									problems.push(
										`${pr.name}: ${sent.length} statements, not ${statementsOf(pr.name)}`
									)
								}
								const judged = yield* sentProblems(s.admin, pr.name, sent, judge)
								appendAll(problems, judged.problems)
								for (const index of judged.read) {
									used.add(index)
								}
							}
							assert.deepEqual(
								problems,
								[],
								"every read is one statement planned through its indexes"
							)
						})
					)
			)
			/** Law maintenance. */
			const lawProblems: Array<string> = []
			for (const w of lawWrites(o, p, e)) {
				const ran = yield* runLawWrite(o, w)
				if (ran.accepted !== w.accepted) {
					lawProblems.push(`${w.name}: ${ran.accepted ? "accepted" : "refused"}`)
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
