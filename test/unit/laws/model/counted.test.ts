import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { foldApplied } from "#test/support/families/fold.ts"
import { brokenBy, immediate } from "#test/support/unit/laws/model/natives.ts"
import {
	caseGen,
	drawnNeed,
	type Feature,
	features,
	lawlessOf,
	statementsOf,
	stateOf
} from "#test/unit/laws/model/counted.fixtures.ts"

/** A counted family's natives admit grizzle's plans and refuse every lawless state swap-with-last and appends pass every immediate native at each statement's end. */
export const aCountedFamilysNativesAdmitGrizzlesPlansAndRefuseEveryLawlessStateSwapWithLastAndAppendsPassEveryImmediateNativeAtEachStatementsEnd =
	property.exhaust(finite(caseGen), {
		needs: { drawnNeed },
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ drawnNeed }, c: Case<Feature>) =>
			(k) =>
				Effect.gen(function* () {
					const { model, drawn } = yield* drawnNeed
					return yield* Effect.sync(() => {
						if (k.kind === "lawless") {
							c.note(`variant ${k.variant}`)
							const state = stateOf(drawn, lawlessOf(k.size, k.variant))
							assert.ok(
								brokenBy(model, state).length > 0,
								`the natives refuse ${k.variant} over ${k.size} members`
							)
							return
						}
						c.note(k.change.kind)
						if (k.change.kind === "append" && Arr.some(k.change.order, (o, i) => o !== i)) {
							c.note("an arrival out of order")
						}
						const { from, statements } = statementsOf(k.change)
						assert.deepEqual(
							brokenBy(model, stateOf(drawn, from)),
							[],
							"the lawful family breaks no native"
						)
						let at = from
						let deferredBroken = false
						for (const statement of statements) {
							at = foldApplied(at, statement)
							const broken = brokenBy(model, stateOf(drawn, at))
							assert.deepEqual(
								Arr.map(Arr.filter(broken, immediate), (o) => o.kind),
								[],
								`no immediate native breaks after ${statement.kind}`
							)
							deferredBroken ||= Arr.some(broken, (o) => !immediate(o))
						}
						assert.deepEqual(
							brokenBy(model, stateOf(drawn, at)),
							[],
							"every native holds at COMMIT"
						)
						if (k.change.kind === "swap with last" && k.change.at < k.change.size - 1) {
							assert.ok(
								deferredBroken,
								"swap-with-last of a slot before the last breaks a deferred axis until the last member moves in"
							)
						}
					})
				}),
		oracle: {
			kind: "second-implementation",
			name: "NP's counted planner and the family law, judged by a host model of the natives"
		},
		box: "one owner of 0 to 4 members beside one of one: every swap-with-last, every append of 1 or 2 in every order, every named lawless variant its family can carry",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					'\t\t\t\tindex.kind === "field" && !this.#recognizer.refillDeferred("predecessor", f)',
				replacement: '\t\t\t\t!this.#recognizer.refillDeferred("predecessor", f)',
				why: "An immediate predecessor axis (laws/model/plan.ts family axes), which swap-with-last breaks mid-plan."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: '\t\t\town.add(cmp("ge", own.column(index), naturalLiteral(0n)))\n',
				replacement: "",
				why: "A counted family's index unbounded below, no `‹i› >= 0`, so a member at slot −1 is accepted."
			}
		]
	})
