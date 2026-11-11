import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, required, requiredInSpace } from "@grizzle/testing/features"
import {
	array,
	boolean,
	bytes,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string,
	subarray,
	weighted
} from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint, double, float, uuid } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, pipe, Record as Rec, String as Str } from "effect"
import {
	base64urlDecode,
	base64urlEncode,
	base64urlLength
} from "#compiler/codec/cursor/base64url.ts"
import { varintLength, varintMax, written } from "#compiler/codec/cursor/bytes.ts"
import {
	type CursorCodec,
	type CursorSpec,
	type CursorValue,
	cursorCodec,
	cursorTokenMaxLength,
	cursorValueMaxBytes,
	cursorValueMinBytes
} from "#compiler/codec/cursor/codec.ts"
import {
	type CursorComparator,
	cursorDigestBytes,
	DigestBytes
} from "#compiler/codec/cursor/identity.ts"
import {
	type CursorFields,
	headerBytes,
	readCursor,
	writeCursor
} from "#compiler/codec/cursor/layout.ts"
import { CursorError, type CursorFault } from "#compiler/core/errors.ts"
import { int8Max, int8Min } from "#compiler/core/limits.ts"
import { opposite } from "#compiler/core/order.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { toReal } from "#compiler/scalar/values/float.ts"
import { compareValues } from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import {
	assert,
	assertNot,
	assertVariant,
	failed,
	lacksText,
	refused,
	succeeded
} from "#test/support/assert.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	generation,
	taskCodec,
	taskId,
	taskSpec,
	cursorCodecTypes,
	cursorCodes
} from "#test/unit/cursor/support.ts"
import { decimalGen } from "#test/unit/values/support.ts"

import { regex } from "arkregex"
import { paramText } from "#test/support/wire.ts"
/**
 * The cursor codec, its host half: exact round-trips of boundary
 * values, validation of every token before any SQL in a fixed order, and the size limits.
 *
 * The codec is pure (packages/engine/src): decode returns before the adapter could issue a statement, so every refusal here
 * is "before any SQL" by construction; test/pg/page confirms it with the statement counter.
 *
 * Oracles: round trips (decode ∘ encode = id per carrier, write ∘ read = id per layout), the order-preservation
 * relation, decode's totality, and the specifications of the validation order, the header, the size limits and each
 * carrier's byte bounds; each suite states its own. Inputs are constructed: a non-empty int8 span by its start then its
 * end past it, a stored string from every scalar but NUL.
 *
 * Features: each carrier case of the carriers suite; each validation fault; a header byte changed.
 *
 * Plants (~/.cache/grizzle-release/BR02/plants): cursor-query-before-generation, cursor-comparators-unchecked,
 * cursor-range-end-from-start, cursor-bigint-truncated.
 */
const single = <T extends ScalarType>(type: T): CursorCodec<readonly [CursorComparator<T>]> =>
	succeeded(
		cursorCodec<readonly [CursorComparator<T>]>(
			{
				query: "q",
				comparators: [{ field: "v", direction: "asc", type }],
				generation
			},
			cursorTokenMaxLength,
			cursorCodes
		)
	)

/** The element at an index the test knows is in range, failing the test where it is not. */
const at = <A>(values: ArrayLike<A>, index: number): A => {
	const value = values[index]
	if (value === undefined) {
		throw new RangeError(`no element at ${index}`)
	}
	return value
}

/** A token's bytes, failing the test where the token is not base64url. */
const bytesOf = (token: string): Uint8Array => {
	const bytes = base64urlDecode(token)
	if (bytes === undefined) {
		throw new Error(`not a base64url token: ${token}`)
	}
	return bytes
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

/** The codec of one comparator, built again over the same spec. */
const again = <T extends ScalarType>(type: T): CursorCodec<readonly [CursorComparator<T>]> =>
	single(type)

/**
 * A carrier's value with its edges planted, the pagination example's tuple, the empty tuple, or a refused admission.
 */
type CarrierCase =
	| { readonly kind: "money"; readonly value: Money }
	| { readonly kind: "uuid"; readonly value: string }
	| { readonly kind: "bool"; readonly value: boolean }
	| { readonly kind: "handle"; readonly value: "Manual" | "Automatic" | "Ünïcode" }
	| { readonly kind: "int8range"; readonly value: { readonly start: bigint; readonly end: bigint } }
	| { readonly kind: "vector"; readonly value: Vector }
	| { readonly kind: "task tuple"; readonly value: readonly [number, string] }
	| { readonly kind: "empty tuple" }
	| { readonly kind: "refused admission"; readonly tuple: unknown }

/** A non-empty int8 span: its start below the top, its end past its start. */
const int8Span: Gen<{ readonly start: bigint; readonly end: bigint }> = (source) => {
	const start = source.draw(bigint(int8Min.value, int8Max.value - 1n))
	return { start, end: source.draw(bigint(start + 1n, int8Max.value)) }
}

/** Every Unicode scalar but NUL, which no text holds, each as often as every other. */
const storedScalar: Gen<string> = map(int(1, 0x10_ffff - 0x800), (index) =>
	String.fromCodePoint(index < 0xd8_00 ? index : index + 0x800)
)

const caseOfUuid = map(
	(source) => [source.draw(uuid(4)), source.draw(boolean)] as const,
	([u, upper]) => (upper ? Str.toUpperCase(u) : u)
)

const cosineBound = Math.fround(2 ** 16 / Math.sqrt(3))

/** The largest finite float32. */
const floatMax = Math.fround(3.4028234663852886e38)

/** A drawn number, or now and then NaN. */
const nanOr = (finite: Gen<number>): Gen<number> =>
	weighted([
		[9, finite],
		[1, constant(Number.NaN)]
	])

/** Every finite double, and now and then NaN or an infinity. */
const anyDouble = weighted([
	[9, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
	[1, element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])]
])

/** Every finite float32, and now and then NaN or an infinity. */
const anyFloat = weighted([
	[9, float(-floatMax, floatMax)],
	[1, element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])]
])

