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

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array, element, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	asTheOldPath,
	built,
	counts,
	type StepKind,
	stepKinds
} from "#test/unit/query/build/scaling.fixtures.ts"

/**
 * A query builder step reads only what it adds builds a fixed number of containers a step, whatever the chain's
 * length.
 *
 * Budget: 16 runs and 16 steered cases, what its suite stated before it became a property
 * (test/unit/query/build/scaling.test.ts:190 at 8cad5bce, its runs and its coverage's cases).
 */
export const aQueryBuilderStepReadsOnlyWhatItAddsBuildsAFixedNumberOfContainersAStepWhateverTheChainsLength =
	property.explore(
		(source) => ({
			kind: source.draw(element(stepKinds)),
			steps: source.draw(int(2, 400))
		}),
		{
			needs: {},
			budget: { runs: 16, steered: 16 },
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

/**
 * A query builder step reads only what it adds gives the Description the whole decode gives, over generated chains.
 *
 * Budget: 200 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/query/build/scaling.test.ts:226 at 8cad5bce, its runs and its coverage's cases).
 */
export const aQueryBuilderStepReadsOnlyWhatItAddsGivesTheDescriptionTheWholeDecodeGivesOverGeneratedChains =
	property.explore(
		(source) =>
			[source.draw(array(element(stepKinds), { min: 0, max: 8 })), source.draw(int(1, 5))] as const,
		{
			needs: {},
			budget: { runs: 200, steered: 200 },
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
			kills: [
				{
					file: "packages/engine/src/core/record.ts",
					original:
						'\tif (typeof value !== "object" || value === null || isList(value)) {\n\t\treturn false\n\t}',
					replacement: "\t{}",
					why: 'Operator mutant (guard) at packages/engine/src/core/record.ts:29 in isPlainRecord: `if (typeof value !== "object" || value === null || isList(value)) {\n\t\treturn fal` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6).'
				},
				{
					file: "packages/engine/src/core/record.ts",
					original:
						'\tif (typeof value !== "object" || value === null || isList(value)) {\n\t\treturn false\n\t}',
					replacement: "\t{}",
					why: 'Operator mutant (guard) at packages/engine/src/core/record.ts:29 in isPlainRecord: `if (typeof value !== "object" || value === null || isList(value)) {\n\t\treturn fal` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6).'
				}
			]
		}
	)
