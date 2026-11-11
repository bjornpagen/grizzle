import { Array as Arr, String as Str } from "effect"
import { accumulated, drawn, natural, pg, uuid } from "#compiler/public/fields.ts"
import {
	type AnySchema,
	contained,
	counted,
	fin,
	fold,
	Monoid,
	mutable,
	on,
	relation,
	role,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import type { EntryValue } from "#compiler/types/schema/world.ts"
import { nonEmpty } from "#test/support/assert.ts"
import type { BuiltRole } from "#test/support/worlds/execute/build.ts"

/**
 * The entry-owner box: a role writing a family's owner through a query entry. Stores own a counted family of Items,
 * whose count `items` grizzle draws and whose quantities sum into the accumulated `stock`; an entry over Store fixes
 * `region` to "north" and holds `id` and `label`, the fields its facts state, beside the family's fields its head holds
 * (`Holds`); its filter reads the fixed region alone, the free `label` too, or a family field, read by a predicate or
 * fixed to a literal (`Filter`). A case writes one fact through the entry (`Op`), stating `id` and `label`, or also the
 * count (`Fact`).
 *
 * The oracle, schema/entry.ts writableEntry and the ChangeSet types: a role whose entry's filter reads a family field
 * is refused when it is declared, `filterReadsFamily` naming the field; every other role is declared, and a write
 * through its entry is admitted exactly when its fact states no family field, which no fact of the entry states.
 */

/** The family fields an entry's head holds besides `id` and `label`. */
export type Holds = "neither" | "count" | "end" | "both"

/** What an entry's filter reads besides its fixed region: nothing more, the free label, or a family field. */
export type Filter = "region" | "label" | "count read" | "end read" | "count fixed"

export type Op = "insert" | "put" | "delete"

/** What a written fact states: the entry's own fields, or the count too. */
export type Fact = "stated" | "count stated"

export interface EntryOwnerCase {
	readonly holds: Holds
	readonly filter: Filter
	readonly op: Op
	readonly fact: Fact
}

const holdsCount = (holds: Holds): boolean => holds === "count" || holds === "both"
const holdsEnd = (holds: Holds): boolean => holds === "end" || holds === "both"

/** The family field an entry's filter reads, the one its declaration is refused for; none for a stated filter. */
export const familyRead = (filter: Filter): "items" | "stock" | undefined => {
	switch (filter) {
		case "region":
		case "label":
			return undefined
		case "count read":
		case "count fixed":
			return "items"
		case "end read":
			return "stock"
	}
}

/** An entry shape the box holds: a count fixed to a literal is no head field, so its head holds no count. */
const shapes: ReadonlyArray<{ readonly holds: Holds; readonly filter: Filter }> = Arr.flatMap(
	["neither", "count", "end", "both"] as const,
	(holds) =>
		Arr.flatMap(["region", "label", "count read", "end read", "count fixed"] as const, (filter) =>
			filter === "count fixed" && holdsCount(holds) ? [] : [{ holds, filter }]
		)
)

/** Every case of the box: each entry shape, op and fact. */
export const entryOwnerCases: Arr.NonEmptyReadonlyArray<EntryOwnerCase> = nonEmpty(
	Arr.flatMap(shapes, (shape) =>
		Arr.flatMap(["insert", "put", "delete"] as const, (op) =>
			Arr.map(["stated", "count stated"] as const, (fact) => ({ ...shape, op, fact }))
		)
	),
	"the entry-owner box's cases"
)

/** Whether a case's role is declared: its entry's filter reads no family field. */
export const entryOwnerDeclared = (c: Pick<EntryOwnerCase, "filter">): boolean =>
	familyRead(c.filter) === undefined

/** Whether a declared role's write is refused: its fact states the count, which no fact of the entry states. */
export const entryOwnerRefused = (c: Pick<EntryOwnerCase, "fact">): boolean =>
	c.fact === "count stated"

/** A filter's name in an identifier. */
const filterWord = (filter: Filter): string => Str.replace(" ", "_")(filter)

/** The entry's name in its role, by its shape. */
export const entryName = (holds: Holds, filter: Filter): string =>
	`Stores_${holds}_${filterWord(filter)}`

/** The role's name, by its entry's shape. */
export const roleName = (holds: Holds, filter: Filter): string => `r_${holds}_${filterWord(filter)}`

/** The box's schema under the declared name `name`. */
export const shopOf = (name: string) => {
	const word = str.regex("^[a-z]{1,8}$")
	const Store = relation(
		"Store",
		{
			id: uuid,
			region: word,
			label: word,
			items: drawn(natural),
			stock: accumulated(pg.bigint, 0n)
		},
		["id"]
	)
	const Item = relation("Item", { id: uuid, store: uuid, region: word, qty: pg.bigint }, ["id"])
	const items = counted(on(Item, "store"), fin(Store, "items"))
	const shop = schema(
		name,
		[Store, Item],
		[
			items,
			fold(items, Monoid.sum, on(Item, "store", "qty"), on(Store, "id", "stock")),
			contained(on(Item, "store", "region"), on(Store, "id", "region")),
			mutable(Store),
			mutable(Item)
		]
	)
	return { shop, Store, Item }
}

export type Shop = ReturnType<typeof shopOf>

/** The entry of a shape over Store, its north stores. */
const entryOf = (built: Shop, holds: Holds, filter: Filter) =>
	queryOver(built.shop).rule((r: RuleValue) => {
		const s = varsOver(built.Store, "store")
		const count = holdsCount(holds) || filter === "count read"
		const end = holdsEnd(holds) || filter === "end read"
		const matched = r.match(built.Store, {
			id: s["id"],
			region: "north",
			label: s["label"],
			...(count ? { items: s["items"] } : filter === "count fixed" ? { items: 0n } : {}),
			...(end ? { stock: s["stock"] } : {})
		})
		const filtered =
			filter === "label"
				? matched.where(r.ne(s["label"], "zz"))
				: filter === "count read"
					? matched.where(r.ge(s["items"], 1n))
					: filter === "end read"
						? matched.where(r.ge(s["stock"], 0n))
						: matched
		return filtered.find({
			id: s["id"],
			label: s["label"],
			...(holdsCount(holds) ? { items: s["items"] } : {}),
			...(holdsEnd(holds) ? { stock: s["stock"] } : {})
		})
	})

/** The role writing Store through the entry of a shape, built as a JavaScript caller builds it: its declaration's
 * refusal is thrown, as `role` throws it. */
export const entryRole = (built: Shop, holds: Holds, filter: Filter): BuiltRole => {
	const base: AnySchema = built.shop
	const entry = entryName(holds, filter)
	const entries: Readonly<Record<string, EntryValue>> = { [entry]: entryOf(built, holds, filter) }
	const write: ReadonlyArray<string> = [entry]
	return role(base, roleName(holds, filter), entries, { write })
}
