/**
 * The platform's laws on the host: every law the platform fixture (test/support/fixtures/api/platform.ts) declares,
 * stated in words over a platform's facts and sharing nothing with grizzle, and what a write does to a state under
 * them. With model.ts's arithmetic this is the host billing model: model.ts says what the application computes, this
 * file what the laws admit.
 *
 * A state is a platform's facts, each relation a set of facts (stateOf). A law is a predicate a state holds or breaks,
 * named by the statement that declares it; a suite reads its law id through the naming door when it compares the law
 * with the one grizzle reported:
 * - a key: no two facts agree on the key's fields; a span key: no two facts agree on its scalar fields while their
 *   spans overlap. A relation's primary key is a span key when one of its fields is a span;
 * - a containment: every source fact's fields, where the source's selection holds, are some target fact's fields where
 *   the target's selection holds;
 * - a coverage: the target facts agreeing with a source fact on its scalar fields cover its span with theirs, which may
 *   abut;
 * - a capacity: for every target fact where its selection holds, the source facts agreeing with it on the paired fields
 *   weigh a sum within its bounds, an empty sum weighing zero;
 * - an alternatives arm: every arm fact's key is the key of a parent fact whose discriminator is the arm's handle; and
 *   the alternatives' reverse law: every parent fact of an armed handle has its arm fact.
 * The contracts' checks (an amount at least zero) and the closed rosters' heads are left out: no write the suites build
 * holds a value outside its contract or its roster.
 *
 * A write is its operations: facts deleted, inserted, and put at their keys. grizzle applies them as sets: the state
 * after is (S \ D \ the facts at the put keys) ∪ I ∪ P. A write that leaves the state as it was is no-change, one whose
 * state after breaks laws is refused by one of them, and any other is accepted. A direct SQL writer's statements run in
 * order, its deletions and then its insertions: keys are checked at each statement, so an insertion at a key a fact
 * already holds, or that two of its own facts share, is refused there by that key; every other law is checked on the
 * state the transaction leaves, at COMMIT or at SET CONSTRAINTS ALL IMMEDIATE.
 */
import { Array as Arr, Order, Record as Rec } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import { contained, on, type Statement, select } from "#compiler/public/schema.ts"
import { defined } from "#test/support/assert.ts"
import * as P from "#test/support/fixtures/api/platform.ts"
import type { LawNames } from "#test/support/kernel/naming.ts"
import { loadOrder, type PlatformFacts } from "#test/support/platform/generate.ts"
import { coveredBy, overlaps, type SpanV, platformSpan } from "#test/support/platform/model.ts"

export type RelationName = (typeof loadOrder)[number]
export type Row = Readonly<Record<string, unknown>>
export type State = ReadonlyMap<RelationName, ReadonlyArray<Row>>

export const stateOf = (facts: PlatformFacts): State =>
	new Map(Arr.map(loadOrder, (r): readonly [RelationName, ReadonlyArray<Row>] => [r, facts[r]]))

export const rowsIn = (s: State, relation: RelationName): ReadonlyArray<Row> =>
	s.get(relation) ?? []

/**
 * A host value's identity: a uuid, enum label or text; an integer, whichever host type carries it; a span by its
 * bounds. Any other value is a defect of the suite that wrote it.
 */
export const valueKey = (v: unknown): string => {
	if (typeof v === "string") {
		return `s${v}`
	}
	if (typeof v === "bigint" || typeof v === "number") {
		return `n${v}`
	}
	if (typeof v === "boolean") {
		return `b${v}`
	}
	const s = spanValue(v)
	return `r${s.start},${s.end}`
}

/** A span value's bounds. */
export const spanValue = (v: unknown): SpanV => {
	if (
		typeof v === "object" &&
		v !== null &&
		"start" in v &&
		"end" in v &&
		(typeof v.start === "bigint" || typeof v.start === "number") &&
		(typeof v.end === "bigint" || typeof v.end === "number")
	) {
		return platformSpan(BigInt(v.start), BigInt(v.end))
	}
	throw new Error(`no platform value: ${String(v)}`)
}

/** An integer value: an amount, a count or a month. */
const amountValue = (v: unknown): bigint => {
	if (typeof v === "bigint") {
		return v
	}
	if (typeof v === "number" && Number.isSafeInteger(v)) {
		return BigInt(v)
	}
	throw new Error(`no integer: ${String(v)}`)
}

