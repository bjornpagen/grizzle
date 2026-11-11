/**
 * A host value's admission and a fact's identity (scalar/values/identity.ts).
 *
 * - Admission: admitValue stores each carrier's value as its documented host type and range say, and refuses every
 *   other value, near misses and wild values of every kind, by its fault, never throwing; Uuid.parse admits exactly as
 *   the uuid carrier does. Oracle: each carrier's documentation as a judge of the value.
 * - Identity: a fact rewritten as PostgreSQL's coercion reads it alike (a uuid's case, digits below the amount's scale,
 *   a real's binary64, a span's keys or the fact's keys in another order) keeps its identity, and a fact changed past
 *   its coercion has another. Oracle: universal, a metamorphic relation.
 * - Refusal: a fact that is not exactly its heading is refused as factShape, naming the field a misspelt key stands
 *   for; a value its field cannot hold, by its fault and field; a heading naming a field twice admits no fact. Oracle:
 *   the heading's shape and each carrier's faults as a checker.
 *
 * Features: each carrier stored and refused; each rewrite and each change; each malformation.
 *
 * Plants: values-uuid-case (an upper-case uuid stored as written), values-identity-raw-part (a field's part of the
 * identity its value's own text rather than its canonical one), values-fact-field-unnamed (a field's fault names no
 * field).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	element,
	type Gen,
	int,
	map,
	oneOf,
	shuffled,
	subarray,
	weighted
} from "@grizzle/testing/gen"
import { lsw, passed, type WildKind } from "@grizzle/testing/lsw"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import type { Source } from "@grizzle/testing/source"
import { bigint, double, uuid } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, String as Str } from "effect"
import type { ValueFault } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import { binary32Max, cosineNormMax, cosineNormMin } from "#compiler/ir/carriers.ts"
import { rosterCodec } from "#compiler/ir/codes.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { isValueFault } from "#compiler/scalar/values/fault.ts"
import {
	admitValue,
	type CarrierHost,
	type CarrierSpec,
	factIdentity,
	type HeadingField
} from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { Uuid } from "#compiler/scalar/values/uuid.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { assert, faulted, nonEmpty, succeeded } from "#test/support/assert.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { plantedStringGen } from "#test/unit/values/support.ts"

import { regex } from "arkregex"
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

const carriers: Arr.NonEmptyReadonlyArray<Carrier> = [
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
		judge: (value) =>
			typeof value !== "number"
				? { fault: "floatType" }
				: { stored: Object.is(value, -0) ? 0 : value }
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
		spec: { carrier: "code", roster: handleCodec },
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
					cosineNormMin.value,
					cosineNormMin.value / 2,
					cosineNormMax.value,
					-cosineNormMax.value,
					cosineNormMax.value * 2,
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
			return norm >= cosineNormMin.value && norm <= cosineNormMax.value
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

type AdmissionFeature = `${CarrierSpec["carrier"]} ${"stored" | "refused"}`

describe("admitValue", () => {
	it.effect(
		"stores every value of each carrier as its host type and range say, and refuses every other by its fault, never throwing; Uuid.parse admits exactly as the uuid carrier does",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "each carrier's documented host type and range, judging the value"
						},
						suite: "unit/values/admission",
						draw: drawn(
							oneOf(
								Arr.map(
									carriers,
									(c) => (source) =>
										[
											c,
											source.draw(
												oneOf([
													lsw<unknown>({
														live: c.live,
														stale: Option.none(),
														wild: hostWild
													}),
													anyHostValue
												])
											)
										] as const
								)
							)
						),
						literal: Formatter.format,
						coverage: required<AdmissionFeature>(
							Arr.flatMap(carriers, (c): Arr.NonEmptyReadonlyArray<AdmissionFeature> => [
								`${c.spec.carrier} stored`,
								`${c.spec.carrier} refused`
							]),
							{ cases: 3000, sense: notesOnly }
						),
						kept: [],
						runs: 3000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([carrier, drawnValue], c) =>
						Effect.sync(() => {
							const value = passed(drawnValue)
							const verdict = carrier.judge(value)
							const result = admitValue(carrier.spec, value)
							c.note(`${carrier.spec.carrier} ${result.ok ? "stored" : "refused"}`)
							if (carrier.spec.carrier === "uuid") {
								assert.deepEqual(
									result,
									Uuid.parse(value),
									"Uuid.parse is the uuid carrier's admission"
								)
							}
							if (verdict === "a fault of the vocabulary") {
								if (!result.ok) {
									assert.ok(isValueFault(result.error))
								}
								return
							}
							if ("stored" in verdict) {
								assert.deepEqual(succeeded(result), verdict.stored)
							} else {
								faulted(result, verdict.fault)
							}
						})
				)
			)
	)
})

const factOf = (f: {
	readonly id: string
	readonly cents: bigint
	readonly ratio: number
	readonly start: bigint
	readonly width: bigint
}) => ({
	id: f.id,
	amount: Decimal.of(`${f.cents}e-2`),
	ratio: f.ratio,
	during: { start: f.start, end: f.start + f.width }
})

/** The amount field's typmod: numeric(18, 2). */
const amountType = { precision: 18, scale: 2 } as const

