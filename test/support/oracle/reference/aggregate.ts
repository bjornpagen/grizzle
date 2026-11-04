import { Array as Arr } from "effect"
import type * as Engine from "#compiler/core/result.ts"
import type { AggregateFn } from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import * as N from "#compiler/scalar/compute/numeric.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { canonicalZero, decimalToBinary32 } from "#compiler/scalar/values/float.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { elementAt } from "#test/support/oracle/pick.ts"
import {
	asBigint,
	asDecimal,
	asMoney,
	asNumber,
	compare,
	referenceUnsupported,
	type Value
} from "#test/support/oracle/reference/values.ts"

const numeric = (r: N.NumericResult): Decimal => {
	if (!r.ok) {
		throw referenceUnsupported(`a numeric aggregate that fails with ${r.error}`)
	}
	return r.value
}

/** A Decimal of parts the reference holds, each within numeric's format: a double's exact value, a count. */
const made = <E>(r: Engine.Result<Decimal, E>): Decimal => {
	if (!r.ok) {
		throw new Error(`the reference made no Decimal: ${String(r.error)}`)
	}
	return r.value
}

/** The exact sum of Decimals, in any order: numeric addition is exact, so the order is unobservable. */
const exactSum = (values: Arr.NonEmptyReadonlyArray<Decimal>): Decimal =>
	Arr.reduce(Arr.tailNonEmpty(values), Arr.headNonEmpty(values), (total, x) =>
		numeric(N.add(total, x))
	)

/**
 * The exact value of a double, independently of the SQL that computes it (sql/build.ts exactNumericOfDouble): its IEEE
 * 754 bits read through a DataView, a sign, an exponent e and a significand M with the implicit bit when e > 0, and the
 * value M · 2^P, P = max(e, 1) - 1075, as a Decimal in its one form. NaN and the infinities are numeric's own.
 */
export const exactDouble = (x: number): Decimal => {
	if (Number.isNaN(x)) {
		return Decimal.nan
	}
	if (x === Number.POSITIVE_INFINITY) {
		return Decimal.infinity
	}
	if (x === Number.NEGATIVE_INFINITY) {
		return Decimal.negativeInfinity
	}
	const view = new DataView(new ArrayBuffer(8))
	view.setFloat64(0, x)
	const bits = view.getBigUint64(0)
	const negative = bits >> 63n === 1n
	const e = Number((bits >> 52n) & 0x7ffn)
	const fraction = bits & ((1n << 52n) - 1n)
	const m = e === 0 ? fraction : fraction | (1n << 52n)
	const p = Math.max(e, 1) - 1075
	return made(
		p >= 0
			? Decimal.fromParts(negative, m << BigInt(p), 0)
			: Decimal.fromParts(negative, m * 5n ** BigInt(-p), -p)
	)
}

/**
 * The IEEE 754 rounding of an exact total into a double: the double nearest it, ties to even, as Number reads a
 * decimal text, and an infinity where it lies past the double range. NaN and the infinities are their own.
 */
const roundedDouble = (total: Decimal): number => canonicalZero(Number(total.text))

/**
 * The IEEE 754 rounding of an exact total into a real: the real nearest it, ties to even (values/float.ts
 * decimalToBinary32), and an infinity where it lies past the real range.
 */
const roundedReal = (total: Decimal): number => {
	const p = total.parts
	switch (p.kind) {
		case "nan":
			return Number.NaN
		case "infinity":
			return Number.POSITIVE_INFINITY
		case "-infinity":
			return Number.NEGATIVE_INFINITY
		case "finite": {
			const magnitude = decimalToBinary32(p.coefficient, -p.minScale)
			return canonicalZero(p.negative ? -magnitude : magnitude)
		}
	}
}

/** The arguments of a float aggregate, each its exact value. */
const exactDoubles = (
	values: Arr.NonEmptyReadonlyArray<Value>
): Arr.NonEmptyReadonlyArray<Decimal> => Arr.map(values, (v) => exactDouble(asNumber(v)))

/** The arguments of an exact aggregate as Decimals: a numeric as it is, an integer as its value. */
const decimals = (
	values: Arr.NonEmptyReadonlyArray<Value>,
	carrier: "int8" | "numeric" | "int2" | "int4" | "exactInteger"
): Arr.NonEmptyReadonlyArray<Decimal> =>
	Arr.map(values, (v) =>
		carrier === "numeric" ? asDecimal(v) : made(Decimal.fromBigInt(asBigint(v)))
	)

/**
 * The weight (in NBASE digits) and leading NBASE digit of a finite value, |v| = first * 10000^weight + rest; zero's
 * are 0 and 0, as select_div_scale reads a value of no digits.
 */
const weightAndFirst = (d: Decimal): { readonly weight: number; readonly first: bigint } => {
	const p = d.parts
	if (p.kind !== "finite" || p.coefficient === 0n) {
		return { weight: 0, first: 0n }
	}
	const exponent = p.coefficient.toString().length - 1 - p.minScale
	const weight = Math.floor(exponent / 4)
	const shift = weight * 4 + p.minScale
	const first =
		shift >= 0 ? p.coefficient / 10n ** BigInt(shift) : p.coefficient * 10n ** BigInt(-shift)
	return { weight, first }
}

