/**
 * Forged carrier instances against the one mint: everything a JavaScript caller can build that looks like a Decimal, a
 * Money or a Vector without the checked constructors is refused, at construction or at admission, or is admitted as the
 * canonical PostgreSQL value it holds. So one PostgreSQL value is one host fact, and a relation input is a set without
 * a DISTINCT.
 *
 * Oracle: the specification turned into a checker. Every input stands for a PostgreSQL value the case states apart from
 * grizzle, as PostgreSQL's own text of it: numeric_out of trim_scale for a numeric, money::numeric for a money,
 * vector_out for a vector. An input is refused with a word of the vocabulary, or thrown out at construction with
 * CompileError MalformedDescription, or admitted with exactly that text. A batch of admitted inputs normalizes to as many
 * facts as the distinct values it holds, and a vector's buffer written by its caller after admission changes neither
 * the batch's identities nor any row its arrays carry.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import {
	normalArrays,
	normalRows,
	positionalColumns,
	type RelationSpec,
	relationNormalizer
} from "#compiler/codec/recordset.ts"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { canonicalTag } from "#compiler/core/canonical.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { isValueFault } from "#compiler/scalar/values/fault.ts"
import { admitValue, canonicalText } from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { kindCodes, types } from "#test/unit/codec/support.ts"

type DecimalForgery =
	| "honest"
	| "a prototype object"
	| "a proxy"
	| "the constructor called"
	| "a subclass's super"
	| "fromValue of a forged payload"
	| "fromValue of another value's parts"

type MoneyForgery =
	| "honest"
	| "a prototype object"
	| "a proxy"
	| "the constructor called"
	| "a subclass's super"
	| "fromValue of a count that is no bigint"
	| "fromValue of an honest count"
	| "an exact amount past int64"

type VectorForgery = "honest" | "own overrides" | "a subclass's overrides" | "a proxy"

const decimalForgeries: Arr.NonEmptyReadonlyArray<DecimalForgery> = [
	"honest",
	"a prototype object",
	"a proxy",
	"the constructor called",
	"a subclass's super",
	"fromValue of a forged payload",
	"fromValue of another value's parts"
]

const moneyForgeries: Arr.NonEmptyReadonlyArray<MoneyForgery> = [
	"honest",
	"a prototype object",
	"a proxy",
	"the constructor called",
	"a subclass's super",
	"fromValue of a count that is no bigint",
	"fromValue of an honest count",
	"an exact amount past int64"
]

const vectorForgeries: Arr.NonEmptyReadonlyArray<VectorForgery> = [
	"honest",
	"own overrides",
	"a subclass's overrides",
	"a proxy"
]

type CarrierName = "numeric" | "numeric(5,2)" | "money" | "vector(3)"

/**
 * A carrier whose host values are objects a caller can forge: its values, each PostgreSQL's text of it and how a host
 * value spells it, colliding under PostgreSQL's equality in several spellings, and the forgeries of its host type.
 */
type Carried = { readonly name: CarrierName; readonly type: ScalarType } & (
	| {
			readonly host: "numeric"
			readonly values: Arr.NonEmptyReadonlyArray<{
				readonly pg: string
				readonly spellings: Arr.NonEmptyReadonlyArray<string>
			}>
			readonly forgeries: Arr.NonEmptyReadonlyArray<DecimalForgery>
	  }
	| {
			readonly host: "money"
			readonly values: Arr.NonEmptyReadonlyArray<{ readonly pg: string; readonly count: bigint }>
			readonly forgeries: Arr.NonEmptyReadonlyArray<MoneyForgery>
	  }
	| {
			readonly host: "vector"
			readonly values: Arr.NonEmptyReadonlyArray<{
				readonly pg: string
				readonly components: ReadonlyArray<number>
			}>
			readonly forgeries: Arr.NonEmptyReadonlyArray<VectorForgery>
	  }
)

