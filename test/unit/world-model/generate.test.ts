/**
 * The worlds generators' small box (test/support/worlds/generate), against the harness's own rules, which judge what a
 * generator drew without the generator's help: from every reality of the box, after drawn steps, the box's actions in
 * a state are duplicate-free up to renaming the values the state does not hold, cover every kind the state offers, and
 * keep the serial rule (drive/index.ts serial).
 *
 * Oracle: the specification, the rules stated apart from the generator. Whether a kind is offered (the box's cover) is
 * judged by generate/offered.ts applicable and namesOffered, the policy the box draws through, so a fault in that policy
 * moves its judge with it; only the feature that every action kind is reached notices a kind it drops. Features: the
 * box's kinds.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { element } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { serial } from "#test/support/worlds/drive/index.ts"
import { installedNames } from "#test/support/worlds/execute/names.ts"
import { knownNonEmpty } from "#test/support/worlds/generate/domain.ts"
import { defaultScope, enumerateActions } from "#test/support/worlds/generate/enumerate.ts"
import { applicable } from "#test/support/worlds/generate/offered.ts"
import { actionKinds } from "#test/support/worlds/generate/weights.ts"
import { docsInstall } from "#test/support/worlds/model/bases/docs.ts"
import { initialState, settle, step } from "#test/support/worlds/model/step.ts"
import type { ActionKind } from "#test/support/worlds/model/types.ts"
import { boxGen, canonicalAction, docs } from "#test/unit/world-model/generate.fixtures.ts"

/**
 * The worlds generators enumerate a finite box, duplicate-free up to renaming, covering every action kind the state
 * offers.
 *
 * Budget: its suite's count before the conversion (unit/world-model/generate-box: 24 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a). Its six fixed witnesses reach no arm with attachments, so that case is kept (its kept
 * token, found by the kill's mutant at the runner's budget and shrunk): at TEST_SEED=1 to 5 every kill is killed.
 */
export const theWorldsGeneratorsEnumerateAFiniteBoxDuplicateFreeUpToRenamingCoveringEveryActionKindTheStateOffers =
	property.explore(boxGen, {
		needs: {},
		situations: [
			"kind open-db",
			"kind direct-begin",
			"kind migrate",
			"kind tamper",
			"kind drift",
			"kind wild"
		] satisfies ReadonlyArray<Reached<`kind ${ActionKind}`>>,
		check:
			(_, c: Case<`kind ${ActionKind}`>) =>
			({ reality, steps }) =>
				Effect.sync(() => {
					let state = initialState(docsInstall, docs.state.names, reality)
					for (let taken = 0; taken < steps; taken += 1) {
						const offered = enumerateActions(state, defaultScope)
						const [firstKind, ...moreKinds] = [...new Set(Arr.map(offered, (x) => x.kind))]
						if (firstKind === undefined) {
							break
						}
						const kind = c.draw(element([firstKind, ...moreKinds]))
						const ofKind = knownNonEmpty(
							Arr.filter(offered, (x) => x.kind === kind),
							"the box's actions of a kind"
						)
						state = settle(
							c.draw(element(step(state, c.draw(element(ofKind))))),
							installedNames
						).next
					}
					const actions = enumerateActions(state, defaultScope)
					const keys = Arr.map(actions, (x) => canonicalAction(state, x))
					assert.equal(
						new Set(keys).size,
						keys.length,
						"the box holds one action twice, up to renaming unheld values"
					)
					for (const kind of actionKinds) {
						if (applicable(state, kind)) {
							assert.ok(
								Arr.some(actions, (x) => x.kind === kind),
								`the state offers a ${kind} and the box holds none`
							)
						}
					}
					for (const x of actions) {
						c.note(`kind ${x.kind}`)
						assert.ok(serial(state, x), `the box holds a ${x.kind} the serial rule refuses`)
					}
				}),
		oracle: {
			kind: "specification",
			name: "the box's canonical form up to renaming, the offered kinds and the serial rule"
		},
		budget: { runs: 24, steered: 0 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/world-model/generate.test.ts#theWorldsGeneratorsEnumerateAFiniteBoxDuplicateFreeUpToRenamingCoveringEveryActionKindTheStateOffers:0:0.1.2.a"
				),
				reason:
					"a box whose enumeration reaches an arm with attachments, which the conservative delivery must hold",
				since: "2026-11-16"
			}
		],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/deliver.ts",
				original: "\t\t\tif (arm.attachments.length > 0) {",
				replacement: "\t\t\tif (arm.attachments.length <= 0) {",
				why: "Operator mutant (comparison) at packages/engine/src/lower/conservative/deliver.ts:495 in <module>: `>` becomes `<=`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