const carrierCaseGen: Gen<CarrierCase> = oneOf([
	map(
		oneOf([bigint(int8Min.value, int8Max.value), element([int8Min.value, int8Max.value, -1n, 0n])]),
		(n): CarrierCase => ({ kind: "money", value: Money.of(n) })
	),
	map(caseOfUuid, (value): CarrierCase => ({ kind: "uuid", value })),
	map(boolean, (value): CarrierCase => ({ kind: "bool", value })),
	map(
		element(["Manual" as const, "Automatic" as const, "Ünïcode" as const]),
		(value): CarrierCase => ({ kind: "handle", value })
	),
	map(
		oneOf([int8Span, constant({ start: int8Min.value, end: int8Max.value })]),
		(value): CarrierCase => ({
			kind: "int8range",
			value
		})
	),
	map(
		oneOf([
			array(float(-cosineBound, cosineBound), { min: 3, max: 3 }),
			constant([1.5, -0, 3e-38])
		]),
		(cs): CarrierCase => {
			/** A vector below the cosine domain's norm has its first component set to 1. */
			const made = Vector.make(Float32Array.from(cs), 3)
			return {
				kind: "vector",
				value: Vector.inCosineDomain(made)
					? made
					: Vector.make(Float32Array.from([1, ...cs.slice(1)]), 3)
			}
		}
	),
	map(
		(source) => [source.draw(int(-(2 ** 31), 2 ** 31 - 1)), source.draw(caseOfUuid)] as const,
		(value): CarrierCase => ({ kind: "task tuple", value })
	),
	constant<CarrierCase>({ kind: "empty tuple" }),
	element<CarrierCase>([
		{ kind: "refused admission", tuple: [5.5, taskId] },
		{ kind: "refused admission", tuple: [5] },
		{ kind: "refused admission", tuple: [null, taskId] }
	])
])

/** Encodes one value and decodes it back, returning the decoded value and its canonical text. */
const roundTrip = <T extends ScalarType>(type: T, value: CursorValue<T>) => {
	const codec = single(type)
	const token = succeeded(codec.encode([value]))
	const decoded = succeeded(codec.decode(token))
	return { value: decoded.values[0], text: at(decoded.texts, 0), token }
}

