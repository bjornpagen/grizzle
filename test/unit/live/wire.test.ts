/**
 * The wire's one table (live/wire.ts carrierWire): each carrier's JSON Schema, encode, exact parse and trusting decode
 * agree, over drawn specs of every carrier and drawn values of each spec's type.
 *
 * - Codec output: every value of a spec's type encodes to JSON its schema admits, as its one form does (a float's and a
 *   vector component's one zero, -0 as 0, ir/carriers.ts canonicalZero), which the parse reads back as that one form and
 *   the decode converts back to it. Oracle: the schema, judged by the validator the CLI generator pins
 *   (test/support/openapi/validator.ts), and the value's one form, compared by live/key.ts sameValue (Object.is).
 * - Exactness: over JSON near a value's spelling (one edit of its encoding, or a JSON value of another kind), the parse
 *   reads nothing its schema refuses, and every JSON its schema admits that the parse refuses is refused as one of the
 *   gaps that schema lists (`x-grizzle-gaps`), each named as its fault is (wireFaults, schemaGaps). Oracle: the schema
 *   and its enumerated gaps, the specification of what the wire's parse takes.
 * - The host door: the wire's parse reads exactly what the host door (scalar/values/identity.ts parseValue, every
 *   caller's value's one door) reads: every value of a type the host door reads, its one form unchanged, the wire reads
 *   back from its JSON as that one form, and every JSON the wire reads, the host door reads, its one form unchanged.
 *   Oracle: a differential with parseValue.
 *
 * Features: every carrier, a numeric under a typmod and a computed numeric, a negative scale, a scale past the
 * precision, zero of a numeric below one, NaN and the infinities of a float, a fixed-width span, a set of handles, a
 * negative zero, a JSON refused by schema and parse alike, a JSON a schema admits and the parse refuses as a gap.
 *
 * Kept: the live test phase's counterexamples at 729f76a6, a vector holding a -0 component, which the oracle compared
 * by Object.is to the 0 the wire spells it as; and at 9ef5c380, zero of a computed numeric below one and "0" read as a
 * numeric(1, 2), whose parse raised 10 to a negative power.
 *
 * Plants (~/.cache/grizzle-release/LIVE-OPENAPI/plants): wire-bigint-number (int8's schema a JSON integer, its values
 * still strings), wire-vector-negative-zero (a vector's -0 component spelled as -0).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	bytes,
	characterOf,
	constant,
	element,
	type Gen,
	int,
	oneOf,
	string,
	subset,
	unicodeScalar
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint, double, uuid } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec, String as Str } from "effect"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import { int2Max, int2Min, int4Max, int4Min, int8Max, int8Min } from "#compiler/core/limits.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { binary32Max, canonicalZero, moneyFractionDigits } from "#compiler/ir/carriers.ts"
import { codecOf, firstCodebook } from "#compiler/ir/codes.ts"
import { type CalendarDate, dateOfDayNumber, dayNumber } from "#compiler/ir/date.ts"
import { type Carrier, carriers, Roster } from "#compiler/ir/scalar.ts"
import { sameValue } from "#compiler/live/key.ts"
import {
	decodeScalar,
	encodeScalar,
	gapsKeyword,
	parseScalar,
	type SchemaGap,
	scalarSchema,
	schemaGaps,
	type WireJson,
	type WireScalar,
	type WireSpec,
	type WireWidth,
	wireFaults
} from "#compiler/live/wire.ts"
import { AdmittedBytes } from "#compiler/scalar/values/bytes.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { type CarrierSpec, parseValue } from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { schemaAdmits } from "#test/support/openapi/validator.ts"
import { upTo } from "#test/support/up-to.ts"

type Feature =
	| `the carrier ${Carrier}`
	| "a numeric under a typmod"
	| "a computed numeric"
	| "a negative scale"
	| "a scale past the precision"
	| "zero of a numeric below one"
	| "a float's NaN or infinity"
	| "a fixed-width span"
	| "a set of handles"
	| "a negative zero"
	| "a JSON refused by schema and parse alike"
	| "a JSON the schema admits and the parse refuses as a gap"

/** The handles a roster of a drawn spec holds, in code order: distinct names. */
const handlesGen: Gen<Arr.NonEmptyReadonlyArray<string>> = (source) => [
	"h0",
	...upTo(source.draw(int(0, 4)), (i) => `h${i + 1}`)
]

