/** What the property of correlated-imports.test.ts reads: its schema, its box and the query of a case. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { InferredQuery } from "#compiler/ir/desc.ts"
import { queryInput } from "#compiler/program/input.ts"
import { Fn } from "#compiler/public/compute.ts"
import { int4, int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { fn, relation, row, rows, schema } from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { checking, checkOptions } from "#test/support/policy.ts"

const A = rows({ k: int8, v: int8 })

/** run: three rows arguments of (k, v), and one row of four fields of rows of (k, v). */
const run = fn("run", {
	calls: [],
	args: { in0: A, in1: A, in2: A },
	returns: row(rows({ out0: A, out1: A, out2: A, out3: A })),
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT NULL`
})

/** Items, and each item's values, which every argument of a run reads by the item's id. */
const Item = relation("Item", { id: int4, kind: int4 }, ["id"])
const Value = relation("Value", { item: int4, k: int8, v: int8 }, ["item", "k"])

const Correlated = schema("CorrelatedImports", [Item, Value, run], [])

/** The values of one item, by its id, their v at least `j`: the `j`-th argument of a run, bound to its reader's item. */
const argumentOf = (j: bigint) =>
	query(Correlated).rule((r) => {
		const { k, v: x } = v(Value, "value")
		return r
			.match(Value, { item: r.param("item", int4), k, v: x })
			.where(r.ge(x, j))
			.find({ k, v: x })
	})

const outs = ["out0", "out1", "out2", "out3"] as const

/** How many fields of one run a case's attachment reads: each a read of the run at the parent item's arguments. */
export type Fields = 1 | 2 | 3 | 4

export const fieldsGen: Gen<Fields> = element([1, 2, 3, 4] as const)

/** How many of the run's arguments are each an import bound to the parent item's id: the rest read every item. */
export type Bound = 1 | 3

/**
 * A case's query: each item and its kind, with an attachment whose one rule reads `fields` fields of one run of `run`,
 * `bound` of whose arguments are each an import bound to the item's id, a term of the parent row, the rest closed: as
 * edullm's session start reads its run's variables and values, two fields of one call bound to the parent's terms.
 */
const fieldsQueryOf = (bound: Bound, fields: Fields): InferredQuery => {
	const q = query(Correlated)
		.rule((r) => {
			const { id, kind } = v(Item, "item")
			return r.match(Item, { id, kind }).find({ id, kind })
		})
		.attach(
			"runs",
			(item) =>
				query(Correlated).rule((r) => {
					const arg = (j: bigint) =>
						j < BigInt(bound)
							? argumentOf(j).bind({ item: item.id })
							: argumentOf(j).bind({ item: r.param("item", int4) })
					const ran = Fn.row(run, { in0: arg(0n), in1: arg(1n), in2: arg(2n) })
					const first = ran.out0
					const { k, v: x } = v(first, "out0")
					const read = Arr.reduce(outs.slice(1, fields), r.match(first, { k, v: x }), (rule, out) =>
						rule.match(ran[out], { k })
					)
					return read.find({ k, v: x })
				}),
			"array"
		)
	return succeeded(queryInput(q), "a query value").desc
}

/** The nodes of a case's query as a query read checks it. */
export const checkedNodes = (bound: Bound, fields: Fields): number =>
	topoOrder(
		succeeded(checkQuery(checking(Correlated), fieldsQueryOf(bound, fields), checkOptions("query")))
			.dag
	).length

/** A session's seeds, by its id: Seed is each item's seed. */
const Seed = relation("Seed", { id: int4, seed: int4 }, ["id"])

const Nested = schema("NestedCorrelatedImports", [Item, Seed], [])

/** A lookup's size: one match of Seed, or three, each its own copy of the seed. */
export type LookupSize = "small" | "large"

/** The seed of one item, by its id, read once or through three copies of Seed: what every read imports. */
const lookupFor = (size: LookupSize) =>
	size === "small"
		? query(Nested).rule((r) => {
				const { seed } = v(Seed, "seed")
				return r.match(Seed, { id: r.param("id", int4), seed }).find({ seed })
			})
		: query(Nested).rule((r) => {
				const { seed } = v(Seed, "seed")
				return r
					.match(Seed, { id: r.param("id", int4), seed })
					.match(Seed, { id: r.param("id", int4), seed })
					.match(Seed, { id: r.param("id", int4), seed })
					.find({ seed })
			})

/** Each size's one lookup, every read's of that size. */
const lookups = { small: lookupFor("small"), large: lookupFor("large") } as const

/** The `j`-th read of an item's seed: its own query, importing the lookup bound to its own parameter. */
const readOf = (size: LookupSize, j: number) =>
	query(Nested).rule((r) => {
		const looked = lookups[size].bind({ id: r.param("id", int4) })
		const { seed } = v(looked, "looked")
		return r.match(looked, { seed }).where(r.ge(seed, j)).find({ seed })
	})

/** How many readers a nested case holds: attachments of one parent, or reads under one attachment. */
export type Readers = 1 | 2 | 3 | 4

export const readersGen: Gen<Readers> = element([1, 2, 3, 4] as const)

/**
 * A nested case's query: each item and its kind, and one attachment whose rule makes `readers` reads of the item's
 * seed, each a read of its own query, which imports the lookup bound to its own parameter, which the attachment binds
 * to its parent's id: the lookup bound to the item's id at two removes, as edullm's session start's run arguments each
 * import the session lookup bound to their own parameters, which the run binds to the parent row's terms.
 */
const nestedQueryOf = (size: LookupSize, readers: Readers): InferredQuery => {
	const q = query(Nested)
		.rule((r) => {
			const { id, kind } = v(Item, "item")
			return r.match(Item, { id, kind }).find({ id, kind })
		})
		.attach(
			"reads",
			(item) =>
				query(Nested).rule((r) => {
					const first = readOf(size, 0).bind({ id: item.id })
					const { seed } = v(first, "read0")
					const read = Arr.reduce(
						Array.from({ length: readers - 1 }, (_, j) => j + 1),
						r.match(first, { seed }),
						(rule, j) => rule.match(readOf(size, j).bind({ id: item.id }), { seed })
					)
					return read.find({ seed })
				}),
			"array"
		)
	return succeeded(queryInput(q), "a query value").desc
}

/** The nodes of a nested case's query as a query read checks it. */
export const nestedNodes = (size: LookupSize, readers: Readers): number =>
	topoOrder(
		succeeded(checkQuery(checking(Nested), nestedQueryOf(size, readers), checkOptions("query"))).dag
	).length

/** How many attachments a chained case holds: each one attached to the one before it, the first to the items. */
export type Links = 1 | 2 | 3 | 4

export const linksGen: Gen<Links> = element([1, 2, 3, 4] as const)

/**
 * A chained case's query: each item and its kind, and `links` attachments, each attached to the one before it, the
 * first to the items, the `j`-th reading the item's seed of at least `j` through the lookup bound to its parent's id:
 * the parent of every link but the first is the link before it, whose columns are the items', as edullm's session
 * record attaches each of its parts to the one before it, every part reading the session's start at the session's
 * terms. Each link is written out: an attachment's name is a literal of its chain's type.
 */
const chainedQueryOf = (size: LookupSize, links: Links): InferredQuery => {
	const lookup = lookups[size]
	const items = query(Nested).rule((r) => {
		const { id, kind } = v(Item, "item")
		return r.match(Item, { id, kind }).find({ id, kind })
	})
	const one = items.attach(
		"link0",
		(item) =>
			query(Nested).rule((r) => {
				const looked = lookup.bind({ id: item.id })
				const { seed } = v(looked, "looked")
				return r.match(looked, { seed }).where(r.ge(seed, 0)).find({ seed })
			}),
		"array"
	)
	const two = one.attach(
		"link1",
		(item) =>
			query(Nested).rule((r) => {
				const looked = lookup.bind({ id: item.id })
				const { seed } = v(looked, "looked")
				return r.match(looked, { seed }).where(r.ge(seed, 1)).find({ seed })
			}),
		"array"
	)
	const three = two.attach(
		"link2",
		(item) =>
			query(Nested).rule((r) => {
				const looked = lookup.bind({ id: item.id })
				const { seed } = v(looked, "looked")
				return r.match(looked, { seed }).where(r.ge(seed, 2)).find({ seed })
			}),
		"array"
	)
	const four = three.attach(
		"link3",
		(item) =>
			query(Nested).rule((r) => {
				const looked = lookup.bind({ id: item.id })
				const { seed } = v(looked, "looked")
				return r.match(looked, { seed }).where(r.ge(seed, 3)).find({ seed })
			}),
		"array"
	)
	const chained = links === 1 ? one : links === 2 ? two : links === 3 ? three : four
	return succeeded(queryInput(chained), "a query value").desc
}

/** The nodes of a chained case's query as a query read checks it. */
export const chainedNodes = (size: LookupSize, links: Links): number =>
	topoOrder(
		succeeded(checkQuery(checking(Nested), chainedQueryOf(size, links), checkOptions("query"))).dag
	).length
