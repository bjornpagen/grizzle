/** What result-order.test.ts and test/pg/physical/order-shape.test.ts read: their spaces, schemas, models and loads. */

import { defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int, map, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Order, Record as Rec, String as Str } from "effect"
import { isRecord } from "#compiler/core/record.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { mutable, relation, schema, unit } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/** The key fields after the unit's, which a case declares in an order of its own. */
const keyFields = ["a", "b", "c"] as const
type KeyField = (typeof keyFields)[number]

/** The mathematical script A, U+1D49C, past U+FFFF: UTF-16 holds it as the surrogates U+D835 U+DC9C. */
const scriptA = "\u{1d49c}"

/** The fullwidth z, U+FF5A: before the script A by code point, after it by UTF-16 unit. */
const fullwidthZ = "ｚ"

/**
 * Characters whose code point order no locale and no UTF-16 comparison keeps: an uppercase letter before every
 * lowercase one, a precomposed e acute and an e with its combining acute, which a locale equates, and the fullwidth z
 * before the script A.
 */
const alphabet = ["a", "B", "b", "é", "é", fullwidthZ, scriptA, " "] as const

const word: Gen<string> = map(array(element(alphabet), { min: 1, max: 2 }), (cs) =>
	Arr.join(cs, "")
)

/** A text field of up to eight code points. */
const Word = str.regex("^.{1,8}$", "su")

/** One stored item: its shelf, the unit it is mutable in, its three key fields and a note. */
export interface Item {
	readonly shelf: number
	readonly a: string
	readonly b: number
	readonly c: string
	readonly note: string
}

/**
 * A case: the order its key declares a, b and c in after the shelf, its items in the order they are inserted, the
 * table's physical order, the places of the items it updates after, in that order, each update moving its row's tuple
 * to the end of its page, and the shelf the shelf read is called at.
 */
export interface ResultOrderCase {
	readonly declared: ReadonlyArray<KeyField>
	readonly items: ReadonlyArray<Item>
	/** The item the read-back's write stocks: its b, 3, is no drawn item's, so its key is none of theirs. */
	readonly stocked: Item
	readonly moved: ReadonlyArray<number>
	readonly shelf: number
}

/** An item's key as one text: its key fields' texts, apart by a character no text holds. */
const itemKey = (i: Item): string => Arr.join([String(i.shelf), i.a, String(i.b), i.c], "\u0000")

const itemGen: Gen<Item> = (source) => ({
	shelf: source.draw(int(0, 1)),
	a: source.draw(word),
	b: source.draw(int(-2, 2)),
	c: source.draw(word),
	note: source.draw(word)
})

/** Items each of its own key: of items drawn with one key, the first. */
const distinctItems = (items: ReadonlyArray<Item>): ReadonlyArray<Item> => {
	const byKey = new Map<string, Item>()
	for (const item of items) {
		const key = itemKey(item)
		if (!byKey.has(key)) {
			byKey.set(key, item)
		}
	}
	return [...byKey.values()]
}

export const caseGen: Gen<ResultOrderCase> = (source) => {
	const declared = source.draw(shuffled(keyFields, { min: 3, max: 3 }))
	const items = distinctItems(source.draw(array(itemGen, { min: 2, max: 12 })))
	const moved = source.draw(
		shuffled(
			Arr.map(items, (_, at) => at),
			{ min: 0, max: items.length }
		)
	)
	return {
		declared,
		items,
		stocked: { ...source.draw(itemGen), b: 3 },
		moved,
		shelf: source.draw(int(0, 1))
	}
}

/**
 * The schema of a case's key order under `name`, Item keyed (shelf, ...declared) and mutable in its shelf, and the
 * reads every case serves: every item, the items of one shelf, whose shelf the parameter fixes, the pairs of a and
 * note and each item's twins less b, projections that keep no key. None states an order.
 */
