/** What the properties of identity.test.ts read: its spaces, models and helpers. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import {
	aimed,
	type Aimed,
	array,
	boolean,
	element,
	type Gen,
	int,
	map,
	oneOf,
	subarray,
	weighted
} from "@bjornpagen/testing/gen"
import { type Drawn, lsw, type WildKind } from "@bjornpagen/testing/lsw"
import type { Source } from "@bjornpagen/testing/source"
import { bigint, double, uuid } from "@bjornpagen/testing/values"
import { regex } from "arkregex"
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"
import type { ValueFault } from "#compiler/core/errors.ts"
import { rosterCodec } from "#compiler/ir/codes.ts"
import { Sha256 } from "#compiler/public/fields.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { cosineNormMax, cosineNormMin } from "#compiler/scalar/values/fault.ts"
import {
	type CarrierHost,
	type CarrierSpec,
	type HeadingField
} from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { plantedStringGen } from "#test/support/unit/values/support.ts"

/**
 * One carrier's admission, stated from its documented host type and range: what a value is stored as, the fault it
 * meets, or, where the documentation leaves the fault open, only that it is one of the vocabulary.
 */
type Verdict =
	| { readonly stored: CarrierHost[keyof CarrierHost] }
	| { readonly fault: ValueFault }
	| "a fault of the vocabulary"

interface Carrier {
	readonly spec: CarrierSpec
	readonly live: Gen<unknown>
	readonly judge: (value: unknown) => Verdict
}

const inRange = (value: number, bits: number): boolean =>
	value >= -(2 ** (bits - 1)) && value <= 2 ** (bits - 1) - 1

const smallInteger = (carrier: "int2" | "int4", bits: number): Carrier => ({
	spec: { carrier },
	live: oneOf<unknown>([
		int(-(2 ** (bits - 1)), 2 ** (bits - 1) - 1),
		element([
			-(2 ** (bits - 1)),
			2 ** (bits - 1) - 1,
			-0,
			2 ** (bits - 1),
			-(2 ** (bits - 1)) - 1,
			1.5
		])
	]),
	judge: (value) =>
		typeof value !== "number"
			? { fault: "integerType" }
			: !Number.isFinite(value)
				? "a fault of the vocabulary"
				: !Number.isInteger(value)
					? { fault: "integerType" }
					: !inRange(value, bits)
						? { fault: "integerRange" }
						: { stored: value === 0 ? 0 : value }
})

const hyphenated = regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "i")

/** SHA-256's digest length, the bytes a digest of no bytes holds. */
const digestLength = Sha256.ofBytes(new Uint8Array()).length

/** `length` drawn bytes. */
const bytesOf = (length: number): Gen<Uint8Array<ArrayBuffer>> =>
	map(array(int(0, 0xff), { min: length, max: length }), (bytes) => Uint8Array.from(bytes))

const handles: Arr.NonEmptyReadonlyArray<string> = ["draft", "paid", "Ünïcode"]

/** The handles' codes in a fresh installation: draft 0, paid 1, Ünïcode 2. */
const handleCodec = rosterCodec(
	parsedName("Status"),
	Arr.map(handles, (handle) => ({ kind: "live" as const, handle }))
)

/** Any double: finite ones, -0 and the subnormals among them, and now and then NaN or an infinity. */
const anyDouble: Gen<number> = weighted([
	[9, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
	[1, element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])]
])

/** The probed numeric's typmod, numeric(6, 2): values past either bound are near. */
const probeTypmod = { precision: 6, scale: 2 } as const

