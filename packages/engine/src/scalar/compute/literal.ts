import { taggedValueOf } from "#compiler/core/canonical.ts"
import { defect } from "#compiler/core/invariant.ts"
import { isRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { VectorText, vectorTag } from "#compiler/ir/carriers.ts"
import { dayNumber, toCalendarDate } from "#compiler/ir/date.ts"
import { decimalPayload, isDecimalLike } from "#compiler/ir/decimal.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import { floatSpecials, type TypedLiteral, literalProblem } from "#compiler/ir/expr.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { Decimal, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { canonicalZero, toReal } from "#compiler/scalar/values/float.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { toUuid } from "#compiler/scalar/values/uuid.ts"

const isSafeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value)

/**
 * The host type of a literal that meets no term, the rule of Compute.cond when both branches are literals: a
 * JavaScript number is an integer, a bigint a bigint, a Decimal numeric, a Money money, a boolean a boolean, and
 * a string text with the canonical wildcard. A float, a span or a vector literal always meets a term.
 */
type BareLiteralKind = "integer" | "bigint" | "numeric" | "money" | "boolean" | "text"

export const bareLiteralKind = (value: unknown): BareLiteralKind | undefined => {
	if (isSafeInteger(value)) {
		return "integer"
	}
	if (typeof value === "bigint") {
		return "bigint"
	}
	if (value instanceof Decimal || isDecimalLike(value)) {
		return "numeric"
	}
	if (value instanceof Money || taggedValueOf(value)?.tag === "m") {
		return "money"
	}
	if (typeof value === "boolean") {
		return "boolean"
	}
	if (typeof value === "string") {
		return "text"
	}
	return undefined
}

/**
 * The exact carrier value of a literal, as the evaluator holds it: integers as bigint, numeric as Decimal, floats as
 * number, money as Money, booleans, text, uuid and closed ids' handles as their primitives, a set over a roster as the
 * fresh Set of its handles, spans as { start, end } bigints, vectors as their canonical value.
 */
export type CarrierValue =
	| bigint
	| Decimal
	| number
	| Money
	| boolean
	| string
	| ReadonlySet<string>
	| { readonly start: bigint; readonly end: bigint }
	| { readonly vector: VectorText }

/** A decoded Description's set literal: its handles, each a string. */
const setHandles = (value: LiteralDesc): ReadonlyArray<string> | undefined => {
	if (!isRecord(value) || !Object.hasOwn(value, "handles") || !("handles" in value)) {
		return undefined
	}
	const handles: unknown = value.handles
	return Array.isArray(handles) && handles.every((h) => typeof h === "string") ? handles : undefined
}

export interface CarriedLiteral {
	readonly literal: TypedLiteral
	readonly value: CarrierValue
}

/**
 * A date span endpoint's position, the day number of the date its text names, the line a date span's endpoints lie on
 * in the IR and the evaluator; undefined for anything that is no calendar date.
 */
const dayPosition = (value: unknown): bigint | undefined => {
	const date = toCalendarDate(value)
	return date.ok ? BigInt(dayNumber(date.value)) : undefined
}

const asBigint = (value: unknown): bigint | undefined => {
	if (typeof value === "bigint") {
		return value
	}
	if (isSafeInteger(value)) {
		return BigInt(value)
	}
	return undefined
}

/** The components of a Vector a Description carries as "~v:" (scalar/values' Vector.canonical, ir/carriers.ts VectorText). */
const taggedVector = (value: unknown): VectorText | undefined => {
	const tagged = taggedValueOf(value)
	return tagged?.tag === vectorTag ? VectorText.parse(tagged.payload) : undefined
}

/** A Money that crossed a process boundary as "~m:" without the owned reviver (ir/carriers.ts MoneyText). */
const taggedMoney = (value: unknown): Money | undefined => {
	const tagged = taggedValueOf(value)
	const money = tagged?.tag === "m" ? Money.fromCanonical(tagged.payload) : undefined
	return money?.ok === true ? money.value : undefined
}

