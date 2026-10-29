import { Array as Arr, type Order } from "effect"
import type { NodeId } from "#compiler/core/ids.ts"
import type { AggregateFn } from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import * as N from "#compiler/scalar/compute/numeric.ts"
import { plainType } from "#compiler/scalar/compute/types.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { elementAt, indices } from "#test/support/oracle/pick.ts"
import {
	agreedOutcome,
	asBigint,
	asDecimal,
	asMoney,
	asNumber,
	compare,
	equal,
	joinedKey,
	mergedOf,
	type MergeObserver,
	mergedValue,
	possibleValues,
	referenceFails,
	referenceUnsupported,
	spellingKey,
	Unstated,
	type Value
} from "#test/support/oracle/reference/values.ts"

/**
 * Where an aggregate is computed: its node and its output column. They name a merge of tied extremes (values.ts
 * MergeObserver) and, with its arguments, identify a value the one rule leaves PostgreSQL's alone.
 */
export interface AggregateSite {
	readonly node: NodeId
	readonly column: string
}

const numeric = (r: N.NumericResult): Decimal => {
	if (!r.ok) {
		throw referenceUnsupported(`a numeric aggregate that fails with ${r.error}`)
	}
	return r.value
}

/** The first of a group's values; a group is never empty, which aggregate checks before it folds. */
const firstOf = <A>(values: ReadonlyArray<A>): A => {
	const [first] = values
	if (first === undefined) {
		throw referenceUnsupported("an aggregate over an empty group")
	}
	return first
}

/** The most input orders a float aggregate is evaluated in: every order of a group of up to seven values. */
const orderLimit = 5040

const permutations = <A>(items: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> => {
	if (items.length <= 1) {
		return [items]
	}
	const out: Array<ReadonlyArray<A>> = []
	for (const [i, item] of items.entries()) {
		for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) {
			out.push([item, ...rest])
		}
	}
	return out
}

/**
 * What an argument may be (values.ts possibleValues); a declined term's values are not listed, so an aggregate that
 * reads one is refused.
 */
const possibleArgs = (v: Value): Arr.NonEmptyReadonlyArray<CarrierValue> => {
	const values = possibleValues(v)
	if (values === undefined) {
		throw referenceUnsupported("an aggregate over a declined term's value")
	}
	return values
}

/**
 * A float accumulation in PostgreSQL's input order: its state after its first value and after each further one
 * (undefined where it overflows), its result, and its state's spelling, by which the combinations that reach one state
 * are walked on once.
 */
interface Accumulation<S> {
	readonly begin: (v: number) => S | undefined
	readonly step: (state: S, v: number) => S | undefined
	readonly result: (state: S) => number
	readonly spelling: (state: S) => string
}

/** A float's text, its zero's sign included. */
const floatSpelling = (x: number): string => (Object.is(x, -0) ? "-0" : String(x))

/**
 * The results of a float accumulation PostgreSQL computes in its input order, which no reference knows: evaluated in
 * every order of a group of up to seven values, and beyond that in the orders that most often disagree (as given,
 * reversed, ascending, descending, and by magnitude both ways), each over every combination of what its arguments may
 * be (a merged zero either sign). It fails when every one overflows; otherwise its results are those that do not (one
 * that overflows where another does not is a failure the frontier allows), which the caller reads by the one rule.
 */
