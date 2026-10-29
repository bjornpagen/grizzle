import { canonicalZero } from "#compiler/scalar/values/float.ts"

/**
 * The text form of pg.real, pg["double precision"] and vector components.
 *
 * A double precision value travels as its shortest round-trip decimal (JavaScript's number text), which PostgreSQL's
 * float8in (strtod) reads back as exactly the same binary64 value. A real value is binary32-exact on the host
 * (values/float.ts toReal), so the shortest round-trip text of that value read as a double names it exactly; float4in
 * and pgvector's vector_in (strtof) read the text as exactly the binary32 value, never double-rounding a float32
 * midpoint. NaN, Infinity and -Infinity are written as those words, and -0 is never written, because the host carriers
 * hold one zero. Reading PostgreSQL's float output is values/float.ts's (convertDouble, convertReal, convertComponent).
 *
 * The text form of a float value the carriers admitted: NaN, Infinity, -Infinity, or the shortest round-trip decimal.
 */
export const floatText = (x: number): string => {
	if (Number.isNaN(x)) {
		return "NaN"
	}
	if (x === Number.POSITIVE_INFINITY) {
		return "Infinity"
	}
	if (x === Number.NEGATIVE_INFINITY) {
		return "-Infinity"
	}
	return String(canonicalZero(x))
}
