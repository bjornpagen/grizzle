import { Array as Arr, Data, Formatter, Result } from "effect"
import { indices } from "#compiler/core/array.ts"
import type { VectorText } from "#compiler/ir/carriers.ts"
import { convertDate } from "#compiler/ir/date.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { literalValue } from "#compiler/scalar/compute/evaluate.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { Decimal, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { canonicalZero } from "#compiler/scalar/values/float.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import {
	Identities,
	type ValueIdentity,
	type Interned,
	sameIdentity
} from "#test/support/kernel/identity.ts"
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
 * of its type or a failure. It is identified by its term as PostgreSQL computes it, the declined operations over the
 * values the reference states (evaluate.ts Reference termOf), never by a label of its DAG, so one term over equal values
 * is one value wherever it stands, in one DAG or in two. A delivered column holding one is compared by type alone
 * (compare.ts StatementRows.unstated). The only reading of one the reference states is its identity: whether two
 * others are equal, how one orders and what any other reading of it gives are unknown, and the reference refuses to
 * judge them (ReferenceUnsupported). The frontier reads a declined column by the same rule (frontier.ts mustEval).
 */
export class Declined {
	readonly identity: ValueIdentity
	readonly reason: DeclineReason

	constructor(identity: ValueIdentity, reason: DeclineReason) {
		this.identity = identity
		this.reason = reason
	}
}

/**
 * Values of the reference evaluator: exact carriers under PostgreSQL's native equality and order, each in its one form.
 *
 * A value is the exact carrier the Compute evaluators work over (compute/literal.ts CarrierValue): an integer as bigint,
 * numeric as Decimal, a float as a double, money as Money, booleans, text, uuids and closed ids' handles as strings, sets as Sets of handles. Every
 * value is the one form grizzle delivers: a Decimal has no display scale, and every float the reference holds has the
 * one zero, at its literal and at every operation result (evaluate/catalog.ts oneZero, aggregate.ts). A value stored
 * in, cast to or read through a column of a numeric(p, s) type is coerced as PostgreSQL's typmod coercion does, so
 * 1.234 stored in numeric(5,2) is 1.23.
 *
 * ValueIdentity is native equality, which for the one form is identity: 1.0 and 1.00 are one Decimal, -0 is 0, NaN = NaN.
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
export class ReferenceUnsupported extends Data.TaggedError("ReferenceUnsupported")<{
	readonly refusal: { readonly kind: "unsupported"; readonly what: string }
}> {
	override get message(): string {
		return `the reference evaluator does not evaluate ${this.refusal.what}`
	}
}

/** The refusal of a construct outside the fragment the reference evaluates, naming what it lacks. */
export const referenceUnsupported = (what: string): ReferenceUnsupported =>
	new ReferenceUnsupported({ refusal: { kind: "unsupported", what } })

/**
 * The value a column of `type` holds for `v`: numeric typmod coercion; every other carrier holds the value unchanged,
 * and a declined term's value stays itself. A value the type cannot hold is a defect of the generator, which draws only
 * values that fit.
 */
export const coerce = (v: Value, type: ScalarType): Value =>
	v instanceof Declined ? v : coerceStated(v, type)

/** The value a column of `type` holds for the stated value `v` (coerce). */
export const coerceStated = (v: CarrierValue, type: ScalarType): CarrierValue => {
	const base = baseOf(type)
	if (base.carrier !== "numeric" || base.typmod === undefined) {
		return v
	}
	const normalized = normalizeNumeric(asDecimal(v), base.typmod)
	if (!normalized.ok) {
		throw referenceUnsupported(`a numeric value outside its typmod`)
	}
	return normalized.value
}

/** A set's members in its roster's declared order; a value that is no Set of handles is a defect of the case. */
const setMembers = (v: Value, handles: ReadonlyArray<string>): ReadonlyArray<string> => {
	if (!(v instanceof Set)) {
		throw referenceUnsupported("a set value that is no Set of handles")
	}
	return Arr.filter(handles, (h) => v.has(h))
}

/** The value of a typed literal of `type`, as a typed SQL literal of that type evaluates. */
export const literalOf = (literal: TypedLiteral, type: ScalarType): Value =>
	coerce(literalValue(literal), type)

/**
 * PostgreSQL's comparison of two values of one type. Two declined values compare equal only as one term, their
 * identities one; any other comparison of a declined value is unknown.
 */
