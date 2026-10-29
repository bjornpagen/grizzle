import { Array as Arr, Option } from "effect"
import { type CatalogOpId, OpId, type RangeOpCode, rangeOp } from "#compiler/ir/expr.ts"
import type { AggregateFn } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import {
	bool,
	float8,
	type GenCarrier,
	genCarrierOf,
	genCarriers,
	hasCap,
	int8,
	numeric
} from "#test/support/oracle/gen/domain.ts"

export const compareOps = ["eq", "ne", "lt", "le", "gt", "ge"] as const
export type CompareOp = (typeof compareOps)[number]

const compareSymbols: Readonly<Record<CompareOp, string>> = {
	eq: "=",
	ne: "<>",
	lt: "<",
	le: "<=",
	gt: ">",
	ge: ">="
}

/** The oprcode stem of each carrier's comparison functions: int4eq but numeric_eq. */
const comparePrefix: Readonly<
	Record<Exclude<GenCarrier, "range4" | "range8">, { readonly stem: string; readonly sep: string }>
> = {
	int2: { stem: "int2", sep: "" },
	int4: { stem: "int4", sep: "" },
	int8: { stem: "int8", sep: "" },
	numeric: { stem: "numeric", sep: "_" },
	float4: { stem: "float4", sep: "" },
	float8: { stem: "float8", sep: "" },
	money: { stem: "cash", sep: "_" },
	bool: { stem: "bool", sep: "" },
	uuid: { stem: "uuid", sep: "_" },
	text: { stem: "text", sep: "" },
	enum: { stem: "enum", sep: "_" },
	vector: { stem: "vector", sep: "_" }
}

/**
 * A range comparison is one catalog operator for every range type, which the IR identity qualifies by the carrier, so a
 * range4 and a range8 comparison stay distinct nodes.
 */
const rangeCompareCodes: Readonly<Record<CompareOp, RangeOpCode>> = {
	eq: "range_eq",
	ne: "range_ne",
	lt: "range_lt",
	le: "range_le",
	gt: "range_gt",
	ge: "range_ge"
}

/** text's equality and inequality are texteq and textne, its order text_lt, text_le, text_gt and text_ge. */
const textSep = (op: CompareOp): string => (op === "eq" || op === "ne" ? "" : "_")

const compareOpIdOf = (carrier: GenCarrier, op: CompareOp): OpId => {
	if (carrier === "range4" || carrier === "range8") {
		return rangeOp(rangeCompareCodes[op], carrier)
	}
	const { stem, sep } = comparePrefix[carrier]
	return OpId(`${stem}${carrier === "text" ? textSep(op) : sep}${op}`)
}

export const compareOpId = (type: ScalarType, op: CompareOp): OpId =>
	compareOpIdOf(genCarrierOf(type), op)

export const andOp: OpId = OpId("and")
export const orOp: OpId = OpId("or")
export const notOp: OpId = OpId("not")

type OpMeaning =
	| {
			readonly kind: "compare"
			readonly op: CompareOp
			readonly symbol: string
			readonly operand: GenCarrier
	  }
	| { readonly kind: "boolean"; readonly connective: "and" | "or" | "not" }
	| {
			readonly kind: "aggregate"
			readonly fn: AggregateFn
			/** The native aggregate's SQL name: count, sum, avg, min, max, bool_and, bool_or. */
			readonly sql: string
	  }

const aggregateSql: Readonly<Record<AggregateFn, string>> = {
	count: "count",
	sum: "sum",
	avg: "avg",
	min: "min",
	max: "max",
	boolAnd: "bool_and",
	boolOr: "bool_or",
	regrSlope: "regr_slope",
	regrSxx: "regr_sxx"
}

/** The aggregates the generators produce: the public vocabulary over one column, and the boolean folds. */
export const genAggregates = ["count", "sum", "avg", "min", "max", "boolAnd", "boolOr"] as const
export type GenAggregate = (typeof genAggregates)[number]

/**
 * Whether `fn` has a native overload over `type`: sum and avg by their capability, min and max over every
 * ordered carrier with a min/max aggregate, the boolean folds over boolean.
 */
