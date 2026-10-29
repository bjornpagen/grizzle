import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { features, noFeatures } from "@grizzle/testing/features"
import {
	boolean,
	characterOf,
	element,
	filter,
	type Gen,
	int,
	map,
	oneOf,
	option,
	string,
	weighted
} from "@grizzle/testing/gen"
import { type DrawnFeature, drawnFeature, lsw, passed, WILD_KINDS } from "@grizzle/testing/lsw"
import { matching } from "@grizzle/testing/pattern"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, pipe, String as Str } from "effect"
import { encode, everyProperty } from "#compiler/core/canonical.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import { DecimalText, isDecimalPayload } from "#compiler/ir/decimal.ts"
import {
	checkNumericTypmod,
	Decimal,
	normalizeNumeric,
	numericMaxDisplayScale,
	numericMaxIntegerDigits,
	roundedUnits
} from "#compiler/scalar/values/decimal.ts"
import { assert, faulted, succeeded } from "#test/support/assert.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { decimalGen, decimalText } from "#test/unit/values/support.ts"

import { regex } from "arkregex"
/**
 * An exact spelling numeric_in reads, with the canonical text of the value it reads (numeric_out at its display
 * scale) and what the spelling exercises.
 */
type SpellingFeature =
	| "signed"
	| "leading zeros"
	| "a bare point"
	| "an exponent"
	| "a zero"
	| "a special"

const spellingFeatures: ReadonlyArray<SpellingFeature> = [
	"signed",
	"leading zeros",
	"a bare point",
	"an exponent",
	"a zero",
	"a special"
]

interface Spelling {
	readonly text: string
	readonly canonical: string
	readonly features: ReadonlyArray<SpellingFeature>
}

const digitsOf = (max: number): Gen<string> => matching(regex.as(`^\\d{0,${max}}$`))

const exactSpelling: Gen<Spelling> = map(
	filter(
		(source) => ({
			sign: source.draw(element(["", "+", "-"])),
			whole: source.draw(digitsOf(6)),
			point: source.draw(boolean),
			fraction: source.draw(digitsOf(6)),
			exponent: Option.getOrUndefined(
				source.draw(
					option((inner) => ({
						e: inner.draw(int(-8, 8)),
						mark: inner.draw(element(["e", "E"])),
						plus: inner.draw(boolean)
					}))
				)
			)
		}),
		({ whole, point, fraction }) => whole.length + (point ? fraction.length : 0) > 0,
		10
	),
	({ sign, whole, point, fraction, exponent }): Spelling => {
		const frac = point ? fraction : ""
		const e = exponent === undefined ? 0 : exponent.e
		const scale = Math.max(0, frac.length - e)
		/**
		 * The digits as an integer at the display scale: digits * 10^(e - frac + scale), an integer since scale >= frac - e.
		 */
		const digits = `${whole}${frac}`
		const coefficient =
			BigInt(digits === "" ? "0" : digits) * 10n ** BigInt(e - frac.length + scale)
		const padded = pipe(coefficient.toString(), Str.padStart(scale + 1, "0"))
		const unsigned =
			scale === 0 ? padded : `${Str.slice(0, -scale)(padded)}.${Str.slice(-scale)(padded)}`
		const exponentText =
			exponent === undefined
				? ""
				: `${exponent.mark}${exponent.plus && e >= 0 ? "+" : ""}${exponent.e}`
		return {
			text: `${sign}${whole}${point ? "." : ""}${frac}${exponentText}`,
			canonical: sign === "-" && coefficient !== 0n ? `-${unsigned}` : unsigned,
			features: [
				...(sign === "" ? [] : ["signed" as const]),
				...(whole.length > 1 && Str.startsWith("0")(whole) ? ["leading zeros" as const] : []),
				...(point && (whole === "" || frac === "") ? ["a bare point" as const] : []),
				...(exponent === undefined ? [] : ["an exponent" as const]),
				...(coefficient === 0n ? ["a zero" as const] : [])
			]
		}
	}
)

const specialSpelling: Gen<Spelling> = element<Spelling>([
	{ text: "NaN", canonical: "NaN", features: ["a special"] },
	{ text: "Infinity", canonical: "Infinity", features: ["a special"] },
	{ text: "+Infinity", canonical: "Infinity", features: ["a special", "signed"] },
	{ text: "-Infinity", canonical: "-Infinity", features: ["a special", "signed"] }
])

