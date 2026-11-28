import { indices } from "@bjornpagen/grizzle-text/base/array"
import { regexMaxRepeat } from "@bjornpagen/grizzle-text/regex/parse"
import {
	array,
	boolean,
	element,
	type Gen,
	int,
	map,
	oneOf,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { wildcardPattern } from "#compiler/ir/scalar.ts"
import { btreeMaxItemSize, keyLayout } from "#compiler/schema/representability.ts"
import { textDesc } from "#test/support/fixtures/ir/desc.ts"
import { wideOctets, wideText } from "#test/support/wide-text.ts"

/** What a case of the population reached: a key the compiler accepts, and one sized within a word of the item limit. */
export type ReprFeature = "accepted key" | "key at the computed maximum"

/** How a text field's length is bounded: by its pattern, or by a contract's charLength or octetLength predicate. */
type TextBound = "pattern" | "charLength" | "octetLength"

export type FieldSketch =
	| { readonly kind: "text"; readonly bound: TextBound; readonly length: number }
	| {
			readonly kind: "numeric"
			readonly precision: number
			readonly scale: number
			readonly align: number
	  }
	| { readonly kind: "uuid" | "int8" | "int4" | "int2" | "bool" }

export interface KeySketch {
	readonly fields: ReadonlyArray<FieldSketch>
	/** Size the first text field to the largest length the compiler accepts beside the others. */
	readonly fill: boolean
	readonly salt: number
}

const fieldGen: Gen<FieldSketch> = weighted<FieldSketch>([
	[
		4,
		oneOf<FieldSketch>([
			(source) => ({
				kind: "text",
				bound: "pattern",
				length: source.draw(int(0, regexMaxRepeat))
			}),
			(source) => ({ kind: "text", bound: "charLength", length: source.draw(int(0, 700)) }),
			(source) => ({ kind: "text", bound: "octetLength", length: source.draw(int(0, 2800)) })
		])
	],
	[
		3,
		(source) => {
			const precision = source.draw(oneOf([int(1, 40), int(1, 1000)]))
			const scale = source.draw(int(0, 1000))
			const align = source.draw(int(0, 3))
			return { kind: "numeric", precision, scale: scale % (precision + 1), align }
		}
	],
	[
		2,
		map(element(["uuid", "int8", "int4", "int2", "bool"] as const), (kind): FieldSketch => ({
			kind
		}))
	]
])

export const keyGen: Gen<KeySketch> = (source) => ({
	fields: source.draw(array(fieldGen, { min: 1, max: 5 })),
	fill: source.draw(boolean),
	salt: source.draw(int(0, 0xffff))
})

/** A contract over the wildcard pattern bounding its value's `measure` at `length`. */
const lengthContract = (measure: "charLength" | "octetLength", length: number): FieldDesc => ({
	kind: "domain",
	name: "Bounded",
	base: textDesc(wildcardPattern.source, wildcardPattern.flags),
	predicate: {
		kind: "compare",
		op: "le",
		left: { kind: "compute", fn: measure, args: [{ kind: "value" }] },
		right: { kind: "literal", value: length }
	},
	facts: []
})

const boundedText = (bound: TextBound, length: number): FieldDesc => {
	switch (bound) {
		case "pattern":
			return textDesc(`^.{0,${length}}$`, "su")
		case "charLength":
		case "octetLength":
			return lengthContract(bound, length)
	}
}

const descOf = (f: FieldSketch): FieldDesc => {
	switch (f.kind) {
		case "text":
			return boundedText(f.bound, f.length)
		case "numeric":
			return { kind: "numeric", precision: f.precision, scale: f.scale }
		case "uuid":
			return { kind: "uuid" }
		case "int8":
			return { kind: "pg", type: "int8" }
		case "int4":
			return { kind: "pg", type: "int4" }
		case "int2":
			return { kind: "pg", type: "int2" }
		case "bool":
			return { kind: "pg", type: "bool" }
	}
}

export const names = (fields: ReadonlyArray<FieldSketch>): ReadonlyArray<string> =>
	Arr.map(indices(fields.length), (i) => `f${i}`)

export const layoutOf = (fields: ReadonlyArray<FieldSketch>) =>
	keyLayout(Arr.map(fields, (f, i) => ({ field: `f${i}`, desc: descOf(f) })))

/**
 * The key with its first text field at the largest accepted length, when it has one and the rest fits: a pattern's
 * length within PostgreSQL's repetition limit, which its pattern `^.{0,n}$` states, a contract's within an index entry.
 */
export const filled = (s: KeySketch): ReadonlyArray<FieldSketch> => {
	const firstText = Arr.findFirstIndex(s.fields, (f) => f.kind === "text")
	if (!s.fill || Option.isNone(firstText)) {
		return s.fields
	}
	const first = firstText.value
	const at = (length: number) =>
		Arr.map(s.fields, (f, i) => (i === first && f.kind === "text" ? { ...f, length } : f))
	if (!layoutOf(at(0)).ok) {
		return s.fields
	}
	const firstField = s.fields[first]
	let lo = 0
	let hi =
		firstField?.kind === "text" && firstField.bound === "pattern"
			? regexMaxRepeat
			: btreeMaxItemSize
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2)
		if (layoutOf(at(mid)).ok) {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	return at(lo)
}

/**
 * The numeric of every digit numeric(p, s) admits, its integer digits shortened by `align` to vary where the
 * base-10000 groups fall, every digit 9 so no group is a stripped zero.
 */
const wideNumeric = (precision: number, scale: number, align: number): string => {
	const integer = Math.max(0, precision - scale - align)
	const whole = integer === 0 ? "0" : Str.repeat(integer)("9")
	return scale === 0 ? whole : `${whole}.${Str.repeat(scale)("9")}`
}

export const columnSql = (f: FieldSketch): string => {
	switch (f.kind) {
		case "text":
			return "text COLLATE pg_c_utf8"
		case "numeric":
			return `numeric(${f.precision}, ${f.scale})`
		case "uuid":
			return "uuid"
		case "int8":
			return "int8"
		case "int4":
			return "int4"
		case "int2":
			return "int2"
		case "bool":
			return "bool"
	}
}

export const widestValue = (f: FieldSketch, salt: number): string => {
	switch (f.kind) {
		case "text":
			return f.bound === "octetLength" ? wideOctets(f.length, salt) : wideText(f.length, salt)
		case "numeric":
			return wideNumeric(f.precision, f.scale, f.align)
		case "uuid":
			return "ffffffff-ffff-ffff-ffff-ffffffffffff"
		case "int8":
			return "9223372036854775807"
		case "int4":
			return "2147483647"
		case "int2":
			return "32767"
		case "bool":
			return "true"
	}
}
