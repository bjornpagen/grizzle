import type { SourceLoc } from "#compiler/core/loc.ts"
import { describeOp, type RangeOpCode, type ScalarExpr } from "#compiler/ir/expr.ts"
import { baseOf, type ScalarType, type SpanCarrier } from "#compiler/ir/scalar.ts"
import { refuseAt } from "#compiler/lower/conservative/context.ts"
import { defaultOps } from "#compiler/lower/conservative/expr/ops.ts"
import {
	admits,
	type NativeOp,
	nativeOp,
	operandCarriers
} from "#compiler/scalar/compute/registry.ts"
import type { BinaryOperator, Expr, TypeRef } from "#compiler/sql/ast.ts"
import { binary, cast, types } from "#compiler/sql/build.ts"

/**
 * How each range overload lowers: an Allen atom by its range operator, pointIn as `@>` (the oprcode of
 * `anyrange @> anyelement`), or by its registry entry: the range comparisons, whose range_eq is the ninth Allen atom
 * and span-value equality both, and the endpoint functions.
 */
type RangeForm =
	| { readonly kind: "atom"; readonly op: BinaryOperator }
	| { readonly kind: "pointIn" | "registry" }
const atom = (op: BinaryOperator): RangeForm => ({ kind: "atom", op })
const registry: RangeForm = { kind: "registry" }
const rangeForms: { readonly [K in RangeOpCode]: RangeForm } = {
	range_overlaps: atom("&&"),
	range_contains: atom("@>"),
	range_contained_by: atom("<@"),
	range_before: atom("<<"),
	range_after: atom(">>"),
	range_overleft: atom("&<"),
	range_overright: atom("&>"),
	range_adjacent: atom("-|-"),
	range_contains_elem: { kind: "pointIn" },
	range_eq: registry,
	range_ne: registry,
	range_lt: registry,
	range_le: registry,
	range_gt: registry,
	range_ge: registry,
	"lower(anyrange)": registry,
	"upper(anyrange)": registry
}

const spanEndpointCarrier: Readonly<Record<SpanCarrier, "int4" | "int8" | "date">> = {
	range4: "int4",
	range8: "int8",
	rangeDate: "date"
}

const endpointType: Readonly<Record<"int4" | "int8" | "date", TypeRef>> = {
	int4: types.integer,
	int8: types.bigint,
	date: types.date
}

const carrierOf = (t: ScalarType): string => baseOf(t).carrier

/**
 * The operator of an Allen atom or of pointIn between two lowered operands, checked against their carriers. A point is
 * the element argument of `anyrange @> anyelement`, which PostgreSQL resolves for a domain's base and never for the
 * domain (it flattens a domain to its base for anyrange and anyarray alone), so a point always takes its endpoint's base
 * type: a parameter's placeholder is cast to its declared type's domain as it is bound (LowerContext.scalarParam),
 * whatever type the IR gives the use, and a value the IR types by a contract is that contract's domain. The domain's
 * check runs at the parameter's own cast, so the base cast loses nothing.
 */
const rangeOperator = (
	expr: ScalarExpr & { readonly kind: "op" },
	form: Exclude<RangeForm, { readonly kind: "registry" }>,
	carrier: SpanCarrier,
	args: ReadonlyArray<Expr>,
	at: SourceLoc
): Expr => {
	const name = describeOp(expr.op)
	const [left, right] = args
	const [leftOperand, rightOperand] = expr.args
	if (
		args.length !== 2 ||
		left === undefined ||
		right === undefined ||
		leftOperand === undefined ||
		rightOperand === undefined
	) {
		return refuseAt("MalformedDescription", at, `two operands for the range operator ${name}`)
	}
	if (carrierOf(expr.type) !== "bool") {
		return refuseAt("MalformedDescription", at, `a boolean result of the range operator ${name}`)
	}
	if (carrierOf(leftOperand.type) !== carrier) {
		return refuseAt("MalformedDescription", at, `a ${carrier} span on the left of ${name}`)
	}
	if (form.kind === "atom") {
		if (carrierOf(rightOperand.type) !== carrier) {
			return refuseAt("MalformedDescription", at, `a ${carrier} span on the right of ${name}`)
		}
		return binary(form.op, left, right)
	}
	const endpoint = spanEndpointCarrier[carrier]
	if (carrierOf(rightOperand.type) !== endpoint) {
		return refuseAt(
			"MalformedDescription",
			at,
			`a point of the span's endpoint type ${endpoint} in ${name}, not ${carrierOf(rightOperand.type)}`
		)
	}
	return binary("@>", left, cast(right, endpointType[endpoint]))
}

