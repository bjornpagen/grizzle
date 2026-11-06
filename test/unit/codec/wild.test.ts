import { inspect } from "node:util"
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	codePoint,
	element,
	filter,
	type Gen,
	int,
	map,
	oneOf,
	string,
	weighted
} from "@grizzle/testing/gen"
import {
	type Drawn,
	drawnFeature,
	type DrawnFeature,
	lsw,
	passed,
	type Stale,
	type Wild,
	wild,
	WILD_KINDS
} from "@grizzle/testing/lsw"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint, double, float, uuid } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	DateTime,
	Effect,
	Formatter,
	Option,
	pipe,
	Record,
	String as Str
} from "effect"
import { isCodecFault } from "#compiler/codec/fault.ts"
import { tupleConverter } from "#compiler/codec/row.ts"
import { carrierSpecOf, paramEncoder, scalarCodec } from "#compiler/codec/scalar.ts"
import { int8Max, int8Min } from "#compiler/core/limits.ts"
import * as Result from "#compiler/core/result.ts"
import { decodeScalarType } from "#compiler/ir/scalar-shape.ts"
import { type Carrier, capabilitySet, type ScalarType } from "#compiler/ir/scalar.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { isValueFault } from "#compiler/scalar/values/fault.ts"
import { factIdentity } from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { kindCodes } from "#test/unit/codec/support.ts"

/**
 * What the encoders answer for anything JavaScript can pass (README "Errors and outcomes": an encoding failure is EncodingFailure
 * with its word, before any SQL).
 *
 * Every descriptor of every carrier meets Live values of its own host type, values of every other carrier's host type,
 * and Wild values (the testing library's lsw): proxies whose every trap throws, objects whose getter throws, bigint for
 * number and number for bigint, lone surrogates, NUL, -0, NaN, the infinities, symbols, functions and any JSON value.
 * The encoder answers each by refusing it with a word of the codec vocabulary, or by admitting it to a text that
 * converts back to a value that encodes to the same text; a Live value is always admitted. It never throws: a value
 * whose reading throws is refused as not of the carrier's host type. A template slot's refusal names the slot and the
 * word, and never the value.
 *
 * A result row grizzle reads for itself is positional text, every cell a text (the session admits no NULL): it converts
 * to a frozen tuple, positionally, each value the one the text encodes.
 *
 * A fact meets the same values as fields, and itself as a proxy, an array or anything else: factIdentity refuses with a
 * word and the field, or admits every field. A getter is read exactly once, at admission: one that answers a valid
 * value first and an invalid one after is admitted with its first answer, and encodes from what admission kept.
 *
 * One descriptor, hand-written as a JavaScript caller or a stored snapshot states one, beside the Live values of its
 * host type. The scalar type decoder is the boundary that admits it, so it stays
 * `unknown` until decoded.
 */
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

const decoded = (written: Written): Carried => {
	const type = decodeScalarType(written.type)
	if (!type.ok) {
		throw new Error(
			`${written.label}: the decoder refuses a hand-written descriptor: ${type.error.message}`
		)
	}
	return { label: written.label, type: type.value, live: written.live }
}

const caps = capabilitySet(["storage", "equality"])

const int32 = int(-(2 ** 31), 2 ** 31 - 1)
const int64 = bigint(int8Min.value, int8Max.value)

/** A decimal whose integer part has at most `digits` digits, with any fraction. */
const decimals = (digits: number): Gen<unknown> =>
	map(
		(source) =>
			[
				source.draw(boolean),
				source.draw(bigint(0n, 10n ** BigInt(digits) - 1n)),
				source.draw(int(0, 999_999))
			] as const,
		([negative, whole, fraction]) => Decimal.of(`${negative ? "-" : ""}${whole}.${fraction}`)
	)

/** A span over endpoints of one width, its end past its start. */
const spans = <E extends number | bigint>(endpoint: Gen<E>): Gen<unknown> =>
	map(
		filter(
			(source) => [source.draw(endpoint), source.draw(endpoint)] as const,
			([a, b]) => a !== b,
			100
		),
		([a, b]) => (a < b ? { start: a, end: b } : { start: b, end: a })
	)

/**
 * A calendar date's ISO 8601 text: a day from 0001-01-01 to 9999-12-31, drawn as a count of days past the first, which
 * Effect's DateTime carries over its months and years by the proleptic Gregorian calendar and formats at its UTC date.
 */
const calendarDates: Gen<unknown> = (source) =>
	DateTime.formatIsoDateUtc(
		DateTime.makeUnsafe({ year: 1, month: 1, day: 1 + source.draw(int(0, 3_652_058)) })
	)