/**
 * Literal operands of the Compute catalogue.
 *
 * LiteralOf<T>: a literal over a numeric base is a Decimal, a bigint, or a string holding an exact decimal literal,
 * checked at construction; a JavaScript number is never a numeric literal, because it has already rounded to binary64.
 * Literals over smallint and integer are JavaScript integers, over bigint bigints, over real and double precision
 * JavaScript numbers (NaN and the infinities included), over money a Money, over boolean a boolean, over uuid its
 * hyphenated text in either case, over text a storable string, over a closed reference one of its handles, over a set
 * its handles in the roster's declared order, over a span a { start, end } of its endpoint's host type, and over a
 * vector a Vector of its dimensions. A literal never
 * has a type of its own unless Compute.literal gives it one: it takes the type of the term it meets.
 *
 * The builder's boundary, a host value to the LiteralDesc the Description carries, is scalar/registry.ts
 * literalDescFor. This module holds the IR's:
 * - irLiteral: a LiteralDesc to the typed IR literal and its exact carrier value at the type it adopted, refusing a
 *   value outside that type (literalProblem: a roster's handles, a vector's dimensions among it), which is how a
 *   description that TypeScript did not check is caught.
 *
 * The typed IR literal of `value` at type `t`, or why it is not a value of t (one line, no value in it). An integer
 * literal must be a JavaScript integer for smallint and integer and a bigint for bigint. A decimal at numeric(p, s) is
 * the value PostgreSQL's coercion stores: rounded to scale s, refused only when it then overflows.
 */
export const irLiteral = (
	value: LiteralDesc,
	t: ScalarType
): Result.Result<CarriedLiteral, string> =>
	Result.flatMap(carriedOf(value, t), (carried) => {
		const problem = literalProblem(carried.literal, t)
		return problem === undefined ? Result.ok(carried) : Result.err(problem)
	})

/**
 * The typed IR literal of an admitted closed relation's cell at its field's type (ir/desc.ts AdmittedClosedRelation):
 * its admission proved it a value of the type's base, of the host kind the type reads, so it is converted and never
 * checked again. A cell no admission proved is no AdmittedClosedRelation's, so a refusal here is a defect.
 */
export const admittedLiteral = (value: LiteralDesc, t: ScalarType): CarriedLiteral => {
	const carried = carriedOf(value, t)
	if (!carried.ok) {
		throw defect(`an admitted cell is a value of its field's type: ${carried.error}`)
	}
	return carried.value
}

/**
 * The typed IR literal of `value` at `t` and its carrier value, as `value`'s host kind gives it, or why its host kind
 * is none `t` reads: irLiteral's conversion, before it is held to `t`'s base (literalProblem).
 */