describe("boundary values round-trip exactly", () => {
	it.effect("round-trips every double and every real bit for bit", (ctx) =>
		Effect.gen(function* () {
			const f8 = single(cursorCodecTypes.float8)
			const f4 = single(cursorCodecTypes.float4)
			yield* searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "universal",
							name: "decode ∘ encode = id, bit for bit, -0 as the one zero"
						},
						suite: "unit/cursor/codec-1601",
						/**
						 * The doubles' and reals' edges are drawn beside the rest of their range: both zeros, NaN, the infinities,
						 * the least subnormal and the largest finite value.
						 */
						draw: drawn(
							(source) =>
								[
									source.draw(
										oneOf([
											anyDouble,
											element([
												-0,
												0,
												Number.NaN,
												Number.POSITIVE_INFINITY,
												Number.NEGATIVE_INFINITY,
												5e-324,
												Number.MAX_VALUE
											])
										])
									),
									source.draw(
										oneOf([
											anyFloat,
											element([
												-0,
												Number.NaN,
												Number.NEGATIVE_INFINITY,
												2 ** -149,
												Math.fround(3.4e38)
											])
										])
									)
								] as const
						),
						literal: Formatter.format,
						coverage: required<"one zero" | "NaN" | "an infinity" | "finite">(
							["one zero", "NaN", "an infinity", "finite"],
							{ cases: 3000, sense: notesOnly }
						),
						kept: [],
						runs: 3000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([d, float4], c) =>
						Effect.sync(() => {
							c.note(
								d === 0
									? "one zero"
									: Number.isNaN(d)
										? "NaN"
										: Number.isFinite(d)
											? "finite"
											: "an infinity"
							)
							const token = succeeded(f8.encode([d]))
							const dv = succeeded(f8.decode(token)).values[0]
							assert.equal(Object.is(dv, d === 0 ? 0 : d), true)
							if (d === 0) {
								assert.equal(token, succeeded(f8.encode([0])))
							}
							const r = succeeded(toReal(float4))
							const fv = succeeded(f4.decode(succeeded(f4.encode([float4])))).values[0]
							assert.equal(Object.is(fv, r), true)
						})
				)
			)
		})
	)

	it.effect("keeps every bigint digit at the int8 extremes", (ctx) =>
		Effect.gen(function* () {
			/** A contract field orders and encodes as its base, so both codecs meet the same values. */
			const codecs = {
				int8: single(cursorCodecTypes.int8),
				contract: single(cursorCodecTypes.cents)
			}
			yield* searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "universal",
							name: "decode ∘ encode = id, every digit at the int8 extremes"
						},
						suite: "unit/cursor/codec-1602",
						draw: drawn(
							(source) =>
								[
									source.draw(
										oneOf([
											bigint(int8Min.value, int8Max.value),
											element([int8Min.value, int8Max.value, 0n, -1n, 2n ** 53n + 1n])
										])
									),
									source.draw(element(["int8" as const, "contract" as const]))
								] as const
						),
						literal: Formatter.format,
						coverage: required<"int8" | "contract" | "an extreme">(
							["int8", "contract", "an extreme"],
							{ cases: 2000, sense: notesOnly }
						),
						kept: [],
						runs: 2000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([n, which], c) =>
						Effect.sync(() => {
							c.note(which)
							if (n === int8Min.value || n === int8Max.value) {
								c.note("an extreme")
							}
							const codec = codecs[which]
							assert.equal(succeeded(codec.decode(succeeded(codec.encode([n])))).values[0], n)
						})
				)
			)
		})
	)

	it.effect("keeps every Decimal exactly, in its one form, the special values included", (ctx) =>
		Effect.gen(function* () {
			const codec = single(cursorCodecTypes.numeric)
			yield* searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "universal",
							name: "decode ∘ encode = id, a Decimal in its one form and text"
						},
						suite: "unit/cursor/codec-1603",
						draw: drawn(
							oneOf([
								decimalGen,
								element([
									Decimal.of("1.50"),
									Decimal.of("123456789012345678901234567890.000000001")
								])
							])
						),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 2000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(d) =>
						Effect.sync(() => {
							const decoded = succeeded(codec.decode(succeeded(codec.encode([d]))))
							assert.equal(decoded.values[0].toString(), d.toString())
							assert.equal(decoded.texts[0], paramText(d.toString()))
						})
				)
			)
		})
	)

	it.effect(
		"applies a numeric typmod before it encodes, the text the rounded value's one text",
		(ctx) =>
			Effect.gen(function* () {
				/** Each typmod with its scale and the largest whole part that rounds within its precision. */
				const typmods = [
					{
						name: "numeric(7,2)",
						codec: single(cursorCodecTypes.numeric72),
						scale: 2,
						largest: 99_998n
					},
					{
						name: "numeric(5,-2)",
						codec: single(cursorCodecTypes.numericNeg),
						scale: -2,
						largest: 9_999_800n
					}
				] as const
				yield* searched(
					ctx,
					explore(
						{
							oracle: {
								kind: "specification",
								name: "the typmod's rounding before encoding, the text the rounded value's one text"
							},
							suite: "unit/cursor/codec-typmod",
							draw: drawn((source) => ({
								typmod: source.draw(element([0 as const, 1 as const])),
								negative: source.draw(boolean),
								whole: source.draw(bigint(0n, 9_999_800n)),
								fraction: source.draw(matching(regex("^\\d{0,4}$")))
							})),
							literal: Formatter.format,
							coverage: required<"numeric(7,2)" | "numeric(5,-2)">(
								["numeric(7,2)", "numeric(5,-2)"],
								{ cases: 500, sense: notesOnly }
							),
							kept: [],
							runs: 500,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ typmod, negative, whole: drawnWhole, fraction }, c) =>
							Effect.sync(() => {
								const { name, codec, scale: s, largest } = typmods[typmod]
								c.note(name)
								const whole = drawnWhole % (largest + 1n)
								const value = Decimal.of(
									`${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`
								)
								/** The magnitude in units of 10^-scale, rounded half away from zero to units of 10^-s. */
								const scale = fraction.length
								const units =
									whole * 10n ** BigInt(scale) + (fraction === "" ? 0n : BigInt(fraction))
								const k = scale - s
								const rounded =
									k <= 0
										? units * 10n ** BigInt(-k)
										: (units + 5n * 10n ** BigInt(k - 1)) / 10n ** BigInt(k)
								const digits =
									s > 0
										? pipe(rounded.toString(), Str.padStart(s + 1, "0"))
										: (rounded * 10n ** BigInt(-s)).toString()
								const unsigned =
									s > 0 ? `${Str.slice(0, -s)(digits)}.${Str.slice(-s)(digits)}` : digits
								/** The rounded value's one text: its fraction's trailing zeros, and a then bare point, dropped. */
								const trimmed = Str.includes(".")(unsigned)
									? Str.replace(regex("\\.?0+$"), "")(unsigned)
									: unsigned
								const expected = negative && rounded !== 0n ? `-${trimmed}` : trimmed
								const decoded = succeeded(codec.decode(succeeded(codec.encode([value]))))
								assert.equal(
									decoded.texts[0],
									paramText(expected),
									`${name} of ${value.toString()}`
								)
							})
					)
				)
			})
	)

	it.effect("keeps supplementary-plane text and every other scalar sequence exactly", (ctx) =>
		Effect.gen(function* () {
			const codec = single(cursorCodecTypes.text)
			yield* searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "universal",
							name: "decode ∘ encode = id over every scalar sequence"
						},
						suite: "unit/cursor/codec-1604",
						/** Supplementary-plane, noncharacter and decomposed scalars are drawn beside strings of any scalar. */
						draw: drawn(
							oneOf([
								string(storedScalar, { min: 0, max: 60 }),
								element(["", "𝄞", "\u{10ffff}", "a\u{1f600}b", "￿", "é", "é"])
							])
						),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 2000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s) =>
						Effect.sync(() => {
							assert.equal(succeeded(codec.decode(succeeded(codec.encode([s])))).values[0], s)
						})
				)
			)
		})
	)

	it.effect(
		"round-trips every carrier's values under one identity, and refuses at creation what admission refuses",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "universal",
							name: "decode ∘ encode = id under one identity, and admission's refusals at creation"
						},
						suite: "unit/cursor/codec-carriers",
						draw: drawn(carrierCaseGen),
						literal: Formatter.format,
						coverage: required<CarrierCase["kind"]>(
							[
								"money",
								"uuid",
								"bool",
								"handle",
								"int8range",
								"vector",
								"task tuple",
								"empty tuple",
								"refused admission"
							],
							{ cases: 900, sense: notesOnly }
						),
						kept: [],
						/** The rotating stream's sample of nine arms, each about one case in nine. */
						runs: 900,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sketch, c) =>
						Effect.sync(() => {
							c.note(sketch.kind)
							switch (sketch.kind) {
								case "money": {
									const back = roundTrip(cursorCodecTypes.money, sketch.value)
									assert.equal(back.value.minorUnits, sketch.value.minorUnits)
									assert.equal(
										back.token,
										succeeded(again(cursorCodecTypes.money).encode([sketch.value]))
									)
									return
								}
								case "uuid":
									assert.equal(
										roundTrip(cursorCodecTypes.uuid, sketch.value).value,
										Str.toLowerCase(sketch.value)
									)
									return
								case "bool":
									assert.equal(roundTrip(cursorCodecTypes.bool, sketch.value).value, sketch.value)
									return
								case "handle":
									assert.equal(roundTrip(cursorCodecTypes.kind, sketch.value).value, sketch.value)
									return
								case "int8range":
									assert.deepEqual(
										roundTrip(cursorCodecTypes.range8, sketch.value).value,
										sketch.value
									)
									return
								case "vector":
									assert.equal(
										Vector.compare(
											roundTrip(cursorCodecTypes.vector3, sketch.value).value,
											sketch.value
										),
										0
									)
									return
								case "task tuple": {
									const token = succeeded(taskCodec.encode(sketch.value))
									const decoded = succeeded(taskCodec.decode(token))
									assert.deepEqual(decoded.values, [
										sketch.value[0],
										Str.toLowerCase(sketch.value[1])
									])
									assert.deepEqual(decoded.texts, [
										paramText(String(sketch.value[0])),
										paramText(Str.toLowerCase(sketch.value[1]))
									])
									/**
									 * The spec states no page size or direction: a codec built again binds the same identity, and one
									 * token serves every request variant.
									 */
									const rebuilt = succeeded(
										cursorCodec(taskSpec, cursorTokenMaxLength, cursorCodes)
									)
									assert.deepEqual(rebuilt.identity, taskCodec.identity)
									assert.equal(succeeded(rebuilt.encode(sketch.value)), token)
									return
								}
								case "empty tuple": {
									const unit = succeeded(
										cursorCodec(
											{ query: "unit", comparators: [] as const, generation },
											cursorTokenMaxLength,
											cursorCodes
										)
									)
									assert.deepEqual(succeeded(unit.decode(succeeded(unit.encode([])))).values, [])
									return
								}
								case "refused admission":
									refused(taskCodec.admit(sketch.tuple), "cursorValue")
									return
							}
						})
				)
			)
	)

	it.effect("decodes values that order exactly as the encoded ones", (ctx) =>
		Effect.gen(function* () {
			const codec = single(cursorCodecTypes.numeric)
			yield* searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "universal",
							name: "decoding preserves order: decoded values compare as the encoded ones"
						},
						suite: "unit/cursor/codec-1605",
						draw: drawn((source) => [source.draw(decimalGen), source.draw(decimalGen)] as const),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([a, b]) =>
						Effect.sync(() => {
							const da = succeeded(codec.decode(succeeded(codec.encode([a])))).values[0]
							const db = succeeded(codec.decode(succeeded(codec.encode([b])))).values[0]
							const numeric = { carrier: "numeric", typmod: undefined } as const
							assert.equal(compareValues(numeric, da, db), compareValues(numeric, a, b))
						})
				)
			)
		})
	)
})

