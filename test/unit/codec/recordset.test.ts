import { describe, it } from "@effect/vitest"
import { drawn, explore, type Kept, sketched } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import {
	array,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	map,
	string,
	uniqueArray,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { double, uuid } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record, String as Str } from "effect"
import {
	arrayTexts,
	normalArray,
	normalFacts,
	parameterNormalizer,
	positionalColumns,
	type RelationSpec,
	relationNormalizer
} from "#compiler/codec/recordset.ts"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import { EncodingFailure } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import { TupleMap } from "#compiler/core/tuple-map.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { FactIdentity } from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { arraysEncoder } from "#test/support/arrays.ts"
import { readArrayLiteral } from "#test/support/arrays.ts"
import { assert, defined, failed, nonEmpty, succeeded } from "#test/support/assert.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { caseHang } from "#test/support/limits.ts"
import { paramText, textOfParam } from "#test/support/wire.ts"
import { kindCodes, normalizedBy, types } from "#test/unit/codec/support.ts"
import { asDecimal } from "#test/unit/codec/values.ts"

/**
 * Relation inputs: the host codec owns the set property and the null ban, deduplicating by fact identity after native
 * coercion and encoding canonically as one array literal per column. The host collects a Stream member whole before it
 * normalizes it (adapter/reader/params.ts). Deduplication and PostgreSQL's reading of the arrays are the pg relation
 * suite's, against PostgreSQL's own DISTINCT and array_in on generated cases (test/pg/codec/relation.test.ts); here,
 * the refusals, the canonical encoding and the literals' grammar, read back by array_in's rules (test/support/arrays.ts).
 */

const reading: RelationSpec = {
	relation: "Reading",
	columns: positionalColumns([
		{ name: "id", type: types.uuid },
		{ name: "value", type: types.numeric52 },
		{ name: "raw", type: types.float8 }
	]),
	slot: { kind: "slot", name: "readings" },
	codes: kindCodes
}

/**
 * A member planted among valid ones, and the refusal README "Errors and outcomes" gives it: an EncodingFailure naming the slot, and
 * the field where there is one, never the value.
 */
/** A scaled fact: a key and a numeric whose display scale varies. */
interface Scaled {
	readonly k: number
	readonly n: Decimal
}

type Plant =
	| "null member"
	| "null field"
	| "undefined field"
	| "missing field"
	| "extra field"
	| "number for decimal"

const plants: Arr.NonEmptyReadonlyArray<Plant> = [
	"null member",
	"null field",
	"undefined field",
	"missing field",
	"extra field",
	"number for decimal"
]
const fieldsOfReading = ["id", "value", "raw"] as const

/** A reading as a caller states it. */
interface Reading {
	readonly id: string
	readonly value: Decimal
	readonly raw: number
}

/** Every finite double, and now and then NaN or an infinity, as a float8 column holds. */
const anyDouble = weighted([
	[9, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
	[1, element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])]
])

const readingFact: Gen<Reading> = (source) => ({
	id: source.draw(uuid(4)),
	value: source.draw(map(int(-99999, 99999), (n) => Decimal.of(`${n}e-2`))),
	raw: source.draw(anyDouble)
})

/** Every character array_in reads as syntax, blanks, and NULL's letters among plain ones. */
const arrayCell = string(
	weighted([
		[3, element(['"', "\\", ",", "{", "}", " ", "\t", "\n", "N", "U", "L", "l"])],
		[2, codePoint(0x20, 0x7e)],
		[1, codePoint(0xa0, 0x10_ffff)]
	]),
	{ min: 0, max: 8 }
)

/** Up to six rows of `width` texts each. */
const cellRows = (width: number): Gen<ReadonlyArray<ReadonlyArray<string>>> =>
	array(array(arrayCell, { min: width, max: width }), { min: 0, max: 6 })

