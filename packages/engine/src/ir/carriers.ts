import * as Result from "@bjornpagen/grizzle-text/base/result"
import { isAsciiDigits } from "@bjornpagen/grizzle-text/text"
import { nominal } from "#compiler/core/brand.ts"
import { type FloatSpecialName, floatSpecialNameOf, int4Max } from "#compiler/core/canonical.ts"
import {
	type Canonicalizable,
	canonicalTag,
	type TaggedValue,
	vectorTag
} from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { NumericTypmod } from "#compiler/ir/scalar.ts"

/**
 * The least smallint.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit a smallint value
 * @scope every smallint value: a column, a parameter, a literal, an endpoint
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/doc/src/sgml/datatype.sgml#L374
 * @quote <entry>-32768 to +32767</entry>
 * @verified 2026-11-20
 */
export const int2Min = -32768

/**
 * The greatest smallint.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit a smallint value
 * @scope every smallint value: a column, a parameter, a literal, an endpoint
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/doc/src/sgml/datatype.sgml#L374
 * @quote <entry>-32768 to +32767</entry>
 * @verified 2026-11-20
 */
export const int2Max = 32767

/**
 * The least integer.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit an integer value
 * @scope every integer value: a column, a parameter, a literal, an endpoint, a span width
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/doc/src/sgml/datatype.sgml#L380
 * @quote <entry>-2147483648 to +2147483647</entry>
 * @verified 2026-11-20
 */
export const int4Min = -2147483648

/**
 * The least bigint, and money's least count of minor units.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit a bigint value
 * @scope every bigint value and every money count of minor units, a row count included
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/doc/src/sgml/datatype.sgml#L386
 * @quote <entry>-9223372036854775808 to +9223372036854775807</entry>
 * @verified 2026-11-20
 */
export const int8Min = -9223372036854775808n

/**
 * The greatest bigint, and money's greatest count of minor units.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit a bigint value
 * @scope every bigint value and every money count of minor units, a row count included
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/doc/src/sgml/datatype.sgml#L386
 * @quote <entry>-9223372036854775808 to +9223372036854775807</entry>
 * @verified 2026-11-20
 */
export const int8Max = 9223372036854775807n

/** The decimal digits of the greatest magnitude in [min, max]: the least d with |x| < 10^d for every x of the range. */
const rangeDigits = (min: bigint, max: bigint): number =>
	Math.max((-min).toString().length, String(max).length)

/**
 * The integer digits of a smallint, |x| < 10^int2Digits.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit decimal digits
 * @scope the integer digits of every smallint value
 * @derivation the decimal length of smallint's greatest magnitude, -int2Min
 * @from {@link int2Min}, {@link int2Max}
 */
const int2Digits = rangeDigits(BigInt(int2Min), BigInt(int2Max))

/**
 * The integer digits of an integer, |x| < 10^int4Digits.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit decimal digits
 * @scope the integer digits of every integer value
 * @derivation the decimal length of integer's greatest magnitude, -int4Min
 * @from {@link int4Min}, {@link int4Max}
 */
export const int4Digits = rangeDigits(BigInt(int4Min), BigInt(int4Max))

/**
 * The integer digits of a bigint, |x| < 10^int8Digits: of a bigint value, of money's count of minor units, and of a
 * count of rows, which PostgreSQL counts in a bigint.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit decimal digits
 * @scope the integer digits of every bigint value, money count and row count
 * @derivation the decimal length of bigint's greatest magnitude, -int8Min
 * @from {@link int8Min}, {@link int8Max}
 */
export const int8Digits = rangeDigits(int8Min, int8Max)

/**
 * Whether a coefficient, a natural, lies below 10^`exponent`: it is 0, or it has at most `exponent` decimal digits, so
 * below 10^0 and below a negative exponent's power, a fraction, only 0 does. Read by its digits, never by the power,
 * which at an exact field's or numeric's bound is a number of 131,072 digits: the wire's per-value hot path
 * (live/wire.ts) and an exact literal's bound (ir/expr.ts literalProblem) alike.
 */
export const belowPowerOfTen = (coefficient: bigint, exponent: number): boolean =>
	coefficient === 0n || (exponent > 0 && coefficient.toString().length <= exponent)

/** The greatest d with 10^d - 1 at most `bound`, a magnitude. */
const exactDigits = (bound: bigint): number => {
	const digits = String(bound).length
	return 10n ** BigInt(digits) - 1n <= bound ? digits : digits - 1
}

/**
 * The decimal digits of the greatest magnitude in [min, max] every integer of that many digits reaches: the greatest d
 * with 10^d - 1 within the range on both sides.
 */
const rangeExactDigits = (min: bigint, max: bigint): number =>
	Math.min(exactDigits(-min), exactDigits(max))