/**
 * Token bytes up to one claim, the tuple's count or its first value's length, the claim raised past the `tail` that
 * follows it: from one more than the tail holds, the smallest refused, up to the largest varint.
 */
interface Claim {
	readonly at: "count" | "value"
	readonly claimed: number
	readonly tail: Uint8Array
}

const claimGen: Gen<Claim> = (source) => {
	const tail = source.draw(bytes({ min: 0, max: 8 }))
	return {
		at: source.draw(element(["count", "value"] as const)),
		claimed: source.draw(
			weighted([
				[4, int(tail.length + 1, varintMax)],
				[1, element([tail.length + 1, varintMax])]
			])
		),
		tail
	}
}

/** The bytes of a claim after `fields`' digests: a value's claim follows a count of one. */
const claimBytes = (fields: CursorFields, claim: Claim): Uint8Array => {
	const claiming = written((sink) => {
		sink.field(fields.generation).field(fields.query).field(fields.comparators)
		if (claim.at === "value") {
			sink.varint(1)
		}
		sink.varint(claim.claimed)
	})
	return Uint8Array.from([...claiming, ...claim.tail])
}

/** The fields of token bytes whose tuple holds `arity` values, read for a codec of that arity. */
const readFields = (bytes: Uint8Array, arity: number): CursorFields => {
	const read = succeeded(readCursor(bytes, arity))
	assertVariant(read, "kind", "fields")
	return read
}

/** The fields of the task codec's token for (5, taskId). */
const taskFields = readFields(bytesOf(succeeded(taskCodec.encode([5, taskId]))), 2)

const digestGen: Gen<DigestBytes> = map(
	bytes({ min: cursorDigestBytes, max: cursorDigestBytes }),
	DigestBytes
)

/**
 * The respects a token can be wrong in, in the order validation checks them (codec/cursor/fault.ts): its kind, its
 * size, its encoding, its layout, its generation, query and comparators, its tuple's count against them,
 * and a value's reading. A token of an order with another number of comparators is cursorComparator,
 * so the count is checked after the comparators: only a forged token whose comparator digest matches reaches it.
 */
const validationOrder = [
	"kind",
	"size",
	"encoding",
	"layout",
	"generation",
	"query",
	"comparators",
	"count",
	"value"
] as const
type Fault = (typeof validationOrder)[number]

const faultReasons: Readonly<Record<Fault, CursorFault>> = {
	kind: "cursorType",
	size: "cursorOversized",
	encoding: "cursorEncoding",
	layout: "cursorMalformed",
	generation: "cursorGeneration",
	query: "cursorQuery",
	comparators: "cursorComparator",
	count: "cursorMalformed",
	value: "cursorValue"
}

type Comparators = ReadonlyArray<CursorComparator>

/**
 * A codec under test and its bound, its token's fields, the fields its token would have under another generation,
 * query or order, a text of its first value that the value's reading refuses, and the texts no refusal may carry.
 */
interface Subject {
	readonly codec: CursorCodec<Comparators>
	readonly maxBytes: number
	readonly fields: CursorFields
	readonly other: Omit<CursorFields, "tuple">
	readonly unreadable: Uint8Array
	readonly secrets: ReadonlyArray<string>
}

const subject = (
	spec: CursorSpec<Comparators>,
	tuple: ReadonlyArray<unknown>,
	unreadable: Uint8Array,
	secrets: ReadonlyArray<string>
): Subject => {
	const tokenOf = (s: CursorSpec<Comparators>): string =>
		succeeded(succeeded(cursorCodec(s, cursorTokenMaxLength, cursorCodes)).admit(tuple))
	const fieldsOf = (s: CursorSpec<Comparators>): CursorFields =>
		readFields(bytesOf(tokenOf(s)), s.comparators.length)
	/**
	 * Twice the token's length, which every planting but an oversized one stays within: the most any other adds is a
	 * copy of one value, a trailing byte and a padding character, beside an unreadable value of a few bytes.
	 */
	const maxBytes = 2 * tokenOf(spec).length
	const [first, ...rest] = spec.comparators
	const flipped: Comparators =
		first === undefined ? [] : [{ ...first, direction: opposite(first.direction) }, ...rest]
	return {
		codec: succeeded(cursorCodec(spec, maxBytes, cursorCodes)),
		maxBytes,
		fields: fieldsOf(spec),
		other: {
			generation: fieldsOf({
				...spec,
				generation: { schema: "schema-fingerprint-0", extensions: {} }
			}).generation,
			query: fieldsOf({ ...spec, query: `${spec.query}-other` }).query,
			comparators: fieldsOf({ ...spec, comparators: flipped }).comparators
		},
		unreadable,
		secrets
	}
}

