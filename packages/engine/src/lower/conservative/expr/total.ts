import { exactParts, nanParts } from "#compiler/core/decimal.ts"
import type { Limit } from "#compiler/core/limits.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import {
	binary32MaxExponent,
	binary32MinExponent,
	binary32Precision,
	binary64MaxExponent,
	binary64MinExponent,
	binary64Precision,
	int8ExactDigits
} from "#compiler/ir/carriers.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { ExactCarrier } from "#compiler/scalar/aggregate.ts"
import { type FloatCarrier, nativeRange } from "#compiler/scalar/compute/native.ts"
import { type IeeeOp, type NativeOp, nativeOp } from "#compiler/scalar/compute/registry.ts"
import type { Expr, OperandSelect, Select, TypeRef } from "#compiler/sql/ast.ts"
import {
	and,
	binary,
	call,
	cast,
	col,
	eq,
	exactNumericOfDouble,
	ge,
	gt,
	le,
	lit,
	lt,
	ne,
	not,
	operandSelect,
	or,
	provedCore,
	select,
	target,
	types
} from "#compiler/sql/build.ts"

/**
 * The SQL rendering of the two Totalities whose computation is not the native overload's (scalar/compute/registry.ts):
 * exact integer and money arithmetic (T1) and IEEE 754 float arithmetic (T2). Every rendering is a function of the
 * IR alone, so a CHECK, an expression index and a query render one expression alike.
 */

/**
 * The SQL space an exact value is computed in: bigint where its digit bound fits int8ExactDigits, numeric otherwise.
 */
type Space = "int8" | "numeric"

const spaceOf = (t: ScalarType): Space | undefined => {
	const b = baseOf(t)
	switch (b.carrier) {
		case "exactInteger":
			return b.digits <= int8ExactDigits.value ? "int8" : "numeric"
		case "exactMoney":
			return "numeric"
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
			return undefined
	}
}

const spaceType: { readonly [S in Space]: TypeRef } = { int8: types.bigint, numeric: types.numeric }

/** Whether an expression is a plain integer widened into the exact integers, the cast a comparison reads through. */
const integerWidening = (e: ScalarExpr): boolean => {
	if (e.kind !== "cast" || e.type.carrier !== "exactInteger") {
		return false
	}
	const [arg] = e.args
	const c = baseOf(arg.type).carrier
	return c === "int2" || c === "int4" || c === "int8"
}

/** The SQL a cast node rendered as `CAST(inner AS type)` holds: its inner expression. */
const castInner = (e: Expr): Expr => (e.kind === "cast" ? e.expr : e)

/**
 * An exact operation's SQL (T1): its operands brought into one space, bigint where its digit bounds fit
 * int8ExactDigits and numeric otherwise, and the space's own operator, so no step overflows; a result whose own type
 * lies in the other space is cast into it, so its SQL type is its physical type (a bigint for an exact integer of at
 * most int8ExactDigits digits). An overload whose Totality is exact computes over plain integers or money (int4pl is an exact sum of two integers,
 * cash_pl of two amounts); every other overload over an exact operand is the exact carriers' own. A comparison computed
 * in bigint reads a widened plain integer bare, so PostgreSQL's cross-type integer operators keep the integer column's
 * index serving it.
 */
export const exactForm = (
	expr: ScalarExpr & { readonly kind: "op" },
	native: NativeOp,
	args: ReadonlyArray<Expr>
): Expr | undefined => {
	const spaces = [expr.type, ...expr.args.map((a) => a.type)].map(spaceOf)
	const space: Space = spaces.includes("numeric") ? "numeric" : "int8"
	const comparison =
		native.fn === "eq" ||
		native.fn === "ne" ||
		native.fn === "lt" ||
		native.fn === "le" ||
		native.fn === "gt" ||
		native.fn === "ge" ||
		native.fn === "between" ||
		native.fn === "in" ||
		native.fn === "least" ||
		native.fn === "greatest"
	const operands = args.map((sql, i) => {
		const ir = expr.args[i]
		if (ir === undefined) {
			return sql
		}
		if (comparison && space === "int8" && integerWidening(ir)) {
			return castInner(sql)
		}
		return spaceOf(ir.type) === space ? sql : cast(sql, spaceType[space])
	})
	const computed = exactIn(native, space, operands)
	const own = spaceOf(expr.type)
	return computed === undefined || own === undefined || own === space
		? computed
		: cast(computed, spaceType[own])
}

