import {
	closed,
	closedRelation,
	f,
	ge,
	literal,
	relation,
	type SchemaDesc,
	value
} from "#test/support/fixtures/ir/desc.ts"

export const Lower = f.regex("^[a-z]+$", "u")
/** Bounded, so it can be a key field. */
export const Code = f.regex("^[a-z0-9]{1,32}$", "u")
export const Qty = f.contract("Qty", f.integer, ge(value, literal(0)))

/**
 * Schemas for the checker's tests: the worked example's Work and a small Lab schema that has
 * what Work lacks: regex text of different patterns, numeric typmods, a span, a serial field, and a roster with a
 * closed relation over it.
 */
export const Lab: SchemaDesc = {
	name: "Lab",
	relations: [
		closed("Color", ["red", "green", "blue"]),
		closedRelation(
			"ColorRank",
			{ color: f.closedId("Color"), rank: f.integer },
			["color"],
			[
				{ color: "red", rank: 1 },
				{ color: "green", rank: 2 },
				{ color: "blue", rank: 3 }
			]
		),
		relation(
			"Item",
			{
				id: f.uuid,
				label: Lower,
				qty: Qty,
				price: f.numeric(10, 2),
				during: f.span(f.bigint, undefined),
				color: f.closedId("Color")
			},
			["id"]
		),
		relation("Tag", { item: f.uuid, label: Code, note: f.wildcard }, ["item", "label"]),
		relation("Entry", { entry: f.bigserial, item: f.uuid, amount: f.bigint }, ["entry"]),
		relation("Wide", { id: f.uuid, price: f.numeric(12, 4) }, ["id"])
	],
	statements: [],
	extends: undefined
}