/** Where a bound falls against the longest literal: the situations its count of the literal's length must get right. */
type LiteralFeature =
	| "far within the bound"
	| "at the bound"
	| "one past the bound"
	| "far past the bound"

/** How far the bound sits from the longest literal's length. */
const boundOffset: Gen<number> = weighted([
	[2, int(2, 40)],
	[3, constant(0)],
	[3, constant(-1)],
	[2, int(-40, -2)]
])

/** A bound case: the columns, their rows' texts, and how far the bound sits from the longest literal's length. */
interface BoundCase {
	readonly width: number
	readonly rows: ReadonlyArray<ReadonlyArray<string>>
	readonly by: number
}

/** A column's literal of no row, its braces alone: once written past a bound one short of them. */
const bracesPastTheBound: Kept<BoundCase, LiteralFeature> = {
	note: "a column's literal of no row, its braces alone, was written past a bound one short of it",
	sketch: { width: 1, rows: [], by: -1 },
	draws: "",
	reaches: ["one past the bound"]
}

describe("relation normalization", () => {
	it.effect(
		"refuses a planted member with its word, naming the slot and the field, never the value",
		(ctx) =>
			Effect.gen(function* () {
				const normalize = relationNormalizer(reading)
				yield* searched(
					ctx,
					explore(
						{
							oracle: { kind: "unstated" },
							suite: "unit/codec/recordset-refusals",
							draw: drawn((source) => ({
								facts: source.draw(uniqueArray(readingFact, (r) => r.id, { min: 0, max: 4 }, 20)),
								at: source.draw(int(0, 2 ** 31 - 1)),
								plant: source.draw(element(plants)),
								field: source.draw(element(fieldsOfReading)),
								bad: source.draw(readingFact)
							})),
							literal: Formatter.format,
							coverage: required<`plant ${Plant}`>(
								Arr.map(plants, (p) => `plant ${p}` as const),
								{ cases: 300, sense: notesOnly }
							),
							kept: [],
							/** The rotating stream's sample of six plants, each a sixth of the cases. */
							runs: 300,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ facts, at, plant, field, bad }, c) =>
							Effect.sync(() => {
								c.note(`plant ${plant}`)
								const [member, reason, slot]: readonly [
									unknown,
									EncodingFailure["reason"]["_tag"],
									string | undefined
								] = (() => {
									switch (plant) {
										case "null member":
											return [null, "nullValue", "readings"]
										case "null field":
											return [{ ...bad, [field]: null }, "nullValue", `readings.${field}`]
										case "undefined field":
											return [{ ...bad, [field]: undefined }, "nullValue", `readings.${field}`]
										case "missing field": {
											const { [field]: _, ...rest } = bad
											return [rest, "factShape", undefined]
										}
										case "extra field":
											return [{ ...bad, extra: 1 }, "factShape", undefined]
										case "number for decimal":
											return [{ ...bad, value: 1.5 }, "decimalNumber", "readings.value"]
									}
								})()
								const members = [
									...facts.slice(0, at % (facts.length + 1)),
									member,
									...facts.slice(at % (facts.length + 1))
								]
								const result = normalizedBy(normalize, members)
								const failure = !result.ok ? result.error : result.value
								assert.ok(failure instanceof EncodingFailure, plant)
								assert.equal(failure.reason._tag, reason, plant)
								if (slot !== undefined) {
									assert.deepEqual(failure.place, { _tag: "Slot", name: slot }, plant)
								}
							})
					)
				)
			})
	)

	it.effect(
		"admits a member span of its column's fixed width, and refuses any other width",
		(ctx) =>
			Effect.gen(function* () {
				const spec: RelationSpec = {
					relation: "Slot",
					columns: positionalColumns([
						{ name: "fixed", type: scalarOf(f.span(f.integer, 15n), {}) }
					]),
					slot: { kind: "slot", name: "slots" },
					codes: kindCodes
				}
				const normalize = parameterNormalizer(spec)
				yield* searched(
					ctx,
					explore(
						{
							oracle: { kind: "unstated" },
							suite: "unit/codec/recordset-fixed-width",
							/** A width of 15 is one draw in thirty, about ten times a run: planted, at a negative start. */
							draw: sketched(
								(source) => ({
									start: source.draw(int(-1000, 1000)),
									width: source.draw(int(1, 30))
								}),
								(x) => x
							),
							literal: Formatter.format,
							coverage: required<"fixed width" | "other width">(["fixed width", "other width"], {
								cases: 300,
								sense: notesOnly
							}),
							kept: [
								{
									note: "a span of the fixed width",
									sketch: { start: -7, width: 15 },
									draws: "",
									reaches: ["fixed width" as const]
								}
							],
							runs: 300,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ start, width }, c) =>
							Effect.sync(() => {
								const result = normalize([{ fixed: { start, end: start + width } }])
								if (width === 15) {
									c.note("fixed width")
									assert.deepEqual(succeeded(result).rows, [
										[paramText(`[${start},${start + 15})`)]
									])
								} else {
									c.note("other width")
									assert.deepEqual(
										result,
										Result.err(
											EncodingFailure.make({
												reason: { _tag: "spanWidth" },
												place: { _tag: "Slot", name: "slots.fixed" }
											})
										)
									)
								}
							})
					)
				)
			})
	)

	it.effect("encodes canonically: the same set in any order gives byte-identical arrays", (ctx) =>
		Effect.gen(function* () {
			const encode = arraysEncoder(reading)
			yield* searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/codec/recordset-1919247219",
						draw: drawn(
							(source) =>
								[
									source.draw(uniqueArray(readingFact, (f) => f.id, { min: 0, max: 20 }, 20)),
									source.draw(int(0, 2 ** 31 - 1))
								] as const
						),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([facts, seed]) =>
						Effect.sync(() => {
							/** A code unit past the end reads as 0, as the native NaN does under `^`. */
							const rank = (id: string): number =>
								Option.getOrElse(Str.charCodeAt(id, seed % 36), () => 0) ^ seed
							const shuffled = Arr.sort(
								facts,
								Order.mapInput(Order.Number, (fact: { readonly id: string }) => rank(fact.id))
							)
							const first = succeeded(encode(facts))
							const second = succeeded(encode([...shuffled, ...shuffled]))
							assert.deepEqual(second, first)
							assert.equal(first.count, facts.length)
							assert.equal(first.arrays.length, 3)
							for (const array of first.arrays) {
								assert.equal(readArrayLiteral(array).length, facts.length)
							}
						})
				)
			)
		})
	)

	it.effect(
		"writes each array of facts normalized on the host as the raw input's arrays, in the heading's order or another",
		(ctx) =>
			Effect.gen(function* () {
				const heading: RelationSpec = {
					relation: "Reading",
					columns: reading.columns,
					slot: { kind: "none" },
					codes: kindCodes
				}
				/** A statement's columns: the heading's, in its order and in another. */
				const statements = Arr.map(
					[
						[
							{ name: "id", type: types.uuid },
							{ name: "value", type: types.numeric52 },
							{ name: "raw", type: types.float8 }
						],
						[
							{ name: "raw", type: types.float8 },
							{ name: "id", type: types.uuid },
							{ name: "value", type: types.numeric52 }
						]
					],
					(columns) => {
						const statement: RelationSpec = {
							relation: "Reading",
							columns: positionalColumns(columns),
							slot: { kind: "none" },
							codes: kindCodes
						}
						return { encode: arraysEncoder(statement), write: normalArray(statement) }
					}
				)
				const normalize = relationNormalizer(heading)
				/** An id in either case, so equal facts are spelled differently. */
				const fact: Gen<Reading> = (source) => {
					const id = source.draw(uuid(4))
					return {
						id: source.draw(element([id, Str.toUpperCase(id)])),
						value: source.draw(map(int(-9999, 9999), (n) => Decimal.of(`${n}e-3`))),
						raw: source.draw(element([0, -0, 1.5, Number.NaN]))
					}
				}
				yield* searched(
					ctx,
					explore(
						{
							oracle: { kind: "unstated" },
							suite: "unit/codec/recordset-1852797549",
							draw: drawn(array(fact, { min: 0, max: 12 })),
							literal: Formatter.format,
							coverage: noCoverage,
							kept: [],
							runs: 300,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(facts) =>
							Effect.sync(() => {
								const normal = succeeded(normalizedBy(normalize, facts))
								const byIdentity = new TupleMap<
									FactIdentity,
									{ readonly fact: { readonly [field: string]: unknown } }
								>()
								for (const e of normal.entries) {
									byIdentity.set(e.identity, { fact: e.fact })
								}
								const marked = normalFacts(byIdentity)
								for (const { encode, write } of statements) {
									const arrays = succeeded(encode(facts)).arrays
									assert.deepEqual<ReadonlyArray<string>>(
										Arr.map(arrays, (_, part) => textOfParam(succeeded(write(marked, part)))),
										arrays
									)
								}
							})
					)
				)
			})
	)

	it.effect(
		"encodes canonically whatever input spelling equal facts' numerics of no typmod took",
		(ctx) =>
			Effect.gen(function* () {
				const spec: RelationSpec = {
					relation: "Scaled",
					columns: positionalColumns([
						{ name: "k", type: types.int4 },
						{ name: "n", type: types.numeric }
					]),
					slot: { kind: "none" },
					codes: kindCodes
				}
				const encode = arraysEncoder(spec)
				const normalize = parameterNormalizer(spec)
				const spellings: Arr.NonEmptyReadonlyArray<string> = [
					"1",
					"1.0",
					"1.00",
					"1e0",
					"10",
					"1e1",
					"10.0",
					"-0",
					"0.000"
				]
				const fact: Gen<Scaled> = (source) => ({
					k: source.draw(int(0, 3)),
					n: Decimal.of(source.draw(element(spellings)))
				})
				/**
				 * One payload per k, spelled at random, so the distinct facts are exactly the drawn ones and most cases hold equal
				 * facts spelled differently.
				 */
				const caseGen: Gen<{
					readonly facts: ReadonlyArray<Scaled>
					readonly extra: ReadonlyArray<Scaled>
				}> = (source) => {
					const facts = nonEmpty(
						source.draw(uniqueArray(fact, (f) => f.k, { min: 1, max: 4 }, 20)),
						"the distinct facts"
					)
					const extra = source.draw(
						array(
							(again) => {
								const picked = again.draw(element(facts))
								const spelled = again.draw(
									element(
										nonEmpty(
											Arr.filter(spellings, (s) => Decimal.of(s).equals(picked.n)),
											"a spelling of the picked value"
										)
									)
								)
								return { k: picked.k, n: Decimal.of(spelled) }
							},
							{ min: 0, max: 8 }
						)
					)
					return { facts, extra }
				}
				yield* searched(
					ctx,
					explore(
						{
							oracle: { kind: "unstated" },
							suite: "unit/codec/recordset-1935892844",
							draw: drawn(
								(source) => [source.draw(caseGen), source.draw(int(0, 2 ** 31 - 1))] as const
							),
							literal: Formatter.format,
							coverage: noCoverage,
							kept: [],
							runs: 500,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						([{ facts, extra }, seed]) =>
							Effect.sync(() => {
								const all = [...facts, ...extra]
								const shuffled = Arr.map(
									Arr.sort(
										Arr.map(all, (fact, i) => ({ fact, r: (i * 2654435761 + seed) % 4294967296 })),
										Order.mapInput(Order.Number, (x: { readonly r: number }) => x.r)
									),
									(x) => x.fact
								)
								const first = succeeded(encode(all))
								const second = succeeded(encode(Arr.reverse([...shuffled])))
								assert.deepEqual(second.arrays, first.arrays)
								assert.equal(first.count, facts.length)
								const a = succeeded(normalize(all))
								const b = succeeded(normalize(shuffled))
								assert.deepEqual(b.rows, a.rows)
								assert.deepEqual(
									Arr.map(b.facts, (f) => asDecimal(f["n"]).toString()),
									Arr.map(a.facts, (f) => asDecimal(f["n"]).toString())
								)
							})
					)
				)
			})
	)

	it.effect(
		"writes one array literal per column that array_in reads back as the column's texts, whatever they hold",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/codec/arrays-literal",
						draw: drawn((source) => {
							const width = source.draw(int(0, 4))
							return [width, source.draw(cellRows(width))] as const
						}),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([width, rows]) =>
						Effect.sync(() => {
							const columns = Array.from({ length: width }, (_, i) => `f${i}`)
							const params = Arr.map(rows, (row) => Arr.map(row, paramText))
							const written = succeeded(arrayTexts("Input", columns, params, 2 ** 20))
							if (width === 0) {
								assert.deepEqual(written, [paramText(String(rows.length))])
								return
							}
							assert.equal(written.length, width)
							for (const [j, literal] of written.entries()) {
								assert.deepEqual(
									readArrayLiteral(literal),
									Arr.map(rows, (row) => defined(row[j])),
									`column ${j} of ${literal}`
								)
							}
						})
				)
			)
	)

	it.effect(
		"refuses a column whose literal would pass the string bound, naming it, and writes every literal within it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/codec/arrays-literal-bound",
						draw: drawn((source): BoundCase => {
							const width = source.draw(int(1, 4))
							return { width, rows: source.draw(cellRows(width)), by: source.draw(boundOffset) }
						}),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "each column's literal written with no bound, against the bound: refused exactly when one is longer, naming one that is"
						},
						coverage: required<LiteralFeature>(
							["far within the bound", "at the bound", "one past the bound", "far past the bound"],
							{ cases: 300, sense: notesOnly }
						),
						kept: [bracesPastTheBound],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ width, rows, by }, c) =>
						Effect.sync(() => {
							const columns = Array.from({ length: width }, (_, i) => `f${i}`)
							const params = Arr.map(rows, (row) => Arr.map(row, paramText))
							const whole = succeeded(arrayTexts("Input", columns, params, 2 ** 20))
							const longest = Arr.reduce(whole, 0, (n, literal) => Math.max(n, literal.length))
							const limit = Math.max(longest + by, 0)
							c.note(
								limit === longest
									? "at the bound"
									: limit === longest - 1
										? "one past the bound"
										: limit > longest
											? "far within the bound"
											: "far past the bound"
							)
							const bounded = arrayTexts("Input", columns, params, limit)
							if (longest <= limit) {
								assert.deepEqual(succeeded(bounded), whole)
								return
							}
							const bound = failed(bounded)
							assert.deepEqual(
								{ _tag: bound._tag, input: bound.input, limit: bound.limit },
								{ _tag: "LiteralBound", input: "Input", limit }
							)
							const at = Arr.findFirstIndex(columns, (column) => column === bound.column)
							assert.ok(Option.isSome(at), `the refusal names a column: ${bound.column}`)
							assert.ok(
								defined(whole[at.value]).length > limit,
								`${bound.column}'s literal passes the bound`
							)
						})
				)
			)
	)
})

