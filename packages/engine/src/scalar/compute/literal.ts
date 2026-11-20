import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { floatSpecials, isFloatSpecialName, taggedValueOf } from "#compiler/core/canonical.ts"
import { isRecord } from "#compiler/core/record.ts"
import { floatLiteral, VectorText, vectorTag } from "#compiler/ir/carriers.ts"
import { type CalendarDate, dateOfDayNumber, dayNumber, toCalendarDate } from "#compiler/ir/date.ts"
import { decimalPayload, isDecimalLike } from "#compiler/ir/decimal.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import { type TypedLiteral, literalProblem } from "#compiler/ir/expr.ts"
import { baseOf, type Carrier, type ScalarType, typeLabel } from "#compiler/ir/scalar.ts"
import { Decimal, integerOfDecimal, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { toReal } from "#compiler/scalar/values/float.ts"
import { type HostValue, hostOf } from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import { toUuid } from "#compiler/scalar/values/uuid.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"

const isSafeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value)

/**
 * The host type of a literal that meets no term, the rule of Logic.cond when both branches are literals: a
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

/** A decoded Description's set literal: its handles, each a string. */
const setHandles = (value: LiteralDesc): ReadonlyArray<string> | undefined => {
	if (!isRecord(value) || !Object.hasOwn(value, "handles") || !("handles" in value)) {
		return undefined
	}
	const handles: unknown = value.handles
	return Array.isArray(handles) && handles.every((h) => typeof h === "string") ? handles : undefined
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
 * Literal operands of the scalar catalogue.
 *
 * LiteralOf<T>: a literal over a numeric base is a Decimal, a bigint, or a string holding an exact decimal literal,
 * checked at construction; a JavaScript number is never a numeric literal, because it has already rounded to binary64.
 * Literals over smallint and integer are JavaScript integers, over bigint bigints, over real and double precision
 * JavaScript numbers (NaN and the infinities included), over money a Money, over boolean a boolean, over uuid its
 * hyphenated text in either case, over text a storable string, over a closed reference one of its handles, over a set
 * its handles in the roster's declared order, over a span a { start, end } of its endpoint's host type, and over a
 * vector a Vector of its dimensions. A literal never
 * has a type of its own unless Type.literal gives it one: it takes the type of the term it meets.
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
export const irLiteral = (value: LiteralDesc, t: ScalarType): Result.Result<TypedLiteral, string> =>
	Result.flatMap(literalOf(value, t), (literal) => {
		const problem = literalProblem(literal, t)
		return problem === undefined ? Result.ok(literal) : Result.err(problem)
	})

/**
 * The typed IR literal of an admitted closed relation's cell at its field's type (ir/desc.ts AdmittedClosedRelation):
 * its admission proved it a value of the type's base, of the host kind the type reads, so it is converted and never
 * checked again. A cell no admission proved is no AdmittedClosedRelation's, so a refusal here is a defect.
 */
export const admittedLiteral = (value: LiteralDesc, t: ScalarType): TypedLiteral => {
	const literal = literalOf(value, t)
	if (!literal.ok) {
		throw defect(`an admitted cell is a value of its field's type: ${literal.error}`)
	}
	return literal.value
}

/**
 * The typed IR literal of `value` at `t`, as `value`'s host kind gives it, or why its host kind is none `t` reads:
 * irLiteral's conversion, before it is held to `t`'s base (literalProblem).
 */
const literalOf = (value: LiteralDesc, t: ScalarType): Result.Result<TypedLiteral, string> => {
	const base = baseOf(t)
	switch (base.carrier) {
		case "int2":
		case "int4": {
			if (!isSafeInteger(value)) {
				return Result.err(`a JavaScript integer for ${base.carrier}`)
			}
			return Result.ok({ kind: "int", value: BigInt(value) })
		}
		case "int8":
			if (typeof value !== "bigint") {
				return Result.err("a bigint for bigint; a JavaScript number is not a bigint")
			}
			return Result.ok({ kind: "int", value })
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
			 * and only a rounded value that overflows the precision, an infinity, or NaN at scale 0, whose values are
			 * integers (ir/carriers.ts isIntegerTypmod), is refused.
			 */
			const { typmod } = base
			if (typmod === undefined) {
				return Result.ok({ kind: "numeric", value: parsed.value })
			}
			const { precision, scale } = typmod
			const coerced = normalizeNumeric(parsed.value, typmod)
			if (!coerced.ok) {
				return Result.err(
					coerced.error === "numericInfinity"
						? `a finite value: numeric(${precision},${scale}) cannot hold an infinite value`
						: coerced.error === "numericNaN"
							? `an integer: numeric(${precision},${scale}) holds integers alone, never NaN`
							: `a value that fits numeric(${precision},${scale}) once rounded to its scale`
				)
			}
			return Result.ok({ kind: "numeric", value: coerced.value })
		}
		case "float4":
		case "float8": {
			const special =
				isRecord(value) && Object.hasOwn(value, "float") && "float" in value
					? value.float
					: undefined
			if (isFloatSpecialName(special)) {
				return Result.ok({ kind: "floatSpecial", value: special })
			}
			if (typeof value !== "number" || !Number.isFinite(value)) {
				return Result.err(`a number for ${base.carrier}`)
			}
			if (base.carrier === "float8") {
				return Result.ok(floatLiteral(value))
			}
			const real = toReal(value)
			if (!real.ok) {
				return Result.err("a number within real's binary32 range")
			}
			return Result.ok(floatLiteral(real.value))
		}
		case "money": {
			if (value instanceof Money) {
				return Result.ok({ kind: "money", value })
			}
			const revived = taggedMoney(value)
			return revived === undefined
				? Result.err("a Money")
				: Result.ok({ kind: "money", value: revived })
		}
		case "bool":
			return typeof value === "boolean"
				? Result.ok({ kind: "bool", value })
				: Result.err("a boolean")
		case "uuid": {
			const uuid = toUuid(value)
			return uuid.ok
				? Result.ok({ kind: "uuid", value: uuid.value })
				: Result.err("a uuid in the hyphenated 8-4-4-4-12 form")
		}
		case "date": {
			const date = toCalendarDate(value)
			return date.ok
				? Result.ok({ kind: "date", value: date.value })
				: Result.err("a calendar date written YYYY-MM-DD, from 0001-01-01 to 9999-12-31")
		}
		case "text":
			return typeof value === "string" ? Result.ok({ kind: "text", value }) : Result.err("a string")
		case "bytes":
			return Result.err("no literal: a bytes value is written and read back whole")
		case "tsvector":
			return Result.err("no literal: a search document is PostgreSQL's parse of its row's texts")
		case "code":
			return typeof value === "string"
				? Result.ok({ kind: "handle", handle: value })
				: Result.err("a handle")
		case "bits": {
			const handles = setHandles(value)
			return handles === undefined
				? Result.err("a set's handles")
				: Result.ok({ kind: "handles", handles: Object.freeze([...handles]) })
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
			return Result.ok({ kind: "span", start, end })
		}
		case "vector": {
			const vector = taggedVector(value)
			return vector === undefined
				? Result.err("a Vector of the field's dimensions")
				: Result.ok({ kind: "vector", value: vector })
		}
		case "exactInteger":
		case "exactMoney":
			return Result.err(
				"a literal of an exact value's family: opposite an exact integer a bigint literal, opposite exact money a Money"
			)
	}
}

