import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen, int, uniqueArray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { memberOps } from "#adapter/db/handles.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, unorderedEqual } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A served ChangeSet's array members take each call's facts (types/db FactsApply), generated: a change member inserting
 * into two relations, each through an array member, is loaded as a handle that takes the call's facts beside its
 * parameters, and a call through it writes exactly the facts it supplies.
 *
 * - Shape: the member loads as a facts handle (db/ops.ts ServedOps `facts`), decided once at load by its array members.
 * - Oracle: after a call into empty relations, the outcome counts each relation's supplied facts as added, and each
 *   relation stores exactly them.
 * - Plant: the handle loses one member's facts, its array emptied or its relation left out of the call's record; the
 *   oracle must then disagree with what the call did, a refusal (memberFactsOf at the member's slot) or a store without
 *   them.
 *
 * Essay ideas: an oracle (the facts a call supplies are the facts it writes) over generated facts, with a plant the
 * oracle must catch.
 */
const Tag = str.regex("^[a-z]{1,4}$")
const Item = relation("Item", { id: pg.integer, score: pg.integer }, ["id"])
const Label = relation("Label", { item: pg.integer, tag: Tag }, ["item", "tag"])
const Labels = schema("Labels", { Item, Label }, [])

const tags = ["a", "bc", "def", "ghij"] as const

/** One call's facts: one array under each array member's relation, each nonempty and of distinct keys. */
interface CallFacts {
	readonly Item: ReadonlyArray<{ readonly id: number; readonly score: number }>
	readonly Label: ReadonlyArray<{ readonly item: number; readonly tag: string }>
}

/** A fault planted at the handle: none, or one member's facts emptied or left out. */
type Plant =
	| { readonly kind: "none" }
	| { readonly kind: "emptied"; readonly relation: keyof CallFacts }
	| { readonly kind: "omitted"; readonly relation: keyof CallFacts }

type Feature = "no plant" | "a member's facts emptied" | "a member's facts omitted"

const factsGen: Gen<CallFacts> = (source) => ({
	Item: source.draw(
		uniqueArray(
			(drawing) => ({ id: drawing.draw(int(1, 40)), score: drawing.draw(int(-5, 5)) }),
			(i) => i.id,
			{ min: 1, max: 5 },
			50
		)
	),
	Label: source.draw(
		uniqueArray(
			(drawing) => ({ item: drawing.draw(int(1, 6)), tag: drawing.draw(element(tags)) }),
			(l) => `${l.item} ${l.tag}`,
			{ min: 1, max: 5 },
			50
		)
	)
})

const relationGen: Gen<keyof CallFacts> = element(["Item", "Label"] as const)

const plantGen: Gen<Plant> = (source) => {
	const kind = source.draw(element(["none", "emptied", "omitted"] as const))
	return kind === "none" ? { kind } : { kind, relation: source.draw(relationGen) }
}

/** The record a planted handle passes for `facts`. */
const plantedFacts = (facts: CallFacts, plant: Plant): unknown => {
	switch (plant.kind) {
		case "none":
			return facts
		case "emptied":
			return { ...facts, [plant.relation]: [] }
		case "omitted":
			return plant.relation === "Item" ? { Label: facts.Label } : { Item: facts.Item }
	}
}

const featureOf = (plant: Plant): Feature =>
	plant.kind === "none"
		? "no plant"
		: plant.kind === "emptied"
			? "a member's facts emptied"
			: "a member's facts omitted"

layer(Substrate.layer, { excludeTestServices: true })(
	"a served ChangeSet's array members",
	(it) => {
		it.effect(
			"write exactly the facts each call supplies, and a handle that loses some is caught",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							oracle: {
								kind: "specification",
								name: "the facts a call supplies are the facts it writes"
							},
							suite: "pg/served/facts",
							draw: drawn((source) => [source.draw(factsGen), source.draw(plantGen)] as const),
							literal: Formatter.format,
							coverage: required<Feature>(
								["no plant", "a member's facts emptied", "a member's facts omitted"],
								{ cases: 12, sense: notesOnly }
							),
							kept: [],
							/** Each case installs a schema and makes one call into its empty relations. */
							runs: 12,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 4,
							caseHang
						},
						([facts, plant], notes) =>
							Effect.gen(function* () {
								notes.note(featureOf(plant))
								const opened = yield* installed(
									Labels,
									{ Item: [], Label: [] },
									{ label: "real", extensions: [], programs: {} }
								)
								const s = opened.schema
								const add = ChangeSet.empty(s).insert(Item, []).insert(Label, [])
								const items = query(s).rule((r) => {
									const { id, score } = v(Item, "item")
									return r.match(Item, { id, score }).find({ id, score })
								})
								const labels = query(s).rule((r) => {
									const { item, tag } = v(Label, "label")
									return r.match(Label, { item, tag }).find({ item, tag })
								})
								yield* withServedDb(
									opened.installed,
									opened.server.roles.app,
									{},
									({ ctx: db, load }) =>
										Effect.gen(function* () {
											const loaded = yield* load({ add, items, labels })
											const handle = memberOps(db, member(loaded, "add"))
											if (handle.kind !== "facts") {
												return assert.fail(
													"a ChangeSet with array members loads as a handle taking each call's facts"
												)
											}
											const applied = yield* Effect.result(
												handle.ops.apply(plantedFacts(facts, plant), {})
											)
											const storedItems = yield* (yield* memberOps(
												db,
												member(loaded, "items")
											).ops.execute({})).collect
											const storedLabels = yield* (yield* memberOps(
												db,
												member(loaded, "labels")
											).ops.execute({})).collect
											const expected = [
												{
													relation: "Item",
													added: BigInt(facts.Item.length),
													deleted: 0n,
													put: 0n
												},
												{
													relation: "Label",
													added: BigInt(facts.Label.length),
													deleted: 0n,
													put: 0n
												}
											]
											const counts =
												Result.isSuccess(applied) && applied.success.kind === "accepted"
													? applied.success.counts
													: []
											const agrees =
												counts.length === expected.length &&
												Arr.every(counts, (c, i) => c.added === expected[i]?.added) &&
												storedItems.length === facts.Item.length &&
												storedLabels.length === facts.Label.length
											if (plant.kind !== "none") {
												assert.ok(
													!agrees,
													`the plant ${Formatter.format(plant)} at ${Formatter.format(facts)} is caught`
												)
												return
											}
											assert.ok(
												agrees,
												`the call of ${Formatter.format(facts)}: ${Formatter.format(applied)}`
											)
											assert.deepEqual(
												counts,
												expected,
												"the outcome counts each relation's supplied facts"
											)
											unorderedEqual(storedItems, facts.Item, "the stored items are the call's")
											unorderedEqual(storedLabels, facts.Label, "the stored labels are the call's")
										})
								)
							}).pipe(Effect.scoped)
					)
				)
		)
	}
)
