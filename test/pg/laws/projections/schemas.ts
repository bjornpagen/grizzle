import { Array as Arr, Record as Rec } from "effect"
import { closedId, pg, uuid } from "#compiler/public/fields.ts"
import {
	type AnyRelation,
	closed,
	contained,
	key,
	type Mutable,
	mirrors,
	mutable,
	on,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"

/**
 * The schemas of selected sides, each owned here once: the projection suites' families (families.ts) draw their
 * parameters, and the fixed points below are fixtures for whatever reads an installation's statements whole.
 *
 * A side `on(select(R, φ), t…)` is a partial projection, and every law over one is native: its terms are STORED
 * generated columns `CASE WHEN φ THEN t END`, a key over it a UNIQUE NULLS DISTINCT over them, and a containment a
 * FOREIGN KEY ... MATCH SIMPLE from them or into a UNIQUE over them. A containment's target contains a key of its
 * relation, so each mirrors' child side is a key of the child.
 *
 * A schema is immutable or, with `mutable`, every relation of it is.
 */

/** Any text: the explicit wildcard. */
const anyText = str.regex("^.*$", "su")

/** The `mutable` statements of a schema's relations: none, or every one. */
const mutables = <V extends AnyRelation>(
	declared: boolean,
	relations: Readonly<Record<string, V>>
): ReadonlyArray<Mutable<V>> => (declared ? Arr.map(Rec.values(relations), (r) => mutable(r)) : [])

export const Worker = relation("Worker", { id: pg.integer, name: anyText }, ["id"])
export const Assignment = relation(
	"Assignment",
	{ id: pg.integer, worker: pg.integer, active: pg.boolean },
	["id"]
)
/** A desk is all key, so a badge's foreign key into it is immediate: no put replaces a desk in passing. */
export const Desk = relation("Desk", { id: pg.integer }, ["id"])
export const Badge = relation("Badge", { id: pg.integer, desk: pg.integer, issued: pg.boolean }, [
	"id"
])
export const staffingRelations = Object.freeze({ Worker, Assignment, Desk, Badge })

export interface StaffingParams {
	readonly mutable: boolean
	/** The `active` value of the assignments, and the `issued` value of the badges, the two sides select. */
	readonly selector: boolean
}

export const staffed = (selector: boolean) =>
	contained(
		on(
			select(Assignment, (a) => a.eq(a.active, selector)),
			"worker"
		),
		on(Worker, "id")
	)

export const issued = (selector: boolean) =>
	contained(
		on(
			select(Badge, (b) => b.eq(b.issued, selector)),
			"desk"
		),
		on(Desk, "id")
	)

/**
 * Staffing: `contained(on(select(Assignment, (a) => a.eq(a.active, sel)), "worker"), on(Worker, "id"))`, and a second,
 * independent law of the same shape into a relation that is all key, `Badge` into `Desk`.
 */
export const staffingOf = (p: StaffingParams) => (name: string) =>
	schema(name, staffingRelations, [
		staffed(p.selector),
		issued(p.selector),
		...mutables(p.mutable, staffingRelations)
	])

export const staffing = (options: { readonly mutable: boolean }) =>
	staffingOf({ mutable: options.mutable, selector: true })("Staffing")

/**
 * Printable ASCII, bounded, so the composite key passes the B-tree entry-size check; quotes, brackets and backslashes
 * included.
 */
const Week = str.regex("^[ -~]{1,40}$", "u")

export const statuses = ["pending", "approved"] as const
export type ShiftStatus = (typeof statuses)[number]
const Status = closed("Status", statuses)
export const Sheet = relation("Sheet", { employee: uuid, week: Week, ceiling: pg.integer }, [
	"employee",
	"week"
])
const Shift = relation(
	"Shift",
	{ id: uuid, employee: uuid, week: Week, status: closedId(Status) },
	["id"]
)
export const rotaRelations = Object.freeze({ Sheet, Shift })

export interface RotaParams {
	readonly mutable: boolean
	/** The status of the shifts the side selects. */
	readonly status: ShiftStatus
	/** Whether the selected side is a key of Shift too: at most one selected shift per sheet. */
	readonly keyed: boolean
}

/** The shifts a status selects, by employee and week: the side the containment and the key both read. */
const shiftWeeks = (status: ShiftStatus) =>
	on(
		select(Shift, (s) => s.eq(s.status, status)),
		"employee",
		"week"
	)

export const shiftSheet = (status: ShiftStatus) =>
	contained(shiftWeeks(status), on(Sheet, "employee", "week"))
export const oneShift = (status: ShiftStatus) => key(shiftWeeks(status))

/**
 * Rota: a composite text and uuid projection selected by a closed handle, `contained(on(select(Shift, (s) =>
 * s.eq(s.status, st)), "employee", "week"), on(Sheet, "employee", "week"))`, whose projection is no key of Shift but,
 * keyed, one of its selected shifts, which shares the containment's generated columns.
 */
export const rotaOf = (p: RotaParams) => (name: string) =>
	schema(name, { Status, ...rotaRelations }, [
		shiftSheet(p.status),
		...(p.keyed ? [oneShift(p.status)] : []),
		...mutables(p.mutable, rotaRelations)
	])

export const rota = (options: { readonly mutable: boolean }) =>
	rotaOf({ mutable: options.mutable, status: "approved", keyed: false })("Rota")

export const Node = relation("Node", { id: pg.integer, parent: pg.integer, live: pg.boolean }, [
	"id"
])

export interface TreeParams {
	readonly mutable: boolean
	/** The `live` value of the nodes the side selects. */
	readonly live: boolean
}

export const nodeParent = (live: boolean) =>
	contained(
		on(
			select(Node, (n) => n.eq(n.live, live)),
			"parent"
		),
		on(Node, "id")
	)

/** Tree: a selected source into its own relation, one table that is both source and target. */
export const treeOf = (p: TreeParams) => (name: string) =>
	schema(name, { Node }, [nodeParent(p.live), ...mutables(p.mutable, { Node })])

export const tree = (options: { readonly mutable: boolean }) =>
	treeOf({ mutable: options.mutable, live: true })("Tree")

export const Line = relation("Line", { id: pg.integer, offCycle: pg.boolean, note: anyText }, [
	"id"
])
export const Reason = relation("Reason", { id: pg.integer, line: pg.integer, text: anyText }, [
	"id"
])
export const reasonsRelations = Object.freeze({ Line, Reason })

export interface ReasonsParams {
	readonly mutable: boolean
	/** The `offCycle` value of the lines the side selects. */
	readonly selector: boolean
}

export const offCycleLines = (selector: boolean) =>
	on(
		select(Line, (l) => l.eq(l.offCycle, selector)),
		"id"
	)
/** A reason explains one line: the mirrors' child side is a candidate key of Reason, beside its id. */
export const reasonLine = on(Reason, "line")
export const reasonKey = key(reasonLine)

/** Reasons: `mirrors(on(select(Line, (l) => l.eq(l.offCycle, sel)), "id"), on(Reason, "line"))`. */
export const reasonsOf = (p: ReasonsParams) => (name: string) =>
	schema(name, reasonsRelations, [
		reasonKey,
		mirrors(offCycleLines(p.selector), reasonLine),
		...mutables(p.mutable, reasonsRelations)
	])

export const reasons = (options: { readonly mutable: boolean }) =>
	reasonsOf({ mutable: options.mutable, selector: true })("Reasons")

/**
 * Batch is keyed (tenant, id) and Note pairs (batch, account) with its projection (id, tenant), out of Batch's key and
 * heading order, a candidate key of Note out of Note's own heading order: both pairs are integers, so only the
 * projection's order pairs Note.batch with Batch.id and Note.account with Batch.tenant.
 */
export const Batch = relation("Batch", { tenant: pg.integer, id: pg.integer, urgent: pg.boolean }, [
	"tenant",
	"id"
])
export const Note = relation(
	"Note",
	{ id: pg.integer, account: pg.integer, batch: pg.integer, text: anyText },
	["id"]
)
export const batchesRelations = Object.freeze({ Batch, Note })

export interface BatchesParams {
	readonly mutable: boolean
	/** The `urgent` value of the batches the side selects. */
	readonly selector: boolean
}

export const urgentBatches = (selector: boolean) =>
	on(
		select(Batch, (b) => b.eq(b.urgent, selector)),
		"id",
		"tenant"
	)
export const noteBatch = on(Note, "batch", "account")
export const noteKey = key(noteBatch)

/** Batches: `mirrors(on(select(Batch, (b) => b.eq(b.urgent, sel)), "id", "tenant"), on(Note, "batch", "account"))`. */
export const batchesOf = (p: BatchesParams) => (name: string) =>
	schema(name, batchesRelations, [
		noteKey,
		mirrors(urgentBatches(p.selector), noteBatch),
		...mutables(p.mutable, batchesRelations)
	])

export const batches = () => batchesOf({ mutable: false, selector: true })("Batches")

export const priorities = ["low", "high"] as const
const Priority = closed("Priority", priorities)
export const Ticket = relation(
	"Ticket",
	{ id: uuid, level: pg.integer, lang: str.regex("^[a-z]{2}$", "u"), priority: closedId(Priority) },
	["id"]
)
/** A ticket's follow-ups, each keyed by its ticket: three are all key, and a translation carries its text. */
export const Escalation = relation("Escalation", { ticket: uuid }, ["ticket"])
export const Translation = relation("Translation", { ticket: uuid, text: anyText }, ["ticket"])
export const Page = relation("Page", { ticket: uuid }, ["ticket"])
export const Watch = relation("Watch", { ticket: uuid }, ["ticket"])
export const signalsRelations = Object.freeze({ Ticket, Escalation, Translation, Page, Watch })

export interface SignalsParams {
	readonly mutable: boolean
}

/** The tickets of level 3, of English, of high priority, and of level 2 or more but not of low priority. */
export const levelTickets = on(
	select(Ticket, (t) => t.eq(t.level, 3)),
	"id"
)
export const englishTickets = on(
	select(Ticket, (t) => t.eq(t.lang, "en")),
	"id"
)
export const urgentTickets = on(
	select(Ticket, (t) => t.eq(t.priority, "high")),
	"id"
)
export const watchedTickets = on(
	select(Ticket, (t) => t.and(t.ge(t.level, 2), t.ne(t.priority, "low"))),
	"id"
)
export const escalationTicket = on(Escalation, "ticket")
export const translationTicket = on(Translation, "ticket")
export const pageTicket = on(Page, "ticket")
export const watchTicket = on(Watch, "ticket")

/**
 * Signals: a ticket's mirrors with each of its follow-ups, selected by an integer, a refined text, a closed handle,
 * and an order comparison beside a closed handle's inequality, a predicate no literal record states; the translation's
 * written with its selected side on the right. Each mirrors is a cycle of two foreign keys, so even the ones into a
 * relation that is all key are deferred.
 */
export const signalsOf = (p: SignalsParams) => (name: string) =>
	schema(name, { Priority, ...signalsRelations }, [
		mirrors(levelTickets, escalationTicket),
		mirrors(translationTicket, englishTickets),
		mirrors(urgentTickets, pageTicket),
		mirrors(watchedTickets, watchTicket),
		...mutables(p.mutable, signalsRelations)
	])

export const signals = (options: { readonly mutable: boolean }) =>
	signalsOf({ mutable: options.mutable })("Signals")
