/**
 * PostgreSQL's float4 and float8 negation, abs and sign, as src/backend/utils/adt/float.c computes them, by the
 * operator's name. Each is exact, so it reproduces PostgreSQL bit
 * for bit: signed zero is kept (`-(0)` is -0), and sign(NaN) is 0, as dsign computes it.
 */
export const totalFloat = {
	/** float8um: plain negation, -0 included. */
	neg: (a: number): number => -a,
	/** float8abs: fabs. */
	abs: (a: number): number => Math.abs(a),
	/** dsign: 1, -1, or 0, with 0 for zero and for NaN. */
	sign: (a: number): number => (a > 0 ? 1 : a < 0 ? -1 : 0)
} as const

/**
 * NaN's one form in a float's identity image (registry.ts floatBitsOf): the quiet NaN of sign 0 and no payload,
 * binary64's 0x7ff8000000000000, the NaN PostgreSQL's float input reads 'NaN' as and Java's doubleToLongBits gives
 * every NaN.
 *
 * @formatConstant IEEE 754 binary64: the default quiet NaN
 */
export const canonicalNanBits = 0x7ff8_0000_0000_0000n

/**
 * A float's identity image, the one implementation the host reads (scalar/compute/evaluate.ts) and exports for an
 * application's own code, which states a key over a float's identity as a field this computes: the bits of the value's
 * IEEE 754 binary64 encoding, float8send's 8 bytes, read as a signed big-endian 64-bit integer, NaN's canonicalNanBits,
 * as PostgreSQL's floatBits form computes it (registry.ts floatBitsOf). A real is the double it widens to exactly, which
 * is the number the host holds for it. Two floats have one image exactly when they are one value: -0 and 0 differ,
 * every NaN is one, and each infinity and subnormal its own.
 */
export const floatBits = (value: number): bigint => {
	if (Number.isNaN(value)) {
		return canonicalNanBits
	}
	const view = new DataView(new ArrayBuffer(8))
	view.setFloat64(0, value)
	return view.getBigInt64(0)
}