const everyOrder = <S>(
	values: ReadonlyArray<Value>,
	accumulation: Accumulation<S>
): Arr.NonEmptyReadonlyArray<number> => {
	const args = Arr.map(values, (v) => Arr.map(possibleArgs(v), asNumber))
	const argAt = (i: number): Arr.NonEmptyReadonlyArray<number> => {
		const arg = args[i]
		if (arg === undefined) {
			throw new Error(`the reference holds no argument ${i}`)
		}
		return arg
	}
	/** An argument's place in an order: its spellings are natively equal, so its first stands for them. */
	const valueAt = (i: number): number => Arr.headNonEmpty(argAt(i))
	const indexes = Arr.map(indices(args.length), (i) => i)
	/** Ascending by `key`, `<` alone deciding as a subtraction does: a NaN key ties with every other. */
	const ascendingBy =
		(key: (i: number) => number): Order.Order<number> =>
		(x, y) => {
			const a = key(x)
			const b = key(y)
			return a < b ? -1 : a > b ? 1 : 0
		}
	const byMagnitude = Arr.sort(
		indexes,
		ascendingBy((i) => Math.abs(valueAt(i)))
	)
	const ascending = Arr.sort(indexes, ascendingBy(valueAt))
	const orders =
		indexes.length <= 7
			? permutations(indexes).slice(0, orderLimit)
			: [
					indexes,
					Arr.reverse([...indexes]),
					ascending,
					Arr.reverse([...ascending]),
					byMagnitude,
					Arr.reverse([...byMagnitude])
				]
	/** The states one spelling apart walked on once. */
	const distinct = (states: ReadonlyArray<S>): ReadonlyArray<S> =>
		Arr.dedupeWith(states, (a, b) => accumulation.spelling(a) === accumulation.spelling(b))
	const defined = (s: S | undefined): ReadonlyArray<S> => (s === undefined ? [] : [s])
	const results: Array<number> = []
	for (const order of orders) {
		const [head, ...rest] = order
		if (head === undefined) {
			throw referenceUnsupported("an aggregate over an empty group")
		}
		let states = distinct(Arr.flatMap(argAt(head), (v) => defined(accumulation.begin(v))))
		for (const i of rest) {
			states = distinct(
				Arr.flatMap(states, (s) => Arr.flatMap(argAt(i), (v) => defined(accumulation.step(s, v))))
			)
		}
		results.push(...Arr.map(states, accumulation.result))
	}
	if (!Arr.isReadonlyArrayNonEmpty(results)) {
		throw referenceFails("22003")
	}
	return results
}

/** float4pl and float8pl from the first value, raising where finite operands overflow (check_float8_val). */
const floatSum = (width: (x: number) => number): Accumulation<number> => ({
	begin: (v) => v,
	step: (acc, v) => {
		const next = width(acc + v)
		return !Number.isFinite(next) &&
			!Number.isNaN(next) &&
			Number.isFinite(acc) &&
			Number.isFinite(v)
			? undefined
			: next
	},
	result: (acc) => acc,
	spelling: floatSpelling
})

/** float8_accum's running count, sum and sum of squares from 0.0; avg is the sum over the count. */
interface Moments {
	readonly n: number
	readonly sx: number
	readonly sxx: number
}

const accumulate = (m: Moments, v: number): Moments | undefined => {
	const n = m.n + 1
	const sx = m.sx + v
	if (n === 1) {
		return { n, sx, sxx: Number.isFinite(v) ? m.sxx : Number.NaN }
	}
	const tmp = v * n - sx
	const sxx = m.sxx + (tmp * tmp) / (n * (n - 1))
	if (Number.isFinite(sx) && Number.isFinite(sxx)) {
		return { n, sx, sxx }
	}
	if (Number.isFinite(m.sx) && Number.isFinite(v) && !Number.isNaN(sx)) {
		return undefined
	}
	return { n, sx, sxx: Number.NaN }
}

const floatAvg: Accumulation<Moments> = {
	begin: (v) => accumulate({ n: 0, sx: 0, sxx: 0 }, v),
	step: accumulate,
	result: (m) => m.sx / m.n,
	spelling: (m) => `${m.n}:${floatSpelling(m.sx)}:${floatSpelling(m.sxx)}`
}

/**
 * The value of an aggregate over its results under every combination its arguments may give: one result, natively
 * equal results of other spellings as a merged value, or otherwise PostgreSQL's alone, declined, identified by the
 * aggregate's site and its arguments' spellings.
 */