export const carriers: Arr.NonEmptyReadonlyArray<Carrier> = [
	smallInteger("int2", 16),
	smallInteger("int4", 32),
	{
		spec: { carrier: "int8" },
		live: oneOf<unknown>([
			bigint(-(2n ** 63n), 2n ** 63n - 1n),
			element([-(2n ** 63n), 2n ** 63n - 1n, 2n ** 63n, -(2n ** 63n) - 1n])
		]),
		judge: (value) =>
			typeof value !== "bigint"
				? { fault: "integerType" }
				: value < -(2n ** 63n) || value > 2n ** 63n - 1n
					? { fault: "integerRange" }
					: { stored: value }
	},
	{
		spec: { carrier: "float8" },
		live: anyDouble,
		judge: (value) => (typeof value !== "number" ? { fault: "floatType" } : { stored: value })
	},
	{
		spec: { carrier: "float4" },
		live: oneOf<unknown>([anyDouble, map(anyDouble, (x) => Math.fround(x))]),
		judge: (value) =>
			typeof value !== "number"
				? { fault: "floatType" }
				: Number.isNaN(value) || Math.fround(value) === value
					? { stored: value }
					: { fault: "realInexact" }
	},
	{
		spec: { carrier: "numeric", typmod: probeTypmod },
		live: oneOf<unknown>([
			(source) =>
				Decimal.of(`${source.draw(bigint(-(10n ** 9n), 10n ** 9n))}e-${source.draw(int(0, 4))}`),
			map(bigint(-(10n ** 6n), 10n ** 6n), (n) => Decimal.of(`${n}e-2`)),
			element<unknown>([Decimal.nan, Decimal.infinity, Decimal.negativeInfinity, 1.5, "1.5"])
		]),
		judge: (value) => {
			if (!(value instanceof Decimal)) {
				return { fault: typeof value === "number" ? "decimalNumber" : "decimalType" }
			}
			if (value.isNaN()) {
				return { stored: value }
			}
			if (value.isInfinite()) {
				return { fault: "numericInfinity" }
			}
			const [whole, fraction = ""] = Str.split(".")(Str.replace("-", "")(value.text))
			return fraction.length > probeTypmod.scale
				? { fault: "numericScale" }
				: BigInt(whole) >= 10n ** BigInt(probeTypmod.precision - probeTypmod.scale)
					? { fault: "numericOverflow" }
					: { stored: value }
		}
	},
	{
		spec: { carrier: "bool" },
		live: boolean,
		judge: (value) => (typeof value === "boolean" ? { stored: value } : { fault: "boolType" })
	},
	{
		spec: { carrier: "money" },
		live: map(bigint(-(2n ** 63n), 2n ** 63n - 1n), (n) => Money.of(n)),
		judge: (value) => (value instanceof Money ? { stored: value } : { fault: "moneyType" })
	},
	{
		spec: { carrier: "text" },
		live: map(plantedStringGen, (t) => t.value),
		judge: (value) =>
			typeof value !== "string"
				? { fault: "textType" }
				: Str.includes("\u0000")(value)
					? { fault: "textNul" }
					: !value.isWellFormed()
						? { fault: "textSurrogate" }
						: { stored: value }
	},
	{
		spec: { carrier: "uuid" },
		live: oneOf<unknown>([
			uuid(7),
			map(uuid(7), (u) => Str.toUpperCase(u)),
			element([
				"a0eebc999c0b4ef8bb6d6bb9bd380a11",
				"{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}",
				"a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a1g",
				"a0eebc99-9c0b4-ef8-bb6d-6bb9bd380a11",
				" a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
			])
		]),
		judge: (value) =>
			typeof value === "string" && hyphenated.test(value)
				? { stored: Str.toLowerCase(value) }
				: { fault: "uuidSyntax" }
	},
	{
		spec: { carrier: "sha256" },
		live: oneOf<unknown>([
			bytesOf(digestLength),
			map(int(0, 2 * digestLength), (length) => new Uint8Array(length)),
			element<unknown>([
				Uint8Array.from({ length: digestLength }, (_, i) => i).toHex(),
				Array.from({ length: digestLength }, () => 0),
				new Uint16Array(digestLength)
			])
		]),
		judge: (value) =>
			value instanceof Uint8Array && value.length === digestLength
				? { stored: Uint8Array.from(value) }
				: { fault: "sha256Value" }
	},
	{
		spec: { carrier: "code", roster: handleCodec, only: undefined },
		live: element<unknown>(Arr.appendAll(handles, ["Draft", "draft ", "", 1])),
		judge: (value) =>
			typeof value === "string" && handles.includes(value)
				? { stored: value }
				: { fault: "codeHandle" }
	},
	{
		spec: { carrier: "bits", roster: handleCodec },
		live: oneOf<unknown>([
			map(subarray(handles), (members) => new Set(members)),
			element<unknown>([new Set(["Draft"]), new Set([1]), ["draft"], "draft"])
		]),
		judge: (value) =>
			!(value instanceof Set)
				? { fault: "bitsType" }
				: Arr.some([...value], (m) => typeof m !== "string")
					? { fault: "bitsType" }
					: Arr.every([...value], (m) => typeof m === "string" && handles.includes(m))
						? { stored: value }
						: { fault: "bitsMember" }
	},
	{
		spec: { carrier: "vector", dimensions: 2 },
		live: map(
			array(
				element([
					0,
					1,
					-3,
					0.5,
					cosineNormMin,
					cosineNormMin / 2,
					cosineNormMax,
					-cosineNormMax,
					cosineNormMax * 2,
					Number.NaN
				]),
				{ min: 1, max: 3 }
			),
			(xs) => Float32Array.from(xs)
		),
		/**
		 * The cosine domain: vector_norm, the Euclidean norm summed in double precision in component order, in
		 * [cosineNormMin, cosineNormMax]. Each bound alone in a buffer of two is its own norm, and a bound with its
		 * neighbour or the greatest twice lies outside.
		 */
		judge: (value) => {
			if (!(value instanceof Float32Array)) {
				return { fault: "vectorType" }
			}
			const finite = value.every((x) => Number.isFinite(x))
			if (value.length !== 2) {
				return finite ? { fault: "vectorDimensions" } : "a fault of the vocabulary"
			}
			if (!finite) {
				return { fault: "vectorNonFinite" }
			}
			const norm = Math.sqrt(value.reduce((sum, x) => sum + x * x, 0))
			return norm >= cosineNormMin && norm <= cosineNormMax
				? { stored: Vector.make(value, 2) }
				: { fault: "vectorNorm" }
		}
	},
	spanCarrier("range4"),
	spanCarrier("range8")
]

