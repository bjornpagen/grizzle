/**
 * The grizzle tier's login (once.test.ts): one relation of every carrier a CLI flag spells differently (an int4 key, an
 * int8, a numeric(12, 2), a money, a boolean, a float4, a refined text, a date, bytes and a uuid under a contract), a
 * law that refuses an id below 1, and one role, `app`, writing it, whose workload holds one member of every shape a
 * role serves: a set read by an int8 floor, a set read by a refined text, a key, an ordered read paged from either end,
 * a read at its call's instant bound to the database's clock, a read answered at its call's instant alone
 * (answered(...)), a put, and a deletion of every item. `grizzle generate`
 * drafts it and `grizzle migrate` installs it through grizzle.config.ts, as an application's would be.
 */
import * as g from "@bjornpagen/grizzle"

/** A name of lower-case letters, one to eight. */
const Name = g.str.regex("^[a-z]{1,8}$")

/** The key of an item's tag. */
const itemTag = Symbol("ItemTag")

/** An item's tag: a uuid, under a contract that says whose id it is, as grizzle takes every uuid. */
const Tag = g.domain<typeof itemTag>()("ItemTag", g.uuid)

const Item = g.relation(
	"Item",
	{
		id: g.int4,
		big: g.int8,
		amount: g.numeric(12, 2),
		cash: g.money,
		flag: g.bool,
		ratio: g.float4,
		name: Name,
		day: g.date,
		blob: g.bytea,
		tag: Tag
	},
	["id"]
)

/** The items' schema: an item is open, mutable inside its unit, so its role puts and deletes it; an id below 1 is
 * refused by its law. */
export const Items = g.schema(
	"Items",
	[Item],
	[g.unit("Item", { id: g.int4 }), g.mutable(Item), g.check("Counted", Item, (x) => x.ge(x.id, 1))]
)

/** Every item. */
const everyItem = g.query(Items).rule((r) => {
	const item = g.v(Item, "item")
	return r.match(Item, item).find(item)
})

/** The role the login serves: it reads and writes every item. */
const App = g.role(Items, "app", { Item }, { write: ["Item"] })

/**
 * The role's members: a set read by an int8 floor, a set read by a name, a key, an ordered read by its windows, a read
 * of the items whose int8 is at most the database's clock in milliseconds at the call's instant, every item answered
 * once and never live, a put, and a deletion of every item.
 */
const programs = Object.freeze({
	atLeast: g.query(Items).rule((r) => {
		const item = g.v(Item, "item")
		return r
			.match(Item, item)
			.where(r.ge(item.big, r.param("floor", g.int8)))
			.find(item)
	}),
	named: g.query(Items).rule((r) => {
		const item = g.v(Item, "item")
		return r
			.match(Item, item)
			.where(r.eq(item.name, r.param("name", Name)))
			.find(item)
	}),
	ranked: g.paged(everyItem.orderBy(["big", "desc"], ["id", "asc"])),
	item: Item,
	past: g.clocked(
		g.query(Items).rule((r) => {
			const item = g.v(Item, "item")
			return r
				.match(Item, item)
				.where(r.le(item.big, r.param("now", g.int8)))
				.find(item)
		}),
		{ now: "millis" }
	),
	listed: g.answered(everyItem),
	put: g.ChangeSet.empty(Items).put(Item, []),
	clear: g.ChangeSet.empty(Items).delete(Item, everyItem)
})

/** The login a CLI is generated for: its one role and that role's workload. */
export const Server = g.login(Items, "server", [App], { workload: [g.workload(App, programs)] })