/** A span's width: free, or a fixed count of its endpoint's units. */
const widthGen: Gen<WireWidth> = oneOf<WireWidth>([
	constant({ kind: "free" }),
	(source) => ({ kind: "fixed", units: String(source.draw(int(1, 40))) })
])

/** A wire spec of `carrier`, its bounds and names drawn. */
const specOf =
	(carrier: Carrier): Gen<WireScalar> =>
	(source) => {
		switch (carrier) {
			case "int2":
			case "int4":
			case "int8":
			case "float4":
			case "float8":
			case "money":
			case "bool":
			case "uuid":
			case "date":
			case "text":
			case "bytes":
				return { carrier }
			case "numeric":
				return source.draw(boolean)
					? {
							carrier,
							numeric: {
								kind: "typmod",
								precision: source.draw(int(1, 30)),
								scale: source.draw(int(-4, 34))
							}
						}
					: {
							carrier,
							numeric: {
								kind: "bound",
								digits: source.draw(int(-3, 30)),
								scale: source.draw(int(0, 30))
							}
						}
			case "exactInteger":
			case "exactMoney":
				return { carrier, digits: source.draw(int(1, 30)) }
			case "code":
			case "bits":
				return { carrier, handles: source.draw(handlesGen) }
			case "range4":
			case "range8":
			case "rangeDate":
				return { carrier, width: source.draw(widthGen) }
			case "vector":
				return { carrier, dimensions: source.draw(int(1, 6)) }
		}
	}

/** A decimal of `units` units of 10^-scale, as numeric_in reads its exponent spelling. */
const decimalOf = (units: bigint, scale: number): Decimal =>
	succeeded(Decimal.fromString(`${units}e${-scale}`), "a decimal's exponent spelling")

/**
 * The integer digits of a numeric spec's values, each below 10^digits in magnitude: p - s for numeric(p, s), negative
 * for a type below one.
 */
const integerDigitsOf = (numeric: WireSpec<"numeric">["numeric"]): number =>
	numeric.kind === "typmod" ? numeric.precision - numeric.scale : numeric.digits

/** The decimals below 10^integerDigits whose digits past the scale are zero: units of 10^-scale, fewer than p + s digits. */
const decimalsGen = (integerDigits: number, scale: number): Gen<Decimal> => {
	const digits = integerDigits + scale
	if (digits <= 0) {
		return constant(Decimal.zero)
	}
	const most = 10n ** BigInt(digits) - 1n
	return (source) => decimalOf(source.draw(bigint(-most, most)), scale)
}

/** A binary32 number from -binary32Max to binary32Max, or a word naming a float JSON numbers cannot hold. */
const realGen: Gen<number> = oneOf<number>([
	(source) => Math.fround(source.draw(double(-binary32Max.value, binary32Max.value))),
	element([0, -0]),
	element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
])

/** A vector's component: a binary32 number of a vector's scale, or either zero. */
const componentGen: Gen<number> = oneOf<number>([
	(source) => Math.fround(source.draw(double(-1000, 1000))),
	element([0, -0])
])

/** The days of the calendar a date holds, as day numbers. */
const dayRange = { first: dayNumber("0001-01-01"), last: dayNumber("9999-12-31") } as const

/** A calendar date of the date carrier's range. */
const dateGen: Gen<CalendarDate> = (source) =>
	dateOfDayNumber(BigInt(source.draw(int(dayRange.first, dayRange.last))))

/** A span's endpoints over `lo..hi` units, start before end, `width` apart where fixed. */
const spanUnits =
	(lo: bigint, hi: bigint, width: WireWidth): Gen<readonly [bigint, bigint]> =>
	(source) => {
		const length = width.kind === "fixed" ? BigInt(width.units) : source.draw(bigint(1n, 1000n))
		const start = source.draw(bigint(lo, hi - length))
		return [start, start + length]
	}

/** A text PostgreSQL's text holds: scalars of every plane, NUL drawn as a letter. */
const textGen: Gen<string> = string(
	(source) => {
		const c = source.draw(unicodeScalar)
		return c === "\u0000" ? "a" : c
	},
	{ min: 0, max: 12 }
)

