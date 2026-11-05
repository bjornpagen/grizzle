import { ChangeSet } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import {
	accumulated,
	Bits,
	bits,
	closedId,
	drawn,
	generated,
	natural,
	pg,
	type Uuid,
	uuid
} from "#compiler/public/fields.ts"
import { type HeadOf, query, v } from "#compiler/public/query.ts"
import {
	closed,
	counted,
	type Fact,
	type Fin,
	fin,
	fold,
	Monoid,
	on,
	ordered,
	relation,
	schema,
	tree
} from "#compiler/public/schema.ts"
import type { Addition, AdditionIn, Written } from "#compiler/types/changeset/changeset.ts"
import type { Bits as BitsOf } from "#compiler/types/fields/field.ts"
import type { Equals, Expect, IsAssignable, Not } from "#test/types/schema/support.ts"

/**
 * Families, trees, folds and the field kinds they write (drawn, accumulated and generated), as the public barrels type
 * them. Typechecked only; every `@ts-expect-error -- TSnnnn` names the diagnostic the type-test batch requires on its
 * next line.
 *
 * The oracle is the type checker. fin(O, n) is O's slots over its drawn count; a fact and a query's head hold every
 * field; an addition holds the fields its caller writes, no drawn, accumulated or generated one. Rows first
 * (rows-first.md §1, §4): an addition in a schema nests a sequence's members, an ordered family's or a tree's, at its
 * owner's count field, each less what its nesting supplies (its group, and a tree's root field), so no tree's addition
 * names `parent` and no row below a root names the root field; a counted family is never nested, its owner and its
 * members each inserted as their written rows, a member's group key naming its owner. A put of any relation, owner or
 * member, takes its written row. A fold's step and end are typed by the family, the monoid and the step value's type.
 */
export const Flag = closed("Flag", ["on", "off"])
export const Kind = closed("Kind", ["low", "high"])

/** An order owns its lines, an ordered family over its drawn n, and folds them four ways into its accumulated ends. */
export const Order = relation(
	"Order",
	{
		id: uuid,
		n: drawn(natural),
		total: accumulated(pg.bigint, 0n),
		seen: accumulated(bits(Flag), Bits.of(Flag, [])),
		ones: accumulated(bits(Flag), Bits.of(Flag, [])),
		twice: accumulated(bits(Flag), Bits.of(Flag, [])),
		top: accumulated(closedId(Kind), "low"),
		lines: accumulated(natural, 0n),
		ratio: accumulated(pg.float8, 0)
	},
	["id"]
)

/** A line: its group and drawn index, its values, a sum's accumulator pair, and a field PostgreSQL generates. */
export const Line = relation.generated(
	"Line",
	{
		order: uuid,
		at: drawn(natural),
		qty: pg.bigint,
		price: pg.float8,
		flags: bits(Flag),
		kind: closedId(Kind),
		before: accumulated(pg.bigint, 0n),
		after: accumulated(pg.bigint, 0n)
	},
	["order", "at"],
	(r) => ({ more: generated(pg.bigint, Compute.cast(Compute.add(r.qty, 1n), pg.bigint)) })
)

export const orderSlots = fin(Order, "n")
export type OrderSlots = Expect<Equals<typeof orderSlots, Fin<typeof Order, "n">>>
/** fin counts a drawn natural of its owner, and no other field. */
// @ts-expect-error -- TS2345: fin's count is a drawn natural of its owner
export const finOfAccumulated = fin(Order, "lines")
// @ts-expect-error -- TS2345: fin's count is a drawn natural of its owner
export const finOfKey = fin(Order, "id")

export const lines = ordered(on(Line, "order", "at"), orderSlots)
export const lineTotal = fold(
	lines,
	Monoid.sum,
	on(Line, "order", "qty", "before", "after"),
	on(Order, "id", "total")
)
export const lineFlags = fold(lines, Monoid.or, on(Line, "order", "flags"), on(Order, "id", "seen"))
export const lineTwos = fold(
	lines,
	Monoid.twos,
	on(Line, "order", "flags"),
	on(Order, "id", "ones", "twice")
)
export const lineTop = fold(lines, Monoid.max, on(Line, "order", "kind"), on(Order, "id", "top"))
export const lineCount = fold(lines, Monoid.count, on(Line, "order"), on(Order, "id", "lines"))

/**
 * A pool's items, a counted family: an unordered set of member rows, their index hidden; their count folded into the
 * pool.
 */
export const Pool = relation(
	"Pool",
	{ id: uuid, k: drawn(natural), size: accumulated(natural, 0n), sum: accumulated(pg.integer, 0) },
	["id"]
)
export const Item = relation(
	"Item",
	{
		pool: uuid,
		v: pg.integer,
		before: accumulated(pg.integer, 0),
		after: accumulated(pg.integer, 0)
	},
	["pool", "v"]
)
export const items = counted(on(Item, "pool"), fin(Pool, "k"))
export const itemCount = fold(items, Monoid.count, on(Item, "pool"), on(Pool, "id", "size"))
export const itemSum = fold(items, Monoid.sum, on(Item, "pool", "v"), on(Pool, "id", "sum"))

