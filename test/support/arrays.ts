import { Array as Arr, String as Str } from "effect"
import { arrayTexts, parameterNormalizer, type RelationSpec } from "#compiler/codec/recordset.ts"
import { maxStringLength } from "#compiler/core/limits.ts"
import * as Result from "#compiler/core/result.ts"
import type { Param } from "#compiler/core/wire.ts"
import type { RelationParamEncoder } from "#compiler/ir/products.ts"

/**
 * The arrays encoder of one relation parameter's input (ir/products.ts RelationParamEncoder): its normal facts as a
 * relation parameter's (codec/recordset.ts parameterNormalizer), written as its arrays (arrayTexts).
 */
export const arraysEncoder = (spec: RelationSpec): RelationParamEncoder => {
	const normalize = parameterNormalizer(spec)
	const fields = Arr.map(spec.columns, (c) => c.field)
	return (facts) =>
		Result.flatMap(normalize(facts), (normalized) =>
			Result.map(
				arrayTexts(spec.relation, fields, normalized.rows, maxStringLength.value),
				(arrays) => ({
					arrays,
					count: normalized.count
				})
			)
		)
}

/**
 * A one-dimensional text-format array literal read as PostgreSQL's array_in reads it (src/backend/utils/adt/arrayfuncs.c
 * ReadArrayToken), the reference the input arrays' writer (codec/recordset.ts arrayTexts) is checked against: braces
 * around elements separated by commas; a quoted element is its characters with each backslash-escaped character taken
 * as itself, and needs a comma or the closing brace after it, whitespace aside; an unquoted element is its characters
 * with leading and trailing whitespace dropped and backslash escapes taken as quoted ones are, NULL, in any case and
 * unescaped, being no value. A literal that is malformed throws.
 */
export const readArrayLiteral = (literal: string): ReadonlyArray<string | null> => {
	const space = (c: string | undefined): boolean =>
		c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\v" || c === "\f"
	let at = 0
	const skipSpace = (): void => {
		while (space(literal[at])) {
			at += 1
		}
	}
	const fail = (why: string): never => {
		throw new Error(`malformed array literal at ${at}: ${why}`)
	}
	skipSpace()
	if (literal[at] !== "{") {
		fail("no opening brace")
	}
	at += 1
	const out: Array<string | null> = []
	skipSpace()
	if (literal[at] === "}") {
		at += 1
		skipSpace()
		return at === literal.length ? out : fail("text after the closing brace")
	}
	for (;;) {
		skipSpace()
		if (literal[at] === '"') {
			at += 1
			let element = ""
			for (;;) {
				const c = literal[at]
				if (c === undefined) {
					return fail("an unterminated quoted element")
				}
				if (c === "\\") {
					const next = literal[at + 1]
					if (next === undefined) {
						return fail("a backslash at the end")
					}
					element += next
					at += 2
					continue
				}
				if (c === '"') {
					at += 1
					break
				}
				element += c
				at += 1
			}
			out.push(element)
		} else {
			let element = ""
			let escaped = false
			let kept = 0
			for (;;) {
				const c = literal[at]
				if (c === undefined) {
					return fail("an unterminated element")
				}
				if (c === "," || c === "}") {
					break
				}
				if (c === '"' || c === "{") {
					return fail("a quote or brace inside an unquoted element")
				}
				if (c === "\\") {
					const next = literal[at + 1]
					if (next === undefined) {
						return fail("a backslash at the end")
					}
					element += next
					escaped = true
					at += 2
					kept = element.length
					continue
				}
				element += c
				at += 1
				if (!space(c)) {
					kept = element.length
				}
			}
			const trimmed = Str.slice(0, kept)(element)
			if (trimmed === "" && !escaped) {
				return fail("an empty unquoted element")
			}
			out.push(!escaped && Str.toUpperCase(trimmed) === "NULL" ? null : trimmed)
		}
		skipSpace()
		const c = literal[at]
		at += 1
		if (c === "}") {
			skipSpace()
			return at === literal.length ? out : fail("text after the closing brace")
		}
		if (c !== ",") {
			return fail("no comma or closing brace after an element")
		}
	}
}

/** A one-dimensional array in the array binary format: its header's flags, element type and lower bound, and its elements. */
export interface BinaryArray {
	readonly flags: number
	readonly elementType: number
	readonly lowerBound: number
	readonly elements: ReadonlyArray<Uint8Array | null>
}

/**
 * An array in the array binary format read as PostgreSQL's array_recv reads it (src/backend/utils/adt/arrayfuncs.c), the
 * reference the binary arrays' writer (codec/bytea.ts) is checked against: its dimension count, its flags, its element
 * type, then each dimension's length and lower bound, then each element's length and bytes, a length of -1 being NULL.
 * An array of no dimension is empty. One of more than one dimension, of flags other than 0 or 1, or of bytes after its
 * last element throws.
 */
export const readArrayBinary = (bytes: Uint8Array): BinaryArray => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	let at = 0
	const field = (): number => {
		const n = view.getInt32(at)
		at += 4
		return n
	}
	const dimensions = field()
	const flags = field()
	const elementType = field()
	if (flags !== 0 && flags !== 1) {
		throw new Error(`malformed binary array: flags ${flags}`)
	}
	if (dimensions === 0) {
		if (at !== bytes.length) {
			throw new Error("malformed binary array: bytes after an empty array's header")
		}
		return { flags, elementType, lowerBound: 1, elements: [] }
	}
	if (dimensions !== 1) {
		throw new Error(`malformed binary array: ${dimensions} dimensions`)
	}
	const count = field()
	const lowerBound = field()
	const elements: Array<Uint8Array | null> = []
	for (let i = 0; i < count; i += 1) {
		const n = field()
		if (n === -1) {
			elements.push(null)
			continue
		}
		elements.push(bytes.subarray(at, at + n))
		at += n
	}
	if (at !== bytes.length) {
		throw new Error("malformed binary array: bytes after its last element")
	}
	return { flags, elementType, lowerBound, elements }
}

/**
 * The elements of the array a placeholder carries, read as its statement binds it: a text parameter's array literal
 * (readArrayLiteral), or a binary parameter's array (readArrayBinary).
 */
export const paramArrayElements = (param: Param): ReadonlyArray<string | Uint8Array | null> =>
	typeof param === "string" ? readArrayLiteral(param) : readArrayBinary(param).elements
