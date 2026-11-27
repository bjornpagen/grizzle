/** What the properties of wild.test.ts read: its spaces, models and helpers. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	bytes as byteValues,
	codePoint,
	element,
	type Gen,
	int,
	map,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import {
	type Drawn,
	type DrawnFeature,
	lsw,
	type Stale,
	type Wild,
	wild,
	WILD_KINDS,
	type WildKind
} from "@bjornpagen/testing/lsw"
import { bigint, double, float, uuid } from "@bjornpagen/testing/values"
import { Array as Arr, DateTime, Option, Record } from "effect"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { int4Max } from "#compiler/core/canonical.ts"
import { sha256Octets } from "#compiler/core/digest.ts"
import type { CodecFault, ValueFault } from "#compiler/core/errors.ts"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import type { ParamText } from "#compiler/core/wire.ts"
import { int4Min, int8Max, int8Min } from "#compiler/ir/carriers.ts"
import { decodeScalarType } from "#compiler/ir/scalar-shape.ts"
import { type Carrier, capabilitySet, Roster, type ScalarType } from "#compiler/ir/scalar.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { isValueFault } from "#compiler/scalar/values/fault.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { succeeded } from "#test/support/assert.ts"
import { cidrValues, inetValues } from "#test/support/net-values.ts"
import { kindCodes } from "#test/unit/codec/support.ts"
import { printed, raw, stored } from "#test/unit/values/search-document.fixtures.ts"

/** The codec's own refusal words beside the value carriers' ValueFault words (core/errors.ts CodecFault). */
const codecWords: ReadonlySet<string> = new Set<Exclude<CodecFault, ValueFault>>(["nullValue"])

/** Whether an encoder's refusal is a codec fault word, never a value or a thrown error. */
export const isCodecFault = (value: unknown): value is CodecFault =>
	isValueFault(value) || (typeof value === "string" && codecWords.has(value))

interface Written {
	readonly label: string
	readonly type: unknown
	readonly live: Gen<unknown>
}

/** A descriptor as the decoder admitted it, and the Live values of its host type. */
interface Carried {
	readonly label: string
	readonly type: ScalarType
	readonly live: Gen<unknown>
}

export const decoded = (written: Written): Carried => {
	const type = decodeScalarType(written.type)
	if (!type.ok) {
		throw new Error(
			`${written.label}: the decoder refuses a hand-written descriptor: ${type.error.message}`
		)
	}
	return { label: written.label, type: type.value, live: written.live }
}

const caps = capabilitySet(["storage", "equality"])

const int32 = int(int4Min, int4Max)
const int64 = bigint(int8Min, int8Max)

/**
 * A numeric(precision, scale) descriptor and its Live values, both from the one typmod: a signed count of 10^-scale
 * units below 10^precision in magnitude, which the typmod holds as it is, so the input boundary admits it exactly
 * (scalar/values/decimal.ts parseNumeric). A value PostgreSQL's coercion would round is no Live value: the boundary
 * refuses it (numericScale), and test/pg/values/numeric.test.ts holds that against PostgreSQL.
 */
const numericUnder = (precision: number, scale: number): Written => {
	const units = 10n ** BigInt(precision)
	return {
		label: `numeric(${precision},${scale})`,
		type: { carrier: "numeric", typmod: { precision, scale }, caps },
		live: map(bigint(1n - units, units - 1n), (count) => Decimal.of(`${count}e${-scale}`))
	}
}

/** A span over int4 endpoints, built ordered: a start below int4's greatest, then an end past it. */
const spans4: Gen<unknown> = (source) => {
	const start = source.draw(int(int4Min, int4Max - 1))
	return { start, end: source.draw(int(start + 1, int4Max)) }
}

/** A span over int8 endpoints, built ordered: a start below int8's greatest, then an end past it. */
const spans8: Gen<unknown> = (source) => {
	const start = source.draw(bigint(int8Min, int8Max - 1n))
	return { start, end: source.draw(bigint(start + 1n, int8Max)) }
}

/**
 * A calendar date's ISO 8601 text: a day from 0001-01-01 to 9999-12-31, drawn as a count of days past the first, which
 * Effect's DateTime carries over its months and years by the proleptic Gregorian calendar and formats at its UTC date.
 */
const dateAt = (days: number): string =>
	DateTime.formatIsoDateUtc(DateTime.makeUnsafe({ year: 1, month: 1, day: 1 + days }))

/** The days past 0001-01-01 of the calendar's last date, 9999-12-31. */
const lastDay = 3_652_058

