type Width = "float4" | "float8"

const round = (x: number, width: Width): number => (width === "float4" ? Math.fround(x) : x)

/**
 * The oracle's float4 and float8 arithmetic: IEEE 754's, which grizzle's SQL computes (lower/conservative/expr/total.ts
 * ieeeForm). A finite operation whose result passes the type's range is an infinity, a result past its least magnitude
 * is zero, a quotient by zero is an infinity of the dividend's sign, or NaN over zero or NaN, and the square root of a
 * value below zero is NaN. A float4 operation rounds once to binary32; computing it in binary64 and rounding the result
 * is exact for +, -, * and /, because binary64 holds every exact binary32 sum, difference and product, and double
 * rounding of a binary32 quotient through binary64 is innocuous (53 >= 2 * 24 + 2).
 *
 * pow is not here: dpow calls the platform libm, which V8's Math.pow does not reproduce in the last place, so the
 * oracle leaves it to PostgreSQL (catalog.ts Evaluation). Negation, abs and sign are src's (scalar/compute/float.ts).
 */
const add = (a: number, b: number, width: Width): number => round(a + b, width)

const sub = (a: number, b: number, width: Width): number => round(a - b, width)

const mul = (a: number, b: number, width: Width): number => round(a * b, width)

const div = (a: number, b: number, width: Width): number => round(a / b, width)

/** The IEEE 754 square root: NaN below zero. */
export const floatSqrt = (a: number): number => Math.sqrt(a)

/** The four arithmetic operations, by the operator's name. */
export const floatArithmetic = { add, sub, mul, div } as const