const spellingGen: Gen<Spelling> = weighted([
	[9, exactSpelling],
	[1, specialSpelling]
])

/** One corruption no exact spelling survives, planted at a drawn position where it has one. */
type Corruption =
	| "a leading space"
	| "a trailing space"
	| "an underscore"
	| "a second point"
	| "a bare exponent mark"
	| "a hexadecimal prefix"
	| "a non-ASCII digit"
	| "a comma for the point"
	| "a misspelt special"
	| "a lone sign"

const corruptions: Arr.NonEmptyReadonlyArray<Corruption> = [
	"a leading space",
	"a trailing space",
	"an underscore",
	"a second point",
	"a bare exponent mark",
	"a hexadecimal prefix",
	"a non-ASCII digit",
	"a comma for the point",
	"a misspelt special",
	"a lone sign"
]

const corrupted = (text: string, corruption: Corruption, at: number): string => {
	const i = at % (text.length + 1)
	switch (corruption) {
		case "a leading space":
			return ` ${text}`
		case "a trailing space":
			return `${text} `
		case "an underscore":
			return `${Str.slice(0, i)(text)}_${Str.slice(i)(text)}`
		case "a second point":
			return `${text}..`
		case "a bare exponent mark":
			return `${text}e`
		case "a hexadecimal prefix":
			return `0x${text}`
		case "a non-ASCII digit":
			return `${text}١`
		case "a comma for the point":
			return `1,${Str.replace(regex("^[+-]"), "")(text)}`
		case "a misspelt special":
			return pickFrom(["inf", "nan", "infinity", "-NaN", "Inf"], at)
		case "a lone sign":
			return pickFrom(["", "-", "+", ".", "e5"], at)
	}
}

/** The order a difference states: -1, 0 or 1, never -0. */
const signOf = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0)

describe("Decimal parsing", () => {
	it.effect("reads every exact spelling to numeric_in's value and display scale", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/values/decimal-spelling",
					draw: drawn(spellingGen),
					literal: Formatter.format,
					features: features<SpellingFeature>(spellingFeatures),
					kept: [],
					runs: 2000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					steering: { kind: "none" },
					caseHang: Duration.minutes(2)
				},
				(spelling, c) =>
					Effect.sync(() => {
						for (const f of spelling.features) {
							c.note(f)
						}
						assert.equal(
							succeeded(Decimal.fromString(spelling.text)).toString(),
							spelling.canonical,
							spelling.text
						)
					})
			)
		)
	)

	it.effect("refuses every spelling one corruption breaks", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/values/decimal-corrupted",
					draw: drawn((source) => ({
						spelling: source.draw(spellingGen),
						corruption: source.draw(element(corruptions)),
						at: source.draw(pickGen)
					})),
					literal: Formatter.format,
					features: features<Corruption>(corruptions),
					kept: [],
					runs: 1000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					steering: { kind: "none" },
					caseHang: Duration.minutes(2)
				},
				({ spelling, corruption, at }, c) =>
					Effect.sync(() => {
						c.note(corruption)
						const text = corrupted(spelling.text, corruption, at)
						faulted(Decimal.fromString(text), "decimalSyntax", Formatter.format(text))
					})
			)
		)
	)

	it.effect("enforces PostgreSQL's numeric format limits, exactly at each", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const explored = yield* explore(
					{
						suite: "unit/values/decimal-limits",
						draw: drawn((source) => ({
							limit: source.draw(element(["display scale", "integer digits", "exponent"] as const)),
							past: source.draw(boolean),
							margin: source.draw(int(1, 4))
						})),
						literal: Formatter.format,
						features:
							features<`${"display scale" | "integer digits" | "exponent"} ${"at" | "past"}`>([
								"display scale at",
								"display scale past",
								"integer digits at",
								"integer digits past",
								"exponent at",
								"exponent past"
							]),
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					({ limit, past, margin }, c) =>
						Effect.sync(() => {
							c.note(`${limit} ${past ? "past" : "at"}`)
							const extra = past ? margin : 0
							const text =
								limit === "display scale"
									? `0.${Str.repeat(numericMaxDisplayScale - 1 + extra)("0")}1`
									: limit === "integer digits"
										? `9${Str.repeat(numericMaxIntegerDigits - 1 + extra)("9")}`
										: `1e${numericMaxIntegerDigits - 1 + extra}`
							if (past) {
								faulted(Decimal.fromString(text), "decimalRange")
							} else {
								succeeded(Decimal.fromString(text))
							}
						})
				)
				faulted(Decimal.fromString("1e1073741824"), "decimalRange")
				faulted(Decimal.fromString("1e-99999999999"), "decimalRange")
				faulted(Decimal.fromBigInt(10n ** 131072n), "decimalRange")
				faulted(Decimal.fromParts(false, 1n, 16384), "decimalRange")
				faulted(Decimal.fromParts(false, -1n, 0), "decimalType")
				return explored
			})
		)
	)

	it.effect("round-trips its own text exactly", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/values/decimal-1",
					draw: drawn(decimalGen),
					literal: Formatter.format,
					features: noFeatures,
					kept: [],
					runs: 2000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					steering: { kind: "none" },
					caseHang: Duration.minutes(2)
				},
				(x) =>
					Effect.sync(() => {
						const back = succeeded(Decimal.fromString(x.toString()))
						assert.equal(back.toString(), x.toString())
						assert.equal(back.scale, x.scale)
						assert.equal(back.equals(x), true)
					})
			)
		)
	)

	it.effect(
		"converts an output text, the text the parsed value writes, to that value at its display scale",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const spelling = oneOf<string>([
						matching(regex("^[+-]?[0-9]{0,4}(\\.[0-9]{0,4})?([eE][+-]?[0-9]{1,2})?$")),
						element([
							"NaN",
							"Infinity",
							"+Infinity",
							"-Infinity",
							"-0",
							"-0.00",
							"00",
							"0.",
							".5",
							""
						]),
						map(decimalGen, (x) => x.toString())
					])
					return yield* explore(
						{
							suite: "unit/values/decimal-2",
							draw: drawn(spelling),
							literal: Formatter.format,
							features: noFeatures,
							kept: [],
							runs: 2000,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							steering: { kind: "none" },
							caseHang: Duration.minutes(2)
						},
						(text) =>
							Effect.sync(() => {
								const parsed = Decimal.fromString(text)
								if (!parsed.ok || parsed.value.toString() !== text) {
									return
								}
								const converted = Decimal.fromOutput(text)
								assert.equal(converted.toString(), text)
								assert.equal(converted.kind, parsed.value.kind)
								assert.equal(converted.negative, parsed.value.negative)
								assert.equal(converted.coefficient, parsed.value.coefficient)
								assert.equal(converted.scale, parsed.value.scale)
							})
					)
				})
			)
	)
})