const days = int(0, lastDay)

const calendarDates: Gen<unknown> = map(days, dateAt)

/** An IPv4 or IPv6 address's text with a mask, its address cleared past the mask for a cidr. */
/** A span of days, built ordered: a start before the last day, then a later end, each its calendar date's text. */
const dateSpans: Gen<unknown> = (source) => {
	const start = source.draw(int(0, lastDay - 1))
	return { start: dateAt(start), end: dateAt(source.draw(int(start + 1, lastDay))) }
}

const handles = ["Manual", "Automatic", "Ünïcode"] as const

/** The roster a closed id and a set are over: Kind, of the three handles. */
const kind = Roster.of(succeeded(parseDeclaredName("Kind")), "ordered", handles)

/** The largest finite float32. */
const floatMax = Math.fround(3.4028234663852886e38)

/** A float carrier's values: finite ones, and now and then NaN or an infinity, which the carrier holds too. */
const withNonFinite = (finite: Gen<number>): Gen<number> =>
	weighted([
		[9, finite],
		[1, element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])]
	])

/**
 * Every carrier with its descriptors: plain, under a typmod, a contract, a fixed width, a roster or an exact value's
 * digit bound. The table is keyed by carrier, so a new carrier must be listed.
 */
export const written: { readonly [C in Carrier]: Arr.NonEmptyReadonlyArray<Written> } = {
	int2: [
		{
			label: "int2",
			type: { carrier: "int2", caps },
			live: int(-32768, 32767)
		}
	],
	int4: [{ label: "int4", type: { carrier: "int4", caps }, live: int32 }],
	int8: [
		{ label: "int8", type: { carrier: "int8", caps }, live: int64 },
		{
			label: "contract over int8",
			type: {
				carrier: "int8",
				contract: { name: "Cents", base: { carrier: "int8", caps }, facts: [] }
			},
			live: int64
		}
	],
	numeric: [numericUnder(36, 6), numericUnder(7, 2), numericUnder(5, -2)],
	float4: [
		{
			label: "float4",
			type: { carrier: "float4", caps },
			live: withNonFinite(float(-floatMax, floatMax))
		}
	],
	float8: [
		{
			label: "float8",
			type: { carrier: "float8", caps },
			live: withNonFinite(double(-Number.MAX_VALUE, Number.MAX_VALUE))
		}
	],
	money: [
		{ label: "money", type: { carrier: "money", caps }, live: map(int64, (n) => Money.of(n)) }
	],
	bool: [{ label: "bool", type: { carrier: "bool", caps }, live: boolean }],
	uuid: [{ label: "uuid", type: { carrier: "uuid", caps }, live: uuid(4) }],
	date: [{ label: "date", type: { carrier: "date", caps }, live: calendarDates }],
	inet: [{ label: "inet", type: { carrier: "inet", caps }, live: inetValues }],
	cidr: [{ label: "cidr", type: { carrier: "cidr", caps }, live: cidrValues }],
	text: [
		{
			label: "text",
			type: { carrier: "text", text: "wildcard", caps },
			live: string(
				weighted([
					[1, codePoint(0x20, 0x7e)],
					[1, codePoint(0xa0, 0xd7_ff)],
					[1, codePoint(0xe0_00, 0x10_ffff)]
				]),
				{ min: 0, max: 10 }
			)
		}
	],
	bytes: [
		{
			label: "bytes",
			type: { carrier: "bytes", caps },
			live: map(byteValues({ min: 0, max: 16 }), (b) => Uint8Array.from(b))
		}
	],
	sha256: [
		{
			label: "sha256",
			type: { carrier: "sha256", caps },
			live: map(byteValues({ min: sha256Octets, max: sha256Octets }), (b) => Uint8Array.from(b))
		}
	],
	code: [
		{
			label: "code",
			type: { carrier: "code", roster: kind, caps },
			live: element(handles)
		}
	],
	bits: [
		{
			label: "bits",
			type: { carrier: "bits", roster: kind, caps },
			live: map(
				array(boolean, { min: 3, max: 3 }),
				(held): ReadonlySet<string> => new Set(Arr.filter(handles, (_, c) => held[c] === true))
			)
		}
	],
	range4: [
		{
			label: "int4range",
			type: { carrier: "range4", span: { endpoint: { carrier: "int4", caps } }, caps },
			live: spans4
		},
		{
			label: "int4range of width 3",
			type: { carrier: "range4", span: { endpoint: { carrier: "int4", caps }, width: 3n }, caps },
			live: map(int(-(2 ** 31), 2 ** 31 - 4), (start) => ({ start, end: start + 3 }))
		}
	],
	range8: [
		{
			label: "int8range",
			type: { carrier: "range8", span: { endpoint: { carrier: "int8", caps } }, caps },
			live: spans8
		},
		{
			label: "int8range of width 1",
			type: { carrier: "range8", span: { endpoint: { carrier: "int8", caps }, width: 1n }, caps },
			live: map(bigint(int8Min, int8Max - 1n), (start) => ({ start, end: start + 1n }))
		}
	],
	rangeDate: [
		{
			label: "daterange",
			type: { carrier: "rangeDate", span: { endpoint: { carrier: "date", caps } }, caps },
			live: dateSpans
		},
		{
			label: "daterange of width 1",
			type: {
				carrier: "rangeDate",
				span: { endpoint: { carrier: "date", caps }, width: 1n },
				caps
			},
			live: map(int(0, 3_652_057), (start) => ({ start: dateAt(start), end: dateAt(start + 1) }))
		}
	],
	vector: [
		{
			label: "vector(3)",
			type: { carrier: "vector", typmod: { dims: 3 }, caps },
			live: map(
				(source) =>
					[
						source.draw(float(1, 100)),
						source.draw(float(-100, 100)),
						source.draw(float(-100, 100))
					] as const,
				(components) => new Float32Array(components)
			)
		}
	],
	tsvector: [
		{
			label: "tsvector english",
			type: { carrier: "tsvector", caps, configuration: "english" },
			/** A document as tsvectorout prints it, the one text a stored document's door admits (values/tsvector.ts). */
			live: map(raw, (d) => printed(stored(d)))
		}
	],
	exactInteger: [
		{
			label: "exact integer of 40 digits",
			type: { carrier: "exactInteger", caps, digits: 40 },
			live: bigint(1n - 10n ** 40n, 10n ** 40n - 1n)
		}
	],
	exactMoney: [
		{
			label: "exact money of 30 digits",
			type: { carrier: "exactMoney", caps, digits: 30 },
			live: map(bigint(1n - 10n ** 32n, 10n ** 32n - 1n), (n) => Money.exact(n))
		}
	],
	variant: [
		{
			label: "variant of Kind",
			type: {
				carrier: "variant",
				caps,
				variant: {
					name: "Pick",
					roster: kind,
					arms: [
						{
							handle: "Manual",
							fields: [
								{ name: "n", type: { carrier: "int4", caps } },
								{ name: "x", type: { carrier: "float8", caps } }
							]
						},
						{ handle: "Automatic", fields: [] },
						{
							handle: "Ünïcode",
							fields: [{ name: "t", type: { carrier: "text", text: "wildcard", caps } }]
						}
					]
				}
			},
			live: weighted<unknown>([
				[
					2,
					(source) =>
						Object.freeze({
							tag: "Manual",
							n: source.draw(int32),
							x: source.draw(element([0, -0, Number.NaN, 1.5, -2]))
						})
				],
				[1, () => Object.freeze({ tag: "Automatic" })],
				[
					2,
					(source) =>
						Object.freeze({
							tag: "Ünïcode",
							t: source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 6 }))
						})
				]
			])
		}
	]
}

