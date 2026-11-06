import { type CompileError, resourceBound, unsupported } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { int8Digits, int8ExactDigits } from "#compiler/ir/carriers.ts"
import { type CatalogOpId, OpId as opId } from "#compiler/ir/expr.ts"
import type { AggregateCallOver, AggregateFn } from "#compiler/ir/rel.ts"
import {
	baseOf,
	type Carrier,
	type NumericBound,
	numericMaxDisplayScale,
	numericMaxIntegerDigits,
	type ScalarType,
	typeLabel
} from "#compiler/ir/scalar.ts"
import {
	exactNumericBound,
	exactType,
	familyDigits,
	plainType,
	valueType
} from "#compiler/scalar/compute/types.ts"
import { numericValue } from "#compiler/scalar/registry.ts"

export type AggregateName = "count" | "sum" | "mean" | "min" | "max"

/**
 * Whether an aggregate of one argument returns one of its values unchanged, so its result is of the type its argument's
 * term has, contract included: min and max do, over boolean as bool_and and bool_or; sum and mean compute a value.
 */
export const returnsInput: { readonly [N in Exclude<AggregateName, "count">]: boolean } = {
	sum: false,
	mean: false,
	min: true,
	max: true
}

/** An aggregate as a rule applies it: count to no argument, every other aggregate to one argument of the given type. */
export type AggregateCall =
	| { readonly name: "count" }
	| { readonly name: Exclude<AggregateName, "count">; readonly arg: ScalarType }

/** The IR's aggregates of one argument (ir/rel.ts): every aggregate a rule applies but count. */
type UnaryAggregateFn = Exclude<AggregateFn, "count">

/** The carriers whose values the lowering writes exactly as numeric: through their bits, or money::numeric. */
export type ExactCarrier = "float4" | "float8" | "money"

/**
 * How an aggregate overload is lowered so that its result is a function of its contributions, one per keyed row, in
 * any order. Every overload
 * states one, so a new aggregate cannot be added without deciding; every emitter (grouped and windowed) dispatches on
 * it exhaustively (lower/conservative/group aggregateExpr):
 *
 * - native: the native call over the arguments as they are, whose accumulator is exact or returns an input: count,
 *   min, max, bool_and, bool_or, and sum over the integers and numeric;
 * - scaleFree: the native call over each argument through trim_scale: avg over numeric, whose quotient reads the sum's
 *   display scale (I2);
 * - exactSum: sum over the exact numeric value of each argument, rounded once to real or double precision as IEEE 754
 *   rounds, or kept as exact money;
 * - exactMean: that exact sum over count(*), rounded once to double precision: avg over real and double precision.
 */
export type AggregateLowering =
	| { readonly kind: "native" }
	| { readonly kind: "scaleFree" }
	| { readonly kind: "exactSum"; readonly exact: ExactCarrier }
	| { readonly kind: "exactMean"; readonly exact: ExactCarrier }

const native: AggregateLowering = Object.freeze({ kind: "native" })
const scaleFree: AggregateLowering = Object.freeze({ kind: "scaleFree" })
const exactSum = (exact: ExactCarrier): AggregateLowering =>
	Object.freeze({ kind: "exactSum", exact })
const exactMean = (exact: ExactCarrier): AggregateLowering =>
	Object.freeze({ kind: "exactMean", exact })

/** The overload of count, or of an aggregate of one argument; fn says which, as the IR's call does (ir/rel.ts). */
export type AggregateOverload = CountOverload | UnaryOverload

interface CountOverload extends OverloadCommon {
	readonly fn: "count"
}

interface UnaryOverload extends OverloadCommon {
	/** The IR's aggregate (ir/rel.ts): mean is avg, and min and max over boolean are bool_and and bool_or. */
	readonly fn: UnaryAggregateFn
}

interface OverloadCommon {
	/**
	 * The native overload, pg_aggregate.aggfnoid as a regprocedure signature: "count()", "sum(bigint)", "min(anyenum)".
	 */
	readonly op: CatalogOpId
	/** The SQL function name. */
	readonly sql: "count" | "sum" | "avg" | "min" | "max" | "bool_and" | "bool_or"
	readonly result: ScalarType
	/** How the overload is lowered so that its result is a function of its contributions in any order. */
	readonly lowering: AggregateLowering
}

