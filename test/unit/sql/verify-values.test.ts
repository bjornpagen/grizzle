import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, requiredInSpace } from "@grizzle/testing/features"
import { array, constant, element, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { regex } from "arkregex"
import { Array as Arr, Duration, Effect, Formatter, String as Str } from "effect"
import { exactParts } from "#compiler/core/decimal.ts"
import type { Expr, SqlStatement, TypeRef } from "#compiler/sql/ast.ts"
import { col, lit, simpleSelect, table, target, types } from "#compiler/sql/build.ts"
import { assert } from "#test/support/assert.ts"
import { auditStatementViolations } from "#test/support/oracle/verify/sql.ts"

/**
 * The structural audit's checks of values, generated against oracles written apart from it: an identifier is nonempty,
 * holds no NUL, is well-formed UTF-16 and fits 63 bytes of UTF-8; a text literal holds no NUL and is well-formed; a
 * decimal literal is an optional minus, digits, and optionally a point and more digits, or NaN or an infinity; an
 * integer literal lies within its type; numeric's precision lies in 1..1000 and its scale in -1000..1000. Each draws
 * values around the edges: lone surrogates of either half, pairs, multibyte letters around the byte limit, empty digit
 * runs, the bounds and one past them.
 */
const rules = (statement: SqlStatement): ReadonlyArray<string> =>
	Arr.map(auditStatementViolations(statement), (v) => v.rule)
const selecting = (e: Expr): SqlStatement => simpleSelect([target(e)], [], undefined)

/** A numeric literal spelled `text` as drawn, built as the AST holds it: lit.decimal spells only a value's parts. */
const decimalSpelled = (text: string): Expr => ({
	kind: "literal",
	value: { kind: "decimal", value: text },
	type: types.numeric
})

/** Text of code units around the edges: ASCII, a two-byte letter, a pair, a lone high or low surrogate, NUL. */
const unitsGen = (maxLength: number): Gen<string> =>
	map(
		array(element(["a", "z", "_", "é", "😀", "\ud800", "\udc00", "\u0000"] as const), {
			min: 0,
			max: maxLength
		}),
		(parts) => Arr.join(parts, "")
	)

const utf8 = (text: string): number => new TextEncoder().encode(text).length

type IntegerName = "smallint" | "integer" | "bigint"

/** The bounds of each integer type. */
const bounds: Arr.NonEmptyReadonlyArray<readonly [IntegerName, TypeRef, bigint, bigint]> = [
	["smallint", types.smallint, -32768n, 32767n],
	["integer", types.integer, -2147483648n, 2147483647n],
	["bigint", types.bigint, -9223372036854775808n, 9223372036854775807n]
]

/** An integer type, one of its ends, and a step of up to two from it: the bounds and one and two past them. */
const integerGen: Gen<readonly [readonly [IntegerName, TypeRef, bigint, bigint], 0 | 1, number]> = (
	source
) =>
	[
		source.draw(element(bounds)),
		source.draw(element([0, 1] as const)),
		source.draw(int(-2, 2))
	] as const

/** What an integer case reached: the type's bound, within or past it. */
type IntegerFeature = `${IntegerName} ${"within" | "past"}`

/** The typmods around numeric's bounds. */
const around = element([-1001, -1000, -999, -1, 0, 1, 2, 999, 1000, 1001] as const)

/** A precision, and a scale or none: each pair one case of the space. */
const typmodGen: Gen<readonly [number, number | undefined]> = (source) =>
	[
		source.draw(around),
		source.draw(oneOf<number | undefined>([constant(undefined), around]))
	] as const

/** What a typmod case reached: a precision and a scale within or past their bounds, or no scale. */
type TypmodFeature = "valid" | "precision past" | "scale past" | "no scale"

describe("the audit's checks of values, generated", () => {
	it.effect("an identifier is nonempty, without NUL, well-formed and at most 63 bytes", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/sql/audit-identifiers",
					draw: drawn(oneOf([unitsGen(8), matching(regex("^[a-zé]{28,36}$"))])),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 400,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(2)
				},
				(name) =>
					Effect.sync(() => {
						const valid =
							name.length > 0 &&
							!Str.includes("\u0000")(name) &&
							name.isWellFormed() &&
							utf8(name) <= 63
						const found = rules(
							simpleSelect([target(col("r1", name))], [table("w", "t", "r1")], undefined)
						).includes("identifier")
						assert.equal(found, !valid, Formatter.format(name))
					})
			)
		)
	)

	it.effect("a text literal holds no NUL and is well-formed", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/sql/audit-text-literals",
					draw: drawn(unitsGen(6)),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 300,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(2)
				},
				(text) =>
					Effect.sync(() => {
						const valid = !Str.includes("\u0000")(text) && text.isWellFormed()
						assert.equal(
							rules(selecting(lit.text(text, types.text))).includes("literal"),
							!valid,
							Formatter.format(text)
						)
					})
			)
		)
	)

	it.effect(
		"a decimal literal is digits with an optional minus and fraction, or NaN or an infinity",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/sql/audit-decimals",
						draw: drawn(
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
							])
						),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					(text) =>
						Effect.sync(() => {
							const valid =
								regex("^-?[0-9]+(\\.[0-9]+)?$").test(text) ||
								["NaN", "Infinity", "-Infinity"].includes(text)
							assert.equal(
								rules(selecting(decimalSpelled(text))).includes("literal"),
								!valid,
								Formatter.format(text)
							)
						})
				)
			)
	)

	it.effect("an integer literal lies within its type", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/sql/audit-integers",
					generator: integerGen,
					literal: Formatter.format,
					/** The space holds 30 cases (3 types, 2 ends, 5 steps); the limit caps a space grown by mistake. */
					limit: 40,
					coverage: requiredInSpace<IntegerFeature>([
						"smallint within",
						"smallint past",
						"integer within",
						"integer past",
						"bigint within",
						"bigint past"
					]),
					caseHang: Duration.minutes(2)
				},
				([[name, type, low, high], end, step], c) =>
					Effect.sync(() => {
						const value = (end === 0 ? low : high) + BigInt(step)
						const valid = value >= low && value <= high
						assert.equal(
							rules(selecting(lit.int(value, type))).includes("literal"),
							!valid,
							`${value}`
						)
						c.note(`${name} ${valid ? "within" : "past"}`)
					})
			)
		)
	)

	it.effect("numeric's precision lies in 1..1000 and its scale in -1000..1000", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/sql/audit-numeric-typmods",
					generator: typmodGen,
					literal: Formatter.format,
					/** The space holds 110 cases (10 precisions, 11 scales); the limit caps a space grown by mistake. */
					limit: 120,
					coverage: requiredInSpace<TypmodFeature>([
						"valid",
						"precision past",
						"scale past",
						"no scale"
					]),
					caseHang: Duration.minutes(2)
				},
				([precision, scale], c) =>
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
					})
			)
		)
	)
})