/** A value of `spec`'s type, as the server holds one. */
const valueOf =
	(spec: WireScalar): Gen<unknown> =>
	(source) => {
		switch (spec.carrier) {
			case "int2":
				return source.draw(int(int2Min.value, int2Max.value))
			case "int4":
				return source.draw(int(int4Min.value, int4Max.value))
			case "int8":
				return source.draw(bigint(int8Min.value, int8Max.value))
			case "numeric": {
				const numeric = spec.numeric
				if (numeric.kind === "typmod" && source.draw(int(0, 9)) === 0) {
					return Decimal.nan
				}
				return source.draw(decimalsGen(integerDigitsOf(numeric), numeric.scale))
			}
			case "float4":
				return source.draw(realGen)
			case "float8":
				return source.draw(
					oneOf<number>([
						double(-Number.MAX_VALUE, Number.MAX_VALUE),
						element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -0])
					])
				)
			case "money":
				return Money.of(source.draw(bigint(int8Min.value, int8Max.value)))
			case "exactInteger": {
				const most = 10n ** BigInt(spec.digits) - 1n
				return source.draw(bigint(-most, most))
			}
			case "exactMoney": {
				const most = 10n ** BigInt(spec.digits + moneyFractionDigits.value) - 1n
				return Money.exact(source.draw(bigint(-most, most)))
			}
			case "bool":
				return source.draw(boolean)
			case "uuid":
				return source.draw(uuid(4))
			case "date":
				return source.draw(dateGen)
			case "text":
				return source.draw(textGen)
			case "bytes":
				return new Uint8Array(source.draw(bytes({ min: 0, max: 12 })))
			case "code":
				return source.draw(element(spec.handles))
			case "bits": {
				const chosen = source.draw(subset(spec.handles, { min: 0, max: spec.handles.length }))
				return new Set(Arr.filter(spec.handles, (handle) => chosen.includes(handle)))
			}
			case "range4": {
				const [start, end] = source.draw(
					spanUnits(BigInt(int4Min.value), BigInt(int4Max.value), spec.width)
				)
				return Object.freeze({ start: Number(start), end: Number(end) })
			}
			case "range8": {
				const [start, end] = source.draw(spanUnits(int8Min.value, int8Max.value, spec.width))
				return Object.freeze({ start, end })
			}
			case "rangeDate": {
				const [start, end] = source.draw(
					spanUnits(BigInt(dayRange.first), BigInt(dayRange.last), spec.width)
				)
				return Object.freeze({ start: dateOfDayNumber(start), end: dateOfDayNumber(end) })
			}
			case "vector": {
				const components = source.draw(
					array(componentGen, {
						min: spec.dimensions,
						max: spec.dimensions
					})
				)
				const buffer = Float32Array.from(components)
				if (!Vector.inCosineDomain(buffer)) {
					buffer[0] = 1
				}
				return Vector.branded(buffer)
			}
		}
	}

/** A spec of a drawn carrier and a value of its type. */
interface Case {
	readonly spec: WireScalar
	readonly value: unknown
}

const caseGen: Gen<Case> = (source) => {
	const spec = source.draw(specOf(source.draw(element(carriers))))
	return { spec, value: source.draw(valueOf(spec)) }
}

/** The features a case exercises. */
const featuresOf = (c: Case): ReadonlyArray<Feature> => {
	const spec = c.spec
	const own: Array<Feature> = [`the carrier ${spec.carrier}`]
	if (spec.carrier === "numeric") {
		const numeric = spec.numeric
		own.push(numeric.kind === "typmod" ? "a numeric under a typmod" : "a computed numeric")
		if (numeric.scale < 0) {
			own.push("a negative scale")
		}
		if (numeric.kind === "typmod" && numeric.scale > numeric.precision) {
			own.push("a scale past the precision")
		}
		if (
			integerDigitsOf(numeric) < 0 &&
			c.value instanceof Decimal &&
			c.value.parts.kind === "finite" &&
			c.value.parts.coefficient === 0n
		) {
			own.push("zero of a numeric below one")
		}
	}
	if (typeof c.value === "number" && !Number.isFinite(c.value)) {
		own.push("a float's NaN or infinity")
	}
	if (
		(spec.carrier === "range4" || spec.carrier === "range8" || spec.carrier === "rangeDate") &&
		spec.width.kind === "fixed"
	) {
		own.push("a fixed-width span")
	}
	if (spec.carrier === "bits") {
		own.push("a set of handles")
	}
	if (holdsNegativeZero(c.value)) {
		own.push("a negative zero")
	}
	return own
}

