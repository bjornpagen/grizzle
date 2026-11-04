import { Array as Arr, Formatter, Result, Schema } from "effect"
import { indices } from "#compiler/core/array.ts"
import type { VectorText } from "#compiler/ir/carriers.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { literalValue } from "#compiler/scalar/compute/evaluate.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { Decimal, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { canonicalZero, floatText } from "#compiler/scalar/values/float.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { type CatalogResult, compareCarried } from "#test/support/oracle/evaluate/catalog.ts"

/**
 * Why the reference states no value: a closed union, so a new way to give up is a type change, and each is a named,
 * countable situation the suites note (evaluate.ts ReferenceObserver.decline).
 * - database: a term PostgreSQL alone computes (evaluate/catalog.ts Evaluation "database": a float's pow through the
 *   platform libm, pgvector's operations);
 * - estimated: numeric power where a libm estimate decides PostgreSQL's choices and the host's may not agree
 *   (evaluate/power.ts libmEstimate);
 * - declinedRead: a reading of a declined value, whose value the reference does not list.
 */
export type DeclineReason = "database" | "estimated" | "declinedRead"

export const declineReasons: Arr.NonEmptyReadonlyArray<DeclineReason> = [
	"database",
	"estimated",
	"declinedRead"
]

/**
 * A value the reference does not state: a declined term's (DeclineReason), which PostgreSQL alone computes, any value
 * of its type or a failure. It is identified by its reading and the values of what that reading reads, so two of one
 * reading over equal reads are one value. A delivered column holding one is compared by type alone (compare.ts
 * StatementRows.unstated). The only reading of one the reference states is its identity: whether two others are equal,
 * how one orders and what any other reading of it gives are unknown, and the reference refuses to judge them
 * (ReferenceUnsupported). The frontier reads a declined column by the same rule (frontier.ts mustEval).
 */
export class Declined {
	readonly identity: string
	readonly reason: DeclineReason

	constructor(identity: string, reason: DeclineReason) {
		this.identity = identity
		this.reason = reason
	}
}

/**
 * Values of the reference evaluator: exact carriers under PostgreSQL's native equality and order, each in its one form.
 *
 * A value is the exact carrier the Compute evaluators work over (compute/literal.ts CarrierValue): an integer as bigint,
 * numeric as Decimal, a float as a double, money as Money, booleans, text, uuids and enum handles as strings. Every
 * value is the one form grizzle delivers: a Decimal has no display scale, and every float the reference holds has the
 * one zero, at its literal and at every operation result (evaluate/catalog.ts oneZero, aggregate.ts). A value stored
 * in, cast to or read through a column of a numeric(p, s) type is coerced as PostgreSQL's typmod coercion does, so
 * 1.234 stored in numeric(5,2) is 1.23.
 *
 * Identity is native equality, which for the one form is identity: 1.0 and 1.00 are one Decimal, -0 is 0, NaN = NaN.
 * A collapse (DISTINCT, UNION, GROUP BY, a join variable, min and max) keeps one of natively equal values, which are
 * identical, so which one it keeps is unobservable and the reference states every collapse exactly.
 */
export type Value = CarrierValue | Declined
export type Row = ReadonlyArray<Value>

/**
 * A value read as the carrier its type names. The evaluator holds each value as its type's carrier, so a value of
 * another carrier is a defect of the evaluator, never of the case; a declined value has no carrier to read, and a
 * reader of one refuses it.
 */
const wrongCarrier = (v: Value, expected: string): never => {
	if (v instanceof Declined) {
		throw referenceUnsupported(`the value of a declined term, read as ${expected}`)
	}
	throw new Error(
		`the reference holds ${typeof v} ${Formatter.format(v)} where ${expected} was expected`
	)
}

export const asBigint = (v: Value): bigint =>
	typeof v === "bigint" ? v : wrongCarrier(v, "a bigint")

export const asDecimal = (v: Value): Decimal =>
	v instanceof Decimal ? v : wrongCarrier(v, "a Decimal")

export const asNumber = (v: Value): number =>
	typeof v === "number" ? v : wrongCarrier(v, "a number")
