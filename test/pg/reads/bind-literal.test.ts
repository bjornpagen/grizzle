import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { array, element, type Gen, int, uniqueArray } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installed } from "#test/pg/reads/support.ts"
import { unorderedEqual } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * An imported query's parameters bound to literals, generated: the import reads exactly the rows the query reads with
 * those values passed as its parameters.
 *
 * The imported query reads a group's items scored at least a bound, keeps those no mark of a given tag names, and
 * takes the first k by score: a parameter in a match, in a filter, in a relational negation and as take's bound. A run
 * draws its facts (a few items in two groups, marks of two tags) and binding cases of values inside and outside the
 * facts; each case binds every parameter to a literal in an importing rule (`query.bind({ ... })`) and the importer,
 * which has no parameters of its own, must read the same rows as the query executed with the same values. The query and
 * every importer are members of the login's workload, served as one file.
 */
const Tag = str.regex("^[a-z]{1,4}$")
const Item = relation("Item", { id: pg.integer, grp: pg.integer, score: pg.integer }, ["id"])
const Mark = relation("Mark", { item: pg.integer, tag: Tag }, ["item", "tag"])
const Scores = schema("Scores", { Item, Mark }, [])

interface Facts {
	readonly items: ReadonlyArray<{
		readonly id: number
		readonly grp: number
		readonly score: number
	}>
	readonly marks: ReadonlyArray<{ readonly item: number; readonly tag: string }>
}

interface Binding {
	readonly grp: number
	readonly lo: number
	readonly k: number
	readonly tag: string
}

const tags = ["red", "blue", "gold"] as const

/** Items of distinct ids, then marks of distinct items and tags over them: up to six of the six a run of three holds, so
 * each draws until its key is new. */
const factsGen: Gen<Facts> = (source) => {
	const items = source.draw(
		uniqueArray(
			(drawing) => ({
				id: drawing.draw(int(1, 12)),
				grp: drawing.draw(int(1, 2)),
				score: drawing.draw(int(-2, 3))
			}),
			(i) => i.id,
			{ min: 3, max: 9 },
			50
		)
	)
	const ids = nonEmptyList(
		Arr.map(items, (i) => i.id),
		"the items"
	)
	const marks = source.draw(
		uniqueArray(
			(drawing) => ({
				item: drawing.draw(element(ids)),
				tag: drawing.draw(element(["red", "blue"] as const))
			}),
			(m) => `${m.item} ${m.tag}`,
			{ min: 0, max: 6 },
			50
		)
	)
	return { items, marks }
}

const bindingGen: Gen<Binding> = (source) => ({
	grp: source.draw(int(1, 3)),
	lo: source.draw(int(-3, 4)),
	k: source.draw(int(1, 4)),
	tag: source.draw(element(tags))
})

layer(Substrate.layer, { excludeTestServices: true })(
	"an imported query's parameters bound to literals",
	(it) => {
		it.effect("read the rows the query reads with those values as its parameters", (ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "pg/reads/bind-literal",
						draw: drawn(
							(source) =>
								[
									source.draw(factsGen),
									source.draw(array(bindingGen, { min: 12, max: 12 }))
								] as const
						),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						/** Each case installs a schema; its twelve bindings vary inside it, as before. */
						runs: 1,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([facts, bindings]) =>
						Effect.gen(function* () {
							const opened = yield* installed(
								Scores,
								{ Item: facts.items, Mark: facts.marks },
								{ label: "real", extensions: [], programs: {} }
							)
							const s = opened.schema
							const top = query(s)
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
							/** Each binding's importer, by its index. */
							const imports = Rec.fromEntries(
								Arr.map(bindings, (b, i) => [
									`imported${i}`,
									query(s).rule((r) => {
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
										const direct = yield* (yield* member(served, "top").ops.execute({ ...b }))
											.collect
										const viaImport = yield* (yield* member(served, `imported${i}`).ops.execute({}))
											.collect
										unorderedEqual(
											viaImport,
											direct,
											`${Formatter.format(b)} over ${Formatter.format(facts)}`
										)
									}
								})
							)
						}).pipe(Effect.scoped)
				)
			)
		)
	}
)
