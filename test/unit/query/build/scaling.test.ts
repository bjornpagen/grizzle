/**
 * A query builder step reads only what it adds. A stage's Description holds its input stage, its earlier arms, an
 * attachment's child and an imported query as the Descriptions they already are (shape.ts recognized), so the step
 * builds a fixed number of containers whatever the query's size, where a decode of the whole would copy every one.
 * The count is taken at every step of a chain of one drawn step kind and a drawn length. The Description is the one the
 * whole decode gives, the old path, kept here as the oracle.
 *
 * The chains here are the builder's own steps (rules, named stages, attachments, imports, an order and a take) drawn by
 * kind and length; test/unit/query/desc-order.test.ts holds the same Description contract over generated public
 * programs, a family these chains do not reach, and these chains reach depths and attachments it does not.
 *
 * Oracles: the first step's count, which every later step must equal, a specification of a step's cost; the whole
 * decode of a plain copy, a second implementation, for the Description.
 *
 * Features: each step kind.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { array, element, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { assert, defined } from "#test/support/assert.ts"
import {
	asTheOldPath,
	built,
	counts,
	type StepKind,
	stepKinds
} from "#test/unit/query/build/scaling.fixtures.ts"

/** A query builder step reads only what it adds builds a fixed number of containers a step, whatever the chain's length. */
export const aQueryBuilderStepReadsOnlyWhatItAddsBuildsAFixedNumberOfContainersAStepWhateverTheChainsLength =
	property.explore(
		(source) => ({
			kind: source.draw(element(stepKinds)),
			steps: source.draw(int(2, 400))
		}),
		{
			needs: {},
			situations: stepKinds satisfies ReadonlyArray<Reached<StepKind>>,
			check:
				(_, c: Case<StepKind>) =>
				({ kind, steps }) =>
					Effect.sync(() => {
						c.note(kind)
						const counted = counts(kind, steps)
						const first = defined(counted[0], "the first step")
						for (const [i, step] of counted.entries()) {
							assert.equal(step, first, `step ${i + 1} of ${steps}`)
						}
					}),
			oracle: {
				kind: "specification",
				name: "every step builds as many containers as the first"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/query/build/query.ts",
					original: "\tconst desc: QueryDesc = deepFreeze({ stage })",
					replacement: "\tconst desc: QueryDesc = deepFreeze({ stage: structuredClone(stage) })",
					why: "Every step copies its whole stage into its Description, so it builds as many containers as the chain holds; the step-count search fails."
				}
			]
		}
	)

/** A query builder step reads only what it adds gives the Description the whole decode gives, over generated chains. */
export const aQueryBuilderStepReadsOnlyWhatItAddsGivesTheDescriptionTheWholeDecodeGivesOverGeneratedChains =
	property.explore(
		(source) =>
			[source.draw(array(element(stepKinds), { min: 0, max: 8 })), source.draw(int(1, 5))] as const,
		{
			needs: {},
			situations: stepKinds satisfies ReadonlyArray<Reached<StepKind>>,
			check:
				(_, c: Case<StepKind>) =>
				([kinds, take]) =>
					Effect.sync(() => {
						c.noteAll(kinds)
						for (const value of built(kinds, take)) {
							asTheOldPath(value)
						}
					}),
			oracle: {
				kind: "second-implementation",
				name: "the whole decode of a plain copy (decodeDesc)"
			},
			kept: [],
			kills: []
		}
	)