/** Whether a value is a float's -0 or a vector holding one. */
const holdsNegativeZero = (value: unknown): boolean =>
	Object.is(value, -0) || (value instanceof Float32Array && value.some((x) => Object.is(x, -0)))

/**
 * A value in its one form: a float's and each vector component's one zero, -0 as 0 (ir/carriers.ts canonicalZero), the
 * value grizzle stores and delivers for either zero, which the wire spells as the one number 0.
 */
const oneForm = (value: unknown): unknown =>
	typeof value === "number"
		? canonicalZero(value)
		: value instanceof Float32Array
			? Vector.branded(Float32Array.from(value, canonicalZero))
			: value

/** Whether a value is a gap schemaGaps enumerates. */
const isSchemaGap = (value: unknown): value is SchemaGap =>
	Arr.some(schemaGaps, (gap) => gap === value)

/** Every gap a schema lists at any depth (`x-grizzle-gaps`), each one of schemaGaps. */
const gapsOf = (schema: unknown): ReadonlySet<SchemaGap> => {
	const out = new Set<SchemaGap>()
	const pending: Array<unknown> = [schema]
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		if (Arr.isArray(next)) {
			for (const item of next) {
				pending.push(item)
			}
		} else if (isRecord(next)) {
			for (const [key, member] of Rec.toEntries(next)) {
				if (key === gapsKeyword && Arr.isArray(member)) {
					for (const gap of member) {
						assert.ok(isSchemaGap(gap), `the gap ${String(gap)} is one of schemaGaps`)
						if (isSchemaGap(gap)) {
							out.add(gap)
						}
					}
				} else {
					pending.push(member)
				}
			}
		}
	}
	return out
}

/** One edit of a spelling: a character inserted, dropped or replaced from the spellings' own alphabet. */
const editGen =
	(text: string): Gen<string> =>
	(source) => {
		const at = source.draw(int(0, text.length))
		const c = source.draw(
			characterOf(["0", "1", "9", "-", "+", ".", "e", "E", " ", "a", "A", "=", "/", "N"])
		)
		switch (source.draw(int(0, 2))) {
			case 0:
				return `${Str.slice(0, at)(text)}${c}${Str.slice(at)(text)}`
			case 1:
				return `${Str.slice(0, at)(text)}${Str.slice(at + 1)(text)}`
			default:
				return `${Str.slice(0, at)(text)}${c}${Str.slice(at + 1)(text)}`
		}
	}

/** JSON near `json`, a value's spelling: one edit of it, a neighbour of a number, or a JSON value of another kind. */
const nearGen =
	(json: WireJson): Gen<WireJson> =>
	(source) => {
		const other = source.draw(
			element<WireJson>([
				null,
				true,
				0,
				-0.5,
				1.5,
				2 ** 53,
				"",
				"0",
				"-0",
				"NaN",
				"Infinity",
				[],
				{}
			])
		)
		if (source.draw(int(0, 4)) === 0) {
			return other
		}
		if (typeof json === "string") {
			return source.draw(editGen(json))
		}
		if (typeof json === "number") {
			return json + source.draw(element([1, -1, 0.5, 2 ** 31, -(2 ** 31), 2 ** 15]))
		}
		if (isList(json)) {
			const items: ReadonlyArray<WireJson> = json
			const dropped = items.slice(1)
			const doubled = [...items, ...items.slice(0, 1)]
			const edited = Arr.map(items, (item, i) =>
				i === 0 && typeof item === "number"
					? item + 0.5
					: i === 0 && typeof item === "string"
						? `${item}x`
						: item
			)
			return source.draw(element<WireJson>([dropped, doubled, edited, [...items, 0]]))
		}
		if (typeof json === "object" && json !== null) {
			const record = trusted<{ readonly [member: string]: WireJson }>(json)
			return source.draw(
				element<WireJson>([
					{ start: record["end"] ?? null, end: record["start"] ?? null },
					{ ...record, extra: 0 },
					{ start: record["start"] ?? null }
				])
			)
		}
		return other
	}