const carriers: Arr.NonEmptyReadonlyArray<Carried> = [
	{
		name: "numeric",
		type: types.numeric,
		host: "numeric",
		values: [
			{ pg: "1.5", spellings: ["1.5", "1.50", "15e-1"] },
			{ pg: "NaN", spellings: ["NaN"] },
			{ pg: "-2", spellings: ["-2", "-2.0"] },
			{ pg: "0", spellings: ["0", "-0", "0.000"] }
		],
		forgeries: decimalForgeries
	},
	{
		name: "numeric(5,2)",
		type: types.numeric52,
		host: "numeric",
		values: [
			{ pg: "1.23", spellings: ["1.231", "1.23", "1.234"] },
			{ pg: "1.24", spellings: ["1.235", "1.24"] },
			{ pg: "NaN", spellings: ["NaN"] }
		],
		forgeries: decimalForgeries
	},
	{
		name: "money",
		type: types.money,
		host: "money",
		values: [
			{ pg: "1.00", count: 100n },
			{ pg: "-0.50", count: -50n },
			{ pg: "0.00", count: 0n }
		],
		forgeries: moneyForgeries
	},
	{
		name: "vector(3)",
		type: types.vector3,
		host: "vector",
		values: [
			{ pg: "[1,0,0]", components: [1, 0, 0] },
			{ pg: "[0,1,0]", components: [-0, 1, 0] },
			{ pg: "[0.5,0.5,0.5]", components: [0.5, 0.5, 0.5] }
		],
		forgeries: vectorForgeries
	}
]

/** The checked constructors as a JavaScript caller sees them, taking any argument at all. */
interface Untyped {
	fromValue(value: unknown): unknown
}
const untypedMoney: Untyped = Money

/** A constructor whose prototype chain runs through `base`, so `Reflect.construct` runs the carrier as its `super`. */
const subclassOf = (base: Decimal | Money): new () => unknown => {
	class Sub {
		readonly forged = true
	}
	Reflect.setPrototypeOf(Sub.prototype, base)
	return Sub
}

/** A Float32Array's every reading method lying: entries, values, its iterator, its length and its text. */
const lying = {
	entries: { value: () => [[0, 9] as const, [1, 9] as const, [2, 9] as const].values() },
	values: { value: () => [9, 9, 9].values() },
	[Symbol.iterator]: { value: () => [9, 9, 9].values() },
	length: { get: () => 3 },
	toString: { value: () => "[9,9,9]" },
	subarray: { value: () => new Float32Array([9, 9, 9]) }
} as const

/** A numeric input of the value spelled `spelling`, by `forgery`; `other` is another value's spelling. */
const numericInput = (
	spelling: string,
	pg: string,
	other: string,
	forgery: DecimalForgery
): unknown => {
	const honest = Decimal.of(spelling)
	switch (forgery) {
		case "honest":
			return honest
		case "a prototype object":
			return Object.create(Decimal.prototype, {
				parts: { value: honest.parts },
				text: { value: spelling }
			})
		case "a proxy":
			return new Proxy(honest, {})
		case "the constructor called":
			return Reflect.construct(Decimal, [honest.parts, spelling])
		case "a subclass's super":
			return Reflect.construct(Decimal, [honest.parts, spelling], subclassOf(Decimal.prototype))
		case "fromValue of a forged payload":
			return Decimal.fromValue({
				parts: honest.parts,
				[canonicalTag]: () => ({ tag: "d", payload: spelling })
			})
		case "fromValue of another value's parts":
			return Decimal.fromValue({
				parts: Decimal.of(other).parts,
				[canonicalTag]: () => ({ tag: "d", payload: pg })
			})
	}
}

