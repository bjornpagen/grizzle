/** What the properties of recordset.test.ts read: its spaces, models and helpers. */

import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import {
	array,
	codePoint,
	constant,
	element,
	finite,
	type Gen,
	int,
	map,
	string,
	uniqueArray,
	weighted
} from "@bjornpagen/testing/gen"
import type { Need } from "@bjornpagen/testing/property"
import type { Source } from "@bjornpagen/testing/source"
import { double, uuid } from "@bjornpagen/testing/values"
import { Array as Arr, Effect, Record, String as Str } from "effect"
import {
	normalArray,
	positionalColumns,
	relationNormalizer,
	type RelationSpec
} from "#compiler/codec/recordset.ts"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { maxStringLength } from "#compiler/core/canonical.ts"
import type { CodecFault } from "#compiler/core/errors.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { admitValue } from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { arraysEncoder } from "#test/support/arrays.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { codecTypes, kindCodes } from "#test/support/unit/codec/support.ts"

/** The relation of readings the normalization properties read: an id, a numeric(5,2) value and a raw double. */
const reading: RelationSpec = {
	relation: "Reading",
	columns: positionalColumns([
		{ name: "id", type: codecTypes.uuid },
		{ name: "value", type: codecTypes.numeric52 },
		{ name: "raw", type: codecTypes.float8 }
	]),
	slot: { kind: "slot", name: "readings" },
	codes: kindCodes
}

/**
 * A member planted among valid ones, and the refusal docs/errors-and-concurrency.md "Errors and outcomes" gives it: an EncodingFailure naming the slot, and
 * the field where there is one, never the value.
 */
/** A scaled fact: a key and a numeric whose display scale varies. */
interface Scaled {
	readonly k: number
	readonly n: Decimal
}

export const fieldsOfReading = ["id", "value", "raw"] as const

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

/**
 * A value of numeric(5,2), a reading's value: a count of hundredths, which the type holds as it is. A value PostgreSQL's
 * coercion would round is no value of the type: the input boundary refuses it (numericScale).
 */
const hundredths: Gen<Decimal> = map(int(-99999, 99999), (n) => Decimal.of(`${n}e-2`))

