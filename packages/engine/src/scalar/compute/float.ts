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

/** The widths a float's IEEE 754 encoding has: a real's binary32 and a double's binary64. */
export type FloatWidth = 32 | 64

/**
 * NaN's one form in a float's identity image (registry.ts floatBitsOf), by its encoding's width: the quiet NaN of sign
 * 0 and no payload, binary32's 0x7fc00000 and binary64's 0x7ff8000000000000, the NaN PostgreSQL's float input reads
 * 'NaN' as and Java's floatToIntBits and doubleToLongBits give every NaN.
 *
 * @formatConstant IEEE 754 binary32 and binary64: the default quiet NaN
 */
export const canonicalNanBits: { readonly [W in FloatWidth]: bigint } = Object.freeze({
	32: 0x7fc0_0000n,
	64: 0x7ff8_0000_0000_0000n
})

/**
 * A float's identity image on the host: the bits of its IEEE 754 encoding of `width`, most significant first, as a
 * signed integer, NaN's canonicalNanBits, as PostgreSQL's floatBits form computes it (registry.ts floatBitsOf): a big-
 * endian DataView of the value's own width, so a real, which the host holds as the double it rounds to exactly, writes
 * its binary32.
 */
export const floatBits = (value: number, width: FloatWidth): bigint => {
	if (Number.isNaN(value)) {
		return canonicalNanBits[width]
	}
	const view = new DataView(new ArrayBuffer(width / 8))
	if (width === 64) {
		view.setFloat64(0, value)
		return view.getBigInt64(0)
	}
	view.setFloat32(0, value)
	return BigInt(view.getInt32(0))
}
