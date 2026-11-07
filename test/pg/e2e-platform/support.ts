import {
	Array as Arr,
	Data,
	Effect,
	Formatter,
	Layer,
	Option,
	Record as Rec,
	type Scope,
	String as Str
} from "effect"
import type { OpenError } from "#adapter/errors/execution.ts"
import { Db } from "#adapter/public/db.ts"
import type { DbOf } from "#adapter/types/db.ts"
import type { DbLayerOf } from "#adapter/types/layer.ts"
import { appendAll, indices } from "#compiler/core/array.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { isRecord } from "#compiler/core/record.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { literalDescShape } from "#compiler/ir/desc.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import * as S from "#compiler/ir/shape.ts"
import { workloadExtension } from "#compiler/physical/access/extension.ts"
import type { WorkloadPlan } from "#compiler/program/workload/compile.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { irLiteral } from "#compiler/scalar/compute/literal.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { AnyLogin } from "#compiler/types/schema/world.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, compileTestWorkload, testCompile } from "#test/support/compile.ts"
import * as P from "#test/support/fixtures/api/platform.ts"
import { type Installed, installMigrated as install } from "#test/support/install-migrate.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import type { GenParam } from "#test/support/oracle/gen/query.ts"
import type { GenSchema } from "#test/support/oracle/gen/schema.ts"
import {
	type ExpectedStatement,
	expectedStatements
} from "#test/support/oracle/reference/deliver.ts"
import { Reference, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { Identities } from "#test/support/oracle/reference/identity.ts"
import { distinctRows, equal, type Row, type Value } from "#test/support/oracle/reference/values.ts"
import type { SqlError } from "#test/support/pg.ts"
import { loadOrder, noFacts, type PlatformFacts } from "#test/support/platform/generate.ts"
import { stateOf, withDrawn } from "#test/support/platform/laws.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { loginLayer } from "#test/support/worlds.ts"

/** The platform rebuilt under an installed name, with its world. */
type PlatformWorld = ReturnType<typeof P.platformAt>

export type PlatformDb = DbOf<PlatformWorld["billing"], unknown>

/** The workload planned once per process, over the declared schema: its access paths name relations, not schemas. */
const workloadPlan: WorkloadPlan = succeeded(
	compileTestWorkload(
		[{ login: "server", workloads: [P.platformWorkload] }],
		P.Billing,
		testCompile
	),
	"the workload"
)

export interface OpenedPlatform {
	readonly installed: Installed
	readonly schema: PlatformWorld
	readonly layer: Layer.Layer<DbLayerOf<PlatformWorld["server"]>, OpenError>
	/** A relation's table, schema-qualified and quoted. */
	readonly table: (relation: string) => string
	/** Every stored relation's rows deleted, as the owner: the next case starts from an empty platform. */
	readonly clear: Effect.Effect<void, SqlError>
	/** Runs `body` on the platform opened as `billing`, in a scope of its own, with whatever else it needs. */
	readonly withDb: <A, E, R>(
		body: (db: PlatformDb) => Effect.Effect<A, E, R | Scope.Scope>
	) => Effect.Effect<A, E | OpenError, R>
}

/**
 * Shared helpers of the platform's end-to-end suites (test/pg/e2e-platform).
 *
 * The platform (test/support/fixtures/api/platform.ts) installs as a deployment installs it: its first migration,
 * drafted with its workload's access paths and applied by the real apply runner (test/support/install-migrate.ts), under a name
 * the substrate allocates, with its login. It is opened through Db.open as the full role `billing` of the schema
 * rebuilt under that name (platformAt), whose levels hold the declared schemas' types, so every workload read and write
 * runs on it unchanged.
 *
 * Facts load through the public API only: db.apply of ChangeSets that insert them, within the input limit, each of
 * which the laws must accept. A generated platform is lawful by construction (test/support/platform/generate.ts), so a
 * refused load is a defect of the generator or of grizzle, reported with the law.
 *
 * The reference evaluator (test/support/oracle/reference) reads a workload read's checked IR, the compiler's own
 * translation, over the same facts as typed literals; what it delivers per statement (the root's rows, and each
 * attachment's parent keys with their children) is compared with what the public read decoded, flattened the same way,
 * each column by its type's own equality and each statement as a set.
 *
 * Installs the platform with its workload under a fresh name and opens it (see the header).
 */
export const openPlatform = (
	label: string
): Effect.Effect<
	OpenedPlatform,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> => openPlatformWith(label, () => [])

/**
 * openPlatform, installing `also`'s logins beside billing's: the logins a suite reads the platform through besides
 * billing, built by `also` over the declared platform to install and, by the suite, over the installed one
 * (OpenedPlatform's `schema`) to open.
 */
export const openPlatformWith = (
	label: string,
	also: (world: PlatformWorld) => ReadonlyArray<AnyLogin>
): Effect.Effect<
	OpenedPlatform,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const declared = P.platformAt("Platform")
		const installed = yield* install(declared.Billing, {
			ambient: ordinarySession,
			label,
			logins: [declared.server, ...also(declared)],
			extensions: [workloadExtension(workloadPlan)]
		})
		const schema = P.platformAt(installed.declared)
		const layer = loginLayer(installed, schema.server)
		const table = (relation: string): string => {
			const q = installed.names.relation(relation)
			return `${quoteIdent(q.schema)}.${quoteIdent(q.name)}`
		}
		const clear = s.admin.query(`TRUNCATE ${Arr.join(Arr.map(loadOrder, table), ", ")}`, [])
		return {
			installed,
			schema,
			layer,
			table,
			clear: Effect.asVoid(clear),
			withDb: (body) =>
				Effect.scoped(
					Effect.flatMap(Layer.build(layer), (context) =>
						Effect.provideContext(
							Effect.scoped(Effect.flatMap(Db.open(schema.server.roles.billing, {}), body)),
							context
						)
					)
				)
		}
	})