/**
 * An overload's result over its argument: a type of the argument's, or a computed numeric whose bound is a function
 * of the argument's once converted into numeric exactly (types.ts exactNumericBound).
 */
type Entry =
	| {
			readonly kind: "typed"
			readonly result: (arg: ScalarType) => ScalarType
			readonly lowering: AggregateLowering
	  }
	| {
			readonly kind: "numeric"
			readonly bound: (arg: NumericBound) => NumericBound
			readonly lowering: AggregateLowering
	  }

/**
 * The integer digits a sum adds to its arguments' at most: it sums fewer rows than a bigint counts, so |sum| <
 * 10^rowDigits · 10^digits.
 */
const rowDigits = int8Digits

/** An exact sum's result over `arg`: an exact integer or exact money, its bound its argument's widened by the rows. */
const exactSumOf =
	(carrier: "exactInteger" | "exactMoney") =>
	(arg: ScalarType): ScalarType =>
		exactType(carrier, (familyDigits(valueType(arg)) ?? 0) + rowDigits.value)

const plainResult = (carrier: "int8" | "float4" | "float8") => (): ScalarType => plainType(carrier)

const typed = (result: (arg: ScalarType) => ScalarType, lowering: AggregateLowering): Entry => ({
	kind: "typed",
	result,
	lowering
})

/** A numeric sum's bound: its argument's integer digits widened by the rows, its fraction digits its argument's. */
const sumBound = (b: NumericBound): NumericBound => ({
	digits: b.digits + rowDigits.value,
	scale: b.scale
})

const numericSum: Entry = { kind: "numeric", bound: sumBound, lowering: native }

/**
 * A numeric mean: within its argument's integer digits, a mean lying between the values it averages and rounding onto
 * a scale they lie on; its scale PostgreSQL's division's, at most numericMaxDisplayScale (numeric_avg is numeric_div).
 * An argument of more fraction digits than that scale may round up past every value it averages, by one unit at that
 * scale: one integer digit more than the larger of its own and the unit's.
 */
const numericMean = (lowering: AggregateLowering): Entry => ({
	kind: "numeric",
	bound: (b) => ({
		digits:
			b.scale <= numericMaxDisplayScale.value
				? b.digits
				: Math.max(b.digits, -numericMaxDisplayScale.value) + 1,
		scale: numericMaxDisplayScale.value
	}),
	lowering
})

/** The result of `entry` over `arg`, or ResourceBound where a computed numeric's bound passes numeric's own. */
const resultOf = (
	entry: Entry,
	arg: ScalarType,
	loc: SourceLoc
): Result.Result<ScalarType, CompileError> => {
	if (entry.kind === "typed") {
		const result = entry.result(arg)
		return result.carrier === "exactInteger" || result.carrier === "exactMoney"
			? withinNumeric(result, result.digits, loc)
			: Result.ok(result)
	}
	const b = exactNumericBound(arg)
	if (b === undefined) {
		return Result.err(unsupported(loc, `a numeric aggregate over ${typeLabel(arg)}`))
	}
	const bound = entry.bound(b)
	return withinNumeric(numericValue(bound), bound.digits, loc)
}

/** `result`, of `digits` integer digits, where numeric holds them: past numericMaxIntegerDigits, ResourceBound. */
const withinNumeric = (
	result: ScalarType,
	digits: number,
	loc: SourceLoc
): Result.Result<ScalarType, CompileError> =>
	digits > numericMaxIntegerDigits.value
		? Result.err(
				resourceBound(loc, {
					kind: "numericDigits",
					limit: numericMaxIntegerDigits.value,
					needed: digits
				})
			)
		: Result.ok(result)

/** The catalog's argument type name of a type (pg_aggregate over pg_proc): an exact value's its SQL type's. */
const catalogName = (t: ScalarType): string => {
	const b = baseOf(t)
	switch (b.carrier) {
		case "int2":
			return "smallint"
		case "int4":
			return "integer"
		case "int8":
			return "bigint"
		case "numeric":
		case "exactMoney":
			return "numeric"
		case "exactInteger":
			return b.digits <= int8ExactDigits.value ? "bigint" : "numeric"
		case "float4":
			return "real"
		case "float8":
			return "double precision"
		case "money":
			return "money"
		case "bool":
			return "boolean"
		case "uuid":
			return "uuid"
		case "date":
			return "date"
		case "text":
			return "text"
		case "code":
			return "smallint"
		case "bits":
			return "bit"
		case "range4":
		case "range8":
			return "anyrange"
		case "vector":
			return "vector"
	}
}

