/**
 * PostgreSQL's total float4 and float8 functions, as src/backend/utils/adt/float.c computes them: the total fragment's
 * negation, abs and sign of a float (total.ts), by the operator's name. Each is exact, so it reproduces PostgreSQL bit
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
