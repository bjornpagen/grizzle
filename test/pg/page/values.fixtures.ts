/** What the properties of values.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, pipe, Record as Rec, String as Str } from "effect"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import {
	float8,
	int8,
	numeric,
	resolveStored,
	scalarOfSpec,
	type SpelledValue,
	type ValueSketch
} from "#test/support/oracle/gen/domain.ts"
import { inputText } from "#test/support/oracle/runner.ts"
import { byAmount, byBig, byLabel, byX, byXDesc } from "#test/unit/page/fixtures.ts"

export const id = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

const text: ScalarType = scalarOfSpec({ carrier: "text" })

/** The ordered fields, each with its type in the generator's domain, and every compared field's SQL type. */
const fields = { x: float8, amount: numeric, big: int8, label: text } as const

export type Field = keyof typeof fields

export const sqlTypes = {
	id: "uuid",
	x: "double precision",
	amount: "numeric",
	big: "bigint",
	label: "text"
} as const

type Compared = keyof typeof sqlTypes

export const isCompared = (field: string): field is Compared =>
	Rec.has<string, string>(sqlTypes, field)

export const queries = {
	"x asc": byX,
	"x desc": byXDesc,
	"amount desc, id asc": byAmount,
	"big asc, id desc": byBig,
	"label asc": byLabel
} as const

type Ordered = keyof typeof queries

export const orderedNames: Arr.NonEmptyReadonlyArray<Ordered> = [
	"x asc",
	"x desc",
	"amount desc, id asc",
	"big asc, id desc",
	"label asc"
]

/** The bigints a binary64 cannot hold, among the int8 classes. */
const unsafeBigints = [2n ** 53n + 1n, -(2n ** 53n + 1n)] as const

interface FactSketch {
	readonly x: ValueSketch
	readonly amount: ValueSketch
	readonly big: ValueSketch
	readonly label: ValueSketch
}

const valueSketchGen: Gen<ValueSketch> = (source) => ({
	cls: source.draw(int(0, 63)),
	sp: source.draw(int(0, 7))
})

const factSketchGen: Gen<FactSketch> = (source) => ({
	x: source.draw(valueSketchGen),
	amount: source.draw(valueSketchGen),
	big: source.draw(valueSketchGen),
	label: source.draw(valueSketchGen)
})

interface ValuesCase {
	readonly facts: ReadonlyArray<FactSketch>
	readonly query: Ordered
	readonly forward: number
	readonly backward: number
}

export const valuesCaseGen: Gen<ValuesCase> = (source) => ({
	facts: source.draw(array(factSketchGen, { min: 1, max: 12 })),
	query: source.draw(element(orderedNames)),
	forward: source.draw(int(1, 4)),
	backward: source.draw(int(1, 4))
})

/** Every class, edges included, in every spelling, so a sketch reaches each: a double's -0 is 0's twin spelling. */
const storedOf = (field: Field, sketch: ValueSketch): SpelledValue =>
	resolveStored(fields[field], sketch, true)

/** A fact's stored values, each in its drawn spelling. */
type StoredFact = Readonly<Record<Field, SpelledValue>>

export const storedFact = (f: FactSketch): StoredFact => ({
	x: storedOf("x", f.x),
	amount: storedOf("amount", f.amount),
	big: storedOf("big", f.big),
	label: storedOf("label", f.label)
})

/**
 * A stored value's text as its column's input function reads it: its canonical text, or its twin spelling. No field is
 * a closed id or a set, so no codes spell any.
 */
const storedText = (field: Field, v: SpelledValue): string =>
	v.spelling.kind === "twin" ? v.spelling.text : inputText(v.literal, fields[field], emptyCodebook)

/** A fact's stored texts, as its column's input function reads them. */
export const factTexts = (f: StoredFact): Readonly<Record<Field, string>> => ({
	x: storedText("x", f.x),
	amount: storedText("amount", f.amount),
	big: storedText("big", f.big),
	label: storedText("label", f.label)
})

export type ValuesFeature =
	| `query ${Ordered}`
	| "float -0"
	| "float NaN"
	| "float infinity"
	| "float subnormal"
	| "numeric NaN"
	| "numeric of more than 17 digits"
	| "bigint extreme"
	| "bigint beyond 2^53"
	| "empty text"
	| "text beyond the BMP"
	| "a tie on the leading key"

/**
 * What a case's stored values reach: each field's stored text, an amount's digits those of its value, whatever zeros
 * its spelling pads it with.
 *
 * A code point beyond the BMP is two UTF-16 units.
 */
export const reached = (stored: ReadonlyArray<StoredFact>): ReadonlyArray<ValuesFeature> => {
	const out = new Set<ValuesFeature>()
	for (const v of stored) {
		const f = { ...factTexts(v), amount: inputText(v.amount.literal, fields.amount, emptyCodebook) }
		if (f.x === "-0") {
			out.add("float -0")
		}
		if (f.x === "NaN") {
			out.add("float NaN")
		}
		if (f.x === "Infinity" || f.x === "-Infinity") {
			out.add("float infinity")
		}
		if (f.x === "5e-324") {
			out.add("float subnormal")
		}
		if (f.amount === "NaN") {
			out.add("numeric NaN")
		}
		if (Str.replace(regex("[-.]", "g"), "")(f.amount).length > 17) {
			out.add("numeric of more than 17 digits")
		}
		const big = BigInt(f.big)
		if (big === 2n ** 63n - 1n || big === -(2n ** 63n)) {
			out.add("bigint extreme")
		}
		if (Arr.some(unsafeBigints, (b) => b === big)) {
			out.add("bigint beyond 2^53")
		}
		if (f.label === "") {
			out.add("empty text")
		}
		if (Arr.some(Arr.fromIterable(f.label), (ch) => ch.length > 1)) {
			out.add("text beyond the BMP")
		}
	}
	return [...out]
}