/** The reading of an id: its value and its raw double drawn. */
const readingOf =
	(id: string): Gen<Reading> =>
	(source) => ({
		id,
		value: source.draw(hundredths),
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
export type LiteralFeature =
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

/** A reading's fields, as `fieldsOfReading` names them. */
type ReadingField = (typeof fieldsOfReading)[number]

/**
 * What a planted member is as a whole: a fact, NULL, undefined, a number, an array, a record of another prototype than
 * a plain object's, or a fact holding a key past its heading's.
 */
const wholePlants = [
	"a fact",
	"a NULL member",
	"an undefined member",
	"a number",
	"an array",
	"a record of another prototype",
	"a key past its heading's"
] as const
type WholePlant = (typeof wholePlants)[number]

/**
 * What a planted member's field holds: its value, as a data property or through a getter, or a fault: no such field,
 * NULL, undefined, a value its carrier refuses, or a getter that throws.
 */
const fieldPlants = [
	"its value",
	"its value through a getter",
	"no such field",
	"NULL",
	"undefined",
	"a value its carrier refuses",
	"a getter that throws"
] as const
type FieldPlant = (typeof fieldPlants)[number]

/** A member with any number of faults planted: as a whole, at each field, and whether a valid member comes before it. */
export interface PlantedMember {
	readonly whole: WholePlant
	readonly fields: Readonly<Record<ReadingField, FieldPlant>>
	readonly after: "alone" | "after a valid member"
}

/** Every planted member: each whole, each field's every plant, alone and after a valid member. */
export const plantedMembers: Gen<PlantedMember> = (source) => ({
	whole: source.draw(element(wholePlants)),
	fields: {
		id: source.draw(element(fieldPlants)),
		value: source.draw(element(fieldPlants)),
		raw: source.draw(element(fieldPlants))
	},
	after: source.draw(element(["alone", "after a valid member"] as const))
})

/** A valid reading, which each field of a planted member holds unless its plant says otherwise. */
const validReading: Reading = {
	id: "00000000-0000-4000-8000-000000000001",
	value: Decimal.of("1.25"),
	raw: 0.5
}

/** A valid reading of another id, the member a planted one may follow. */
export const otherReading: Reading = { ...validReading, id: "00000000-0000-4000-8000-000000000002" }

/** A value each field's carrier refuses: a number for a uuid, a JavaScript number for a numeric, a text for a double. */
const refusedValues: Readonly<Record<ReadingField, unknown>> = { id: 42, value: 1.5, raw: "x" }

/** The fault a field's carrier refuses its refused value by, as the field's one admission gives it (admitValue). */
const refusedFaults: Readonly<Record<ReadingField, CodecFault>> = Record.map(
	{ id: codecTypes.uuid, value: codecTypes.numeric52, raw: codecTypes.float8 },
	(type, field) => {
		const admitted = admitValue(carrierSpecOf(type, kindCodes), refusedValues[field])
		return admitted.ok
			? assert.fail(`${field}'s carrier refuses its refused value`)
			: admitted.error
	}
)

/** A record of another prototype than a plain object's, which a read refuses whole. */
const otherPrototype = (): object => {
	const record = {}
	Reflect.setPrototypeOf(record, { inherited: true })
	return record
}

/**
 * `member` with each field of a reading set on it, each plant's way, in its heading's order, each getter counting its
 * runs in `reads`.
 */
const withFields = (
	member: object,
	plant: PlantedMember,
	reads: Record<ReadingField, number>
): object => {
	for (const field of fieldsOfReading) {
		const value = validReading[field]
		const plain = (held: unknown) =>
			Object.defineProperty(member, field, { value: held, enumerable: true, writable: true })
		switch (plant.fields[field]) {
			case "its value":
				plain(value)
				break
			case "its value through a getter":
				Object.defineProperty(member, field, {
					enumerable: true,
					get: () => {
						reads[field] += 1
						return value
					}
				})
				break
			case "no such field":
				break
			case "NULL":
				plain(null)
				break
			case "undefined":
				plain(undefined)
				break
			case "a value its carrier refuses":
				plain(refusedValues[field])
				break
			case "a getter that throws":
				Object.defineProperty(member, field, {
					enumerable: true,
					get: () => {
						reads[field] += 1
						throw new Error(`a planted getter of ${field}`)
					}
				})
				break
		}
	}
	return member
}

/**
 * A planted member as a caller states it, and how many times each field's getter has run: its fields set in its
 * heading's order, each plant's way, under the prototype its whole names.
 */
export const plantedValue = (
	plant: PlantedMember
): { readonly member: unknown; readonly reads: Readonly<Record<ReadingField, number>> } => {
	const reads: Record<ReadingField, number> = { id: 0, value: 0, raw: 0 }
	switch (plant.whole) {
		case "a NULL member":
			return { member: null, reads }
		case "an undefined member":
			return { member: undefined, reads }
		case "a number":
			return { member: 7, reads }
		case "an array":
			return { member: [], reads }
		case "a fact":
			return { member: withFields({}, plant, reads), reads }
		case "a record of another prototype":
			return { member: withFields(otherPrototype(), plant, reads), reads }
		case "a key past its heading's":
			return {
				member: Object.defineProperty(withFields({}, plant, reads), "extra", {
					value: 1,
					enumerable: true
				}),
				reads
			}
	}
}

/** A refusal as the rule names it: its fault, and its field, none for the member as a whole. */
export interface RuledRefusal {
	readonly fault: CodecFault
	readonly field: ReadingField | undefined
}

/** A reading's fields in the order the rule reads them: by name. */
const byName: ReadonlyArray<ReadingField> = Arr.sort(fieldsOfReading, Str.Order)

/** A field plant's fault, none for a field that holds its value. */
const fieldFault = (field: ReadingField, plant: FieldPlant): CodecFault | undefined => {
	switch (plant) {
		case "its value":
		case "its value through a getter":
			return undefined
		case "no such field":
		case "a getter that throws":
			return "factShape"
		case "NULL":
		case "undefined":
			return "nullValue"
		case "a value its carrier refuses":
			return refusedFaults[field]
	}
}

/**
 * What the rule of refusal reads of a planted member: its refusal, the first fault met reading it once, the member as a
 * whole first (NULL or undefined is nullValue; anything but a plain record, or one of another count of own keys than
 * its heading's three, is factShape), then each field in name order, the first fault there; and the fields the read
 * reaches, each read once, the read stopping at the first fault.
 */
export const ruleOf = (
	plant: PlantedMember
): { readonly refusal: RuledRefusal | undefined; readonly reached: ReadonlySet<ReadingField> } => {
	const reached = new Set<ReadingField>()
	switch (plant.whole) {
		case "a NULL member":
		case "an undefined member":
			return { refusal: { fault: "nullValue", field: undefined }, reached }
		case "a number":
		case "an array":
		case "a record of another prototype":
			return { refusal: { fault: "factShape", field: undefined }, reached }
		case "a fact":
		case "a key past its heading's":
			break
	}
	const keys =
		Arr.filter(fieldsOfReading, (field) => plant.fields[field] !== "no such field").length +
		(plant.whole === "a key past its heading's" ? 1 : 0)
	if (keys !== fieldsOfReading.length) {
		return { refusal: { fault: "factShape", field: undefined }, reached }
	}
	for (const field of byName) {
		reached.add(field)
		const fault = fieldFault(field, plant.fields[field])
		if (fault !== undefined) {
			return { refusal: { fault, field }, reached }
		}
	}
	return { refusal: undefined, reached }
}

/** What a planted member's case reaches: which step of the rule refused it, over which other faults, and its getters. */
export type PlantFeature =
	| "admitted"
	| "a NULL member"
	| "refused as a whole over a field's NULL"
	| "refused at a missing field its count hides"
	| "a field's fault over a later field's NULL"
	| "a NULL over a later field's other fault"
	| "the first of two NULLs by name"
	| "a getter run once"
	| "a getter the read stops before"
	| "a throwing getter refused"

export const plantFeatures: Arr.NonEmptyReadonlyArray<PlantFeature> = [
	"admitted",
	"a NULL member",
	"refused as a whole over a field's NULL",
	"refused at a missing field its count hides",
	"a field's fault over a later field's NULL",
	"a NULL over a later field's other fault",
	"the first of two NULLs by name",
	"a getter run once",
	"a getter the read stops before",
	"a throwing getter refused"
]

/** The features of a planted member, refused by `refusal` and read as far as `reached`. */
export const plantFeaturesOf = (
	plant: PlantedMember,
	refusal: RuledRefusal | undefined,
	reached: ReadonlySet<ReadingField>
): ReadonlyArray<PlantFeature> => {
	const faultAt = (field: ReadingField) => fieldFault(field, plant.fields[field])
	const after = (field: ReadingField) => Arr.filter(byName, (other) => Str.Order(other, field) > 0)
	const getters = Arr.filter(
		fieldsOfReading,
		(field) => plant.fields[field] === "its value through a getter"
	)
	const features: Array<PlantFeature> = []
	if (Arr.some(getters, (field) => reached.has(field))) {
		features.push("a getter run once")
	}
	if (Arr.some(getters, (field) => !reached.has(field))) {
		features.push("a getter the read stops before")
	}
	if (refusal === undefined) {
		return [...features, "admitted"]
	}
	const { field } = refusal
	if (field === undefined) {
		const isNullMember = plant.whole === "a NULL member" || plant.whole === "an undefined member"
		return isNullMember
			? [...features, "a NULL member"]
			: Arr.some(fieldsOfReading, (f) => faultAt(f) === "nullValue")
				? [...features, "refused as a whole over a field's NULL"]
				: features
	}
	const later = Arr.map(after(field), faultAt)
	if (refusal.fault === "nullValue") {
		if (Arr.contains(later, "nullValue")) {
			features.push("the first of two NULLs by name")
		}
		if (Arr.some(later, (fault) => fault !== undefined && fault !== "nullValue")) {
			features.push("a NULL over a later field's other fault")
		}
		return features
	}
	if (Arr.contains(later, "nullValue")) {
		features.push("a field's fault over a later field's NULL")
	}
	if (plant.fields[field] === "no such field") {
		features.push("refused at a missing field its count hides")
	}
	if (plant.fields[field] === "a getter that throws") {
		features.push("a throwing getter refused")
	}
	return features
}

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
			{ name: "id", type: codecTypes.uuid },
			{ name: "value", type: codecTypes.numeric52 },
			{ name: "raw", type: codecTypes.float8 }
		],
		[
			{ name: "raw", type: codecTypes.float8 },
			{ name: "id", type: codecTypes.uuid },
			{ name: "value", type: codecTypes.numeric52 }
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
		{ name: "k", type: codecTypes.int4 },
		{ name: "n", type: codecTypes.numeric }
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
		type: codecTypes.text,
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
	{ name: "uuid", type: codecTypes.uuid, value: uuid(4) },
	{ name: "kind", type: codecTypes.kind, value: element(["Manual", "Automatic", "Ünïcode"]) },
	{
		name: "numeric",
		type: codecTypes.numeric,
		value: map(int(-99999, 99999), (n) => Decimal.of(`${n}e-3`))
	},
	{
		name: "scaled",
		type: codecTypes.numeric52,
		value: hundredths
	},
	{
		name: "span4",
		type: codecTypes.range4,
		value: map(int(-1000, 1000), (start) => ({ start, end: start + 3 }))
	},
	{
		name: "span8",
		type: codecTypes.range8,
		value: map(int(-1000, 1000), (start) => ({ start: BigInt(start), end: BigInt(start) + 5n }))
	},
	{ name: "cents", type: codecTypes.cents, value: map(int(-1000, 1000), (n) => BigInt(n) * 7n) },
	{ name: "big", type: codecTypes.int8, value: map(int(-1000, 1000), (n) => BigInt(n) ** 3n) },
	{ name: "small", type: codecTypes.int2, value: int(-32768, 32767) },
	{ name: "whole", type: codecTypes.int4, value: int(-(2 ** 31), 2 ** 31 - 1) },
	{ name: "flag", type: codecTypes.bool, value: element([true, false]) },
	{
		name: "embedding",
		type: codecTypes.vector3,
		value: map(int(1, 1000), (n) => Vector.make(Float32Array.of(n / 8, -n, 0.5), 3))
	},
	{ name: "raw", type: codecTypes.float8, value: anyDouble },
	{
		name: "single",
		type: codecTypes.float4,
		value: element([0, -0, 1.5, -2.25, Number.NaN, Number.POSITIVE_INFINITY])
	},
	{
		name: "price",
		type: codecTypes.money,
		value: map(int(-100000, 100000), (n) => Money.of(BigInt(n)))
	}
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

/** What the search built once before its cases (normalize), now once per worker: every case on it reads them. */
export const normalizeNeed = {
	key: "test/unit/codec/recordset.fixtures.ts normalizeNeed",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.sync(() => {
		const normalize = relationNormalizer(reading)
		return Effect.succeed(normalize)
	})
} as const satisfies Need<unknown>

/** What the search built once before its cases (encode), now once per worker: every case on it reads them. */
export const encodeNeed = {
	key: "test/unit/codec/recordset.fixtures.ts encodeNeed",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.sync(() => {
		const encode = arraysEncoder(reading)
		return Effect.succeed(encode)
	})
} as const satisfies Need<unknown>

/** A relation of two texts, which a fact past the longest string fills. */
export const notesHeading: RelationSpec = {
	relation: "Note",
	columns: positionalColumns([
		{ name: "a", type: codecTypes.text },
		{ name: "b", type: codecTypes.text }
	]),
	slot: { kind: "slot", name: "notes" },
	codes: kindCodes
}

/**
 * A text whose JSON string literal is longer than the longest string V8 holds (core/canonical.ts maxStringLength):
 * U+0001 over and over, each unit six of the literal's (`\u0001`), one string shared by every case and field that holds
 * it, so a fact of it costs its one allocation.
 */
export const pastTheBound: string = Str.repeat(Math.ceil(maxStringLength / 6) + 1)("\u0001")

/** Where a case puts the text past the bound: in one field of a note, or in both. */
export const pastTheBoundBox = finite((source) => ({
	fields: source.draw(element(["a", "both"] as const)),
	copies: source.draw(int(1, 2))
}))