/**
 * A span's admission over its endpoint's host kind (values/span.ts): exactly a { start, end } object, each endpoint an
 * integer of the endpoint type in range (int4 a JavaScript integer, int8 a bigint), and start < end; -0 is stored as 0.
 * Its live values plant the endpoint types' limits, an empty or reversed span, and the near-miss shapes a JavaScript
 * caller writes.
 */
function spanCarrier(carrier: "range4" | "range8"): Carrier {
	const endpointOk = (x: unknown): boolean =>
		carrier === "range4"
			? typeof x === "number" && Number.isInteger(x) && inRange(x, 32)
			: typeof x === "bigint" && x >= -(2n ** 63n) && x <= 2n ** 63n - 1n
	const endpoint: Gen<unknown> =
		carrier === "range4"
			? oneOf<unknown>([
					int(-(2 ** 31), 2 ** 31 - 1),
					element([-(2 ** 31), 2 ** 31 - 1, -0, 2 ** 31, 0.5])
				])
			: oneOf<unknown>([
					bigint(-(2n ** 63n), 2n ** 63n - 1n),
					element([-(2n ** 63n), 2n ** 63n - 1n, 2n ** 63n])
				])
	return {
		spec: { carrier, width: undefined },
		live: weighted<unknown>([
			[6, (source) => ({ start: source.draw(endpoint), end: source.draw(endpoint) })],
			[
				1,
				element<unknown>([
					null,
					[1, 2],
					{ start: 1 },
					{ start: 1, end: 2, guest: 3 },
					{ lower: 1, upper: 2 },
					new Map([["start", 1]]),
					"[1,2)"
				])
			]
		]),
		judge: (value) => {
			if (
				typeof value !== "object" ||
				value === null ||
				Arr.isArray(value) ||
				value instanceof Date
			) {
				return { fault: "spanType" }
			}
			const keys = Rec.keys(value)
			if (keys.length !== 2 || !("start" in value) || !("end" in value)) {
				return { fault: "spanType" }
			}
			const { start, end } = value
			if (!endpointOk(start) || !endpointOk(end)) {
				return { fault: "spanEndpoint" }
			}
			if (typeof start === "number" && typeof end === "number") {
				return start < end ? { stored: { start: start + 0, end: end + 0 } } : { fault: "spanOrder" }
			}
			if (typeof start === "bigint" && typeof end === "bigint") {
				return start < end ? { stored: { start, end } } : { fault: "spanOrder" }
			}
			return { fault: "spanEndpoint" }
		}
	}
}

/**
 * The values of every kind: every carrier's values, near misses included, under each other carrier, and every wild
 * kind but a hostile proxy and a throwing getter, which a JavaScript caller cannot build by mistake. A wild value is
 * read only by `passed`, inside the property.
 */
const hostWild: Arr.NonEmptyReadonlyArray<WildKind> = [
	"null",
	"undefined",
	"negative-zero",
	"nan",
	"infinity",
	"bigint-for-number",
	"number-for-bigint",
	"lone-surrogate",
	"nul-character",
	"symbol",
	"function",
	"anything"
]

const anyHostValue = lsw<unknown>({
	live: oneOf(Arr.map(carriers, (c) => c.live)),
	stale: Option.none(),
	wild: hostWild
})

export type AdmissionFeature = `${CarrierSpec["carrier"]} ${"stored" | "refused"}`

/** A carrier and the value offered to it, as the boundary is handed it. */
export type Admission = readonly [Carrier, Drawn<unknown, never>]

/** The carrier `c` offered a value of `offered`. */
const offeredTo =
	(c: Carrier, offered: Gen<Drawn<unknown, never>>): Gen<Admission> =>
	(source) => [c, source.draw(offered)]

/**
 * Each carrier offered its own live, wild or any carrier's value, aimed where a carrier has stored none yet at its own
 * live values, which its near misses and the values past its range share with the values it stores.
 */