/**
 * The most decimal digits every integer of which is a bigint: an exact integer that many digits long travels as one.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit decimal digits
 * @scope the exact integers SQL computes in bigint rather than numeric
 * @derivation the greatest d with 10^d - 1 within bigint's range on both sides
 * @from {@link int8Min}, {@link int8Max}
 */
export const int8ExactDigits = rangeExactDigits(int8Min, int8Max)

/**
 * pgvector's most dimensions a vector holds: its storage limit, not the HNSW index's 2,000.
 *
 * @limitKind published
 * @owner pgvector 0.8.7
 * @unit dimensions
 * @scope one vector value: a column's typmod, a literal, a parameter
 * @constraint compile-time constant
 * @source https://github.com/pgvector/pgvector/blob/v0.8.7/src/vector.h#L11
 * @quote #define VECTOR_MAX_DIM 16000
 * @verified 2026-11-05
 */
export const vectorMaxDimensions = 16000

declare const canonicalFloat: unique symbol

/**
 * The number of a float literal's `float` arm (ir/expr.ts TypedLiteral): finite and not -0, the numbers JSON writes as
 * themselves. NaN, the infinities and -0 are its `floatSpecial` arm, by the word naming each (core/canonical.ts
 * floatSpecialNames). Minted by floatLiteral alone, which reads the word first.
 */
export type CanonicalFloat = number & { readonly [canonicalFloat]: true }

const mintCanonical = nominal<number, CanonicalFloat>()

/** A float's typed literal: a number no word names as itself, and NaN, an infinity or -0 by the word naming it. */
export const floatLiteral = (
	x: number
):
	| { readonly kind: "float"; readonly value: CanonicalFloat }
	| { readonly kind: "floatSpecial"; readonly value: FloatSpecialName } => {
	const name = floatSpecialNameOf(x)
	return name === undefined
		? { kind: "float", value: mintCanonical(x) }
		: { kind: "floatSpecial", value: name }
}

/**
 * Money and Vector values at the Description boundary and in the IR.
 *
 * A Money literal travels as "~m:<minor units>" and a Vector literal as "~v:[c1,...,cn]", the
 * same extension tags the owned Money and scalar/values' Vector.canonical write, the vector's the one the canonical
 * model writes a host vector's components under (core/canonical.ts vectorTag). A Description holds either as any
 * object implementing the canonical protocol with that tag; the IR holds it parsed, as decimal.ts does for decimals: a
 * money amount as its minor units (MoneyValue), so the owned Money travels through unchanged, and a vector as its
 * components (VectorText), since a Vector is a caller's mutable Float32Array. This module owns only what the boundary
 * needs: the payload grammars and two minimal carriers, MoneyText and VectorText, that a decode parses a payload into.
 * Neither does arithmetic; each spells exactly the payload it was parsed from, so a value survives decode and re-encode
 * exactly.
 *
 * - Money: the canonical decimal integer text of a signed 64-bit count of minor units: an optional '-', digits with no
 *   leading zero, no "-0".
 * - Vector: "[c1,...,cn]" with 1..vectorMaxDimensions components, each the shortest round-trip text of a finite binary32 value read
 *   as a double (String(x), so never "-0": -0 is stored as +0).
 */
export const moneyTag = "m"
export { vectorTag }

/** The integer carriers' ranges as bigints, [least, greatest]: what an exact integer narrowed into one lies within. */
export const integerRanges: {
	readonly [C in "int2" | "int4" | "int8"]: readonly [bigint, bigint]
} = {
	int2: [BigInt(int2Min), BigInt(int2Max)],
	int4: [BigInt(int4Min), BigInt(int4Max)],
	int8: [int8Min, int8Max]
}

/** The integer carriers' integer digits, |x| < 10^digits. */
export const integerDigits: { readonly [C in "int2" | "int4" | "int8"]: number } = {
	int2: int2Digits,
	int4: int4Digits,
	int8: int8Digits
}

/**
 * The hex digits of a uuid text's five groups, 8-4-4-4-12: uuid_out's format (RFC 9562 §4, "the formal definition of
 * the UUID string representation"), which a change would make another format.
 *
 * @formatConstant the widths of uuid_out's five hex groups
 */
export const uuidGroups = [8, 4, 4, 4, 12] as const

/** A group of the hyphenated uuid text, by its position among the five. */
export type UuidGroup = 0 | 1 | 2 | 3 | 4

/** Where a group starts in the hyphenated uuid text: after the groups and hyphens before it. */
export const uuidGroupStart = (group: UuidGroup): number =>
	uuidGroups.slice(0, group).reduce((at, width) => at + width + 1, 0)

/** The hyphens' positions in the uuid text: one after each group but the last. */
export const uuidHyphens: ReadonlySet<number> = new Set(
	[uuidGroupStart(1), uuidGroupStart(2), uuidGroupStart(3), uuidGroupStart(4)].map(
		(start) => start - 1
	)
)

