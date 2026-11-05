import { closedId, contract, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, key, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"

/**
 * The schema the type/engine agreements draw their queries over (test/support/agreement/queries.ts, admission.ts).
 *
 * The evidence agreement's relations are small enough that every draw meets each kind of key the evidence types reason
 * about: a single-field primary key (Item.id), a candidate key over two fields (Item's owner and n), a composite primary
 * key (Tag's item and label) and a one-to-one key over a reference (Note.item). Its uuid fields join one another and so
 * do its integer fields, so a drawn join may meet any key from any side; Item.tone is a roster's, which a handle or a
 * member's JavaScript value binds, fixes, heads and discriminates. Tones, a union of Item's facts of two tones whose
 * arms hold Tone's handles at tone, is the union source a drawn rule matches with a constant bound at tone.
 *
 * Cell holds one column per constant kind the admission matrix draws: a JavaScript value of every carrier, Tone's
 * handles, typed integer constants and a contract's, and a finite refined text's members (grade); Shade, a second
 * roster sharing a member with Tone, gives the wrong-roster arm.
 */
export const Tone = closed("Tone", ["low", "mid", "high"])
export const Shade = closed("Shade", ["low", "dark"])
export const Cents = contract("Cents", pg.bigint, (x) => x.ge(0n))

export const Item = relation(
	"Item",
	{ id: uuid, owner: uuid, n: pg.integer, m: pg.integer, tone: closedId(Tone) },
	["id"]
)

export const Tag = relation("Tag", { item: uuid, label: pg.integer, w: pg.integer }, [
	"item",
	"label"
])
export const Note = relation("Note", { item: uuid, k: pg.integer }, ["item"])

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

export const Agree = schema("Agree", { Tone, Shade, Item, Tag, Note, Cell }, [
	key(on(Item, "owner", "n"))
])

export const Tones = query(Agree)
	.rule((r) => {
		const { id } = v(Item, "item")
		return r.match(Item, { id, tone: "low" }).find({ id, tone: Tone.handle("low") })
	})
	.rule((r) => {
		const { id } = v(Item, "item")
		return r.match(Item, { id, tone: "mid" }).find({ id, tone: Tone.handle("mid") })
	})
