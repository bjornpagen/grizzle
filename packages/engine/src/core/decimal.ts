/**
 * A finite numeric value in its one form: (-1)^negative · coefficient · 10^-minScale, where minScale is the least
 * scale that writes the value exactly (PostgreSQL's min_scale).
 */
export interface FiniteParts {
	readonly kind: "finite"
	/** False for zero: numeric has no signed zero. */
	readonly negative: boolean
	/** Not a multiple of 10 when minScale > 0; 0n only at minScale 0. */
	readonly coefficient: bigint
	/** 0..numericMaxFractionDigits (ir/scalar.ts), NUMERIC_DSCALE_MAX: the most fraction digits a numeric value has. */
	readonly minScale: number
}

/** A numeric value: NaN, an infinity, or a finite value in its one form. */
export type DecimalParts =
	| FiniteParts
	| { readonly kind: "nan" }
	| { readonly kind: "infinity" }
	| { readonly kind: "-infinity" }

export const nanParts: DecimalParts = Object.freeze({ kind: "nan" })
export const infinityParts: DecimalParts = Object.freeze({ kind: "infinity" })
export const negativeInfinityParts: DecimalParts = Object.freeze({ kind: "-infinity" })

/**
 * The exact value units · 10^-scale in its one form, `scale` a nonnegative integer: the trailing zeros of the units
 * past the point are divided away.
 */
export const exactParts = (units: bigint, scale: number): FiniteParts => {
	const negative = units < 0n
	let coefficient = negative ? -units : units
	let minScale = coefficient === 0n ? 0 : scale
	while (minScale > 0 && coefficient % 10n === 0n) {
		coefficient /= 10n
		minScale -= 1
	}
	return Object.freeze({ kind: "finite", negative, coefficient, minScale })
}

/**
 * The text of a finite value in its one form, PostgreSQL's numeric_out of trim_scale(value): `digits` are the
 * coefficient's decimal digits, written with minScale fractional digits and no exponent.
 */
export const finiteDigitsText = (negative: boolean, digits: string, minScale: number): string => {
	const sign = negative ? "-" : ""
	if (minScale === 0) {
		return sign + digits
	}
	const padded = digits.padStart(minScale + 1, "0")
	const point = padded.length - minScale
	return `${sign}${padded.slice(0, point)}.${padded.slice(point)}`
}

/** A value's one text: NaN, Infinity, -Infinity, or its finite digits with no exponent (finiteDigitsText). */
export const partsText = (parts: DecimalParts): string => {
	switch (parts.kind) {
		case "nan":
			return "NaN"
		case "infinity":
			return "Infinity"
		case "-infinity":
			return "-Infinity"
		case "finite":
			return finiteDigitsText(parts.negative, parts.coefficient.toString(), parts.minScale)
	}
}
