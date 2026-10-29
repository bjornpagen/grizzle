import { Array as Arr, Formatter, Option, Order, Result, Schema } from "effect"
import type { VectorText } from "#compiler/ir/carriers.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { compareValues, literalValue } from "#compiler/scalar/compute/evaluate.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { Decimal, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { floatIdentityText } from "#compiler/scalar/values/float.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import type { CatalogResult } from "#test/support/oracle/evaluate/catalog.ts"
import { indices } from "#test/support/oracle/pick.ts"

/**
 * A value the reference does not state in full: one of the values PostgreSQL may hold there, known as `known` says.
 * - declined: the value of a term the oracle declines (oracle/evaluate/catalog.ts declinedOps), which PostgreSQL
 *   alone computes, or of a reading the possibilities below disagree on: any value of its type, or a failure. It is
 *   identified by its reading and the spellings of what that reading reads, so two of one reading over reads spelled
 *   alike are one value. A delivered column holding one is compared by type alone (compare.ts StatementRows.unstated).
 * - merged: a numeric or float a collapse merged with natively equal values of other spellings (mergedValue), a numeric
 *   of other display scales or a float zero of the other sign: any of its spellings. Delivered, its cell is compared by
 *   value (compare.ts MergedCells).
 *
 * One rule reads both. A reading of an unstated value (an expression over it, a predicate, an aggregate, a comparison,
 * a coercion into a column) is that reading of every value it may hold: stated where they all give one
 * outcome (agreedOutcome), that is one value spelled alike, natively equal values of other spellings (a merged value
 * again) or a failure; PostgreSQL's alone, a declined value, where they do not. A declined term's values are not listed, so the
 * only reading of one the reference states is its identity: whether two others are equal, how one orders and what any
 * other reading of it gives are unknown, and the reference refuses to judge them (ReferenceUnsupported). A merged
 * value's spellings share one value, so its comparison, its key and its coercion into a numeric(p, s) column read that
 * value; a reading its spelling reaches (a numeric result's scale, a quotient's digits, a zero's sign, its text)
 * differs per spelling. The frontier reads an unstated column by the same rule (frontier.ts mustEval): an outcome every
 * possibility gives is certain, and any other one may or may not fail.
 */
type Known =
	| { readonly kind: "declined"; readonly identity: string }
	| { readonly kind: "merged"; readonly spellings: Arr.NonEmptyReadonlyArray<CarrierValue> }

export class Unstated {
	readonly known: Known

	constructor(known: Known) {
		this.known = known
	}
}

/**
 * Values of the reference evaluator: exact carriers under PostgreSQL's native equality and order.
 *
 * A value is the exact carrier the Compute evaluators work over (compute/literal.ts CarrierValue): an integer as bigint,
 * numeric as Decimal with its display scale, a float as a double with its sign of zero, money as Money, booleans, text,
 * uuids and enum handles as strings. A value keeps the spelling PostgreSQL would keep, because raw text multisets observe it (1.0 vs 1.00, -0):
 * a value stored in, cast to or read through a column of a numeric(p, s) type is coerced as PostgreSQL's typmod
 * coercion does, so "1" stored in numeric(5,2) is 1.00, and every other value is held as written.
 *
 * Identity is native equality: 1.0 = 1.00, -0 = 0, NaN = NaN. A collapse keeps one of natively equal values, as
 * DISTINCT, UNION and GROUP BY keep whichever they meet first and min and max return one of their arguments. Where they
 * are spelled alike that choice is unobservable, and the oracle generators spell every outputable value of one class
 * one way per case (gen/domain.ts); where natively equal values of other spellings still meet (a numeric cast to
 * numeric(38, 10) beside the plain value, a float's -0 beside 0, or stored values the public generator spells per
 * fact), which spelling survives is PostgreSQL's choice, and the collapsed value is a merged value (Unstated, below),
 * while a value whose class holds one spelling stays fully stated.
 */
export type Value = CarrierValue | Unstated
export type Row = ReadonlyArray<Value>

/**
 * A value read as the carrier its type names. The evaluator holds each value as its type's carrier, so a value of
 * another carrier is a defect of the evaluator, never of the case; an unstated value has no one carrier to read, and a
 * reader that does not read it by the one rule above refuses it.
 */