/** One ChangeSet inserting every relation's facts. */
export const insertAll = (f: PlatformFacts) =>
	ChangeSet.empty(P.Platform)
		.insert(P.Month, f.Month)
		.insert(P.Day, f.Day)
		.insert(P.Org, f.Org)
		.insert(P.ParentOrg, f.ParentOrg)
		.insert(P.Workspace, f.Workspace)
		.insert(P.WorkspaceLimit, f.WorkspaceLimit)
		.insert(P.ApiKey, f.ApiKey)
		.insert(P.Revocation, f.Revocation)
		.insert(P.ApiKeyActive, f.ApiKeyActive)
		.insert(P.Provider, f.Provider)
		.insert(P.Model, f.Model)
		.insert(P.Route, f.Route)
		.insert(P.ProviderPrice, f.ProviderPrice)
		.insert(P.RateCard, f.RateCard)
		.insert(P.RateTier, f.RateTier)
		.insert(P.CreditGrant, f.CreditGrant)
		.insert(P.Subscription, f.Subscription)
		.insert(P.Segment, f.Segment)
		.insert(P.UsageEvent, f.UsageEvent)
		.insert(P.EventCharge, f.EventCharge)
		.insert(P.UsageCharge, f.UsageCharge)
		.insert(P.ProviderCost, f.ProviderCost)
		.insert(P.CreditDebit, f.CreditDebit)
		.insert(P.Invoice, f.Invoice)
		.insert(P.InvoiceLine, f.InvoiceLine)
		.insert(P.UsageLine, f.UsageLine)
		.insert(P.PlanLine, f.PlanLine)
		.insert(P.Allocation, f.Allocation)
		.insert(P.Payment, f.Payment)
		.insert(P.Voiding, f.Voiding)
		.insert(P.Dispute, f.Dispute)
		.insert(P.Refund, f.Refund)

const factCount = (f: PlatformFacts): number => Arr.reduce(loadOrder, 0, (n, r) => n + f[r].length)

/** A load the laws refused, or that changed nothing: a defect of the generator or of grizzle. */
class LoadRefused extends Data.TaggedError("LoadRefused")<{ readonly reason: string }> {
	override get message(): string {
		return this.reason
	}
}