/** Whether a registry overload's carriers are the node's: a span comparison, construct, lower or upper. */
const registryCarriersAgree = (
	native: NativeOp,
	expr: ScalarExpr & { readonly kind: "op" }
): boolean =>
	native.result === carrierOf(expr.type) &&
	admits(
		native.operands,
		expr.args.map((a) => baseOf(a.type).carrier)
	)

/**
 * The SQL of one span operation node, given its lowered operands. Throws a Refusal for a node it cannot lower.
 *
 * Span operations in the conservative lowering.
 *
 * Every scalar operator, function or comparison whose operands or result are spans lowers here, one IR node to one SQL
 * node. The checker has already expanded each `r.allen` mask into the shipped table's formula (check/checker.ts), so
 * what arrives is one node per range operator; nothing here derives or widens a formula:
 *
 * - an Allen atom, `range_overlaps` at range8 and the like, is the range operator of its pg_operator.oprcode: `&&`, `@>`,
 *   `<@`, `<<`, `>>`, `&<`, `&>`, `-|-`, and `=` through the registry's range comparison. No mask
 *   ever reads lower() or upper(), so the GiST range_ops index on the left span drives every
 *   disjunct and the negated atoms are rechecked on its candidate rows;
 * - `r.pointIn(t, s)`, `range_contains_elem`, is `s @> t`, the range-contains-element operator the same GiST index
 *   serves. PostgreSQL resolves `anyrange @> anyelement` only for the range's own subtype, never through
 *   a domain, so a point PostgreSQL types by a contract over the endpoint is cast to its base, `s @> t::int8`: the cast
 *   is on the probe, never on the indexed span column. A point that is a call of a function or operator with a fixed
 *   result type, such as `lower(s)` of a span over a contract, is already of the base type in PostgreSQL whatever
 *   contract the IR records for the host, and gets no cast: PostgreSQL never records a cast of a value to its own type,
 *   so a stored view's definition would not show one (ScalarExpr.pgType);
 * - span equality and ordering (`range_eq` .. `range_ge`), and `between`, `in`, `least` and `greatest` over spans, are
 *   the registry's range comparisons and constructs: shared span variables and span-value equality compare complete
 *   span values with `=`;
 * - `Compute.lower` and `Compute.upper` are `lower(s)` and `upper(s)` over the bounded, nonempty span, which never
 *   return NULL, and `Compute.width` is `upper(s) - lower(s)` in the endpoint's base type, its
 *   subtraction an ordinary integer node; in a contract predicate or a row check the checker casts both
 *   endpoints to numeric first, so a stored width check never overflows.
 *
 * Each node's operand and result carriers are checked against the operator it names: an IR whose span node pairs a
 * range4 with a range8, or names a point of the wrong endpoint type, is MalformedDescription, and an identity this
 * vocabulary does not know is UnsupportedOperation naming it. The persistent lowering of CHECKs (physical/ddl/expr.ts)
 * uses this same vocabulary, so a span expression installed in the schema and the same expression in a query are one
 * native expression tree.
 *
 * The optimized artifact spells every Allen mask, pointIn and span comparison through this vocabulary too. Its one
 * rewrite of span predicates is the Allen normal form (lower/optimize/simplify/allen.ts), which writes an endpoint
 * spelling of a relation between two spans, `lower(a) > lower(b)` or `b @> lower(a)`, as its mask's table formula;
 * this lowering, the differential's comparator, keeps the spelling as written. A mask's formula is already the
 * shipped table's minimal one, so no rewrite could make it smaller or more indexable. The converse lowering for an
 * index on the right span only is the workload compiler's choice by the indexes a program requests, not a rewrite of the
 * formula.
 */
export const lowerSpanOp = (
	expr: ScalarExpr & { readonly kind: "op" },
	args: ReadonlyArray<Expr>,
	at: SourceLoc
): Expr => {
	if (typeof expr.op !== "string") {
		const form = rangeForms[expr.op.code]
		if (form.kind !== "registry") {
			return rangeOperator(expr, form, expr.op.carrier, args, at)
		}
	}
	const native = nativeOp(expr.op)
	if (native !== undefined) {
		if (!registryCarriersAgree(native, expr)) {
			return refuseAt(
				"MalformedDescription",
				at,
				`operands and result of the carriers ${describeOp(expr.op)} names (${operandCarriers(native.operands).join(", ")} to ${native.result})`
			)
		}
		const lowered = defaultOps(expr, args)
		if (lowered !== undefined) {
			return lowered
		}
	}
	return refuseAt(
		"UnsupportedOperation",
		at,
		`a span operation ${describeOp(expr.op)}: spans admit the Allen range operators, pointIn, span comparisons, and Compute.lower, upper and width`
	)
}