const subjects: Arr.NonEmptyReadonlyArray<Subject> = [
	subject(taskSpec, [5, taskId], utf8("x5"), [taskId]),
	subject(
		{
			query: "q-title",
			comparators: [{ field: "title", direction: "asc", type: cursorCodecTypes.text }],
			generation
		},
		["SECRET-TITLE-VALUE"],
		Uint8Array.of(0xc0, 0x80),
		["SECRET-TITLE-VALUE"]
	),
	subject(
		{
			query: "q-amounts",
			comparators: [
				{ field: "amount", direction: "desc", type: cursorCodecTypes.int8 },
				{ field: "kind", direction: "asc", type: cursorCodecTypes.kind }
			],
			generation
		},
		[123456789012n, "Ünïcode"],
		utf8("12.5"),
		["123456789012", "Ünïcode"]
	),
	subject(
		{
			query: "q-id",
			comparators: [{ field: "id", direction: "asc", type: cursorCodecTypes.uuid }],
			generation
		},
		[taskId],
		utf8("not-a-uuid"),
		[taskId]
	)
]

/**
 * One token to plant: a subject and the respects it is wrong in, with which layout and count defect when it has one.
 */
interface Planting {
	readonly subject: Subject
	readonly faults: ReadonlySet<Fault>
	readonly layout: "trailing byte" | "truncated"
	readonly count: "short" | "long"
}

/** Every subject, every set of respects, and every layout and count defect where the set holds one. */
const plantings: Gen<Planting> = (source) => {
	const subject = source.draw(element(subjects))
	const faults: ReadonlySet<Fault> = new Set(source.draw(subarray(validationOrder)))
	return {
		subject,
		faults,
		layout: source.draw(
			element<Planting["layout"]>(
				faults.has("layout") ? ["trailing byte", "truncated"] : ["trailing byte"]
			)
		),
		count: source.draw(
			element<Planting["count"]>(faults.has("count") ? ["short", "long"] : ["short"])
		)
	}
}

/**
 * The value a planting hands decode: the token's fields wrong in their respects, its bytes in theirs, its text in its
 * own, and anything but a string for the wrong kind.
 */
const planted = ({ subject: s, faults, layout, count }: Planting): unknown => {
	const has = (fault: Fault) => faults.has(fault)
	const [value, ...values] = s.fields.tuple
	const valued = has("value") && value !== undefined ? [s.unreadable, ...values] : s.fields.tuple
	const counted = !has("count")
		? valued
		: count === "short"
			? valued.slice(0, -1)
			: [...valued, ...valued.slice(0, 1)]
	const fields: CursorFields = {
		generation: has("generation") ? s.other.generation : s.fields.generation,
		query: has("query") ? s.other.query : s.fields.query,
		comparators: has("comparators") ? s.other.comparators : s.fields.comparators,
		tuple: counted
	}
	const whole = writeCursor(fields)
	const laid = !has("layout")
		? whole
		: layout === "trailing byte"
			? Uint8Array.from([...whole, 0])
			: whole.slice(0, -1)
	const text = base64urlEncode(laid)
	const encoded = has("encoding") ? `${text}=` : text
	const sized = has("size")
		? `${encoded}${Str.repeat(Math.max(1, s.maxBytes + 1 - encoded.length))("A")}`
		: encoded
	return has("kind") ? [sized] : sized
}

describe("validation before any SQL, in order", () => {
	const token = succeeded(taskCodec.encode([5, taskId]))

	it.effect(
		"reports the first fault in validation order of a token wrong in any set of respects, and never a value or the token",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "every subject, every set of the respects a token can be wrong in, and every layout and count defect of a set that holds one",
						oracle: {
							kind: "specification",
							name: "the validation order: a token wrong in many respects reports the first"
						},
						suite: "unit/cursor/validation-order",
						generator: plantings,
						literal: Formatter.format,
						limit: 20_000,
						coverage: requiredInSpace<CursorFault | "accepted">([
							"accepted",
							...new Set(Rec.values(faultReasons))
						]),
						caseHang
					},
					(planting, c) =>
						Effect.sync(() => {
							const value = planted(planting)
							const first = Arr.findFirst(validationOrder, (fault) => planting.faults.has(fault))
							const result = planting.subject.codec.decode(value)
							if (Option.isNone(first)) {
								c.note("accepted")
								assert.ok(result.ok, "an unbroken token decodes")
								return
							}
							const expected = faultReasons[first.value]
							c.note(expected)
							assert.equal(
								!result.ok && result.error.reason._tag,
								expected,
								`planted ${Arr.join([...planting.faults], ", ")}`
							)
							if (result.ok) {
								return
							}
							const secrets = Arr.appendAll(
								planting.subject.secrets,
								typeof value === "string" ? [value] : []
							)
							for (const secret of secrets) {
								lacksText(Formatter.format(result.error), secret)
								lacksText(String(result.error), secret)
							}
						})
				)
			)
	)

	it.effect(
		"decodes arbitrary input, valid tokens changed at any byte and claims past the input to a cursor that encodes again, or refuses it with a vocabulary word, and never throws",
		(ctx) =>
			Effect.gen(function* () {
				/**
				 * Random text, of any UTF-16 code units, and bytes fail at the first checks; a valid token with up to three
				 * bytes changed, cut or extended reaches every later step, from the layout to a boundary value; and its digests
				 * followed by a count or a length claiming more than follows it reach the layout's claim check.
				 */
				const valid = bytesOf(token)
				const changed = map(
					(source) => ({
						edits: source.draw(
							array(
								(source) => ({
									at: source.draw(int(0, valid.length - 1)),
									byte: source.draw(int(0, 255))
								}),
								{ min: 1, max: 3 }
							)
						),
						length: source.draw(int(-4, 4))
					}),
					({ edits, length }) => {
						const bytes = Uint8Array.from(valid)
						for (const e of edits) {
							bytes[e.at] = e.byte
						}
						const sized =
							length < 0
								? bytes.slice(0, bytes.length + length)
								: Uint8Array.from([...bytes, ...new Uint8Array(length)])
						return base64urlEncode(sized)
					}
				)
				yield* searched(
					ctx,
					explore(
						{
							oracle: {
								kind: "universal",
								name: "decode is total: a cursor that encodes again, or a vocabulary refusal, never a throw"
							},
							suite: "unit/cursor/codec-total",
							draw: drawn(
								oneOf([
									string(codePoint(0x20, 0x7e), { min: 0, max: 200 }),
									string(codePoint(0, 0xff_ff), { min: 0, max: 200 }),
									map(bytes({ min: 0, max: 200 }), base64urlEncode),
									changed,
									map(claimGen, (claim) => base64urlEncode(claimBytes(taskFields, claim)))
								])
							),
							literal: Formatter.format,
							coverage: required<CursorFault>(
								[
									"cursorEncoding",
									"cursorMalformed",
									"cursorGeneration",
									"cursorQuery",
									"cursorComparator",
									"cursorValue"
								],
								{ cases: 5000, sense: notesOnly }
							),
							kept: [],
							runs: 5000,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(text, c) =>
							Effect.sync(() => {
								const result = taskCodec.decode(text)
								if (!result.ok) {
									assert.ok(result.error instanceof CursorError)
									c.note(result.error.reason._tag)
									return
								}
								/** A cursor that decodes is one of the order's: its values encode, and read back as themselves. */
								const reissued = succeeded(taskCodec.encode(result.value.values))
								assert.deepEqual(succeeded(taskCodec.decode(reissued)).texts, result.value.texts)
							})
					)
				)
			})
	)

	it.effect("refuses every single-byte change to the header", (ctx) =>
		Effect.gen(function* () {
			const bytes = bytesOf(token)
			yield* searched(
				ctx,
				exhaust(
					{
						box: "every header byte of a valid token, changed by 1 and by 0x80",
						oracle: {
							kind: "specification",
							name: "a token with a header byte changed is refused"
						},
						suite: "unit/cursor/header-bytes",
						generator: (source) =>
							[source.draw(int(0, headerBytes - 1)), source.draw(element([1, 0x80]))] as const,
						literal: Formatter.format,
						limit: headerBytes * 2,
						coverage: requiredInSpace<"a header byte changed">(["a header byte changed"]),
						caseHang
					},
					([i, delta], c) =>
						Effect.sync(() => {
							c.note("a header byte changed")
							const changed = Uint8Array.from(bytes)
							changed[i] = (at(changed, i) + delta) & 0xff
							assert.ok(!taskCodec.decode(base64urlEncode(changed)).ok, `byte ${i} + ${delta}`)
						})
				)
			)
		})
	)
})

