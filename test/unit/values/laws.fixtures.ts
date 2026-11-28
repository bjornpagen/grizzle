/** What the properties of laws.test.ts read: its spaces, models and helpers. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import {
	aimed,
	type Aimed,
	array,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	option
} from "@bjornpagen/testing/gen"
import { bigint } from "@bjornpagen/testing/values"
import { Array as Arr, Option, String as Str } from "effect"
import { type FieldDesc, pgScalarNames } from "#compiler/ir/desc.ts"
import { type DeclaredType, languageOfText, languageWithin, textOf } from "#compiler/ir/scalar.ts"
import { int4, int8, numeric } from "#compiler/public/fields.ts"
import { str } from "#compiler/public/text.ts"
import { Numeric, type DecimalParts, type FiniteParts } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { makeSpan } from "#compiler/scalar/values/span.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { textLookup } from "#compiler/text/refinement.ts"
import { succeeded } from "#test/support/assert.ts"
import { f, textDesc } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { Id } from "#test/support/ids.ts"
import { decimalGen, numericText } from "#test/support/unit/values/support.ts"

/** Groups of spellings of one Numeric value, and values alone. */
const decimalGroups: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<string>> = [
	["0", "-0", "0.000", "+0", "0e5", "-0.0"],
	["1", "1.0", "1.00", "+1", "1e0", "10e-1", "0.1e1"],
	["-1.5", "-1.50", "-15e-1"],
	["120.05", "120.0500", "12005e-2"],
	["1000", "1e3", "1000.000"],
	["NaN"],
	["Infinity", "+Infinity"],
	["-Infinity"],
	["0.1"],
	["0.10000000000000000001"]
]

const decimalOf = (text: string): Numeric => succeeded(Numeric.fromString(text))

/** A value drawn from the dictionary or generated. */
const dictionaryDecimal: Gen<Numeric> = (source) =>
	decimalOf(source.draw(element(source.draw(element(decimalGroups)))))

const anyDecimal: Gen<Numeric> = oneOf([dictionaryDecimal, decimalGen])

const signed = (p: FiniteParts): bigint => (p.negative ? -p.coefficient : p.coefficient)

/**
 * The exact rational value of a finite Numeric as a signed coefficient over 10^minScale, compared by cross
 * multiplication, which reads no canonical form; the specials by their kind, NaN equal to NaN.
 */
const sameDecimal = (a: Numeric, b: Numeric): boolean => {
	const x = a.parts
	const y = b.parts
	if (x.kind !== "finite" || y.kind !== "finite") {
		return x.kind === y.kind
	}
	return signed(x) * 10n ** BigInt(y.minScale) === signed(y) * 10n ** BigInt(x.minScale)
}

/** Two Decimals' parts field by field: one form means equal values hold identical parts. */
const sameParts = (a: DecimalParts, b: DecimalParts): boolean =>
	a.kind === "finite" && b.kind === "finite"
		? a.negative === b.negative && a.coefficient === b.coefficient && a.minScale === b.minScale
		: a.kind === b.kind

const minorUnits: Gen<bigint> = oneOf([
	element([0n, 1n, -1n, 5n, 6n, 2n ** 63n - 1n, -(2n ** 63n)]),
	bigint(-(2n ** 63n), 2n ** 63n - 1n)
])

const moneyOf = (units: bigint): Money => succeeded(Money.fromCanonical(units.toString()))

/** Components that equal under binary32: -0 and 0, 0.1 and its binary32 rounding, a subnormal. */
const components: Gen<number> = element([0, -0, 0.1, Math.fround(0.1), 1, 1.5, -2, 3e-40])

const vectorOf = (xs: ReadonlyArray<number>): Vector =>
	Vector.make(Float32Array.from(xs), xs.length)

/** The components of a vector, read one by one. */
const componentsOf = (v: Float32Array): ReadonlyArray<number> => [...v]

const sameVector = (a: Float32Array, b: Float32Array): boolean => {
	const xs = componentsOf(a)
	const ys = componentsOf(b)
	return xs.length === ys.length && Arr.every(xs, (x, i) => x === ys[i])
}

/** One pair of one carrier, with the oracle's verdict and every implementation's. */
interface JudgedPair {
	readonly oracle: boolean
	readonly sides: ReadonlyArray<readonly [string, boolean]>
	readonly identities: readonly [string, string]
}

/** A judged pair of Decimals or Moneys, or of vectors, which carries its two vectors' components. */
type Judged =
	| (JudgedPair & { readonly carrier: "decimal" | "money" })
	| (JudgedPair & {
			readonly carrier: "vector"
			readonly components: readonly [ReadonlyArray<number>, ReadonlyArray<number>]
	  })

