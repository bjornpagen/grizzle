import { assert, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, Result } from "effect"
import { memberCalls, variantOf } from "#adapter/db/handles.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	caseGen,
	type Feature,
	featureOf,
	Item,
	itemsAfter,
	Label,
	Labels,
	labelsInstall,
	labelsTemplate,
	plainRows,
	plantedFacts,
	plantGen,
	sameItems
} from "#test/pg/served/facts.fixtures.ts"
import { writeAnswerOf, readOnce, writeOnce } from "#test/support/calls.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A served ChangeSet's array members write exactly the facts each call supplies, and a handle that loses some is caught. */
export const aServedChangeSetsArrayMembersWriteExactlyTheFactsEachCallSuppliesAndAHandleThatLosesSomeIsCaught =
	property.explore((source) => [source.draw(caseGen), source.draw(plantGen)] as const, {
		needs: { labelled: Substrate.fresh(labelsTemplate) },
		situations: [
			"no plant",
			"a member's facts emptied",
			"a member's facts omitted",
			"the put's and delete's facts swapped"
		] satisfies ReadonlyArray<Reached<Feature>>,
		/** Its pre-conversion budget: runs 32, coverage cases 32 (facts.test.ts at bf4f43bb). */
		budget: { runs: 32, steered: 32 },
		check:
			({ labelled }, notes: Case<Feature>) =>
			([{ stored, facts }, plant]) =>
				Effect.scoped(
					Effect.gen(function* () {
						notes.note(featureOf(plant))
						const taken = yield* labelled
						const opened = yield* openedIn(
							Labels,
							{ Item: stored, Label: [] },
							labelsInstall,
							taken
						)
						const s = opened.schema
						const add = ChangeSet.empty(s).insert(Label, []).put(Item, []).delete(Item, [])
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
									const change = member(loaded, "add")
									if (
										change.kind !== "change" ||
										variantOf(db, change.variants).call.kind !== "facts"
									) {
										return assert.fail(
											"a ChangeSet with array members loads as a handle taking each call's facts"
										)
									}
									const applied = yield* Effect.result(
										writeAnswerOf(
											writeOnce(memberCalls(db, change))({
												params: {},
												facts: plantedFacts(facts, plant)
											})
										)
									)
									const everyRow = (name: string) =>
										readOnce(memberCalls(db, member(loaded, name)))({ params: {}, facts: {} })
									const storedItems = yield* everyRow("items")
									const storedLabels = yield* everyRow("labels")
									const expectedItems = itemsAfter(stored, facts)
									const agrees =
										Result.isSuccess(applied) &&
										applied.success._tag === "accepted" &&
										sameItems(storedItems, expectedItems) &&
										storedLabels.length === facts.insert.Label.length
									if (plant.kind !== "none") {
										assert.ok(
											!agrees,
											`the plant ${Formatter.format(plant)} at ${Formatter.format(facts)} is caught`
										)
										return
									}
									assert.ok(
										agrees,
										`the call of ${Formatter.format(facts)} over ${Formatter.format(stored)}: ${Formatter.format(applied)}, stored ${Formatter.format(storedItems)} and ${Formatter.format(storedLabels)}`
									)
									unorderedEqual(
										plainRows(storedItems),
										expectedItems,
										"the stored items are the call's puts over its deletes"
									)
									unorderedEqual(
										plainRows(storedLabels),
										facts.insert.Label,
										"the stored labels are the call's inserts"
									)
								})
						)
					})
				),
		oracle: {
			kind: "specification",
			name: "the facts a call supplies are the facts it writes"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/members.ts",
				original: "\t\t\tout.set(member.slot, given)",
				replacement: '\t\t\tout.set(member.slot, member.op === "delete" ? [] : given)',
				why: "memberFactsOf drops the delete member's facts, so a call deletes nothing; the oracle disagrees with the items stored."
			}
		]
	})