/** Applies one ChangeSet of facts; it must be accepted. */
export const applyFacts = (db: PlatformDb, f: PlatformFacts) =>
	Effect.gen(function* () {
		if (factCount(f) === 0) {
			return
		}
		const outcome = yield* db.apply(insertAll(f), {})
		if (outcome.kind === "invariant-rejected") {
			return yield* Effect.die(
				new LoadRefused({
					reason: `the load was refused by ${Formatter.format(outcome.laws)}: ${Formatter.format(outcome.witness)}`
				})
			)
		}
		if (outcome.kind === "no-change") {
			return yield* Effect.die(new LoadRefused({ reason: "the load changed nothing" }))
		}
	})

/** Rows grouped by the event they belong to, in order. */
const byEvent = <A extends { readonly event: string }>(
	rows: ReadonlyArray<A>
): Map<string, Array<A>> => {
	const m = new Map<string, Array<A>>()
	for (const row of rows) {
		const list = m.get(row.event)
		if (list === undefined) {
			m.set(row.event, [row])
		} else {
			list.push(row)
		}
	}
	return m
}

/** The usage rows of one batch, each event's rows together, and how many rows it holds. */
interface UsageBatch {
	readonly events: Array<PlatformFacts["UsageEvent"][number]>
	readonly charges: Array<PlatformFacts["UsageCharge"][number]>
	readonly totals: Array<PlatformFacts["EventCharge"][number]>
	readonly costs: Array<PlatformFacts["ProviderCost"][number]>
	readonly debits: Array<PlatformFacts["CreditDebit"][number]>
	size: number
}

/** A usage batch holding nothing. */
const emptyUsage = (): UsageBatch => ({
	events: [],
	charges: [],
	totals: [],
	costs: [],
	debits: [],
	size: 0
})

/** Rows by the invoice each belongs to, one per invoice. */
const one = <A extends { readonly invoice: string }>(rows: ReadonlyArray<A>) =>
	new Map(Arr.map(rows, (r) => [r.invoice, r]))

/** The keys in batches of at most `limit / 2`, each with its keys' revocations. */
const keyBatches = (
	f: PlatformFacts,
	limit: number,
	revocations: ReadonlyMap<string, PlatformFacts["Revocation"][number]>
): ReadonlyArray<PlatformFacts> =>
	Arr.map(indices(Math.ceil(f.ApiKey.length / (limit / 2))), (n) => {
		const keys = f.ApiKey.slice(n * (limit / 2), (n + 1) * (limit / 2))
		return {
			...noFacts,
			ApiKey: keys,
			Revocation: Arr.flatMap(keys, (k) => {
				const revoked = revocations.get(k.id)
				return revoked === undefined ? [] : [revoked]
			})
		}
	})

/**
 * The facts in batches of at most `limit` facts, each lawful on its own once the earlier ones committed: the setup
 * relations first, in order; then the usage, each event's rows together; then the billing, each invoice's rows
 * together. They load one after another: two large batches at once share SERIALIZABLE predicate locks that PostgreSQL
 * coarsens to whole relations, so concurrent loading only trades its time for serialization failures.
 */
