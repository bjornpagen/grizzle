/**
 * The key representability bound against PostgreSQL 19: every key the compiler accepts fits a B-tree index entry,
 * at the computed maximum, with the widest values its fields admit.
 *
 * A key is representable when its fields' worst-case B-tree entry stays within PostgreSQL's 2704-byte item limit
 * (schema/representability.ts keyLayout); a key the compiler accepts must never meet "index row size exceeds btree
 * maximum" (54000) on a lawful fact, or a valid write would fail at run time. The property draws composite keys of
 * bounded text (whose bound is four bytes per code point), numeric(p, s) up to the format's precision, uuid and the
 * fixed-width types, sizes the text to the largest length the compiler still accepts beside the other fields when the
 * case asks for the maximum, and inserts the widest fact: text of distinct 4-byte UTF-8 code points, which no
 * compression shortens, numerics of every digit their typmod admits at each base-10000 alignment, the largest uuid
 * and integers. PostgreSQL must accept every such fact into the key's unique index.
 *
 * Text is bounded in each spelling the compiler accepts: its pattern ^.{0,n}$, n within PostgreSQL's repetition limit
 * (core/limits.ts regexMaxRepeat), a contract's charLength(value) <= n over the wildcard pattern, or a contract's
 * octetLength(value) <= n over it, which bounds the text's bytes exactly and reaches the item limit at the byte. A key's
 * entry is counted at exact offsets through its fixed-width prefix, so a key whose bounded text comes after fixed-width
 * fields alone is sized to the byte PostgreSQL lays out.
 *
 * Oracle: PostgreSQL itself, the B-tree item limit (54000) of the key's unique index.
 *
 * Plants: oracle-representability-utf8-three (the byte bound counts three bytes a code point).
 *
 * Features: a key the compiler accepts, and one sized within a word of the item limit.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, map, oneOf, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { indices } from "#compiler/core/array.ts"
import { regexMaxRepeat } from "#compiler/core/limits.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { wildcardPattern } from "#compiler/ir/scalar.ts"
import { btreeMaxItemSize, keyLayout } from "#compiler/schema/representability.ts"
import { succeeded } from "#test/support/assert.ts"
import { textDesc } from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** What a case of the population reached: a key the compiler accepts, and one sized within a word of the item limit. */
type ReprFeature = "accepted key" | "key at the computed maximum"

/** How a text field's length is bounded: by its pattern, or by a contract's charLength or octetLength predicate. */
type TextBound = "pattern" | "charLength" | "octetLength"

type FieldSketch =
	| { readonly kind: "text"; readonly bound: TextBound; readonly length: number }
	| {
			readonly kind: "numeric"
			readonly precision: number
			readonly scale: number
			readonly align: number
	  }
	| { readonly kind: "uuid" | "int8" | "int4" | "int2" | "bool" }

interface KeySketch {
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
				length: source.draw(int(0, regexMaxRepeat.value))
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

const keyGen: Gen<KeySketch> = (source) => ({
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

const layoutOf = (fields: ReadonlyArray<FieldSketch>) =>
	keyLayout(Arr.map(fields, (f, i) => ({ field: `f${i}`, desc: descOf(f) })))

/**
 * The key with its first text field at the largest accepted length, when it has one and the rest fits: a pattern's
 * length within PostgreSQL's repetition limit, which its pattern `^.{0,n}$` states, a contract's within an index entry.
 */
const filled = (s: KeySketch): ReadonlyArray<FieldSketch> => {
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
			? regexMaxRepeat.value
			: btreeMaxItemSize.value
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
 * A text of exactly `bytes` UTF-8 bytes no compression shortens: distinct supplementary-plane code points (wideText)
 * for every four, then ASCII letters for the rest.
 */
const wideOctets = (bytes: number, salt: number): string =>
	`${wideText(Math.floor(bytes / 4), salt)}${Str.repeat(bytes % 4)("z")}`

/** Distinct supplementary-plane code points, four UTF-8 bytes each, spread so that pglz finds no repeat. */
const wideText = (length: number, salt: number): string => {
	let out = ""
	let x = (salt * 2654435761) >>> 0
	for (let i = 0; i < length; i++) {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0
		out += String.fromCodePoint(0x20000 + ((x >>> 7) % 0x9fff) * 2 + (i % 2))
	}
	return out
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

const columnSql = (f: FieldSketch): string => {
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

const widestValue = (f: FieldSketch, salt: number): string => {
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

const runs = 150

layer(Substrate.layer)("key representability against PostgreSQL's B-tree item limit", (it) => {
	it.effect(
		`accepts the widest fact of each of ${runs} generated keys the compiler accepts`,
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema({ create: false, label: "repr" })
					const session = yield* s.admin.pin
					return yield* explore(
						{
							oracle: {
								kind: "postgresql",
								name: "the B-tree item limit of the key's unique index, 54000"
							},
							suite: "oracle/representability",
							draw: drawn(keyGen),
							literal: Formatter.format,
							coverage: required<ReprFeature>(["accepted key", "key at the computed maximum"], {
								cases: runs,
								sense: notesOnly
							}),
							kept: [],
							runs,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(sketch, k) =>
							Effect.gen(function* () {
								const fields = filled(sketch)
								const layout = layoutOf(fields)
								if (!layout.ok) {
									return
								}
								k.note("accepted key")
								if (
									sketch.fill &&
									Arr.some(fields, (f) => f.kind === "text") &&
									layout.value.btreeBytes > btreeMaxItemSize.value - 8
								) {
									k.note("key at the computed maximum")
								}
								const columns = names(fields)
								const table = `"${schema}"."t"`
								const ddl = `CREATE TABLE ${table} (${Arr.join(
									Arr.map(fields, (f, i) => `"${columns[i]}" ${columnSql(f)} NOT NULL`),
									", "
								)}, PRIMARY KEY (${Arr.join(
									Arr.map(columns, (c) => `"${c}"`),
									", "
								)}))`
								const insert = `INSERT INTO ${table} VALUES (${Arr.join(
									Arr.map(indices(fields.length), (i) => `$${i + 1}`),
									", "
								)})`
								const run = Effect.gen(function* () {
									yield* session.query("BEGIN", [])
									yield* session.query(`CREATE SCHEMA "${schema}"`, [])
									yield* session.query(ddl, [])
									yield* session.query(
										insert,
										Arr.map(fields, (f, i) => widestValue(f, sketch.salt + i))
									)
								}).pipe(Effect.ensuring(Effect.ignore(session.query("ROLLBACK", []))))
								const outcome = yield* Effect.result(run)
								succeeded(
									outcome,
									`the compiler accepts the key (${Arr.join(
										Arr.map(fields, (f) => columnSql(f)),
										", "
									)}) at ${layout.value.btreeBytes} bytes, but PostgreSQL refuses its widest fact\n${ddl}`
								)
							})
					)
				}).pipe(Effect.scoped)
			)
	)
})