const declaredIn = (declared: ReadonlyArray<KeyField>) => (name: string) => {
	const Item = relation("Item", { shelf: int4, a: Word, b: int4, c: Word, note: Word }, [
		"shelf",
		...declared
	])
	const s = schema(name, [Item], [unit("Shelf", { shelf: int4 }), mutable(Item)])
	const all = query(s).rule((r) => {
		const { shelf, a, b, c, note } = v(Item, "item")
		return r.match(Item, { shelf, a, b, c, note }).find({ shelf, a, b, c, note })
	})
	const onShelf = query(s).rule((r) => {
		const { shelf, a, b, c, note } = v(Item, "item")
		return r
			.match(Item, { shelf, a, b, c, note })
			.where(r.eq(shelf, r.param("shelf", int4)))
			.find({ a, b, c, note })
	})
	const pairs = query(s).rule((r) => {
		const { a, note } = v(Item, "item")
		return r.match(Item, { a, note }).find({ a, note })
	})
	/**
	 * Each item's c beside the c of every item of its shelf, a and b, its twins, less b: a join that drops a key field of
	 * both sides, so no key, a DISTINCT over the join, whose rows the planner takes for as many as the join's.
	 */
	const twins = query(s).rule((r) => {
		const { shelf, a, b, c } = v(Item, "item")
		const twin = v(Item, "twin")
		return r
			.match(Item, { shelf, a, b, c })
			.match(Item, { shelf, a, b, c: twin.c })
			.find({ shelf, a, c, twin: twin.c })
	})
	/**
	 * A union of two heading groups told apart by `side`: shelf 0's items with their notes, side 0, and shelf 1's
	 * without, side 1.
	 */
	const sides = query(s)
		.rule((r) => {
			const { a, b, c, note } = v(Item, "item")
			return r.match(Item, { shelf: 0, a, b, c, note }).find({ side: 0, a, b, c, note })
		})
		.rule((r) => {
			const { a, b, c } = v(Item, "item")
			return r.match(Item, { shelf: 1, a, b, c }).find({ side: 1, a, b, c })
		})
	/** An item stocked, every item read back after it. */
	const stock = ChangeSet.empty(s)
		.insert(Item, [])
		.read("items", () => all)
	return { schema: s, programs: { all, onShelf, pairs, twins, sides, stock } }
}

/** The installation of a case's schema under `name`: its schema and the login serving its reads. */
export const installationOf = (declared: ReadonlyArray<KeyField>) => (name: string) => {
	const built = declaredIn(declared)(name)
	return { schema: built.schema, logins: [fullWorld(built.schema, built.programs, []).server] }
}

/** The served world and reads of a case's schema over its installation's declared name. */
export const servedOf = (declared: ReadonlyArray<KeyField>, name: string) => {
	const built = declaredIn(declared)(name)
	return { world: fullWorld(built.schema, built.programs, []), programs: built.programs }
}

/**
 * Texts by code point, as PostgreSQL's pg_c_utf8 orders them: their UTF-8 bytes compared, whose order is their code
 * points', where a UTF-16 comparison puts a character past U+FFFF before U+FF5A.
 */
const byCodePoints = Order.make<string>((x, y) => {
	const d = Buffer.compare(Buffer.from(x, "utf8"), Buffer.from(y, "utf8"))
	return d < 0 ? -1 : d > 0 ? 1 : 0
})

type Field = keyof Item

/** A row as the model holds it: each field a read delivers, by name, a text or an integer. */
export type Row = Readonly<Record<string, string | number>>

/** One field of rows ascending: a text by its code points, an integer numerically. */
const byField = (f: Field): Order.Order<Row> =>
	Order.make((x, y) => {
		const p = x[f]
		const q = y[f]
		return typeof p === "string" && typeof q === "string"
			? byCodePoints(p, q)
			: Order.Number(Number(p), Number(q))
	})

/** Rows by `fields` ascending, field by field. */
const ordered = (rows: ReadonlyArray<Row>, fields: ReadonlyArray<Field>): Array<Row> =>
	Arr.sort(rows, Order.combineAll(Arr.map(fields, byField)))

/** `items` projected onto `fields`, each row once. */
const projected = (
	items: ReadonlyArray<Item>,
	fields: ReadonlyArray<Field>
): ReadonlyArray<Row> => {
	const seen = new Map<string, Row>()
	for (const item of items) {
		seen.set(
			Arr.join(
				Arr.map(fields, (f) => String(item[f])),
				"\u0000"
			),
			Rec.fromEntries(Arr.map(fields, (f) => [f, item[f]] as const))
		)
	}
	return [...seen.values()]
}

/**
 * Each read's rows as the ruling states them: a read that states no order delivers its rows by its key, ascending, in
 * the order its declaration names the key's fields, a field its parameter fixes ordering nothing; a projection that
 * keeps no key by its whole heading, field by field in the heading's order, its fields' names'.
 */