/** A money input of the count `count`, by `forgery`. */
const moneyInput = (count: bigint, forgery: MoneyForgery): unknown => {
	switch (forgery) {
		case "honest":
			return Money.of(count)
		case "a prototype object":
			return Object.create(Money.prototype, {
				minorUnits: { value: count },
				toString: { value: () => `00${Money.of(count).toString()}` }
			})
		case "a proxy":
			return new Proxy(Money.of(count), {})
		case "the constructor called":
			return Reflect.construct(Money, [count])
		case "a subclass's super":
			return Reflect.construct(Money, [count], subclassOf(Money.prototype))
		case "fromValue of a count that is no bigint":
			return untypedMoney.fromValue({
				minorUnits: `00${count}`,
				[canonicalTag]: () => ({ tag: "m", payload: `${count}` })
			})
		case "fromValue of an honest count":
			return Money.fromValue({
				minorUnits: count,
				[canonicalTag]: () => ({ tag: "m", payload: `${count}` })
			})
		case "an exact amount past int64":
			return Money.exact(2n ** 63n + (count < 0n ? -count : count))
	}
}

/** A subclass of Float32Array whose prototype lies through every reading method. */
const lyingSubclass = (): typeof Float32Array => {
	class Lying extends Float32Array {}
	Object.defineProperties(Lying.prototype, lying)
	return Lying
}

/** A vector input of `components`, by `forgery`: a plain buffer, or one whose methods lie about its components. */
const vectorInput = (components: ReadonlyArray<number>, forgery: VectorForgery): unknown => {
	switch (forgery) {
		case "honest":
			return new Float32Array(components)
		case "own overrides":
			return Object.defineProperties(new Float32Array(components), lying)
		case "a subclass's overrides": {
			const Lying = lyingSubclass()
			return new Lying(components)
		}
		case "a proxy":
			return new Proxy(new Float32Array(components), {})
	}
}

/** One built input: the forgery that built it, the PostgreSQL text it stands for, and the input or what building threw. */
interface Built {
	readonly forgery: string
	readonly pg: string
	readonly input: Result.Result<unknown, unknown>
}

interface ForgedCase {
	readonly carrier: CarrierName
	readonly type: ScalarType
	readonly inputs: ReadonlyArray<Built>
}

const at = <A>(items: Arr.NonEmptyReadonlyArray<A>, i: number): A =>
	defined(items[i % items.length], "an item")

/**
 * A case: a carrier, and one to five inputs, each a value of it in one of its spellings built by one of its forgeries.
 * Building runs in the property, so what a forgery throws is the case's to judge.
 */
const caseGen: Gen<ForgedCase> = (source) => {
	const carrier = source.draw(element(carriers))
	const picks = source.draw(
		array(
			(s) => ({
				value: s.draw(int(0, 3)),
				spelling: s.draw(int(0, 2)),
				forgery: s.draw(int(0, 7))
			}),
			{ min: 1, max: 5 }
		)
	)
	const inputs = Arr.map(picks, (p): Built => {
		switch (carrier.host) {
			case "numeric": {
				const value = at(carrier.values, p.value)
				const forgery = at(carrier.forgeries, p.forgery)
				const other = at(carrier.values, p.value + 1)
				return {
					forgery,
					pg: value.pg,
					input: Result.try(() =>
						numericInput(at(value.spellings, p.spelling), value.pg, other.spellings[0], forgery)
					)
				}
			}
			case "money": {
				const value = at(carrier.values, p.value)
				const forgery = at(carrier.forgeries, p.forgery)
				return { forgery, pg: value.pg, input: Result.try(() => moneyInput(value.count, forgery)) }
			}
			case "vector": {
				const value = at(carrier.values, p.value)
				const forgery = at(carrier.forgeries, p.forgery)
				return {
					forgery,
					pg: value.pg,
					input: Result.try(() => vectorInput(value.components, forgery))
				}
			}
		}
	})
	return { carrier: carrier.name, type: carrier.type, inputs }
}

type Feature =
	| `numeric: ${DecimalForgery}`
	| `numeric(5,2): ${DecimalForgery}`
	| `money: ${MoneyForgery}`
	| `vector(3): ${VectorForgery}`
	| "refused at admission"
	| "thrown out at construction"
	| "admitted as its value"
	| "a batch holding one value twice"
	| "a buffer written after admission"

