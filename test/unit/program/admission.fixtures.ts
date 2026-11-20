/** What the property of admission.test.ts reads: its schema, its sites, the inputs each site refuses, and its space. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { Logic, Text } from "#compiler/public/compute.ts"
import { relation } from "#compiler/public/dynamic.ts"
import { bytes, contract, date, Decimal, pg } from "#compiler/public/fields.ts"
import { schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Id } from "#test/support/ids.ts"

/** A text of every value but NUL, which its type's input function refuses before any pattern reads it. */
const anyText = str.regex("^.*$", "su")

/**
 * The fields of the relation every case admits a row of: one at each site a value sits, each integer type, a text, a
 * date, a numeric of a typmod and a bytes value, plainly and under a contract whose predicate the host judges (a refined
 * field, the domain loop's), so a value the input function refuses reaches both the column's type and its domain.
 */
export const cellFields = {
	id: Id,
	i2: pg.smallint,
	i4: pg.integer,
	i8: pg.bigint,
	t: anyText,
	d: date,
	n: pg.numeric(5, 2),
	b: bytes,
	ci4: contract("Slot", pg.integer, (v) => Logic.ge(v, 0)),
	ci8: contract("Tally", pg.bigint, (v) => Logic.ge(v, 0n)),
	ct: contract("Short", anyText, (v) => Logic.le(Text.charLength(v), 8))
} as const

/**
 * The relation over cellFields, by the dynamic door, whose rows are records of any value: a case writes a value its
 * field's type refuses, which no row of a typed relation holds.
 */
export const Cells = relation("Cells", cellFields, ["id"])

export const Admissions = schema("Admissions", [Cells], [])

/** A row of Cells every field of which its type and its domain admit. */
export const admittedRow = {
	id: Id("00000000-0000-4000-8000-000000000001"),
	i2: 1,
	i4: 1,
	i8: 1n,
	t: "a",
	d: "2024-02-29",
	n: Decimal.of("123.45"),
	b: new Uint8Array([1, 2]),
	ci4: 1,
	ci8: 1n,
	ct: "a"
} as const

/** A field of Cells a case writes a value its type refuses into. */
type Cell = keyof typeof cellFields

/** One case: the site, the value written there, and what the value is, as the case prints. */
export interface BadInput {
	readonly site: Cell
	readonly label: string
	readonly value: unknown
}

/**
 * The values each site's type refuses, its input function's every class F7 names: an integer that is none (a fraction,
 * a value of the other integer host) or past its type's range, a text holding NUL, a date no calendar holds, and a
 * numeric past its typmod's scale or its precision, and a bytes value that is no Uint8Array.
 */
const integerOfNumber = (site: Cell, high: number): ReadonlyArray<BadInput> => [
	{ site, label: "a fraction", value: 1.5 },
	{ site, label: "a bigint", value: 1n },
	{ site, label: "one past its range", value: high + 1 },
	{ site, label: "one below its range", value: -high - 2 }
]
const integerOfBigint = (site: Cell): ReadonlyArray<BadInput> => [
	{ site, label: "a fraction", value: 1.5 },
	{ site, label: "a number", value: 1 },
	{ site, label: "one past its range", value: 2n ** 63n },
	{ site, label: "one below its range", value: -(2n ** 63n) - 1n }
]
const textWithNul = (site: Cell): ReadonlyArray<BadInput> => [
	{ site, label: "a NUL", value: "a\u0000b" }
]

const badInputs: Arr.NonEmptyReadonlyArray<BadInput> = [
	{ site: "i2", label: "a fraction", value: 1.5 },
	...Arr.drop(integerOfNumber("i2", 32767), 1),
	...integerOfNumber("i4", 2147483647),
	...integerOfBigint("i8"),
	...textWithNul("t"),
	{ site: "d", label: "February the 30th", value: "2023-02-30" },
	{ site: "d", label: "a thirteenth month", value: "2024-13-01" },
	{ site: "n", label: "past its scale", value: Decimal.of("123.456") },
	{ site: "n", label: "past its precision", value: Decimal.of("12345.6") },
	{ site: "b", label: "a text", value: "AQI=" },
	{ site: "b", label: "an array of numbers", value: [1, 2] },
	...integerOfNumber("ci4", 2147483647),
	...integerOfBigint("ci8"),
	...textWithNul("ct")
]

/** Every bad input at every site, each once. */
export const badInputGen: Gen<BadInput> = (source) => source.draw(element(badInputs))
