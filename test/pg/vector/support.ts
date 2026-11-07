import { Array as Arr, Option, pipe, String as Str } from "effect"
import { vectorMaxDimensions } from "#compiler/ir/carriers.ts"

/**
 * The exact decimal text of a binary64 value, every digit of it, so a reader that rounds correctly rounds the value
 * itself and never a shorter text beside it; NaN and the infinities as PostgreSQL spells them.
 */
const exactDecimal = (x: number): string => {
	if (Number.isNaN(x)) {
		return "NaN"
	}
	if (!Number.isFinite(x)) {
		return x > 0 ? "Infinity" : "-Infinity"
	}
	if (x === 0) {
		return Object.is(x, -0) ? "-0" : "0"
	}
	const view = new DataView(new ArrayBuffer(8))
	view.setFloat64(0, x)
	const bits = view.getBigUint64(0)
	const sign = bits >> 63n === 1n ? "-" : ""
	const biased = Number((bits >> 52n) & 0x7ffn)
	const fraction = bits & ((1n << 52n) - 1n)
	const significand = biased === 0 ? fraction : fraction | (1n << 52n)
	const exponent = (biased === 0 ? 1 : biased) - 1075
	if (exponent >= 0) {
		return `${sign}${String(significand << BigInt(exponent))}`
	}
	const places = -exponent
	const digits = pipe(String(significand * 5n ** BigInt(places)), Str.padStart(places + 1, "0"))
	const point = digits.length - places
	return `${sign}${pipe(digits, Str.slice(0, point))}.${pipe(digits, Str.slice(point))}`
}

/** A vector's text of every component's exact decimal. */
export const exactVectorText = (xs: ReadonlyArray<number>): string =>
	`[${Arr.join(Arr.map(xs, exactDecimal), ",")}]`

/** What PostgreSQL answers a vector input: the vector, or the SQLSTATE it refuses it with. */
export type InputVerdict = "admitted" | "22000" | "22003" | "54000"

/**
 * pgvector's vector_in over a text of exact decimals, under the column's dimension count when it has one: it reads the
 * components in order, refusing a component past the storage limit before reading it (54000), one whose binary32
 * rounding overflows (22003) and a non-finite one (22000), a component that underflows reading as zero; then a count
 * other than the column's (22000).
 */
export const vectorInVerdict = (
	xs: ReadonlyArray<number>,
	dimensions: Option.Option<number>
): InputVerdict => {
	for (const [i, x] of xs.entries()) {
		if (i === vectorMaxDimensions.value) {
			return "54000"
		}
		const rounded = Math.fround(x)
		if (Number.isFinite(x) && !Number.isFinite(rounded)) {
			return "22003"
		}
		if (!Number.isFinite(rounded)) {
			return "22000"
		}
	}
	return Option.exists(dimensions, (n) => n !== xs.length) ? "22000" : "admitted"
}

/** The norm of binary32 components summed in binary64, in index order: what the cosine domain bounds. */
export const normOf = (xs: ReadonlyArray<number>): number =>
	Math.sqrt(Arr.reduce(xs, 0, (sum, x) => sum + Math.fround(x) * Math.fround(x)))

/** One unit in the last place of a positive normal double. */
const ulp = (x: number): number => 2 ** (Math.floor(Math.log2(x)) - 52)

/**
 * How far the host norm may lie from vector_norm's: both sum the same n exact double squares (a binary32 square fits
 * a double), in index order on the host and in whatever order pgvector's -fassociative-math build vectorizes, so
 * each sum is within (n - 1) units of 2^-53 of the exact one, relatively; the square root halves that and adds half
 * an ulp on either side. A float32 accumulator or a square taken before widening errs by about 2^-24 per term, far
 * beyond this bound at every dimension count.
 */
export const normTolerance = (dimensions: number, norm: number): number =>
	dimensions * 2 ** -53 * norm + ulp(norm)