const judgedDecimal = (a: Numeric, b: Numeric): Judged => ({
	carrier: "decimal",
	oracle: sameDecimal(a, b),
	sides: [
		["equals", a.equals(b)],
		["compare", a.compare(b) === 0],
		["toString", Str.Equivalence(a.toString(), b.toString())],
		["parts", sameParts(a.parts, b.parts)]
	],
	identities: [a.text, b.text]
})

const judgedMoney = (x: bigint, y: bigint): Judged => {
	const a = moneyOf(x)
	const b = moneyOf(y)
	return {
		carrier: "money",
		oracle: x === y,
		sides: [
			["equals", a.equals(b)],
			["compare", a.compare(b) === 0]
		],
		identities: [a.minorUnits.toString(), b.minorUnits.toString()]
	}
}

const judgedVector = (xs: ReadonlyArray<number>, ys: ReadonlyArray<number>): Judged => {
	const a = vectorOf(xs)
	const b = vectorOf(ys)
	return {
		carrier: "vector",
		oracle: sameVector(a, b),
		sides: [
			["Vector.equals", Vector.equals(a, b)],
			["Vector.compare", Vector.compare(a, b) === 0 && a.length === b.length]
		],
		identities: [Vector.componentText(a), Vector.componentText(b)],
		components: [xs, ys]
	}
}

/**
 * Whether two vectors of one length differ, under binary32, in their last component alone: an order that stops short
 * of it calls them equal.
 */
export const apartInTheLastAlone = ([xs, ys]: readonly [
	ReadonlyArray<number>,
	ReadonlyArray<number>
]): boolean =>
	xs.length === ys.length &&
	Arr.every(
		Arr.zip(xs, ys),
		([x, y], i) => (Math.fround(x) === Math.fround(y)) === i < xs.length - 1
	)

const vectorGen = array(components, { min: 1, max: 3 })

const pairGen: Gen<Judged> = oneOf([
	(source) => judgedDecimal(source.draw(anyDecimal), source.draw(anyDecimal)),
	(source) => {
		const members = source.draw(element(decimalGroups))
		return judgedDecimal(
			decimalOf(source.draw(element(members))),
			decimalOf(source.draw(element(members)))
		)
	},
	(source) => judgedMoney(source.draw(minorUnits), source.draw(minorUnits)),
	map(minorUnits, (x) => judgedMoney(x, x)),
	(source) => judgedVector(source.draw(vectorGen), source.draw(vectorGen)),
	map(vectorGen, (xs) =>
		judgedVector(
			xs,
			Arr.map(xs, (x) => (x === 0 ? -0 : Math.fround(x)))
		)
	)
])

/** What a judged pair reached: its carrier and verdict, and two vectors apart in their last component alone. */
export type EqualityFeature =
	| `${Judged["carrier"]} ${"equal" | "unequal"}`
	| "vector unequal in its last component alone"

/** A vector and another of its length whose last component is drawn again: often apart in it alone. */
const lastRedrawn: Gen<Judged> = (source) => {
	const xs = source.draw(vectorGen)
	const last = source.draw(components)
	return judgedVector(xs, [...xs.slice(0, -1), last])
}

/** The pairs, aimed at two vectors apart in their last component alone. */
export const pairSpace: Aimed<Judged, EqualityFeature> = aimed(pairGen, [
	["vector unequal in its last component alone", lastRedrawn]
])

/**
 * Every object a value reaches through its own properties, the value first; a typed array's elements are no objects,
 * and a descriptor's column is Effect's.
 */
export const reached = (value: unknown): ReadonlyArray<object> => {
	const out: Array<object> = []
	const seen = new Set<object>()
	const visit = (v: unknown): void => {
		if (typeof v !== "object" || v === null || seen.has(v)) {
			return
		}
		seen.add(v)
		out.push(v)
		if (ArrayBuffer.isView(v)) {
			return
		}
		for (const key of Reflect.ownKeys(v)) {
			if (key !== "column") {
				visit(Reflect.get(v, key))
			}
		}
	}
	visit(value)
	return out
}

/** A text descriptor of `source` cut to `bytes` UTF-8 bytes, its language as str.bytes admits it. */
const bytesDesc = (source: string, flags: "u" | "su", bytes: number): FieldDesc => ({
	kind: "text",
	patterns: [{ source, flags }],
	bytes,
	language: languageWithin(succeeded(textLookup([{ source, flags }])), bytes)
})

/** The roster the closed id and the set descriptors are over. */
const rosters = { Kind: ["Manual", "Automatic"] } as const

