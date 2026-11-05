/**
 * The platform's laws on the host: every law the platform fixture (test/support/fixtures/api/platform.ts) declares,
 * stated in words over a platform's facts and sharing nothing with grizzle, and what a write does to a state under
 * them. With model.ts's arithmetic this is the host billing model: model.ts says what the application computes, this
 * file what the laws admit.
 *
 * A state is a platform's facts, each relation a set of facts as its caller writes them (stateOf): no count or sum a
 * counted family draws is a fact's field, so every sum below is the host's own, over the members' rows, each counted
 * once by its key. A law is a predicate a state holds or breaks, named by the statement that declares it; a suite reads
 * its law id through the naming door when it compares the law with the one grizzle reported:
 * - a key: no two facts agree on the key's fields; a span key: no two facts agree on its scalar fields while their
 *   spans overlap. A relation's primary key is a span key when one of its fields is a span;
 * - a containment: every source fact's fields, where the source's selection holds, are some target fact's fields where
 *   the target's selection holds;
 * - a coverage: the target facts agreeing with a source fact on its scalar fields cover its span with theirs, which may
 *   abut;
 * - a counted family: every member's group fields are the key of some owner fact (its owner axis);
 * - a fold: each owner's accumulator is the sum of its members' step values. grizzle accumulates it from the members'
 *   rows, so the rows a write states never break it; a refusal names it only beside its family's law (the predecessor
 *   and last axes carry both), which judges it;
 * - a check: every fact of its relation holds its predicate, which over an owner reads its family's sum, the sum of its
 *   members' step values, an empty family's zero;
 * - an alternatives arm: every arm fact's key is the key of a parent fact whose discriminator is the arm's handle; and
 *   each armed handle's reverse law: every parent fact of that handle has its arm fact.
 * The contracts' checks (an amount at least zero) and the closed rosters' heads are left out: no write the suites build
 * holds a value outside its contract or its roster.
 *
 * A write is its operations: facts deleted, inserted, and put at their keys. grizzle applies them as sets: the state
 * after is (S \ D \ the facts at the put keys) ∪ I ∪ P. A write that leaves the state as it was is no-change, one whose
 * state after breaks laws is refused by one of them, and any other is accepted. A direct SQL writer's statements run in
 * order, its deletions and then its puts and insertions, a put replacing the fact at its key. Some laws are checked at
 * each statement on a relation they name (a law's checkedAt): keys and row checks at their relation's, a family's owner
 * axis (a foreign key no family defers) at its member's and its owner's, and a sum check at its member's, which writes
 * the owner's end. So an insertion at a key a fact already holds or that two of its own facts share, a fact its own
 * check refuses, a member inserted before its owner, an owner deleted from under its members and a member past its
 * owner's bound are refused there by that law; every other law is checked on the state the transaction leaves, at
 * COMMIT or at SET CONSTRAINTS ALL IMMEDIATE.
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
export type PlatformRow = Readonly<Record<string, unknown>>
export type State = ReadonlyMap<RelationName, ReadonlyArray<PlatformRow>>

export const stateOf = (facts: PlatformFacts): State =>
	new Map(
		Arr.map(loadOrder, (r): readonly [RelationName, ReadonlyArray<PlatformRow>] => [r, facts[r]])
	)

export const rowsIn = (s: State, relation: RelationName): ReadonlyArray<PlatformRow> =>
	s.get(relation) ?? []

/**
 * A host value's identity: a uuid, enum label or text; an integer, whichever host type carries it; a span by its
 * bounds. Any other value is a defect of the suite that wrote it.
 */