/**
 * What the layout reads, each for a codec of an arity: arbitrary bytes, the bytes of arbitrary fields, or a claim past
 * what follows it.
 */
type LayoutCase =
	| { readonly kind: "arbitrary"; readonly bytes: Uint8Array; readonly arity: number }
	| { readonly kind: "written"; readonly fields: CursorFields; readonly arity: number }
	| { readonly kind: "claim"; readonly claim: Claim }

/** An arity a codec reads a tuple for: one of the few a test tuple holds. */
const arityGen: Gen<number> = int(0, 7)

const layoutCaseGen: Gen<LayoutCase> = oneOf<LayoutCase>([
	(source): LayoutCase => ({
		kind: "arbitrary",
		bytes: source.draw(bytes({ min: 0, max: 120 })),
		arity: source.draw(arityGen)
	}),
	(source): LayoutCase => {
		const tuple = source.draw(array(bytes({ min: 0, max: 40 }), { min: 0, max: 6 }))
		return {
			kind: "written",
			fields: {
				generation: source.draw(digestGen),
				query: source.draw(digestGen),
				comparators: source.draw(digestGen),
				tuple
			},
			arity: source.draw(
				weighted([
					[3, constant(tuple.length)],
					[1, arityGen]
				])
			)
		}
	},
	map(claimGen, (claim): LayoutCase => ({ kind: "claim", claim }))
])

/**
 * The arities a claim is read for: one that keeps the tuple's one value (1), and one that walks past it (0). Either way
 * the refusal is the comparison itself, the claim against the fewer bytes after it, so nothing of what it claims is
 * read or allocated, a claim of the largest varint over a few bytes included.
 */
const claimArities: ReadonlyArray<number> = [0, 1]

/** Every field of `fields`, as views of `input`'s own bytes: nothing of them was copied or built. */
const assertViews = (fields: CursorFields, input: Uint8Array): void => {
	for (const field of [fields.generation, fields.query, fields.comparators, ...fields.tuple]) {
		assert.equal(field.buffer, input.buffer)
		assert.ok(field.byteOffset + field.length <= input.byteOffset + input.length)
	}
}

type LayoutFeature =
	| "arbitrary"
	| "written"
	| "written another count"
	| "claim count"
	| "claim value"

describe("the layout over untrusted bytes", () => {
	it.effect(
		"reads any bytes into views of them that write them again, keeping a tuple's values only for a codec of its count, or refuses, and refuses a claim past what follows it without reading it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "universal",
							name: "write ∘ read = id over any bytes the layout reads, or a refusal"
						},
						suite: "unit/cursor/layout-untrusted",
						draw: drawn(layoutCaseGen),
						literal: Formatter.format,
						coverage: required<LayoutFeature>(
							["arbitrary", "written", "written another count", "claim count", "claim value"],
							{ cases: 3000, sense: notesOnly }
						),
						kept: [],
						runs: 3000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							switch (c.kind) {
								case "arbitrary": {
									k.note("arbitrary")
									const read = readCursor(c.bytes, c.arity)
									if (read.ok) {
										/** A tuple of another count is the same layout, read whole for a codec of its count. */
										const fields =
											read.value.kind === "fields"
												? read.value
												: readFields(c.bytes, read.value.count)
										assertViews(fields, c.bytes)
										assert.deepEqual(writeCursor(fields), c.bytes)
									} else if (read.error.kind === "claim") {
										assert.ok(read.error.claimed > read.error.remaining)
										assert.ok(read.error.remaining < c.bytes.length)
									}
									return
								}
								case "written": {
									const laid = writeCursor(c.fields)
									const read = succeeded(readCursor(laid, c.arity))
									const { generation, query, comparators, tuple } = c.fields
									if (c.arity === tuple.length) {
										k.note("written")
										assertVariant(read, "kind", "fields")
										assertViews(read, laid)
										assert.deepEqual(read, { kind: "fields", ...c.fields })
										return
									}
									k.note("written another count")
									assert.deepEqual(read, {
										kind: "count",
										generation,
										query,
										comparators,
										count: tuple.length
									})
									return
								}
								case "claim": {
									k.note(`claim ${c.claim.at}`)
									for (const arity of claimArities) {
										const refusal = failed(readCursor(claimBytes(taskFields, c.claim), arity))
										assert.deepEqual(
											refusal,
											{
												kind: "claim",
												claimed: c.claim.claimed,
												remaining: c.claim.tail.length
											},
											`arity ${arity}`
										)
									}
									return
								}
							}
						})
				)
			)
	)
})

