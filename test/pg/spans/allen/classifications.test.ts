/**
 * Allen masks and pointIn on stored spans, against PostgreSQL 19, in both artifacts (optimized and conservative).
 *
 * The universe's every spelling is stored in a relation of each range type, and points around the window and at the
 * limits beside them. Properties:
 *
 * - every mask ALLEN names, its complement and converse, and the full mask, exhausted, and drawn masks searched: a pair
 *   query's answer holds each pair of stored spans once, exactly the pairs the brute-force classifier relates by a
 *   relation in the mask;
 * - pointIn over every stored span and point, exhausted over the point's type (int4, int8, a contract over int8) and
 *   the artifact: exactly the pairs whose span contains the point, half-open;
 * - a pointIn window parameter, drawn at each limit, over one point and inside, binds as the point's base range type:
 *   exactly the stored points inside it.
 *
 * Features: every basic relation a mask includes; each point type in each artifact; each window type at each edge.
 *
 * A mask reaches PostgreSQL as its formula in the shipped table (allen/table.generated.ts), each literal one range
 * operator (check/allen.ts allenExpr), so the relations each atom of allen/atoms.ts holds for are the table
 * generator's, which test/unit/allen/table.test.ts holds.
 */

import { element, int, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { fullAllenMask } from "#compiler/allen/mask.ts"
import { rowsAs, runArtifact } from "#test/pg/spans/allen/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { rangeTypes } from "#test/support/oracle/allen.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

import {
	rowOrder,
	fixedMasks,
	type MaskFeature,
	checkMask,
	windowTypes,
	windowEdges,
	type WindowFeature,
	windowLimits,
	windowPoints,
	windowSketchGen,
	resolveWindow,
	artifacts,
	type PointFeature,
	pointCase,
	universeTemplate,
	universeIn,
	windowTemplates,
	noteMask,
	maskFeatures
} from "#test/pg/spans/allen/classifications.fixtures.ts"

/**
 * Allen masks and pointIn on stored spans match the brute-force classifier for every basic relation, named mask,
 * complement and converse.
 */
export const allenMasksAndPointInOnStoredSpansMatchTheBruteForceClassifierForEveryBasicRelationNamedMaskComplementAndConverse =
	property.exhaust(
		finite((source) => ({
			type: source.draw(element(rangeTypes)),
			mask: source.draw(element(fixedMasks))
		})),
		{
			box: "both range types, by every mask ALLEN names, its complement and converse, and the full mask",
			needs: { universe: Substrate.seat(universeTemplate) },
			situations: maskFeatures,
			check:
				({ universe }, c: Case<MaskFeature>) =>
				({ type, mask }) =>
					Effect.scoped(
						Effect.gen(function* () {
							const { installed, reader } = yield* Effect.flatMap(universe, universeIn)
							noteMask(mask, c)
							const maskFaults = yield* checkMask(installed, reader, type, mask)
							assert.deepEqual(maskFaults, [])
						})
					),
			oracle: {
				kind: "second-implementation",
				name: "the brute-force Allen classifier over the stored universe's pairs"
			},
			kept: [],
			kills: []
		}
	)

/**
 * Allen masks and pointIn on stored spans match the brute-force classifier for every explored mask.
 *
 * Its pre-conversion budget: runs 24, coverage cases 24 (test/pg/spans/allen/classifications.test.ts at f2a727cba).
 */
export const allenMasksAndPointInOnStoredSpansMatchTheBruteForceClassifierForEveryExploredMask =
	property.explore(int(1, fullAllenMask), {
		needs: { universe: Substrate.seat(universeTemplate) },
		situations: maskFeatures,
		check:
			({ universe }, c: Case<MaskFeature>) =>
			(mask) =>
				Effect.scoped(
					Effect.gen(function* () {
						const { installed, reader } = yield* Effect.flatMap(universe, universeIn)
						noteMask(mask, c)
						for (const type of rangeTypes) {
							const maskFaults = yield* checkMask(installed, reader, type, mask)
							assert.deepEqual(maskFaults, [])
						}
					})
				),
		oracle: {
			kind: "second-implementation",
			name: "the brute-force Allen classifier over the stored universe's pairs"
		},
		budget: { runs: 24, steered: 24 },
		kept: [],
		kills: []
	})

/** Allen masks and pointIn on stored spans match pointIn for every stored span and every point around the window and at the limits. */
export const allenMasksAndPointInOnStoredSpansMatchPointInForEveryStoredSpanAndEveryPointAroundTheWindowAndAtTheLimits =
	property.exhaust(
		finite((source) => ({
			point: source.draw(element(windowTypes)),
			artifact: source.draw(element(artifacts))
		})),
		{
			box: "every point relation's type, in both artifacts",
			needs: { universe: Substrate.seat(universeTemplate) },
			situations: Arr.flatMap(windowTypes, (point) =>
				Arr.map(artifacts, (artifact): PointFeature => `${point} ${artifact}`)
			),
			check:
				({ universe }, c: Case<PointFeature>) =>
				({ point, artifact }) =>
					Effect.scoped(
						Effect.gen(function* () {
							const { installed, reader } = yield* Effect.flatMap(universe, universeIn)
							c.note(`${point} ${artifact}`)
							const { template, columns, expected } = pointCase(point, installed)
							const spec = defined(template[artifact][0], "a statement")
							const [rows] = yield* runArtifact(reader, template, artifact, {})
							assert.deepEqual(rowsAs(spec, rows ?? [], columns).rows, expected)
						})
					),
			oracle: {
				kind: "specification",
				name: "pointIn as half-open containment, lo <= p < hi, over every stored span and point"
			},
			kept: [],
			kills: []
		}
	)

/**
 * Allen masks and pointIn on stored spans bind a pointIn window parameter as the point's base range type, for every
 * window the search draws.
 *
 * Its pre-conversion budget: runs 48, coverage cases 48 (test/pg/spans/allen/classifications.test.ts at f2a727cba).
 */
export const allenMasksAndPointInOnStoredSpansBindAPointInWindowParameterAsThePointsBaseRangeTypeForEveryWindowTheSearchDraws =
	property.explore(windowSketchGen, {
		needs: { universe: Substrate.seat(universeTemplate), windowTemplates },
		situations: Arr.flatMap(windowTypes, (type) =>
			Arr.map(windowEdges, (edge): WindowFeature => `${type} window ${edge}`)
		),
		check:
			({ universe, windowTemplates }, c: Case<WindowFeature>) =>
			(sketch) =>
				Effect.scoped(
					Effect.gen(function* () {
						const { reader } = yield* Effect.flatMap(universe, universeIn)
						const { type, lo, hi } = resolveWindow(sketch)
						const { min, max } = windowLimits(type)
						if (lo === min) {
							c.note(`${type} window from the lower limit`)
						}
						if (hi === max) {
							c.note(`${type} window to the upper limit`)
						}
						if (hi - lo === 1n) {
							c.note(`${type} window one point`)
						}
						if (lo > min && hi < max) {
							c.note(`${type} window inside`)
						}
						const at = (n: bigint) => (type === "int4range" ? Number(n) : n)
						const expected = Arr.sort(
							Arr.map(
								Arr.filter(windowPoints(type), (p) => lo <= p && p < hi),
								(p) => [String(p)]
							),
							rowOrder
						)
						const templates = yield* windowTemplates
						const template = templates[type]
						for (const artifact of artifacts) {
							const spec = defined(template[artifact][0], `the ${artifact} statement`)
							const [rows] = yield* runArtifact(reader, template, artifact, {
								window: { start: at(lo), end: at(hi) }
							})
							assert.deepEqual(
								rowsAs(spec, rows ?? [], [type === "contract" ? "at" : "p"]).rows,
								expected,
								`${type} [${lo}, ${hi}) (${artifact})`
							)
						}
					})
				),
		oracle: {
			kind: "specification",
			name: "the stored points inside the half-open window, lo <= p < hi"
		},
		budget: { runs: 48, steered: 48 },
		kept: [],
		kills: []
	})
