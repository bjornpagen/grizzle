import { Result } from "effect"
import type { FailureCode } from "#compiler/scalar/compute/registry.ts"

type FloatResult = Result.Result<number, FailureCode>

type Width = "float4" | "float8"

const round = (x: number, width: Width): number => (width === "float4" ? Math.fround(x) : x)

const isInf = (x: number): boolean =>
	x === Number.POSITIVE_INFINITY || x === Number.NEGATIVE_INFINITY

/**
 * The oracle's float4 and float8 arithmetic, as src/include/utils/float.h and float.c compute it.
 *
 * PostgreSQL departs from IEEE 754 in what it refuses: a finite operation whose result overflows to an infinity is
 * 22003, a product or quotient of nonzero operands that underflows to zero is 22003, a zero divisor is 22012 unless
 * the dividend is NaN, and a negative square root is 2201F. A float4 operation rounds once to binary32; computing it
 * in binary64 and rounding the result is exact for +, -, * and /, because binary64 holds every exact binary32 sum,
 * difference and product, and double rounding of a binary32 quotient through binary64 is innocuous (53 >= 2 * 24 + 2).
 *
 * These are exactly the float operations the oracle evaluates: each is IEEE 754 exact, so it reproduces PostgreSQL bit
 * for bit. pow is not here: dpow calls the platform libm, which V8's Math.pow does not reproduce in the last place,
 * so the oracle leaves it to PostgreSQL (catalog.ts Evaluation). Negation, abs and sign are the total fragment's,
 * src's (scalar/compute/float.ts).
 *
 * float8_pl / float4_pl and the minus forms: overflow only.
 */
const add = (a: number, b: number, width: Width): FloatResult => {
	const r = round(a + b, width)
	return isInf(r) && !isInf(a) && !isInf(b) ? Result.fail("22003") : Result.succeed(r)
}

const sub = (a: number, b: number, width: Width): FloatResult => {
	const r = round(a - b, width)
	return isInf(r) && !isInf(a) && !isInf(b) ? Result.fail("22003") : Result.succeed(r)
}

/** float8_mul: overflow, and underflow of a product of nonzero operands. */
const mul = (a: number, b: number, width: Width): FloatResult => {
	const r = round(a * b, width)
	if (isInf(r) && !isInf(a) && !isInf(b)) {
		return Result.fail("22003")
	}
	if (r === 0 && a !== 0 && b !== 0) {
		return Result.fail("22003")
	}
	return Result.succeed(r)
}

/**
 * float8_div: a zero divisor unless the dividend is NaN; overflow; underflow of a nonzero dividend over a finite
 * divisor.
 */
const div = (a: number, b: number, width: Width): FloatResult => {
	if (b === 0 && !Number.isNaN(a)) {
		return Result.fail("22012")
	}
	const r = round(a / b, width)
	if (isInf(r) && !isInf(a)) {
		return Result.fail("22003")
	}
	if (r === 0 && a !== 0 && !isInf(b)) {
		return Result.fail("22003")
	}
	return Result.succeed(r)
}

/** dsqrt: 2201F below zero; sqrt(-0) is -0. */
export const floatSqrt = (a: number): FloatResult =>
	a < 0 ? Result.fail("2201F") : Result.succeed(Math.sqrt(a))

/** The four arithmetic operations, by the operator's name. */
export const floatArithmetic = { add, sub, mul, div } as const