const batches = (f: PlatformFacts, limit: number): ReadonlyArray<PlatformFacts> => {
	const out: Array<PlatformFacts> = []
	const setup: Array<keyof PlatformFacts> = [
		"Month",
		"Day",
		"Org",
		"ParentOrg",
		"Workspace",
		"WorkspaceLimit",
		"ApiKeyActive",
		"Provider",
		"Model",
		"Route",
		"ProviderPrice",
		"RateCard",
		"RateTier",
		"CreditGrant",
		"Subscription",
		"Segment"
	]
	/**
	 * The setup relations, sliced; each is lawful once the relations before it are stored. A key and its revocation are
	 * one batch, as the alternatives law holds at commit, before the keys' active spans.
	 */
	const revocations = new Map(Arr.map(f.Revocation, (r) => [r.key, r]))
	for (const r of setup) {
		if (r === "ApiKeyActive") {
			appendAll(out, keyBatches(f, limit, revocations))
		}
		const rows = f[r]
		for (let i = 0; i < rows.length; i += limit) {
			out.push({ ...noFacts, [r]: rows.slice(i, i + limit) })
		}
	}
	const charges = byEvent(f.UsageCharge)
	const debits = byEvent(f.CreditDebit)
	const totals = new Map(Arr.map(f.EventCharge, (e) => [e.event, e]))
	const costs = new Map(Arr.map(f.ProviderCost, (c) => [c.event, c]))
	let usage = emptyUsage()
	const flushUsage = () => {
		if (usage.size === 0) {
			return
		}
		out.push({
			...noFacts,
			UsageEvent: usage.events,
			UsageCharge: usage.charges,
			EventCharge: usage.totals,
			ProviderCost: usage.costs,
			CreditDebit: usage.debits
		})
		usage = emptyUsage()
	}
	for (const e of f.UsageEvent) {
		const c = charges.get(e.id) ?? []
		const d = debits.get(e.id) ?? []
		const t = totals.get(e.id)
		const k = costs.get(e.id)
		const size = 1 + c.length + d.length + (t === undefined ? 0 : 1) + (k === undefined ? 0 : 1)
		if (usage.size + size > limit) {
			flushUsage()
		}
		usage.events.push(e)
		appendAll(usage.charges, c)
		appendAll(usage.debits, d)
		if (t !== undefined) {
			usage.totals.push(t)
		}
		if (k !== undefined) {
			usage.costs.push(k)
		}
		usage.size += size
	}
	flushUsage()
	const lines = new Map<string, Array<(typeof f.InvoiceLine)[number]>>()
	for (const l of f.InvoiceLine) {
		lines.set(l.invoice, [...(lines.get(l.invoice) ?? []), l])
	}
	const lineInvoice = new Map(Arr.map(f.InvoiceLine, (l) => [l.id, l.invoice]))
	const usageOf = new Map<string, Array<(typeof f.UsageLine)[number]>>()
	for (const u of f.UsageLine) {
		const i = lineInvoice.get(u.line) ?? ""
		usageOf.set(i, [...(usageOf.get(i) ?? []), u])
	}
	const planOf = new Map<string, Array<(typeof f.PlanLine)[number]>>()
	for (const p of f.PlanLine) {
		const i = lineInvoice.get(p.line) ?? ""
		planOf.set(i, [...(planOf.get(i) ?? []), p])
	}
	const allocationsOf = new Map<string, Array<(typeof f.Allocation)[number]>>()
	for (const a of f.Allocation) {
		const i = lineInvoice.get(a.line) ?? ""
		allocationsOf.set(i, [...(allocationsOf.get(i) ?? []), a])
	}
	const payments = one(f.Payment)
	const voidings = one(f.Voiding)
	const disputes = one(f.Dispute)
	const refunds = new Map<string, Array<(typeof f.Refund)[number]>>()
	for (const r of f.Refund) {
		refunds.set(r.invoice, [...(refunds.get(r.invoice) ?? []), r])
	}
	let bill: Array<PlatformFacts> = []
	let billSize = 0
	const flushBill = () => {
		if (bill.length === 0) {
			return
		}
		out.push({
			...noFacts,
			Invoice: Arr.flatMap(bill, (b) => b.Invoice),
			InvoiceLine: Arr.flatMap(bill, (b) => b.InvoiceLine),
			UsageLine: Arr.flatMap(bill, (b) => b.UsageLine),
			PlanLine: Arr.flatMap(bill, (b) => b.PlanLine),
			Allocation: Arr.flatMap(bill, (b) => b.Allocation),
			Payment: Arr.flatMap(bill, (b) => b.Payment),
			Voiding: Arr.flatMap(bill, (b) => b.Voiding),
			Dispute: Arr.flatMap(bill, (b) => b.Dispute),
			Refund: Arr.flatMap(bill, (b) => b.Refund)
		})
		bill = []
		billSize = 0
	}
	for (const invoice of f.Invoice) {
		const part: PlatformFacts = {
			...noFacts,
			Invoice: [invoice],
			InvoiceLine: lines.get(invoice.id) ?? [],
			UsageLine: usageOf.get(invoice.id) ?? [],
			PlanLine: planOf.get(invoice.id) ?? [],
			Allocation: allocationsOf.get(invoice.id) ?? [],
			Payment: Option.toArray(Option.fromUndefinedOr(payments.get(invoice.id))),
			Voiding: Option.toArray(Option.fromUndefinedOr(voidings.get(invoice.id))),
			Dispute: Option.toArray(Option.fromUndefinedOr(disputes.get(invoice.id))),
			Refund: refunds.get(invoice.id) ?? []
		}
		const size = factCount(part)
		if (billSize + size > limit) {
			flushBill()
		}
		bill.push(part)
		billSize += size
	}
	flushBill()
	return out
}

