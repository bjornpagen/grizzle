/**
 * Num.floatBits, a float's identity image (scalar/compute/registry.ts floatBitsOf), lowered as a check lowers it and
 * evaluated on the host (scalar/compute/float.ts floatBits) and by the reference evaluator, which reads a value's own
 * bits through a typed array of its width, every NaN the quiet NaN of no payload
 * (test/support/oracle/evaluate/catalog.ts identityBits).
 *
 * Property: over drawn doubles and reals, finite ones and the specials (NaN, ±Infinity, -0) and both zeros often, the
 * host's image and the reference's agree, a bigint, a real's that of the double it widens to, and two values have one
 * image exactly when they are one IEEE 754 value with every NaN one.
 *
 * Oracle: the reference evaluator's reading of the encoding, and IEEE 754 identity (Object.is).
 */
import * as Engine from "@bjornpagen/grizzle-text/base/result"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { boolean, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { doubleOrSpecial, floatOrSpecial } from "@bjornpagen/testing/values"
import { Effect, Formatter } from "effect"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { predicateTable } from "#compiler/ir/expr.ts"
import { compiledExpr, noParamLeaf } from "#compiler/scalar/compute/evaluate.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { succeeded } from "#test/support/assert.ts"
import { evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import { baseParams, lowerWith, testPg } from "#test/unit/compute/support.ts"

type BitsFeature =
	| "a double"
	| "a real"
	| "both zeros apart"
	| "a double's NaN"
	| "a real's NaN"
	| "an infinity"

/** Two values of one width, both zeros and the specials often. */
const pairGen: Gen<{ readonly real: boolean; readonly x: number; readonly y: number }> = (s) => {
	const real = s.draw(boolean)
	const value = weighted<number>([
		[1, element([0, -0] as const)],
		[3, real ? floatOrSpecial(-4, 4) : doubleOrSpecial(-4, 4)]
	])
	return { real, x: s.draw(value), y: s.draw(value) }
}

const bits: ExprDesc = { kind: "compute", fn: "floatBits", args: [{ kind: "var", var: "x" }] }

/** Num.floatBits on the host is the reference's reading of a float's encoding, one image per IEEE 754 value. */
export const computeFloatBitsOnTheHostIsTheReferencesReadingOfAFloatsEncodingOneImagePerValue =
	property.explore(pairGen, {
		needs: {},
		situations: [
			"a double",
			"a real",
			"both zeros apart",
			"a double's NaN",
			"a real's NaN",
			"an infinity"
		] satisfies ReadonlyArray<Reached<BitsFeature>>,
		check:
			(_, k: Case<BitsFeature>) =>
			({ real, x, y }) =>
				Effect.sync(() => {
					const column = {
						kind: "column" as const,
						type: (real ? testPg.real : testPg.double).scalar
					}
					const root = succeeded(
						lowerWith("check", bits, { x: column }, false, baseParams),
						"it lowers"
					).root.expr
					const image = (v: number) => {
						const table = predicateTable(root)
						const host = succeeded(
							Engine.mapError(
								compiledExpr(table)(
									{
										value: undefined,
										column: () => v,
										closed: () => undefined,
										param: noParamLeaf
									},
									ProgramPatterns.of(tablePatterns(table))
								),
								(stop) => new Error(Formatter.format(stop))
							),
							"the host evaluates it"
						)
						const reference = evaluate(root, {
							kind: "row",
							column: () => v,
							param: () => undefined,
							regexMember: patternMember
						})
						assert.ok(
							reference._tag === "Success",
							`the reference evaluates ${Formatter.format(v)}`
						)
						assert.equal<unknown>(
							host,
							reference.success,
							`the host's image of ${Formatter.format(v)} is the reference's`
						)
						return host
					}
					const [ix, iy] = [image(x), image(y)]
					assert.equal(typeof ix, "bigint", "the image is a bigint")
					const same = Object.is(x, y) || (Number.isNaN(x) && Number.isNaN(y))
					assert.equal(
						ix === iy,
						same,
						`one image exactly for one value: ${Formatter.format([x, y])}`
					)
					k.note(real ? "a real" : "a double")
					if (Object.is(x, -0) !== Object.is(y, -0) && x === 0 && y === 0) {
						k.note("both zeros apart")
					}
					if (Number.isNaN(x) || Number.isNaN(y)) {
						k.note(real ? "a real's NaN" : "a double's NaN")
					}
					if (
						Math.abs(x) === Number.POSITIVE_INFINITY ||
						Math.abs(y) === Number.POSITIVE_INFINITY
					) {
						k.note("an infinity")
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator's reading of a float's encoding through a typed array, and IEEE 754 identity"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/float.ts",
				original: "export const canonicalNanBits = 0x7ff8_0000_0000_0000n",
				replacement: "export const canonicalNanBits = 0x7ff0_0000_0000_0001n",
				why: "A double's NaN's image is a signalling NaN's bits, not the quiet NaN of no payload the reference reads every NaN as."
			},
			{
				file: "packages/engine/src/scalar/compute/float.ts",
				original: "\tview.setFloat64(0, value)",
				replacement: "\tview.setFloat64(0, value + 0)",
				why: "The host's image folds -0 into 0, so the two zeros share one image."
			},
			{
				file: "packages/engine/src/scalar/compute/float.ts",
				original: "\tview.setFloat64(0, value)",
				replacement: "\tview.setFloat64(0, value, true)",
				why: "The host writes the double little-endian and reads it big-endian, so its image is the bytes reversed, not the reference's."
			}
		]
	})
