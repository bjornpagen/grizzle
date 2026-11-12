/**
 * An imported query's parameters bound to literals read exactly the rows the query reads with those values passed as
 * its parameters.
 *
 * The imported query reads a group's items scored at least a bound, keeps those no mark of a given tag names, and
 * takes the first k by score: a parameter in a match, in a filter, in a relational negation and as take's bound. The
 * schema is installed once; each case replaces its facts (items of distinct ids in two groups, marks of distinct items
 * and tags over them, both sets by construction) and draws bindings of values inside and outside the facts. Each
 * binding is bound to literals in an importing rule (`query.bind({ ... })`), and the importer, which has no parameters
 * of its own, is served beside the query as one file of the login.
 *
 * - Property: for every binding, the importer reads exactly the rows, as a set, that the query reads executed with the
 *   binding's values as its parameters.
 * - Oracle: a differential between the two paths, the literal bound at compile and the parameter bound at execution.
 * - Features: an importer reading no row, the take cutting the eligible rows, a mark excluding an eligible item, and a
 *   binding outside the facts, each from a host model of the query over the drawn facts.
 * - Plant: ~/.cache/grizzle-release/BR08/plants/bind-literal-number-as-zero.patch, a bound parameter's number literal
 *   read as zero where the import binds it, must turn the property red.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, increasing, int, subset } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installed } from "#test/pg/reads/support.ts"
import { unorderedEqual } from "#test/support/assert.ts"
import { readOnce } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Tag = str.regex("^[a-z]{1,4}$")
const Item = relation("Item", { id: pg.integer, grp: pg.integer, score: pg.integer }, ["id"])
const Mark = relation("Mark", { item: pg.integer, tag: Tag }, ["item", "tag"])
const Scores = schema("Scores", [Item, Mark], [])

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

/** The tags a mark holds; a binding also draws one no mark holds. */
const markTags = ["red", "blue"] as const
const tags = [...markTags, "gold"] as const

/** The groups the items fall into; a binding also draws one no item is in. */
const groups = 2

/**
 * Items at distinct ids, a set drawn as its increasing ids, each with a group and a score; then marks, a subset of the
 * items' pairs with a mark's tag, so no two share a key and none is retried.
 */
const factsGen: Gen<Facts> = (source) => {
	const ids = source.draw(increasing(1, 12, { min: 1, max: 9 }))
	const items = Arr.map(ids, (id) => ({
		id,
		grp: source.draw(int(1, groups)),
		score: source.draw(int(-2, 3))
	}))
	const pairs = Arr.flatMap(ids, (item) => Arr.map(markTags, (tag) => ({ item, tag })))
	return { items, marks: source.draw(subset(pairs, { min: 0, max: pairs.length })) }
}

const bindingGen: Gen<Binding> = (source) => ({
	grp: source.draw(int(1, groups + 1)),
	lo: source.draw(int(-3, 4)),
	k: source.draw(int(1, 4)),
	tag: source.draw(element(tags))
})

type BindFeature =
	| "an importer reading no row"
	| "the take cutting the eligible rows"
	| "a mark excluding an eligible item"
	| "a binding outside the facts"

/** The situations a binding reaches over the facts, from the query restated on the host. */
const featuresOf = (facts: Facts, b: Binding): ReadonlyArray<BindFeature> => {
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

layer(Substrate.layer, { excludeTestServices: true })(
	"an imported query's parameters bound to literals",
	(it) => {
		it.effect("read the rows the query reads with those values as its parameters", (ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const opened = yield* installed(Scores, {}, { label: "real", programs: {} })
					const names = namesOf(opened.installed)
					const itemInsert = `INSERT INTO ${names.table(Item)} (${names.column(Item, "id")}, ${names.column(Item, "grp")}, ${names.column(Item, "score")}) VALUES ($1::int4, $2::int4, $3::int4)`
					const markInsert = `INSERT INTO ${names.table(Mark)} (${names.column(Mark, "item")}, ${names.column(Mark, "tag")}) VALUES ($1::int4, $2::text)`
					const top = query(opened.schema)
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
					return yield* explore(
						{
							oracle: {
								kind: "second-implementation",
								name: "the query executed with the binding's values as its parameters"
							},
							suite: "pg/reads/bind-literal",
							draw: drawn(
								(source) =>
									[
										source.draw(factsGen),
										source.draw(array(bindingGen, { min: 1, max: 4 }))
									] as const
							),
							literal: Formatter.format,
							coverage: required<BindFeature>(
								[
									"an importer reading no row",
									"the take cutting the eligible rows",
									"a mark excluding an eligible item",
									"a binding outside the facts"
								],
								{ cases: 24, sense: notesOnly }
							),
							kept: [],
							runs: 24,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 8,
							caseHang
						},
						([facts, bindings], c) =>
							Effect.gen(function* () {
								yield* replaceRows(s.admin, installationGroup(names), [
									...Arr.map(facts.items, (i) => ({
										sql: itemInsert,
										params: [String(i.id), String(i.grp), String(i.score)]
									})),
									...Arr.map(facts.marks, (m) => ({
										sql: markInsert,
										params: [String(m.item), m.tag]
									}))
								])
								/** Each binding's importer, by its index. */
								const imports = Rec.fromEntries(
									Arr.map(bindings, (b, i) => [
										`imported${i}`,
										query(opened.schema).rule((r) => {
											const bound = top.bind({ grp: b.grp, lo: b.lo, k: b.k, tag: b.tag })
											const { id, score } = v(bound, "bound")
											return r.match(bound, { id, score }).find({ id, score })
										})
									])
								)
								yield* withServedDb(opened.installed, opened.server.roles.app, {}, ({ serve }) =>
									Effect.gen(function* () {
										const served = yield* serve({ top, ...imports })
										for (const [i, b] of bindings.entries()) {
											const direct = yield* readOnce(member(served, "top"))({
												params: { ...b },
												facts: {}
											})
											const viaImport = yield* readOnce(member(served, `imported${i}`))({
												params: {},
												facts: {}
											})
											unorderedEqual(
												viaImport,
												direct,
												`${Formatter.format(b)} over ${Formatter.format(facts)}`
											)
											c.noteAll(featuresOf(facts, b))
										}
									})
								)
							}).pipe(Effect.scoped)
					)
				}).pipe(Effect.scoped)
			)
		)
	}
)
