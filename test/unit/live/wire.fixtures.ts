/** What the properties of wire.test.ts read: its spaces, models and helpers. */

import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import {
	type Aimed,
	aimed,
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
} from "@bjornpagen/testing/gen"
import { bigint, double, uuid } from "@bjornpagen/testing/values"
import { Array as Arr, Record as Rec, String as Str } from "effect"
import { int4Max } from "#compiler/core/canonical.ts"
import { sha256Octets } from "#compiler/core/digest.ts"
import { parseDeclaredName } from "#compiler/core/identity.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { int2Max, int2Min, int4Min, int8Max, int8Min } from "#compiler/ir/carriers.ts"
import { codecOf, firstCodebook, variantLayout } from "#compiler/ir/codes.ts"
import { type CalendarDate, dateOfDayNumber, dayNumber } from "#compiler/ir/date.ts"
import { type Carrier, carriers, Roster } from "#compiler/ir/scalar.ts"
import {
	encodeScalar,
	gapsKeyword,
	type SchemaGap,
	schemaGaps,
	type WireJson,
	type WireScalar,
	type WireSpec,
	type WireWidth,
	wireFaults
} from "#compiler/live/wire.ts"
import { AdmittedBytes } from "#compiler/scalar/values/bytes.ts"
import { moneyFractionDigits, Numeric } from "#compiler/scalar/values/decimal.ts"
import { binary32Max } from "#compiler/scalar/values/float.ts"
import { type CarrierSpec } from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { succeeded } from "#test/support/assert.ts"
import { cidrValues, inetValues } from "#test/support/net-values.ts"
import { printed, raw, stored } from "#test/support/unit/values/search-document.fixtures.ts"
import { upTo } from "#test/support/up-to.ts"

export type Feature =
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
			case "inet":
			case "cidr":
			case "text":
			case "bytes":
			case "sha256":
			case "tsvector":
				return { carrier }
			case "numeric":
				return source.draw(boolean)
					? {
							carrier,
							numeric: {
								kind: "typmod",
								precision: source.draw(int(1, 30)),
								/** Scale 0 is numeric(p, 0)'s, an integer type the wire spells as the exact integer (live/member.ts wireScalarOf). */
								scale: source.draw(oneOf([int(-4, -1), int(1, 34)]))
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
			case "variant":
				return {
					carrier,
					arms: upTo(source.draw(int(1, 3)), (i) => ({
						handle: `a${i}`,
						fields: upTo(source.draw(int(0, 2)), (j) => ({
							name: `f${j}`,
							spec: source.draw(specOf(source.draw(element(armCarriers))))
						}))
					}))
				}
		}
	}

/** The carriers a drawn variant's arms hold fields of: an integer, a double, a text, a boolean and a closed id. */
const armCarriers = ["int4", "float8", "text", "bool", "code"] as const

/** A decimal of `units` units of 10^-scale, as numeric_in reads its exponent spelling. */
const decimalOf = (units: bigint, scale: number): Numeric =>
	succeeded(Numeric.fromString(`${units}e${-scale}`), "a decimal's exponent spelling")

/**
 * The integer digits of a numeric spec's values, each below 10^digits in magnitude: p - s for numeric(p, s), negative
 * for a type below one.
 */
const integerDigitsOf = (numeric: WireSpec<"numeric">["numeric"]): number =>
	numeric.kind === "typmod" ? numeric.precision - numeric.scale : numeric.digits

/** The decimals below 10^integerDigits whose digits past the scale are zero: units of 10^-scale, fewer than p + s digits. */
const decimalsGen = (integerDigits: number, scale: number): Gen<Numeric> => {
	const digits = integerDigits + scale
	if (digits <= 0) {
		return constant(Numeric.zero)
	}
	const most = 10n ** BigInt(digits) - 1n
	return (source) => decimalOf(source.draw(bigint(-most, most)), scale)
}