export const asMoney = (v: Value): Money => (v instanceof Money ? v : wrongCarrier(v, "a Money"))
const asBoolean = (v: Value): boolean => (typeof v === "boolean" ? v : wrongCarrier(v, "a boolean"))
const asString = (v: Value): string => (typeof v === "string" ? v : wrongCarrier(v, "a string"))
/** A span value: its two bigint endpoints. */
export const asSpan = (v: Value): { readonly start: bigint; readonly end: bigint } =>
	typeof v === "object" && "start" in v && "end" in v ? v : wrongCarrier(v, "a span")

/**
 * A vector value: its canonical form, whose text is "[c1,...,cn]" with every component the shortest text of its binary32
 * value and -0 stored as +0 (ir/carriers.ts VectorText), so the vectors pgvector finds equal have one text.
 */
const asVector = (v: Value): VectorText =>
	typeof v === "object" && "vector" in v ? v.vector : wrongCarrier(v, "a vector")
const vectorText = (v: Value): string => asVector(v).toString()

/** The item at index i of a list the caller built to that length; a missing one is a defect of the evaluator. */
const elementOf = <A>(items: ReadonlyArray<A>, i: number): A => {
	const item = items[i]
	if (item === undefined) {
		throw new Error(`the reference holds no item ${i}`)
	}
	return item
}

/** The value at column i of a row whose heading the caller holds; a missing one is a defect of the evaluator. */
export const valueAt = (row: Row, i: number): Value => {
	const v = row[i]
	if (v === undefined) {
		throw new Error(`the reference row has no column ${i}`)
	}
	return v
}

/**
 * What the reference refuses to evaluate: it evaluates only the generator fragment, and anything else is refused with
 * what it lacks, which makes a harness that compares rows refuse the case. No expression it evaluates fails: every
 * partial operation stands with its proof, so an operation met where its precondition fails is a defect, thrown
 * (outcomeOf).
 */
export class ReferenceUnsupported extends Schema.TaggedError<
	ReferenceUnsupported,
	{ readonly brand: unique symbol }
>()("ReferenceUnsupported", {
	refusal: Schema.Struct({ kind: Schema.Literal("unsupported"), what: Schema.String })
}) {
	override get message(): string {
		return `the reference evaluator does not evaluate ${this.refusal.what}`
	}
}

/** The refusal of a construct outside the fragment the reference evaluates, naming what it lacks. */
export const referenceUnsupported = (what: string): ReferenceUnsupported =>
	ReferenceUnsupported.make({ refusal: { kind: "unsupported", what } })

/**
 * The value a column of `type` holds for `v`: numeric typmod coercion; every other carrier holds the value unchanged,
 * and a declined term's value stays itself. A value the type cannot hold is a defect of the generator, which draws only
 * values that fit.
 */
export const coerce = (v: Value, type: ScalarType): Value => {
	const base = baseOf(type)
	if (base.carrier !== "numeric" || base.typmod === undefined || v instanceof Declined) {
		return v
	}
	const normalized = normalizeNumeric(asDecimal(v), base.typmod)
	if (!normalized.ok) {
		throw referenceUnsupported(`a numeric value outside its typmod`)
	}
	return normalized.value
}

/** The value of a typed literal of `type`, as a typed SQL literal of that type evaluates. */
export const literalOf = (literal: TypedLiteral, type: ScalarType): Value =>
	coerce(literalValue(literal), type)

/** A declined term's identity; undefined for any other value. */
const identityOf = (v: Value): string | undefined =>
	v instanceof Declined ? v.identity : undefined

/**
 * PostgreSQL's comparison of two values of one type. Two declined values compare equal only as one reading over equal
 * reads; any other comparison of a declined value is unknown.
 */
export const compare = (a: Value, b: Value, type: ScalarType): -1 | 0 | 1 => {
	const identity = identityOf(a)
	if (identity !== undefined && identity === identityOf(b)) {
		return 0
	}
	if (a instanceof Declined || b instanceof Declined) {
		throw referenceUnsupported("a comparison of a declined term's value")
	}
	const c = compareCarried(a, b, type)
	if (c === undefined) {
		throw referenceUnsupported(`comparison of ${baseOf(type).carrier} values`)
	}
	return c
}