/** The descriptors of every kind but text, every PostgreSQL scalar among them. */
const otherDescs: Arr.NonEmptyReadonlyArray<FieldDesc> = [
	{ kind: "numeric", precision: 10, scale: 2 },
	...Arr.map(pgScalarNames, (type): FieldDesc => ({ kind: "pg", type })),
	{ kind: "uuid" },
	f.natural,
	f.closedId("Kind"),
	{ kind: "bits", roster: "Kind" },
	{ kind: "span", endpoint: { kind: "pg", type: "int8" }, width: 10n },
	{ kind: "span", endpoint: { kind: "pg", type: "int4" }, width: undefined },
	{ kind: "span", endpoint: { kind: "pg", type: "date" }, width: undefined },
	{ kind: "vector", dimensions: 3 }
]

/** A constructed value with the name of its constructor. */
export type Constructor =
	| "Numeric.fromString"
	| "Money.fromCanonical"
	| "makeSpan"
	| "Vector.canonical"
	| "scalarTypeOf"
	| "scalarTypeOf, a finite check"
	| "scalarTypeOf, a bounded regex check"
	| "scalarTypeOf, a regex check of no bound"
	| "scalarTypeOf, a byte bound beside a check"
	| "scalarTypeOf, a byte bound alone"
	| "scalarTypeOf, every text"
	| "a public field descriptor"
	| "str.regex"

/** What scalarTypeOf made, as its value shows it: a text type by the check its language carries. */
const typedBy = (type: DeclaredType): Constructor => {
	const text = textOf(type)
	if (text === undefined) {
		return "scalarTypeOf"
	}
	const language = languageOfText(text)
	if (language.kind === "every") {
		return "scalarTypeOf, every text"
	}
	const { check } = language
	switch (check.kind) {
		case "finite":
			return "scalarTypeOf, a finite check"
		case "regex":
			return check.bounds === undefined
				? "scalarTypeOf, a regex check of no bound"
				: "scalarTypeOf, a bounded regex check"
		case "octets":
			return check.check === undefined
				? "scalarTypeOf, a byte bound alone"
				: "scalarTypeOf, a byte bound beside a check"
	}
}

interface Constructed {
	readonly by: Constructor
	readonly value: unknown
}

/** The type scalarTypeOf makes of `desc`, by the check its language carries. */
const typedOf = (desc: FieldDesc): Constructed => {
	const type = scalarOf(desc, rosters)
	return { by: typedBy(type), value: type }
}

/** A text descriptor of `source` cut to between one and `most` UTF-8 bytes. */
const cutText = (source: string, flags: "u" | "su", most: number): Gen<FieldDesc> =>
	map(int(1, most), (bytes) => bytesDesc(source, flags, bytes))

/** What scalarTypeOf makes, by the check its language carries. */
type Typed = Extract<Constructor, `scalarTypeOf${string}`>

/**
 * The types scalarTypeOf is drawn to make, each of the descriptors that make it: every kind but text, and each text
 * check the analysis makes: a finite language's, a bounded regex's, an unbounded one's past the automaton bound, a byte
 * bound cutting a bounded pattern below the eight bytes it bounds (beside its check) or cutting every text (alone), and
 * every text's.
 */
const typedSpaces: Arr.NonEmptyReadonlyArray<readonly [Typed, Gen<Constructed>]> = [
	["scalarTypeOf", map(element(otherDescs), typedOf)],
	["scalarTypeOf, a finite check", map(constant(textDesc("^x$", "u")), typedOf)],
	["scalarTypeOf, a bounded regex check", map(constant(textDesc("^[a-z]{1,8}$", "u")), typedOf)],
	[
		"scalarTypeOf, a regex check of no bound",
		map(constant(textDesc("^(a|b)*a(a|b){12}$", "u")), typedOf)
	],
	["scalarTypeOf, a byte bound beside a check", map(cutText("^[a-z]{1,8}$", "u", 7), typedOf)],
	["scalarTypeOf, a byte bound alone", map(cutText("^.*$", "su", 16), typedOf)],
	["scalarTypeOf, every text", map(constant(f.wildcard), typedOf)]
]

const constructedGen: Gen<Constructed> = oneOf<Constructed>([
	map(numericText, (text): Constructed => ({ by: "Numeric.fromString", value: decimalOf(text) })),
	map(minorUnits, (units): Constructed => ({ by: "Money.fromCanonical", value: moneyOf(units) })),
	(source): Constructed => {
		const start = source.draw(bigint(-10n, 10n))
		const width = source.draw(bigint(1n, 10n))
		return { by: "makeSpan", value: succeeded(makeSpan("int8", start, start + width)) }
	},
	map(vectorGen, (xs): Constructed => ({
		by: "Vector.canonical",
		value: succeeded(Vector.canonical(vectorOf(xs)))
	})),
	oneOf(Arr.map(typedSpaces, ([, space]) => space)),
	element<Constructed>([
		{ by: "a public field descriptor", value: Id },
		{ by: "a public field descriptor", value: int4 },
		{ by: "a public field descriptor", value: int8 },
		{ by: "a public field descriptor", value: numeric(10, 2) },
		{ by: "str.regex", value: str.regex("^[a-z]{1,8}$") }
	])
])