const sumOverloads: Readonly<Partial<Record<Carrier, Entry>>> = {
	int2: typed(plainResult("int8"), native),
	int4: typed(plainResult("int8"), native),
	int8: numericSum,
	numeric: numericSum,
	float4: typed(plainResult("float4"), exactSum("float4")),
	float8: typed(plainResult("float8"), exactSum("float8")),
	money: typed(exactSumOf("exactMoney"), exactSum("money")),
	exactInteger: typed(exactSumOf("exactInteger"), native),
	exactMoney: typed(exactSumOf("exactMoney"), native)
}

const avgOverloads: Readonly<Partial<Record<Carrier, Entry>>> = {
	int2: numericMean(native),
	int4: numericMean(native),
	int8: numericMean(native),
	numeric: numericMean(scaleFree),
	float4: typed(plainResult("float8"), exactMean("float4")),
	float8: typed(plainResult("float8"), exactMean("float8")),
	exactInteger: numericMean(native)
}

/**
 * sum(bigint)'s result, a computed numeric of a bigint's digits widened by the rows: what a window total of grouped
 * counts is (lower/shapes/catalog/share.ts).
 */
export const bigintSumType: ScalarType = numericValue(
	sumBound({ digits: int8Digits.value, scale: 0 })
)

/**
 * The carriers with min and max: those with the minMax capability. A closed id's is min(smallint) over its code, which
 * is its roster's order.
 */
const minMaxCarriers: ReadonlyArray<Carrier> = [
	"int2",
	"int4",
	"int8",
	"numeric",
	"float4",
	"float8",
	"money",
	"text",
	"code",
	"exactInteger",
	"exactMoney"
]

const refusedAggregate = (loc: SourceLoc, capability: string): Result.Result<never, CompileError> =>
	Result.err(unsupported(loc, capability))

/**
 * Native aggregate result typing and conditional aggregates.
 *
 * The aggregate vocabulary is r.count, r.sum, r.mean, r.min and r.max and nothing else. Each applies to
 * the rule's distinct full-binding set and takes PostgreSQL's own overload and result type:
 *
 * | Input            | r.sum            | r.mean / AVG     |
 * | smallint         | bigint           | numeric          |
 * | integer          | bigint           | numeric          |
 * | bigint           | numeric          | numeric          |
 * | numeric          | numeric          | numeric          |
 * | real             | real             | double precision |
 * | double precision | double precision | double precision |
 * | money            | exact money      | refused          |
 * | exact integer    | exact integer    | numeric          |
 * | exact money      | exact money      | refused          |
 *
 * r.count is bigint. A contract input contributes its base to r.sum and r.mean, whose result is no contract until an
 * explicit cast; r.min and r.max return an input unchanged and keep its type, contract included. Numeric sums and
 * means carry no typmod: each is a computed numeric whose bound its argument's gives, a sum's integer digits widened by
 * the rows' (rowDigits) and a mean's scale PostgreSQL's division's (numericMaxDisplayScale), refused as ResourceBound
 * where it passes numeric's integer digits; an exact sum is refused there too. Over boolean, r.min is bool_and and r.max is bool_or, matching false < true.
 * PostgreSQL defines no AVG(money), no sum or mean over any other type, and no min or max over uuid, ranges or vectors,
 * so those are UnsupportedOperation with the capability named.
 *
 * Every aggregate is a function of its contributions, one per keyed row, in any order: no plan, scan order, join order,
 * hash or sort grouping,
 * parallel worker, window frame or co-located aggregate can change it. count, min, max, bool_and, bool_or and the sums
 * over the integers and numeric already accumulate exactly or return an input, and are native. The others are lowered
 * to an exact accumulator (AggregateLowering):
 *
 * - r.sum over real or double precision is the double (for real, the real) nearest the exact sum of its arguments'
 *   values, ties to even, ±Infinity past the largest finite value: a correctly rounded sum, as IEEE 754 rounds. Each
 *   argument enters the sum as the exact numeric value of its bits (sql/build.ts exactNumericOfDouble), the numeric sum
 *   is exact, and the total is rounded once (lower/conservative/expr/total.ts roundToFloat).
 * - r.mean over real or double precision is the double nearest PostgreSQL's numeric quotient of that exact sum, its
 *   display scale trimmed, by the count.
 * - r.sum over money is the exact total in cents, exact money, sum(x::numeric), which no total overflows; r.sum over
 *   the exact carriers is exact too, bounded by its rows. A derived relation holds no exact field
 *   (analysis/derived/fields.ts), so a stored money total sums the amounts cast to numeric.
 * - r.mean over numeric is avg over each argument through trim_scale, so the quotient's scale is read from the values
 *   alone (I2).
 *
 * Each is the identity on one value, equals IEEE `+` on two values, and never raises.
 *
 * Conditional aggregates: `sum(cond(p, 1, 0))` is a conditional count, lowered to `count(*) FILTER (WHERE p)` and
 * cast to the composition's sum type when that is not bigint; `sum(cond(p, x, 0))` is a conditional sum, lowered to
 * `sum(CASE WHEN p THEN x ELSE 0 END)` with the zero of x's type, never `sum(x) FILTER (WHERE p)`, which is NULL when
 * no binding satisfies p. The shapes package recognizes both in the lowered aggregate and lowers them.
 *
 * The native overload and result type of an aggregate as applied.
 */
