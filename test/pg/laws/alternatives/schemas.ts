import { Array as Arr } from "effect"
import {
	alternatives,
	closed,
	f,
	mirrors,
	mutable,
	on,
	onSelected,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"

const Stage = closed("Stage", ["draft", "approved", "paid", "voided"])
const Run = relation(
	"Run",
	{ tenant: f.integer, id: f.integer, stage: f.closedId("Stage"), note: f.wildcard },
	["tenant", "id"]
)

const Payment = relation("Payment", { tenant: f.integer, run: f.integer, amount: f.integer }, [
	"tenant",
	"run"
])

const Voiding = relation("Voiding", { tenant: f.integer, run: f.integer, reason: f.wildcard }, [
	"tenant",
	"run"
])
const Line = relation("Line", { id: f.integer, offCycle: f.boolean, note: f.wildcard }, ["id"])
const Reason = relation("Reason", { id: f.integer, line: f.integer, text: f.wildcard }, ["id"])

const ledgerRelations = ["Run", "Payment", "Voiding", "Line", "Reason"] as const

const runStage = alternatives(Run, "stage", Stage, { paid: Payment, voided: Voiding })
const lineReasons = mirrors(onSelected("Line", ["id"], { offCycle: true }), on("Reason", ["line"]))

/**
 * Ledger: a partial arm map over a composite parent key, `alternatives(Run, "stage", Stage, { paid: Payment, voided:
 * Voiding })` with `draft` and `approved` unarmed, beside a conditional mirrors outside alternatives whose child side
 * is not the child's key, `mirrors(on(select(Line, { offCycle: true }), "id"), on(Reason, "line"))`, so a line may have
 * several reasons and loses its obligation's support only with the last one. `mutable` adds every relation's UPDATE
 * events. The two laws are the pair of the cross-law deadlock schedule.
 */
export const ledger = (options: { readonly mutable: boolean }): SchemaDesc => ({
	name: "Ledger",
	relations: [Stage, Run, Payment, Voiding, Line, Reason],
	statements: [
		...runStage,
		lineReasons,
		...(options.mutable ? Arr.map(ledgerRelations, mutable) : [])
	],
	extends: undefined
})

const Priority = closed("Priority", ["low", "high"])
const Ticket = relation(
	"Ticket",
	{
		id: f.uuid,
		level: f.integer,
		lang: f.regex("^[a-z]{2}$", "u"),
		priority: f.closedId("Priority")
	},
	["id"]
)
const Escalation = relation("Escalation", { ticket: f.uuid }, ["ticket"])
const Translation = relation("Translation", { ticket: f.uuid, text: f.wildcard }, ["ticket"])
const Page = relation("Page", { ticket: f.uuid }, ["ticket"])

const levelEscalation = mirrors(
	onSelected("Ticket", ["id"], { level: 3 }),
	on("Escalation", ["ticket"])
)

const langTranslation = mirrors(
	on("Translation", ["ticket"]),
	onSelected("Ticket", ["id"], { lang: "en" })
)

const priorityPage = mirrors(
	onSelected("Ticket", ["id"], { priority: "high" }),
	on("Page", ["ticket"])
)

/**
 * Signals: conditional mirrors whose selectors are an integer, a regex text and a closed handle, one written with its
 * selected side on the right (nothing depends on the selector being a closed handle).
 */
export const signals = (options: { readonly mutable: boolean }): SchemaDesc => ({
	name: "Signals",
	relations: [Priority, Ticket, Escalation, Translation, Page],
	statements: [
		levelEscalation,
		langTranslation,
		priorityPage,
		...(options.mutable ? [mutable("Ticket")] : [])
	],
	extends: undefined
})

const Batch = relation("Batch", { tenant: f.integer, id: f.integer, urgent: f.boolean }, [
	"tenant",
	"id"
])

const Note = relation(
	"Note",
	{ id: f.integer, account: f.integer, batch: f.integer, text: f.wildcard },
	["id"]
)

const urgentNotes = mirrors(
	onSelected("Batch", ["id", "tenant"], { urgent: true }),
	on("Note", ["batch", "account"])
)

/**
 * Batches: a composite conditional mirrors whose projection is a key of the parent out of its key and heading order,
 * `mirrors(on(select(Batch, { urgent: true }), "id", "tenant"), on(Note, "batch", "account"))` over Batch keyed
 * (tenant, id), with the child's fields out of their sorted and heading order too. Both pairs are integers, so only
 * the projection's order pairs Note.batch with Batch.id and Note.account with Batch.tenant, and the DETAIL is the
 * projection in its own order.
 */
export const batches = (): SchemaDesc => ({
	name: "Batches",
	relations: [Batch, Note],
	statements: [urgentNotes],
	extends: undefined
})
