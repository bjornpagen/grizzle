import type { ValueFault } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import { int2Max, int2Min, int4Max, int4Min, int8Max, int8Min } from "#compiler/ir/carriers.ts"

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
	checkNumber(value, int2Min.value, int2Max.value)

/**
 * Integer host values of pg.smallint, pg.integer and pg.bigint.
 *
 * smallint and integer fit exactly in a JavaScript number and travel as one: an integer number in the type's signed
 * range (ir/carriers.ts int2Min through int4Max), -0 as 0. bigint always travels as a JavaScript bigint in the signed 64-bit range; a number is never a bigint
 * value, because the host type is bigint.
 */
export const toInt4 = (value: unknown): Result.Result<number, ValueFault> =>
	checkNumber(value, int4Min.value, int4Max.value)

export const toInt8 = (value: unknown): Result.Result<bigint, ValueFault> => {
	if (typeof value !== "bigint") {
		return Result.err("integerType")
	}
	if (value < int8Min.value || value > int8Max.value) {
		return Result.err("integerRange")
	}
	return Result.ok(value)
}
