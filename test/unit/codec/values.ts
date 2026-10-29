import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { isVector, type Vector } from "#compiler/scalar/values/vector.ts"

/**
 * The host value classes a ScalarCodec decodes to, admitted by an instanceof check: a codec's decode returns
 * `unknown`, because its result type follows the descriptor it was built from at run time.
 */
const fail = (expected: string, value: unknown): never => {
	throw new Error(`expected a ${expected}, got ${String(value)}`)
}

export const asDecimal = (value: unknown): Decimal =>
	value instanceof Decimal ? value : fail("Decimal", value)

export const asVector = (value: unknown): Vector =>
	isVector(value) ? value : fail("Vector", value)