export const equal = (a: Value, b: Value, type: ScalarType): boolean => compare(a, b, type) === 0

/**
 * A value's identity under native equality, as text: its canonical text, since every value is in its one form; a
 * declined term's, its reading's over its reads.
 */
export const valueKey = (v: Value, type: ScalarType): string => {
	if (v instanceof Declined) {
		return `u${v.identity}`
	}
	const base = baseOf(type)
	switch (base.carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "exactInteger":
			return asBigint(v).toString()
		case "numeric":
			return `d${asDecimal(v).text}`
		case "float4":
		case "float8":
			return `f${floatText(asNumber(v))}`
		case "money":
		case "exactMoney":
			return `m${asMoney(v).minorUnits.toString()}`
		case "bool":
			return v === true ? "t" : "f"
		case "uuid":
		case "text":
		case "enum":
			return `x${asString(v)}`
		case "range4":
		case "range8": {
			const { start, end } = asSpan(v)
			return `s${start},${end}`
		}
		case "vector":
			return `v${vectorText(v)}`
	}
}

/**
 * A value's identity under native equality where it decides equality exactly as comparison does, for the evaluator's
 * hash lookups: the value is its type's carrier, and the type's comparison is 0 for exactly the values of one identity.
 * Otherwise undefined, and only comparison decides: a value of another carrier, whose comparison refuses, and an enum
 * handle outside its roster, which compares equal to every other such handle. A vector holds the one zero, so pgvector's
 * order is 0 exactly between vectors of one canonical text.
 */
export const indexKey = (v: Value, type: ScalarType): string | undefined => {
	if (v instanceof Declined) {
		return undefined
	}
	const base = baseOf(type)
	switch (base.carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "exactInteger":
			return typeof v === "bigint" ? v.toString() : undefined
		case "numeric":
			return v instanceof Decimal ? valueKey(v, type) : undefined
		case "float4":
		case "float8":
			return typeof v === "number" ? valueKey(v, type) : undefined
		case "money":
		case "exactMoney":
			return v instanceof Money ? valueKey(v, type) : undefined
		case "bool":
			return typeof v === "boolean" ? valueKey(v, type) : undefined
		case "uuid":
		case "text":
			return typeof v === "string" ? valueKey(v, type) : undefined
		case "enum":
			return typeof v === "string" && base.roster.handles.includes(v)
				? valueKey(v, type)
				: undefined
		case "range4":
		case "range8":
			return typeof v === "object" && "start" in v ? valueKey(v, type) : undefined
		case "vector":
			return typeof v === "object" && "vector" in v ? valueKey(v, type) : undefined
	}
}

/**
 * Identities joined into one, each length-prefixed, so no part's text runs into the next: a declined value's identity
 * holds the separators a plain join would use.
 */
export const joinedKey = (parts: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(parts, (p) => `${p.length}:${p}`),
		""
	)

export const rowKey = (row: Row, heading: Heading): string =>
	joinedKey(Arr.map(heading, (c, i) => valueKey(valueAt(row, i), c.type)))

/**
 * The identity of each row on `heading`, where the reference decides it: two rows that agree on every column no row of
 * `rows` leaves declined and differ in a column some row leaves declined may or may not be one row in PostgreSQL, which
 * the reference refuses to judge (a declined value from one expression and a stated one, or declined values from two,
 * are equal or not as PostgreSQL computes them). Every hash-equality site of the evaluator keys its rows through it.
 */
export const decidedKeys = (
	rows: ReadonlyArray<Row>,
	heading: Heading,
	at: string
): ReadonlyArray<string> => {
	const keys = Arr.map(rows, (row) => rowKey(row, heading))
	const open = new Set(
		Arr.filter(indices(heading.length), (i) => Arr.some(rows, (row) => declined(valueAt(row, i))))
	)
	if (open.size === 0) {
		return keys
	}
	const decided = new Map<string, string>()
	for (const [r, row] of rows.entries()) {
		const partial = joinedKey(
			Arr.map(heading, (c, i) => (open.has(i) ? "?" : valueKey(valueAt(row, i), c.type)))
		)
		const key = elementOf(keys, r)
		const other = decided.get(partial)
		if (other !== undefined && other !== key) {
			throw referenceUnsupported(`${at} over rows told apart by declined terms alone`)
		}
		decided.set(partial, key)
	}
	return keys
}

