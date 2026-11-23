import { catchSignal } from "@bjornpagen/grizzle-text/base/result"
/**
 * Shared spaces and oracles of the chunk properties (grizzle-text chunks.ts): drawn JSON texts in every spelling JSON
 * allows, drawn SQL texts of the forms the marker and statement scanners read, any cut of a text into strings, and the
 * whole-text oracles each reader is held to (JSON.parse, a byte comparison of whole arrays, the string's own methods).
 */
import { assert } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	element,
	type Gen,
	int,
	oneOf,
	recursive,
	unicodeScalar,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, Record as Rec, String as Str } from "effect"
import { trusted, trustedJson } from "#compiler/core/trusted.ts"

/** JSON's whitespace between tokens. */
const spaceGen: Gen<string> = weighted([
	[4, element([""])],
	[1, element([" ", "\n", "\t", "\r", " \n\t "])]
])

/** A string literal's one character, as JSON spells it: plain, by a one-character escape, or by a \u escape. */
const literalCharGen: Gen<string> = weighted([
	[
		6,
		(source) => {
			const c = source.draw(unicodeScalar)
			const unit = Option.getOrElse(Str.charCodeAt(c, 0), () => 0)
			return c === '"' || c === "\\" || unit < 0x20 ? `\\u${hex4(unit)}` : c
		}
	],
	[2, element(["a", "~", "é", "€", "😀", "𝄞"])],
	[2, element(['\\"', "\\\\", "\\/", "\\b", "\\f", "\\n", "\\r", "\\t"])],
	[
		2,
		(source) => {
			const unit = source.draw(oneOf([int(0, 0x7f), int(0xd800, 0xdfff), int(0, 0xffff)]))
			const text = hex4(unit)
			return `\\u${source.draw(boolean) ? Str.toUpperCase(text) : text}`
		}
	]
])

/** Four hex digits of a code unit. */
const hex4 = (unit: number): string => Str.padStart(4, "0")(unit.toString(16))

const stringGen: Gen<string> = (source) =>
	`"${Arr.join(source.draw(array(literalCharGen, { min: 0, max: 8 })), "")}"`

/** Digits as text. */
const digitsOf = (digits: ReadonlyArray<number>): string => Arr.join(Arr.map(digits, String), "")

/** A number as JSON spells it: a sign, an integer part, a fraction and an exponent, each drawn. */
const numberGen: Gen<string> = (source) => {
	const sign = source.draw(boolean) ? "-" : ""
	const integer = source.draw(
		weighted([
			[2, element(["0"])],
			[
				3,
				(s) => String(s.draw(int(1, 9))) + digitsOf(s.draw(array(int(0, 9), { min: 0, max: 20 })))
			]
		])
	)
	const fraction = source.draw(boolean)
		? `.${digitsOf(source.draw(array(int(0, 9), { min: 1, max: 20 })))}`
		: ""
	const exponent = source.draw(boolean)
		? `${source.draw(element(["e", "E"]))}${source.draw(element(["", "+", "-"]))}${source.draw(int(0, 400))}`
		: ""
	return `${sign}${integer}${fraction}${exponent}`
}

/** A member's key: from few spellings, so keys repeat, `__proto__` and integer-like keys among them. */
const keyGen: Gen<string> = weighted([
	[4, element(['"a"', '"b"', '"__proto__"', '"0"', '"10"', '"constructor"', '"a\\u0062"'])],
	[1, stringGen]
])

const scalarGen: Gen<string> = oneOf([element(["null", "true", "false"]), numberGen, stringGen])