/** A document's nodes, a tree: each row's drawn at, children, start and end, the root field doc its tree's. */
export const Node = relation(
	"Node",
	{
		id: uuid,
		parent: uuid,
		at: drawn(natural),
		children: drawn(natural),
		start: drawn(natural),
		end: drawn(natural),
		doc: uuid,
		label: pg.integer
	},
	["id"]
)
export const nodes = tree(on(Node, "parent", "at"), fin(Node, "children"), { root: "doc" })

export const Families = schema("Families", { Flag, Kind, Order, Line, Pool, Item, Node }, [
	lines,
	lineTotal,
	lineFlags,
	lineTwos,
	lineTop,
	lineCount,
	items,
	itemCount,
	itemSum,
	nodes
])

/** A fact holds every field, drawn, accumulated and generated alike. */
export type LineFact = Expect<
	Equals<
		keyof Fact<typeof Line>,
		"order" | "at" | "qty" | "price" | "flags" | "kind" | "before" | "after" | "more"
	>
>
export type OrderFact = Expect<
	Equals<
		keyof Fact<typeof Order>,
		"id" | "n" | "total" | "seen" | "ones" | "twice" | "top" | "lines" | "ratio"
	>
>
export type LineAt = Expect<Equals<Fact<typeof Line>["at"], bigint>>
export type OrderSeen = Expect<Equals<Fact<typeof Order>["seen"], BitsOf<typeof Flag>>>

/** A query's head holds them too, each at its type. */
export const lineHead = query(Families).rule((r) => {
	const { order, at, before, more } = v(Line, "line")
	return r.match(Line, { order, at, before, more }).find({ order, at, before, more })
})
export type LineHead = Expect<
	Equals<
		HeadOf<typeof lineHead>,
		{ readonly order: Uuid; readonly at: bigint; readonly before: bigint; readonly more: bigint }
	>
>

/** An addition holds the fields its caller writes: no drawn, accumulated or generated field. */
export type OrderAddition = Expect<Equals<keyof Addition<typeof Order>, "id">>
export type LineAddition = Expect<
	Equals<keyof Addition<typeof Line>, "order" | "qty" | "price" | "flags" | "kind">
>
export type NodeAddition = Expect<
	Equals<keyof Addition<typeof Node>, "id" | "parent" | "doc" | "label">
>

/** In the schema, a sequence's members nest at its owner's count field, less the group the nesting supplies. */
type OrderIn = AdditionIn<typeof Families, typeof Order>
type LineIn = OrderIn["n"][number]
export type OrderInKeys = Expect<Equals<keyof OrderIn, "id" | "n">>
export type OrderInLines = Expect<Equals<keyof LineIn, "qty" | "price" | "flags" | "kind">>
export type LineInNoIndex = Expect<
	Not<IsAssignable<"at" | "before" | "after" | "more", keyof LineIn>>
>
/**
 * A counted owner's and a counted member's additions are their written rows, no nesting at the count: each is
 * assignable to its written row and back, and holds its written fields alone.
 */
type SameRows<A, B> = [IsAssignable<A, B>, IsAssignable<B, A>] extends [true, true] ? true : false
export type PoolIn = Expect<
	SameRows<AdditionIn<typeof Families, typeof Pool>, Written<typeof Pool>>
>
export type PoolInKeys = Expect<Equals<keyof AdditionIn<typeof Families, typeof Pool>, "id">>
export type ItemIn = Expect<Equals<AdditionIn<typeof Families, typeof Item>, Addition<typeof Item>>>
export type ItemWritten = Expect<
	SameRows<AdditionIn<typeof Families, typeof Item>, Written<typeof Item>>
>
export type ItemInKeys = Expect<
	Equals<keyof AdditionIn<typeof Families, typeof Item>, "pool" | "v">
>

/** A tree's addition names no parent, and a row below its root names no root field: the nesting supplies both. */
type NodeIn = AdditionIn<typeof Families, typeof Node>
type ChildIn = NodeIn["children"][number]
export type NodeInKeys = Expect<Equals<keyof NodeIn, "id" | "doc" | "label" | "children">>
export type ChildInKeys = Expect<Equals<keyof ChildIn, "id" | "label" | "children">>
export type GrandchildInKeys = Expect<
	Equals<keyof ChildIn["children"][number], "id" | "label" | "children">
>

declare const someId: Uuid

/**
 * A sequence's owner is inserted with its members nested at its count field, a tree with its children nested; a
 * counted owner and its members are inserted as rows, the members by their group key.
 */
export const nestedWrites = ChangeSet.empty(Families)
	.insert(Order, [
		{
			id: someId,
			n: [
				{ qty: 1n, price: 0.5, flags: Bits.of(Flag, ["on"]), kind: "low" },
				{ qty: 2n, price: 1.5, flags: Bits.of(Flag, []), kind: "high" }
			]
		}
	])
	.insert(Pool, [{ id: someId }])
	.insert(Item, [
		{ pool: someId, v: 1 },
		{ pool: someId, v: 2 }
	])
	.insert(Node, [
		{
			id: someId,
			doc: someId,
			label: 0,
			children: [{ id: someId, label: 1, children: [{ id: someId, label: 2, children: [] }] }]
		}
	])