const handles = ["Manual", "Automatic", "Ünïcode"] as const

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
const written: { readonly [C in Carrier]: Arr.NonEmptyReadonlyArray<Written> } = {
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
				caps,
				contract: { name: "Cents", base: { carrier: "int8", caps }, facts: [] }
			},
			live: int64
		}
	],
	numeric: [
		{
			label: "numeric(36,6)",
			type: { carrier: "numeric", typmod: { precision: 36, scale: 6 }, caps },
			live: decimals(30)
		},
		{
			label: "numeric(7,2)",
			type: { carrier: "numeric", typmod: { precision: 7, scale: 2 }, caps },
			live: decimals(4)
		},
		{
			label: "numeric(5,-2)",
			type: { carrier: "numeric", typmod: { precision: 5, scale: -2 }, caps },
			live: decimals(6)
		}
	],
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
	text: [
		{
			label: "text",
			type: { carrier: "text", text: { regex: "wildcard" }, caps },
			live: string(
				oneOf([codePoint(0x20, 0x7e), codePoint(0xa0, 0xd7_ff), codePoint(0xe0_00, 0x10_ffff)]),
				{ min: 0, max: 10 }
			)
		}
	],
	code: [
		{
			label: "code",
			type: { carrier: "code", roster: { closed: "Kind", handles }, caps },
			live: element(handles)
		}
	],
	bits: [
		{
			label: "bits",
			type: { carrier: "bits", roster: { closed: "Kind", handles }, caps },
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
			live: spans(int32)
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
			live: spans(int64)
		},
		{
			label: "int8range of width 1",
			type: { carrier: "range8", span: { endpoint: { carrier: "int8", caps }, width: 1n }, caps },
			live: map(bigint(int8Min.value, int8Max.value - 1n), (start) => ({ start, end: start + 1n }))
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

type EncoderFeature =
	| DrawnFeature<StaleFrom>
	| "stale"
	| "refused"
	| "admitted from another carrier"

const caseGen: Gen<readonly [Carried, Drawn<unknown, StaleFrom>]> = (source) => {
	const target = source.draw(element(everyCarried))
	return [target, source.draw(drawnFor(target))] as const
}

/** A marker no word of the vocabulary holds: a refusal that carries it carries the value. */
const marker = "wild-marker-0x5eed"

describe("the encoders", () => {
	it.effect(
		"refuse every value with a word of the vocabulary, or admit it to a text that round-trips, and never throw",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/codec/wild",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<EncoderFeature>(
							[
								"live",
								...Arr.map(WILD_KINDS, (kind): EncoderFeature => `wild ${kind}`),
								"refused",
								"admitted from another carrier"
							],
							{ cases: 3000, sense: notesOnly }
						),
						kept: [],
						runs: 3000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([target, drawn], c) =>
						Effect.sync(() => {
							const codec = scalarCodec(target.type, kindCodes)
							const value = passed(drawn)
							c.note(drawn.kind === "stale" ? "stale" : drawnFeature(drawn))
							const encoded = codec.encode(value)
							if (!encoded.ok) {
								c.note("refused")
								assert.ok(
									isCodecFault(encoded.error),
									`${target.label}: refused with ${encoded.error}`
								)
								assert.notEqual(
									drawn.kind,
									"live",
									`${target.label}: a Live value was refused (${encoded.error})`
								)
								const slotted = paramEncoder(target.type, "slot", kindCodes)(value)
								assert.ok(
									!slotted.ok,
									`${target.label}: the slot's encoder admitted what the codec refused`
								)
								assert.equal(slotted.error.reason._tag, encoded.error)
								return
							}
							if (drawn.kind === "stale") {
								c.note("admitted from another carrier")
							}
							const again = codec.encode(codec.convert(encoded.value))
							assert.deepEqual(
								again,
								Result.ok(encoded.value),
								`${target.label}: the converted value encodes otherwise`
							)
						})
				)
			)
	)

	it.effect("name the slot and the word in a template slot's refusal, never the value", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/codec/wild-slot",
					draw: drawn(
						(source) =>
							[
								source.draw(element(everyCarried)),
								source.draw(
									map(string(codePoint(0x20, 0x7e), { min: 0, max: 8 }), (s) => `${s}${marker}${s}`)
								)
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
				([target, text]) =>
					Effect.sync(() => {
						const encoded = paramEncoder(
							target.type,
							"slot",
							kindCodes
						)(target.type.carrier === "text" ? `${text}\u0000` : text)
						if (encoded.ok) {
							return
						}
						assert.deepEqual(encoded.error.place, { _tag: "Slot", name: "slot" })
						assert.ok(
							!pipe(inspect(encoded.error, { depth: 8 }), Str.includes(marker)),
							`${target.label}: the refusal holds the value`
						)
					})
			)
		)
	)
})

/** A span whose `start` getter answers `first` and then `then`, counting its reads. */
const unstableSpan = <E extends number | bigint>(first: E, then: E, end: E) => {
	let reads = 0
	const span = Object.defineProperty({ end }, "start", {
		enumerable: true,
		get: () => (reads++ === 0 ? first : then)
	})
	return { span, reads: () => reads }
}