/**
 * The stateless single-text token of a value of `valueBytes` UTF-8 bytes, from the layout: the header, the tuple
 * count, the value's varint length and its bytes (layout.ts).
 */
const stateless = (valueBytes: number, maxBytes: number) => {
	const length = base64urlLength(
		headerBytes + varintLength(1) + varintLength(valueBytes) + valueBytes
	)
	return { length, fits: length <= maxBytes }
}

/** A one-text codec whose tokens are at most `maxBytes` long. */
const codecUnder = (maxBytes: number) =>
	cursorCodec(
		{
			query: "q",
			comparators: [{ field: "v", direction: "asc", type: cursorCodecTypes.text }] as const,
			generation
		},
		maxBytes,
		cursorCodes
	)

/**
 * The largest bound the size tests draw: the bound is the codec's parameter, and production's, the layout's
 * cursorTokenMaxLength, decides exactly as a small one does. Bounds up to it pass every residue of a token's base64url
 * length mod 4 a thousand times, and a token at one is cheap to build.
 */
const drawnBoundMax = 4_096

/** A bound a one-text codec admits: from its shortest token up. */
const drawnBound: Gen<number> = int(
	succeeded(codecUnder(cursorTokenMaxLength)).bound.min,
	drawnBoundMax
)

describe("size limits (the codec's byte bound)", () => {
	/** The UTF-8 length of the longest text value whose stateless token fits within the limit. */
	const longestFitting = (maxBytes: number): number => {
		let n = 0
		while (stateless(n + 1, maxBytes).fits) {
			n++
		}
		return n
	}

	it.effect(
		"decodes every token encode issues near the limit, and refuses exactly the ones past it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "every token encode issues within the limit decodes, and exactly those past it are refused"
						},
						suite: "unit/cursor/codec-1607",
						draw: drawn((source) => {
							const maxBytes = source.draw(drawnBound)
							const n = longestFitting(maxBytes)
							return {
								maxBytes,
								scalars: source.draw(
									array(element(["x", "é", "€", "\u{1f600}"]), {
										min: Math.max(0, Math.floor(n / 4) - 8),
										max: n + 8
									})
								)
							}
						}),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ maxBytes, scalars }) =>
						Effect.sync(() => {
							const codec = succeeded(codecUnder(maxBytes))
							const value = Arr.join(scalars, "")
							const bytes = utf8(value).length
							const expected = base64urlLength(
								headerBytes + varintLength(1) + varintLength(bytes) + bytes
							)
							const token = codec.encode([value])
							if (expected <= maxBytes) {
								const issued = succeeded(token)
								assert.equal(issued.length, expected)
								assert.deepEqual(succeeded(codec.decode(issued)).values, [value])
							} else {
								refused(token, "cursorTupleOversized")
							}
						})
				)
			)
	)

	it.effect(
		"refuses an oversized tuple before writing it, under every limit a codec admits up to the layout's own",
		(ctx) =>
			Effect.gen(function* () {
				yield* searched(
					ctx,
					explore(
						{
							oracle: {
								kind: "specification",
								name: "an oversized tuple is refused before it is written"
							},
							suite: "unit/cursor/oversized-before-write",
							draw: drawn(drawnBound),
							literal: Formatter.format,
							coverage: noCoverage,
							kept: [],
							runs: 1_000,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(maxBytes) =>
							Effect.sync(() => {
								const k = longestFitting(maxBytes)
								const codec = succeeded(codecUnder(maxBytes))
								const edge = succeeded(codec.encode([Str.repeat(k)("x")]))
								assert.ok(edge.length <= maxBytes)
								assert.deepEqual(succeeded(codec.decode(edge)).values, [Str.repeat(k)("x")])
								refused(codec.encode([Str.repeat(k + 1)("x")]), "cursorTupleOversized")
							})
					)
				)
				/** At the layout's own bound, a value longer than every token, refused before its bytes are built. */
				const pastLayout = Str.repeat(cursorTokenMaxLength + 1)("x")
				refused(single(cursorCodecTypes.text).encode([pastLayout]), "cursorTupleOversized")
				/** The layout's bound is every codec's ceiling: a varint could not write a longer token's lengths. */
				const pastCeiling = codecUnder(cursorTokenMaxLength + 1)
				refused(pastCeiling, "UnsupportedOperation")
			})
	)

	it.effect(
		"builds an order under a limit exactly when its shortest token fits, and refuses only an oversized token",
		(ctx) =>
			Effect.gen(function* () {
				const bounded = {
					query: "q",
					comparators: [
						{
							field: "v",
							direction: "asc",
							type: scalarOf(f.regex("^.{0,250}.{0,250}$", "su"), {})
						}
					] as const,
					generation
				}
				const unbounded = succeeded(cursorCodec(bounded, cursorTokenMaxLength, cursorCodes)).bound
				yield* searched(
					ctx,
					explore(
						{
							oracle: {
								kind: "specification",
								name: "an order builds exactly when its shortest token fits the limit"
							},
							suite: "unit/cursor/build-limit",
							draw: drawn((source) => ({
								maxBytes: source.draw(int(16, drawnBoundMax)),
								spec: source.draw(element(["task" as const, "bounded" as const])),
								length: source.draw(int(0, 500))
							})),
							literal: Formatter.format,
							coverage: required<
								"refused at build" | "built, every token fits" | "built, a token may not fit"
							>(["refused at build", "built, every token fits", "built, a token may not fit"], {
								cases: 500,
								sense: notesOnly
							}),
							kept: [],
							runs: 500,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ maxBytes, spec, length }, c) =>
							Effect.sync(() => {
								if (spec === "task") {
									const built = cursorCodec(taskSpec, maxBytes, cursorCodes)
									const min = taskCodec.bound.min
									if (min > maxBytes) {
										c.note("refused at build")
										refused(built, "UnsupportedOperation")
									} else {
										succeeded(built)
									}
									return
								}
								const built = cursorCodec(bounded, maxBytes, cursorCodes)
								if (unbounded.min > maxBytes) {
									c.note("refused at build")
									refused(built, "UnsupportedOperation")
									return
								}
								const codec = succeeded(built)
								const max = codec.bound.max
								assertNot(max, "unbounded")
								c.note(max > maxBytes ? "built, a token may not fit" : "built, every token fits")
								assert.equal(codec.bound.fits, max <= maxBytes)
								const value = Str.repeat(length)("x")
								const tokenLength = base64urlLength(
									headerBytes + varintLength(1) + varintLength(length) + length
								)
								const token = codec.encode([value])
								if (tokenLength <= maxBytes) {
									assert.deepEqual(succeeded(codec.decode(succeeded(token))).values, [value])
								} else {
									refused(token, "cursorTupleOversized")
								}
							})
					)
				)
			})
	)
})

