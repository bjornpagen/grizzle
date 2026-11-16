import { boundaryDigits, exponentReach, int8ExactDigits } from "@grizzle/limits"
import { roundToFloat } from "#compiler/lower/conservative/expr/total.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { binary, call, cast, gt, lit, types } from "#compiler/sql/build.ts"

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
