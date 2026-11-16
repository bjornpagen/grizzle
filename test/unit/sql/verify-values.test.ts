/**
 * The structural audit's checks of values, generated against oracles written apart from it: an identifier is nonempty,
 * holds no NUL, is well-formed UTF-16 and fits 63 bytes of UTF-8; a text literal holds no NUL and is well-formed; a
 * decimal literal is an optional minus, digits, and optionally a point and more digits, or NaN or an infinity; an
 * integer literal lies within its type; numeric's precision lies in 1..1000 and its scale in -1000..1000. Each draws
 * values around the edges: lone surrogates of either half, pairs, multibyte letters around the byte limit, empty digit
 * runs, the bounds and one past them, and named malformed spellings beside drawn ones.
 *
 * Oracle: each check restated apart from the audit (test/support/oracle/verify/sql.ts), a second implementation.
 * Features: each integer type within and past its bounds; a typmod valid, past either bound, or without a scale.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { element, finite, oneOf } from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import { type Case, property } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Effect, Formatter, String as Str } from "effect"
import { exactParts } from "#compiler/core/decimal.ts"
import type { TypeRef } from "#compiler/sql/ast.ts"
import { col, distinctCore, lit, select, table, target, types } from "#compiler/sql/build.ts"
import { assert } from "#test/support/assert.ts"
import {
	byteEdgeGen,
	decimalSpelled,
	type IntegerFeature,
	integerGen,
	rules,
	selecting,
	type TypmodFeature,
	typmodGen,
	unitsGen,
	utf8
} from "#test/unit/sql/verify-values.fixtures.ts"

/** The audit's checks of values, generated an identifier is nonempty, without NUL, well-formed and at most 63 bytes. */
export const theAuditsChecksOfValuesGeneratedAnIdentifierIsNonemptyWithoutNULWellFormedAndAtMost63Bytes =
	property.explore(oneOf([unitsGen(8), byteEdgeGen]), {
		needs: {},
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
		kills: []
	})

/** The audit's checks of values, generated a text literal holds no NUL and is well-formed. */
export const theAuditsChecksOfValuesGeneratedATextLiteralHoldsNoNULAndIsWellFormed =
	property.explore(unitsGen(6), {
		needs: {},
		situations: [],
		check: () => (text) =>
			Effect.sync(() => {
				const valid = !Str.includes("\u0000")(text) && text.isWellFormed()
				assert.equal(
					rules(selecting(lit.text(text, types.text))).includes("literal"),
					!valid,
					Formatter.format(text)
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "no NUL and well-formed, restated apart from the audit"
		},
		kept: [],
		kills: []
	})

/** The audit's checks of values, generated a decimal literal is digits with an optional minus and fraction, or NaN or an infinity. */
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
			kills: []
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
		kills: []
	}
)

/** The audit's checks of values, generated numeric's precision lies in 1..1000 and its scale in -1000..1000. */
export const theAuditsChecksOfValuesGeneratedNumericsPrecisionLiesIn11000AndItsScaleIn10001000 =
	property.exhaust(finite(typmodGen), {
		needs: {},
		situations: ["valid", "precision past", "scale past", "no scale"] satisfies ReadonlyArray<
			Reached<TypmodFeature>
		>,
		check:
			(_, c: Case<TypmodFeature>) =>
			([precision, scale]) =>
				Effect.sync(() => {
					const type: TypeRef =
						scale === undefined
							? { kind: "builtin", name: "numeric", precision, scale: undefined, array: false }
							: { kind: "builtin", name: "numeric", precision, scale, array: false }
					const precisionValid = precision >= 1 && precision <= 1000
					const scaleValid = scale === undefined || (scale >= -1000 && scale <= 1000)
					assert.equal(
						rules(selecting(lit.decimal(exactParts(1n, 0), type))).includes("type"),
						!(precisionValid && scaleValid),
						Formatter.format(type)
					)
					if (scale === undefined) {
						c.note("no scale")
					}
					c.note(!precisionValid ? "precision past" : !scaleValid ? "scale past" : "valid")
				}),
		oracle: {
			kind: "second-implementation",
			name: "precision in 1..1000 and scale in -1000..1000, restated apart from the audit"
		},
		box: "every pair of ten precisions around numeric's bounds and ten scales or none",
		kept: [],
		kills: []
	})