/** An exact operation computed in `space` over its operands brought into it. */
const exactIn = (
	native: NativeOp,
	space: Space,
	operands: ReadonlyArray<Expr>
): Expr | undefined => {
	const [x, y, z] = operands
	if (x === undefined) {
		return undefined
	}
	switch (native.fn) {
		case "add":
			return y === undefined ? undefined : binary("+", x, y)
		case "sub":
			return y === undefined ? undefined : binary("-", x, y)
		case "mul":
			return y === undefined ? undefined : binary("*", x, y)
		case "neg":
			return { kind: "negate", expr: x }
		case "abs":
			return call("abs", [x])
		case "gcd":
		case "lcm":
			return y === undefined ? undefined : call(native.fn, [x, y])
		case "div":
			return y === undefined
				? undefined
				: space === "int8"
					? binary("/", x, y)
					: call("div", [x, y])
		case "mod":
			return y === undefined
				? undefined
				: space === "int8"
					? binary("%", x, y)
					: call("mod", [x, y])
		case "sign":
			return space === "int8"
				? cast(call("sign", [cast(x, types.numeric)]), types.bigint)
				: call("sign", [x])
		case "eq":
			return y === undefined ? undefined : eq(x, y)
		case "ne":
			return y === undefined ? undefined : ne(x, y)
		case "lt":
			return y === undefined ? undefined : lt(x, y)
		case "le":
			return y === undefined ? undefined : le(x, y)
		case "gt":
			return y === undefined ? undefined : gt(x, y)
		case "ge":
			return y === undefined ? undefined : ge(x, y)
		case "between":
			return y === undefined || z === undefined
				? undefined
				: { kind: "between", expr: x, low: y, high: z, not: false }
		case "in": {
			const [, ...listed] = operands
			return isNonEmpty(listed)
				? { kind: "inList", expr: x, list: listed, not: false }
				: lit.bool(false)
		}
		case "least":
		case "greatest":
			return { kind: native.fn, args: [x, ...operands.slice(1)] }
		case "and":
		case "or":
		case "not":
		case "cast":
		case "ceil":
		case "floor":
		case "round":
		case "trunc":
		case "minScale":
		case "power":
		case "sqrt":
		case "quot":
		case "rem":
		case "widthBucket":
		case "charLength":
		case "octetLength":
		case "concat":
		case "startsWith":
		case "endsWith":
		case "right":
		case "matches":
		case "translate":
		case "collapse":
		case "regexpReplace":
		case "btrim":
		case "lower":
		case "upper":
		case "cosineDistance":
		case "union":
		case "intersection":
		case "difference":
		case "complement":
		case "cardinality":
		case "subset":
		case "disjoint":
		case "adjoin":
			return undefined
	}
}

/** An integer as a numeric literal. */
const numericInteger = (n: bigint): Expr => lit.decimal(exactParts(n, 0), types.numeric)

/**
 * What one binary format's rounding reads, from its precision p, greatest exponent emax and least normal exponent emin
 * (ir/carriers.ts): `over`, 2^(emax + 1) - 2^(emax - p), the midpoint between the greatest finite value and
 * 2^(emax + 1), at or past which a value rounds to an infinity; `under`, 2^(p - emin), the inverse of half the least
 * subnormal, 2^(emin - p), at or below which a value rounds to zero; and the scale of an exact quotient
 * (exactQuotient), 10^(p - emin), with its half unit, 5 · 10^-(p - emin + 1). Every point at which the format's
 * rounding changes, a midpoint between two neighbours, `over` and half the least subnormal, is a multiple of
 * 2^(emin - p), and so of 10^(emin - p): a quotient on one is exact at that scale, and one strictly between two
 * multiples of it rounds as every value between them does.
 */
const formatOf = (
	p: Limit,
	emax: Limit,
	emin: Limit,
	type: TypeRef
): {
	readonly over: Expr
	readonly under: Expr
	readonly quotientScale: Expr
	readonly halfUnit: Expr
	readonly type: TypeRef
} => {
	const cell = p.value - emin.value
	return {
		over: numericInteger(2n ** BigInt(emax.value + 1) - 2n ** BigInt(emax.value - p.value)),
		under: numericInteger(2n ** BigInt(cell)),
		quotientScale: numericInteger(10n ** BigInt(cell)),
		halfUnit: lit.decimal(exactParts(5n, cell + 1), types.numeric),
		type
	}
}

/** The binary64 and binary32 roundings (formatOf). */
const thresholds = {
	float8: formatOf(binary64Precision, binary64MaxExponent, binary64MinExponent, types.double),
	float4: formatOf(binary32Precision, binary32MaxExponent, binary32MinExponent, types.real)
} as const

const floatLit = (value: number, carrier: "float4" | "float8"): Expr =>
	lit.float(value, thresholds[carrier].type)