/**
 * A span literal's endpoints, positions on its carrier's line (a date span's day numbers), as its host value's. A span
 * literal is a value of a span type only (ir/expr.ts literalProblem), so another carrier is a defect.
 */
const spanHost = (
	carrier: Carrier,
	literal: Extract<TypedLiteral, { readonly kind: "span" }>
): Span<number> | Span<bigint> | Span<CalendarDate> => {
	if (carrier !== "range4" && carrier !== "range8" && carrier !== "rangeDate") {
		throw defect(`a span literal is a value of a span type, not of ${carrier}`)
	}
	switch (carrier) {
		case "range4":
			return Object.freeze({ start: Number(literal.start), end: Number(literal.end) })
		case "range8":
			return Object.freeze({ start: literal.start, end: literal.end })
		case "rangeDate":
			return Object.freeze({
				start: dateOfDayNumber(literal.start),
				end: dateOfDayNumber(literal.end)
			})
	}
}

/**
 * The host value of a typed literal at its type's carrier `carrier`, the codec's own (scalar/values/identity.ts
 * CarrierHost): what the evaluator holds a literal as, a fill writes a literal start as and a closed relation's cell is
 * read as. A literal over smallint or integer is a JavaScript integer and over bigint a bigint, a numeric a Decimal,
 * money a Money, a float a number, a set the fresh Set of its handles, an int4 span's endpoints JavaScript integers and
 * a date span's the dates its day numbers are, a vector a fresh Vector of its components. A numeric literal at the
 * exact integer's carrier is an integer numeric field's (values/identity.ts CarrierSpec), its bigint. The one conversion
 * of a literal to a host value, whose inverse is literalOfHost.
 */