/** Loads a platform's facts through db.apply in batches (see batches); every batch must be accepted. */
export const loadPlatform = (db: PlatformDb, f: PlatformFacts, limit: number) =>
	Effect.forEach(batches(f, limit), (batch) => applyFacts(db, batch), { discard: true })

/** A host value as the literal of `type` it is (a span as its endpoints), or the defect of the test. */
const literalOf = (value: unknown, type: ScalarType, what: string) => {
	const desc =
		(type.carrier === "range4" || type.carrier === "range8") && isRecord(value)
			? { span: value }
			: value
	const decoded = succeeded(
		S.decodeWith(literalDescShape, desc, what),
		`${what} is a Description literal`
	)
	return succeeded(irLiteral(decoded, type), `${what} is a literal of its type`).literal
}

/**
 * The host facts of a relation by declared name: the platform's stored facts, each owner with the count and sums the
 * host draws for its counted families (withDrawn), as a read reads the stored row whole, and DailySpend's refreshed
 * rows.
 */
export type HostFacts = Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>

export const hostFacts = (
	f: PlatformFacts,
	dailySpend: ReadonlyArray<Readonly<Record<string, unknown>>>
): HostFacts => ({
	...Rec.fromEntries([...withDrawn(stateOf(f))]),
	DailySpend: dailySpend
})

/** The relations a checked query reads, with the heading each is read under. */
const baseHeadings = (q: LogicalQuery): ReadonlyMap<string, Heading> => {
	const out = new Map<string, Heading>()
	for (const node of topoOrder(q.dag)) {
		if (node.kind === "Base") {
			out.set(node.relation, node.heading)
		}
	}
	return out
}

/** The reference's input for a checked query over host facts and the caller's parameters by name. */
const referenceOf = (
	q: LogicalQuery,
	facts: HostFacts,
	params: Readonly<Record<string, unknown>>
): Reference => {
	const headings = baseHeadings(q)
	const schema: GenSchema = {
		name: "Platform",
		relations: Arr.map([...headings], ([name, heading]) => ({
			name,
			columns: Arr.map(heading, (c) => ({ name: c.name, type: c.type })),
			primaryKey: [],
			keys: [],
			mutable: false
		})),
		closed: [],
		containments: []
	}
	const valueFacts = Rec.fromEntries(
		Arr.map([...headings], ([name, heading]) => [
			name,
			Arr.map(facts[name] ?? [], (fact) =>
				Arr.map(heading, (c) => literalOf(fact[c.name], c.type, `${name}.${c.name}`))
			)
		])
	)
	const genParams: Record<string, GenParam> = {}
	for (const decl of q.params) {
		const value = params[decl.name]
		if (decl.kind === "relation") {
			const rows = Arr.isArray(value) ? value : []
			genParams[decl.id] = {
				kind: "relation",
				heading: decl.heading,
				rows: Arr.map(rows, (row: unknown) =>
					Arr.map(decl.heading, (c) =>
						literalOf(isRecord(row) ? row[c.name] : undefined, c.type, `${decl.name}.${c.name}`)
					)
				)
			}
		} else {
			genParams[decl.id] = {
				kind: "scalar",
				type: decl.type,
				value: literalOf(value, decl.type, decl.name)
			}
		}
	}
	return Reference.of(q.dag, {
		schema,
		facts: canonicalFacts(valueFacts),
		params: genParams,
		observer: unobserved
	})
}

