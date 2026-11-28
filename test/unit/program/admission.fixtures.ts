/** What the property of admission.test.ts reads: its schema, its sites, the inputs each site refuses, and its space. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { Logic, Text } from "#compiler/public/compute.ts"
import { relation } from "#compiler/public/dynamic.ts"
import {
	bytea,
	contract,
	date,
	Numeric,
	int2,
	int4,
	int8,
	numeric
} from "#compiler/public/fields.ts"
import { schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Id, toId } from "#test/support/ids.ts"

/** A text of every value but NUL, which its type's input function refuses before any pattern reads it. */
const anyText = str.regex("^.*$", "su")

const shortKey = Symbol("Short")
const slotKey = Symbol("Slot")
const tallyKey = Symbol("Tally")
/**
 * The fields of the relation every case admits a row of: one at each site a value sits, each integer type, a text, a
 * date, a numeric of a typmod and a bytes value, plainly and under a contract whose predicate the host judges (a refined
 * field, the domain loop's), so a value the input function refuses reaches both the column's type and its domain.
 */
export const cellFields = {
	id: Id,
	i2: int2,
	i4: int4,
	i8: int8,
	t: anyText,
	d: date,
	n: numeric(5, 2),
	b: bytea,
	ci4: contract<typeof slotKey>()("Slot", int4, (v) => Logic.ge(v, 0)),
	ci8: contract<typeof tallyKey>()("Tally", int8, (v) => Logic.ge(v, 0n)),
	ct: contract<typeof shortKey>()("Short", anyText, (v) => Logic.le(Text.charLength(v), 8))
} as const

/**
 * The relation over cellFields, by the dynamic door, whose rows are records of any value: a case writes a value its
 * field's type refuses, which no row of a typed relation holds.
 */
export const Cells = relation("Cells", cellFields, ["id"])

export const Admissions = schema("Admissions", [Cells], [])

/** A row of Cells every field of which its type and its domain admit. */
export const admittedRow = {
	id: toId("00000000-0000-4000-8000-000000000001"),
	i2: 1,
	i4: 1,
	i8: 1n,
	t: "a",
	d: "2024-02-29",
	n: Numeric.of("123.45"),
	b: new Uint8Array([1, 2]),
	ci4: 1,
	ci8: 1n,
	ct: "a"
} as const

/** A field of Cells a case writes a value its type refuses into. */
type Cell = keyof typeof cellFields

/**
 * What a case's row holds at its site: a value written there, or no field at all, as a write's fact holds none of the
 * fields grizzle draws or the call computes (pantry's import rows of Node, which state no `start`).
 */
export type SiteInput =
	| { readonly kind: "stated"; readonly value: unknown }
	| { readonly kind: "absent" }

/** One case: the site, what the row holds there, and what that is, as the case prints. */
export interface BadInput {
	readonly site: Cell
	readonly label: string
	readonly input: SiteInput
}

/** A value written at a site. */
const stated = (value: unknown): SiteInput => ({ kind: "stated", value })

/** A row of Cells, every field of admittedRow but `site`, which holds what `input` says. */
export const rowWith = (site: Cell, input: SiteInput): Readonly<Record<string, unknown>> =>
	input.kind === "absent" ? Rec.remove(admittedRow, site) : { ...admittedRow, [site]: input.value }

/** A fact of the site's field alone, holding what `input` says: a write's fact of it, its oracle. */
export const factWith = (site: Cell, input: SiteInput): Readonly<Record<string, unknown>> =>
	input.kind === "absent" ? {} : { [site]: input.value }

/**
 * The values each site's type refuses, its input function's every class F7 names: an integer that is none (a fraction,
 * a value of the other integer host) or past its type's range, a text holding NUL, a date no calendar holds, and a
 * numeric past its typmod's scale or its precision, and a bytes value that is no Uint8Array; and at every site a field
 * that holds no value, NULL or undefined, and a row that lacks the field, as a write's fact refuses each.
 */
const integerOfNumber = (site: Cell, high: number): ReadonlyArray<BadInput> => [
	{ site, label: "a fraction", input: stated(1.5) },
	{ site, label: "a bigint", input: stated(1n) },
	{ site, label: "one past its range", input: stated(high + 1) },
	{ site, label: "one below its range", input: stated(-high - 2) }
]
const integerOfBigint = (site: Cell): ReadonlyArray<BadInput> => [
	{ site, label: "a fraction", input: stated(1.5) },
	{ site, label: "a number", input: stated(1) },
	{ site, label: "one past its range", input: stated(2n ** 63n) },
	{ site, label: "one below its range", input: stated(-(2n ** 63n) - 1n) }
]
const textWithNul = (site: Cell): ReadonlyArray<BadInput> => [
	{ site, label: "a NUL", input: stated("a\u0000b") }
]
const noValue = (site: Cell): ReadonlyArray<BadInput> => [
	{ site, label: "NULL", input: stated(null) },
	{ site, label: "undefined", input: stated(undefined) },
	{ site, label: "no such field", input: { kind: "absent" } }
]

const badInputs: Arr.NonEmptyReadonlyArray<BadInput> = [
	{ site: "i2", label: "a fraction", input: stated(1.5) },
	...Arr.drop(integerOfNumber("i2", 32767), 1),
	...integerOfNumber("i4", 2147483647),
	...integerOfBigint("i8"),
	...textWithNul("t"),
	{ site: "d", label: "February the 30th", input: stated("2023-02-30") },
	{ site: "d", label: "a thirteenth month", input: stated("2024-13-01") },
	{ site: "n", label: "past its scale", input: stated(Numeric.of("123.456")) },
	{ site: "n", label: "past its precision", input: stated(Numeric.of("12345.6")) },
	{ site: "b", label: "a text", input: stated("AQI=") },
	{ site: "b", label: "an array of numbers", input: stated([1, 2]) },
	...integerOfNumber("ci4", 2147483647),
	...integerOfBigint("ci8"),
	...textWithNul("ct"),
	...Arr.flatMap(Rec.keys(cellFields), noValue)
]

/** Every bad input at every site, each once. */
export const badInputGen: Gen<BadInput> = (source) => source.draw(element(badInputs))