describe("Decimal identity and order", () => {
	it.effect("orders consistently with value identity", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/values/decimal-3",
					draw: drawn(
						(source) =>
							[source.draw(decimalGen), source.draw(decimalGen), source.draw(decimalGen)] as const
					),
					literal: Formatter.format,
					features: noFeatures,
					kept: [],
					runs: 2000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					steering: { kind: "none" },
					caseHang: Duration.minutes(2)
				},
				([a, b, c]) =>
					Effect.sync(() => {
						assert.equal(a.compare(b), signOf(-b.compare(a)))
						assert.equal(a.compare(b) === 0, a.identityText() === b.identityText())
						if (a.compare(b) <= 0 && b.compare(c) <= 0) {
							assert.ok(a.compare(c) <= 0)
						}
					})
			)
		)
	)
})

describe("Decimal in the canonical serializer", () => {
	it.effect("agrees with the IR's decimal payload grammar (ir/decimal.ts)", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				yield* explore(
					{
						suite: "unit/values/decimal-19182",
						draw: drawn(decimalGen),
						literal: Formatter.format,
						features: noFeatures,
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(x) =>
						Effect.sync(() => {
							const text = x.toString()
							assert.equal(isDecimalPayload(text), true)
							assert.equal(
								succeeded(encode(succeeded(DecimalText.make(text)), everyProperty)),
								succeeded(encode(x, everyProperty))
							)
						})
				)
				const candidate = string(
					characterOf(["0", "1", "9", ".", "-", "+", "e", "N", "a", "I", "n", "f", "i", "t", "y"]),
					{ min: 0, max: 12 }
				)
				return yield* explore(
					{
						suite: "unit/values/decimal-19183",
						draw: drawn(
							oneOf<string>([candidate, element(["NaN", "Infinity", "-Infinity", "-0", "0.00"])])
						),
						literal: Formatter.format,
						features: noFeatures,
						kept: [],
						runs: 5000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(text) =>
						Effect.sync(() => {
							assert.equal(isDecimalPayload(text), Decimal.fromCanonical(text).ok, text)
						})
				)
			})
		)
	)
})