const wrongCarrier = (v: Value, expected: string): never => {
	if (v instanceof Unstated) {
		throw referenceUnsupported(
			`the value of ${v.known.kind === "declined" ? "a declined term" : "a merged value"}, read as ${expected}`
		)
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
 * What the reference refuses to evaluate. It evaluates only the generator fragment, and anything else is refused with
 * what it lacks; and an expression the definition evaluates may fail with a SQLSTATE, so the case's answer is an
 * execution error, not rows (an admitted typed outcome). Either refusal makes a harness that compares rows only refuse
 * the case; the frontier comparison (frontier.ts) reads a failure's code.
 */
export class ReferenceUnsupported extends Schema.TaggedError<
	ReferenceUnsupported,
	{ readonly brand: unique symbol }
>()("ReferenceUnsupported", {
	refusal: Schema.Union([
		Schema.Struct({ kind: Schema.Literal("unsupported"), what: Schema.String }),
		Schema.Struct({ kind: Schema.Literal("fails"), code: Schema.String })
	])
}) {
	override get message(): string {
		const what =
			this.refusal.kind === "unsupported"
				? this.refusal.what
				: `an expression that fails with ${this.refusal.code}`
		return `the reference evaluator does not evaluate ${what}`
	}
}

/** The refusal of a construct outside the fragment the reference evaluates, naming what it lacks. */
export const referenceUnsupported = (what: string): ReferenceUnsupported =>
	ReferenceUnsupported.make({ refusal: { kind: "unsupported", what } })

/** The refusal of an expression the definition evaluates that fails with SQLSTATE `code`. */
export const referenceFails = (code: string): ReferenceUnsupported =>
	ReferenceUnsupported.make({ refusal: { kind: "fails", code } })

/** Whether `e` is the reference's refusal of an expression that fails with a SQLSTATE. */
export const isExecutionFailure = (e: unknown): boolean =>
	Schema.is(ReferenceUnsupported)(e) && e.refusal.kind === "fails"

/**
 * The value a column of `type` holds for `v`: numeric typmod coercion, which spells every spelling of one value alike,
 * so a merged numeric coerced is stated again; every other carrier holds the value unchanged, and a declined term's
 * value stays itself. A value the type cannot hold is a defect of the generator, which draws only values that fit.
 */
export const coerce = (v: Value, type: ScalarType): Value => {
	const base = baseOf(type)
	const typmod = base.carrier === "numeric" ? base.typmod : undefined
	const values = possibleValues(v)
	if (typmod === undefined || values === undefined) {
		return v
	}
	return mergedOf(
		Arr.map(values, (x) => {
			const normalized = normalizeNumeric(asDecimal(x), typmod)
			if (!normalized.ok) {
				throw referenceUnsupported(`a numeric value outside its typmod`)
			}
			return normalized.value
		}),
		type
	)
}

/** The value of a typed literal of `type`, as a typed SQL literal of that type evaluates. */
export const literalOf = (literal: TypedLiteral, type: ScalarType): Value =>
	coerce(literalValue(literal), type)

/** A declined term's identity; undefined for any other value. */
const identityOf = (v: Value): string | undefined =>
	v instanceof Unstated && v.known.kind === "declined" ? v.known.identity : undefined

/**
 * PostgreSQL's comparison of two values of one type. Every spelling of a merged value compares alike, so its first
 * decides; two declined values compare equal only as one reading over reads spelled alike; any other comparison of a
 * declined value is unknown.
 */
export const compare = (a: Value, b: Value, type: ScalarType): -1 | 0 | 1 => {
	const identity = identityOf(a)
	if (identity !== undefined && identity === identityOf(b)) {
		return 0
	}
	const x = possibleValues(a)
	const y = possibleValues(b)
	if (x === undefined || y === undefined) {
		throw referenceUnsupported("a comparison of a declined term's value")
	}
	const c = compareValues(Arr.headNonEmpty(x), Arr.headNonEmpty(y), type)
	if (c === undefined) {
		throw referenceUnsupported(`comparison of ${baseOf(type).carrier} values`)
	}
	return c
}

export const equal = (a: Value, b: Value, type: ScalarType): boolean => compare(a, b, type) === 0

/**
 * A value's identity under native equality, as text: a merged value's, the value its spellings share; a declined
 * term's, its reading's over its reads.
 */
export const valueKey = (v: Value, type: ScalarType): string => {
	if (v instanceof Unstated) {
		return v.known.kind === "merged"
			? valueKey(Arr.headNonEmpty(v.known.spellings), type)
			: `u${v.known.identity}`
	}
	const base = baseOf(type)
	switch (base.carrier) {
		case "int2":
		case "int4":
		case "int8":
			return asBigint(v).toString()
		case "numeric":
			return `d${asDecimal(v).identityText()}`
		case "float4":
		case "float8":
			return `f${floatIdentityText(asNumber(v))}`
		case "money":
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
 * Otherwise undefined, and only comparison decides: a value of another carrier, whose comparison refuses, an enum
 * handle outside its roster, which compares equal to every other such handle, and a vector, which comparison does not
 * order.
 */
export const indexKey = (v: Value, type: ScalarType): string | undefined => {
	if (v instanceof Unstated) {
		return v.known.kind === "merged"
			? indexKey(Arr.headNonEmpty(v.known.spellings), type)
			: undefined
	}
	const base = baseOf(type)
	switch (base.carrier) {
		case "int2":
		case "int4":
		case "int8":
			return typeof v === "bigint" ? v.toString() : undefined
		case "numeric":
			return v instanceof Decimal ? valueKey(v, type) : undefined
		case "float4":
		case "float8":
			return typeof v === "number" ? valueKey(v, type) : undefined
		case "money":
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
			return undefined
	}
}

/**
 * Identities joined into one, each length-prefixed, so no part's text runs into the next: an unstated value's identity
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
 * A value's spelling: the text PostgreSQL's output function writes, up to what this module keeps of it. Natively
 * equal values differ in spelling only by a numeric display scale (1.0, 1.00) or the sign of a float zero. A merged
 * value's is the spellings it may hold; a declined term's, its identity.
 */
export const spellingKey = (v: Value, type: ScalarType): string => {
	if (v instanceof Unstated) {
		return v.known.kind === "merged"
			? `o${joinedKey(Arr.map(v.known.spellings, (s) => spellingKey(s, type)))}`
			: valueKey(v, type)
	}
	const base = baseOf(type)
	switch (base.carrier) {
		case "numeric":
			return `d${asDecimal(v).toString()}`
		case "float4":
		case "float8":
			return Object.is(v, -0) ? "f-0" : `f${floatIdentityText(asNumber(v))}`
		case "bool":
		case "enum":
		case "int2":
		case "int4":
		case "int8":
		case "money":
		case "range4":
		case "range8":
		case "text":
		case "uuid":
		case "vector":
			return valueKey(v, type)
	}
}

export const rowSpelling = (row: Row, heading: Heading): string =>
	joinedKey(Arr.map(heading, (c, i) => spellingKey(valueAt(row, i), c.type)))

/**
 * Where the reference merges natively equal rows or values into one and keeps a representative: a set boundary
 * (DISTINCT, UNION, a group's bound tuples), a group key, a recursion's new state, an intersection's matched row, a
 * join variable bound by two columns, and a min or max over equal arguments. PostgreSQL keeps whichever spelling its
 * plan meets first, so the generators' perCase rule (gen/domain.ts) promises that the merged items are spelled alike
 * wherever this happens. A test observes the merges of its reference to check that promise (evaluate.ts
 * ReferenceObserver); every other caller ignores them.
 */
export type MergeObserver = (heading: Heading, kept: Row, merged: Row, at: string) => void

/** The merge observer of a caller that observes no merge. */
export const ignoreMerges: MergeObserver = () => {}

/**
 * The identity of each row on `heading`, where the reference decides it: two rows that agree on every column no row of
 * `rows` leaves unstated and differ in a column some row leaves unstated may or may not be one row in PostgreSQL, which
 * the reference refuses to judge (an unstated value from one expression and a stated one, or unstated values from two,
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
 * equality (decidedKeys).
 */
export const distinctRows = (
	rows: ReadonlyArray<Row>,
	heading: Heading,
	at: string,
	onMerge: MergeObserver
): ReadonlyArray<Row> => {
	const keys = decidedKeys(rows, heading, at)
	const seen = new Map<string, number>()
	const out: Array<Row> = []
	for (const [r, row] of rows.entries()) {
		const key = elementOf(keys, r)
		const kept = seen.get(key)
		if (kept !== undefined) {
			const prior = elementOf(out, kept)
			onMerge(heading, prior, row, at)
			out[kept] = mergedRow(heading, prior, row)
			continue
		}
		seen.set(key, out.length)
		out.push(row)
	}
	return out
}

/** Whether a value is a declined term's, whose values the reference does not list. */
export const declined = (v: Value): boolean => identityOf(v) !== undefined

/**
 * What a value may be (the one rule above): a stated value itself, a merged value each of its spellings; undefined
 * for a declined term's, whose values are not listed.
 */
export const possibleValues = (v: Value): Arr.NonEmptyReadonlyArray<CarrierValue> | undefined => {
	if (!(v instanceof Unstated)) {
		return [v]
	}
	return v.known.kind === "merged" ? v.known.spellings : undefined
}

/**
 * Whether natively equal values of `type` can differ in spelling: a numeric by its display scale, a float zero by its
 * sign. Every other carrier spells one value one way.
 */
const spelled = (type: ScalarType): boolean => {
	const carrier = baseOf(type).carrier
	return carrier === "numeric" || carrier === "float4" || carrier === "float8"
}

/**
 * The one value natively equal values of `type` stand for: the value where they are spelled alike, otherwise a merged
 * value of their spellings, each once, in the order of their spelling.
 */
export const mergedOf = (
	values: Arr.NonEmptyReadonlyArray<CarrierValue>,
	type: ScalarType
): Value => {
	const spellings = Arr.dedupeWith(
		Arr.sortWith(values, (v) => spellingKey(v, type), Order.String),
		(a, b) => spellingKey(a, type) === spellingKey(b, type)
	)
	return spellings.length === 1
		? Arr.headNonEmpty(spellings)
		: new Unstated({ kind: "merged", spellings })
}

/**
 * One possibility's outcome of a reading: its value, the SQLSTATE it fails with, or none the host states (a term the
 * oracle declines, or a declined term's value read).
 */
export type Possible =
	| { readonly kind: "value"; readonly value: CarrierValue }
	| { readonly kind: "failure"; readonly code: string }
	| { readonly kind: "declined" }

/**
 * How a reading reads a value: a stated value is itself, a merged value one of its spellings, and a declined term's
 * none. `at` names where the value is read (a column), so a run reads one place alike however often it reads it.
 */
export type CarrierRead = (at: string, v: Value) => CarrierValue | undefined

/** A choice a run made where it first read a merged value: which of its spellings, of how many. */
interface Choice {
	readonly spelling: number
	readonly of: number
}

/**
 * The outcomes of a reading, by the one rule above, over every combination of what the unstated values it reads may
 * be, as it reads them: a value a run never reads (a CASE branch it does not take) adds no combination. Each run reads
 * through `read`, which gives every merged value it meets the spelling its combination chooses; one that reads a
 * declined term's value is declined, whatever it gives. The combinations are walked depth first, the last choice a run
 * made advancing first. A term the Compute evaluator does not evaluate is refused.
 */
export const possibleOutcomes = (
	run: (read: CarrierRead) => CatalogResult,
	onReading: ReadingObserver
): Arr.NonEmptyReadonlyArray<Possible> => {
	/**
	 * One run choosing `prefix` at its first merged reads and each first spelling after, and the choices that follow.
	 */
	const once = (
		prefix: ReadonlyArray<Choice>
	): { readonly outcome: Possible; readonly next: ReadonlyArray<Choice> | undefined } => {
		const chosen = new Map<string, CarrierValue>()
		const made: Array<Choice> = []
		/** The positions at which the run read a declined term's value. */
		const declined = new Set<string>()
		const result = run((at, v) => {
			if (!(v instanceof Unstated)) {
				return v
			}
			if (v.known.kind === "declined") {
				declined.add(at)
				return undefined
			}
			const known = chosen.get(at)
			if (known !== undefined) {
				return known
			}
			const choice = { spelling: prefix[made.length]?.spelling ?? 0, of: v.known.spellings.length }
			made.push(choice)
			const spelling = elementOf(v.known.spellings, choice.spelling)
			chosen.set(at, spelling)
			return spelling
		})
		const outcome = declined.size > 0 ? { kind: "declined" as const } : possibleOutcome(result)
		const next = Option.flatMap(
			Arr.findLastIndex(made, (c) => c.spelling + 1 < c.of),
			(last) =>
				Option.map(Arr.get(made, last), (advanced) => [
					...made.slice(0, last),
					{ spelling: advanced.spelling + 1, of: advanced.of }
				])
		)
		return { outcome, next: Option.getOrUndefined(next) }
	}
	const first = once([])
	const rest: Array<Possible> = []
	for (let next = first.next; next !== undefined;) {
		const r = once(next)
		rest.push(r.outcome)
		next = r.next
	}
	if (rest.length > 0) {
		onReading()
	}
	return [first.outcome, ...rest]
}

/**
 * Where the reference reads a merged value by the one rule: a reading walked over more than one combination. A test
 * observes the readings of its reference to note that a case reached it (evaluate.ts ReferenceObserver); every other
 * caller ignores them.
 */
export type ReadingObserver = () => void

/** The reading observer of a caller that observes no reading. */
export const ignoreReadings: ReadingObserver = () => {}

/** One possibility's outcome from the Compute evaluator's result; a term it does not evaluate is refused. */
const possibleOutcome = (result: CatalogResult): Possible => {
	if (Result.isSuccess(result)) {
		return { kind: "value", value: result.success }
	}
	const stop = result.failure
	switch (stop.kind) {
		case "failure":
			return { kind: "failure", code: stop.code }
		case "declined":
			return { kind: "declined" }
		case "unsupported":
			throw referenceUnsupported(stop.what)
	}
}

/**
 * The outcome of a reading by the one rule above, from every possibility's: a value they all give, spelled alike or
 * natively equal values of other spellings (a merged value); a failure they all meet, with each code one meets; or
 * `open`, PostgreSQL's
 * alone.
 */
export type Agreed =
	| { readonly kind: "value"; readonly value: Value }
	| { readonly kind: "failure"; readonly codes: Arr.NonEmptyReadonlyArray<string> }
	| { readonly kind: "open" }

export const agreedOutcome = (
	outcomes: Arr.NonEmptyReadonlyArray<Possible>,
	type: ScalarType
): Agreed => {
	const [head, ...tail] = outcomes
	switch (head.kind) {
		case "declined":
			return { kind: "open" }
		case "failure": {
			const codes = Arr.flatMap(tail, (o) => (o.kind === "failure" ? [o.code] : []))
			const all: Arr.NonEmptyReadonlyArray<string> = [head.code, ...codes]
			return codes.length === tail.length
				? { kind: "failure", codes: Arr.dedupe(all) }
				: { kind: "open" }
		}
		case "value": {
			const first = head.value
			const others = Arr.flatMap(tail, (o) => (o.kind === "value" ? [o.value] : []))
			if (others.length !== tail.length) {
				return { kind: "open" }
			}
			if (Arr.every(others, (v) => spellingKey(v, type) === spellingKey(first, type))) {
				return { kind: "value", value: first }
			}
			if (!spelled(type) || !Arr.every(others, (v) => compare(v, first, type) === 0)) {
				return { kind: "open" }
			}
			return { kind: "value", value: mergedOf(Arr.prepend(others, first), type) }
		}
	}
}

/**
 * The representative of two natively equal values a collapse merges, `kept` the one the reference keeps: values of
 * other spellings are a merged value of every spelling either may hold, since which one survives is PostgreSQL's
 * choice; any other value, and a declined term's, stays as kept.
 */
export const mergedValue = (kept: Value, merged: Value, type: ScalarType): Value => {
	if (!spelled(type)) {
		return kept
	}
	const a = possibleValues(kept)
	const b = possibleValues(merged)
	if (a === undefined || b === undefined) {
		return kept
	}
	return mergedOf(Arr.appendAll(a, b), type)
}

/** The representative of two natively equal rows, cell by cell (mergedValue). */
export const mergedRow = (heading: Heading, kept: Row, merged: Row): Row =>
	Arr.map(heading, (c, i) => mergedValue(valueAt(kept, i), valueAt(merged, i), c.type))

/** The typed IR literal of a value of `type`, for rendering through PostgreSQL's output functions. */
export const literalOfValue = (v: Value, type: ScalarType): TypedLiteral => {
	const base = baseOf(type)
	switch (base.carrier) {
		case "int2":
		case "int4":
		case "int8":
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
			return { kind: "float", value: x }
		}
		case "money":
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
