import { floatDescriptors, isFloatPrecision, refuseFloat } from "#compiler/scalar/pg.ts"

/**
 * float(p) over a precision known only at run time, as a JavaScript caller passes it to pg.float: the real or double
 * precision descriptor it resolves to (scalar/pg.ts floatDescriptors), or a malformed description.
 */
export const floatOf = (precision: unknown) =>
	isFloatPrecision(precision) ? floatDescriptors[precision] : refuseFloat()