/** The hyphenated uuid text's length: every group's digits and a hyphen between each two. */
export const uuidTextLength =
	uuidGroups.reduce((sum, width) => sum + width, 0) + uuidGroups.length - 1

/** The minor units `text` spells when it is a money amount's canonical text, else undefined. */
const moneyUnits = (text: string): bigint | undefined => {
	const digits = text.startsWith("-") ? text.slice(1) : text
	if (digits.length === 0 || digits.length > int8Digits) {
		return undefined
	}
	if (!isAsciiDigits(digits, 0, digits.length)) {
		return undefined
	}
	if (digits.length > 1 && digits.startsWith("0")) {
		return undefined
	}
	if (digits === "0" && text.length > 1) {
		return undefined
	}
	const value = BigInt(text)
	return value >= int8Min && value <= int8Max ? value : undefined
}

export const isMoneyPayload = (text: string): boolean => moneyUnits(text) !== undefined

/**
 * A money amount parsed: a signed 64-bit count of minor units. The IR holds a money literal as one (ir/expr.ts
 * TypedLiteral): MoneyText, or scalar/values' Money, which has the same count; either spells its canonical text from it.
 */
export type MoneyValue = Canonicalizable & { readonly minorUnits: bigint }

export class MoneyText implements Canonicalizable {
	readonly minorUnits: bigint

	private constructor(minorUnits: bigint) {
		this.minorUnits = minorUnits
		Object.freeze(this)
	}

	/** The amount `text` spells when it is a money amount's canonical text, else undefined. */
	static parse(text: string): MoneyText | undefined {
		const units = moneyUnits(text)
		return units === undefined ? undefined : new MoneyText(units)
	}

	[canonicalTag](): TaggedValue {
		return { tag: moneyTag, payload: this.toString() }
	}

	toString(): string {
		return this.minorUnits.toString()
	}
}

/** The binary32 components `list` spells when it is a vector's canonical text, else undefined. */
const vectorComponents = (list: string): ReadonlyArray<number> | undefined => {
	if (!list.startsWith("[") || !list.endsWith("]")) {
		return undefined
	}
	const texts = list.slice(1, -1).split(",")
	if (texts.length > vectorMaxDimensions) {
		return undefined
	}
	const components: Array<number> = []
	for (const t of texts) {
		const x = Number(t)
		if (!Number.isFinite(x) || Math.fround(x) !== x || String(x) !== t) {
			return undefined
		}
		components.push(x)
	}
	return components
}

export const isVectorPayload = (text: string): boolean => vectorComponents(text) !== undefined

const malformedVector = (): CompileError =>
	malformedDescription(
		SourceLoc("vector literal", []),
		"the canonical text of a Vector: [c1,...,cn] with shortest binary32 components"
	)

/**
 * A vector parsed: 1..vectorMaxDimensions finite binary32 components, -0 held as 0. The IR holds a vector literal as one
 * (ir/expr.ts TypedLiteral); it spells its canonical text from its components.
 */
export class VectorText implements Canonicalizable {
	readonly components: ReadonlyArray<number>

	private constructor(components: ReadonlyArray<number>) {
		this.components = Object.freeze(components)
		Object.freeze(this)
	}

	/** The vector `text` spells when it is a vector's canonical text, else undefined. */
	static parse(text: string): VectorText | undefined {
		const components = vectorComponents(text)
		return components === undefined ? undefined : new VectorText(components)
	}

	/** A vector from its binary32 components, -0 held as 0. */
	static of(components: Float32Array): Result.Result<VectorText, CompileError> {
		const held = Array.from(components, (c) => (c === 0 ? 0 : c))
		return held.length >= 1 &&
			held.length <= vectorMaxDimensions &&
			held.every((c) => Number.isFinite(c))
			? Result.ok(new VectorText(held))
			: Result.err(malformedVector())
	}

	[canonicalTag](): TaggedValue {
		return { tag: vectorTag, payload: this.toString() }
	}

	/** pgvector's input text of the components: "[c1,...,cn]", each the shortest round-trip text, -0 never written. */
	toString(): string {
		return `[${this.components.map(String).join(",")}]`
	}
}

export const moneyMinorUnits = (value: MoneyValue): bigint => value.minorUnits

/**
 * The canonical payload of a vector-tagged value, "[c1,...,cn]": pgvector's input text of the components, -0 never
 * written.
 */
export const vectorPayload = (value: Canonicalizable): string => value[canonicalTag]().payload

/**
 * Whether a numeric typmod's values are integers held as bigints: numeric(p, 0), whose column holds no NaN, which no
 * bigint spells (physical/numeric/storage.ts). A negative scale's values are integers too, but multiples of 10^-s, which
 * no exact integer's wire spelling states (live/wire.ts), so they stay Decimals, NaN among them.
 */
export const isIntegerTypmod = (typmod: NumericTypmod): boolean => typmod.scale === 0
