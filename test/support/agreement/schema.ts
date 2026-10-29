import { pg, uuid } from "#compiler/public/fields.ts"
import { key, relation, schema } from "#compiler/public/schema.ts"

/**
 * The schema the type/engine agreement draws its queries over (test/support/agreement/queries.ts), small enough that
 * every draw meets each kind of key the evidence types reason about: a single-field primary key (Item.id), a candidate
 * key over two fields (Item's owner and n), a composite primary key (Tag's item and label) and a one-to-one key over a
 * reference (Note.item). Its uuid fields join one another and so do its integer fields, so a drawn join may meet any
 * key from any side.
 */
export const Item = relation("Item", { id: uuid, owner: uuid, n: pg.integer, m: pg.integer }, [
	"id"
])

export const Tag = relation("Tag", { item: uuid, label: pg.integer, w: pg.integer }, [
	"item",
	"label"
])
export const Note = relation("Note", { item: uuid, k: pg.integer }, ["item"])
export const Agree = schema("Agree", { Item, Tag, Note }, [key(Item, ["owner", "n"])])
