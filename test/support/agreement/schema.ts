import { Record as Rec } from "effect"
import { Logic } from "#compiler/public/compute.ts"
import { closedId, contract, date, mintOf, natural, pg, span } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	closed,
	contained,
	derived,
	key,
	mirrors,
	mutable,
	on,
	relation,
	role,
	schema,
	select,
	unit
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Id } from "#test/support/ids.ts"

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
 * it as any relation, and every role reads its rows, so it is no role's entry. Its weights are distinct, so the engine
 * keys it by its weight too, a fact of its rows the types do not read (README "Closed relations"); ToneWeightTyped, a
 * relation of its heading keyed by its tone alone, is ToneWeight as the types read it, which the evidence agreement
 * reads a query over in its place to tell that class apart (queries.ts ClosedReading), and which no drawn rule names.
 * Tone itself, a roster, is a source of its one field, id. byOwner names Item's candidate key, which a keyed get reads
 * through as it reads a primary key.
 *
 * Rollup extends Agree with two derived relations, each keyed by what its definition proves: ItemTones, a projection of
 * Item keyed by its id, stored, each item's row in the unit Entry every relation keyed by its id sits in, and
 * OwnerCounts, the count of each owner's items, keyed by the owner, live, which a role reads through Item. A query over
 * Rollup reads them and Agree's relations alike; a Db over a role of Agree reads no query over Rollup.
 */
export const Tone = closed.ordered("Tone", ["low", "mid", "high"])
export const Shade = closed.ordered("Shade", ["low", "dark"])
const centsKey = Symbol("Cents")
export const Cents = contract<typeof centsKey>()("Cents", pg.bigint, (x) => Logic.ge(x, 0n), {
	proves: ["nonnegative"]
})
export const toCents = mintOf(centsKey)
/** The key's type, which a program states a Cents value by and which mints nothing. */
export type CentsKey = typeof centsKey

export const Item = relation(
	"Item",
	{ id: Id, owner: Id, n: pg.integer, m: pg.integer, tone: closedId(Tone), cost: Cents },
	["id"]
)

export const Tag = relation("Tag", { item: Id, label: pg.integer, w: pg.integer }, [
	"item",
	"label"
])
export const Note = relation("Note", { item: Id, k: pg.integer }, ["item"])
export const Stray = relation("Stray", { id: Id, n: pg.integer }, ["id"])
export const Batch = relation("Batch", { id: Id, n: pg.integer }, ["id"])

export const Cell = relation(
	"Cell",
	{
		id: Id,
		text: str.regex("^.*$", "su"),
		integer: pg.integer,
		bigint: pg.bigint,
		natural,
		boolean: pg.boolean,
		uuid: Id,
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
		item: Id,
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
		{ tone: "low", weight: toCents(1n) },
		{ tone: "mid", weight: toCents(2n) }
	]
)

export const ToneWeightTyped = relation(
	"ToneWeightTyped",
	{ tone: closedId(Tone), weight: Cents },
	["tone"]
)

export const byOwner = key(on(Item, "owner", "n"))

/**
 * The agreement's schema. An item's rows, Tag, Note and Slot, each keyed by its item, sit in the item's unit, and Note
 * is open, which a ChangeSet of the admission agreement deletes (agreement/admission.ts idsWrite).
 */
export const Agree = schema(
	"Agree",
	[Tone, Shade, Item, Tag, Note, Batch, Cell, Slot, ToneWeight, ToneWeightTyped],
	[byOwner, unit("Item", { item: Id }), mutable(Note), unit("Entry", { id: Id })]
)

/** Agree's entries a full role holds whole: every relation and roster but the closed relation. */
const agreeEntries = Object.freeze({
	Tone,
	Shade,
	Item,
	Tag,
	Note,
	Batch,
	Cell,
	Slot,
	ToneWeightTyped
})

/** The full role over Agree every drawn read goes through, but where a case reads through Reporter. */
export const Reader = role(Agree, "reader", agreeEntries)

export const ItemTones = derived(
	"ItemTones",
	query(Agree).rule((r) => {
		const { id, tone, owner } = v(Item, "item")
		return r.match(Item, { id, tone, owner }).find({ id, tone, owner })
	})
)

export const OwnerCounts = derived(
	"OwnerCounts",
	query(Agree).rule((r) => {
		const { id, owner } = v(Item, "item")
		return r.match(Item, { id, owner }).find({ owner, items: r.count() })
	})
)

export const Rollup = schema.extend([Agree], "Rollup", [ItemTones, OwnerCounts], [])

/** The full role over Rollup, which reads queries over Rollup and over Agree, a level of it: it holds Agree's
 * relations whole, so it reads Rollup's derived relations in full, the stored ItemTones by its table. */
export const Reporter = role(Rollup, "reporter", agreeEntries)

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
export const AgreeAbove = schema.extend([Agree], "AgreeAbove", [], [])
export const Apart = schema("Apart", [Tone, Shade, Cell], [])

/**
 * The schema the attachment agreement draws its parents and children over (test/support/agreement/attachments.ts): a
 * containment from a field into an ordinary relation's key (Task.account into Account, TaskNote.task into Task), into a
 * closed relation's (Account.plan into PlanBudget), and a composite one (TaskLabel's account and label into Label), each
 * of which proves the one child; keys a child may be bound by, at most one child per parent; and Task's kind's arms,
 * AutomaticTask and ManualTask, each mirrored with the tasks of its kind.
 */
const Kind = closed.ordered("Kind", ["Automatic", "Manual"])
const Plan = closed.ordered("Plan", ["Free", "Pro"])
const PlanBudget = closed.relation(
	"PlanBudget",
	{ plan: closedId(Plan), budget: Cents },
	["plan"],
	[
		{ plan: "Free", budget: toCents(1n) },
		{ plan: "Pro", budget: toCents(2n) }
	]
)
const Account = relation("Account", { id: Id, rank: pg.integer, plan: closedId(Plan) }, ["id"])
const Task = relation("Task", { id: Id, account: Id, kind: closedId(Kind), score: pg.integer }, [
	"id"
])
const AutomaticTask = relation("AutomaticTask", { task: Id, budget: Cents }, ["task"])
const ManualTask = relation("ManualTask", { task: Id, operator: pg.integer }, ["task"])
const TaskNote = relation("TaskNote", { task: Id, note: pg.integer }, ["task"])
const Label = relation("Label", { account: Id, label: pg.integer, color: pg.integer }, [
	"account",
	"label"
])
const TaskLabel = relation("TaskLabel", { task: Id, account: Id, label: pg.integer }, [
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
		mirrors(
			on(AutomaticTask, "task"),
			on(
				select(Task, (t) => t.eq(t.kind, "Automatic")),
				"id"
			)
		),
		mirrors(
			on(ManualTask, "task"),
			on(
				select(Task, (t) => t.eq(t.kind, "Manual")),
				"id"
			)
		)
	]
)

/**
 * A schema of Deliver's relations that is no level of Deliver, nor Deliver of it: an attachment child written over it
 * reads relations its parent's schema holds, and is still over no level of that schema.
 */
export const DeliverApart = schema("DeliverApart", Rec.values(Deliver.relations), [])
