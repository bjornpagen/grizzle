import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { IeeeOp, NativeOp } from "#compiler/scalar/compute/registry.ts"
import type { Expr, TypeRef } from "#compiler/sql/ast.ts"
import {
	and,
	binary,
	call,
	cast,
	col,
	core,
	eq,
	exactNumeric,
	ge,
	gt,
	le,
	lit,
	lt,
	ne,
	not,
	or,
	select,
	target,
	types
} from "#compiler/sql/build.ts"

/**
 * The SQL rendering of the two Totalities whose computation is not the native overload's (scalar/compute/registry.ts):
 * exact integer and money arithmetic (T1) and IEEE 754 float arithmetic (T2). Every rendering is a function of the
 * IR alone, so a CHECK, an expression index and a query render one expression alike.
 */

/** The SQL space an exact value is computed in: bigint where its digit bound fits 18 digits, numeric otherwise. */
type Space = "int8" | "numeric"

const spaceOf = (t: ScalarType): Space | undefined => {
	const b = baseOf(t)
	switch (b.carrier) {
		case "exactInteger":
			return b.digits <= 18 ? "int8" : "numeric"
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
		case "text":
		case "enum":
		case "range4":
		case "range8":
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
 * An exact operation's SQL (T1): its operands brought into one space, bigint where its digit bounds fit 18 digits and
 * numeric otherwise, and the space's own operator, so no step overflows. An overload whose Totality is exact computes
 * over plain integers or money (int4pl is an exact sum of two integers, cash_pl of two amounts); every other overload
 * over an exact operand is the exact carriers' own. A comparison computed in bigint reads a widened plain integer
 * bare, so PostgreSQL's cross-type integer operators keep the integer column's index serving it.
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
		default:
			return undefined
	}
}