export const compare = (a: Value, b: Value, type: ScalarType): -1 | 0 | 1 => {
	if (a instanceof Declined && b instanceof Declined && sameIdentity(a.identity, b.identity)) {
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
 * A value's identity under native equality: its kind ("value" or "declined") and its atoms, each value in its one form,
 * so a stated value's atoms are its own (a numeric by its one text, a float by its number, a set by its members in roster
 * order after their count, a vector by its components after its dimensions); a declined term's, its term's (Declined
 * identity), after its length.
 */
export const valueIdentity = (v: Value, type: ScalarType): ValueIdentity => {
	if (v instanceof Declined) {
		return ["declined", v.identity.length, ...v.identity]
	}
	const base = baseOf(type)
	switch (base.carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "exactInteger":
			return ["value", asBigint(v)]
		case "numeric":
			return ["value", asDecimal(v).text]
		case "float4":
		case "float8":
			return ["value", asNumber(v)]
		case "money":
		case "exactMoney":
			return ["value", asMoney(v).minorUnits]
		case "bool":
			return ["value", v === true]
		case "bytes":
			throw referenceUnsupported("a bytes value, which is stored only")
		case "uuid":
		case "date":
		case "text":
		case "code":
			return ["value", asString(v)]
		case "bits": {
			const members = setMembers(v, base.roster.handles)
			return ["value", members.length, ...members]
		}
		case "range4":
		case "range8":
		case "rangeDate": {
			const { start, end } = asSpan(v)
			return ["value", start, end]
		}
		case "vector": {
			const components = asVector(v).components
			return ["value", components.length, ...components]
		}
	}
}

/**
 * A value's identity under native equality where it decides equality exactly as comparison does, for the evaluator's
 * hash lookups: the value is its type's carrier, and the type's comparison is 0 for exactly the values of one identity.
 * Otherwise undefined, and only comparison decides: a value of another carrier, whose comparison refuses, and a closed
 * id's handle outside its roster, which compares equal to every other such handle. A set is equal exactly to the set
 * of its members. A vector holds the one zero, so pgvector's order is 0 exactly between vectors of one identity.
 */
export const indexIdentity = (v: Value, type: ScalarType): ValueIdentity | undefined => {
	if (v instanceof Declined) {
		return undefined
	}
	const base = baseOf(type)
	switch (base.carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "exactInteger":
			return typeof v === "bigint" ? valueIdentity(v, type) : undefined
		case "numeric":
			return v instanceof Decimal ? valueIdentity(v, type) : undefined
		case "float4":
		case "float8":
			return typeof v === "number" ? valueIdentity(v, type) : undefined
		case "money":
		case "exactMoney":
			return v instanceof Money ? valueIdentity(v, type) : undefined
		case "bool":
			return typeof v === "boolean" ? valueIdentity(v, type) : undefined
		case "bytes":
			return undefined
		case "uuid":
		case "date":
		case "text":
			return typeof v === "string" ? valueIdentity(v, type) : undefined
		case "code":
			return typeof v === "string" && base.roster.handles.includes(v)
				? valueIdentity(v, type)
				: undefined
		case "bits":
			return v instanceof Set ? valueIdentity(v, type) : undefined
		case "range4":
		case "range8":
		case "rangeDate":
			return typeof v === "object" && "start" in v ? valueIdentity(v, type) : undefined
		case "vector":
			return typeof v === "object" && "vector" in v ? valueIdentity(v, type) : undefined
	}
}

/** A row's identity on `heading`: its values' identities in column order, each self-delimiting. */
export const rowIdentity = (row: Row, heading: Heading): ValueIdentity =>
	Arr.flatMap(heading, (c, i) => valueIdentity(valueAt(row, i), c.type))

/**
 * The identity of each row on `heading`, interned in `identities`, where the reference decides it: two rows that agree
 * on every column no row of `rows` leaves declined and differ in a column some row leaves declined may or may not be one
 * row in PostgreSQL, which the reference refuses to judge (a declined value from one expression and a stated one, or
 * declined values from two, are equal or not as PostgreSQL computes them). Every hash-equality site of the evaluator
 * keys its rows through it.
 */
export const decidedKeys = (
	rows: ReadonlyArray<Row>,
	heading: Heading,
	at: string,
	identities: Identities
): ReadonlyArray<Interned> => {
	const keys = Arr.map(rows, (row) => identities.of(rowIdentity(row, heading)))
	const open = new Set(
		Arr.filter(indices(heading.length), (i) => Arr.some(rows, (row) => declined(valueAt(row, i))))
	)
	if (open.size === 0) {
		return keys
	}
	const partials = new Identities()
	const decided = new Map<Interned, Interned>()
	for (const [r, row] of rows.entries()) {
		const partial = partials.of(
			Arr.flatMap(heading, (c, i): ValueIdentity =>
				open.has(i) ? ["open"] : valueIdentity(valueAt(row, i), c.type)
			)
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
	at: string,
	identities: Identities
): ReadonlyArray<Row> => {
	const keys = decidedKeys(rows, heading, at, identities)
	const seen = new Set<Interned>()
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
 * The outcome of a reading: its value; its decline, named (DeclineReason): a term the oracle declines, or a reading of
 * a declined term's value; an operation it meets where its precondition fails; or a term the Compute evaluator does not
 * evaluate, named. No term PostgreSQL evaluates meets an undefined operation, since every partial operation stands with
 * its proof, but an operand of a declined term read alone may, where an operand the reference declines decides whether
 * PostgreSQL evaluates it, and may be one the evaluator never reached (evaluate.ts Reference termOf).
 */
export type ReadingOutcome =
	| { readonly kind: "value"; readonly value: CarrierValue }
	| { readonly kind: "declined"; readonly reason: DeclineReason }
	| { readonly kind: "undefined"; readonly what: string }
	| { readonly kind: "unsupported"; readonly what: string }

/**
 * The outcome of a reading, run once through `read`: every value is in its one form, so one run is the reading. A run
 * that reads a declined term's value is declined, whatever it gives.
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
			return { kind: "undefined", what: stop.what }
		case "declined":
			return { kind: "declined", reason: stop.evaluation }
		case "unsupported":
			return { kind: "unsupported", what: stop.what }
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
		case "bytes":
			throw referenceUnsupported("a bytes value, which is stored only")
		case "text":
			return { kind: "text", value: asString(v) }
		case "uuid":
			return { kind: "uuid", value: asString(v) }
		case "date":
			return { kind: "date", value: convertDate(asString(v)) }
		case "code":
			return { kind: "handle", handle: asString(v) }
		case "bits":
			return { kind: "handles", handles: setMembers(v, base.roster.handles) }
		case "range4":
		case "range8":
		case "rangeDate": {
			const { start, end } = asSpan(v)
			return { kind: "span", start, end }
		}
		case "vector":
			return { kind: "vector", value: asVector(v) }
	}
}