/** The host door's spec of a wire spec (scalar/values/identity.ts CarrierSpec), a roster's codes its first codebook's. */
const carrierSpecOf = (spec: WireScalar): CarrierSpec => {
	switch (spec.carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "exactInteger":
		case "exactMoney":
			return { carrier: spec.carrier }
		case "bytes":
			return { carrier: "bytes" }
		case "numeric":
			return {
				carrier: "numeric",
				typmod:
					spec.numeric.kind === "typmod"
						? { precision: spec.numeric.precision, scale: spec.numeric.scale }
						: undefined
			}
		case "code":
		case "bits": {
			const roster = Roster.of(succeeded(parseDeclaredName("Roster")), spec.handles)
			return { carrier: spec.carrier, roster: codecOf(firstCodebook([roster]), roster) }
		}
		case "range4":
		case "range8":
		case "rangeDate":
			return {
				carrier: spec.carrier,
				width: spec.width.kind === "fixed" ? BigInt(spec.width.units) : undefined
			}
		case "vector":
			return { carrier: "vector", dimensions: spec.dimensions }
	}
}

/** A host value as its one form compares it: an admitted bytes value by its bytes. */
const hostForm = (value: unknown): unknown => (value instanceof AdmittedBytes ? value.bytes : value)

/** The fault kinds a parse refusal names, each a WireFaultKind (wireFaults). */
const isFault = (kind: string): boolean => Arr.some(wireFaults, (f) => f === kind)

