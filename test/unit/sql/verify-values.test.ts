/**
 * The structural audit's checks of values, generated against oracles written apart from it: an identifier is nonempty,
 * holds no NUL, is well-formed UTF-16 and fits 63 bytes of UTF-8; a decimal literal is an optional minus, digits, and
 * optionally a point and more digits, or NaN or an infinity; an integer literal lies within its type. Each draws values
 * around the edges: lone surrogates of either half, pairs, multibyte letters around the byte limit, empty digit runs,
 * the bounds and one past them, and named malformed spellings beside drawn ones.
 *
 * Oracle: each check restated apart from the audit (test/support/oracle/verify/sql.ts), a second implementation.
 * Features: each integer type within and past its bounds.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { element, finite, oneOf } from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import { type Case, property } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Effect, Formatter, String as Str } from "effect"
import { col, distinctCore, lit, select, table, target } from "#compiler/sql/build.ts"
import { assert } from "#test/support/assert.ts"
import {
	byteEdgeGen,
	decimalSpelled,
	type IntegerFeature,
	integerGen,
	rules,
	selecting,
	unitsGen,
	utf8
} from "#test/unit/sql/verify-values.fixtures.ts"

/**
 * The audit's checks of values, generated an identifier is nonempty, without NUL, well-formed and at most 63 bytes.
 *
 * Budget: 400 runs and 0 steered cases, what its suite stated before it became a property
 * (test/unit/sql/verify-values.test.ts:108 at 8cad5bce, its runs and its coverage's cases).
 */
export const theAuditsChecksOfValuesGeneratedAnIdentifierIsNonemptyWithoutNULWellFormedAndAtMost63Bytes =
	property.explore(oneOf([unitsGen(8), byteEdgeGen]), {
		needs: {},
		budget: { runs: 400, steered: 0 },
		situations: [],
		check: () => (name) =>
			Effect.sync(() => {
				const valid =
					name.length > 0 &&
					!Str.includes("\u0000")(name) &&
					name.isWellFormed() &&
					utf8(name) <= 63
				const found = rules(
					select(distinctCore([target(col("r1", name))], [table("w", "t", "r1")], undefined))
				).includes("identifier")
				assert.equal(found, !valid, Formatter.format(name))
			}),
		oracle: {
			kind: "second-implementation",
			name: "nonempty, no NUL, well-formed, at most 63 UTF-8 bytes, restated apart from the audit"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/utf8.ts",
				original: "\t\t\t? 2\n",
				replacement: "\t\t\t? 3\n",
				why: "Operator mutant (bound) at packages/engine/src/core/sha256.ts:54 in utf8Length: `2` becomes `3`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * The audit's checks of values, generated a decimal literal is digits with an optional minus and fraction, or NaN or
 * an infinity.
 *
 * Budget: 300 runs and 0 steered cases, what its suite stated before it became a property
 * (test/unit/sql/verify-values.test.ts:175 at 8cad5bce, its runs and its coverage's cases).
 */
export const theAuditsChecksOfValuesGeneratedADecimalLiteralIsDigitsWithAnOptionalMinusAndFractionOrNaNOrAnInfinity =
	property.explore(
		oneOf([
			matching(regex("^-?[0-9]{0,3}(\\.[0-9]{0,3})?$")),
			element([
				"NaN",
				"Infinity",
				"-Infinity",
				"1e5",
				"+1",
				"1.",
				".5",
				"-",
				".",
				"--1",
				"1.2.3",
				" 1"
			] as const)
		]),
		{
			needs: {},
			budget: { runs: 300, steered: 0 },
			situations: [],
			check: () => (text) =>
				Effect.sync(() => {
					const valid =
						regex("^-?[0-9]+(\\.[0-9]+)?$").test(text) ||
						["NaN", "Infinity", "-Infinity"].includes(text)
					assert.equal(
						rules(selecting(decimalSpelled(text))).includes("literal"),
						!valid,
						Formatter.format(text)
					)
				}),
			oracle: {
				kind: "second-implementation",
				name: "an optional minus, digits and an optional fraction, or NaN or an infinity, restated apart from the audit"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/sql/build.ts",
					original: "\tscale: undefined,\n\tarray: false\n})",
					replacement: "\tscale: undefined,\n\tarray: true\n})",
					why: "Operator mutant (boolean) at packages/engine/src/sql/build.ts:56 in builtinType: `false` becomes `true`; the property fails (lane CATCH, grizzle 0baff5d6)."
				}
			]
		}
	)

/** The audit's checks of values, generated an integer literal lies within its type. */
export const theAuditsChecksOfValuesGeneratedAnIntegerLiteralLiesWithinItsType = property.exhaust(
	finite(integerGen),
	{
		needs: {},
		situations: [
			"smallint within",
			"smallint past",
			"integer within",
			"integer past",
			"bigint within",
			"bigint past"
		] satisfies ReadonlyArray<Reached<IntegerFeature>>,
		check:
			(_, c: Case<IntegerFeature>) =>
			([[name, type, low, high], end, step]) =>
				Effect.sync(() => {
					const value = (end === 0 ? low : high) + BigInt(step)
					const valid = value >= low && value <= high
					assert.equal(
						rules(selecting(lit.int(value, type))).includes("literal"),
						!valid,
						`${value}`
					)
					c.note(`${name} ${valid ? "within" : "past"}`)
				}),
		oracle: {
			kind: "second-implementation",
			name: "each integer type's bounds, restated apart from the audit"
		},
		box: "each integer type at each bound and up to two past or within it",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/build.ts",
				original: "\tscale: undefined,\n\tarray: false\n})",
				replacement: "\tscale: undefined,\n\tarray: true\n})",
				why: "Operator mutant (boolean) at packages/engine/src/sql/build.ts:56 in builtinType: `false` becomes `true`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	}
)
