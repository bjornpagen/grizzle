/**
 * The worlds model's small box: every transition of the teams base's small scope, one per class of what the model
 * tells apart of its outcomes, run on PostgreSQL from its reality along the trail that first reached it, every step
 * against the model.
 */
import { type Case, family, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { slotSpaces, transitionWorld } from "#test/pg/world-model/exhaustive.fixtures.ts"
import { checkStart, runStep } from "#test/support/worlds/drive/index.ts"
import { unnoted } from "#test/support/worlds/drive/suite.ts"
import { initialState } from "#test/support/worlds/model/step.ts"
import type { ModelState, WorldFeature } from "#test/support/worlds/model/types.ts"

/**
 * Every program in the small box agrees with the model, one property for each installation holding a transition of
 * the box: a transition's prefix replayed from its reality, and where nature took the branches the box found, its
 * action, each step's allowed observations, stored relations and every open session's probe the model's; a prefix
 * nature led elsewhere is moot.
 *
 * Its pre-conversion budget: the box, 372 transitions (test/pg/world-model/exhaustive.test.ts at 4ca3036a9).
 */
export const everyProgramInTheSmallBoxAgreesWithTheModel = family(
	Rec.fromEntries(
		Arr.map(slotSpaces, ({ key, space, needs }) => [
			key,
			property.exhaust(space, {
				needs,
				situations: [],
				check: (resources, c: Case<WorldFeature>) => (transition) =>
					Effect.scoped(
						Effect.gen(function* () {
							const install = transition.slot.install
							const world = yield* transitionWorld(resources, transition)
							yield* world.reset(transition.reality)
							const start = yield* checkStart(
								world,
								initialState(install, world.names, transition.reality)
							)
							const reached = yield* Effect.reduce(
								transition.prefix,
								(): Option.Option<ModelState> => Option.some(start),
								(at, planned, index) =>
									Option.match(at, {
										onNone: () => Effect.succeedNone,
										onSome: (state) =>
											Effect.map(runStep(world, state, planned.action, index, unnoted), (stepped) =>
												stepped.branch === planned.branch
													? Option.some(stepped.next)
													: Option.none()
											)
									})
							)
							if (Option.isSome(reached)) {
								yield* runStep(world, reached.value, transition.action, transition.prefix.length, c)
							}
						})
					),
				oracle: {
					kind: "second-implementation",
					name: "the worlds model (test/support/worlds/model): each transition's allowed observations, its stored relations and every open session's probe"
				},
				box: `every transition of the teams base's small scope (two relations, two rules, one context, two subjects, three facts, three actions deep), one per class of what the model tells apart of its outcomes, that ${key} holds`,
				show: Formatter.format,
				kept: [],
				kills: []
			})
		])
	)
)