const everyCarried: Arr.NonEmptyReadonlyArray<Carried> = Arr.map(
	Arr.flatten(nonEmpty(Record.values(written), "the carriers")),
	decoded
)

/** Where a stale value comes from: the carrier whose host type it has. */
type StaleFrom = `another carrier (${string})`

/** A value of another carrier's host type, named for the carrier it comes from. */
const otherCarrier: Gen<Stale<unknown, StaleFrom>> = (source) => {
	const other = source.draw(element(everyCarried))
	return { value: source.draw(other.live), from: `another carrier (${other.label})` }
}

/** A value for a descriptor: Live, of another carrier, or Wild. */
const drawnFor = (target: Carried): Gen<Drawn<unknown, StaleFrom>> =>
	lsw({ live: target.live, stale: Option.some(otherCarrier), wild: WILD_KINDS })

export type EncoderFeature =
	| DrawnFeature<StaleFrom>
	| "stale"
	| "refused"
	| "admitted from another carrier"

/**
 * Every descriptor whose values have a parameter text: all but bytes, whose value travels in binary and is read back
 * as itself (codec/delivery.ts), so no text of it round-trips.
 */
const textCarried: Arr.NonEmptyReadonlyArray<Carried> = nonEmpty(
	Arr.filter(everyCarried, (c) => c.type.carrier !== "bytes"),
	"the carriers of a parameter text"
)

