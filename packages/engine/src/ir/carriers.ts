import type { Limit } from "@bjornpagen/limit"
import {
	int2Digits,
	int2Max,
	int2Min,
	int4Digits,
	int4Max,
	int4Min,
	int8Digits,
	int8Max,
	int8Min,
	vectorMaxDimensions
} from "@grizzle/limits"
import { nominal } from "#compiler/core/brand.ts"
import {
	type Canonicalizable,
	canonicalTag,
	type TaggedValue,
	vectorTag
} from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"

declare const canonicalFloat: unique symbol

/**
 * A float with the one zero: any number but -0. canonicalZero is its one mint; the IR's float literal holds one
 * (ir/expr.ts TypedLiteral), and scalar/values/float.ts re-exports both.
 */
export type CanonicalFloat = number & { readonly [canonicalFloat]: true }

const mintCanonical = nominal<number, CanonicalFloat>()

/** One spelling of zero: -0 as +0, every other number as it is. */
export const canonicalZero = (x: number): CanonicalFloat => mintCanonical(x === 0 ? 0 : x)

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
	int2: [BigInt(int2Min.value), BigInt(int2Max.value)],
	int4: [BigInt(int4Min.value), BigInt(int4Max.value)],
	int8: [int8Min.value, int8Max.value]
}

/** The integer carriers' integer digits, |x| < 10^digits. */
export const integerDigits: { readonly [C in "int2" | "int4" | "int8"]: Limit } = {
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
	if (digits.length === 0 || digits.length > int8Digits.value) {
		return undefined
	}
	for (let i = 0; i < digits.length; i++) {
		const code = digits.charCodeAt(i)
		if (code < 0x30 || code > 0x39) {
			return undefined
		}
	}
	if (digits.length > 1 && digits.startsWith("0")) {
		return undefined
	}
	if (digits === "0" && text.length > 1) {
		return undefined
	}
	const value = BigInt(text)
	return value >= int8Min.value && value <= int8Max.value ? value : undefined
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
	if (texts.length > vectorMaxDimensions.value) {
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
			held.length <= vectorMaxDimensions.value &&
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
