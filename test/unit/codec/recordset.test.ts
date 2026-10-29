import { describe, it } from "@effect/vitest"
import { drawn, explore, sketched } from "@grizzle/testing/explore"
import { features, noFeatures } from "@grizzle/testing/features"
import {
	array,
	codePoint,
	element,
	type Gen,
	int,
	map,
	string,
	uniqueArray,
	weighted
} from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { double, uuid } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Option,
	Order,
	Record,
	Schema,
	String as Str
} from "effect"
import {
	keyedColumns,
	normalEncoder,
	normalForm,
	normalRows,
	positionalColumns,
	type RelationSpec,
	recordsetEncoder,
	recordsetJson,
	relationNormalizer
} from "#compiler/codec/recordset.ts"
import { EncodingFailure } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { assert, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { decodeJson } from "#test/support/json.ts"
import { types } from "#test/unit/codec/support.ts"
import { asDecimal } from "#test/unit/codec/values.ts"

/**
 * Relation inputs: the host codec owns the set property and the null ban, deduplicating by fact identity after native
 * coercion and encoding canonically. The host collects a Stream member up to recordsetMaxRows before it normalizes it
 * (adapter/reader/params.ts). Deduplication is the pg relation suite's, against
 * PostgreSQL's own DISTINCT on generated cases (test/pg/codec/relation.test.ts); here, the refusals and the canonical
 * encoding PostgreSQL cannot see.
 */
const decodeJsonArray = decodeJson(Schema.Array(Schema.Unknown))
/** A recordset of text cells: one object per row, its wire names to its texts. */
const decodeRecordset = decodeJson(Schema.Array(Schema.Record(Schema.String, Schema.String)))

const reading: RelationSpec = {
	relation: "Reading",
	columns: positionalColumns([
		{ name: "id", type: types.uuid },
		{ name: "value", type: types.numeric52 },
		{ name: "raw", type: types.float8 }
	]),
	slot: { kind: "slot", name: "readings" }
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
							suite: "unit/codec/recordset-refusals",
							draw: drawn((source) => ({
								facts: source.draw(uniqueArray(readingFact, (r) => r.id, { min: 0, max: 4 }, 20)),
								at: source.draw(int(0, 2 ** 31 - 1)),
								plant: source.draw(element(plants)),
								field: source.draw(element(fieldsOfReading)),
								bad: source.draw(readingFact)
							})),
							literal: Formatter.format,
							features: features<`plant ${Plant}`>(Arr.map(plants, (p) => `plant ${p}` as const)),
							kept: [],
							/** Six plants, each a sixth of the cases: 300 cases reach every one many times over. */
							runs: 300,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							steering: { kind: "none" },
							caseHang: Duration.minutes(2)
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
								const result = normalize(members)
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
					slot: { kind: "slot", name: "slots" }
				}
				const normalize = relationNormalizer(spec)
				yield* searched(
					ctx,
					explore(
						{
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
							features: features<"fixed width" | "other width">(["fixed width", "other width"]),
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
							steering: { kind: "none" },
							caseHang: Duration.minutes(2)
						},
						({ start, width }, c) =>
							Effect.sync(() => {
								const result = normalize([{ fixed: { start, end: start + width } }])
								if (width === 15) {
									c.note("fixed width")
									assert.deepEqual(succeeded(result).rows, [[`[${start},${start + 15})`]])
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

	it.effect("encodes canonically: the same set in any order gives byte-identical JSON", (ctx) =>
		Effect.gen(function* () {
			const encode = recordsetEncoder(reading)
			yield* searched(
				ctx,
				explore(
					{
						suite: "unit/codec/recordset-1919247219",
						draw: drawn(
							(source) =>
								[
									source.draw(uniqueArray(readingFact, (f) => f.id, { min: 0, max: 20 }, 20)),
									source.draw(int(0, 2 ** 31 - 1))
								] as const
						),
						literal: Formatter.format,
						features: noFeatures,
						kept: [],
						runs: 500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
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
							assert.equal(decodeJsonArray(first.json).length, facts.length)
						})
				)
			)
		})
	)

	it.effect(
		"encodes facts normalized on the host as it encodes the raw input, without normalizing them again",
		(ctx) =>
			Effect.gen(function* () {
				const heading: RelationSpec = {
					relation: "Reading",
					columns: reading.columns,
					slot: { kind: "none" }
				}
				/** A statement's encoder over the same heading: its own column order and wire names. */
				const statement: RelationSpec = {
					relation: "Reading",
					columns: keyedColumns([
						{ name: "raw", type: types.float8, key: "x" },
						{ name: "id", type: types.uuid, key: "y" },
						{ name: "value", type: types.numeric52, key: "z" }
					]),
					slot: { kind: "none" }
				}
				const normalize = relationNormalizer(heading)
				const again = relationNormalizer(statement)
				const encode = recordsetEncoder(statement)
				const rows = normalRows(statement)
				const encodeNormal = normalEncoder(statement)
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
							suite: "unit/codec/recordset-1852797549",
							draw: drawn(array(fact, { min: 0, max: 12 })),
							literal: Formatter.format,
							features: noFeatures,
							kept: [],
							runs: 300,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							steering: { kind: "none" },
							caseHang: Duration.minutes(2)
						},
						(facts) =>
							Effect.sync(() => {
								const normal = succeeded(normalize(facts))
								const marked = normalForm(heading)(normal.entries)
								const written = succeeded(rows(marked))
								assert.equal(written.facts, marked.facts)
								assert.deepEqual(written.rows, succeeded(again(facts)).rows)
								assert.equal(succeeded(encodeNormal(marked)).json, succeeded(encode(facts)).json)
							})
					)
				)
			})
	)

	it.effect("encodes canonically when equal facts differ in bare numeric display scale", (ctx) =>
		Effect.gen(function* () {
			const spec: RelationSpec = {
				relation: "Scaled",
				columns: positionalColumns([
					{ name: "k", type: types.int4 },
					{ name: "n", type: types.numeric }
				]),
				slot: { kind: "none" }
			}
			const encode = recordsetEncoder(spec)
			const normalize = relationNormalizer(spec)
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
										Arr.filter(
											spellings,
											(s) => Decimal.of(s).identityText() === picked.n.identityText()
										),
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
						suite: "unit/codec/recordset-1935892844",
						draw: drawn(
							(source) => [source.draw(caseGen), source.draw(int(0, 2 ** 31 - 1))] as const
						),
						literal: Formatter.format,
						features: noFeatures,
						kept: [],
						runs: 500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
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
							assert.equal(second.json, first.json)
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
			assert.equal(
				succeeded(
					encode([
						{ k: 1, n: Decimal.of("1.00") },
						{ k: 1, n: Decimal.of("1.0") }
					])
				).json,
				'[{"c1":"1","c2":"1.0"}]'
			)
			assert.equal(
				succeeded(
					encode([
						{ k: 1, n: Decimal.of("1.0") },
						{ k: 1, n: Decimal.of("1.00") }
					])
				).json,
				'[{"c1":"1","c2":"1.0"}]'
			)
		})
	)

	it.effect("writes the recordset JSON of the same rows as objects", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/codec/recordset-1",
					draw: drawn((source) => {
						const wires = source.draw(
							map(
								uniqueArray(
									string(codePoint(0x20, 0x7e), { min: 0, max: 10 }),
									(item) => item,
									{ min: 0, max: 4 },
									20
								),
								(names) => Arr.map(names, (name) => `c${name}`)
							)
						)
						return [
							wires,
							source.draw(
								array(
									array(string(codePoint(0x20, 0x7e), { min: 0, max: 10 }), {
										min: wires.length,
										max: wires.length
									}),
									{ min: 0, max: 4 }
								)
							)
						] as const
					}),
					literal: Formatter.format,
					features: noFeatures,
					kept: [],
					runs: 100,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					steering: { kind: "none" },
					caseHang: Duration.minutes(2)
				},
				([wires, rows]) =>
					Effect.sync(() => {
						const objects = Arr.map(rows, (row) =>
							Record.fromEntries(Arr.map(row, (cell, i) => [defined(wires[i]), cell]))
						)
						assert.deepEqual(decodeRecordset(recordsetJson(wires, rows)), objects)
					})
			)
		)
	)
})