const caseOf = (whens: NonEmptyReadonlyArray<readonly [Expr, Expr]>, otherwise: Expr): Expr => ({
	kind: "case",
	operand: undefined,
	whens: mapNonEmpty(whens, ([when, result]) => ({ when, result })),
	else: otherwise
})

/**
 * The alias of the derived row that binds an operation's operands, in the reserved __ namespace no lowering mints: the
 * one FROM item of its own scalar subquery, so a nested binding shadows an enclosing one and reads only its own row.
 */
export const operandsAlias = "__operands"

/**
 * Whether an operand's SQL repeats inline at no cost: a column, a parameter, a literal, VALUE, or a cast of one. The
 * SQL decides, never the IR: a column reference renders as whatever SQL its scope binds the column to, which can be any
 * expression (a correlated variable's value, a parent's key).
 */
const isAtom = (e: Expr): boolean =>
	e.kind === "cast"
		? isAtom(e.expr)
		: e.kind === "column" || e.kind === "param" || e.kind === "literal" || e.kind === "domainValue"

/**
 * The one row of an operation's operands, SELECT a, b OFFSET 0. The OFFSET keeps PostgreSQL's planner from pulling the
 * row up into the subquery that reads it, which would put a copy of each operand at each of its references and plan
 * the copies' own bindings again, so nesting would cost exponential planning time.
 */
const operandRow = (operands: NonEmptyReadonlyArray<Expr>): Select => ({
	...select(provedCore("oneRow", mapNonEmpty(operands, target), [], undefined)),
	offset: lit.int(0, types.bigint)
})

/**
 * A rendering that names its operands several times, over operands rendered once: inline where every operand is an
 * atom, and otherwise as a scalar subquery that binds them once, (SELECT <form> FROM (SELECT a, b OFFSET 0) AS
 * __operands(c1, c2)), one row, its columns the generated c<n> names every stage's columns take. Each compound
 * operand's text appears once, so nesting costs linear size and linear planning, never exponential (operandRow).
 * Nothing in it reads a row of its own: it is its operands' function, so where a statement evaluates it for every row,
 * the statement reads it as a LATERAL item of that row instead (lateral.ts bindLaterally). A window call is never an
 * operand: bound, it would compute over the binding's one row.
 */
const bindOperands = <F extends Expr | undefined>(
	sqlArgs: NonEmptyReadonlyArray<Expr>,
	form: (operands: NonEmptyReadonlyArray<Expr>) => F
): F | Expr => {
	if (sqlArgs.every(isAtom)) {
		return form(sqlArgs)
	}
	const names = mapNonEmpty(sqlArgs, (_, i) => `c${i + 1}`)
	const body = form(mapNonEmpty(names, (name) => col(operandsAlias, name)))
	if (body === undefined) {
		return body
	}
	return {
		kind: "subquery",
		query: operandSelect(
			provedCore(
				"oneRow",
				[target(body)],
				[
					{
						kind: "derived",
						query: operandRow(sqlArgs),
						alias: operandsAlias,
						columns: names,
						lateral: false
					}
				],
				undefined
			)
		)
	}
}

/** Whether a query is an operation's operand binding (bindOperands): a core whose first FROM item is its operand row. */
export const isOperandBinding = (query: OperandSelect): boolean => {
	const body = query.body
	if (body.kind !== "core") {
		return false
	}
	const [row] = body.from
	return row?.kind === "derived" && row.alias === operandsAlias
}

/**
 * A numeric value rounded once to the float carrier as IEEE 754 rounds, half to even: NaN is NaN; at or past the
 * rounding threshold (the midpoint between the greatest finite value and 2^128 or 2^1024) an infinity of its sign; at
 * or below half the least subnormal the one zero; any other value through float8in or float4in, which round correctly
 * and admit subnormals. PostgreSQL's own numeric-to-float cast raises past the range, so it is never reached there.
 */
export const roundToFloat = (n: Expr, carrier: "float4" | "float8"): Expr => {
	const { over, under, type } = thresholds[carrier]
	return caseOf(
		[
			[eq(n, lit.decimal(nanParts, types.numeric)), floatLit(Number.NaN, carrier)],
			[
				ge(call("abs", [n]), over),
				caseOf(
					[[gt(n, numericInteger(0n)), floatLit(Number.POSITIVE_INFINITY, carrier)]],
					floatLit(Number.NEGATIVE_INFINITY, carrier)
				)
			],
			[le(binary("*", call("abs", [n]), under), numericInteger(1n)), floatLit(0, carrier)]
		],
		cast(n, type)
	)
}