/** The checked IR of a query over the platform, as the runtime compiles it. */
const checkedOf = (query: unknown): LogicalQuery =>
	succeeded(compileTemplate(query, P.Billing, testCompile), "the workload read compiles").programs
		.checked

/**
 * What a read delivers by the reference, statement by statement, and each attachment's correlation by its name: the
 * parent column each correlation column of its child's heading equals.
 */
export interface Expected {
	readonly statements: ReadonlyArray<ExpectedStatement>
	readonly correlations: ReadonlyMap<
		string,
		ReadonlyArray<{ readonly parent: string; readonly child: string }>
	>
}

export const expectedOf = (
	query: unknown,
	facts: HostFacts,
	params: Readonly<Record<string, unknown>>
): Expected => {
	const q = checkedOf(query)
	const correlations = new Map<
		string,
		ReadonlyArray<{ readonly parent: string; readonly child: string }>
	>()
	for (const node of topoOrder(q.dag)) {
		if (node.kind === "Attach") {
			correlations.set(node.name, node.correlation)
		}
	}
	return {
		statements: expectedStatements(referenceOf(q, facts, params), q.dag.roots[0]),
		correlations
	}
}

/** The rows of DailySpend's definition over the facts: what a refresh stores, by the reference. */
export const dailySpendRows = (
	facts: PlatformFacts
): ReadonlyArray<Readonly<Record<string, unknown>>> => {
	const q = checkedOf(P.dailySpendDefinition)
	const [main] = expectedStatements(referenceOf(q, hostFacts(facts, []), {}), q.dag.roots[0])
	if (main === undefined) {
		return []
	}
	return Arr.map(main.rows, (row) =>
		Rec.fromEntries(Arr.map(main.heading, (c, i) => [c.name, hostOf(row[i], c.type)]))
	)
}

/** A reference value as the host value a fact holds. */
const hostOf = (v: Value | undefined, type: ScalarType): unknown => {
	if (v === undefined) {
		return undefined
	}
	if ((type.carrier === "int2" || type.carrier === "int4") && typeof v === "bigint") {
		return Number(v)
	}
	return v
}

/** A decoded host value as the reference's carrier of `type`. */
const carrier = (type: ScalarType, host: unknown, what: string): Value => {
	switch (type.carrier) {
		case "int2":
		case "int4":
			if (typeof host === "number" && Number.isSafeInteger(host)) {
				return BigInt(host)
			}
			break
		case "int8":
		case "exactInteger":
			if (typeof host === "bigint") {
				return host
			}
			break
		case "numeric":
			if (host instanceof Decimal) {
				return host
			}
			break
		case "uuid":
		case "text":
		case "code":
		case "date":
			if (typeof host === "string") {
				return host
			}
			break
		case "bool":
			if (typeof host === "boolean") {
				return host
			}
			break
		case "range4":
		case "range8":
			if (isRecord(host) && typeof host["start"] === "bigint" && typeof host["end"] === "bigint") {
				return { start: host["start"], end: host["end"] }
			}
			break
		case "float4":
		case "float8":
		case "money":
		case "exactMoney":
		case "vector":
		case "bits":
			break
	}
	throw new Error(`${what}: a ${type.carrier} column delivered ${typeof host} ${String(host)}`)
}

/**
 * The children an attachment delivered under a parent row: an array as is, an Option as its value or none, the one
 * child as itself.
 */
const childrenOf = (delivered: unknown, what: string): ReadonlyArray<unknown> => {
	if (Arr.isArray(delivered)) {
		return delivered
	}
	if (Option.isOption(delivered)) {
		return Option.isSome(delivered) ? [delivered.value] : []
	}
	if (isRecord(delivered)) {
		return [delivered]
	}
	throw new Error(`${what}: an attachment delivered as ${String(delivered)}`)
}

