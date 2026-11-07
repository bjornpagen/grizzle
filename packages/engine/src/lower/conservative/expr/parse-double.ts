import { derived, type Limit } from "#compiler/core/limits.ts"
import {
	binary64MaxExponent,
	binary64MinExponent,
	binary64Precision,
	int8ExactDigits
} from "#compiler/ir/carriers.ts"
import { roundToFloat } from "#compiler/lower/conservative/expr/total.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { binary, call, cast, gt, lit, types } from "#compiler/sql/build.ts"

const owner = "grizzle's parse of a double's decimal text (lower/conservative/expr/parse-double.ts)"

/**
 * The most significant decimal digits a point at which binary64's rounding changes has: every such point, a midpoint
 * between two neighbouring doubles, the overflow threshold and half the least subnormal, is an odd multiple of
 * 2^(e - p) for some e at least emin, below 2^(e + 1); its digits are the odd multiplier's times 5^(p - e) where e < p,
 * most at e = emin, and at most binary64's integer digits elsewhere. So a decimal cut to this many significant digits,
 * with one nonzero digit after them where it had more, lies on the same side of every such point as the decimal itself,
 * and rounds and compares with the thresholds alike.
 */
const boundaryDigits: Limit = derived({
	owner,
	unit: "decimal digits",
	scope: "the significant digits of a double's text read into the numeric it rounds from",
	from: [binary64Precision, binary64MinExponent],
	derivation:
		"the digits of (2^(p + 1) - 1) * 5^(p - emin), the greatest odd multiplier below 2^(p + 1) times the least weight 2^(emin - p) of a rounding point, written in decimal",
	compute: ([p, emin]) =>
		(((1n << BigInt(p.value + 1)) - 1n) * 5n ** BigInt(p.value - emin.value)).toString().length
})

/**
 * The magnitude a double's text's decimal exponent is clamped to: a decimal 0.d... * 10^e with e above the digits of
 * 2^(emax + 1) is past the overflow threshold, and one with e at most -(p - emin - digits(5^(p - emin)) + 1) is below
 * half the least subnormal, 2^(emin - p) = 5^(p - emin) * 10^(emin - p), so clamping e into [-reach, reach] keeps every
 * decimal on the side of both thresholds it was on, and the numeric read from it within numeric's digits.
 */
const exponentReach: Limit = derived({
	owner,
	unit: "a decimal exponent",
	scope: "the decimal exponent of the numeric a double's text is read into",
	from: [binary64Precision, binary64MinExponent, binary64MaxExponent],
	derivation:
		"max(digits(2^(emax + 1)) + 1, (p - emin) - digits(5^(p - emin)) + 1): past the first every value overflows, at or below the second's negation every value is below half the least subnormal",
	compute: ([p, emin, emax]) =>
		Math.max(
			(1n << BigInt(emax.value + 1)).toString().length + 1,
			p.value - emin.value - (5n ** BigInt(p.value - emin.value)).toString().length + 1
		)
})

const text = (value: string): Expr => lit.text(value, types.text)
const integer = (value: number): Expr => lit.int(value, types.integer)
const bigint = (value: number): Expr => lit.int(value, types.bigint)
const double = (value: number): Expr => lit.float(value, types.double)

const caseWhen = (when: Expr, result: Expr, otherwise: Expr): Expr => ({
	kind: "case",
	operand: undefined,
	whens: [{ when, result }],
	else: otherwise
})

/**
 * A double's parse from its decimal text `x` (scalar/compute/registry.ts textParseDouble), IEEE 754-2019's conversion
 * from decimal character sequences, over a text the lowering proved a member of every double's text (scalar/lexical.ts
 * doubleTextForm), with no regex and nothing that allocates past x's own size. It reads x in two coordinates, a sign and
 * the text past it, so a sign is never a case: the magnitude the signless text names, times -1 for a text of a minus
 * sign, which gives -Infinity, -0 for a negative zero's text, and -0 for a negative one below half the least subnormal.
 *
 * - The signless text `INF` names Infinity and `NaN` NaN, by one CASE over it;
 * - any other is a mantissa and an optional exponent split at `e` or `E`. The mantissa's digits past its leading
 *   zeros, `lead`, and past its trailing zeros too, `digits`, name the value 0.digits * 10^e, e the digits of lead less
 *   the mantissa's fraction digits plus the exponent, the exponent read from at most int8ExactDigits of its significant
 *   digits, so a longer one stays past either threshold;
 * - 0.d * 10^c, d the first boundaryDigits of digits with a 1 after them where digits has more, and c e clamped into
 *   [-exponentReach, exponentReach], is a numeric of at most boundaryDigits + exponentReach + 1 fraction digits, on the
 *   same side of every rounding point as the text's value, which numeric_in reads whatever the text's own length;
 * - roundToFloat rounds it once: an infinity at or past the overflow threshold, zero at or below half the least
 *   subnormal, otherwise float8in's correctly rounded double.
 */
export const parseDoubleForm = (x: Expr): Expr => {
	const signless = call("ltrim", [x, text("+-")])
	const mantissa = call("split_part", [
		call("split_part", [signless, text("e"), integer(1)]),
		text("E"),
		integer(1)
	])
	const exponentText = binary(
		"||",
		call("split_part", [signless, text("e"), integer(2)]),
		call("split_part", [signless, text("E"), integer(2)])
	)
	const fraction = call("split_part", [mantissa, text("."), integer(2)])
	const lead = call("ltrim", [call("replace", [mantissa, text("."), text("")]), text("0")])
	const digits = call("rtrim", [lead, text("0")])
	const exponent = cast(
		binary(
			"||",
			caseWhen(call("starts_with", [exponentText, text("-")]), text("-0"), text("0")),
			call("left", [call("ltrim", [exponentText, text("+-0")]), integer(int8ExactDigits.value)])
		),
		types.bigint
	)
	const decimalExponent = binary(
		"+",
		binary("-", call("char_length", [lead]), call("char_length", [fraction])),
		exponent
	)
	const clamped: Expr = {
		kind: "greatest",
		args: [
			bigint(-exponentReach.value),
			{ kind: "least", args: [bigint(exponentReach.value), decimalExponent] }
		]
	}
	const cut = binary(
		"||",
		call("left", [digits, integer(boundaryDigits.value)]),
		caseWhen(gt(call("char_length", [digits]), integer(boundaryDigits.value)), text("1"), text(""))
	)
	const numeral = cast(
		binary("||", binary("||", binary("||", text("0."), cut), text("e")), cast(clamped, types.text)),
		types.numeric
	)
	const magnitude: Expr = {
		kind: "case",
		operand: signless,
		whens: [
			{ when: text("INF"), result: double(Number.POSITIVE_INFINITY) },
			{ when: text("NaN"), result: double(Number.NaN) }
		],
		else: roundToFloat(numeral, "float8")
	}
	return binary(
		"*",
		magnitude,
		caseWhen(call("starts_with", [x, text("-")]), double(-1), double(1))
	)
}