/**
 * numeric_avg of arguments each through trim_scale (scalar/aggregate.ts "scaleFree"): the exact sum over the count by
 * numeric_div at select_div_scale, the sum's display scale being the largest argument's least scale (accum_sum_add
 * keeps the largest dscale), rounded half away from zero. Written here from numeric.c, apart from the engine's
 * division, because the dividend's display scale is not its value's.
 */
const numericMean = (args: Arr.NonEmptyReadonlyArray<Decimal>): Decimal => {
	const total = exactSum(args)
	const count = BigInt(args.length)
	const p = total.parts
	if (p.kind !== "finite") {
		return total
	}
	const scale = Arr.reduce(args, 0, (s, d) => (d.isFinite() ? Math.max(s, d.parts.minScale) : s))
	const x = weightAndFirst(total)
	const y = weightAndFirst(made(Decimal.fromBigInt(count)))
	const qweight = x.weight - y.weight - (x.first <= y.first ? 1 : 0)
	const rscale = Math.min(Math.max(16 - qweight * 4, scale, 0), 1000)
	const num = p.coefficient * 10n ** BigInt(rscale)
	const den = count * 10n ** BigInt(p.minScale)
	const q = num / den + ((num % den) * 2n >= den ? 1n : 0n)
	return numeric(N.fromUnits(p.negative ? -q : q, rscale))
}

const sum = (values: Arr.NonEmptyReadonlyArray<Value>, type: ScalarType): Value => {
	const carrier = baseOf(type).carrier
	switch (carrier) {
		case "int2":
		case "int4":
		case "exactInteger":
			return Arr.reduce<Value, bigint>(values, 0n, (acc, v) => acc + asBigint(v))
		case "int8":
		case "numeric":
			return exactSum(decimals(values, carrier))
		case "float4":
			return roundedReal(exactSum(exactDoubles(values)))
		case "float8":
			return roundedDouble(exactSum(exactDoubles(values)))
		case "money":
		case "exactMoney":
			return Money.exact(
				Arr.reduce<Value, bigint>(values, 0n, (acc, v) => acc + asMoney(v).minorUnits)
			)
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

const avg = (values: Arr.NonEmptyReadonlyArray<Value>, type: ScalarType): Value => {
	const carrier = baseOf(type).carrier
	switch (carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "exactInteger":
			return numericMean(decimals(values, carrier))
		case "float4":
		case "float8": {
			const total = exactSum(exactDoubles(values))
			return roundedDouble(numeric(N.div(total, made(Decimal.fromBigInt(BigInt(values.length))))))
		}
		case "bool":
		case "enum":
		case "money":
		case "exactMoney":
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
 * order decides which; natively equal arguments are identical in their one form, so which one is unobservable.
 */
const extreme = (
	values: Arr.NonEmptyReadonlyArray<Value>,
	type: ScalarType,
	fn: "min" | "max"
): Value => {
	const sign = fn === "min" ? -1 : 1
	const argument = (i: number): Value => elementAt(values, i, "the aggregate's arguments")
	const at = Arr.reduce<Value, number>(values, 0, (best, v, i) =>
		compare(argument(best), v, type) === sign ? best : i
	)
	return argument(at)
}

/**
 * Aggregates of the reference evaluator: each a function of its arguments' multiset, as grizzle defines and lowers it
 * (scalar/aggregate.ts), over one group's distinct bound tuples.
 *
 * - count(*) is bigint;
 * - sum over smallint and integer is bigint; over bigint and numeric it is numeric, exact; over real and double
 *   precision it is the real or double nearest the exact sum of the arguments' values (exactDouble), ties to even,
 *   an infinity where that total lies past the range; over money it is the exact total, exact money;
 * - avg over the exact types is numeric_div of the exact sum by the count at select_div_scale (numericMean); over the
 *   floats it is the double nearest numeric_div of the exact sum, trimmed, by the count;
 * - min and max keep the argument's type under its total order (NaN greatest, enums in roster order, text in code
 *   point order); over boolean they are bool_and and bool_or, as are the boolean folds themselves.
 *
 * Every one is stated for a group of any size, never declined: no sum's value depends on an order. The input is the
 * group's set of distinct complete bound tuples, never its rows: the caller passes one argument value per distinct
 * tuple, so equal values of different tuples each contribute. A group is never empty: an empty input creates no group.
 *
 * One aggregate over the argument values of a group's distinct bound tuples; `argType` is the argument's type, and
 * count(*) takes no argument and receives one value per tuple.
 */
export const aggregate = (
	fn: AggregateFn,
	values: ReadonlyArray<Value>,
	argType: ScalarType | undefined
): Value => {
	if (!Arr.isReadonlyArrayNonEmpty(values)) {
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
			return sum(values, argType)
		case "avg":
			return avg(values, argType)
		case "min":
		case "max":
			return isBool
				? fn === "min"
					? Arr.every(values, (v) => v === true)
					: Arr.some(values, (v) => v === true)
				: extreme(values, argType, fn)
		case "boolAnd":
			return Arr.every(values, (v) => v === true)
		case "boolOr":
			return Arr.some(values, (v) => v === true)
	}
}