const tupleKey = (row: Row, fields: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(fields, (f) => valueKey(row[f])),
		"|"
	)

/** A fact's identity: every field's value. */
const rowKey = (row: Row): string =>
	Arr.join(
		Arr.map(Arr.sort(Rec.keys(row), Order.String), (f) => `${f}=${valueKey(row[f])}`),
		";"
	)

const keySet = (rows: ReadonlyArray<Row>): ReadonlySet<string> => new Set(Arr.map(rows, rowKey))

/** Where two states differ, relation by relation as sets of facts, or undefined when they agree. */
const stateDifference = (a: State, b: State): string | undefined => {
	for (const relation of loadOrder) {
		const left = keySet(rowsIn(a, relation))
		const right = keySet(rowsIn(b, relation))
		const missing = Arr.filter([...left], (k) => !right.has(k))
		const extra = Arr.filter([...right], (k) => !left.has(k))
		if (missing.length > 0 || extra.length > 0) {
			return `${relation}: only in the first [${Arr.join(missing, " / ")}], only in the second [${Arr.join(extra, " / ")}]`
		}
	}
	return undefined
}

export type LawFamily =
	| "key"
	| "span key"
	| "containment"
	| "coverage"
	| "capacity"
	| "arm"
	| "reverse"

export interface HostLaw {
	readonly name: string
	readonly family: LawFamily
	/** The relations whose facts it reads. */
	readonly relations: ReadonlyArray<RelationName>
	/** A key is checked at each statement; every other law on the state a transaction leaves. */
	readonly immediate: boolean
	readonly id: (names: LawNames) => LawId
	readonly broken: (s: State) => boolean
}

/** A law's side: a relation's fields, where its selection (field = label) holds. */
interface Side {
	readonly relation: RelationName
	readonly fields: ReadonlyArray<string>
	readonly where: Readonly<Record<string, string>>
}

const side = (relation: RelationName, ...fields: ReadonlyArray<string>): Side => ({
	relation,
	fields,
	where: {}
})

const selected = (
	relation: RelationName,
	where: Readonly<Record<string, string>>,
	...fields: ReadonlyArray<string>
): Side => ({
	relation,
	fields,
	where
})

const rowsOf = (s: State, at: Side): ReadonlyArray<Row> =>
	Arr.filter(rowsIn(s, at.relation), (row) =>
		Arr.every(Rec.toEntries(at.where), ([f, label]) => row[f] === label)
	)

/** Two rows of `rows` agreeing on `fields` (span keys: overlapping on `spanField` too). */
const keyBroken = (rows: ReadonlyArray<Row>, fields: ReadonlyArray<string>): boolean =>
	new Set(Arr.map(rows, (row) => tupleKey(row, fields))).size !== rows.length

const spanKeyBroken = (
	rows: ReadonlyArray<Row>,
	scalars: ReadonlyArray<string>,
	spanField: string
): boolean => {
	const groups = new Map<string, Array<SpanV>>()
	for (const row of rows) {
		const k = tupleKey(row, scalars)
		const spans = groups.get(k) ?? []
		groups.set(k, spans)
		spans.push(spanValue(row[spanField]))
	}
	return Arr.some([...groups.values()], (spans) =>
		Arr.some(spans, (a, i) => Arr.some(spans, (b, j) => i < j && overlaps(a, b)))
	)
}

const containBroken = (s: State, source: Side, target: Side): boolean => {
	const held = new Set(Arr.map(rowsOf(s, target), (row) => tupleKey(row, target.fields)))
	return Arr.some(rowsOf(s, source), (row) => !held.has(tupleKey(row, source.fields)))
}

/** The source's last field and the target's are the spans; the fields before them pair the facts. */
const coverBroken = (s: State, source: Side, target: Side): boolean => {
	const scalars = (at: Side) => at.fields.slice(0, -1)
	const spanField = (at: Side) =>
		defined(at.fields[at.fields.length - 1], `${at.relation}'s span field`)
	const spans = new Map<string, Array<SpanV>>()
	for (const row of rowsOf(s, target)) {
		const k = tupleKey(row, scalars(target))
		const list = spans.get(k) ?? []
		spans.set(k, list)
		list.push(spanValue(row[spanField(target)]))
	}
	return Arr.some(
		rowsOf(s, source),
		(row) =>
			!coveredBy(spans.get(tupleKey(row, scalars(source))) ?? [], spanValue(row[spanField(source)]))
	)
}