type Tag = "d" | "m" | "v"

/** The tags a payload is offered under. */
const tags: Arr.NonEmptyReadonlyArray<Tag> = ["d", "m", "v"]

/**
 * The near misses of a payload, by what each does to it: a sign, a leading or trailing zero, an exponent, a space, a
 * doubled or dropped separator, a suffix, a character cut.
 */
/** A leading zero, which no canonical text of any tag holds. */
const leadingZero = ["a leading zero", (payload: string) => `0${payload}`] as const

const nearMisses = [
	["a plus sign", (payload: string) => `+${payload}`],
	leadingZero,
	["a trailing zero", (payload: string) => `${payload}0`],
	["an exponent", (payload: string) => `${payload}e0`],
	["a leading space", (payload: string) => ` ${payload}`],
	["a trailing space", (payload: string) => `${payload} `],
	["a minus sign", (payload: string) => `-${payload}`],
	["no point", Str.replace(".", "")],
	["a doubled comma", Str.replace(",", ",,")],
	["no comma", Str.replace(",", "")],
	["no bracket", Str.replace("[", "")],
	["a suffix", (payload: string) => `${payload}@`],
	["no first character", Str.slice(1)],
	["no last character", Str.slice(0, -1)]
] as const

/** A near miss of a payload, by what it does to it. */
type NearMiss = (typeof nearMisses)[number][0]

type NearMissing = (typeof nearMisses)[number]

/** A payload and the tag it is offered under. */
interface Offered {
	readonly tag: Tag
	readonly payload: string
	/** Whether it is a written payload, unchanged. */
	readonly written: boolean
	/** The near miss made of a written payload, if any. */
	readonly miss: Option.Option<NearMiss>
}

/** What an offered payload reached: a written payload revived, a near miss refused, and which near miss. */
export type RevivalFeature =
	| `${Tag} ${"written" | "near miss refused"}`
	| `${Tag} refused, ${NearMiss}`

/** The payloads each tag's values write. */
const writtenOf: { readonly [T in Tag]: Gen<string> } = {
	d: map(anyDecimal, (d) => d.toString()),
	m: map(minorUnits, (u) => moneyOf(u).minorUnits.toString()),
	v: map(vectorGen, (xs) => Vector.componentText(vectorOf(xs)))
}

/** A payload `tag`'s values write, offered as written or as the near miss `missing` draws of it. */
const offeredOf =
	(tag: Tag, missing: Gen<Option.Option<NearMissing>>): Gen<Offered> =>
	(source) => {
		const written = source.draw(writtenOf[tag])
		return Option.match(source.draw(missing), {
			onNone: (): Offered => ({ tag, payload: written, written: true, miss: Option.none() }),
			onSome: ([miss, missed]): Offered => {
				const payload = missed(written)
				return { tag, payload, written: payload === written, miss: Option.some(miss) }
			}
		})
	}

const offeredGen: Gen<Offered> = oneOf(
	Arr.map(tags, (tag) => offeredOf(tag, option(element(nearMisses))))
)

/** The offered payloads, aimed at each tag's payload offered with a leading zero, which no canonical text holds. */
export const offeredSpace: Aimed<Offered, RevivalFeature> = aimed(
	offeredGen,
	Arr.map(
		tags,
		(tag) =>
			[
				`${tag} refused, a leading zero`,
				offeredOf(tag, constant(Option.some(leadingZero)))
			] as const
	)
)

/** The payload a revived value writes again, or why the payload was not revived. */
export const rewritten = (tag: Tag, payload: string): Result.Result<string, string> => {
	switch (tag) {
		case "d": {
			const d = Numeric.fromCanonical(payload)
			return d.ok ? Result.ok(d.value.toString()) : Result.err(d.error.message)
		}
		case "m": {
			const m = Money.fromCanonical(payload)
			return m.ok ? Result.ok(m.value.minorUnits.toString()) : Result.err(m.error.message)
		}
		case "v": {
			const v = Vector.fromCanonical(payload)
			return v.ok ? Result.ok(Vector.componentText(v.value)) : Result.err(v.error.message)
		}
	}
}

/** The constructed values, each type scalarTypeOf makes aimed at the descriptors drawn to make it. */
export const constructedSpace: Aimed<Constructed, Constructor> = aimed(constructedGen, typedSpaces)