const agreedOf = (
	results: Arr.NonEmptyReadonlyArray<CarrierValue>,
	type: ScalarType,
	values: ReadonlyArray<Value>,
	argType: ScalarType,
	site: AggregateSite
): Value => {
	const agreed = agreedOutcome(
		Arr.map(results, (value) => ({ kind: "value" as const, value })),
		type
	)
	if (agreed.kind === "value") {
		return agreed.value
	}
	return new Unstated({
		kind: "declined",
		identity: joinedKey([
			site.node,
			site.column,
			...Arr.map(values, (v) => spellingKey(v, argType))
		])
	})
}

/** What an exact argument may be, as a Decimal: a merged numeric each of its spellings (values.ts possibleValues). */
const possibleDecimals = (v: Value, carrier: string): Arr.NonEmptyReadonlyArray<Decimal> =>
	carrier === "numeric" ? Arr.map(possibleArgs(v), asDecimal) : [Decimal.of(asBigint(v))]

/**
 * The exact sums of a group's arguments over every combination of what they may be, each spelling once: the sums are
 * natively equal and differ by display scale alone (the largest input's), so the partial sums stay few.
 */
const decimalSums = (
	values: ReadonlyArray<Value>,
	carrier: string
): Arr.NonEmptyReadonlyArray<Decimal> =>
	Arr.reduce(values.slice(1), possibleDecimals(firstOf(values), carrier), (sums, v) =>
		Arr.dedupeWith(
			Arr.flatMap(sums, (sum) =>
				Arr.map(possibleDecimals(v, carrier), (x) => numeric(N.add(sum, x)))
			),
			(a, b) => a.toString() === b.toString()
		)
	)

const sum = (values: ReadonlyArray<Value>, type: ScalarType, site: AggregateSite): Value => {
	const carrier = baseOf(type).carrier
	switch (carrier) {
		case "int2":
		case "int4":
			return Arr.reduce<Value, bigint>(values, 0n, (acc, v) => acc + asBigint(v))
		case "int8":
		case "numeric":
			return mergedOf(decimalSums(values, carrier), plainType("numeric"))
		case "float4":
		case "float8":
			return agreedOf(
				everyOrder(values, floatSum(carrier === "float4" ? Math.fround : (x: number) => x)),
				type,
				values,
				type,
				site
			)
		case "money": {
			/**
			 * cash_pl from the first value, each step checked: the final amount out of range fails in every order;
			 * within range, an order whose partial sum overflows may fail too, which the frontier allows.
			 */
			const total = Arr.reduce<Value, bigint>(values, 0n, (acc, v) => acc + asMoney(v).minorUnits)
			if (total < -(2n ** 63n) || total > 2n ** 63n - 1n) {
				throw referenceFails("22003")
			}
			return Money.of(total)
		}
		case "bool":
		case "enum":
		case "range4":
		case "range8":
		case "text":
		case "uuid":
		case "vector":
			throw referenceUnsupported(`sum over ${carrier}`)
	}
}

/**
 * An exact average's quotient takes its scale from its sum's, so sums of other display scales may give unequal averages.
 */
const avg = (values: ReadonlyArray<Value>, type: ScalarType, site: AggregateSite): Value => {
	const carrier = baseOf(type).carrier
	const count = BigInt(values.length)
	switch (carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
			return agreedOf(
				Arr.map(decimalSums(values, carrier), (total) => numeric(N.div(total, Decimal.of(count)))),
				plainType("numeric"),
				values,
				type,
				site
			)
		case "float4":
		case "float8":
			return agreedOf(everyOrder(values, floatAvg), plainType("float8"), values, type, site)
		case "bool":
		case "enum":
		case "money":
		case "range4":
		case "range8":
		case "text":
		case "uuid":
		case "vector":
			throw referenceUnsupported(`avg over ${carrier}`)
	}
}

/**
 * The least or greatest argument. PostgreSQL's <type>larger and <type>smaller keep one argument of a tie, and its input
 * order decides which, so the arguments equal to the extreme merge into one value (values.ts mergedValue): a merged
 * value where they are spelled otherwise. Each merge is observed at the aggregate's site.
 */