/** A JSON text's value, nested a few levels, its tokens spaced as drawn. */
const valueGen: Gen<string> = recursive(
	scalarGen,
	(inner) =>
		oneOf([
			(source) => {
				const items = source.draw(array(inner, { min: 0, max: 4 }))
				const s = () => source.draw(spaceGen)
				return `[${s()}${Arr.join(items, `${s()},${s()}`)}${s()}]`
			},
			(source) => {
				const members = source.draw(
					array((s) => `${s.draw(keyGen)}${s.draw(spaceGen)}:${s.draw(spaceGen)}${s.draw(inner)}`, {
						min: 0,
						max: 4
					})
				)
				const s = () => source.draw(spaceGen)
				return `{${s()}${Arr.join(members, `${s()},${s()}`)}${s()}}`
			}
		]),
	4
)

/** How a drawn JSON text is made: as drawn, nested deeper than any call stack holds, or with one character changed. */
export type JsonForm =
	| { readonly kind: "drawn" }
	| { readonly kind: "deep"; readonly depth: number }
	| {
			readonly kind: "edited"
			readonly at: number
			readonly insert: string
			readonly removes: boolean
	  }

/** A drawn JSON text, or a near miss, and the cuts it is read through. */
export interface JsonCase {
	readonly text: string
	readonly form: JsonForm
	readonly cuts: ReadonlyArray<number>
}

/** Cut positions in a text of `length` units: any unit boundary, inside a pair, an escape or a number. */
export const cutsGen =
	(length: number): Gen<ReadonlyArray<number>> =>
	(source) =>
		source.draw(array(int(0, length), { min: 0, max: 12 }))

/**
 * The text cut at `cuts`, in any order (a caller may reduce drawn cuts into a text's length, which orders them anew), as
 * strings in the text's order, empty ones among them where two cuts meet.
 */
export const cutAt = (text: string, cuts: ReadonlyArray<number>): ReadonlyArray<string> => {
	const out: Array<string> = []
	let from = 0
	for (const cut of Arr.sort(cuts, Order.Number)) {
		out.push(Str.slice(from, cut)(text))
		from = cut
	}
	out.push(Str.slice(from)(text))
	return out
}

export const jsonCaseGen: Gen<JsonCase> = (source) => {
	const space = () => source.draw(spaceGen)
	const form = source.draw(
		weighted<JsonForm>([
			[6, element([{ kind: "drawn" } as const])],
			[1, (s) => ({ kind: "deep", depth: s.draw(int(1, 20_000)) })],
			[
				2,
				(s) => ({
					kind: "edited",
					at: s.draw(int(0, 1_000_000)),
					insert: s.draw(
						element(["", ",", "}", "]", '"', "\\", "0", "-", "e", ":", " ", "\u0001"])
					),
					removes: s.draw(boolean)
				})
			]
		])
	)
	const drawn = `${space()}${source.draw(valueGen)}${space()}`
	const text = ((): string => {
		switch (form.kind) {
			case "drawn":
				return drawn
			case "deep":
				return `${Str.repeat(form.depth)('{"a":[')}${drawn}${Str.repeat(form.depth)("]}")}`
			case "edited": {
				const at = form.at % (drawn.length + 1)
				return `${Str.slice(0, at)(drawn)}${form.insert}${Str.slice(form.removes ? at + 1 : at)(drawn)}`
			}
		}
	})()
	return { text, form, cuts: source.draw(cutsGen(text.length)) }
}

/** JSON.parse's value of `text` (core/trusted.ts trustedJson, its door), or none where it refuses it. */
const parsed = (
	text: string
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } => {
	const read = catchSignal(SyntaxError, () => trustedJson<unknown>(text))
	return read.ok ? { ok: true, value: read.value } : { ok: false }
}

/** A record's own keys, in its order. */
const keysOf = (record: object): ReadonlyArray<string> =>
	Rec.keys(trusted<Readonly<Record<string, unknown>>>(record))

/**
 * Whether two values read from JSON are one value: lists item for item, records member for member in the same key
 * order, each scalar the same by Object.is, so -0 is not 0. A container is walked on a stack, so no depth reaches the
 * call stack.
 */
