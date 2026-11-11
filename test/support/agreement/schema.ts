import { Record as Rec } from "effect"
import { closedId, contract, date, pg, span, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	alternatives,
	closed,
	contained,
	derived,
	key,
	on,
	relation,
	role,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"

/**
 * The schema the type/engine agreements draw their queries over (test/support/agreement/queries.ts, admission.ts).
 *
 * The evidence agreement's relations are small enough that every draw meets each kind of key the evidence types reason
 * about: a single-field primary key (Item.id), a candidate key over two fields (Item's owner and n), a composite primary
 * key (Tag's item and label) and a one-to-one key over a reference (Note.item). Its uuid fields join one another and so
 * do its integer fields, so a drawn join may meet any key from any side; Item.tone is a roster's, which a handle or a
 * member's JavaScript value binds, fixes, heads and discriminates, and Item.cost a contract's, whose brand a variable,
 * a parameter and min and max keep and sum and mean read through, and which declares its values nonnegative, a fact a
 * variable read from a column of its type has and one of any other type lacks. Tones, a union of Item's facts of two tones whose
 * arms hold Tone's handles at tone, is the union source a drawn rule matches with a constant bound at tone; Owned, the
 * items of one owner, is the import a rule matches bound or, where a case plants the fault, unbound; Stray is a
 * relation Agree does not hold, which a rule's match or relation parameter names where a case plants that fault.
 * Batch, a relation of Stray's heading that Agree holds, is the relation a rule's relation parameter takes its heading
 * from (r.relation(name, Batch)); its rows are a set, keyed by their whole heading, not by Batch's key.
 *
 * Cell holds one column per constant kind the admission matrix draws: a JavaScript value of every carrier, Tone's
 * handles, typed integer constants and a contract's, and a finite refined text's members (grade); Shade, a second
 * roster sharing a member with Tone, gives the wrong-roster arm.
 *
 * Slot holds an item's spans and vectors, keyed by its item and span: during, a span over integer ticks, which Allen
 * predicates, a point's test and the span producers read, and which a span parameter declared at it types; budget and
 * raw, spans over Cents and over its bare base, which never meet; when, a span of calendar dates, whose width counts
 * days, and day, a date a point's test of it reads; embedding, the vector a cosine distance scores and an
 * approximate search ranks by, and image, a second vector of its dimensions, which a distance relates to it but no
 * search ranks by.
 *
 * ToneWeight is a closed relation, a weight of Cents for two of Tone's three members, keyed by its tone: a rule matches
 * it as any relation, and every role reads its rows, so it is no role's entry. Tone itself, a roster, is a source of its
 * one field, id. byOwner names Item's candidate key, which a keyed get reads through as it reads a primary key.
 *
 * Rollup extends Agree with two derived relations, each keyed by what its definition proves: ItemTones, a projection of
 * Item keyed by its id, and OwnerCounts, the count of each owner's items, keyed by the owner. A query over Rollup reads
 * them and Agree's relations alike; a Db over a role of Agree reads no query over Rollup.
 */
export const Tone = closed("Tone", ["low", "mid", "high"])
export const Shade = closed("Shade", ["low", "dark"])
export const Cents = contract("Cents", pg.bigint, (x) => x.ge(0n), { proves: ["nonnegative"] })

export const Item = relation(
	"Item",
	{ id: uuid, owner: uuid, n: pg.integer, m: pg.integer, tone: closedId(Tone), cost: Cents },
	["id"]
)

export const Tag = relation("Tag", { item: uuid, label: pg.integer, w: pg.integer }, [
	"item",
	"label"
])
export const Note = relation("Note", { item: uuid, k: pg.integer }, ["item"])
export const Stray = relation("Stray", { id: uuid, n: pg.integer }, ["id"])
export const Batch = relation("Batch", { id: uuid, n: pg.integer }, ["id"])

export const Cell = relation(
	"Cell",
	{
		id: uuid,
		text: str.regex("^.*$", "su"),
		integer: pg.integer,
		bigint: pg.bigint,
		boolean: pg.boolean,
		uuid,
		numeric: pg.numeric(10, 2),
		money: pg.money,
		vector: pg.vector(3),
		tone: closedId(Tone),
		shade: closedId(Shade),
		cents: Cents,
		grade: str.regex("^(pass|fail)$")
	},
	["id"]
)

export const Slot = relation(
	"Slot",
	{
		item: uuid,
		during: span(pg.integer),
		budget: span(Cents),
		raw: span(pg.bigint),
		day: date,
		when: span(date),
		embedding: pg.vector(3),
		image: pg.vector(3)
	},
	["item", "during"]
)

export const ToneWeight = closed.relation(
	"ToneWeight",
	{ tone: closedId(Tone), weight: Cents },
	["tone"],
	[
		{ tone: "low", weight: Cents(1n) },
		{ tone: "mid", weight: Cents(2n) }
	]
)

export const byOwner = key(on(Item, "owner", "n"))

export const Agree = schema(
	"Agree",
	[Tone, Shade, Item, Tag, Note, Batch, Cell, Slot, ToneWeight],
	[byOwner]
)

/** Agree's entries a full role holds whole: every relation and roster but the closed relation. */
const agreeEntries = Object.freeze({ Tone, Shade, Item, Tag, Note, Batch, Cell, Slot })

/** The full role over Agree every drawn read goes through, but where a case reads through Reporter. */
export const Reader = role(Agree, "reader", agreeEntries)

export const ItemTones = derived.materialized(
	"ItemTones",
	query(Agree).rule((r) => {
		const { id, tone, owner } = v(Item, "item")
		return r.match(Item, { id, tone, owner }).find({ id, tone, owner })
	})
)

export const OwnerCounts = derived.materialized(
	"OwnerCounts",
	query(Agree).rule((r) => {
		const { id, owner } = v(Item, "item")
		return r.match(Item, { id, owner }).find({ owner, items: r.count() })
	})
)

export const Rollup = schema.extend(Agree, "Rollup", [ItemTones, OwnerCounts], [])

/** Rollup's entries a full role holds whole: Agree's and the derived relations. */
const rollupEntries = Object.freeze({ ...agreeEntries, ItemTones, OwnerCounts })

/** The full role over Rollup, which reads queries over Rollup and over Agree, a level of it. */
export const Reporter = role(Rollup, "reporter", rollupEntries)

export const Tones = query(Agree)
	.rule((r) => {
		const { id } = v(Item, "item")
		return r.match(Item, { id, tone: "low" }).find({ id, tone: Tone.handle("low") })
	})
	.rule((r) => {
		const { id } = v(Item, "item")
		return r.match(Item, { id, tone: "mid" }).find({ id, tone: Tone.handle("mid") })
	})

export const Owned = query(Agree).rule((r) => {
	const { id, n } = v(Item, "item")
	return r.match(Item, { id, owner: r.param("owner", Item.fields.owner), n }).find({ id, n })
})

/**
 * The schemas the admission agreement's scope cells match a query across (admission.ts scopeCells): AgreeAbove, an
 * extension of Agree, whose levels are itself and Agree; and Apart, which holds Agree's Cell and its rosters but is no
 * level of Agree, nor Agree of it, so a query over one reads relations the other holds and is still over no level of it.
 */
export const AgreeAbove = schema.extend(Agree, "AgreeAbove", [], [])
export const Apart = schema("Apart", [Tone, Shade, Cell], [])

/**
 * The schema the attachment agreement draws its parents and children over (test/support/agreement/attachments.ts): a
 * containment from a field into an ordinary relation's key (Task.account into Account, TaskNote.task into Task), into a
 * closed relation's (Account.plan into PlanBudget), and a composite one (TaskLabel's account and label into Label), each
 * of which proves the one child; keys a child may be bound by, at most one child per parent; and the alternatives law
 * over Task by its kind, whose arms are AutomaticTask and ManualTask.
 */
const Kind = closed("Kind", ["Automatic", "Manual"])
const Plan = closed("Plan", ["Free", "Pro"])
const PlanBudget = closed.relation(
	"PlanBudget",
	{ plan: closedId(Plan), budget: Cents },
	["plan"],
	[
		{ plan: "Free", budget: Cents(1n) },
		{ plan: "Pro", budget: Cents(2n) }
	]
)
const Account = relation("Account", { id: uuid, rank: pg.integer, plan: closedId(Plan) }, ["id"])
const Task = relation(
	"Task",
	{ id: uuid, account: uuid, kind: closedId(Kind), score: pg.integer },
	["id"]
)
const AutomaticTask = relation("AutomaticTask", { task: uuid, budget: Cents }, ["task"])
const ManualTask = relation("ManualTask", { task: uuid, operator: pg.integer }, ["task"])
const TaskNote = relation("TaskNote", { task: uuid, note: pg.integer }, ["task"])
const Label = relation("Label", { account: uuid, label: pg.integer, color: pg.integer }, [
	"account",
	"label"
])
const TaskLabel = relation("TaskLabel", { task: uuid, account: uuid, label: pg.integer }, [
	"task",
	"label"
])
export const Deliver = schema(
	"Deliver",
	[Kind, Plan, PlanBudget, Account, Task, AutomaticTask, ManualTask, TaskNote, Label, TaskLabel],
	[
		contained(on(Task, "account"), on(Account, "id")),
		contained(on(Account, "plan"), on(PlanBudget, "plan")),
		contained(on(TaskNote, "task"), on(Task, "id")),
		contained(on(TaskLabel, "account", "label"), on(Label, "account", "label")),
		alternatives(Task, "kind", Kind, { Automatic: AutomaticTask, Manual: ManualTask })
	]
)

/**
 * A schema of Deliver's relations that is no level of Deliver, nor Deliver of it: an attachment child written over it
 * reads relations its parent's schema holds, and is still over no level of that schema.
 */
export const DeliverApart = schema("DeliverApart", Rec.values(Deliver.relations), [])