/** Whether a float operand is NaN or an infinity: not strictly between the infinities. */
const special = (x: Expr, carrier: "float4" | "float8"): Expr =>
	not(
		and([
			gt(x, floatLit(Number.NEGATIVE_INFINITY, carrier)),
			lt(x, floatLit(Number.POSITIVE_INFINITY, carrier))
		])
	)

/** Whether a float operand's magnitude lies in [2^-k, 2^k]. */
const moderate = (x: Expr, k: number, carrier: "float4" | "float8"): Expr => ({
	kind: "between",
	expr: call("abs", [x]),
	low: floatLit(2 ** -k, carrier),
	high: floatLit(2 ** k, carrier),
	not: false
})

/**
 * The exact numeric value of a float or money expression: a double's bits (sql/build.ts exactNumericOfDouble), which
 * name the double many times, so a compound one is bound once (bindOperands), a real widened to double precision
 * exactly first, money as money::numeric (cash_numeric, exact).
 */
export const exactNumeric = (e: Expr, carrier: ExactCarrier): Expr => {
	switch (carrier) {
		case "money":
			return cast(e, types.numeric)
		case "float4":
			return bindOperands([e], ([x]) => exactNumericOfDouble(cast(x, types.double)))
		case "float8":
			return bindOperands([e], ([x]) => exactNumericOfDouble(x))
	}
}

/**
 * roundToFloat over a value bound once (bindOperands): the rounding of an exact path, whose value is a compound
 * expression of bound operands. roundToFloat itself names its value inline, as an aggregate's rounded total, a window
 * call among them, must.
 */
const roundedOnce = (n: Expr, carrier: "float4" | "float8"): Expr =>
	bindOperands([n], ([v]) => roundToFloat(v, carrier))

/** A float operand's exact numeric value (exactNumeric), of a finite operand. */
const exactOf = (x: Expr, carrier: "float4" | "float8"): Expr => exactNumeric(x, carrier)

/**
 * The correctly rounded quotient of two finite floats, the divisor nonzero, from their exact values: the quotient
 * scaled by the carrier's quotient scale 10^(p - emin) (formatOf) and truncated (div, exact), doubled, and one more
 * toward its sign where it was inexact (a sticky half unit), then scaled back exactly and rounded once. Every point at
 * which the carrier's rounding changes, a tie among them, is a multiple of 10^(emin - p), so a quotient on one is
 * exact at that scale, and an inexact one and its sticky half unit lie strictly between the same two multiples, where
 * no rounding changes, and round alike. The value rounded is bound once (roundedOnce).
 */
const exactQuotient = (x: Expr, y: Expr, carrier: "float4" | "float8"): Expr => {
	const { quotientScale, halfUnit } = thresholds[carrier]
	const scaled = binary("*", exactOf(x, carrier), quotientScale)
	const divisor = exactOf(y, carrier)
	const truncated = call("div", [scaled, divisor])
	const sticky = caseOf(
		[[eq(call("mod", [scaled, divisor]), numericInteger(0n)), numericInteger(0n)]],
		binary("*", call("sign", [exactOf(x, carrier)]), call("sign", [divisor]))
	)
	const doubled = binary("+", binary("*", truncated, numericInteger(2n)), sticky)
	return roundedOnce(binary("*", doubled, halfUnit), carrier)
}

/**
 * An IEEE 754 operation's guarded form over its operands' SQL (T2): CASE WHEN <fast> THEN <native> ELSE <exact path>
 * END. The fast test admits operands PostgreSQL's native operation meets with no overflow, underflow or zero divisor
 * (it computes IEEE there): NaN and the infinities (which it propagates), zeros of a product, and magnitudes inside
 * the range native.ts nativeRange states. The exact path computes the exact value of the finite operands and rounds it
 * once (roundToFloat); a zero divisor gives the infinity of the dividend's sign, or NaN over a zero or NaN dividend
 * (grizzle's floats have one zero, so the divisor's sign never shows), and NULL over a NULL dividend, as every
 * strict operation is NULL over a NULL operand, which a closed read at an absent key reads; the square root of a
 * negative is NaN.
 */