const extreme = (
	values: ReadonlyArray<Value>,
	type: ScalarType,
	fn: "min" | "max",
	site: AggregateSite,
	onMerge: MergeObserver
): Value => {
	const sign = fn === "min" ? -1 : 1
	const argument = (i: number): Value => elementAt(values, i, "the aggregate's arguments")
	/** The extreme's index: on a tie the later argument, as <type>larger and <type>smaller keep their second. */
	const at = Arr.reduce<Value, number>(values, 0, (best, v, i) =>
		compare(argument(best), v, type) === sign ? best : i
	)
	let result = argument(at)
	for (const [i, v] of values.entries()) {
		if (i === at || !equal(v, result, type)) {
			continue
		}
		onMerge([{ name: site.column, type }], [result], [v], `${fn} ${site.node}.${site.column}`)
		result = mergedValue(result, v, type)
	}
	return result
}

/**
 * Aggregates of the reference evaluator: PostgreSQL's native aggregate overloads over one group's distinct bound
 * tuples.
 *
 * Each fold computes what the named PostgreSQL aggregate returns, result type and display scale included, because
 * raw text observes both:
 *
 * - count(*) is bigint;
 * - sum over smallint and integer is bigint (int2_sum, int4_sum); over bigint and numeric it is numeric, exact, at
 *   the largest input display scale (numeric_poly_sum, numeric_sum), NaN when any input is NaN or both infinities
 *   occur; over real, double precision and money it is the input type, added in input order from the first value
 *   (float4pl, float8pl, cash_pl have no initial state, so a lone -0 sums to -0);
 * - avg over the exact types is numeric_div(sum, count) at select_div_scale (int8_avg, numeric_poly_avg, numeric_avg);
 *   over the floats it is the double sum, accumulated from 0.0 (float8_accum's initial state, so a lone -0 averages to
 *   0), divided by the count (float8_avg);
 * - min and max keep the argument's type under its total order (NaN greatest, enums in roster order, text in code
 *   point order); over boolean they are bool_and and bool_or, as are the boolean folds themselves.
 *
 * The input is the group's set of distinct complete bound tuples, never its rows: the caller passes
 * one argument value per distinct tuple, so equal values of different tuples each contribute. A group is never
 * empty: an empty input creates no group.
 *
 * An aggregate reads its arguments by the one rule for unstated values (values.ts): a merged argument contributes each
 * of its spellings, and a sum or an average is stated where every combination, and for a float every input order,
 * gives one outcome, and otherwise is PostgreSQL's alone, a declined value. min and max return one of their arguments,
 * which one among those equal to the extreme PostgreSQL's choice, so those spelled otherwise merge into one value.
 *
 * One aggregate over the argument values of a group's distinct bound tuples, computed at `site`; `argType` is the
 * argument's type, and count(*) takes no argument and receives one value per tuple.
 */
export const aggregate = (
	fn: AggregateFn,
	values: ReadonlyArray<Value>,
	argType: ScalarType | undefined,
	site: AggregateSite,
	onMerge: MergeObserver
): Value => {
	if (values.length === 0) {
		throw referenceUnsupported("an aggregate over an empty group")
	}
	if (fn === "count") {
		return BigInt(values.length)
	}
	if (argType === undefined) {
		throw referenceUnsupported(`${fn} without an argument`)
	}
	const isBool = baseOf(argType).carrier === "bool"
	switch (fn) {
		case "sum":
			return sum(values, argType, site)
		case "avg":
			return avg(values, argType, site)
		case "min":
		case "max":
			return isBool
				? fn === "min"
					? Arr.every(values, (v) => v === true)
					: Arr.some(values, (v) => v === true)
				: extreme(values, argType, fn, site, onMerge)
		case "boolAnd":
			return Arr.every(values, (v) => v === true)
		case "boolOr":
			return Arr.some(values, (v) => v === true)
		case "regrSlope":
		case "regrSxx":
			throw referenceUnsupported(`the ${fn} aggregate`)
	}
}
