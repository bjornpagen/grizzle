/** What the properties of bind-literal.test.ts read: its spaces, models and helpers. */

import { element, type Gen, increasing, int, subset } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { Schema } from "#compiler/types/schema/schema.ts"

const Tag = str.regex("^[a-z]{1,4}$")

export const Item = relation("Item", { id: pg.integer, grp: pg.integer, score: pg.integer }, ["id"])

export const Mark = relation("Mark", { item: pg.integer, tag: Tag }, ["item", "tag"])

export const Scores = schema("Scores", [Item, Mark], [])

interface ItemFact {
	readonly id: number
	readonly grp: number
	readonly score: number
}

interface MarkFact {
	readonly item: number
	readonly tag: string
}

interface Facts {
	readonly items: ReadonlyArray<ItemFact>
	readonly marks: ReadonlyArray<MarkFact>
}

interface Binding {
	readonly grp: number
	readonly lo: number
	readonly k: number
	readonly tag: string
}

/**
 * The imported query over the schema value `over`: a group's items scored at least `lo`, none a mark of `tag` names,
 * the first `k` by score. The installation serves it over the declared schema, so it installs the pattern domain its
 * `tag` parameter casts to, and every importer and every direct read of it is compiled under the installed name.
 */
export const topOver = <N extends string>(over: Schema<N, (typeof Scores)["relations"], []>) =>
	query(over)
		.rule((r) => {
			const { id, score } = v(Item, "item")
			return r
				.match(Item, { id, grp: r.param("grp", Item.fields.grp), score })
				.where(
					r.ge(score, r.param("lo", pg.integer)),
					r.not(Mark, { item: id, tag: r.param("tag", Mark.fields.tag) })
				)
				.find({ id, score })
		})
		.orderBy(["score", "desc"], ["id", "asc"])
		.take("k")

/** The tags a mark holds; a binding also draws one no mark holds. */
const markTags = ["red", "blue"] as const

const tags = [...markTags, "gold"] as const

/** The groups the items fall into; a binding also draws one no item is in. */
const groups = 2

/**
 * Items at distinct ids, a set drawn as its increasing ids, each with a group and a score; then marks, a subset of the
 * items' pairs with a mark's tag, so no two share a key and none is retried.
 */
export const factsGen: Gen<Facts> = (source) => {
	const ids = source.draw(increasing(1, 12, { min: 1, max: 9 }))
	const items = Arr.map(ids, (id) => ({
		id,
		grp: source.draw(int(1, groups)),
		score: source.draw(int(-2, 3))
	}))
	const pairs = Arr.flatMap(ids, (item) => Arr.map(markTags, (tag) => ({ item, tag })))
	return { items, marks: source.draw(subset(pairs, { min: 0, max: pairs.length })) }
}

export const bindingGen: Gen<Binding> = (source) => ({
	grp: source.draw(int(1, groups + 1)),
	lo: source.draw(int(-3, 4)),
	k: source.draw(int(1, 4)),
	tag: source.draw(element(tags))
})

export type BindFeature =
	| "an importer reading no row"
	| "the take cutting the eligible rows"
	| "a mark excluding an eligible item"
	| "a binding outside the facts"

/** The situations a binding reaches over the facts, from the query restated on the host. */
export const featuresOf = (facts: Facts, b: Binding): ReadonlyArray<BindFeature> => {
	const scored = Arr.filter(facts.items, (i) => i.grp === b.grp && i.score >= b.lo)
	const marked = (i: ItemFact) => Arr.some(facts.marks, (m) => m.item === i.id && m.tag === b.tag)
	const eligible = Arr.filter(scored, (i) => !marked(i))
	return [
		...(eligible.length === 0 ? (["an importer reading no row"] as const) : []),
		...(eligible.length > b.k ? (["the take cutting the eligible rows"] as const) : []),
		...(Arr.some(scored, marked) ? (["a mark excluding an eligible item"] as const) : []),
		...(b.grp > groups || !Arr.some(markTags, (t) => t === b.tag)
			? (["a binding outside the facts"] as const)
			: [])
	]
}
