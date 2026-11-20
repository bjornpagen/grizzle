/**
 * What the property of suffix.test.ts reads: drawn texts and suffixes over the code points the suffix key's range turns
 * on, and the host's evaluation of the range's SQL (sql/suffix.ts suffixRange), each builtin it calls as PostgreSQL 19
 * computes it over a UTF8 database's texts, by code points.
 */

import { assert } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import type { Expr } from "#compiler/sql/ast.ts"
import { lit, types } from "#compiler/sql/build.ts"
import { suffixRange } from "#compiler/sql/suffix.ts"

/**
 * The code points the range turns on: the sentinel U+0001 and the next one up, ASCII, the dot, the last one- and
 * two-byte code points and the first of two and three bytes, U+D7FF and U+E000 on either side of the surrogates, the last
 * code point of the Basic Multilingual Plane and the first astral one, and U+10FFFE and U+10FFFF, the last two.
 */
const codePoints = [
	0x1, 0x2, 0x2e, 0x61, 0x62, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xffff, 0x10000, 0x10fffe,
	0x10ffff
] as const

/** A text of up to `max` of the code points the range turns on. */
const textGen =
	(max: number): Gen<string> =>
	(source) =>
		Arr.join(
			Arr.map(source.draw(array(element(codePoints), { min: 0, max })), (c) =>
				String.fromCodePoint(c)
			),
			""
		)

/** The code point a one-character text is. */
const codePointOf = (c: string): number => Option.getOrElse(Str.codePointAt(0)(c), () => 0)

/** Whether a case's text ends with its suffix, as the host compares well-formed texts: by code points. */
export const endsWith = (c: SuffixCase): boolean => Str.endsWith(c.suffix)(c.text)

/** What a case is about: whether the text ends with the suffix, and the edges its suffix holds. */
export type SuffixFeature =
	| "ends with it"
	| "does not end with it"
	| "an empty suffix"
	| "a suffix of U+10FFFF alone"
	| "a suffix ending in U+D7FF"
	| "an astral suffix"

export const suffixFeatures: ReadonlyArray<SuffixFeature> = [
	"ends with it",
	"does not end with it",
	"an empty suffix",
	"a suffix of U+10FFFF alone",
	"a suffix ending in U+D7FF",
	"an astral suffix"
]

/** A case: a text and a suffix, the suffix as often its own tail, drawn apart, or a tail with one code point changed. */
export interface SuffixCase {
	readonly text: string
	readonly suffix: string
}

export const caseGen: Gen<SuffixCase> = (source) => {
	const text = source.draw(textGen(6))
	const points = Array.from(text)
	if (source.draw(boolean)) {
		const length = source.draw(int(0, points.length))
		return { text, suffix: Arr.join(points.slice(points.length - length), "") }
	}
	return { text, suffix: source.draw(textGen(3)) }
}

/** The features of a case. */
export const featuresOf = (c: SuffixCase): ReadonlyArray<SuffixFeature> => {
	const points = Array.from(c.suffix)
	return [
		endsWith(c) ? "ends with it" : "does not end with it",
		...(points.length === 0 ? (["an empty suffix"] as const) : []),
		...(points.length > 0 && Arr.every(points, (p) => p === "\u{10ffff}")
			? (["a suffix of U+10FFFF alone"] as const)
			: []),
		...(points.at(-1) === "\u{d7ff}" ? (["a suffix ending in U+D7FF"] as const) : []),
		...(Arr.some(points, (p) => codePointOf(p) > 0xffff) ? (["an astral suffix"] as const) : [])
	]
}

/** A value of the range's SQL: a text, an integer or a boolean. */
type Value =
	| { readonly kind: "text"; readonly points: ReadonlyArray<number> }
	| { readonly kind: "int"; readonly value: number }
	| { readonly kind: "bool"; readonly value: boolean }

const textOf = (v: Value): ReadonlyArray<number> =>
	v.kind === "text" ? v.points : assert.fail(`a text operand, not ${v.kind}`)

const intOf = (v: Value): number =>
	v.kind === "int" ? v.value : assert.fail(`an integer operand, not ${v.kind}`)

const text = (points: ReadonlyArray<number>): Value => ({ kind: "text", points })

/** Two texts in code point order, as PostgreSQL compares two texts collated pg_c_utf8: -1, 0 or 1. */
const compareCodePoints = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		const x = a[i] ?? 0
		const y = b[i] ?? 0
		if (x !== y) {
			return x < y ? -1 : 1
		}
	}
	return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

/**
 * chr(n) as PostgreSQL 19 computes it in a UTF8 database (oracle_compat.c chr): the code point n, and an error for 0, a
 * surrogate and anything past U+10FFFF, which no text holds.
 */