export const admissionSpace: Aimed<Admission, AdmissionFeature> = aimed(
	oneOf(
		Arr.map(carriers, (c) =>
			offeredTo(
				c,
				oneOf([lsw<unknown>({ live: c.live, stale: Option.none(), wild: hostWild }), anyHostValue])
			)
		)
	),
	Arr.map(
		carriers,
		(c) =>
			[
				`${c.spec.carrier} stored`,
				offeredTo(
					c,
					map(c.live, (value): Drawn<unknown, never> => ({ kind: "live", value }))
				)
			] as const
	)
)

export const factOf = (f: {
	readonly id: string
	readonly cents: bigint
	readonly ratio: number
	readonly start: bigint
	readonly width: bigint
}) => ({
	id: f.id,
	amount: Decimal.of(`${f.cents}e-2`),
	ratio: Math.fround(f.ratio),
	during: { start: f.start, end: f.start + f.width }
})

/** The amount field's typmod: numeric(18, 2). */
export const amountType = { precision: 18, scale: 2 } as const

export const heading: ReadonlyArray<HeadingField> = [
	{ name: "id", spec: { carrier: "uuid" } },
	{ name: "amount", spec: { carrier: "numeric", typmod: amountType } },
	{ name: "ratio", spec: { carrier: "float4" } },
	{ name: "during", spec: { carrier: "range8", width: undefined } }
]

export const keys = nonEmpty(
	Arr.map(heading, (field) => field.name),
	"the heading's names"
)

/**
 * A fact rewritten as another spelling of its values (a uuid's case, a span's keys reordered, the fact's keys in
 * another order) has the fact's identity; one value changed has another. The admitted fact is frozen.
 */
export type FactRewrite = "uuid case" | "span keys reordered" | "fact keys reordered"

export type FactChange = "another amount" | "another span" | "another real"

export const factRewrites: Arr.NonEmptyReadonlyArray<FactRewrite> = [
	"uuid case",
	"span keys reordered",
	"fact keys reordered"
]

export const factChanges: Arr.NonEmptyReadonlyArray<FactChange> = [
	"another amount",
	"another span",
	"another real"
]

/** A double whose real is a normal value or zero: neither underflows nor overflows. */
const ratioGen: Gen<number> = weighted([
	[1, element([0, -0])],
	[
		9,
		(source) => {
			const magnitude = source.draw(double(1e-30, 1e30))
			return source.draw(boolean) ? -magnitude : magnitude
		}
	]
])

export const factGen = (source: Source) => ({
	id: source.draw(uuid(7)),
	cents: source.draw(bigint(-(10n ** 12n), 10n ** 12n)),
	ratio: source.draw(ratioGen),
	start: source.draw(bigint(-(10n ** 9n), 10n ** 9n)),
	width: source.draw(bigint(1n, 10n ** 6n))
})

/** A fact's fields set in `order`, each the value it holds. */
export const reordered = (
	fact: Readonly<Record<string, unknown>>,
	order: ReadonlyArray<string>
) => {
	const out: Record<string, unknown> = {}
	for (const key of order) {
		out[key] = fact[key]
	}
	return out
}

/**
 * A fact that is not exactly the heading is refused as factShape, naming the field a misspelt key stands for; a
 * value its field cannot hold is refused by its fault, naming the field; a heading that names a field twice admits
 * no fact.
 */
export type Malformed =
	| "an extra key"
	| "a missing key"
	| "a misspelt key"
	| "an array"
	| "null"
	| "a real past the range"
	| "a real no binary32 value holds"
	| "an amount past the precision"
	| "an amount past the scale"
	| "a heading naming a field twice"

export const malformations: Arr.NonEmptyReadonlyArray<Malformed> = [
	"an extra key",
	"a missing key",
	"a misspelt key",
	"an array",
	"null",
	"a real past the range",
	"a real no binary32 value holds",
	"an amount past the precision",
	"an amount past the scale",
	"a heading naming a field twice"
]

/**
 * Two digests a key compares: the second a copy of the first's bytes in an array of its own, or the first with one
 * byte, at a drawn place, another value.
 */
export interface DigestPair {
	readonly first: Uint8Array<ArrayBuffer>
	readonly second: Uint8Array<ArrayBuffer>
}

export type DigestFeature = "one digest in two arrays" | "digests one byte apart"

export const digestPairs: Gen<DigestPair> = (s) => {
	const first = s.draw(bytesOf(digestLength))
	const second = Uint8Array.from(first)
	if (s.draw(boolean)) {
		const at = s.draw(int(0, digestLength - 1))
		second[at] = ((second[at] ?? 0) + s.draw(int(1, 0xff))) & 0xff
	}
	return { first, second }
}