describe("factIdentity", () => {
	const heading: ReadonlyArray<HeadingField> = [
		{ name: "id", spec: { carrier: "uuid" } },
		{ name: "amount", spec: { carrier: "numeric", typmod: amountType } },
		{ name: "ratio", spec: { carrier: "float4" } },
		{ name: "during", spec: { carrier: "range8", width: undefined } }
	]
	const keys = nonEmpty(
		Arr.map(heading, (field) => field.name),
		"the heading's names"
	)

	/**
	 * A fact rewritten as PostgreSQL's coercion reads it the same (a uuid's case, an amount's digits below its scale, a
	 * real given as the binary64 it rounds from, a span's keys reordered, the fact's keys in another order) has the
	 * fact's identity; one value changed past its coercion has another. The admitted fact is frozen.
	 */
	type FactRewrite =
		| "uuid case"
		| "digits below the scale"
		| "a real's binary64"
		| "span keys reordered"
		| "fact keys reordered"
	type FactChange = "another amount" | "another span" | "another real"
	const factRewrites: Arr.NonEmptyReadonlyArray<FactRewrite> = [
		"uuid case",
		"digits below the scale",
		"a real's binary64",
		"span keys reordered",
		"fact keys reordered"
	]
	const factChanges: Arr.NonEmptyReadonlyArray<FactChange> = [
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
	const factGen = (source: Source) => ({
		id: source.draw(uuid(7)),
		cents: source.draw(bigint(-(10n ** 12n), 10n ** 12n)),
		ratio: source.draw(ratioGen),
		start: source.draw(bigint(-(10n ** 9n), 10n ** 9n)),
		width: source.draw(bigint(1n, 10n ** 6n))
	})

	/** A fact's fields set in `order`, each the value it holds. */
	const reordered = (fact: Readonly<Record<string, unknown>>, order: ReadonlyArray<string>) => {
		const out: Record<string, unknown> = {}
		for (const key of order) {
			out[key] = fact[key]
		}
		return out
	}

	it.effect(
		"gives facts PostgreSQL's coercion reads alike one identity, and a changed fact another",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "universal",
							name: "metamorphic: a rewrite PostgreSQL's coercion reads alike keeps the identity, a change past it moves it"
						},
						suite: "unit/values/fact-identity",
						draw: drawn((source) => ({
							fact: source.draw(factGen),
							same: source.draw(boolean),
							pick: source.draw(pickGen),
							digit: source.draw(int(0, 4)),
							order: source.draw(shuffled(keys, { min: keys.length, max: keys.length }))
						})),
						literal: Formatter.format,
						coverage: required<`same: ${FactRewrite}` | `changed: ${FactChange}`>(
							[
								...Arr.map(factRewrites, (r) => `same: ${r}` as const),
								...Arr.map(factChanges, (r) => `changed: ${r}` as const)
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ fact: drawnFact, same, pick, digit, order }, c) =>
						Effect.sync(() => {
							const fact = factOf(drawnFact)
							const admitted = succeeded(factIdentity(heading, fact))
							assert.ok(Object.isFrozen(admitted.fact))
							if (same) {
								const rewrite = pickFrom(factRewrites, pick)
								c.note(`same: ${rewrite}`)
								const rewritten =
									rewrite === "uuid case"
										? { ...fact, id: Str.toUpperCase(fact.id) }
										: rewrite === "digits below the scale"
											? { ...fact, amount: Decimal.of(`${drawnFact.cents}${digit}e-3`) }
											: rewrite === "a real's binary64"
												? { ...fact, ratio: Math.fround(fact.ratio) }
												: rewrite === "span keys reordered"
													? { ...fact, during: { end: fact.during.end, start: fact.during.start } }
													: reordered(fact, order)
								assert.deepEqual(
									succeeded(factIdentity(heading, rewritten)).identity,
									admitted.identity,
									rewrite
								)
							} else {
								const change = pickFrom(factChanges, pick)
								c.note(`changed: ${change}`)
								const changedFact =
									change === "another amount"
										? { ...fact, amount: Decimal.of(`${drawnFact.cents + 1n}e-2`) }
										: change === "another span"
											? { ...fact, during: { start: fact.during.start, end: fact.during.end + 1n } }
											: { ...fact, ratio: Math.fround(fact.ratio) === 0 ? 1 : -fact.ratio }
								assert.notDeepEqual(
									succeeded(factIdentity(heading, changedFact)).identity,
									admitted.identity,
									change
								)
							}
						})
				)
			)
	)

	/**
	 * A fact that is not exactly the heading is refused as factShape, naming the field a misspelt key stands for; a
	 * value its field cannot hold is refused by its fault, naming the field; a heading that names a field twice admits
	 * no fact.
	 */
	type Malformed =
		| "an extra key"
		| "a missing key"
		| "a misspelt key"
		| "an array"
		| "null"
		| "a real past the range"
		| "an amount past the precision"
		| "a heading naming a field twice"
	const malformations: Arr.NonEmptyReadonlyArray<Malformed> = [
		"an extra key",
		"a missing key",
		"a misspelt key",
		"an array",
		"null",
		"a real past the range",
		"an amount past the precision",
		"a heading naming a field twice"
	]
	it.effect(
		"refuses facts that are not exactly the heading, naming the field when there is one",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "a fact's shape against its heading, and each field's carrier fault, named by its field"
						},
						suite: "unit/values/fact-refusals",
						draw: drawn((source) => ({
							fact: source.draw(factGen),
							malformed: source.draw(element(malformations)),
							extra: source.draw(boolean),
							digits: source.draw(int(0, 4))
						})),
						literal: Formatter.format,
						coverage: required<Malformed>(malformations, { cases: 300, sense: notesOnly }),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ fact: drawnFact, malformed, extra, digits }, c) =>
						Effect.sync(() => {
							c.note(malformed)
							const fact = factOf(drawnFact)
							const { ratio: _, ...missing } = fact
							const duplicated = [...heading, { name: "id", spec: { carrier: "uuid" } } as const]
							const [h, value, refusal]: readonly [
								ReadonlyArray<HeadingField>,
								unknown,
								{ readonly fault: ValueFault; readonly field: string | undefined }
							] =
								malformed === "an extra key"
									? [heading, { ...fact, extra: 1 }, { fault: "factShape", field: undefined }]
									: malformed === "a missing key"
										? [heading, missing, { fault: "factShape", field: undefined }]
										: malformed === "a misspelt key"
											? [
													heading,
													{ ...missing, ratoi: fact.ratio },
													{ fault: "factShape", field: "ratio" }
												]
											: malformed === "an array"
												? [heading, [fact], { fault: "factShape", field: undefined }]
												: malformed === "null"
													? [heading, null, { fault: "factShape", field: undefined }]
													: malformed === "a real past the range"
														? [
																heading,
																{ ...fact, ratio: binary32Max.value * 2 },
																{ fault: "realOverflow", field: "ratio" }
															]
														: malformed === "an amount past the precision"
															? [
																	heading,
																	{
																		...fact,
																		amount: Decimal.of(
																			`1e${amountType.precision - amountType.scale + digits}`
																		)
																	},
																	{ fault: "numericOverflow", field: "amount" }
																]
															: [
																	duplicated,
																	extra ? { ...fact, extra: 1 } : fact,
																	{ fault: "factShape", field: undefined }
																]
							assert.deepEqual(factIdentity(h, value), Result.err(refusal))
						})
				)
			)
	)
})