describe("admission reads a value once", () => {
	it.effect("admits a getter's first answer and encodes from it, however it answers after", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/codec/wild-unstable",
					draw: drawn((source) => [source.draw(int32), source.draw(int32)] as const),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 300,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				([first, then], c) =>
					Effect.gen(function* () {
						const end = 2 ** 31 - 1
						yield* c.assume(first < end)
						const range4 = decoded(written.range4[0]).type
						const codec = scalarCodec(range4, kindCodes)
						const unstable = unstableSpan(first, then, end)
						const encoded = codec.encode(unstable.span)
						assert.deepEqual(encoded, Result.ok(`[${first},${end})`))
						assert.equal(unstable.reads(), 1, "the getter is read once")
						/** A fact's field: read once, and its admitted value is the first answer. */
						const heading = [{ name: "span", spec: carrierSpecOf(range4, kindCodes) }]
						const fieldReads = unstableSpan(first, then, end)
						let factReads = 0
						const fact = Object.defineProperty({}, "span", {
							enumerable: true,
							get: () => {
								factReads++
								return factReads === 1 ? fieldReads.span : undefined
							}
						})
						const admitted = factIdentity(heading, fact)
						assert.ok(admitted.ok)
						assert.equal(factReads, 1, "the fact's field is read once")
						assert.deepEqual(admitted.value.fact["span"], { start: first, end })
					})
			)
		)
	)
})

/** A fact as drawn: fields, each Live, of another carrier or Wild, or a wild value in place of the whole fact. */
type DrawnFact =
	| { readonly kind: "fields"; readonly fields: ReadonlyArray<Drawn<unknown, StaleFrom>> }
	| { readonly kind: "wild"; readonly wild: Wild }

describe("fact identity", () => {
	it.effect(
		"refuses every fact with a word and its field, or admits every field, and never throws",
		(ctx) =>
			Effect.gen(function* () {
				const descriptors = [
					decoded(written.int8[0]),
					decoded(written.text[0]),
					decoded(written.range8[0])
				] as const
				const heading = Arr.map(descriptors, (d, i) => ({
					name: `f${i}`,
					spec: carrierSpecOf(d.type, kindCodes)
				}))
				const fieldGen: Gen<ReadonlyArray<Drawn<unknown, StaleFrom>>> = (source) =>
					Arr.map(descriptors, (d) => source.draw(drawnFor(d)))
				/** The fact is built inside the property: a wild value reaches no generator. */
				const factGen = oneOf([
					map(fieldGen, (fields): DrawnFact => ({ kind: "fields", fields })),
					map(wild(WILD_KINDS), (wild): DrawnFact => ({ kind: "wild", wild }))
				])
				yield* searched(
					ctx,
					explore(
						{
							suite: "unit/codec/wild-fact",
							draw: drawn(factGen),
							literal: Formatter.format,
							coverage: required<"admitted" | "refused at a field" | "refused whole">(
								["admitted", "refused at a field", "refused whole"],
								{ cases: 1000, sense: notesOnly }
							),
							kept: [],
							runs: 1000,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(drawn, c) =>
							Effect.sync(() => {
								const fact =
									drawn.kind === "fields"
										? Record.fromEntries(
												Arr.map(drawn.fields, (field, i) => [`f${i}`, passed(field)])
											)
										: passed({ kind: "wild", wild: drawn.wild })
								const admitted = factIdentity(heading, fact)
								if (admitted.ok) {
									c.note("admitted")
									return
								}
								assert.ok(
									isValueFault(admitted.error.fault),
									`refused with ${admitted.error.fault}`
								)
								c.note(admitted.error.field === undefined ? "refused whole" : "refused at a field")
								if (drawn.kind === "fields" && Arr.every(drawn.fields, (f) => f.kind === "live")) {
									assert.fail(
										`a fact of Live fields was refused: ${admitted.error.fault} at ${String(admitted.error.field)}`
									)
								}
							})
					)
				)
			})
	)
})

/** A row of a heading drawn from every descriptor: each cell the text of a Live value. */
const rowCaseGen: Gen<{
	readonly columns: ReadonlyArray<Carried>
	readonly values: ReadonlyArray<unknown>
}> = (source) => {
	const columns = source.draw(array(element(everyCarried), { min: 1, max: 4 }))
	return { columns, values: Arr.map(columns, (c) => source.draw(c.live)) }
}

describe("the tuple converter", () => {
	it.effect(
		"converts every row to a frozen tuple, each position the value its text encodes",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/codec/wild-rows",
						draw: drawn(rowCaseGen),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ columns, values }) =>
						Effect.sync(() => {
							const cells = Arr.map(columns, (column, i) => {
								const encoded = scalarCodec(column.type, kindCodes).encode(values[i])
								assert.ok(encoded.ok, `${column.label}: a Live value was refused`)
								return { column, text: encoded.value }
							})
							/** Repeated private names convert positionally. */
							const tuple = tupleConverter(
								Arr.map(columns, (c) => ({ name: "c", type: c.type })),
								kindCodes
							)(Arr.map(cells, (cell) => cell.text))
							assert.ok(Object.isFrozen(tuple))
							assert.equal(tuple.length, columns.length)
							for (const [i, { column, text }] of cells.entries()) {
								assert.deepEqual(
									scalarCodec(column.type, kindCodes).encode(tuple[i]),
									Result.ok(text)
								)
							}
						})
				)
			)
	)
})
