import { Result } from "effect"
import type { IntCarrier } from "#compiler/scalar/compute/cast.ts"
import type { FailureCode } from "#compiler/scalar/compute/registry.ts"
import { gcdBig } from "#test/support/oracle/evaluate/numeric.ts"

/**
 * The oracle's integer arithmetic, as int.c and int8.c compute it.
 *
 * Integer operators are exact and refuse a result outside the type with 22003: sums, differences, products, the
 * negation and absolute value of the minimum, the quotient minimum / -1, and gcd or lcm results past the maximum; a
 * zero divisor is 22012, and minimum % -1 is 0.
 */
export const intRange: { readonly [C in IntCarrier]: readonly [bigint, bigint] } = {
	int2: [-32768n, 32767n],
	int4: [-2147483648n, 2147483647n],
	int8: [-(2n ** 63n), 2n ** 63n - 1n]
}

type IntResult = Result.Result<bigint, FailureCode>

const inIntRange = (value: bigint, c: IntCarrier): IntResult => {
	const [lo, hi] = intRange[c]
	return value < lo || value > hi ? Result.fail("22003") : Result.succeed(value)
}

export const intAdd = (a: bigint, b: bigint, c: IntCarrier): IntResult => inIntRange(a + b, c)

export const intSub = (a: bigint, b: bigint, c: IntCarrier): IntResult => inIntRange(a - b, c)

export const intMul = (a: bigint, b: bigint, c: IntCarrier): IntResult => inIntRange(a * b, c)

export const intDiv = (a: bigint, b: bigint, c: IntCarrier): IntResult =>
	b === 0n ? Result.fail("22012") : inIntRange(a / b, c)

export const intMod = (a: bigint, b: bigint): IntResult =>
	b === 0n ? Result.fail("22012") : Result.succeed(a % b)

export const intNeg = (a: bigint, c: IntCarrier): IntResult => inIntRange(-a, c)

export const intAbs = (a: bigint, c: IntCarrier): IntResult => inIntRange(a < 0n ? -a : a, c)

/** int4gcd and int8gcd: the nonnegative gcd, 22003 when it is the type's minimum's magnitude. */
export const intGcd = (a: bigint, b: bigint, c: IntCarrier): IntResult =>
	inIntRange(gcdBig(a, b), c)

/** int4lcm and int8lcm: zero when either is zero, otherwise |a / gcd(a, b) * b|, refused past the maximum. */
export const intLcm = (a: bigint, b: bigint, c: IntCarrier): IntResult => {
	if (a === 0n || b === 0n) {
		return Result.succeed(0n)
	}
	const g = intGcd(a, b, c)
	if (Result.isFailure(g)) {
		return g
	}
	const product = (a / g.success) * b
	return inIntRange(product < 0n ? -product : product, c)
}