export const caseGen: Gen<readonly [Carried, Drawn<unknown, StaleFrom>]> = (source) => {
	const target = source.draw(element(textCarried))
	return [target, source.draw(drawnFor(target))] as const
}

/** A case handing a descriptor of a parameter text a wild value of one kind. */
const wildCase =
	(kind: WildKind): Gen<readonly [Carried, Drawn<unknown, StaleFrom>]> =>
	(source) =>
		[source.draw(element(textCarried)), { kind: "wild", wild: source.draw(wild([kind])) }] as const

/** Each wild kind's situation, and the space of cases handing a descriptor a value of that kind: the encoders' aims. */
export const wildAims = Arr.map(
	WILD_KINDS,
	(kind) => [`wild ${kind}` satisfies EncoderFeature, wildCase(kind)] as const
)

/** A marker no word of the vocabulary holds: a refusal that carries it carries the value. */
export const marker = "wild-marker-0x5eed"

/** The encoders property's situations: a Live value, every wild kind, a refusal and an admission from another carrier. */
export const encoderSituations: ReadonlyArray<EncoderFeature> = [
	"live",
	...Arr.map(WILD_KINDS, (kind): EncoderFeature => `wild ${kind}`),
	"refused",
	"admitted from another carrier"
]

/** A case of the slot property: a descriptor, and a text that holds the marker between two copies of one text. */
export const slotCases: Gen<readonly [Carried, string]> = (source) =>
	[
		source.draw(element(everyCarried)),
		source.draw(map(string(codePoint(0x20, 0x7e), { min: 0, max: 8 }), (s) => `${s}${marker}${s}`))
	] as const

/** A case of the getter property: the start its getter answers first, and the one it answers after. */
export const unstableCases: Gen<readonly [number, number]> = (source) =>
	[source.draw(int(int4Min, int4Max - 1)), source.draw(int32)] as const

/** A span whose `start` getter answers `first` and then `then`, counting its reads. */
export const unstableSpan = <E extends number | bigint>(first: E, then: E, end: E) => {
	let reads = 0
	const span = Object.defineProperty({ end }, "start", {
		enumerable: true,
		get: () => (reads++ === 0 ? first : then)
	})
	return { span, reads: () => reads }
}

/** A fact as drawn: fields, each Live, of another carrier or Wild, or a wild value in place of the whole fact. */
type DrawnFact =
	| { readonly kind: "fields"; readonly fields: ReadonlyArray<Drawn<unknown, StaleFrom>> }
	| { readonly kind: "wild"; readonly wild: Wild }

/** The descriptors of the fact property's heading. */
const descriptors = [
	decoded(written.int8[0]),
	decoded(written.text[0]),
	decoded(written.range8[0])
] as const
/** The heading of the fact property: an int8, a text and an int8range. */
export const heading = Arr.map(descriptors, (d, i) => ({
	name: `f${i}`,
	spec: carrierSpecOf(d.type, kindCodes)
}))
/** A fact's fields, each Live, of another carrier or Wild. */
const fieldGen: Gen<ReadonlyArray<Drawn<unknown, StaleFrom>>> = (source) =>
	Arr.map(descriptors, (d) => source.draw(drawnFor(d)))
/** The fact is built inside the property: a wild value reaches no generator. */
export const factGen = weighted([
	[1, map(fieldGen, (fields): DrawnFact => ({ kind: "fields", fields }))],
	[1, map(wild(WILD_KINDS), (wild): DrawnFact => ({ kind: "wild", wild }))]
])

/** A row of a heading drawn from every descriptor: each cell the text of a Live value, a bytes value's digest. */
export const rowCaseGen: Gen<{
	readonly columns: ReadonlyArray<Carried>
	readonly values: ReadonlyArray<unknown>
}> = (source) => {
	const columns = source.draw(array(element(everyCarried), { min: 1, max: 4 }))
	return { columns, values: Arr.map(columns, (c) => source.draw(c.live)) }
}

/**
 * A row's cell as the test writes it: a text column's parameter text, or a bytes column's digest, all a write statement
 * returns of a bytes value (write/insert/statement.ts returnedColumn).
 */
export type RowCell =
	| { readonly kind: "text"; readonly column: Carried; readonly text: ParamText }
	| { readonly kind: "bytes"; readonly digest: string }