export const aggregateApplies = (fn: GenAggregate, type: ScalarType | undefined): boolean => {
	switch (fn) {
		case "count":
			return true
		case "sum":
			return type !== undefined && hasCap(type, "sum")
		case "avg":
			return type !== undefined && hasCap(type, "avg")
		case "min":
		case "max":
			return type !== undefined && hasCap(type, "minMax")
		case "boolAnd":
		case "boolOr":
			return type !== undefined && hasCap(type, "boolAgg")
	}
}

/**
 * The native result type: count is bigint; sum is bigint over smallint and integer, numeric
 * over bigint and numeric, and the argument's type over real, double precision and money; avg is numeric over the
 * exact types and double precision over the floats; min and max keep the argument's descriptor; the folds are boolean.
 */
export const aggregateResult = (fn: GenAggregate, type: ScalarType | undefined): ScalarType => {
	if (fn === "count") {
		return int8
	}
	if (type === undefined) {
		throw new Error(`${fn} needs an argument`)
	}
	const carrier = genCarrierOf(type)
	switch (fn) {
		case "sum":
			if (carrier === "int2" || carrier === "int4") {
				return int8
			}
			if (carrier === "int8" || carrier === "numeric") {
				return numeric
			}
			return type
		case "avg":
			return carrier === "float4" || carrier === "float8" ? float8 : numeric
		case "min":
		case "max":
			return type
		case "boolAnd":
		case "boolOr":
			return bool
	}
}

export const aggregateOpId = (fn: GenAggregate, type: ScalarType | undefined): CatalogOpId => {
	if (fn === "count") {
		return OpId("count")
	}
	if (fn === "boolAnd") {
		return OpId("bool_and")
	}
	if (fn === "boolOr") {
		return OpId("bool_or")
	}
	if (type === undefined) {
		throw new Error(`${fn} needs an argument`)
	}
	return OpId(`${genCarrierOf(type)}_${fn}`)
}

/**
 * The operator and aggregate vocabulary the generated IR uses.
 *
 * Every expression node is exactly one PostgreSQL operator, function or cast with its native overload identity. The
 * Compute registry (packages/engine/src/scalar/compute) owns the full catalogue; the generators name overloads by these
 * fixed ids, the convention test/unit/ir set ("int8gt", "int8_sum", "count"), and this table is the one place the
 * conservative lowering, the reference evaluator and the mutants read their meaning from:
 *
 * - a comparison is the pg_operator oprcode of the operator over two operands of one type: int4lt, numeric_eq,
 *   text_lt, enum_ge (verifiable as `SELECT oprcode FROM pg_operator`);
 * - the boolean connectives AND, OR and NOT are SQL operators with no pg_proc entry, named "and", "or" and "not";
 *   "and" and "or" take two or more operands;
 * - an aggregate is "<carrier>_<fn>" (int4_sum, numeric_avg, text_min), with "count" for count(*) and bool_and and
 *   bool_or for the boolean folds, each with PostgreSQL's native result type.
 *
 * The meaning of every OpId the generators emit, for the lowering, the reference evaluator and the mutants.
 */
export const opMeaning = (op: OpId): OpMeaning | undefined => {
	for (const connective of ["and", "or", "not"] as const) {
		if (op === connective) {
			return { kind: "boolean", connective }
		}
	}
	if (op === "count") {
		return { kind: "aggregate", fn: "count", sql: "count" }
	}
	if (op === "bool_and") {
		return { kind: "aggregate", fn: "boolAnd", sql: "bool_and" }
	}
	if (op === "bool_or") {
		return { kind: "aggregate", fn: "boolOr", sql: "bool_or" }
	}
	for (const carrier of genCarriers) {
		const fn = Arr.findFirst(["sum", "avg", "min", "max"] as const, (f) => op === `${carrier}_${f}`)
		if (Option.isSome(fn)) {
			return { kind: "aggregate", fn: fn.value, sql: aggregateSql[fn.value] }
		}
		const cmp = Arr.findFirst(compareOps, (c) => op === compareOpIdOf(carrier, c))
		if (Option.isSome(cmp)) {
			return { kind: "compare", op: cmp.value, symbol: compareSymbols[cmp.value], operand: carrier }
		}
	}
	return undefined
}
