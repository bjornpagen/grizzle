/** What the properties of exact-fields.test.ts read: its spaces, models and helpers. */

import { element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { bigint } from "@bjornpagen/testing/values"
import { int8Max } from "#compiler/ir/carriers.ts"
import type { ExactValueCarrier } from "#compiler/ir/scalar.ts"
import { Num } from "#compiler/public/compute.ts"
import { exactInteger, exactMoney, Money, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { key, on, relation, schema, unit } from "#compiler/public/schema.ts"
import { numericMaxIntegerDigits } from "#compiler/scalar/values/fault.ts"
import { derivedBuilder } from "#compiler/schema/relation.ts"
import { schemaBuilder } from "#compiler/schema/schema.ts"

/** Each exact field by its carrier. */
export const exactFields = { exactInteger, exactMoney } as const

/** The other exact carrier, whose values no field of `carrier` holds. */
export const otherCarrier = (carrier: ExactValueCarrier): ExactValueCarrier =>
	carrier === "exactInteger" ? "exactMoney" : "exactInteger"

/**
 * A value of an exact field: its carrier, the host value, and numeric_out's text of it, the cell a read of the field
 * delivers and the text the codec writes. An exact integer is its digits; an amount is its count of cents at money's
 * two fraction digits.
 */
export type ExactValue =
	| { readonly carrier: "exactInteger"; readonly value: bigint; readonly text: string }
	| { readonly carrier: "exactMoney"; readonly value: Money; readonly text: string }

/** An exact integer of `value`, its text its digits. */
const integerValue = (value: bigint): ExactValue => ({
	carrier: "exactInteger",
	value,
	text: value.toString()
})

/** An amount of `cents` minor units, its text money::numeric's at two fraction digits. */
const amountValue = (cents: bigint): ExactValue => {
	const value = Money.exact(cents)
	return { carrier: "exactMoney", value, text: value.toString() }
}

/** The magnitude a drawn value is of: within a signed 64-bit count, past it, or of hundreds of digits. */
export type MagnitudeFeature =
	| "a value within a signed 64-bit count"
	| "a value past a signed 64-bit count"
	| "a value of hundreds of digits"

/** 10^n. */
const tenTo = (n: number): bigint => 10n ** BigInt(n)

/** A magnitude of each class, signed: within int8, just past it, and of 100 to 1,000 digits. */
/** A drawn magnitude's class and its signed count of units. */
interface Magnitude {
	readonly magnitude: MagnitudeFeature
	readonly units: bigint
}

const magnitudeGen: Gen<Magnitude> = weighted<Magnitude>([
	[
		2,
		(s) => ({
			magnitude: "a value within a signed 64-bit count",
			units: s.draw(bigint(-int8Max, int8Max))
		})
	],
	[
		2,
		(s) => {
			const past = s.draw(bigint(int8Max + 1n, tenTo(40)))
			return {
				magnitude: "a value past a signed 64-bit count",
				units: s.draw(element([1n, -1n])) * past
			}
		}
	],
	[
		1,
		(s) => {
			const digits = s.draw(int(100, 1000))
			const past = s.draw(bigint(tenTo(digits - 1), tenTo(digits) - 1n))
			return {
				magnitude: "a value of hundreds of digits",
				units: s.draw(element([1n, -1n])) * past
			}
		}
	]
])

/** The digit bound an operation's exact value is computed at: few digits, about a bigint's, or numeric's own limit. */
export type BoundFeature =
	| "a computed bound of a bigint's digits or fewer"
	| "a computed bound past a bigint's digits"
	| "a computed bound at numeric's own limit"

/** A drawn bound's class and its digits. */
interface Bound {
	readonly bound: BoundFeature
	readonly digits: number
}

const boundGen: Gen<Bound> = weighted<Bound>([
	[
		2,
		(s) => ({ bound: "a computed bound of a bigint's digits or fewer", digits: s.draw(int(0, 18)) })
	],
	[2, (s) => ({ bound: "a computed bound past a bigint's digits", digits: s.draw(int(19, 2000)) })],
	[1, () => ({ bound: "a computed bound at numeric's own limit", digits: numericMaxIntegerDigits })]
])

/**
 * A case of the typing property: a carrier, the digit bound of an exact value an operation computes, a drawn value of
 * the field's, and a digit count `edge`, 1 to 40, at whose power of ten the wire's spec of that bound is probed.
 */
interface TypingCase {
	readonly carrier: ExactValueCarrier
	readonly bound: BoundFeature
	readonly digits: number
	readonly magnitude: MagnitudeFeature
	readonly value: ExactValue
	readonly edge: number
}

export const typingCaseGen: Gen<TypingCase> = (s) => {
	const carrier = s.draw(element(["exactInteger", "exactMoney"] as const))
	const { bound, digits } = s.draw(boundGen)
	const { magnitude, units } = s.draw(magnitudeGen)
	return {
		carrier,
		bound,
		digits,
		magnitude,
		value: carrier === "exactInteger" ? integerValue(units) : amountValue(units),
		edge: s.draw(int(1, 40))
	}
}

/** Where a schema places an exact field: its relation's primary key, a candidate key, beside its key, or a derived head. */
export type Placement =
	| "in the primary key"
	| "in a candidate key"
	| "beside the key"
	| "a derived relation's head"

export const placements = [
	"in the primary key",
	"in a candidate key",
	"beside the key",
	"a derived relation's head"
] as const satisfies ReadonlyArray<Placement>

/** A relation holding an exact field `x` of `carrier` beside `id`, keyed by `id`. */
const holding = (carrier: ExactValueCarrier) =>
	relation("Holding", { id: pg.integer, x: exactFields[carrier] }, ["id"])

/** A relation holding an exact field `x` of `carrier` beside `id`, keyed by `x`. */
const keyedByExact = (carrier: ExactValueCarrier) =>
	relation("Holding", { id: pg.integer, x: exactFields[carrier] }, ["x"])

/** The schema of a placement of an exact field of `carrier` that a relation declares. */
export const declaredSchema = (
	carrier: ExactValueCarrier,
	placement: Exclude<Placement, "a derived relation's head">
) => {
	switch (placement) {
		case "in the primary key":
			return schema("Exact", [keyedByExact(carrier)], [])
		case "in a candidate key": {
			const R = holding(carrier)
			return schema("Exact", [R], [key(on(R, "id", "x"))])
		}
		case "beside the key":
			return schema("Exact", [holding(carrier)], [])
	}
}

/** The plain fields a derived head computes an exact value of `carrier` from: two bigints, or two amounts. */
const Plain = relation(
	"Plain",
	{ id: pg.integer, a: pg.bigint, b: pg.bigint, m: pg.money, n: pg.money },
	["id"]
)

/** The plain schema, the level a derived relation over Plain extends: Plain in a unit of its id. */
const PlainSchema = schema("Exact", [Plain], [unit("Plains", { id: pg.integer })])

/**
 * A level extending PlainSchema with a stored derived relation `Summed`, keyed by `id`, whose head `x` is `carrier`'s exact
 * value: the sum a + b of two bigints, an exact integer of 20 digits, or the sum m + n of two amounts, exact money.
 */
export const derivedLevel = (carrier: ExactValueCarrier) =>
	schemaBuilder.extend(
		[PlainSchema],
		"Derived",
		[
			derivedBuilder(
				"Summed",
				query(PlainSchema).rule((r) => {
					const { id, a, b, m, n } = v(Plain, "p")
					return r
						.match(Plain, { id, a, b, m, n })
						.find({ id, x: carrier === "exactInteger" ? Num.add(a, b) : Num.add(m, n) })
				}),
				[]
			)
		],
		[],
		[]
	)

/** The text of the column CHECK an exact field of `carrier` named `field` carries in its table's CREATE TABLE. */
export const exactCheckText = (field: string, carrier: ExactValueCarrier): string =>
	`CHECK (("pg_catalog"."scale"("${field}") = ${carrier === "exactInteger" ? 0 : 2}) IS TRUE)`

/**
 * What the refusal of a key over an exact field of `carrier` says the field is, and the precision it names, its fix, as
 * the specification states them.
 */
export const keyFaultOf: {
	readonly [C in ExactValueCarrier]: { readonly type: string; readonly precision: string }
} = {
	exactInteger: {
		type: "an exact integer",
		precision: "pg.numeric(p, 0), an integer of at most p digits read as a bigint, or pg.bigint"
	},
	exactMoney: {
		type: "exact money",
		precision: "pg.numeric(p, 2), or pg.money, a signed 64-bit count of cents"
	}
}

/** The precision the refusal of a key over an exact field of `carrier` names: its fix. */
export const precisionFix: { readonly [C in ExactValueCarrier]: string } = {
	exactInteger: "declare its precision: pg.numeric(p, 0)",
	exactMoney: "declare its precision: pg.numeric(p, 2)"
}