describe("per-value byte bounds behind the static token bound", () => {
	const within = <T extends ScalarType>(
		type: T,
		generator: Gen<CursorValue<T>>,
		extremes: ReadonlyArray<CursorValue<T>>,
		id: number
	) => {
		const codec = single(type)
		const max = cursorValueMaxBytes(type)
		const min = cursorValueMinBytes(type)
		assertNot(max, "unbounded")
		const tokenMax = codec.bound.max
		assertNot(tokenMax, "unbounded")
		return explore(
			{
				oracle: {
					kind: "specification",
					name: "each value's text within its carrier's per-value byte bounds, each token within the codec's static bound"
				},
				suite: `unit/cursor/codec-bytes-${id}`,
				/** Each carrier's extreme values, whose texts are its longest, are planted beside the drawn ones. */
				draw: drawn(
					Arr.isReadonlyArrayNonEmpty(extremes) ? oneOf([generator, element(extremes)]) : generator
				),
				literal: Formatter.format,
				coverage: noCoverage,
				kept: [],
				runs: 3000,
				shrink: completeShrink,
				concurrency: 1,
				steerEvery: 16,
				caseHang
			},
			(value) =>
				Effect.sync(() => {
					const token = codec.encode([value])
					if (!token.ok) {
						return
					}
					const text = at(succeeded(codec.decode(token.value)).texts, 0)
					const bytes = new TextEncoder().encode(text).length
					assert.ok(bytes <= max)
					assert.ok(bytes >= min)
					assert.ok(token.value.length <= tokenMax && token.value.length >= codec.bound.min)
				})
		)
	}

	it.effect("holds for every bounded carrier over arbitrary values", (ctx) =>
		Effect.gen(function* () {
			yield* searched(ctx, within(cursorCodecTypes.int2, int(-32768, 32767), [-32768, 32767], 1610))
			yield* searched(
				ctx,
				within(cursorCodecTypes.int4, int(-2147483648, 2147483647), [-2147483648], 1611)
			)
			yield* searched(
				ctx,
				within(cursorCodecTypes.int8, bigint(int8Min.value, int8Max.value), [int8Min.value], 1612)
			)
			yield* searched(
				ctx,
				within(
					cursorCodecTypes.float8,
					oneOf([anyDouble, nanOr(double(-1e-5, 1e-5))]),
					[
						-0.0000018606976450270172,
						-2.2250738585072014e-308,
						-Number.MAX_VALUE,
						Number.NEGATIVE_INFINITY
					],
					1613
				)
			)
			yield* searched(
				ctx,
				within(
					cursorCodecTypes.float4,
					oneOf([anyFloat, nanOr(float(Math.fround(-1e-5), Math.fround(1e-5)))]),
					[-1.1754942106924411e-38, Math.fround(-3.4e38)],
					1614
				)
			)
			yield* searched(
				ctx,
				within(
					cursorCodecTypes.money,
					map(bigint(int8Min.value, int8Max.value), (minor) => Money.of(minor)),
					[Money.min],
					1615
				)
			)
			/** Values filling each typmod's precision, beside arbitrary decimals the typmod rounds or refuses. */
			const scaled = (digits: bigint, scale: number) =>
				map(bigint(-(10n ** digits) + 1n, 10n ** digits - 1n), (n) => Decimal.of(`${n}e${-scale}`))
			yield* searched(
				ctx,
				within(
					cursorCodecTypes.numeric72,
					oneOf([scaled(7n, 2), decimalGen]),
					[Decimal.of("-99999.99")],
					1616
				)
			)
			yield* searched(
				ctx,
				within(
					cursorCodecTypes.numericNeg,
					oneOf([scaled(5n, -2), decimalGen]),
					[Decimal.of("-9999900")],
					1617
				)
			)
			yield* searched(
				ctx,
				within(
					cursorCodecTypes.numericSmall,
					oneOf([scaled(3n, 5), decimalGen]),
					[Decimal.of("-0.00999")],
					1618
				)
			)
			yield* searched(ctx, within(cursorCodecTypes.bool, boolean, [false], 1619))
			yield* searched(ctx, within(cursorCodecTypes.uuid, uuid(4), [], 1620))
			yield* searched(
				ctx,
				within(
					cursorCodecTypes.kind,
					element(["Manual", "Automatic", "Ünïcode"]),
					["Ünïcode"],
					1621
				)
			)
			yield* searched(
				ctx,
				within(
					cursorCodecTypes.range8,
					int8Span,
					[{ start: int8Min.value, end: int8Max.value }],
					1622
				)
			)
			yield* searched(
				ctx,
				within(
					cursorCodecTypes.vector3,
					map(array(float(-floatMax, floatMax), { min: 3, max: 3 }), (cs) =>
						Vector.make(Float32Array.from(cs), 3)
					),
					[
						Vector.make(
							Float32Array.of(
								-1.1754942106924411e-38,
								Math.fround(-(2 ** 16) / Math.sqrt(3)),
								1e-45
							),
							3
						)
					],
					1623
				)
			)
			yield* searched(
				ctx,
				within(
					cursorCodecTypes.title,
					map(
						string(
							oneOf([
								codePoint(0x20, 0x7e),
								codePoint(0xa0, 0xd7_ff),
								codePoint(0xe0_00, 0x10_ffff)
							]),
							{ min: 1, max: 40 }
						),
						(s) => Arr.join(Arr.take(Arr.fromIterable(s), 50), "")
					),
					[Str.repeat(50)("\u{10000}")],
					1624
				)
			)
		})
	)
})
