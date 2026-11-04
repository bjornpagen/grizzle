import { Result } from "effect"
import type { IntCarrier } from "#compiler/scalar/compute/cast.ts"
import type { Undefined } from "#compiler/scalar/compute/registry.ts"
import { gcdBig } from "#test/support/oracle/evaluate/numeric.ts"

/**
 * The oracle's integer arithmetic: exact, as grizzle's SQL computes it over the exact integers (an exact integer, SQL
 * numeric at scale 0). No sum, difference, product, negation, absolute value, quotient, gcd or lcm leaves the
 * integers, so none refuses a value; a quotient or remainder by zero is undefined ("nonzero"), which no admitted
 * expression meets, since its divisor is proved nonzero. Division truncates toward zero, and the remainder has the
 * dividend's sign.
 */
export const intRange: { readonly [C in IntCarrier]: readonly [bigint, bigint] } = {
	int2: [-32768n, 32767n],
	int4: [-2147483648n, 2147483647n],
	int8: [-(2n ** 63n), 2n ** 63n - 1n]
}

type IntResult = Result.Result<bigint, Undefined>

export const intAdd = (a: bigint, b: bigint): bigint => a + b

export const intSub = (a: bigint, b: bigint): bigint => a - b

export const intMul = (a: bigint, b: bigint): bigint => a * b

export const intDiv = (a: bigint, b: bigint): IntResult =>
	b === 0n ? Result.fail("nonzero") : Result.succeed(a / b)

export const intMod = (a: bigint, b: bigint): IntResult =>
	b === 0n ? Result.fail("nonzero") : Result.succeed(a % b)

export const intNeg = (a: bigint): bigint => -a

export const intAbs = (a: bigint): bigint => (a < 0n ? -a : a)

/** The nonnegative gcd. */
export const intGcd = (a: bigint, b: bigint): bigint => gcdBig(a, b)

/** Zero when either is zero, otherwise |a / gcd(a, b) * b|. */
export const intLcm = (a: bigint, b: bigint): bigint => {
	if (a === 0n || b === 0n) {
		return 0n
	}
	const product = (a / intGcd(a, b)) * b
	return product < 0n ? -product : product
}