/** A capacity's bound: zero, or a field of the target fact. */
type Bound = { readonly kind: "zero" } | { readonly kind: "field"; readonly field: string }
const zero: Bound = { kind: "zero" }
const field = (name: string): Bound => ({ kind: "field", field: name })
const boundOf = (b: Bound, row: Row): bigint => (b.kind === "zero" ? 0n : amountValue(row[b.field]))

const capacityBroken = (
	s: State,
	target: Side,
	source: Side,
	weight: string,
	low: Bound,
	high: Bound
): boolean => {
	const sums = new Map<string, bigint>()
	for (const row of rowsOf(s, source)) {
		const k = tupleKey(row, source.fields)
		sums.set(k, (sums.get(k) ?? 0n) + amountValue(row[weight]))
	}
	return Arr.some(rowsOf(s, target), (row) => {
		const sum = sums.get(tupleKey(row, target.fields)) ?? 0n
		return sum < boundOf(low, row) || sum > boundOf(high, row)
	})
}

/** A relation's primary key: its fields, or its scalar fields and its span field. */
type PrimaryKey =
	| { readonly kind: "key"; readonly fields: ReadonlyArray<string> }
	| { readonly kind: "span key"; readonly scalars: ReadonlyArray<string>; readonly span: string }

const pk = (...fields: ReadonlyArray<string>): PrimaryKey => ({ kind: "key", fields })
const spanPk = (spanField: string, ...scalars: ReadonlyArray<string>): PrimaryKey => ({
	kind: "span key",
	scalars,
	span: spanField
})

const primaryKeys: Readonly<Record<RelationName, PrimaryKey>> = {
	Month: pk("month"),
	Day: pk("day"),
	Org: pk("id"),
	ParentOrg: pk("child"),
	Workspace: pk("id"),
	WorkspaceLimit: pk("workspace", "month"),
	ApiKey: pk("id"),
	Revocation: pk("key"),
	ApiKeyActive: spanPk("during", "key"),
	Provider: pk("id"),
	Model: pk("id"),
	Route: pk("model", "provider"),
	ProviderPrice: spanPk("during", "provider", "model", "kind"),
	RateCard: pk("id"),
	RateTier: spanPk("tier", "card"),
	CreditGrant: pk("id"),
	Subscription: pk("id"),
	Segment: spanPk("during", "subscription"),
	UsageEvent: pk("id"),
	EventCharge: pk("event"),
	UsageCharge: pk("event", "kind"),
	ProviderCost: pk("event"),
	CreditDebit: pk("grant", "event", "kind"),
	Invoice: pk("id"),
	InvoiceLine: pk("id"),
	UsageLine: pk("line"),
	PlanLine: pk("line"),
	Allocation: spanPk("during", "line"),
	Payment: pk("invoice"),
	Voiding: pk("invoice"),
	Dispute: pk("invoice"),
	Refund: pk("id")
}

/** The fields a put replaces the fact at. */
const keyFieldsOf = (relation: RelationName): ReadonlyArray<string> => {
	const key = primaryKeys[relation]
	return key.kind === "key" ? key.fields : [...key.scalars, key.span]
}

const primaryKeyLaw = (relation: RelationName): HostLaw => {
	const key = primaryKeys[relation]
	return {
		name: `${relation}'s primary key`,
		family: key.kind,
		relations: [relation],
		immediate: true,
		id: (names) => names.primaryKeyLaw({ name: relation }),
		broken: (s) =>
			key.kind === "key"
				? keyBroken(rowsIn(s, relation), key.fields)
				: spanKeyBroken(rowsIn(s, relation), key.scalars, key.span)
	}
}

const spanKey = (
	name: string,
	statement: Statement,
	relation: RelationName,
	scalars: ReadonlyArray<string>,
	spanField: string
): HostLaw => ({
	name,
	family: "span key",
	relations: [relation],
	immediate: true,
	id: (names) => names.lawOf(statement),
	broken: (s) => spanKeyBroken(rowsIn(s, relation), scalars, spanField)
})

const containment = (name: string, statement: Statement, source: Side, target: Side): HostLaw => ({
	name,
	family: "containment",
	relations: [source.relation, target.relation],
	immediate: false,
	id: (names) => names.lawOf(statement),
	broken: (s) => containBroken(s, source, target)
})