const field = (row: unknown, name: string, what: string): unknown => {
	if (!isRecord(row) || !Rec.has(row, name)) {
		throw new Error(`${what}: a row without ${name}`)
	}
	return row[name]
}

/**
 * The public rows of a read flattened into the reference's statements: the root's rows under the main heading, and for
 * each attachment statement, each parent's key followed by each of its children, the parents of a nested attachment
 * being its parent statement's children. A child's correlation column, which the public child does not repeat, is its
 * parent's column it equals.
 */
export const flattened = (
	expected: Expected,
	rows: ReadonlyArray<unknown>
): ReadonlyArray<ExpectedStatement> => {
	const delivered = new Map<string, ReadonlyArray<unknown>>([["main", rows]])
	return Arr.map(expected.statements, (statement) => {
		if (statement.role !== "attachment") {
			const values = Arr.map(rows, (row) =>
				Arr.map(statement.heading, (c) =>
					carrier(c.type, field(row, c.name, statement.label), statement.label)
				)
			)
			return {
				...statement,
				rows: distinctRows(values, statement.heading, statement.label, new Identities())
			}
		}
		const path = Str.split(statement.label, "/")
		const parentLabel = Arr.join(Arr.initNonEmpty(path), "/")
		const name = Arr.lastNonEmpty(path)
		const correlation = expected.correlations.get(name) ?? []
		const parents = delivered.get(parentLabel) ?? []
		const keys = statement.heading.slice(0, statement.parentKeyWidth)
		const columns = statement.heading.slice(statement.parentKeyWidth)
		const children: Array<unknown> = []
		const out: Array<Row> = []
		for (const parent of parents) {
			const key = Arr.map(keys, (c) =>
				carrier(c.type, field(parent, c.name, statement.label), statement.label)
			)
			for (const child of childrenOf(field(parent, name, statement.label), statement.label)) {
				children.push(child)
				out.push([
					...key,
					...Arr.map(columns, (c) =>
						Option.match(
							Arr.findFirst(correlation, (x) => x.child === c.name),
							{
								onNone: () =>
									carrier(c.type, field(child, c.name, statement.label), statement.label),
								onSome: (x) =>
									carrier(c.type, field(parent, x.parent, statement.label), statement.label)
							}
						)
					)
				])
			}
		}
		delivered.set(statement.label, children)
		return {
			...statement,
			rows: distinctRows(out, statement.heading, statement.label, new Identities())
		}
	})
}

const showValue = (v: Value | undefined): string => {
	if (typeof v === "bigint") {
		return `${v}n`
	}
	if (v instanceof Decimal) {
		return `${v.toString()}d`
	}
	if (isRecord(v) && "start" in v && "end" in v) {
		return `[${Formatter.format(v.start)},${Formatter.format(v.end)})`
	}
	return Formatter.format(v)
}

const showRow = (row: Row): string => `(${Arr.join(Arr.map(row, showValue), ", ")})`

/** Where two deliveries of one read disagree, statement by statement as sets: none when they agree. */
export const differences = (
	expected: Expected,
	actual: ReadonlyArray<ExpectedStatement>
): ReadonlyArray<string> =>
	Arr.flatMap(expected.statements, (e, i) => {
		const a = actual[i]
		if (a === undefined) {
			return [`${e.label}: not delivered`]
		}
		const same = (x: Row, y: Row) =>
			Arr.every(e.heading, (c, j) => {
				const p = x[j]
				const q = y[j]
				return p !== undefined && q !== undefined && equal(p, q, c.type)
			})
		const missing = Arr.filter(e.rows, (x) => !Arr.some(a.rows, (y) => same(x, y)))
		const extra = Arr.filter(a.rows, (y) => !Arr.some(e.rows, (x) => same(x, y)))
		return missing.length === 0 && extra.length === 0
			? []
			: [
					`${e.label} (${Arr.join(
						Arr.map(e.heading, (c) => c.name),
						", "
					)}): missing ${Arr.join(Arr.map(missing, showRow), " ")}; unexpected ${Arr.join(Arr.map(extra, showRow), " ")}`
				]
	})
