import type { ValueFault } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"

export const int2Min = -32768
export const int2Max = 32767
export const int4Min = -2147483648
export const int4Max = 2147483647
export const int8Min = -(2n ** 63n)
export const int8Max = 2n ** 63n - 1n

const checkNumber = (
	value: unknown,
	min: number,
	max: number
): Result.Result<number, ValueFault> => {
	if (typeof value !== "number" || !Number.isInteger(value)) {
		return Result.err("integerType")
	}
	if (value < min || value > max) {
		return Result.err("integerRange")
	}
	return Result.ok(value === 0 ? 0 : value)
}

export const toInt2 = (value: unknown): Result.Result<number, ValueFault> =>
	checkNumber(value, int2Min, int2Max)

/**
 * Integer host values of pg.smallint, pg.integer and pg.bigint.
 *
 * smallint and integer fit exactly in a JavaScript number and travel as one: an integer number in the type's signed
 * range, -0 as 0. bigint always travels as a JavaScript bigint in the signed 64-bit range; a number is never a bigint
 * value, because the host type is bigint.
 */
export const toInt4 = (value: unknown): Result.Result<number, ValueFault> =>
	checkNumber(value, int4Min, int4Max)

export const toInt8 = (value: unknown): Result.Result<bigint, ValueFault> => {
	if (typeof value !== "bigint") {
		return Result.err("integerType")
	}
	if (value < int8Min || value > int8Max) {
		return Result.err("integerRange")
	}
	return Result.ok(value)
}