/** An ordered member is written under its owner, never alone: its order is the nesting's. */
export const memberInsert = ChangeSet.empty(Families).insert(
	// @ts-expect-error -- TS2345 refusal: a sequence's member is written under its owner: nest it in order at the owner's count field
	Line,
	[{ order: someId, qty: 1n, price: 0.5, flags: Bits.of(Flag, []), kind: "low" }]
)

/** A counted member is never nested under its owner: its group key is its membership. */
export const countedNested = ChangeSet.empty(Families).insert(
	Pool,
	// @ts-expect-error -- TS2345 refusal: a member fact is not a fact of the relation
	[{ id: someId, k: [{ v: 1 }] }]
)

/** A put of any relation takes its written row: an owner's, an ordered member's, a counted member's, a tree row's. */
export const writtenPuts = ChangeSet.empty(Families)
	.put(Order, [{ id: someId }])
	.put(Line, [{ order: someId, qty: 1n, price: 0.5, flags: Bits.of(Flag, []), kind: "low" }])
	.put(Pool, [{ id: someId }])
	.put(Item, [{ pool: someId, v: 1 }])
	.put(Node, [{ id: someId, parent: someId, doc: someId, label: 0 }])

/** A put is a whole written row: no field of it left out, and no drawn, accumulated or nested field. */
export const putPartial = ChangeSet.empty(Families).put(
	Item,
	// @ts-expect-error -- TS2741: a put is a whole written row, every written field stated
	[{ pool: someId }]
)
export const putDrawn = ChangeSet.empty(Families).put(
	Item,
	// @ts-expect-error -- TS2345 refusal: a member fact is not a fact of the relation
	[{ pool: someId, v: 1, before: 0 }]
)
export const putNested = ChangeSet.empty(Families).put(
	Order,
	// @ts-expect-error -- TS2345 refusal: a member fact is not a fact of the relation
	[{ id: someId, n: [] }]
)

/** A fold over a counted family names no accumulator pair: a visible one would show the hidden order. */
export const countedPair = fold(
	items,
	Monoid.sum,
	// @ts-expect-error -- TS2345 refusal: a fold over a counted family hides its accumulators: name the step's value alone
	on(Item, "pool", "v", "before", "after"),
	on(Pool, "id", "sum")
)

/** sum combines exact numbers, never a float; or and twos combine sets. */
export const floatSum = fold(
	lines,
	Monoid.sum,
	// @ts-expect-error -- TS2345 refusal: the monoid admits the step value's type: sum an exact number, or and twos a set, max an ordered value with a least one
	on(Line, "order", "price"),
	on(Order, "id", "ratio")
)
export const orOfNumbers = fold(
	lines,
	Monoid.or,
	// @ts-expect-error -- TS2345 refusal: the monoid admits the step value's type: sum an exact number, or and twos a set, max an ordered value with a least one
	on(Line, "order", "qty"),
	on(Order, "id", "total")
)

/** A fold's end holds one accumulated field per plane of the step value's type. */
export const wrongEnd = fold(
	lines,
	Monoid.sum,
	on(Line, "order", "qty"),
	// @ts-expect-error -- TS2345 refusal: a fold's end names one accumulated field of the owner per plane
	on(Order, "id", "seen")
)
export const oneTwosPlane = fold(
	lines,
	Monoid.twos,
	on(Line, "order", "flags"),
	// @ts-expect-error -- TS2345 refusal: a fold's end names one accumulated field of the owner per plane
	on(Order, "id", "ones")
)

/** A tree's parent is of its relation's key's type. */
export const Loose = relation(
	"Loose",
	{
		id: uuid,
		parent: pg.integer,
		at: drawn(natural),
		children: drawn(natural),
		start: drawn(natural),
		end: drawn(natural),
		doc: uuid
	},
	["id"]
)
export const looseTree = tree(
	// @ts-expect-error -- TS2345 refusal: a tree is a family of T over itself, on(T, parent, at), with drawn start and end
	on(Loose, "parent", "at"),
	fin(Loose, "children"),
	{ root: "doc" }
)

/** fin is a family's second argument, never a schema member. */
// @ts-expect-error -- TS2322: a schema's members are relations, and fin(O, n) is none
export const finMember = schema("FinMember", { Order, orderSlots }, [])

/** A drawn field is a natural grizzle draws; an accumulated field is of a value type, its start a value of it. */
// @ts-expect-error -- TS2741: a drawn field is a natural
export const drawnInteger = drawn(pg.integer)
export const accumulatedDrawn = accumulated(
	// @ts-expect-error -- TS2345 refusal: an accumulated field is of a value type: no span, vector or field of a writing of its own
	drawn(natural),
	0n
)
// @ts-expect-error -- TS2345: an accumulated field's start is a value of its type
export const accumulatedStart = accumulated(pg.bigint, 0)