/** One column of every carrier, and the contract and refinement forms, each with a generator of its host values. */
const everyType: ReadonlyArray<{
	readonly name: string
	readonly type: ScalarType
	readonly value: Gen<unknown>
}> = [
	{
		name: "text",
		type: types.text,
		/** Text PostgreSQL stores, no NUL and no lone surrogate, with array_in's syntax characters among it. */
		value: string(
			weighted([
				[2, element(['"', "\\", ",", "{", "}", " ", "N", "U", "L"])],
				[2, codePoint(0x20, 0x7e)],
				[1, codePoint(0xa0, 0xd7_ff)],
				[1, codePoint(0xe0_00, 0x10_ffff)]
			]),
			{ min: 0, max: 6 }
		)
	},
	{
		name: "pattern",
		type: scalarOf(f.regex("^[a-z ,]+$", "u"), {}),
		value: string(element(["a", "b", " ", ","]), { min: 1, max: 4 })
	},
	{ name: "uuid", type: types.uuid, value: uuid(4) },
	{ name: "kind", type: types.kind, value: element(["Manual", "Automatic", "Ünïcode"]) },
	{
		name: "numeric",
		type: types.numeric,
		value: map(int(-99999, 99999), (n) => Decimal.of(`${n}e-3`))
	},
	{
		name: "scaled",
		type: types.numeric52,
		value: map(int(-99999, 99999), (n) => Decimal.of(`${n}e-2`))
	},
	{
		name: "span4",
		type: types.range4,
		value: map(int(-1000, 1000), (start) => ({ start, end: start + 3 }))
	},
	{
		name: "span8",
		type: types.range8,
		value: map(int(-1000, 1000), (start) => ({ start: BigInt(start), end: BigInt(start) + 5n }))
	},
	{ name: "cents", type: types.cents, value: map(int(-1000, 1000), (n) => BigInt(n) * 7n) },
	{ name: "big", type: types.int8, value: map(int(-1000, 1000), (n) => BigInt(n) ** 3n) },
	{ name: "small", type: types.int2, value: int(-32768, 32767) },
	{ name: "whole", type: types.int4, value: int(-(2 ** 31), 2 ** 31 - 1) },
	{ name: "flag", type: types.bool, value: element([true, false]) },
	{
		name: "embedding",
		type: types.vector3,
		value: map(int(1, 1000), (n) => Vector.make(Float32Array.of(n / 8, -n, 0.5), 3))
	},
	{ name: "raw", type: types.float8, value: anyDouble },
	{
		name: "single",
		type: types.float4,
		value: element([0, -0, 1.5, -2.25, Number.NaN, Number.POSITIVE_INFINITY])
	},
	{ name: "price", type: types.money, value: map(int(-100000, 100000), (n) => Money.of(BigInt(n))) }
]