const carriedOf = (value: LiteralDesc, t: ScalarType): Result.Result<CarriedLiteral, string> => {
	const base = baseOf(t)
	/**
	 * A decoded Description's span holds its two endpoints.
	 *
	 * A decoded Description holds only these three specials.
	 */
	const finish = (
		literal: TypedLiteral,
		carrierValue: CarrierValue
	): Result.Result<CarriedLiteral, string> => Result.ok({ literal, value: carrierValue })
	switch (base.carrier) {
		case "int2":
		case "int4": {
			if (!isSafeInteger(value)) {
				return Result.err(`a JavaScript integer for ${base.carrier}`)
			}
			const v = BigInt(value)
			return finish({ kind: "int", value: v }, v)
		}
		case "int8":
			if (typeof value !== "bigint") {
				return Result.err("a bigint for bigint; a JavaScript number is not a bigint")
			}
			return finish({ kind: "int", value }, value)
		case "numeric": {
			if (typeof value === "number") {
				return Result.err(
					"an exact decimal: a Decimal, a bigint or a decimal string, never a JavaScript number"
				)
			}
			const parsed = isDecimalLike(value)
				? Decimal.fromString(decimalPayload(value))
				: Decimal.parse(value)
			if (!parsed.ok) {
				return Result.err("an exact decimal literal")
			}
			/**
			 * Native coercion happens before the value is a value of the type: a literal at
			 * numeric(p, s), a contract over one included, rounds half away from zero to scale s as the domain cast does,
			 * and only a rounded value that overflows the precision, or an infinity, is refused.
			 */
			const { typmod } = base
			if (typmod === undefined) {
				return finish({ kind: "numeric", value: parsed.value }, parsed.value)
			}
			const { precision, scale } = typmod
			const coerced = normalizeNumeric(parsed.value, typmod)
			if (!coerced.ok) {
				return Result.err(
					coerced.error === "numericInfinity"
						? `a finite value: numeric(${precision},${scale}) cannot hold an infinite value`
						: `a value that fits numeric(${precision},${scale}) once rounded to its scale`
				)
			}
			return finish({ kind: "numeric", value: coerced.value }, coerced.value)
		}
		case "float4":
		case "float8": {
			const special =
				isRecord(value) && Object.hasOwn(value, "float") && "float" in value
					? value.float
					: undefined
			if (special === "NaN" || special === "Infinity" || special === "-Infinity") {
				return finish({ kind: "floatSpecial", value: special }, floatSpecials[special])
			}
			if (typeof value !== "number" || !Number.isFinite(value)) {
				return Result.err(`a number for ${base.carrier}`)
			}
			if (base.carrier === "float8") {
				const double = canonicalZero(value)
				return finish({ kind: "float", value: double }, double)
			}
			const real = toReal(value)
			if (!real.ok) {
				return Result.err("a number within real's binary32 range")
			}
			return finish({ kind: "float", value: real.value }, real.value)
		}
		case "money": {
			if (value instanceof Money) {
				return finish({ kind: "money", value }, value)
			}
			const revived = taggedMoney(value)
			return revived === undefined
				? Result.err("a Money")
				: finish({ kind: "money", value: revived }, revived)
		}
		case "bool":
			return typeof value === "boolean"
				? finish({ kind: "bool", value }, value)
				: Result.err("a boolean")
		case "uuid": {
			const uuid = toUuid(value)
			return uuid.ok
				? finish({ kind: "uuid", value: uuid.value }, uuid.value)
				: Result.err("a uuid in the hyphenated 8-4-4-4-12 form")
		}
		case "date": {
			const date = toCalendarDate(value)
			return date.ok
				? finish({ kind: "date", value: date.value }, date.value)
				: Result.err("a calendar date written YYYY-MM-DD, from 0001-01-01 to 9999-12-31")
		}
		case "text":
			return typeof value === "string"
				? finish({ kind: "text", value }, value)
				: Result.err("a string")
		case "bytes":
			return Result.err("no literal: a bytes value is written and read back whole")
		case "code":
			return typeof value === "string"
				? finish({ kind: "handle", handle: value }, value)
				: Result.err("a handle")
		case "bits": {
			const handles = setHandles(value)
			return handles === undefined
				? Result.err("a set's handles")
				: finish({ kind: "handles", handles: Object.freeze([...handles]) }, new Set(handles))
		}
		case "range4":
		case "range8":
		case "rangeDate": {
			if (!isRecord(value) || !Object.hasOwn(value, "span") || !("span" in value)) {
				return Result.err("a span { start, end }")
			}
			const span: unknown = value.span
			if (!isRecord(span)) {
				return Result.err("a span's endpoints")
			}
			const position = base.carrier === "rangeDate" ? dayPosition : asBigint
			const start = position(span["start"])
			const end = position(span["end"])
			if (start === undefined || end === undefined) {
				return Result.err(
					base.carrier === "rangeDate" ? "date span endpoints" : "integer span endpoints"
				)
			}
			return finish({ kind: "span", start, end }, { start, end })
		}
		case "vector": {
			const vector = taggedVector(value)
			return vector === undefined
				? Result.err("a Vector of the field's dimensions")
				: finish({ kind: "vector", value: vector }, { vector })
		}
		case "exactInteger":
		case "exactMoney":
			return Result.err(
				"a literal of an exact value's family: opposite an exact integer a bigint literal, opposite exact money a Money"
			)
	}
}
