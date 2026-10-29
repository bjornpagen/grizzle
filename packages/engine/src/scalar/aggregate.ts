import { type CompileError, unsupported } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { type CatalogOpId, OpId as opId } from "#compiler/ir/expr.ts"
import type { AggregateFn } from "#compiler/ir/rel.ts"
import { baseOf, type Carrier, type ScalarType, typeLabel } from "#compiler/ir/scalar.ts"
import type { FailureCode } from "#compiler/scalar/compute/registry.ts"
import {
	type PlainCarrier,
	plainType,
	valueType,
	withoutSerial
} from "#compiler/scalar/compute/types.ts"

export type AggregateName = "count" | "sum" | "mean" | "min" | "max"

/** An aggregate as a rule applies it: count to no argument, every other aggregate to one argument of the given type. */
export type AggregateCall =
	| { readonly name: "count" }
	| { readonly name: Exclude<AggregateName, "count">; readonly arg: ScalarType }

/** The IR's aggregates of one argument (ir/rel.ts): every aggregate a rule applies but count. */
type UnaryAggregateFn = Exclude<AggregateFn, "count" | "regrSlope" | "regrSxx">

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
	/**
	 * The SQLSTATEs the aggregation can raise: a float or money accumulation overflows, a numeric one exceeds numeric's
	 * format.
	 */
	readonly failures: ReadonlyArray<FailureCode>
}

interface Entry {
	readonly result: PlainCarrier
	readonly failures: ReadonlyArray<FailureCode>
}

/** The catalog's argument type names (pg_aggregate over pg_proc). */
const catalogName: { readonly [C in Carrier]: string } = {
	int2: "smallint",
	int4: "integer",
	int8: "bigint",
	numeric: "numeric",
	float4: "real",
	float8: "double precision",
	money: "money",
	bool: "boolean",
	uuid: "uuid",
	text: "text",
	enum: "anyenum",
	range4: "anyrange",
	range8: "anyrange",
	vector: "vector"
}

const sumOverloads: Readonly<Partial<Record<Carrier, Entry>>> = {
	int2: { result: "int8", failures: [] },
	int4: { result: "int8", failures: [] },
	int8: { result: "numeric", failures: [] },
	numeric: { result: "numeric", failures: ["22003"] },
	float4: { result: "float4", failures: ["22003"] },
	float8: { result: "float8", failures: ["22003"] },
	money: { result: "money", failures: ["22003"] }
}

const avgOverloads: Readonly<Partial<Record<Carrier, Entry>>> = {
	int2: { result: "numeric", failures: [] },
	int4: { result: "numeric", failures: [] },
	int8: { result: "numeric", failures: [] },
	numeric: { result: "numeric", failures: ["22003"] },
	float4: { result: "float8", failures: ["22003"] },
	float8: { result: "float8", failures: ["22003"] }
}

/** The carriers with min and max: those with the minMax capability, PostgreSQL's min(anyenum) included. */
const minMaxCarriers: ReadonlyArray<Carrier> = [
	"int2",
	"int4",
	"int8",
	"numeric",
	"float4",
	"float8",
	"money",
	"text",
	"enum"
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
 * | money            | money            | refused          |
 *
 * r.count is bigint. A contract input contributes its base to r.sum and r.mean, whose result is no contract until an
 * explicit cast; r.min and r.max return an input unchanged and keep its type, contract included. Numeric sums and
 * means carry no typmod. Over boolean, r.min is bool_and and r.max is bool_or, matching false < true.
 * PostgreSQL defines no AVG(money), no sum or mean over any other type, and no min or max over uuid, ranges or vectors,
 * so those are UnsupportedOperation with the capability named.
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
	failures: []
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
		return Result.ok({
			fn: sql,
			op: opId(`${sql}(${catalogName[c]})`),
			sql,
			result: plainType(entry.result),
			failures: entry.failures
		})
	}
	/** min and max keep the input's type, contract included. */
	const kept = withoutSerial(arg)
	if (c === "bool") {
		const sql = name === "min" ? "bool_and" : "bool_or"
		return Result.ok({
			fn: name === "min" ? "boolAnd" : "boolOr",
			op: opId(`${sql}(boolean)`),
			sql,
			result: kept,
			failures: []
		})
	}
	if (!minMaxCarriers.includes(c) || !baseOf(arg).caps.includes("minMax")) {
		return refusedAggregate(loc, `minMax: PostgreSQL has no ${name} over ${typeLabel(arg)}`)
	}
	return Result.ok({
		fn: name,
		op: opId(`${name}(${catalogName[c]})`),
		sql: name,
		result: kept,
		failures: []
	})
}