/** A containment declared in the schema's list, named by its sides. */
const contains = (statement: Statement, source: Side, target: Side): HostLaw =>
	containment(
		`${source.relation}(${Arr.join(source.fields, ", ")}) in ${target.relation}(${Arr.join(target.fields, ", ")})`,
		statement,
		source,
		target
	)

const coverage = (name: string, statement: Statement, source: Side, target: Side): HostLaw => ({
	name,
	family: "coverage",
	relations: [source.relation, target.relation],
	immediate: false,
	id: (names) => names.lawOf(statement),
	broken: (s) => coverBroken(s, source, target)
})

const capacity = (
	name: string,
	statement: Statement,
	target: Side,
	source: Side,
	weight: string,
	low: Bound,
	high: Bound
): HostLaw => ({
	name,
	family: "capacity",
	relations: [target.relation, source.relation],
	immediate: false,
	id: (names) => names.lawOf(statement),
	broken: (s) => capacityBroken(s, target, source, weight, low, high)
})

/**
 * An alternatives statement's laws: each arm's key into its parent's facts of the arm's handle, and the reverse law,
 * every parent fact of an armed handle obliged to its arm fact.
 */
const alternativesLaws = (
	name: string,
	value: Parameters<LawNames["alternativesOf"]>[0],
	parent: RelationName,
	discriminator: string,
	armed: ReadonlyArray<{
		readonly handle: string
		readonly arm: RelationName
		readonly key: string
	}>
): ReadonlyArray<HostLaw> => [
	...Arr.map(armed, ({ handle, arm, key }): HostLaw => ({
		name: `${name}: a ${arm} only of a ${handle} ${parent}`,
		family: "arm",
		relations: [arm, parent],
		immediate: false,
		id: (names) => defined(names.alternativesOf(value).arms[handle], `the ${handle} arm's law`),
		broken: (s) =>
			containBroken(s, side(arm, key), selected(parent, { [discriminator]: handle }, "id"))
	})),
	{
		name: `${name}: every armed ${parent} has its arm`,
		family: "reverse",
		relations: [parent, ...Arr.map(armed, (a) => a.arm)],
		immediate: false,
		id: (names) => names.alternativesOf(value).reverse,
		broken: (s) =>
			Arr.some(armed, ({ handle, arm, key }) =>
				containBroken(s, selected(parent, { [discriminator]: handle }, "id"), side(arm, key))
			)
	}
]