describe("the wire's one table", () => {
	it.effect(
		"encodes every value of a type to JSON its schema admits, which the parse and the decode read back",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the carrier's JSON Schema, judged by the pinned validator, and the value itself by its one form"
						},
						suite: "unit/live/wire-codec",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								...Arr.map(carriers, (carrier): Feature => `the carrier ${carrier}`),
								"a numeric under a typmod",
								"a computed numeric",
								"a negative scale",
								"a scale past the precision",
								"zero of a numeric below one",
								"a float's NaN or infinity",
								"a fixed-width span",
								"a set of handles",
								"a negative zero"
							],
							{ cases: 1500, sense: notesOnly }
						),
						kept: [
							{
								note: "a vector holding a -0 component, spelled and read back as 0 (wire-codec, live test phase 729f76a6)",
								sketch: {
									spec: { carrier: "vector", dimensions: 6 },
									value: Vector.branded(Float32Array.from([1, -0, 0, 0, 0, 0]))
								},
								draws: "",
								reaches: ["the carrier vector", "a negative zero"]
							},
							{
								note: "zero of a computed numeric below one, whose parse raised 10 to a negative power (wire-codec, live test phase 9ef5c380)",
								sketch: {
									spec: { carrier: "numeric", numeric: { kind: "bound", digits: -1, scale: 0 } },
									value: Decimal.zero
								},
								draws: "",
								reaches: [
									"the carrier numeric",
									"a computed numeric",
									"zero of a numeric below one"
								]
							}
						],
						runs: 1500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, notes) =>
						Effect.gen(function* () {
							notes.noteAll(featuresOf(c))
							const json = encodeScalar(c.spec, c.value)
							const schema = scalarSchema(c.spec)
							const admitted = yield* schemaAdmits(schema, json, 0)
							assert.ok(
								admitted,
								`the schema ${Formatter.format(schema)} admits ${Formatter.format(json)}`
							)
							const parsed = succeeded(
								parseScalar(c.spec, json),
								`the parse reads ${Formatter.format(json)}`
							)
							assert.ok(
								sameValue(json, encodeScalar(c.spec, oneForm(c.value))),
								"the value encodes as its one form does, -0 as 0"
							)
							assert.ok(
								sameValue(parsed, oneForm(c.value)),
								"the parse reads back the value's one form"
							)
							assert.ok(
								sameValue(decodeScalar(c.spec, json), oneForm(c.value)),
								"the decode converts back the value's one form"
							)
						})
				)
			)
	)

	it.effect(
		"parses nothing its schema refuses, and refuses what its schema admits only as one of the schema's gaps",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the carrier's JSON Schema and the gaps it lists, the language the wire's parse takes"
						},
						suite: "unit/live/wire-exact",
						draw: drawn((source) => {
							const c = source.draw(caseGen)
							return { ...c, near: source.draw(nearGen(encodeScalar(c.spec, c.value))) }
						}),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								...Arr.map(carriers, (carrier): Feature => `the carrier ${carrier}`),
								"a JSON refused by schema and parse alike",
								"a JSON the schema admits and the parse refuses as a gap"
							],
							{ cases: 3000, sense: notesOnly }
						),
						kept: [
							{
								note: '"0" read as a numeric(1, 2), whose parse raised 10 to a negative power (wire-exact, live test phase 9ef5c380)',
								sketch: {
									spec: {
										carrier: "numeric",
										numeric: { kind: "typmod", precision: 1, scale: 2 }
									},
									value: Decimal.nan,
									near: "0"
								},
								draws: "",
								reaches: ["the carrier numeric"]
							}
						],
						runs: 3000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, notes) =>
						Effect.gen(function* () {
							notes.note(`the carrier ${c.spec.carrier}`)
							const schema = scalarSchema(c.spec)
							const admitted = yield* schemaAdmits(schema, c.near, 0)
							const parsed = parseScalar(c.spec, c.near)
							if (parsed.ok) {
								assert.ok(
									admitted,
									`the parse reads ${Formatter.format(c.near)}, which ${Formatter.format(schema)} refuses`
								)
								return
							}
							assert.ok(
								isFault(parsed.error),
								`the parse's refusal ${parsed.error} is a WireFaultKind`
							)
							if (!admitted) {
								notes.note("a JSON refused by schema and parse alike")
								return
							}
							const gaps = gapsOf(schema)
							assert.ok(
								Arr.some([...gaps], (gap) => gap === parsed.error),
								`the schema admits ${Formatter.format(c.near)}, which the parse refuses as ${parsed.error}, no gap of ${Arr.join([...gaps], ", ")}`
							)
							notes.note("a JSON the schema admits and the parse refuses as a gap")
						})
				)
			)
	)
	it.effect(
		"parses to exactly what the host door parses: every value it reads the host door reads unchanged, and every value of a type reads back from its JSON",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "scalar/values/identity.ts parseValue, the one door for every caller's host value"
						},
						suite: "unit/live/wire-host-door",
						draw: drawn((source) => {
							const c = source.draw(caseGen)
							return { ...c, near: source.draw(nearGen(encodeScalar(c.spec, c.value))) }
						}),
						literal: Formatter.format,
						coverage: required<Feature>(
							Arr.map(carriers, (carrier): Feature => `the carrier ${carrier}`),
							{ cases: 2000, sense: notesOnly }
						),
						kept: [
							{
								note: "a vector holding a -0 component, which the wire reads back as 0 (wire-host-door, live test phase 729f76a6)",
								sketch: {
									spec: { carrier: "vector", dimensions: 3 },
									value: Vector.branded(Float32Array.from([1, -0, 0])),
									near: null
								},
								draws: "",
								reaches: ["the carrier vector"]
							}
						],
						runs: 2000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, notes) =>
						Effect.sync(() => {
							notes.note(`the carrier ${c.spec.carrier}`)
							const door = carrierSpecOf(c.spec)
							const own = succeeded(
								parseValue(door, c.value),
								"the host door reads a value of the type"
							)
							assert.ok(
								sameValue(oneForm(hostForm(own)), oneForm(c.value)),
								"the host door reads the value, its one form unchanged"
							)
							const back = succeeded(
								parseScalar(c.spec, encodeScalar(c.spec, c.value)),
								"the wire reads its JSON"
							)
							assert.ok(
								sameValue(back, oneForm(hostForm(own))),
								"the wire reads back the one form of the value the host door reads"
							)
							const parsed = parseScalar(c.spec, c.near)
							if (!parsed.ok) {
								return
							}
							const host = succeeded(
								parseValue(door, parsed.value),
								`the host door reads what the wire read of ${Formatter.format(c.near)}`
							)
							assert.ok(
								sameValue(oneForm(hostForm(host)), parsed.value),
								"the host door reads it, its one form unchanged"
							)
						})
				)
			)
	)
})