const chr = (n: number): ReadonlyArray<number> =>
	n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)
		? assert.fail(`chr(${n}): requested character not valid for encoding`)
		: [n]

/** The argument at `at` of a builtin's call. */
const argAt = (args: ReadonlyArray<Value>, at: number): Value =>
	args[at] ?? assert.fail(`an argument at ${at}`)

/** Each builtin the range calls, by its name, over its arguments' values, by code points. */
const builtins: Readonly<Record<string, (args: ReadonlyArray<Value>) => Value>> = {
	chr: (args) => text(chr(intOf(argAt(args, 0)))),
	reverse: (args) => text(Arr.reverse(textOf(argAt(args, 0)))),
	rtrim: (args) => {
		const points = textOf(argAt(args, 0))
		const strip = new Set(textOf(argAt(args, 1)))
		let end = points.length
		while (end > 0 && strip.has(points[end - 1] ?? -1)) {
			end--
		}
		return text(points.slice(0, end))
	},
	left: (args) => {
		const points = textOf(argAt(args, 0))
		const n = intOf(argAt(args, 1))
		return text(n < 0 ? points.slice(0, Math.max(points.length + n, 0)) : points.slice(0, n))
	},
	right: (args) => {
		const points = textOf(argAt(args, 0))
		const n = intOf(argAt(args, 1))
		return text(
			n < 0
				? points.slice(Math.min(-n, points.length))
				: points.slice(Math.max(points.length - n, 0))
		)
	},
	ascii: (args) => ({ kind: "int", value: textOf(argAt(args, 0))[0] ?? 0 })
}

/** A builtin's value over its arguments' values. */
const builtin = (name: string, args: ReadonlyArray<Value>): Value =>
	(builtins[name] ?? assert.fail(`the range calls no ${name}`))(args)

/** Each binary operator the range applies, over its operands' values. */
const binaries: Readonly<Record<string, (l: Value, r: Value) => Value>> = {
	"||": (l, r) => text([...textOf(l), ...textOf(r)]),
	"+": (l, r) => ({ kind: "int", value: intOf(l) + intOf(r) }),
	">=": (l, r) => ({ kind: "bool", value: compareCodePoints(textOf(l), textOf(r)) >= 0 }),
	"<": (l, r) => ({ kind: "bool", value: compareCodePoints(textOf(l), textOf(r)) < 0 })
}

/** The value of a literal of the range: a text, an integer or a boolean. */
const literalValue = (e: Extract<Expr, { readonly kind: "literal" }>): Value =>
	e.value.kind === "text"
		? text(Arr.map(Array.from(e.value.value), codePointOf))
		: e.value.kind === "int"
			? { kind: "int", value: Number(e.value.value) }
			: e.value.kind === "bool"
				? { kind: "bool", value: e.value.value }
				: assert.fail(`a literal of ${e.value.kind}`)

/** The host's value of `e`, an expression of the range's SQL over literals. */
const evaluated = (e: Expr): Value => {
	if (e.kind === "literal") {
		return literalValue(e)
	}
	if (e.kind === "call") {
		return e.fn.kind === "builtin"
			? builtin(e.fn.name, Arr.map(e.args, evaluated))
			: assert.fail("a builtin call")
	}
	if (e.kind === "and") {
		return {
			kind: "bool",
			value: Arr.every(e.args, (a) => {
				const v = evaluated(a)
				return v.kind === "bool" ? v.value : assert.fail("a boolean conjunct")
			})
		}
	}
	if (e.kind === "binary") {
		const apply = binaries[e.op] ?? assert.fail(`the range applies no ${e.op}`)
		return apply(evaluated(e.left), evaluated(e.right))
	}
	if (e.kind === "case") {
		const operand = e.operand === undefined ? undefined : evaluated(e.operand)
		const taken = Arr.findFirst(e.whens, (w) => {
			const when = evaluated(w.when)
			return operand === undefined
				? when.kind === "bool" && when.value
				: operand.kind === "int" && when.kind === "int" && operand.value === when.value
		})
		return evaluated(Option.match(taken, { onNone: () => e.else, onSome: (w) => w.result }))
	}
	return assert.fail(`the range holds no ${e.kind}`)
}

/** Whether `text` lies in its suffix key's range of `suffix`, as the host evaluates the range's SQL. */
export const inRange = (c: SuffixCase): boolean => {
	const v = evaluated(suffixRange(lit.text(c.text, types.text), lit.text(c.suffix, types.text)))
	return v.kind === "bool" ? v.value : assert.fail("the range is a boolean")
}