/** Every law the platform declares, in the order the fixture states them. */
export const platformLaws: ReadonlyArray<HostLaw> = [
	...Arr.map(loadOrder, (relation) => primaryKeyLaw(relation)),
	spanKey("rateInForce", P.rateInForce, "RateCard", ["model", "kind"], "during"),
	spanKey("invoicePeriods", P.invoicePeriods, "Invoice", ["org"], "period"),
	spanKey("dayOfSpan", P.dayOfSpan, "Day", [], "during"),
	spanKey("monthOfSpan", P.monthOfSpan, "Month", [], "during"),
	spanKey("grantValidity", P.grantValidity, "CreditGrant", ["id"], "valid"),
	contains(
		contained(on(P.ParentOrg, "child"), on(P.Org, "id")),
		side("ParentOrg", "child"),
		side("Org", "id")
	),
	contains(
		contained(on(P.ParentOrg, "parent"), on(P.Org, "id")),
		side("ParentOrg", "parent"),
		side("Org", "id")
	),
	contains(
		contained(on(P.Workspace, "org"), on(P.Org, "id")),
		side("Workspace", "org"),
		side("Org", "id")
	),
	contains(
		contained(on(P.ApiKey, "workspace"), on(P.Workspace, "id")),
		side("ApiKey", "workspace"),
		side("Workspace", "id")
	),
	contains(
		contained(on(P.ApiKeyActive, "key"), on(P.ApiKey, "id")),
		side("ApiKeyActive", "key"),
		side("ApiKey", "id")
	),
	contains(
		contained(on(P.Route, "model"), on(P.Model, "id")),
		side("Route", "model"),
		side("Model", "id")
	),
	contains(
		contained(on(P.Route, "provider"), on(P.Provider, "id")),
		side("Route", "provider"),
		side("Provider", "id")
	),
	contains(
		contained(on(P.ProviderPrice, "model", "provider"), on(P.Route, "model", "provider")),
		side("ProviderPrice", "model", "provider"),
		side("Route", "model", "provider")
	),
	contains(
		contained(on(P.RateCard, "model"), on(P.Model, "id")),
		side("RateCard", "model"),
		side("Model", "id")
	),
	contains(
		contained(on(P.RateTier, "card"), on(P.RateCard, "id")),
		side("RateTier", "card"),
		side("RateCard", "id")
	),
	contains(
		contained(on(P.UsageEvent, "model", "provider"), on(P.Route, "model", "provider")),
		side("UsageEvent", "model", "provider"),
		side("Route", "model", "provider")
	),
	coverage(
		"usageWhileActive",
		P.usageWhileActive,
		side("UsageEvent", "key", "during"),
		side("ApiKeyActive", "key", "during")
	),
	coverage(
		"pricedByCard",
		P.pricedByCard,
		side("UsageCharge", "model", "kind", "priced"),
		side("RateCard", "model", "kind", "during")
	),
	contains(
		contained(on(P.UsageCharge, "event"), on(P.EventCharge, "event")),
		side("UsageCharge", "event"),
		side("EventCharge", "event")
	),
	contains(
		contained(on(P.EventCharge, "event"), on(P.UsageEvent, "id")),
		side("EventCharge", "event"),
		side("UsageEvent", "id")
	),
	contains(
		contained(on(P.EventCharge, "workspace"), on(P.Workspace, "id")),
		side("EventCharge", "workspace"),
		side("Workspace", "id")
	),
	contains(
		contained(on(P.EventCharge, "workspace", "month"), on(P.WorkspaceLimit, "workspace", "month")),
		side("EventCharge", "workspace", "month"),
		side("WorkspaceLimit", "workspace", "month")
	),
	contains(
		contained(on(P.ProviderCost, "event"), on(P.UsageEvent, "id")),
		side("ProviderCost", "event"),
		side("UsageEvent", "id")
	),
	contains(
		contained(on(P.CreditGrant, "org"), on(P.Org, "id")),
		side("CreditGrant", "org"),
		side("Org", "id")
	),
	contains(
		contained(on(P.CreditDebit, "grant"), on(P.CreditGrant, "id")),
		side("CreditDebit", "grant"),
		side("CreditGrant", "id")
	),
	contains(
		contained(on(P.CreditDebit, "event", "kind"), on(P.UsageCharge, "event", "kind")),
		side("CreditDebit", "event", "kind"),
		side("UsageCharge", "event", "kind")
	),
	coverage(
		"debitWhileValid",
		P.debitWhileValid,
		side("CreditDebit", "grant", "during"),
		side("CreditGrant", "id", "valid")
	),
	contains(
		contained(on(P.WorkspaceLimit, "workspace"), on(P.Workspace, "id")),
		side("WorkspaceLimit", "workspace"),
		side("Workspace", "id")
	),
	contains(
		contained(on(P.WorkspaceLimit, "month"), on(P.Month, "month")),
		side("WorkspaceLimit", "month"),
		side("Month", "month")
	),
	contains(
		contained(on(P.Day, "month"), on(P.Month, "month")),
		side("Day", "month"),
		side("Month", "month")
	),
	contains(
		contained(on(P.Invoice, "org"), on(P.Org, "id")),
		side("Invoice", "org"),
		side("Org", "id")
	),
	contains(
		contained(on(P.InvoiceLine, "invoice"), on(P.Invoice, "id")),
		side("InvoiceLine", "invoice"),
		side("Invoice", "id")
	),
	contains(
		contained(on(P.UsageLine, "model"), on(P.Model, "id")),
		side("UsageLine", "model"),
		side("Model", "id")
	),
	contains(
		contained(on(P.PlanLine, "subscription"), on(P.Subscription, "id")),
		side("PlanLine", "subscription"),
		side("Subscription", "id")
	),
	contains(
		contained(on(P.Subscription, "org"), on(P.Org, "id")),
		side("Subscription", "org"),
		side("Org", "id")
	),
	contains(
		contained(on(P.Segment, "subscription"), on(P.Subscription, "id")),
		side("Segment", "subscription"),
		side("Subscription", "id")
	),
	contains(
		contained(on(P.Refund, "invoice"), on(P.Invoice, "id")),
		side("Refund", "invoice"),
		side("Invoice", "id")
	),
	contains(
		contained(on(P.Allocation, "line", "subscription"), on(P.PlanLine, "line", "subscription")),
		side("Allocation", "line", "subscription"),
		side("PlanLine", "line", "subscription")
	),
	contains(
		contained(
			on(P.Allocation, "line"),
			on(
				select(P.InvoiceLine, (r) => r.eq(r.source, "plan")),
				"id"
			)
		),
		side("Allocation", "line"),
		selected("InvoiceLine", { source: "plan" }, "id")
	),
	coverage(
		"allocationCovered",
		P.allocationCovered,
		side("Allocation", "subscription", "during"),
		side("Segment", "subscription", "during")
	),
	capacity(
		"chargeExact",
		P.chargeExact,
		side("EventCharge", "event"),
		side("UsageCharge", "event"),
		"amount",
		field("amount"),
		field("amount")
	),
	capacity(
		"creditedExact",
		P.creditedExact,
		side("UsageCharge", "event", "kind"),
		side("CreditDebit", "event", "kind"),
		"amount",
		field("credited"),
		field("credited")
	),
	capacity(
		"creditedWithinCharge",
		P.creditedWithinCharge,
		side("UsageCharge", "event", "kind"),
		side("UsageCharge", "event", "kind"),
		"credited",
		zero,
		field("amount")
	),
	capacity(
		"grantWithinAmount",
		P.grantWithinAmount,
		side("CreditGrant", "id"),
		side("CreditDebit", "grant"),
		"amount",
		zero,
		field("amount")
	),
	capacity(
		"spendWithinCap",
		P.spendWithinCap,
		side("WorkspaceLimit", "workspace", "month"),
		side("EventCharge", "workspace", "month"),
		"amount",
		zero,
		field("cap")
	),
	capacity(
		"invoiceExact",
		P.invoiceExact,
		side("Invoice", "id"),
		side("InvoiceLine", "invoice"),
		"amount",
		field("amount"),
		field("amount")
	),
	capacity(
		"allocationExact",
		P.allocationExact,
		selected("InvoiceLine", { source: "plan" }, "id"),
		side("Allocation", "line"),
		"amount",
		field("amount"),
		field("amount")
	),
	capacity(
		"refundWithinInvoice",
		P.refundWithinInvoice,
		side("Invoice", "id"),
		side("Refund", "invoice"),
		"amount",
		zero,
		field("amount")
	),
	containment(
		"refundOnlyPaid",
		P.refundOnlyPaid,
		side("Refund", "invoice"),
		selected("Invoice", { state: "paid" }, "id")
	),
	...alternativesLaws("keyRevocation", P.keyRevocation, "ApiKey", "state", [
		{ handle: "revoked", arm: "Revocation", key: "key" }
	]),
	...alternativesLaws("invoiceSettlement", P.invoiceSettlement, "Invoice", "state", [
		{ handle: "paid", arm: "Payment", key: "invoice" },
		{ handle: "void", arm: "Voiding", key: "invoice" },
		{ handle: "disputed", arm: "Dispute", key: "invoice" }
	]),
	...alternativesLaws("lineDetail", P.lineDetail, "InvoiceLine", "source", [
		{ handle: "usage", arm: "UsageLine", key: "line" },
		{ handle: "plan", arm: "PlanLine", key: "line" }
	])
]

