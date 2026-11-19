/**
 * The Allen masks (allen/mask.ts):
 *
 * - Named masks: over every ordered pair of spans of a window, each named mask holds of the pair exactly when what it
 *   names holds of the spans' points. Oracle: the specification, each name's meaning over points.
 * - Entry points: every integer from one below the thirteen bits to one past them, the numbers that are no integer and
 *   values of other kinds: parseAllenMask and checkedMask accept exactly the masks, -0 as the empty one; complement,
 *   converse and r.allen refuse every other number as MalformedDescription; complement is the thirteen bits' complement
 *   and converse each relation's converse, each its own inverse, and the two commute; r.allen records a nonempty mask
 *   unchanged and refuses the empty one. Oracle: the specification, a mask's definition and those of complement and
 *   converse.
 *
 * Features, required in the space: each named mask held and failed; a mask, the empty and the full one, below and past
 * the thirteen bits, no integer, no number.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	ALLEN,
	allenConverseRelation,
	AllenMask,
	allenMaskOf,
	checkedMask,
	complementMask,
	converseMask,
	fullAllenMask,
	parseAllenMask
} from "#compiler/allen/mask.ts"
import { classify, spanText } from "#test/support/oracle/allen.ts"
import {
	allenTerm,
	type EntryFeature,
	given,
	isMask,
	meanings,
	named,
	type NamedFeature,
	namedMasks,
	refusedMalformed,
	relationsOf,
	spans
} from "#test/unit/allen/mask.fixtures.ts"

/** The named Allen masks hold of two spans exactly when what each names holds of their points. */
export const theNamedAllenMasksHoldOfTwoSpansExactlyWhenWhatEachNamesHoldsOfTheirPoints =
	property.exhaust(
		finite((source) => [source.draw(element(spans)), source.draw(element(spans))] as const),
		{
			needs: {},
			situations: Arr.flatMap(namedMasks, (n): Arr.NonEmptyReadonlyArray<NamedFeature> => [
				`${n} held`,
				`${n} failed`
			]) satisfies ReadonlyArray<Reached<NamedFeature>>,
			check:
				(_, c: Case<NamedFeature>) =>
				([a, b]) =>
					Effect.sync(() => {
						const relation = classify(a, b)
						for (const n of namedMasks) {
							const holds = meanings[n](a, b)
							assert.equal(
								Arr.contains(relationsOf(named[n]), relation),
								holds,
								`${n} of ${spanText(a)} and ${spanText(b)}, which are ${relation}`
							)
							c.note(`${n} ${holds ? "held" : "failed"}`)
						}
					}),
			oracle: {
				kind: "specification",
				name: "each named mask's meaning over the spans' points, against the pair's one basic relation by its endpoint conditions"
			},
			box: "every ordered pair of spans [a, b) with -3 <= a < b <= 8",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/allen/mask.ts",
					original: '\tcovers: allenMaskOf(["equals", "contains", "startedBy", "finishedBy"]),',
					replacement: '\tcovers: allenMaskOf(["contains", "startedBy", "finishedBy"]),',
					why: "covers missing equals (allen/mask.ts); the named masks property fails."
				}
			]
		}
	)

/** Every entry point a mask reaches accepts exactly the masks, as complement and converse define them, and refuses every other value as malformed. */
export const everyEntryPointAMaskReachesAcceptsExactlyTheMasksAsComplementAndConverseDefineThemAndRefusesEveryOtherValueAsMalformed =
	property.exhaust(finite(given), {
		needs: {},
		situations: [
			"a mask",
			"the empty mask",
			"the full mask",
			"below the thirteen bits",
			"past the thirteen bits",
			"no integer",
			"no number"
		] satisfies ReadonlyArray<Reached<EntryFeature>>,
		check: (_, c: Case<EntryFeature>) => (g) =>
			Effect.sync(() => {
				/** -0 is the empty mask. */
				const mask = isMask(g.value) ? AllenMask(g.value === 0 ? 0 : g.value) : undefined
				c.note(
					g.kind === "other"
						? "no number"
						: mask === 0
							? "the empty mask"
							: mask === fullAllenMask
								? "the full mask"
								: mask !== undefined
									? "a mask"
									: !Number.isInteger(g.value)
										? "no integer"
										: g.value < 0
											? "below the thirteen bits"
											: "past the thirteen bits"
				)
				assert.equal(parseAllenMask(g.value), mask)
				if (mask === undefined) {
					assert.ok(refusedMalformed(() => checkedMask(g.value, "converse")))
				} else {
					assert.equal(checkedMask(g.value, "converse"), mask)
				}
				if (g.kind === "other") {
					return
				}
				if (mask === undefined) {
					assert.ok(
						refusedMalformed(() => ALLEN.complement(g.value)),
						"complement"
					)
					assert.ok(
						refusedMalformed(() => ALLEN.converse(g.value)),
						"converse"
					)
					assert.ok(
						refusedMalformed(() => allenTerm(g.value)),
						"r.allen"
					)
					return
				}
				assert.equal(ALLEN.complement(mask), AllenMask(fullAllenMask ^ mask))
				assert.equal(ALLEN.complement(ALLEN.complement(mask)), mask)
				assert.equal(
					ALLEN.converse(mask),
					allenMaskOf(Arr.map(relationsOf(mask), (relation) => allenConverseRelation[relation]))
				)
				assert.equal(ALLEN.converse(ALLEN.converse(mask)), mask)
				assert.equal(ALLEN.converse(ALLEN.complement(mask)), ALLEN.complement(ALLEN.converse(mask)))
				assert.equal(converseMask(mask), ALLEN.converse(mask))
				assert.equal(complementMask(mask), ALLEN.complement(mask))
				if (mask === 0) {
					assert.ok(
						refusedMalformed(() => allenTerm(mask)),
						"r.allen"
					)
					return
				}
				const desc = allenTerm(mask)
				const [arm] = desc?.stage.kind === "rules" ? desc.stage.arms : []
				const [term] = arm?.where ?? []
				assert.equal(
					term?.kind === "allen" && term.mask,
					mask,
					"r.allen records the mask unchanged"
				)
			}),
		oracle: {
			kind: "specification",
			name: "a mask is an integer of thirteen bits; complement and converse as defined"
		},
		box: "every integer from -1 to two past the full mask, the named numbers that are no integer, and values of other kinds",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/allen/mask.ts",
				original: "\tNumber.isInteger(value) && value >= 0 && value <= allenMaskMax",
				replacement: "\tNumber.isInteger(value) && value >= 0 && value <= allenMaskMax * 2 + 1",
				why: "A fourteenth bit admitted as a mask (allen/mask.ts inMaskRange); the entry points property fails."
			}
		]
	})
