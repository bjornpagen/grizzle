/** What known-imports.test.ts reads: its box, its schema and the write of a case. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { int4, int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"

/** How deep the items stand inside the import the second member reads: read by it, or by an import it reads. */
export type Depth = "one deep" | "two deep"

/** Where the first member reads the items before that import: itself, or inside another import of the items. */
export type Before = "read by the member" | "read inside another import"

export interface Known {
	readonly depth: Depth
	readonly before: Before
}

export const knownGen: Gen<Known> = (s) => ({
	depth: s.draw(element<Depth>(["one deep", "two deep"])),
	before: s.draw(element<Before>(["read by the member", "read inside another import"]))
})

/** A session's items, its sittings, and the rows the members write. */
const Item = relation("Item", { session: int4, k: int8, v: int8 }, ["session", "k"])
const Sitting = relation("Sitting", { session: int4, opened: int4 }, ["session"])
const First = relation("First", { k: int8, v: int8 }, ["k", "v"])
const Second = relation("Second", { k: int8, v: int8 }, ["k", "v"])
export const Known = schema("KnownImports", [Item, Sitting, First, Second], [])

/** A set of sessions: the call's sittings, a relation parameter, and the sessions it takes, which the ChangeSet binds. */
const sessions = { session: int4 } as const

/**
 * The sessions the call takes: those of its sittings, a relation parameter, that a sitting holds, which the ChangeSet
 * binds `taken` to; so `sittings` is used inside this query alone, wherever a read of `taken` reads it.
 */
const carried = query(Known).rule((r) => {
	const { session, opened } = v(Sitting, "sitting")
	return r
		.match(r.relation("sittings", sessions), { session })
		.match(Sitting, { session, opened })
		.find({ session })
})

/** The items of the sessions the call takes, the one import that reads `taken`. */
const items = query(Known).rule((r) => {
	const { session, k, v: x } = v(Item, "item")
	return r
		.match(r.relation("taken", sessions), { session })
		.match(Item, { session, k, v: x })
		.find({ k, v: x })
})

/** The items of `taken` whose v is at least 1: an import that reads the items whole, so it reads `taken` through them. */
const outerOne = query(Known).rule((r) => {
	const read = items.bind({ taken: r.relation("taken", sessions) })
	const { k, v: x } = v(read, "items")
	return r.match(read, { k, v: x }).where(r.ge(x, 1n)).find({ k, v: x })
})

/** The rows of `outerOne` whose v is at least 2: an import that reads the items two imports deep. */
const outerTwo = query(Known).rule((r) => {
	const read = outerOne.bind({ taken: r.relation("taken", sessions) })
	const { k, v: x } = v(read, "outer")
	return r.match(read, { k, v: x }).where(r.ge(x, 2n)).find({ k, v: x })
})

/** The items of `taken` whose v is at least 3: another import of the items, which the first member may read them in. */
const beside = query(Known).rule((r) => {
	const read = items.bind({ taken: r.relation("taken", sessions) })
	const { k, v: x } = v(read, "items")
	return r.match(read, { k, v: x }).where(r.ge(x, 3n)).find({ k, v: x })
})

/** The first member's query: the items, read itself, then `outerOne`, which reads them again one import deep. */
const itemsThenOne = query(Known).rule((r) => {
	const first = items.bind({ taken: r.relation("taken", sessions) })
	const then = outerOne.bind({ taken: r.relation("taken", sessions) })
	const { k, v: x } = v(first, "first")
	const { v: y } = v(then, "then")
	return r.match(first, { k, v: x }).match(then, { k, v: y }).find({ k, v: x })
})

/** The first member's query: the items, read itself, then `outerTwo`, which reads them again two imports deep. */
const itemsThenTwo = query(Known).rule((r) => {
	const first = items.bind({ taken: r.relation("taken", sessions) })
	const then = outerTwo.bind({ taken: r.relation("taken", sessions) })
	const { k, v: x } = v(first, "first")
	const { v: y } = v(then, "then")
	return r.match(first, { k, v: x }).match(then, { k, v: y }).find({ k, v: x })
})

/** The first member's query: the items, read inside `beside`, then `outerOne`. */
const besideThenOne = query(Known).rule((r) => {
	const first = beside.bind({ taken: r.relation("taken", sessions) })
	const then = outerOne.bind({ taken: r.relation("taken", sessions) })
	const { k, v: x } = v(first, "first")
	const { v: y } = v(then, "then")
	return r.match(first, { k, v: x }).match(then, { k, v: y }).find({ k, v: x })
})

/** The first member's query: the items, read inside `beside`, then `outerTwo`. */
const besideThenTwo = query(Known).rule((r) => {
	const first = beside.bind({ taken: r.relation("taken", sessions) })
	const then = outerTwo.bind({ taken: r.relation("taken", sessions) })
	const { k, v: x } = v(first, "first")
	const { v: y } = v(then, "then")
	return r.match(first, { k, v: x }).match(then, { k, v: y }).find({ k, v: x })
})

/** The second member's query: `outerOne` alone, which names no parameter but `taken`. */
const aloneOne = query(Known).rule((r) => {
	const read = outerOne.bind({ taken: r.relation("taken", sessions) })
	const { k, v: x } = v(read, "outer")
	return r.match(read, { k, v: x }).find({ k, v: x })
})

/** The second member's query: `outerTwo` alone. */
const aloneTwo = query(Known).rule((r) => {
	const read = outerTwo.bind({ taken: r.relation("taken", sessions) })
	const { k, v: x } = v(read, "outer")
	return r.match(read, { k, v: x }).find({ k, v: x })
})

/**
 * The case's ChangeSet, `taken` bound to `carried`: the first member, First's insert, which its relation's name checks
 * first, reads the items, itself or inside `beside`, and then the outer import of the case's depth, which reads them
 * again; the second, Second's, reads that outer import alone and names no parameter but `taken`. So the outer import is
 * checked inside the first member's check after the items were, and the second member adopts its record, whose uses of
 * `sittings` are those of the items' read of `carried` alone.
 */
export const writeOf = (c: Known): unknown => {
	const empty = ChangeSet.empty(Known)
	switch (c.depth) {
		case "one deep":
			return (
				c.before === "read by the member"
					? empty.insert(First, itemsThenOne)
					: empty.insert(First, besideThenOne)
			)
				.insert(Second, aloneOne)
				.bind({ taken: carried })
		case "two deep":
			return (
				c.before === "read by the member"
					? empty.insert(First, itemsThenTwo)
					: empty.insert(First, besideThenTwo)
			)
				.insert(Second, aloneTwo)
				.bind({ taken: carried })
	}
}