/** The laws a state breaks. */
const brokenLaws = (s: State): ReadonlyArray<HostLaw> =>
	Arr.filter(platformLaws, (law) => law.broken(s))

/** Every law by the id the naming door gives it; two laws of one id are a defect of this table. */
export const lawsById = (names: LawNames): ReadonlyMap<LawId, HostLaw> => {
	const out = new Map<LawId, HostLaw>()
	for (const law of platformLaws) {
		const id = law.id(names)
		const known = out.get(id)
		if (known !== undefined) {
			throw new Error(`${law.name} and ${known.name} are one law, ${id}`)
		}
		out.set(id, law)
	}
	return out
}

/** Facts of one relation deleted, inserted, or put at their keys. */
export interface PlatformOp {
	readonly kind: "delete" | "insert" | "put"
	readonly relation: RelationName
	readonly facts: ReadonlyArray<Row>
}

/** An exact deletion of facts of one relation, typed by the relation. */
export const deleteOp: <K extends RelationName>(
	relation: K,
	facts: PlatformFacts[K]
) => PlatformOp = (relation: RelationName, facts: ReadonlyArray<Row>): PlatformOp => ({
	kind: "delete",
	relation,
	facts
})

/** An insertion of facts of one relation, typed by the relation. */
export const insertOp: <K extends RelationName>(
	relation: K,
	facts: PlatformFacts[K]
) => PlatformOp = (relation: RelationName, facts: ReadonlyArray<Row>): PlatformOp => ({
	kind: "insert",
	relation,
	facts
})

