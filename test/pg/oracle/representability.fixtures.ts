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
import { identifierOf, type KeyImage } from "#compiler/core/identity.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import type { LibraryFn } from "#compiler/ir/physical.ts"
import { wildcardPattern } from "#compiler/ir/scalar.ts"
import { keyImageForm } from "#compiler/lower/conservative/expr/ops.ts"
import { libraryCreate, libraryIdentity } from "#compiler/physical/ddl/library.ts"
import {
	btreeMaxItemSize,
	entryImages,
	keyedField,
	keyLayout
} from "#compiler/schema/representability.ts"
import type { QualifiedFunctionRef } from "#compiler/sql/ast.ts"
import { tableCol } from "#compiler/sql/build.ts"
import { printExpr, printStatement } from "#compiler/sql/print.ts"
import { textDesc } from "#test/support/fixtures/ir/desc.ts"
import { wideOctets, wideText } from "#test/support/wide-text.ts"

/**
 * What a case of the population reached: a key the compiler accepts, one sized within a word of the item limit, and one
 * that holds a field by its image.
 */
export type ReprFeature =
	| "accepted key"
	| "key at the computed maximum"
	| "a field held by its image"

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
	kind: "contract",
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
			return { kind: "pg", type: "bigint" }
		case "int4":
			return { kind: "pg", type: "integer" }
		case "int2":
			return { kind: "pg", type: "smallint" }
		case "bool":
			return { kind: "pg", type: "boolean" }
	}
}

const names = (fields: ReadonlyArray<FieldSketch>): ReadonlyArray<string> =>
	Arr.map(indices(fields.length), (i) => `f${i}`)

export const layoutOf = (fields: ReadonlyArray<FieldSketch>) =>
	keyLayout(Arr.map(fields, (f, i) => ({ field: `f${i}`, desc: descOf(f) })))

/**
 * The image the compiler's key holds each field by, in key order, none for a field it holds as itself: its one rule for
 * a key's entry (schema/representability.ts entryImages over keyedField), which keyLayout counts and the installation
 * installs, each image a law column STORED from the row in its field's place.
 */
export const imagesOf = (fields: ReadonlyArray<FieldSketch>): ReadonlyArray<KeyImage | undefined> =>
	entryImages(
		"key",
		Arr.map(fields, (f) => keyedField(descOf(f)))
	)

/**
 * The key with its first text field at the largest length its key holds it as itself, when it has one and the rest
 * fits: a pattern's length within PostgreSQL's repetition limit, which its pattern `^.{0,n}$` states, a contract's
 * within an index entry. Past that length the key holds the text by its image, whose entry no length moves.
 */
export const filled = (s: KeySketch): ReadonlyArray<FieldSketch> => {
	const firstText = Arr.findFirstIndex(s.fields, (f) => f.kind === "text")
	if (!s.fill || Option.isNone(firstText)) {
		return s.fields
	}
	const first = firstText.value
	const at = (length: number) =>
		Arr.map(s.fields, (f, i) => (i === first && f.kind === "text" ? { ...f, length } : f))
	const asItself = (length: number): boolean =>
		layoutOf(at(length)).ok && imagesOf(at(length))[first] === undefined
	if (!asItself(0)) {
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
		if (asItself(mid)) {
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
			return "bigint"
		case "int4":
			return "integer"
		case "int2":
			return "smallint"
		case "bool":
			return "boolean"
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

/**
 * The statements that install the key over `fields` in `schema` as the compiler holds it (`imagesOf`): its table, each
 * field a column and each image a bytea column STORED from its field by the image's one SQL form
 * (lower/conservative/expr/ops.ts keyImageForm), the primary key over each field or its image in key order, after the
 * library functions those forms call (physical/ddl/library.ts libraryCreate); and the insert of a fact into its fields.
 */
export const keyTable = (
	schema: string,
	fields: ReadonlyArray<FieldSketch>
): { readonly ddl: ReadonlyArray<string>; readonly insert: string } => {
	const columns = names(fields)
	const keyed = Arr.zip(columns, imagesOf(fields))
	const called = new Set<LibraryFn>()
	const library = (fn: LibraryFn): QualifiedFunctionRef => {
		called.add(fn)
		return { kind: "qualified", schema, name: identifierOf(libraryIdentity(fn)) }
	}
	const quoted = (c: string) => `"${c}"`
	const imageColumn = (c: string) => `${c}_image`
	const imageColumns = Arr.flatMap(keyed, ([c, image]) =>
		image === undefined
			? []
			: [
					`${quoted(imageColumn(c))} bytea GENERATED ALWAYS AS (${printExpr(
						keyImageForm(library, image, tableCol(c))
					)}) STORED`
				]
	)
	const table = `"${schema}"."t"`
	const create = `CREATE TABLE ${table} (${Arr.join(
		[
			...Arr.map(Arr.zip(columns, fields), ([c, f]) => `${quoted(c)} ${columnSql(f)} NOT NULL`),
			...imageColumns
		],
		", "
	)}, PRIMARY KEY (${Arr.join(
		Arr.map(keyed, ([c, image]) => quoted(image === undefined ? c : imageColumn(c))),
		", "
	)}))`
	return {
		ddl: [
			`CREATE SCHEMA "${schema}"`,
			...Arr.map([...called], (fn) => printStatement(libraryCreate(schema, fn))),
			create
		],
		insert: `INSERT INTO ${table} (${Arr.join(Arr.map(columns, quoted), ", ")}) VALUES (${Arr.join(
			Arr.map(indices(fields.length), (i) => `$${i + 1}`),
			", "
		)})`
	}
}