const guardedForm = (
	op: Exclude<IeeeOp, "round">,
	carrier: FloatCarrier,
	operands: ReadonlyArray<Expr>
): Expr | undefined => {
	const [x, y] = operands
	if (x === undefined) {
		return undefined
	}
	const zero = floatLit(0, carrier)
	const nan = floatLit(Number.NaN, carrier)
	const { sum, product } = nativeRange[carrier]
	switch (op) {
		case "sqrt":
			return caseOf([[lt(x, zero), nan]], call("sqrt", [x]))
		case "add":
		case "sub": {
			if (y === undefined) {
				return undefined
			}
			const native = binary(op === "add" ? "+" : "-", x, y)
			const fast = or([
				special(x, carrier),
				special(y, carrier),
				and([
					lt(call("abs", [x]), floatLit(2 ** sum, carrier)),
					lt(call("abs", [y]), floatLit(2 ** sum, carrier))
				])
			])
			const exact = roundedOnce(
				binary(op === "add" ? "+" : "-", exactOf(x, carrier), exactOf(y, carrier)),
				carrier
			)
			return caseOf([[fast, native]], exact)
		}
		case "mul": {
			if (y === undefined) {
				return undefined
			}
			const fast = or([
				special(x, carrier),
				special(y, carrier),
				eq(x, zero),
				eq(y, zero),
				and([moderate(x, product, carrier), moderate(y, product, carrier)])
			])
			const exact = roundedOnce(binary("*", exactOf(x, carrier), exactOf(y, carrier)), carrier)
			return caseOf([[fast, binary("*", x, y)]], exact)
		}
		case "div": {
			if (y === undefined) {
				return undefined
			}
			const fast = and([
				ne(y, zero),
				or([
					special(x, carrier),
					special(y, carrier),
					eq(x, zero),
					and([moderate(x, product, carrier), moderate(y, product, carrier)])
				])
			])
			const byZero = caseOf(
				[
					[or([eq(x, zero), eq(x, nan)]), nan],
					[gt(x, zero), floatLit(Number.POSITIVE_INFINITY, carrier)],
					[lt(x, zero), floatLit(Number.NEGATIVE_INFINITY, carrier)]
				],
				x
			)
			return caseOf(
				[
					[fast, binary("/", x, y)],
					[eq(y, zero), byZero]
				],
				exactQuotient(x, y, carrier)
			)
		}
	}
}

/**
 * A conversion into a float carrier rounded as IEEE 754 rounds (a registered cast whose Totality is ieee round): from
 * numeric or an exact integer by roundToFloat, from double precision to real natively where PostgreSQL's cast meets no
 * overflow or underflow (NaN, the infinities, zero and the normal range) and by the exact value rounded once otherwise;
 * a bigint exact integer converts natively, as a bigint never leaves either range.
 */
const ieeeCastForm = (arg: Expr, from: ScalarType, to: "float4" | "float8"): Expr => {
	const source = baseOf(from)
	const space = spaceOf(source)
	if (space === "int8") {
		return cast(arg, thresholds[to].type)
	}
	if (source.carrier === "float8") {
		const fast = or([
			special(arg, "float8"),
			eq(arg, floatLit(0, "float8")),
			moderate(arg, nativeRange.float4.rounding, "float8")
		])
		return caseOf([[fast, cast(arg, types.real)]], roundedOnce(exactOf(arg, "float8"), "float4"))
	}
	return roundedOnce(space === "numeric" ? cast(arg, types.numeric) : arg, to)
}

/**
 * How an IEEE 754 node renders, an operation or a cast whose overload's Totality is ieee (T2): as PostgreSQL's own
 * overload where the node carries the proof that it computes the IEEE 754 value there (ir/proof.ts NativeProof), with
 * no guard and no binding; otherwise as its guarded form over its operands bound once (bindOperands), an operation's
 * fast and exact paths (guardedForm) or a rounding's (ieeeCastForm). Undefined for a node of any other overload. The
 * one choice every renderer of an IEEE 754 node makes: the conservative lowering's operations (ops.ts) and casts
 * (index.ts), and the compute suites' renderer.
 */
export const ieeeForm = (
	expr: ScalarExpr & { readonly kind: "op" | "cast" },
	args: ReadonlyArray<Expr>
):
	| { readonly kind: "native" }
	| { readonly kind: "guarded"; readonly sql: Expr | undefined }
	| undefined => {
	const totality = nativeOp(expr.kind === "op" ? expr.op : expr.cast)?.totality
	const carrier = baseOf(expr.type).carrier
	const [first, ...rest] = args
	const [source] = expr.args
	if (
		totality?.kind !== "ieee" ||
		(carrier !== "float4" && carrier !== "float8") ||
		first === undefined
	) {
		return undefined
	}
	if ("native" in expr) {
		return { kind: "native" }
	}
	const op = totality.op
	return {
		kind: "guarded",
		sql: bindOperands([first, ...rest], (operands) =>
			op === "round"
				? ieeeCastForm(operands[0], source.type, carrier)
				: guardedForm(op, carrier, operands)
		)
	}
}
