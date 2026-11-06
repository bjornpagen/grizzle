import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, map, oneOf, option } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import * as Result from "#compiler/core/result.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { str } from "#compiler/public/text.ts"
import { Decimal, type DecimalParts, type FiniteParts } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { makeSpan } from "#compiler/scalar/values/span.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { textDesc } from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { caseHang } from "#test/support/limits.ts"
import { decimalGen, decimalText } from "#test/unit/values/support.ts"

/** Groups of spellings of one Decimal value, and values alone. */
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

const decimalOf = (text: string): Decimal => succeeded(Decimal.fromString(text))

/** A value drawn from the dictionary or generated. */
const dictionaryDecimal: Gen<Decimal> = (source) =>
	decimalOf(source.draw(element(source.draw(element(decimalGroups)))))

const anyDecimal: Gen<Decimal> = oneOf([dictionaryDecimal, decimalGen])

const signed = (p: FiniteParts): bigint => (p.negative ? -p.coefficient : p.coefficient)

/**
 * The exact rational value of a finite Decimal as a signed coefficient over 10^minScale, compared by cross
 * multiplication, which reads no canonical form; the specials by their kind, NaN equal to NaN.
 */
const sameDecimal = (a: Decimal, b: Decimal): boolean => {
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
interface Judged {
	readonly carrier: "decimal" | "money" | "vector"
	readonly oracle: boolean
	readonly sides: ReadonlyArray<readonly [string, boolean]>
	readonly identities: readonly [string, string]
}

const judgedDecimal = (a: Decimal, b: Decimal): Judged => ({
	carrier: "decimal",
	oracle: sameDecimal(a, b),
	sides: [
		["equals", a.equals(b)],
		["compare", a.compare(b) === 0],
		["toString", a.toString() === b.toString()],
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
		identities: [Vector.componentText(a), Vector.componentText(b)]
	}
}

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

/**
 * Every object a value reaches through its own properties, the value first; a typed array's elements are no objects,
 * and a descriptor's column is Effect's.
 */
const reached = (value: unknown): ReadonlyArray<object> => {
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

const fieldDescs: Arr.NonEmptyReadonlyArray<FieldDesc> = [
	{ kind: "pg", type: "integer" },
	{ kind: "numeric", precision: 10, scale: 2 },
	{ kind: "uuid" },
	textDesc("^[a-z]{1,8}$", "u"),
	{ kind: "span", endpoint: { kind: "pg", type: "bigint" }, width: 10n },
	{ kind: "vector", dimensions: 3 }
]

/** A constructed value with the name of its constructor. */
type Constructor =
	| "Decimal.fromString"
	| "Money.fromCanonical"
	| "makeSpan"
	| "Vector.canonical"
	| "scalarTypeOf"
	| "a public field descriptor"
	| "str.regex"

interface Constructed {
	readonly by: Constructor
	readonly value: unknown
}

const constructedGen: Gen<Constructed> = oneOf<Constructed>([
	map(decimalText, (text): Constructed => ({ by: "Decimal.fromString", value: decimalOf(text) })),
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
	map(element(fieldDescs), (desc): Constructed => ({
		by: "scalarTypeOf",
		value: scalarOf(desc, {})
	})),
	element<Constructed>([
		{ by: "a public field descriptor", value: uuid },
		{ by: "a public field descriptor", value: pg.integer },
		{ by: "a public field descriptor", value: pg.bigint },
		{ by: "a public field descriptor", value: pg.numeric(10, 2) },
		{ by: "str.regex", value: str.regex("^[a-z]{1,8}$") }
	])
])

type Tag = "d" | "m" | "v"

/** A payload and the tag it is offered under. */
interface Offered {
	readonly tag: Tag
	readonly payload: string
	/** Whether it is a written payload, unchanged. */
	readonly written: boolean
}

/**
 * The near misses of a payload: a sign, a leading or trailing zero, an exponent, a space, a doubled or dropped
 * separator, a suffix.
 */
const nearMisses = (payload: string): Arr.NonEmptyReadonlyArray<string> => [
	`+${payload}`,
	`0${payload}`,
	`${payload}0`,
	`${payload}e0`,
	` ${payload}`,
	`${payload} `,
	`-${payload}`,
	Str.replace(".", "")(payload),
	Str.replace(",", ",,")(payload),
	Str.replace(",", "")(payload),
	Str.replace("[", "")(payload),
	`${payload}@`,
	Str.slice(1)(payload),
	Str.slice(0, -1)(payload)
]

const writtenGen: Gen<{ readonly tag: Tag; readonly payload: string }> = oneOf<{
	readonly tag: Tag
	readonly payload: string
}>([
	map(anyDecimal, (d) => ({ tag: "d" as const, payload: d.toString() })),
	map(minorUnits, (u) => ({ tag: "m" as const, payload: moneyOf(u).minorUnits.toString() })),
	map(vectorGen, (xs) => ({ tag: "v" as const, payload: Vector.componentText(vectorOf(xs)) }))
])

const offeredGen: Gen<Offered> = (source) => {
	const w = source.draw(writtenGen)
	return Option.match(source.draw(option(element(nearMisses(w.payload)))), {
		onNone: (): Offered => ({ ...w, written: true }),
		onSome: (payload): Offered => ({ tag: w.tag, payload, written: payload === w.payload })
	})
}

/** The payload a revived value writes again, or why the payload was not revived. */
const rewritten = (tag: Tag, payload: string): Result.Result<string, string> => {
	switch (tag) {
		case "d": {
			const d = Decimal.fromCanonical(payload)
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

describe("the value carriers' laws", () => {
	it.effect(
		"equality is value identity, every implementation agrees, and equal values have one identity text",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/values/laws-equality",
						draw: drawn(pairGen),
						literal: Formatter.format,
						coverage: required<`${Judged["carrier"]} ${"equal" | "unequal"}`>(
							[
								"decimal equal",
								"decimal unequal",
								"money equal",
								"money unequal",
								"vector equal",
								"vector unequal"
							],
							{ cases: 2000, sense: notesOnly }
						),
						kept: [],
						runs: 2000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(j, c) =>
						Effect.sync(() => {
							c.note(`${j.carrier} ${j.oracle ? "equal" : "unequal"}`)
							for (const [side, verdict] of j.sides) {
								assert.equal(
									verdict,
									j.oracle,
									`${j.carrier}: ${side} says ${verdict}, the value oracle ${j.oracle}`
								)
							}
							if (j.oracle) {
								assert.equal(
									j.identities[0],
									j.identities[1],
									`${j.carrier}: equal values have different identity texts`
								)
							}
						})
				)
			)
	)

	it.effect(
		"every value a constructor returns is frozen, and so is every object it reaches",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/values/laws-frozen",
						draw: drawn(constructedGen),
						literal: Formatter.format,
						coverage: required<Constructor>(
							[
								"Decimal.fromString",
								"Money.fromCanonical",
								"makeSpan",
								"Vector.canonical",
								"scalarTypeOf",
								"a public field descriptor",
								"str.regex"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(made, c) =>
						Effect.sync(() => {
							c.note(made.by)
							for (const object of reached(made.value)) {
								if (!ArrayBuffer.isView(object)) {
									assert.equal(
										Object.isFrozen(object),
										true,
										`${made.by} returns an object reaching an unfrozen one`
									)
								}
							}
						})
				)
			)
	)

	it.effect("a written payload revives to its value, and only a written payload revives", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/values/laws-revival",
					draw: drawn(offeredGen),
					literal: Formatter.format,
					coverage: required<`${Tag} ${"written" | "near miss refused"}`>(
						[
							"d written",
							"d near miss refused",
							"m written",
							"m near miss refused",
							"v written",
							"v near miss refused"
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
				(o, c) =>
					Effect.sync(() => {
						const back = rewritten(o.tag, o.payload)
						if (o.written) {
							c.note(`${o.tag} written`)
							assert.ok(back.ok, `the written ${o.tag} payload ${o.payload} is refused`)
							assert.equal(back.value, o.payload)
							return
						}
						if (back.ok) {
							assert.equal(
								back.value,
								o.payload,
								`~${o.tag}:${o.payload} revives to a value writing ${back.value}`
							)
						} else {
							c.note(`${o.tag} near miss refused`)
						}
					})
			)
		)
	)
})