const sameJson = (a: unknown, b: unknown): boolean => {
	const pairs: Array<readonly [unknown, unknown]> = [[a, b]]
	for (let pair = pairs.pop(); pair !== undefined; pair = pairs.pop()) {
		const [x, y] = pair
		if (Arr.isArray(x) || Arr.isArray(y)) {
			if (!Arr.isArray(x) || !Arr.isArray(y) || x.length !== y.length) {
				return false
			}
			for (let i = 0; i < x.length; i++) {
				pairs.push([x[i], y[i]])
			}
			continue
		}
		if (typeof x === "object" && x !== null && typeof y === "object" && y !== null) {
			const xs = keysOf(x)
			const ys = keysOf(y)
			if (xs.length !== ys.length || Arr.some(xs, (k, i) => k !== ys[i])) {
				return false
			}
			for (const k of xs) {
				pairs.push([Reflect.get(x, k), Reflect.get(y, k)])
			}
			continue
		}
		if (!Object.is(x, y)) {
			return false
		}
	}
	return true
}

/** Asserts a reader's value of a JSON text is JSON.parse's, or that both refuse it. */
export const agreesWithParse = (
	text: string,
	read: { readonly ok: true; readonly value: unknown } | { readonly ok: false },
	what: string
): void => {
	const whole = parsed(text)
	assert.equal(
		read.ok,
		whole.ok,
		`${what}: the reader ${read.ok ? "reads" : "refuses"} what JSON.parse ${whole.ok ? "reads" : "refuses"}`
	)
	if (read.ok && whole.ok) {
		assert.ok(sameJson(read.value, whole.value), `${what}: the reader's value is JSON.parse's`)
	}
}

/** A line of a drawn SQL file: statements, comments, quotes, dollar quotes, markers and placeholder tokens. */
const sqlLineGen: Gen<string> = element([
	"SELECT 1;",
	"CREATE TABLE t (a integer);",
	"-- a comment; with a semicolon",
	"-- grizzle: placeholder: write the value below",
	"-- grizzle: confirm: keep these",
	"-- grizzle: no-transaction",
	"  -- grizzle: placeholder indented",
	"UPDATE t SET a = __GRIZZLE_PLACEHOLDER__;",
	"/* a block comment with __GRIZZLE_PLACEHOLDER__ */",
	"/* a block comment that runs on",
	"and ends here */",
	"SELECT '__GRIZZLE_PLACEHOLDER__;' AS quoted;",
	"SELECT 'it''s';",
	'SELECT "quoted ident";',
	"DO $body$ BEGIN PERFORM 1; END $body$;",
	"CREATE FUNCTION f() RETURNS int BEGIN ATOMIC SELECT 1; END;",
	"",
	"  ",
	"SELECT 'é😀';\r",
	"SELECT 'unclosed",
	"SELECT 1 -- trailing __GRIZZLE_PLACEHOLDER__"
])

/** A drawn SQL file's text and the cuts it is read through. */
export interface SqlCase {
	readonly text: string
	readonly cuts: ReadonlyArray<number>
	readonly searches: ReadonlyArray<readonly [string, number]>
	readonly slices: ReadonlyArray<readonly [number, number]>
}

export const sqlCaseGen: Gen<SqlCase> = (source) => {
	const text = Arr.join(source.draw(array(sqlLineGen, { min: 0, max: 14 })), "\n")
	return {
		text,
		cuts: source.draw(cutsGen(text.length)),
		searches: source.draw(
			array(
				(s) =>
					[
						s.draw(
							element([
								"\n",
								";",
								"__GRIZZLE_PLACEHOLDER__",
								"-- grizzle:",
								"''",
								"$body$",
								"😀",
								"x"
							])
						),
						s.draw(int(0, text.length + 2))
					] as const,
				{ min: 1, max: 8 }
			)
		),
		slices: source.draw(
			array((s) => [s.draw(int(0, text.length + 1)), s.draw(int(0, text.length + 1))] as const, {
				min: 1,
				max: 8
			})
		)
	}
}