export const hostValueKey = (v: unknown): string => {
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

const tupleKey = (row: PlatformRow, fields: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(fields, (f) => hostValueKey(row[f])),
		"|"
	)

/** A fact's identity: every field's value. */
const rowKey = (row: PlatformRow): string =>
	Arr.join(
		Arr.map(Arr.sort(Rec.keys(row), Order.String), (f) => `${f}=${hostValueKey(row[f])}`),
		";"
	)

const keySet = (rows: ReadonlyArray<PlatformRow>): ReadonlySet<string> =>
	new Set(Arr.map(rows, rowKey))

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
	| "family"
	| "fold"
	| "check"
	| "arm"
	| "reverse"

export interface HostLaw {
	readonly name: string
	readonly family: LawFamily
	/** The relations whose facts it reads. */
	readonly relations: ReadonlyArray<RelationName>
	/**
	 * The relations a direct statement on which checks the law there (a key's, a row check's, a family's member and
	 * owner, a sum check's member, whose statement rewrites the owner's end); none for a law checked on the state a
	 * transaction leaves.
	 */
	readonly checkedAt: ReadonlyArray<RelationName>
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

const rowsOf = (s: State, at: Side): ReadonlyArray<PlatformRow> =>
	Arr.filter(rowsIn(s, at.relation), (row) =>
		Arr.every(Rec.toEntries(at.where), ([f, label]) => row[f] === label)
	)

/** Two rows of `rows` agreeing on `fields` (span keys: overlapping on `spanField` too). */
const keyBroken = (rows: ReadonlyArray<PlatformRow>, fields: ReadonlyArray<string>): boolean =>
	new Set(Arr.map(rows, (row) => tupleKey(row, fields))).size !== rows.length

const spanKeyBroken = (
	rows: ReadonlyArray<PlatformRow>,
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

/**
 * A counted family on the host: the facts of `member`, each in the group of the owner fact whose key fields `key` its
 * group fields `group` equal, pair by pair; the owner's `count` field, and the end of its sum fold, the sum of the
 * members' `step`.
 */
interface Counted {
	readonly member: RelationName
	readonly group: ReadonlyArray<string>
	readonly owner: RelationName
	readonly key: ReadonlyArray<string>
	readonly count: string
	readonly sum: { readonly step: string; readonly end: string }
}

const counted = (
	member: RelationName,
	group: ReadonlyArray<string>,
	owner: RelationName,
	key: ReadonlyArray<string>,
	count: string,
	sum: Counted["sum"]
): Counted => ({ member, group, owner, key, count, sum })

/**
 * Each owner's sum of its members' `value`, by the owner's key: a sum over the members' facts, each counted once, an
 * owner no member names absent (its sum is zero).
 */
const sumsOf = (s: State, f: Counted, value: string): ReadonlyMap<string, bigint> => {
	const sums = new Map<string, bigint>()
	for (const row of rowsIn(s, f.member)) {
		const k = tupleKey(row, f.group)
		sums.set(k, (sums.get(k) ?? 0n) + amountValue(row[value]))
	}
	return sums
}

/** The family's sums, read at one owner fact. */
const sumAt = (sums: ReadonlyMap<string, bigint>, f: Counted, owner: PlatformRow): bigint =>
	sums.get(tupleKey(owner, f.key)) ?? 0n

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
		checkedAt: [relation],
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
	checkedAt: [relation],
	id: (names) => names.lawOf(statement),
	broken: (s) => spanKeyBroken(rowsIn(s, relation), scalars, spanField)
})

const containment = (name: string, statement: Statement, source: Side, target: Side): HostLaw => ({
	name,
	family: "containment",
	relations: [source.relation, target.relation],
	checkedAt: [],
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
	checkedAt: [],
	id: (names) => names.lawOf(statement),
	broken: (s) => coverBroken(s, source, target)
})

/**
 * A counted family's law: every member's group is its owner's key. grizzle draws every slot, count and copy from the
 * members' rows, so of the family's law only the owner axis is the rows' to break; no family defers it, so a direct
 * writer meets it at each statement on the member or the owner: a member inserted before its owner, an owner deleted
 * from under its members.
 */
const family = (name: string, statement: Statement, f: Counted): HostLaw => ({
	name,
	family: "family",
	relations: [f.member, f.owner],
	checkedAt: [f.member, f.owner],
	id: (names) => names.lawOf(statement),
	broken: (s) =>
		containBroken(
			s,
			{ relation: f.member, fields: f.group, where: {} },
			{ relation: f.owner, fields: f.key, where: {} }
		)
})

/**
 * A sum fold's law: each owner's accumulator is its members' sum. grizzle accumulates it from the members' rows, so no
 * state of rows breaks it; a refusal names it beside its family's law, which judges that refusal.
 */
const sumFold = (name: string, statement: Statement, f: Counted): HostLaw => ({
	name,
	family: "fold",
	relations: [f.member, f.owner],
	checkedAt: [],
	id: (names) => names.lawOf(statement),
	broken: () => false
})

/**
 * A row check over an owner that reads its family's sum: every owner fact holds `holds` of itself and that sum. PostgreSQL checks it where the owner's end is written: at a member's statement, which appends to a stored owner
 * and rewrites its end, or at the insertion of an owner the transaction inserts with its members, its end their sum
 * already. Either way it is judged on the host after the members' statement, and at commit.
 */
const sumCheck = (
	name: string,
	statement: Statement,
	f: Counted,
	holds: (owner: PlatformRow, sum: bigint) => boolean
): HostLaw => ({
	name,
	family: "check",
	relations: [f.owner, f.member],
	checkedAt: [f.member],
	id: (names) => names.lawOf(statement),
	broken: (s) => {
		const sums = sumsOf(s, f, f.sum.step)
		return Arr.some(rowsIn(s, f.owner), (row) => !holds(row, sumAt(sums, f, row)))
	}
})

/** A row check over a relation's own fields: every fact holds `holds`, checked at each statement. */
const rowCheck = (
	name: string,
	statement: Statement,
	relation: RelationName,
	holds: (row: PlatformRow) => boolean
): HostLaw => ({
	name,
	family: "check",
	relations: [relation],
	checkedAt: [relation],
	id: (names) => names.lawOf(statement),
	broken: (s) => Arr.some(rowsIn(s, relation), (row) => !holds(row))
})

/** An integer field of a fact. */
const amountOf = (row: PlatformRow, field: string): bigint => amountValue(row[field])

/**
 * An alternatives statement's laws: each arm's key into its parent's facts of the arm's handle, and each armed handle's
 * reverse law, every parent fact of that handle obliged to its arm fact.
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
		checkedAt: [],
		id: (names) => defined(names.alternativesOf(value).arms[handle], `the ${handle} arm's law`),
		broken: (s) =>
			containBroken(s, side(arm, key), selected(parent, { [discriminator]: handle }, "id"))
	})),
	...Arr.map(armed, ({ handle, arm, key }): HostLaw => ({
		name: `${name}: every ${handle} ${parent} has its ${arm}`,
		family: "reverse",
		relations: [parent, arm],
		checkedAt: [],
		id: (names) =>
			defined(names.alternativesOf(value).reverse[handle], `the ${handle} reverse law`),
		broken: (s) =>
			containBroken(s, selected(parent, { [discriminator]: handle }, "id"), side(arm, key))
	}))
]

/**
 * The platform's counted families, as the fixture states them: the member and its group, the owner and its key, the
 * owner's count, and the sum its fold accumulates.
 */
const eventCharges = counted("UsageCharge", ["event"], "EventCharge", ["event"], "charges", {
	step: "amount",
	end: "charged"
})
const chargeDebits = counted(
	"CreditDebit",
	["event", "kind"],
	"UsageCharge",
	["event", "kind"],
	"debits",
	{ step: "amount", end: "debited" }
)
const grantDebits = counted("CreditDebit", ["grant"], "CreditGrant", ["id"], "debits", {
	step: "amount",
	end: "debited"
})
const limitCharges = counted(
	"EventCharge",
	["workspace", "month"],
	"WorkspaceLimit",
	["workspace", "month"],
	"charges",
	{ step: "amount", end: "spent" }
)
const invoiceLines = counted("InvoiceLine", ["invoice"], "Invoice", ["id"], "lines", {
	step: "amount",
	end: "billed"
})
const lineAllocations = counted("Allocation", ["line"], "InvoiceLine", ["id"], "allocations", {
	step: "amount",
	end: "allocated"
})
const invoiceRefunds = counted("Refund", ["invoice"], "Invoice", ["id"], "refunds", {
	step: "amount",
	end: "refunded"
})

const platformFamilies: ReadonlyArray<Counted> = [
	eventCharges,
	chargeDebits,
	grantDebits,
	limitCharges,
	invoiceLines,
	lineAllocations,
	invoiceRefunds
]

/**
 * A state's facts with the fields grizzle draws and accumulates for each owner, as the host counts and sums them over
 * the owner's members: its count, how many facts its family holds, and its sum fold's end, the sum of their step
 * values, an empty family's zero. A read reads an owner's whole row, so a reference over the host's facts states them
 * too, and wherever a read delivers one the host's count or sum is a second implementation of grizzle's.
 */
export const withDrawn = (s: State): ReadonlyMap<RelationName, ReadonlyArray<PlatformRow>> =>
	new Map(
		Arr.map(loadOrder, (relation): readonly [RelationName, ReadonlyArray<PlatformRow>] => {
			const tallies = Arr.map(
				Arr.filter(platformFamilies, (f) => f.owner === relation),
				(f) => {
					const counts = new Map<string, bigint>()
					for (const m of rowsIn(s, f.member)) {
						const k = tupleKey(m, f.group)
						counts.set(k, (counts.get(k) ?? 0n) + 1n)
					}
					return { f, counts, sums: sumsOf(s, f, f.sum.step) }
				}
			)
			return [
				relation,
				Arr.map(rowsIn(s, relation), (row) =>
					Arr.reduce(tallies, row, (out: PlatformRow, { f, counts, sums }): PlatformRow => ({
						...out,
						[f.count]: counts.get(tupleKey(row, f.key)) ?? 0n,
						[f.sum.end]: sumAt(sums, f, row)
					}))
				)
			]
		})
	)

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
	family("eventCharges", P.eventCharges, eventCharges),
	sumFold("eventCharged", P.eventCharged, eventCharges),
	sumCheck(
		"chargeExact",
		P.chargeExact,
		eventCharges,
		(e, charged) => charged === amountOf(e, "amount")
	),
	family("chargeDebits", P.chargeDebits, chargeDebits),
	sumFold("chargeDebited", P.chargeDebited, chargeDebits),
	sumCheck(
		"creditedExact",
		P.creditedExact,
		chargeDebits,
		(c, debited) => debited === amountOf(c, "credited")
	),
	rowCheck(
		"creditedWithinCharge",
		P.creditedWithinCharge,
		"UsageCharge",
		(c) => amountOf(c, "credited") <= amountOf(c, "amount")
	),
	family("grantDebits", P.grantDebits, grantDebits),
	sumFold("grantDebited", P.grantDebited, grantDebits),
	sumCheck(
		"grantWithinAmount",
		P.grantWithinAmount,
		grantDebits,
		(g, debited) => debited <= amountOf(g, "amount")
	),
	family("limitCharges", P.limitCharges, limitCharges),
	sumFold("limitSpent", P.limitSpent, limitCharges),
	sumCheck(
		"spendWithinCap",
		P.spendWithinCap,
		limitCharges,
		(l, spent) => spent <= amountOf(l, "cap")
	),
	family("invoiceLines", P.invoiceLines, invoiceLines),
	sumFold("invoiceBilled", P.invoiceBilled, invoiceLines),
	sumCheck(
		"invoiceExact",
		P.invoiceExact,
		invoiceLines,
		(i, billed) => billed === amountOf(i, "amount")
	),
	family("lineAllocations", P.lineAllocations, lineAllocations),
	sumFold("lineAllocated", P.lineAllocated, lineAllocations),
	sumCheck(
		"allocationExact",
		P.allocationExact,
		lineAllocations,
		(l, allocated) => l["source"] !== "plan" || allocated === amountOf(l, "amount")
	),
	family("invoiceRefunds", P.invoiceRefunds, invoiceRefunds),
	sumFold("invoiceRefunded", P.invoiceRefunded, invoiceRefunds),
	sumCheck(
		"refundWithinInvoice",
		P.refundWithinInvoice,
		invoiceRefunds,
		(i, refunded) => refunded <= amountOf(i, "amount")
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
	readonly facts: ReadonlyArray<PlatformRow>
}

/** An exact deletion of facts of one relation, typed by the relation. */
export const deleteOp: <K extends RelationName>(
	relation: K,
	facts: PlatformFacts[K]
) => PlatformOp = (relation: RelationName, facts: ReadonlyArray<PlatformRow>): PlatformOp => ({
	kind: "delete",
	relation,
	facts
})

/** An insertion of facts of one relation, typed by the relation. */
export const insertOp: <K extends RelationName>(
	relation: K,
	facts: PlatformFacts[K]
) => PlatformOp = (relation: RelationName, facts: ReadonlyArray<PlatformRow>): PlatformOp => ({
	kind: "insert",
	relation,
	facts
})

/** A put of facts of one relation, typed by the relation. */
export const putOp: <K extends RelationName>(relation: K, facts: PlatformFacts[K]) => PlatformOp = (
	relation: RelationName,
	facts: ReadonlyArray<PlatformRow>
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

const withRows = (s: State, relation: RelationName, rows: ReadonlyArray<PlatformRow>): State =>
	new Map([...s, [relation, rows]])

/** The state grizzle's operations leave, as sets (see the header). */
const applied = (s: State, ops: ReadonlyArray<PlatformOp>): State => {
	let out = s
	for (const relation of loadOrder) {
		const mine = Arr.filter(ops, (o) => o.relation === relation)
		if (mine.length === 0) {
			continue
		}
		const of = (kind: PlatformOp["kind"]): ReadonlyArray<PlatformRow> =>
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
		const rows = new Map(Arr.map(kept, (row): [string, PlatformRow] => [rowKey(row), row]))
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

/**
 * A direct writer's statement: facts of one relation deleted exactly, inserted, or put at their keys. A put is how a
 * direct writer replaces an owner: its written fields change in place, its families untouched.
 */
export interface DirectStatement {
	readonly kind: "delete" | "insert" | "put"
	readonly relation: RelationName
	readonly facts: ReadonlyArray<PlatformRow>
}

/** A relation's rows after one direct statement: the facts deleted exactly, appended, or put at their keys. */
const statementRows = (
	rows: ReadonlyArray<PlatformRow>,
	statement: DirectStatement
): ReadonlyArray<PlatformRow> => {
	switch (statement.kind) {
		case "delete": {
			const gone = keySet(statement.facts)
			return Arr.filter(rows, (row) => !gone.has(rowKey(row)))
		}
		case "insert":
			return [...rows, ...statement.facts]
		case "put": {
			const key = keyFieldsOf(statement.relation)
			const at = new Set(Arr.map(statement.facts, (f) => tupleKey(f, key)))
			return [...Arr.filter(rows, (row) => !at.has(tupleKey(row, key))), ...statement.facts]
		}
	}
}

/**
 * What a direct writer's statements decide on a state, in order: a direct transaction commits or is refused, so a
 * commit that changes nothing is accepted too. The state is a bag: an inserted fact equal to a stored one is a second
 * fact at its key. After each statement the laws it checks (checkedAt) are judged on the state it leaves, and after the
 * last every law is.
 */
export const decideStatements = (
	s: State,
	statements: ReadonlyArray<DirectStatement>
): Decision => {
	let at = s
	for (const statement of statements) {
		at = withRows(at, statement.relation, statementRows(rowsIn(at, statement.relation), statement))
		const broken = Arr.filter(
			platformLaws,
			(law) => law.checkedAt.includes(statement.relation) && law.broken(at)
		)
		if (broken.length > 0) {
			return { kind: "refused", laws: broken }
		}
	}
	const broken = brokenLaws(at)
	return broken.length === 0 ? { kind: "accepted", after: at } : { kind: "refused", laws: broken }
}