/** Every (carrier, forgery) pair, a situation the cases must reach. */
const pairs: ReadonlyArray<Feature> = [
	...Arr.map(decimalForgeries, (f): Feature => `numeric: ${f}`),
	...Arr.map(decimalForgeries, (f): Feature => `numeric(5,2): ${f}`),
	...Arr.map(moneyForgeries, (f): Feature => `money: ${f}`),
	...Arr.map(vectorForgeries, (f): Feature => `vector(3): ${f}`)
]

/** The pair a built input reached, read back from its carrier and forgery. */
const pairOf = (carrier: CarrierName, forgery: string): Feature =>
	defined(
		Option.getOrUndefined(Arr.findFirst(pairs, (p) => p === `${carrier}: ${forgery}`)),
		`the pair ${carrier}: ${forgery}`
	)

describe("a forged carrier instance", () => {
	it.effect(
		"is refused, or admitted as the PostgreSQL value it holds, so one value is one fact whatever its caller writes later",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/values/forged",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"refused at admission",
								"thrown out at construction",
								"admitted as its value",
								"a batch holding one value twice",
								"a buffer written after admission",
								...pairs
							],
							{ cases: 3000, sense: notesOnly }
						),
						kept: [],
						runs: 1500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ carrier, type, inputs }, c) =>
						Effect.sync(() => {
							const spec = carrierSpecOf(type, kindCodes)
							const admitted: Array<{ readonly input: unknown; readonly pg: string }> = []
							for (const one of inputs) {
								c.note(pairOf(carrier, one.forgery))
								const made = one.input
								if (Result.isFailure(made)) {
									c.note("thrown out at construction")
									assert.ok(
										isCompileError(made.failure) &&
											made.failure.reason._tag === "MalformedDescription",
										`${carrier}, ${one.forgery}: construction threw something other than MalformedDescription`
									)
									assert.notEqual(one.forgery, "honest", "an honest construction threw")
									continue
								}
								const verdict = admitValue(spec, made.success)
								if (!verdict.ok) {
									c.note("refused at admission")
									assert.ok(isValueFault(verdict.error), `refused with ${verdict.error}`)
									assert.notEqual(one.forgery, "honest", "an honest value was refused")
									continue
								}
								c.note("admitted as its value")
								assert.equal(
									canonicalText(spec, verdict.value),
									one.pg,
									`${carrier}, ${one.forgery}: admitted as another text than PostgreSQL's`
								)
								admitted.push({ input: made.success, pg: one.pg })
							}
							const relation: RelationSpec = {
								relation: "Forged",
								columns: positionalColumns([{ name: "v", type }]),
								slot: { kind: "none" },
								codes: kindCodes
							}
							const distinct = new Set(Arr.map(admitted, (a) => a.pg))
							if (distinct.size < admitted.length) {
								c.note("a batch holding one value twice")
							}
							const normal = succeeded(
								relationNormalizer(relation)(Arr.map(admitted, (a) => ({ v: a.input })))
							)
							assert.equal(normal.count, distinct.size, "one fact per PostgreSQL value")
							assert.deepEqual(
								new Set(Arr.flatten(normal.rows)),
								distinct,
								"every row carries its value's PostgreSQL text"
							)
							const buffers = Arr.filter(
								Arr.map(admitted, (a) => a.input),
								(input): input is Float32Array => input instanceof Float32Array
							)
							if (buffers.length === 0) {
								return
							}
							c.note("a buffer written after admission")
							const identities = Arr.map(normal.entries, (e) => e.identity)
							for (const buffer of buffers) {
								buffer.fill(7)
							}
							assert.deepEqual(
								new Set(Arr.flatten(succeeded(normalRows(relation)(normal)).rows)),
								distinct,
								"the rows stay the admitted values"
							)
							assert.deepEqual(
								Arr.map(normal.entries, (e) => e.identity),
								identities,
								"the identities stay the admitted ones"
							)
							const arrays = succeeded(normalArrays(relation)(normal))
							for (const pg of distinct) {
								assert.ok(Arr.some(arrays, Str.includes(`"${pg}"`)), `the arrays carry ${pg}`)
							}
						})
				)
			)
	)
})