describe("the arrays of every field type", () => {
	it.effect(
		"carry each value's canonical text, which array_in reads back exactly, in the facts' canonical order",
		(ctx) =>
			Effect.gen(function* () {
				const spec: RelationSpec = {
					relation: "Every",
					columns: positionalColumns(Arr.map(everyType, ({ name, type }) => ({ name, type }))),
					slot: { kind: "none" },
					codes: kindCodes
				}
				const encode = arraysEncoder(spec)
				const normalize = relationNormalizer(spec)
				const factGen: Gen<Readonly<Record<string, unknown>>> = (source) =>
					Record.fromEntries(
						Arr.map(everyType, ({ name, value }) => [name, source.draw(value)] as const)
					)
				yield* searched(
					ctx,
					explore(
						{
							oracle: { kind: "unstated" },
							suite: "unit/codec/arrays-every-type",
							draw: drawn(array(factGen, { min: 0, max: 8 })),
							literal: Formatter.format,
							coverage: noCoverage,
							kept: [],
							runs: 200,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(facts) =>
							Effect.sync(() => {
								const normal = succeeded(normalizedBy(normalize, facts))
								const { arrays, count } = succeeded(encode(facts))
								assert.equal(count, normal.count)
								assert.equal(arrays.length, everyType.length)
								for (const [j, column] of everyType.entries()) {
									const codec = scalarCodec(column.type, kindCodes)
									assert.deepEqual(
										readArrayLiteral(defined(arrays[j])),
										Arr.map(normal.facts, (fact) => codec.text(fact[column.name])),
										`the ${column.name} column`
									)
								}
							})
					)
				)
			})
	)
})
