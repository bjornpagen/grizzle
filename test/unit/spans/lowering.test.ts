/**
 * Span parameters and windows, as the builder records them and the compiler lowers them.
 *
 * - pointIn of two parameters: over every pair of a point's type and a window's endpoint (integer, bigint), the
 *   builder and the compile of the same description both admit it exactly where the two are one type, compatibility
 *   being nominal (scalar/compute/types.ts compatible); the compile refuses any other as MalformedDescription at
 *   pointIn's point. Oracle: the specification, nominal compatibility.
 * - Fixed-width spans: a window or an equated value of Shift's slot, a span of integer fixed at width 15, is bound at
 *   its declared type, int4range, in every statement of both artifacts, and its encoder admits exactly the spans of
 *   width 15, written as [start, end), refusing every other width at bind (spanWidth). The widths are drawn from the
 *   column's, its neighbours one unit either side, where the encoder's comparison turns, and 1 to 60. Oracle: the
 *   specification.
 *
 * Features: admitted and refused pairs; the column's width, a width one unit off it, and another width.
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Reached } from "@bjornpagen/testing/features"
import { constant, element, finite, int, oneOf } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { identity } from "#compiler/core/identity.ts"

import { range, int4, int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { pointIn } from "#compiler/query/build/terms.ts"

import { assert } from "@bjornpagen/testing/assert"
import { placeOf, refusalLoc, refused } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"

import { paramText } from "#test/support/wire.ts"
import {
	encoders,
	endpoints,
	equated,
	equatedChecksNeed,
	pointInDescription,
	type PointInFeature,
	Slot,
	Spans,
	window
} from "#test/unit/spans/lowering.fixtures.ts"

/** Span parameters and windows admits a pointIn of two parameters exactly where the point's type is the window's endpoint, at the builder and at the compile. */
export const spanParametersAndWindowsAdmitsAPointInOfTwoParametersExactlyWhereThePointsTypeIsTheWindowsEndpointAtTheBuilderAndAtTheCompile =
	property.exhaust(
		finite((source) => [source.draw(element(endpoints)), source.draw(element(endpoints))] as const),
		{
			needs: {},
			situations: ["admitted", "refused"] satisfies ReadonlyArray<Reached<PointInFeature>>,
			check:
				(_, c: Case<PointInFeature>) =>
				([pointType, endpoint]) =>
					Effect.sync(() => {
						const admits = pointType === endpoint
						const built = catchCompileError(() =>
							query(Spans).rule((r) => {
								const { id } = v(Slot, "slot")
								const point = pointType === "int4" ? r.param("point", int4) : r.param("point", int8)
								const window =
									endpoint === "int4"
										? r.param("window", range(int4))
										: r.param("window", range(int8))
								return r.match(Slot, { id }).where(pointIn(point, window)).find({ id })
							})
						)
						assert.equal(
							built.ok,
							admits,
							`the builder over a ${pointType} point and a ${endpoint} window`
						)
						if (!built.ok) {
							assert.equal(built.error.reason._tag, "MalformedDescription")
						}
						const compiled = compileTemplate(pointInDescription(pointType, endpoint), Spans, {
							...testCompile,
							installation: identity.schema(parsedSchemaName("spans"))
						})
						c.note(admits ? "admitted" : "refused")
						if (admits) {
							assert.ok(compiled.ok, "a point meets a window of its own endpoint type")
							return
						}
						const failure = refused(compiled, "MalformedDescription")
						assert.deepEqual(
							Arr.takeRight(placeOf(refusalLoc(failure)).path, 2),
							["pointIn", "point"],
							"the refusal names pointIn's point"
						)
					}),
			oracle: {
				kind: "specification",
				name: "nominal compatibility: a point meets a window exactly at the window's endpoint type"
			},
			box: "every pair of a point parameter's type and a window parameter's endpoint, of integer and bigint",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/check/checker.ts",
					original:
						'\t\t\t\t\tconst point = operand(desc.point, span.span.endpoint, childLoc(loc, "pointIn", "point"))',
					replacement: "\t\t\t\t\tconst point = unwrap(lower(desc.point)).expr",
					why: "The compile of pointIn over a span term admits a point of any type, its window's endpoint type unchecked (check/checker.ts); the pointIn property fails."
				}
			]
		}
	)

/**
 * Span parameters and windows binds a window or an equated value of a fixed-width span at its declared width, and
 * refuses another width at bind.
 *
 * Budget: 100 runs and 100 steered cases, what its suite stated before it became a property
 * (test/unit/spans/lowering.test.ts:187 at 8cad5bce, its runs and its coverage's cases).
 */
export const spanParametersAndWindowsBindsAWindowOrAnEquatedValueOfAFixedWidthSpanAtItsDeclaredWidthAndRefusesAnotherWidthAtBind =
	property.explore(
		(source) => ({
			start: source.draw(int(-1000, 1000)),
			width: source.draw(oneOf([constant(15), int(14, 16), int(1, 60)]))
		}),
		{
			needs: { equatedChecksNeed },
			budget: { runs: 100, steered: 100 },
			situations: [
				"the column's width",
				"a width one unit off it",
				"another width"
			] satisfies ReadonlyArray<
				Reached<"the column's width" | "a width one unit off it" | "another width">
			>,
			check:
				(
					{ equatedChecksNeed },
					c: Case<"the column's width" | "a width one unit off it" | "another width">
				) =>
				({ start, width }) =>
					Effect.gen(function* () {
						yield* equatedChecksNeed
						return yield* Effect.sync(() => {
							c.note(
								width === 15
									? "the column's width"
									: Math.abs(width - 15) === 1
										? "a width one unit off it"
										: "another width"
							)
							/** Each statement's encoder of the parameter, of its declared type: the column's fixed-width span. */
							const declared = [...encoders(window), ...encoders(equated)]
							for (const encode of declared) {
								const encoded = encode({ start, end: start + width })
								if (width === 15) {
									assert.deepEqual(encoded, Result.ok(paramText(`[${start},${start + width})`)))
								} else {
									refused(encoded, "spanWidth")
								}
							}
						})
					}),
			oracle: {
				kind: "specification",
				name: "a fixed-width span parameter binds exactly the spans of its width, as [start, end)"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/values/span.ts",
					original:
						'\treturn units(span.value.end) - units(span.value.start) === width ? span : Result.err("spanWidth")',
					replacement:
						'\treturn [width, width + 1n].includes(units(span.value.end) - units(span.value.start))\n\t\t? span\n\t\t: Result.err("spanWidth")',
					why: "A fixed width admitting one more unit at bind (scalar/values/span.ts); the fixed-width binding property fails."
				}
			]
		}
	)
