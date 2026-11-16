/** What the properties of recordset.test.ts read: its spaces, models and helpers. */

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
} from "@bjornpagen/testing/gen"
import type { Source } from "@bjornpagen/testing/source"
import { double, uuid } from "@bjornpagen/testing/values"
import { Array as Arr, Record, String as Str } from "effect"
import { normalArray, positionalColumns, type RelationSpec } from "#compiler/codec/recordset.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { arraysEncoder } from "#test/support/arrays.ts"
import { nonEmpty } from "#test/support/assert.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { kindCodes, types } from "#test/unit/codec/support.ts"

/** The relation of readings the normalization properties read: an id, a numeric(5,2) value and a raw double. */
export const reading: RelationSpec = {
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

export type Plant =
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
export const fieldsOfReading = ["id", "value", "raw"] as const

/** A reading as a caller states it. */
interface Reading {
	readonly id: string
	readonly value: Decimal
	readonly raw: number
}

/** Every finite double, and now and then NaN or an infinity, as a float8 column holds. */
export const anyDouble = weighted([
	[9, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
	[1, element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])]
])

/**
 * A value of numeric(5,2), a reading's value: a count of hundredths, which the type holds as it is. A value PostgreSQL's
 * coercion would round is no value of the type: the input boundary refuses it (numericScale).
 */
export const hundredths: Gen<Decimal> = map(int(-99999, 99999), (n) => Decimal.of(`${n}e-2`))

/** The reading of an id: its value and its raw double drawn. */
const readingOf =
	(id: string): Gen<Reading> =>
	(source) => ({
		id,
		value: source.draw(hundredths),
		raw: source.draw(anyDouble)
	})

/** A reading of a drawn id. */
const readingFact: Gen<Reading> = (source) => source.draw(readingOf(source.draw(uuid(4))))

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
export const cellRows = (width: number): Gen<ReadonlyArray<ReadonlyArray<string>>> =>
	array(array(arrayCell, { min: width, max: width }), { min: 0, max: 6 })

/** Where a bound falls against the longest literal: the situations its count of the literal's length must get right. */
export type LiteralFeature =
	| "far within the bound"
	| "at the bound"
	| "one past the bound"
	| "far past the bound"

/** How far the bound sits from the longest literal's length. */
export const boundOffset: Gen<number> = weighted([
	[2, int(2, 40)],
	[3, constant(0)],
	[3, constant(-1)],
	[2, int(-40, -2)]
])

/** A bound case: the columns, their rows' texts, and how far the bound sits from the longest literal's length. */
export interface BoundCase {
	readonly width: number
	readonly rows: ReadonlyArray<ReadonlyArray<string>>
	readonly by: number
}

/** A refusal case: a set of readings, where a planted member goes among them, the plant, its field and its reading. */
export const refusalCases = (source: Source) => ({
	facts: source.draw(uniqueArray(uuid(4), readingOf, { min: 0, max: 4 })),
	at: source.draw(int(0, 2 ** 31 - 1)),
	plant: source.draw(element(plants)),
	field: source.draw(element(fieldsOfReading)),
	bad: source.draw(readingFact)
})

/** Every plant's situation. */
export const plantSituations: ReadonlyArray<`plant ${Plant}`> = Arr.map(
	plants,
	(p) => `plant ${p}` as const
)

/** A relation of one span column of the fixed width 15. */
export const slotSpec: RelationSpec = {
	relation: "Slot",
	columns: positionalColumns([{ name: "fixed", type: scalarOf(f.span(f.integer, 15n), {}) }]),
	slot: { kind: "slot", name: "slots" },
	codes: kindCodes
}

/** A span case: its start, and a width of 1 to 30. */
export const spanCases: Gen<{ readonly start: number; readonly width: number }> = (source) => ({
	start: source.draw(int(-1000, 1000)),
	width: source.draw(int(1, 30))
})

/** A set of up to twenty readings of distinct ids, and a seed its reordering is drawn from. */
export const orderedSets: Gen<readonly [ReadonlyArray<Reading>, number]> = (source) =>
	[
		source.draw(uniqueArray(uuid(4), readingOf, { min: 0, max: 20 })),
		source.draw(int(0, 2 ** 31 - 1))
	] as const

/** The readings' heading, slotless. */
export const readingHeading: RelationSpec = {
	relation: "Reading",
	columns: reading.columns,
	slot: { kind: "none" },
	codes: kindCodes
}
/** A statement's columns: the heading's, in its order and in another. */
export const statements = Arr.map(
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

/** An id in either case, so equal facts are spelled differently. */
const spelledReading: Gen<Reading> = (source) => {
	const id = source.draw(uuid(4))
	return {
		id: source.draw(element([id, Str.toUpperCase(id)])),
		value: source.draw(hundredths),
		raw: source.draw(element([0, -0, 1.5, Number.NaN]))
	}
}

/** Up to twelve readings, an id in either case. */
export const spelledReadings = array(spelledReading, { min: 0, max: 12 })

/** A relation of an int4 key and a numeric of no typmod. */
export const scaledSpec: RelationSpec = {
	relation: "Scaled",
	columns: positionalColumns([
		{ name: "k", type: types.int4 },
		{ name: "n", type: types.numeric }
	]),
	slot: { kind: "none" },
	codes: kindCodes
}

/** Spellings of a numeric: equal values written otherwise. */
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
/** The fact of a key, its numeric spelled at random. */
const factOf =
	(k: number): Gen<Scaled> =>
	(source) => ({
		k,
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
		source.draw(uniqueArray(int(0, 3), factOf, { min: 1, max: 4 })),
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

/** A spelling case, and a seed its reordering is drawn from. */
export const spelledSets = (source: Source) =>
	[source.draw(caseGen), source.draw(int(0, 2 ** 31 - 1))] as const

/** A literal case: a width of up to four columns, and up to six rows of cells. */
export const literalCases = (source: Source) => {
	const width = source.draw(int(0, 4))
	return [width, source.draw(cellRows(width))] as const
}

/** A bound case: one to four columns, their rows, and how far the bound sits from the longest literal. */
export const boundCases = (source: Source): BoundCase => {
	const width = source.draw(int(1, 4))
	return { width, rows: source.draw(cellRows(width)), by: source.draw(boundOffset) }
}

/** One column of every carrier, and the contract and refinement forms, each with a generator of its host values. */
export const everyType: ReadonlyArray<{
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
		value: hundredths
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

/** A relation of one column of every field type. */
export const everySpec: RelationSpec = {
	relation: "Every",
	columns: positionalColumns(Arr.map(everyType, ({ name, type }) => ({ name, type }))),
	slot: { kind: "none" },
	codes: kindCodes
}

/** A fact of every field type. */
const everyFact: Gen<Readonly<Record<string, unknown>>> = (source) =>
	Record.fromEntries(Arr.map(everyType, ({ name, value }) => [name, source.draw(value)] as const))

/** Up to eight facts of every field type. */
export const everyFacts = array(everyFact, { min: 0, max: 8 })