/**
 * The set of `rows`: the first of each class of natively equal rows, in input order, where the reference decides
 * equality (decidedKeys). Natively equal rows are identical, so the first stands for every one.
 */
export const distinctRows = (
	rows: ReadonlyArray<Row>,
	heading: Heading,
	at: string
): ReadonlyArray<Row> => {
	const keys = decidedKeys(rows, heading, at)
	const seen = new Set<string>()
	const out: Array<Row> = []
	for (const [r, row] of rows.entries()) {
		const key = elementOf(keys, r)
		if (!seen.has(key)) {
			seen.add(key)
			out.push(row)
		}
	}
	return out
}

/** Whether a value is a declined term's, whose values the reference does not list. */
const declined = (v: Value): v is Declined => v instanceof Declined

/** A stated value itself; undefined for a declined term's, whose values are not listed. */
export const statedValue = (v: Value): CarrierValue | undefined =>
	v instanceof Declined ? undefined : v

/** How a reading reads a value: a stated value is itself, and a declined term's none, which declines the reading. */
export type CarrierRead = (v: Value) => CarrierValue | undefined

/**
 * The outcome of a reading: its value, or its decline, named (DeclineReason): a term the oracle declines, or a reading
 * of a declined term's value.
 */
export type ReadingOutcome =
	| { readonly kind: "value"; readonly value: CarrierValue }
	| { readonly kind: "declined"; readonly reason: DeclineReason }

/**
 * The outcome of a reading, run once through `read`: every value is in its one form, so one run is the reading. A run
 * that reads a declined term's value is declined, whatever it gives. A term the Compute evaluator does not evaluate is
 * refused.
 */
export const outcomeOf = (run: (read: CarrierRead) => CatalogResult): ReadingOutcome => {
	const declinedReads: Array<Declined> = []
	const result = run((v) => {
		if (v instanceof Declined) {
			declinedReads.push(v)
			return undefined
		}
		return v
	})
	if (declinedReads.length > 0) {
		return { kind: "declined", reason: "declinedRead" }
	}
	if (Result.isSuccess(result)) {
		return { kind: "value", value: result.success }
	}
	const stop = result.failure
	switch (stop.kind) {
		case "undefined":
			throw new Error(
				`the reference met an operation where its precondition fails (${stop.what}): a partial operation stands without its proof`
			)
		case "declined":
			return { kind: "declined", reason: stop.evaluation }
		case "unsupported":
			throw referenceUnsupported(stop.what)
	}
}

/**
 * The typed IR literal of a value of `type`, for rendering through PostgreSQL's output functions: an exact integer as
 * its integer and exact money as its amount, which no column stores but a rendering spells at the exact value's SQL type.
 */
export const literalOfValue = (v: Value, type: ScalarType): TypedLiteral => {
	const base = baseOf(type)
	switch (base.carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "exactInteger":
			return { kind: "int", value: asBigint(v) }
		case "numeric":
			return { kind: "numeric", value: asDecimal(v) }
		case "float4":
		case "float8": {
			const x = asNumber(v)
			if (Number.isNaN(x)) {
				return { kind: "floatSpecial", value: "NaN" }
			}
			if (x === Number.POSITIVE_INFINITY) {
				return { kind: "floatSpecial", value: "Infinity" }
			}
			if (x === Number.NEGATIVE_INFINITY) {
				return { kind: "floatSpecial", value: "-Infinity" }
			}
			return { kind: "float", value: canonicalZero(x) }
		}
		case "money":
		case "exactMoney":
			return { kind: "money", value: asMoney(v) }
		case "bool":
			return { kind: "bool", value: asBoolean(v) }
		case "text":
			return { kind: "text", value: asString(v) }
		case "uuid":
			return { kind: "uuid", value: asString(v) }
		case "enum":
			return { kind: "enum", handle: asString(v) }
		case "range4":
		case "range8": {
			const { start, end } = asSpan(v)
			return { kind: "span", start, end }
		}
		case "vector":
			return { kind: "vector", value: asVector(v) }
	}
}