/** A literal of an integer numeric, numeric(p, 0), as its field holds it, a bigint: its stored literal refused a fraction
 * and NaN (scalar/literal.ts storedLiteral), so any other is a defect. */
const integerOfLiteral = (d: Decimal): bigint => {
	const x = integerOfDecimal(d)
	if (x === undefined) {
		throw defect("a literal of numeric(p, 0) is an integer")
	}
	return x
}

export const hostOfLiteral = (carrier: Carrier, literal: TypedLiteral): HostValue => {
	switch (literal.kind) {
		case "int":
			return carrier === "int2" || carrier === "int4" ? Number(literal.value) : literal.value
		case "numeric": {
			const d = Decimal.fromValue(literal.value)
			return carrier === "exactInteger" ? integerOfLiteral(d) : d
		}
		case "float":
			return literal.value
		case "floatSpecial":
			return floatSpecials[literal.value]
		case "money":
			return Money.fromValue(literal.value)
		case "bool":
			return literal.value
		case "text":
		case "uuid":
		case "date":
			return literal.value
		case "handle":
			return literal.handle
		case "handles":
			return new Set(literal.handles)
		case "span":
			return spanHost(carrier, literal)
		case "vector":
			return Vector.fromValue(literal.value)
		case "pattern":
			return literal.value.spelling
	}
}

/** A span's endpoints as its literal's positions: an integer itself, a date its day number. */
const spanLiteral = <E>(span: Span<E>, position: (endpoint: E) => bigint): TypedLiteral => ({
	kind: "span",
	start: position(span.start),
	end: position(span.end)
})

/**
 * The typed literal of a host value of `type`, the inverse of hostOfLiteral: what a constant subterm the host evaluated
 * is printed as (physical/ddl/expr.ts). A set's handles come in its roster's declared order. The evaluator's value of an
 * expression is a value of the expression's type (hostOf), and a bytes value has no literal, so either is a defect.
 */
export const literalOfHost = (value: HostValue, type: ScalarType): TypedLiteral => {
	const base = baseOf(type)
	switch (base.carrier) {
		case "int2":
		case "int4":
			return { kind: "int", value: BigInt(hostOf(base.carrier, value)) }
		case "int8":
		case "exactInteger":
			return { kind: "int", value: hostOf(base.carrier, value) }
		case "numeric":
			return { kind: "numeric", value: hostOf("numeric", value) }
		case "float4":
		case "float8":
			return floatLiteral(hostOf(base.carrier, value))
		case "money":
		case "exactMoney":
			return { kind: "money", value: hostOf(base.carrier, value) }
		case "bool":
			return { kind: "bool", value: hostOf("bool", value) }
		case "text":
			return { kind: "text", value: hostOf("text", value) }
		case "uuid":
			return { kind: "uuid", value: hostOf("uuid", value) }
		case "date":
			return { kind: "date", value: hostOf("date", value) }
		case "code":
			return { kind: "handle", handle: hostOf("code", value) }
		case "bits": {
			const set = hostOf("bits", value)
			return { kind: "handles", handles: base.roster.handles.filter((h) => set.has(h)) }
		}
		case "range4":
			return spanLiteral(hostOf("range4", value), BigInt)
		case "range8":
			return spanLiteral(hostOf("range8", value), (endpoint) => endpoint)
		case "rangeDate":
			return spanLiteral(hostOf("rangeDate", value), (endpoint) => BigInt(dayNumber(endpoint)))
		case "vector": {
			const text = Vector.canonical(hostOf("vector", value))
			if (!text.ok) {
				throw defect(`a constant of ${typeLabel(type)} is a vector of finite components`)
			}
			return { kind: "vector", value: text.value }
		}
		case "bytes":
			throw defect(`a constant of ${typeLabel(type)}: a bytes value has no literal`)
		case "tsvector":
			throw defect(`a constant of ${typeLabel(type)}: a search document has no literal`)
	}
}