export const expectedOf = (c: ResultOrderCase) => ({
	all: ordered(projected(c.items, ["shelf", "a", "b", "c", "note"]), ["shelf", ...c.declared]),
	onShelf: ordered(
		projected(
			Arr.filter(c.items, (i) => i.shelf === c.shelf),
			["a", "b", "c", "note"]
		),
		c.declared
	),
	pairs: ordered(projected(c.items, ["a", "note"]), ["a", "note"]),
	/**
	 * The union's rows by its key, which lies within the fields its groups share: the side, so side 0's group comes
	 * first, then the item's key in its declared order, the one order of every group.
	 */
	sides: [
		...Arr.map(
			ordered(
				projected(
					Arr.filter(c.items, (i) => i.shelf === 0),
					["a", "b", "c", "note"]
				),
				c.declared
			),
			(row): Row => ({ side: 0, ...row })
		),
		...Arr.map(
			ordered(
				projected(
					Arr.filter(c.items, (i) => i.shelf === 1),
					["a", "b", "c"]
				),
				c.declared
			),
			(row): Row => ({ side: 1, ...row })
		)
	],
	/** The read-back of every item, the stocked one among them, by its key as `all`. */
	stocked: ordered(projected([...c.items, c.stocked], ["shelf", "a", "b", "c", "note"]), [
		"shelf",
		...c.declared
	])
})

/** A delivered row as the model writes it: the fields a read delivers, by name, each a text or a number. */
export const rowOf =
	(fields: ReadonlyArray<string>) =>
	(row: unknown): Row =>
		isRecord(row)
			? Rec.fromEntries(
					Arr.map(fields, (f) => {
						const value = row[f]
						return [
							f,
							typeof value === "number" || typeof value === "string" ? value : String(value)
						] as const
					})
				)
			: {}

/** Item's table and columns as the installation names them, quoted. */
const tableOf = (installed: Installed) => ({
	table: printObjectName(installed.names.relation("Item")),
	column: (f: Field) => quoteIdent(installed.names.column("Item", f))
})

/** Inserts `items` in their order, so the table holds them in that physical order. */
export const insertItems = (installed: Installed, items: ReadonlyArray<Item>) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const { table, column } = tableOf(installed)
		const fields: ReadonlyArray<Field> = ["shelf", "a", "b", "c", "note"]
		for (const item of items) {
			yield* admin.query(
				`INSERT INTO ${table} (${Arr.join(Arr.map(fields, column), ", ")}) VALUES ($1, $2, $3, $4, $5)`,
				Arr.map(fields, (f) => item[f])
			)
		}
	})

/** Updates each moved item's note to itself, in order: a new tuple of the row, at the end of its page. */
export const moveItems = (installed: Installed, c: ResultOrderCase) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const { table, column } = tableOf(installed)
		for (const at of c.moved) {
			const item = defined(c.items[at], "a moved item")
			yield* admin.query(
				`UPDATE ${table} SET ${column("note")} = ${column("note")} WHERE ${column("shelf")} = $1 AND ${column("a")} = $2 AND ${column("b")} = $3 AND ${column("c")} = $4`,
				[item.shelf, item.a, item.b, item.c]
			)
		}
	})

/** Whether a case declares its key out of its fields' name order, which a name-order completion would not follow. */
export const declaredUnlikeNames = (c: Pick<ResultOrderCase, "declared">): boolean =>
	Arr.some(c.declared, (f, i) => f !== keyFields[i])

export type ResultOrderFeature =
	| "a key declared out of its fields' name order"
	| "a row moved after it was inserted"
	| "texts ordered by code point where UTF-16 differs"
	| "a shelf's read, its shelf fixed"
	| "a projection that keeps no key"

/** Whether a text of one of `items` holds `ch`. */
const holds = (items: ReadonlyArray<Item>, ch: string): boolean =>
	Arr.some(items, (i) => Str.includes(ch)(i.a) || Str.includes(ch)(i.c))

/** What a case reaches. */
export const featuresOf = (c: ResultOrderCase): ReadonlyArray<ResultOrderFeature> => [
	...(declaredUnlikeNames(c) ? ["a key declared out of its fields' name order" as const] : []),
	...(c.moved.length > 0 ? ["a row moved after it was inserted" as const] : []),
	...(holds(c.items, scriptA) && holds(c.items, fullwidthZ)
		? ["texts ordered by code point where UTF-16 differs" as const]
		: []),
	...(Arr.some(c.items, (i) => i.shelf === c.shelf)
		? ["a shelf's read, its shelf fixed" as const]
		: []),
	...(c.items.length > 1 ? ["a projection that keeps no key" as const] : [])
]