/** A binary32 number from -binary32Max to binary32Max, or a word naming a float JSON numbers cannot hold. */
const realGen: Gen<number> = oneOf<number>([
	(source) => Math.fround(source.draw(double(-binary32Max, binary32Max))),
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
				return source.draw(int(int2Min, int2Max))
			case "int4":
				return source.draw(int(int4Min, int4Max))
			case "int8":
				return source.draw(bigint(int8Min, int8Max))
			case "numeric": {
				const numeric = spec.numeric
				if (numeric.kind === "typmod" && source.draw(int(0, 9)) === 0) {
					return Numeric.nan
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
				return Money.of(source.draw(bigint(int8Min, int8Max)))
			case "exactInteger": {
				const most = 10n ** BigInt(spec.digits) - 1n
				return source.draw(bigint(-most, most))
			}
			case "exactMoney": {
				const most = 10n ** BigInt(spec.digits + moneyFractionDigits) - 1n
				return Money.exact(source.draw(bigint(-most, most)))
			}
			case "bool":
				return source.draw(boolean)
			case "uuid":
				return source.draw(uuid(4))
			case "date":
				return source.draw(dateGen)
			case "inet":
				return source.draw(inetValues)
			case "cidr":
				return source.draw(cidrValues)
			case "text":
				return source.draw(textGen)
			case "tsvector":
				return printed(stored(source.draw(raw)))
			case "bytes":
				return new Uint8Array(source.draw(bytes({ min: 0, max: 12 })))
			case "sha256":
				return new Uint8Array(source.draw(bytes({ min: sha256Octets, max: sha256Octets })))
			case "code":
				return source.draw(element(nonEmpty(spec.handles, "a drawn closed id's roster's handles")))
			case "bits": {
				const chosen = source.draw(subset(spec.handles, { min: 0, max: spec.handles.length }))
				return new Set(Arr.filter(spec.handles, (handle) => chosen.includes(handle)))
			}
			case "range4": {
				const [start, end] = source.draw(spanUnits(BigInt(int4Min), BigInt(int4Max), spec.width))
				return Object.freeze({ start: Number(start), end: Number(end) })
			}
			case "range8": {
				const [start, end] = source.draw(spanUnits(int8Min, int8Max, spec.width))
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
			case "variant": {
				const arm = source.draw(element(nonEmpty(spec.arms, "a drawn variant's arms")))
				const value: Record<string, unknown> = { tag: arm.handle }
				for (const field of arm.fields) {
					value[field.name] = source.draw(valueOf(field.spec))
				}
				return Object.freeze({ ...value, tag: arm.handle })
			}
		}
	}

/** A spec of a drawn carrier and a value of its type. */
interface WireCase {
	readonly spec: WireScalar
	readonly value: unknown
}

const caseGen: Gen<WireCase> = (source) => {
	const spec = source.draw(specOf(source.draw(element(carriers))))
	return { spec, value: source.draw(valueOf(spec)) }
}

/** The features a case exercises. */
export const featuresOf = (c: WireCase): ReadonlyArray<Feature> => {
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
			c.value instanceof Numeric &&
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
 * A value in its one form: a float as it is, either zero its own value, which the wire spells -0 by its word
 * (core/canonical.ts floatSpecialNames); a vector with each component's one zero, -0 as 0, the value pgvector's
 * components hold and the wire spells as the one number 0.
 */
export const oneForm = (value: unknown): unknown =>
	value instanceof Float32Array
		? Vector.branded(Float32Array.from(value, (x) => (x === 0 ? 0 : x)))
		: value

/** Whether a value is a gap schemaGaps enumerates. */
const isSchemaGap = (value: unknown): value is SchemaGap =>
	Arr.some(schemaGaps, (gap) => gap === value)

/** Every gap a schema lists at any depth (`x-grizzle-gaps`), each one of schemaGaps. */
export const gapsOf = (schema: unknown): ReadonlySet<SchemaGap> => {
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
export const carrierSpecOf = (spec: WireScalar): CarrierSpec => {
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
		case "inet":
		case "cidr":
		case "text":
		case "sha256":
		case "tsvector":
		case "exactMoney":
			return { carrier: spec.carrier }
		case "exactInteger":
			return { carrier: "exactInteger", typmod: undefined }
		case "bytes":
			return { carrier: "bytes" }
		case "numeric":
			return spec.numeric.kind === "typmod"
				? {
						carrier: "numeric",
						typmod: { precision: spec.numeric.precision, scale: spec.numeric.scale }
					}
				: {
						carrier: "numeric",
						typmod: undefined,
						bound: { digits: spec.numeric.digits, scale: spec.numeric.scale }
					}
		case "code": {
			const roster = Roster.of(succeeded(parseDeclaredName("Roster")), "ordered", spec.handles)
			return { carrier: "code", roster: codecOf(firstCodebook([roster]), roster), only: undefined }
		}
		case "bits": {
			const roster = Roster.of(succeeded(parseDeclaredName("Roster")), "ordered", spec.handles)
			return { carrier: "bits", roster: codecOf(firstCodebook([roster]), roster) }
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
		case "variant": {
			const roster = Roster.of(
				succeeded(parseDeclaredName("Roster")),
				"ordered",
				Arr.map(spec.arms, (arm) => arm.handle)
			)
			const codec = codecOf(firstCodebook([roster]), roster)
			const layout = variantLayout(
				spec.arms,
				codec.names,
				(f) => f.spec.carrier === "float4" || f.spec.carrier === "float8"
			)
			return {
				carrier: "variant",
				roster: codec,
				arms: new Map(
					Arr.map(layout, (arm) => [
						arm.handle,
						{
							fields: Arr.map(arm.fields, ({ field, at, zero }) => ({
								name: field.name,
								spec: carrierSpecOf(field.spec),
								at,
								zero
							}))
						}
					])
				),
				attributes:
					1 +
					Arr.reduce(layout, 0, (n, arm) =>
						Arr.reduce(arm.fields, n, (k, f) => k + (f.zero === undefined ? 1 : 2))
					)
			}
		}
	}
}

/** A host value as its one form compares it: an admitted bytes value by its bytes. */
export const hostForm = (value: unknown): unknown =>
	value instanceof AdmittedBytes ? value.bytes : value

/** The fault kinds a parse refusal names, each a WireFaultKind (wireFaults). */
export const isFault = (kind: string): boolean => Arr.some(wireFaults, (f) => f === kind)

/** A case, and JSON near its value's spelling (nearGen). */
export const nearCaseGen: Gen<WireCase & Readonly<{ near: WireJson }>> = (source) => {
	const c = source.draw(caseGen)
	return { ...c, near: source.draw(nearGen(encodeScalar(c.spec, c.value))) }
}

/** A numeric spec of a drawn typmod or bound, and a value of its type. */
const numericCaseGen =
	(numeric: Gen<WireSpec<"numeric">["numeric"]>): Gen<WireCase> =>
	(source) => {
		const spec: WireScalar = { carrier: "numeric", numeric: source.draw(numeric) }
		return { spec, value: source.draw(valueOf(spec)) }
	}

/**
 * Every carrier's specs and values, aimed while pending at a numeric of a negative scale, one whose scale passes its
 * precision, and zero of a numeric below one: a computed numeric whose integer digits and scale sum to none, whose
 * every value is zero.
 */
export const caseSpace: Aimed<WireCase, Feature> = aimed(caseGen, [
	[
		"a negative scale",
		numericCaseGen((source) => ({
			kind: "typmod",
			precision: source.draw(int(1, 30)),
			scale: source.draw(int(-4, -1))
		}))
	],
	[
		"a scale past the precision",
		numericCaseGen((source) => {
			const precision = source.draw(int(1, 30))
			return { kind: "typmod", precision, scale: source.draw(int(precision + 1, 34)) }
		})
	],
	[
		"zero of a numeric below one",
		numericCaseGen((source) => {
			const digits = source.draw(int(-3, -1))
			return { kind: "bound", digits, scale: source.draw(int(0, -digits)) }
		})
	]
])