const isInt = (x: unknown, min: number, max: number): x is number =>
	typeof x === "number" && Number.isInteger(x) && x >= min && x <= max

describe("numeric(p, s) normalization", () => {
	it.effect("validates the typmod list as numerictypmodin does: a null scale is no scale", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const entry = weighted<unknown>([
					[6, int(-1100, 1100)],
					[1, element<unknown>([-0, 0.5, 1.5, Number.NaN, "5", 2n, null, undefined])]
				])
				return yield* explore(
					{
						suite: "unit/values/numeric-typmod",
						draw: drawn(
							oneOf<readonly [unknown] | readonly [unknown, unknown]>([
								(source) => [source.draw(entry)],
								(source) => [source.draw(entry), source.draw(entry)]
							])
						),
						literal: Formatter.format,
						features: features<"admitted" | "refused" | "one element">([
							"admitted",
							"refused",
							"one element"
						]),
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(list, c) =>
						Effect.sync(() => {
							const [precision, scale] = list
							if (list.length === 1) {
								c.note("one element")
							}
							const scaleOk = list.length === 1 || isInt(scale, -1000, 1000)
							if (isInt(precision, 1, 1000) && scaleOk) {
								c.note("admitted")
								assert.deepEqual(succeeded(checkNumericTypmod(list)), {
									precision,
									scale: isInt(scale, -1000, 1000) ? scale + 0 : 0
								})
							} else {
								c.note("refused")
								faulted(checkNumericTypmod(list), "numericTypmod")
							}
						})
				)
			})
		)
	)

	it.effect("is idempotent and within a half unit of the input", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const typmod: Gen<{ readonly precision: number; readonly scale: number }> = (source) => ({
					precision: source.draw(int(1, 40)),
					scale: source.draw(int(-10, 45))
				})
				return yield* explore(
					{
						suite: "unit/values/decimal-4",
						draw: drawn((source) => [source.draw(decimalGen), source.draw(typmod)] as const),
						literal: Formatter.format,
						features: noFeatures,
						kept: [],
						runs: 3000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					([x, type]) =>
						Effect.sync(() => {
							const once = normalizeNumeric(x, type)
							if (!once.ok) {
								return
							}
							const n = once.value
							if (!x.isFinite() || !n.isFinite()) {
								return
							}
							assert.equal(succeeded(normalizeNumeric(n, type)).toString(), n.toString())
							assert.equal(n.scale, Math.max(type.scale, 0))
							/** |x - n| * 10^s <= 1/2, exactly: compare 2 * |x * 10^k - n * 10^k| with 10^(k - s) at a common k. */
							const k = Math.max(x.scale, n.scale, type.scale, 0)
							const xs = roundedUnits(x, k)
							const ns = roundedUnits(n, k)
							const diff = xs > ns ? xs - ns : ns - xs
							assert.equal(diff * 2n <= 10n ** BigInt(k - type.scale), true)
						})
				)
			})
		)
	)
})

describe("Decimal admission of a JavaScript caller's value", () => {
	it.effect(
		"parses a decimal string, refuses a value of no decimal host kind as decimalType, and admit raises only CompileError",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/values/decimal-wild",
						draw: drawn(lsw<string>({ live: decimalText, stale: Option.none(), wild: WILD_KINDS })),
						literal: Formatter.format,
						features: features<DrawnFeature<never>>([
							"live",
							...Arr.map(WILD_KINDS, (kind): DrawnFeature<never> => `wild ${kind}`)
						]),
						kept: [],
						/** Fourteen wild kinds beside the live arm: a few hundred cases reach every one many times over. */
						runs: 500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(d, c) =>
						Effect.sync(() => {
							c.note(drawnFeature(d))
							const value = passed(d)
							const parsed = Decimal.parse(value)
							if (d.kind === "live") {
								succeeded(parsed)
							}
							const host = typeof value
							if (host !== "string" && host !== "bigint" && host !== "number") {
								faulted(parsed, "decimalType")
							}
							if (typeof value === "number") {
								faulted(parsed, "decimalNumber")
							}
							if (typeof value === "bigint") {
								assert.equal(succeeded(parsed).toString(), value.toString())
							}
							if (parsed.ok) {
								assert.equal(Decimal.admit(value).equals(parsed.value), true)
							} else {
								assert.throws(() => Decimal.admit(value), isCompileError)
							}
						})
				)
			)
	)
})