/** The binary64 and binary32 thresholds of one rounding: past `over` a value rounds to an infinity; at or below 2^-`under` to zero. */
const thresholds = {
	float8: {
		over: (2n ** 1024n - 2n ** 970n).toString(),
		under: (2n ** 1075n).toString(),
		type: types.double
	},
	float4: {
		over: (2n ** 128n - 2n ** 103n).toString(),
		under: (2n ** 150n).toString(),
		type: types.real
	}
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
 * A numeric value rounded once to the float carrier as IEEE 754 rounds, half to even: NaN is NaN; at or past the
 * rounding threshold (the midpoint between the greatest finite value and 2^128 or 2^1024) an infinity of its sign; at
 * or below half the least subnormal the one zero; any other value through float8in or float4in, which round correctly
 * and admit subnormals. PostgreSQL's own numeric-to-float cast raises past the range, so it is never reached there.
 */
export const roundToFloat = (n: Expr, carrier: "float4" | "float8"): Expr => {
	const { over, under, type } = thresholds[carrier]
	const numeric = (text: string): Expr => lit.decimal(text, types.numeric)
	return caseOf(
		[
			[eq(n, lit.decimal("NaN", types.numeric)), floatLit(Number.NaN, carrier)],
			[
				ge(call("abs", [n]), numeric(over)),
				caseOf(
					[[gt(n, numeric("0")), floatLit(Number.POSITIVE_INFINITY, carrier)]],
					floatLit(Number.NEGATIVE_INFINITY, carrier)
				)
			],
			[le(binary("*", call("abs", [n]), numeric(under)), numeric("1")), floatLit(0, carrier)]
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

/** The magnitudes the native operations of each width meet with no overflow or underflow. */
const safe = { float8: { sum: 1022, product: 500 }, float4: { sum: 126, product: 60 } } as const

/** A float operand's exact numeric value (sql/build.ts exactNumeric), of a finite operand. */
const exactOf = (x: Expr, carrier: "float4" | "float8"): Expr => exactNumeric(x, carrier)

/** 10^700 and 5 · 10^-701: an exact quotient's scale and its half unit, written as numeric_in reads them exactly. */
const quotientScale = lit.decimal("1e700", types.numeric)
const halfUnit = lit.decimal("5e-701", types.numeric)

/**
 * The correctly rounded quotient of two finite floats, the divisor nonzero, from their exact values: the quotient
 * scaled by 10^700 and truncated (div, exact), doubled, and one more toward its sign where it was inexact (a sticky
 * half unit), then scaled back exactly and rounded once. The truncated quotient keeps at least 68 significant digits
 * for any two doubles, so the sticky half unit decides every rounding the true quotient does.
 */
const exactQuotient = (x: Expr, y: Expr, carrier: "float4" | "float8"): Expr => {
	const scaled = binary("*", exactOf(x, carrier), quotientScale)
	const divisor = exactOf(y, carrier)
	const truncated = call("div", [scaled, divisor])
	const sticky = caseOf(
		[
			[
				eq(call("mod", [scaled, divisor]), lit.decimal("0", types.numeric)),
				lit.decimal("0", types.numeric)
			]
		],
		binary("*", call("sign", [exactOf(x, carrier)]), call("sign", [divisor]))
	)
	const doubled = binary("+", binary("*", truncated, lit.decimal("2", types.numeric)), sticky)
	return roundToFloat(binary("*", doubled, halfUnit), carrier)
}

/**
 * An IEEE 754 operation over its operands' SQL (T2): CASE WHEN <fast> THEN <native> ELSE <exact path> END. The fast
 * test admits exactly the operands PostgreSQL's native operation meets with no overflow, underflow or zero divisor (it
 * computes IEEE there): NaN and the infinities (which it propagates), zeros of a product, and magnitudes inside the
 * safe range. The exact path computes the exact value of the finite operands and rounds it once (roundToFloat); a zero
 * divisor gives the infinity of the dividend's sign, or NaN over a zero or NaN dividend (grizzle's floats have one
 * zero, so the divisor's sign never shows); the square root of a negative is NaN.
 */
export const ieeeForm = (
	op: IeeeOp,
	carrier: "float4" | "float8",
	operands: ReadonlyArray<Expr>
): Expr | undefined => {
	const [x, y] = operands
	if (x === undefined) {
		return undefined
	}
	const zero = floatLit(0, carrier)
	const nan = floatLit(Number.NaN, carrier)
	const { sum, product } = safe[carrier]
	switch (op) {
		case "sqrt":
			return caseOf([[lt(x, zero), nan]], call("sqrt", [x]))
		case "round":
			return undefined
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
			const exact = roundToFloat(
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
			const exact = roundToFloat(binary("*", exactOf(x, carrier), exactOf(y, carrier)), carrier)
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
					[gt(x, zero), floatLit(Number.POSITIVE_INFINITY, carrier)]
				],
				floatLit(Number.NEGATIVE_INFINITY, carrier)
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
export const ieeeCastForm = (arg: Expr, from: ScalarType, to: "float4" | "float8"): Expr => {
	const source = baseOf(from)
	const space = spaceOf(source)
	if (space === "int8") {
		return cast(arg, thresholds[to].type)
	}
	if (source.carrier === "float8") {
		const fast = or([
			special(arg, "float8"),
			eq(arg, floatLit(0, "float8")),
			moderate(arg, 125, "float8")
		])
		return caseOf([[fast, cast(arg, types.real)]], roundToFloat(exactOf(arg, "float8"), "float4"))
	}
	return roundToFloat(space === "numeric" ? cast(arg, types.numeric) : arg, to)
}

/** The alias of the VALUES row that binds an operation's operands, in the reserved __ namespace no lowering mints. */
const operandsAlias = "__operands"

/** Whether an IR expression is a leaf, whose SQL repeats inline at no cost: a column, a parameter, a literal, VALUE. */
const isLeaf = (e: ScalarExpr): boolean =>
	e.kind === "column" || e.kind === "param" || e.kind === "literal" || e.kind === "value"

/**
 * A rendering that names its operands several times, over operands rendered once: inline where every operand is a
 * leaf, and otherwise as a scalar subquery that binds them once, (SELECT <form> FROM (VALUES (a, b)) AS
 * __operands(o0, o1)), so
 * nesting costs linear size, never exponential. Nothing in it reads a row of its own: it is its operands' function.
 */
export const bindOperands = (
	irArgs: ReadonlyArray<ScalarExpr>,
	sqlArgs: NonEmptyReadonlyArray<Expr>,
	form: (operands: NonEmptyReadonlyArray<Expr>) => Expr | undefined
): Expr | undefined => {
	if (irArgs.every(isLeaf)) {
		return form(sqlArgs)
	}
	const names = mapNonEmpty(sqlArgs, (_, i) => `o${i}`)
	const body = form(mapNonEmpty(names, (name) => col(operandsAlias, name)))
	if (body === undefined) {
		return undefined
	}
	return {
		kind: "subquery",
		query: select(
			core(
				[target(body)],
				[{ kind: "values", rows: [sqlArgs], alias: operandsAlias, columns: names }],
				undefined
			)
		)
	}
}
