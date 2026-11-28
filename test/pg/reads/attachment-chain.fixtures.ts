/** What the property of attachment-chain.test.ts reads: its schema, its reads, its facts and the host's model of them. */

import { type Gen, int, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, Record as Rec } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"

/** An item, with its kind: the rows each chain attaches to. */
const Item = relation("Item", { id: pg.integer, kind: pg.integer }, ["id"])

/** An item's seeds: the rows every link reads through a lookup bound to its parent's id. */
const Seed = relation("Seed", { id: pg.integer, seed: pg.integer }, ["id", "seed"])

export const AttachmentChain = schema("AttachmentChain", [Item, Seed], [])

/** A lookup's size: one match of Seed, or three, each its own copy of the item's seeds. */
export type LookupSize = "small" | "large"

const lookups = {
	small: query(AttachmentChain).rule((r) => {
		const { seed } = v(Seed, "seed")
		return r.match(Seed, { id: r.param("id", pg.integer), seed }).find({ seed })
	}),
	large: query(AttachmentChain).rule((r) => {
		const { seed } = v(Seed, "seed")
		return r
			.match(Seed, { id: r.param("id", pg.integer), seed })
			.match(Seed, { id: r.param("id", pg.integer), seed })
			.match(Seed, { id: r.param("id", pg.integer), seed })
			.find({ seed })
	})
} as const

/**
 * The rows a chain attaches to: every item, or every item with its id and kind swapped, a projection below the chain
 * that renames its columns.
 */
export type Rows = "all" | "swapped"

/** How many links a chain holds, over which lookup, and the rows it attaches to. */
export interface Chain {
	readonly links: 1 | 2 | 3 | 4
	readonly size: LookupSize
	readonly rows: Rows
}

export const chains: ReadonlyArray<Chain> = Arr.flatMap([1, 2, 3, 4] as const, (links) =>
	Arr.flatMap(["small", "large"] as const, (size) =>
		Arr.map(["all", "swapped"] as const, (rows) => ({ links, size, rows }))
	)
)

/** The read of a chain, by its name. */
export const nameOf = (c: Chain): string => `chain${c.links}${c.size}${c.rows}`

const all = query(AttachmentChain).rule((r) => {
	const { id, kind } = v(Item, "item")
	return r.match(Item, { id, kind }).find({ id, kind })
})

const swapped = query(AttachmentChain).rule((r) => {
	const { id, kind } = v(Item, "item")
	return r.match(Item, { id, kind }).find({ id: kind, kind: id })
})

/**
 * A chain's read: the rows it attaches to (Rows), and `links` attachments, each attached to the one before it, the
 * first to the rows, the `j`-th reading the seeds of at least `j` of the row's id through the lookup bound to its
 * parent's id: the parent of every link but the first is the link before it, whose columns are the rows'. Each link is
 * written out: an attachment's name is a literal of its chain's type.
 */
const readOf = (c: Chain) => {
	const lookup = lookups[c.size]
	const items = c.rows === "all" ? all : swapped
	const one = items.attach(
		"link0",
		(item) =>
			query(AttachmentChain).rule((r) => {
				const looked = lookup.bind({ id: item.id })
				const { seed } = v(looked, "looked")
				return r.match(looked, { seed }).where(r.ge(seed, 0)).find({ seed })
			}),
		"array"
	)
	const two = one.attach(
		"link1",
		(item) =>
			query(AttachmentChain).rule((r) => {
				const looked = lookup.bind({ id: item.id })
				const { seed } = v(looked, "looked")
				return r.match(looked, { seed }).where(r.ge(seed, 1)).find({ seed })
			}),
		"array"
	)
	const three = two.attach(
		"link2",
		(item) =>
			query(AttachmentChain).rule((r) => {
				const looked = lookup.bind({ id: item.id })
				const { seed } = v(looked, "looked")
				return r.match(looked, { seed }).where(r.ge(seed, 2)).find({ seed })
			}),
		"array"
	)
	const four = three.attach(
		"link3",
		(item) =>
			query(AttachmentChain).rule((r) => {
				const looked = lookup.bind({ id: item.id })
				const { seed } = v(looked, "looked")
				return r.match(looked, { seed }).where(r.ge(seed, 3)).find({ seed })
			}),
		"array"
	)
	return c.links === 1 ? one : c.links === 2 ? two : c.links === 3 ? three : four
}

/** Every chain's read, by its name: the programs its login's workload holds. */
export const chainInstall = Object.freeze({
	label: "attachchain",
	programs: Rec.fromEntries(Arr.map(chains, (c) => [nameOf(c), readOf(c)] as const))
})

/** AttachmentChain installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const chainTemplate = fixtureTemplate(import.meta, AttachmentChain, chainInstall)

export interface Facts {
	readonly items: ReadonlyArray<{ readonly id: number; readonly kind: number }>
	readonly seeds: ReadonlyArray<{ readonly id: number; readonly seed: number }>
}

/** Items, a subset of three ids each of kind 1 to 3, and seeds, a subset of those ids' seeds 0 to 3. */
export const factsGen: Gen<Facts> = (source) => {
	const ids = source.draw(subset([1, 2, 3], { min: 1, max: 3 }))
	return {
		items: Arr.map(ids, (id) => ({ id, kind: source.draw(int(1, 3)) })),
		seeds: source.draw(
			subset(
				Arr.flatMap([1, 2, 3], (id) => Arr.map([0, 1, 2, 3], (seed) => ({ id, seed }))),
				{ min: 0, max: 8 }
			)
		)
	}
}

/** One item as a chain's read delivers it: its id and kind, and each link's seeds, ascending. */
export interface Delivered {
	readonly id: number
	readonly kind: number
	readonly links: ReadonlyArray<ReadonlyArray<number>>
}

/**
 * The model: each row the chain attaches to, every item or every item with its id and kind swapped, with the `j`-th
 * link the seeds of at least `j` of the row's id.
 */
export const expected = (c: Chain, facts: Facts): ReadonlyArray<Delivered> => {
	const rows =
		c.rows === "all" ? facts.items : Arr.map(facts.items, (i) => ({ id: i.kind, kind: i.id }))
	return Arr.map(rows, (item) => ({
		...item,
		links: Array.from({ length: c.links }, (_, j) =>
			Arr.sort(
				Arr.flatMap(facts.seeds, (s) => (s.id === item.id && s.seed >= j ? [s.seed] : [])),
				Order.Number
			)
		)
	}))
}

export type ChainFeature =
	| "one link"
	| "two links"
	| "three links"
	| "four links"
	| "a projection below the chain that renames its columns"
	| "an item with no seed"
	| "a link that drops a seed an earlier link reads"

/** What the facts reach besides the reads: an item with no seed, and a seed below a later link's bound. */
export const featuresOf = (facts: Facts): ReadonlyArray<ChainFeature> => [
	...(Arr.some(facts.items, (i) => !Arr.some(facts.seeds, (s) => s.id === i.id))
		? (["an item with no seed"] as const)
		: []),
	...(Arr.some(facts.items, (i) => Arr.some(facts.seeds, (s) => s.id === i.id && s.seed < 3))
		? (["a link that drops a seed an earlier link reads"] as const)
		: [])
]