/** A put of facts of one relation, typed by the relation. */
export const putOp: <K extends RelationName>(relation: K, facts: PlatformFacts[K]) => PlatformOp = (
	relation: RelationName,
	facts: ReadonlyArray<Row>
): PlatformOp => ({
	kind: "put",
	relation,
	facts
})

/** What a write decided on a state. */
export type Decision =
	| { readonly kind: "accepted"; readonly after: State }
	| { readonly kind: "no-change" }
	| { readonly kind: "refused"; readonly laws: ReadonlyArray<HostLaw> }

const withRows = (s: State, relation: RelationName, rows: ReadonlyArray<Row>): State =>
	new Map([...s, [relation, rows]])

/** The state grizzle's operations leave, as sets (see the header). */
const applied = (s: State, ops: ReadonlyArray<PlatformOp>): State => {
	let out = s
	for (const relation of loadOrder) {
		const mine = Arr.filter(ops, (o) => o.relation === relation)
		if (mine.length === 0) {
			continue
		}
		const of = (kind: PlatformOp["kind"]): ReadonlyArray<Row> =>
			Arr.flatMap(
				Arr.filter(mine, (o: PlatformOp) => o.kind === kind),
				(o: PlatformOp) => o.facts
			)
		const deleted = keySet(of("delete"))
		const key = keyFieldsOf(relation)
		const putKeys = new Set(Arr.map(of("put"), (f) => tupleKey(f, key)))
		const kept = Arr.filter(
			rowsIn(s, relation),
			(row) => !deleted.has(rowKey(row)) && !putKeys.has(tupleKey(row, key))
		)
		const rows = new Map(Arr.map(kept, (row): [string, Row] => [rowKey(row), row]))
		for (const row of [...of("insert"), ...of("put")]) {
			rows.set(rowKey(row), row)
		}
		out = withRows(out, relation, [...rows.values()])
	}
	return out
}

/** What grizzle decides of a write's operations on a state. */
export const decideSet = (s: State, ops: ReadonlyArray<PlatformOp>): Decision => {
	const after = applied(s, ops)
	if (stateDifference(s, after) === undefined) {
		return { kind: "no-change" }
	}
	const broken = brokenLaws(after)
	return broken.length === 0 ? { kind: "accepted", after } : { kind: "refused", laws: broken }
}

/** A direct writer's statement: facts of one relation deleted exactly, or inserted. */
export interface DirectStatement {
	readonly kind: "delete" | "insert"
	readonly relation: RelationName
	readonly facts: ReadonlyArray<Row>
}

/**
 * What a direct writer's statements decide on a state, in order: a direct transaction commits or is refused, so a
 * commit that changes nothing is accepted too. The state is a bag: an inserted fact equal to a stored one is a second
 * fact at its key.
 */
export const decideStatements = (
	s: State,
	statements: ReadonlyArray<DirectStatement>
): Decision => {
	let at = s
	for (const statement of statements) {
		const rows = rowsIn(at, statement.relation)
		if (statement.kind === "delete") {
			const gone = keySet(statement.facts)
			at = withRows(
				at,
				statement.relation,
				Arr.filter(rows, (row) => !gone.has(rowKey(row)))
			)
			continue
		}
		at = withRows(at, statement.relation, [...rows, ...statement.facts])
		const keys = Arr.filter(
			platformLaws,
			(law) => law.immediate && law.relations.includes(statement.relation)
		)
		const broken = Arr.filter(keys, (law) => law.broken(at))
		if (broken.length > 0) {
			return { kind: "refused", laws: broken }
		}
	}
	const broken = brokenLaws(at)
	return broken.length === 0 ? { kind: "accepted", after: at } : { kind: "refused", laws: broken }
}