export const aggregateOverload = (
	call: AggregateCall,
	loc: SourceLoc
): Result.Result<AggregateOverload, CompileError> =>
	call.name === "count" ? Result.ok(countOverload()) : unaryOverload(call.name, call.arg, loc)

/** count(*): bigint over no argument. */
export const countOverload = (): CountOverload => ({
	fn: "count",
	op: opId("count()"),
	sql: "count",
	result: plainType("int8"),
	lowering: native
})

/** The overload of an aggregate of one argument of type `arg`, refused where PostgreSQL defines none. */
export const unaryOverload = (
	name: Exclude<AggregateName, "count">,
	arg: ScalarType,
	loc: SourceLoc
): Result.Result<UnaryOverload, CompileError> => {
	const value = valueType(arg)
	const c = value.carrier
	if (name === "sum" || name === "mean") {
		const table = name === "sum" ? sumOverloads : avgOverloads
		const entry = table[c]
		if (entry === undefined && name === "mean" && c === "money") {
			return refusedAggregate(
				loc,
				"avg: PostgreSQL does not define AVG(money); an explicit cast to numeric expresses a numeric mean"
			)
		}
		if (entry === undefined) {
			return refusedAggregate(
				loc,
				`${name === "sum" ? "sum" : "avg"}: ${typeLabel(arg)} has no native ${name === "sum" ? "SUM" : "AVG"}`
			)
		}
		const sql = name === "sum" ? "sum" : "avg"
		return Result.map(resultOf(entry, value, loc), (result) => ({
			fn: sql,
			op: opId(`${sql}(${catalogName(value)})`),
			sql,
			result,
			lowering: entry.lowering
		}))
	}
	/** min and max keep the input's type, contract included. */
	const kept = arg
	if (c === "bool") {
		const sql = name === "min" ? "bool_and" : "bool_or"
		return Result.ok({
			fn: name === "min" ? "boolAnd" : "boolOr",
			op: opId(`${sql}(boolean)`),
			sql,
			result: kept,
			lowering: native
		})
	}
	if (!minMaxCarriers.includes(c) || !baseOf(arg).caps.includes("minMax")) {
		return refusedAggregate(loc, `minMax: PostgreSQL has no ${name} over ${typeLabel(arg)}`)
	}
	return Result.ok({
		fn: name,
		op: opId(`${name}(${catalogName(value)})`),
		sql: name,
		result: kept,
		lowering: native
	})
}

/**
 * The overload of an IR aggregate (ir/rel.ts AggregateCallOver) over its arguments' types: count's, or its one
 * argument's, mean as avg, and bool_and and bool_or as min and max over boolean.
 */
export const callOverload = (
	agg: AggregateCallOver<{ readonly type: ScalarType }>,
	loc: SourceLoc
): Result.Result<AggregateOverload, CompileError> => {
	switch (agg.fn) {
		case "count":
			return Result.ok(countOverload())
		case "sum":
			return unaryOverload("sum", agg.args[0].type, loc)
		case "avg":
			return unaryOverload("mean", agg.args[0].type, loc)
		case "min":
		case "boolAnd":
			return unaryOverload("min", agg.args[0].type, loc)
		case "max":
		case "boolOr":
			return unaryOverload("max", agg.args[0].type, loc)
	}
}
