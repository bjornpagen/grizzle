/** What the properties of representability.test.ts read: its spaces, models and helpers. */

import { indices, maxOf } from "@bjornpagen/grizzle-text/base/array"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, defined } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, pipe, Record as Rec, String as Str } from "effect"
import { settled } from "#compiler/core/canonical.ts"
import { vectorMaxDimensions } from "#compiler/ir/carriers.ts"
import { type ExprDesc, type FieldDesc, fieldTypes } from "#compiler/ir/desc.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { parseSchemaInput } from "#compiler/program/input.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { natural } from "#compiler/public/fields.ts"
import { str } from "#compiler/public/text.ts"
import {
	accumulatedField,
	closedBuilder as closed,
	drawnField,
	relationBuilder as relation,
	relationDescOf
} from "#compiler/schema/relation.ts"
import {
	typlens,
	type DatumBound,
	datumBound,
	type LengthMeasure
} from "#compiler/schema/representability.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import {
	finBuilder,
	foldBuilder,
	keyBuilder,
	monoids,
	onBuilder,
	orderedBuilder,
	selectBuilder,
	treeBuilder
} from "#compiler/schema/statements.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { Id } from "#test/support/ids.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"
import { ownInput } from "#test/support/policy.ts"
import {
	charLengthAtMost,
	descOf,
	octetLengthAtMost,
	rawClosedId,
	rawContract,
	rawPg,
	regex,
	type Row,
	wildcard
} from "#test/support/unit/schema/support.ts"

export const postgresIndexMaxKeys = 32

/** BTMaxItemSize for the default 8192-byte block (nbtree.h), restated. */
export const postgresBtreeMaxItem = 2704

/** An empty GiST page, GiSTPageSize (8192 - 24 - 16), less one line pointer (gist.c gistfitpage), restated. */
export const postgresGistMaxItem = 8148

/** The index tuple header (IndexTupleData) and MAXALIGN of the pinned 64-bit build. */
const indexTupleHeader = 8

const maxalign = (n: number): number => Math.ceil(n / 8) * 8

const utf8 = new TextEncoder()

export const utf8Bytes = (text: string): number => utf8.encode(text).length

/**
 * The ownership of a schema value at the schema door, as a compile that ends there settles it: every unrepresentable key
 * ownership met refused at once (core/canonical.ts settled).
 */
export const ownValue = (value: unknown) =>
	Result.flatMap(Result.flatMap(parseSchemaInput(value), ownInput), (owned) =>
		settled(owned.unrepresentable, Result.ok(owned))
	)

export const ownOne = (r: AnyRelation | AnyClosed, statements: ReadonlyArray<Statement>) =>
	ownValue(schema("Keys", [r], statements, []))

/** The field Descriptions of a relation, read through its accessor. */
export const fieldDescsOf = (r: unknown): Readonly<Record<string, FieldDesc>> => {
	const desc = relationDescOf(r, "test")
	if (desc.kind !== "relation") {
		throw new Error(`${desc.name} is not an ordinary relation`)
	}
	return fieldTypes(desc.fields)
}

/**
 * A pattern as drawn: a symbol (a literal, an escape or a class, with the most UTF-8 bytes one code point it matches
 * holds, and a code point of that width it matches), a group of alternatives, a zero-width lookaround that always
 * holds, and a back-reference, for which no bound is claimed.
 */
interface RegexSymbol {
	readonly source: string
	readonly bytes: number
	readonly witness: string
}

/**
 * ECMAScript's classes in "u" mode: \d and \w are ASCII, \s's widest member (U+3000, U+FEFF) takes three bytes, and a
 * negated class, \D, the dot and \p{L} reach the supplementary planes.
 */
const regexSymbols: Arr.NonEmptyReadonlyArray<RegexSymbol> = [
	{ source: "a", bytes: 1, witness: "a" },
	{ source: "é", bytes: 2, witness: "é" },
	{ source: "€", bytes: 3, witness: "€" },
	{ source: "😀", bytes: 4, witness: "😀" },
	{ source: "\\.", bytes: 1, witness: "." },
	{ source: "\\x41", bytes: 1, witness: "A" },
	{ source: "\\u00e9", bytes: 2, witness: "é" },
	{ source: "\\u{1F600}", bytes: 4, witness: "😀" },
	{ source: "\\d", bytes: 1, witness: "7" },
	{ source: "\\w", bytes: 1, witness: "_" },
	{ source: "\\s", bytes: 3, witness: "　" },
	{ source: "\\D", bytes: 4, witness: "😀" },
	{ source: ".", bytes: 4, witness: "😀" },
	{ source: "[a-z]", bytes: 1, witness: "q" },
	{ source: "[a-zé]", bytes: 2, witness: "é" },
	{ source: "[€0-9]", bytes: 3, witness: "€" },
	{ source: "[^a]", bytes: 4, witness: "😀" },
	{ source: "[\\u{1F600}-\\u{1F64F}]", bytes: 4, witness: "😀" },
	{ source: "\\p{L}", bytes: 4, witness: "𠀀" }
]

type Quantifier =
	| { readonly kind: "once" }
	| { readonly kind: "optional"; readonly lazy: boolean }
	| { readonly kind: "exactly"; readonly n: number }
	| { readonly kind: "range"; readonly low: number; readonly high: number; readonly lazy: boolean }
	| { readonly kind: "unbounded"; readonly spelling: "*" | "+" | "{2,}" }

type RegexAtom =
	| { readonly kind: "symbol"; readonly symbol: RegexSymbol }
	| {
			readonly kind: "group"
			readonly capture: boolean
			readonly alternatives: Arr.NonEmptyReadonlyArray<RegexSequence>
	  }

type RegexItem =
	| { readonly kind: "quantified"; readonly atom: RegexAtom; readonly quantifier: Quantifier }
	| { readonly kind: "lookaround"; readonly source: "(?=.*)" | "(?<=.*)" }
	| { readonly kind: "back-reference" }

type RegexSequence = ReadonlyArray<RegexItem>

/** A top-level alternative and its anchors. */
interface TopAlternative {
	readonly start: boolean
	readonly items: RegexSequence
	readonly end: boolean
}

const quantifierSource = (q: Quantifier): string => {
	switch (q.kind) {
		case "once":
			return ""
		case "optional":
			return q.lazy ? "??" : "?"
		case "exactly":
			return `{${q.n}}`
		case "range":
			return `{${q.low},${q.high}}${q.lazy ? "?" : ""}`
		case "unbounded":
			return q.spelling
	}
}

const atomSource = (a: RegexAtom): string =>
	a.kind === "symbol"
		? a.symbol.source
		: `${a.capture ? "(" : "(?:"}${Arr.join(Arr.map(a.alternatives, sequenceSource), "|")})`

const itemSource = (item: RegexItem): string => {
	switch (item.kind) {
		case "quantified":
			return `${atomSource(item.atom)}${quantifierSource(item.quantifier)}`
		case "lookaround":
			return item.source
		case "back-reference":
			return "(a)\\1"
	}
}

const sequenceSource = (items: RegexSequence): string => Arr.join(Arr.map(items, itemSource), "")

export const patternSource = (alternatives: ReadonlyArray<TopAlternative>): string =>
	Arr.join(
		Arr.map(
			alternatives,
			(a) => `${a.start ? "^" : ""}${sequenceSource(a.items)}${a.end ? "$" : ""}`
		),
		"|"
	)

/** The most repetitions a quantifier admits. */
const repetitions = (q: Quantifier): number => {
	switch (q.kind) {
		case "once":
		case "optional":
			return 1
		case "exactly":
			return q.n
		case "range":
			return q.high
		case "unbounded":
			return Number.POSITIVE_INFINITY
	}
}

/**
 * The longest match in UTF-8 bytes, Infinity where none is bounded: a sequence sums, a group takes its widest
 * alternative, a quantifier multiplies by its most repetitions (an empty match repeated stays empty), a lookaround is
 * empty, and a back-reference repeats a match of unknown size.
 */
const atomBytes = (a: RegexAtom): number =>
	a.kind === "symbol"
		? a.symbol.bytes
		: maxOf(Arr.map(a.alternatives, sequenceBytes), Number.NEGATIVE_INFINITY)

const itemBytes = (item: RegexItem): number => {
	switch (item.kind) {
		case "quantified": {
			const once = atomBytes(item.atom)
			return once === 0 ? 0 : once * repetitions(item.quantifier)
		}
		case "lookaround":
			return 0
		case "back-reference":
			return Number.POSITIVE_INFINITY
	}
}

export const sequenceBytes = (items: RegexSequence): number =>
	Arr.reduce(items, 0, (sum, item) => sum + itemBytes(item))

/**
 * A sequence spelled so a backtracking matcher's first path through it is a longest match: every quantifier greedy,
 * so it tries its most repetitions first, and every group's alternatives widest first. Neither changes the language,
 * since laziness and the order of alternatives only order the search, so the host's RegExp witnesses a longest match
 * of the pattern as drawn without searching for it. The drawn spelling would make it search: lazy repetitions try
 * every shorter split first, exponentially many once nested, and `^😀(?:(.(?<=.*)|){1,1}\w??(?:.\D?.{3,4}?){3,6}?){3}$`
 * against its 115-code-point witness ran for over twenty minutes without finishing.
 */
const greedyQuantifier = (q: Quantifier): Quantifier => {
	switch (q.kind) {
		case "optional":
		case "range":
			return { ...q, lazy: false }
		case "once":
		case "exactly":
		case "unbounded":
			return q
	}
}

const widestFirst = Order.flip(Order.Number)

const greedyAtom = (a: RegexAtom): RegexAtom =>
	a.kind === "symbol"
		? a
		: {
				...a,
				alternatives: Arr.sortWith(
					Arr.map(a.alternatives, greedySequence),
					sequenceBytes,
					widestFirst
				)
			}

const greedyItem = (item: RegexItem): RegexItem =>
	item.kind === "quantified"
		? {
				kind: "quantified",
				atom: greedyAtom(item.atom),
				quantifier: greedyQuantifier(item.quantifier)
			}
		: item

const greedySequence = (items: RegexSequence): RegexSequence => Arr.map(items, greedyItem)

/** The top-level alternatives spelled greedy and widest first (greedySequence), the widest first of all. */
export const greedyAlternatives = (alternatives: Arr.NonEmptyReadonlyArray<TopAlternative>) =>
	Arr.sortWith(
		Arr.map(alternatives, (a): TopAlternative => ({ ...a, items: greedySequence(a.items) })),
		(a) => sequenceBytes(a.items),
		widestFirst
	)

/**
 * The match a backtracking matcher's first path through a sequence consumes: each symbol's witness, each group's first
 * alternative, as many repetitions as the quantifier admits. Of a sequence spelled greedy and widest first
 * (greedySequence), a longest match.
 */
const atomWitness = (a: RegexAtom): string =>
	a.kind === "symbol" ? a.symbol.witness : sequenceWitness(a.alternatives[0])

const itemWitness = (item: RegexItem): string =>
	item.kind === "quantified" ? Str.repeat(repetitions(item.quantifier))(atomWitness(item.atom)) : ""

export const sequenceWitness = (items: RegexSequence): string =>
	Arr.join(Arr.map(items, itemWitness), "")

/** A nonempty list: a first element and up to `more` others. */
export const nonEmptyOf = <A>(arb: Gen<A>, more: number): Gen<Arr.NonEmptyReadonlyArray<A>> =>
	map(
		(source) => [source.draw(arb), source.draw(array(arb, { min: 0, max: more }))] as const,
		([first, rest]): Arr.NonEmptyReadonlyArray<A> => [first, ...rest]
	)

const quantifierGen: Gen<Quantifier> = weighted([
	[4, constant<Quantifier>({ kind: "once" })],
	[1, map(boolean, (lazy): Quantifier => ({ kind: "optional", lazy }))],
	[1, map(int(0, 4), (n): Quantifier => ({ kind: "exactly", n }))],
	[
		1,
		map(
			(source) => ({
				low: source.draw(int(0, 3)),
				more: source.draw(int(0, 3)),
				lazy: source.draw(boolean)
			}),
			({ low, more, lazy }): Quantifier => ({ kind: "range", low, high: low + more, lazy })
		)
	]
])

const symbolItemGen: Gen<RegexItem> = map(
	(source) => ({
		symbol: source.draw(element(regexSymbols)),
		quantifier: source.draw(quantifierGen)
	}),
	({ symbol, quantifier }): RegexItem => ({
		kind: "quantified",
		atom: { kind: "symbol", symbol },
		quantifier
	})
)

const lookaroundGen: Gen<RegexItem> = map(
	element<"(?=.*)" | "(?<=.*)">(["(?=.*)", "(?<=.*)"]),
	(source): RegexItem => ({ kind: "lookaround", source })
)

/** Items nested at most `depth` groups deep. */
const regexItemGen = (depth: number): Gen<RegexItem> =>
	depth === 0
		? weighted([
				[5, symbolItemGen],
				[1, lookaroundGen]
			])
		: weighted([
				[5, symbolItemGen],
				[1, lookaroundGen],
				[
					2,
					map(
						(source) => ({
							capture: source.draw(boolean),
							alternatives: source.draw(
								nonEmptyOf(array(regexItemGen(depth - 1), { min: 0, max: 3 }), 2)
							),
							quantifier: source.draw(quantifierGen)
						}),
						({ capture, alternatives, quantifier }): RegexItem => ({
							kind: "quantified",
							atom: { kind: "group", capture, alternatives },
							quantifier
						})
					)
				]
			])

/**
 * What a drawn pattern is planted with: nothing, a top-level alternative missing an anchor, an unbounded repetition, a
 * back-reference, or a run of 600 literals, longer than the regex node bound however short each node is.
 */
type RegexDefect =
	| "none"
	| "no start anchor"
	| "no end anchor"
	| "unbounded repetition"
	| "back-reference"
	| "long run"

interface PatternSketch {
	readonly alternatives: Arr.NonEmptyReadonlyArray<RegexSequence>
	readonly defect: RegexDefect
	readonly at: number
	readonly spelling: "*" | "+" | "{2,}"
	readonly flags: "u" | "su"
}

export const patternSketchGen: Gen<PatternSketch> = (source) => ({
	alternatives: source.draw(nonEmptyOf(array(regexItemGen(2), { min: 0, max: 4 }), 2)),
	defect: source.draw(
		weighted<RegexDefect>([
			[3, constant("none")],
			[1, constant("no start anchor")],
			[1, constant("no end anchor")],
			[1, constant("unbounded repetition")],
			[1, constant("back-reference")],
			[1, constant("long run")]
		])
	),
	at: source.draw(pickGen),
	spelling: source.draw(element<"*" | "+" | "{2,}">(["*", "+", "{2,}"])),
	flags: source.draw(element<"u" | "su">(["u", "su"]))
})

/** The top-level alternatives with the defect planted in the one `at` picks. */
export const plantedAlternatives = (
	s: PatternSketch
): Arr.NonEmptyReadonlyArray<TopAlternative> => {
	const target = pickIndex(s.at, s.alternatives.length)
	const a: RegexItem = {
		kind: "quantified",
		atom: { kind: "symbol", symbol: regexSymbols[0] },
		quantifier: { kind: "once" }
	}
	return Arr.map(s.alternatives, (items, i): TopAlternative => {
		if (i !== target) {
			return { start: true, items, end: true }
		}
		switch (s.defect) {
			case "none":
				return { start: true, items, end: true }
			case "no start anchor":
				return { start: false, items, end: true }
			case "no end anchor":
				return { start: true, items, end: false }
			case "unbounded repetition":
				return {
					start: true,
					items: [...items, { ...a, quantifier: { kind: "unbounded", spelling: s.spelling } }],
					end: true
				}
			case "back-reference":
				return { start: true, items: [...items, { kind: "back-reference" }], end: true }
			case "long run":
				return {
					start: true,
					items: [...items, ...Array.from({ length: 600 }, () => a)],
					end: true
				}
		}
	})
}

export type RegexFeature =
	| "bounded"
	| "exact"
	| "long run"
	| "unanchored"
	| "unbounded repetition"
	| "back-reference"
	| "lookaround"
	| "four-byte code point"
	| "group alternation"

export const hasItem = (items: RegexSequence, holds: (item: RegexItem) => boolean): boolean =>
	Arr.some(
		items,
		(item) =>
			holds(item) ||
			(item.kind === "quantified" &&
				item.atom.kind === "group" &&
				Arr.some(item.atom.alternatives, (alt) => hasItem(alt, holds)))
	)

/**
 * A conjunct of a contract predicate over one length of VALUE, `measure`, its char_length or its octet_length =: L, as
 * drawn: a comparison with a literal on either side (a number or a bigint), between (low <= high), in (a nonempty
 * list), a disjunction of two upper bounds, which bounds L but is no form the reader recognizes, or a test of the value
 * that leaves L free.
 */
type LengthForm =
	| {
			readonly kind: "compare"
			readonly op: "le" | "lt" | "eq" | "ge" | "gt" | "ne"
			readonly n: number
			readonly mirrored: boolean
			readonly bigint: boolean
	  }
	| { readonly kind: "between"; readonly low: number; readonly high: number }
	| { readonly kind: "in"; readonly values: Arr.NonEmptyReadonlyArray<number> }
	| { readonly kind: "or"; readonly left: number; readonly right: number }
	| { readonly kind: "other" }

interface LengthConjunct {
	readonly measure: LengthMeasure
	readonly form: LengthForm
}

const lengthOfValue = (measure: LengthMeasure): ExprDesc => ({
	kind: "compute",
	fn: measure,
	args: [{ kind: "value" }]
})

const lengthLiteral = (n: number, bigint: boolean): ExprDesc => ({
	kind: "literal",
	value: bigint ? BigInt(n) : n
})

export const conjunctExpr = ({ measure, form: c }: LengthConjunct): ExprDesc => {
	const measured = lengthOfValue(measure)
	switch (c.kind) {
		case "compare":
			return c.mirrored
				? { kind: "compare", op: c.op, left: lengthLiteral(c.n, c.bigint), right: measured }
				: { kind: "compare", op: c.op, left: measured, right: lengthLiteral(c.n, c.bigint) }
		case "between":
			return {
				kind: "between",
				arg: measured,
				low: lengthLiteral(c.low, false),
				high: lengthLiteral(c.high, false)
			}
		case "in":
			return { kind: "in", arg: measured, values: c.values }
		case "or":
			return {
				kind: "or",
				args: [
					{ kind: "compare", op: "le", left: measured, right: lengthLiteral(c.left, false) },
					{ kind: "compare", op: "le", left: measured, right: lengthLiteral(c.right, false) }
				]
			}
		case "other":
			return {
				kind: "compare",
				op: "ne",
				left: { kind: "value" },
				right: { kind: "literal", value: "zz" }
			}
	}
}

const compares = (op: "le" | "lt" | "eq" | "ge" | "gt" | "ne", a: number, b: number): boolean =>
	op === "le"
		? a <= b
		: op === "lt"
			? a < b
			: op === "eq"
				? a === b
				: op === "ge"
					? a >= b
					: op === "gt"
						? a > b
						: a !== b

/** Whether a conjunct's form holds of a value whose measured length is L. */
const holdsAt = (c: LengthForm, length: number): boolean => {
	switch (c.kind) {
		case "compare":
			return c.mirrored ? compares(c.op, c.n, length) : compares(c.op, length, c.n)
		case "between":
			return c.low <= length && length <= c.high
		case "in":
			return c.values.includes(length)
		case "or":
			return length <= c.left || length <= c.right
		case "other":
			return true
	}
}

/**
 * The forms the reader documents as bounding L above: <=, < and = with L on the left, their mirror images, between
 * and in.
 */
export const boundsAbove = (c: LengthForm): boolean =>
	c.kind === "between" ||
	c.kind === "in" ||
	(c.kind === "compare" &&
		(c.mirrored
			? c.op === "ge" || c.op === "gt" || c.op === "eq"
			: c.op === "le" || c.op === "lt" || c.op === "eq"))

/** Lengths past every drawn literal, and below zero, where an upper bound's arithmetic may land. */
const lengthsScanned = Object.freeze(Arr.map(indices(141), (i) => 100 - i))

/**
 * The bound the model reads on `measure` from the conjuncts: each documented upper-bounding conjunct of that measure
 * alone bounds L at the largest scanned length it holds of, and the conjunction at the least of those; Infinity, the top
 * of the bounds' min order, when no conjunct of the measure bounds L.
 */
export const modelBound = (
	conjuncts: ReadonlyArray<LengthConjunct>,
	measure: LengthMeasure
): number =>
	Arr.reduce(
		Arr.filter(conjuncts, (c) => c.measure === measure && boundsAbove(c.form)),
		Number.POSITIVE_INFINITY,
		(bound, c) =>
			Math.min(
				bound,
				defined(
					Option.getOrUndefined(Arr.findFirst(lengthsScanned, (length) => holdsAt(c.form, length))),
					"a scanned length the conjunct holds of"
				)
			)
	)

export interface LengthSketch {
	readonly conjuncts: Arr.NonEmptyReadonlyArray<LengthConjunct>
	/** The conjuncts after the first written as a conjunction of their own. */
	readonly nested: boolean
	/** The contract's base: the wildcard, or ^[A-Z]{k}$ of k bytes. */
	readonly base: { readonly kind: "wildcard" } | { readonly kind: "letters"; readonly k: number }
}

const lengthFormGen: Gen<LengthForm> = weighted<LengthForm>([
	[
		4,
		(source) => ({
			kind: "compare",
			op: source.draw(
				element<"le" | "lt" | "eq" | "ge" | "gt" | "ne">(["le", "lt", "eq", "ge", "gt", "ne"])
			),
			n: source.draw(int(-3, 60)),
			mirrored: source.draw(boolean),
			bigint: source.draw(boolean)
		})
	],
	[
		1,
		(source) => {
			const low = source.draw(int(0, 40))
			return { kind: "between", low, high: low + source.draw(int(0, 20)) }
		}
	],
	[1, (source) => ({ kind: "in", values: source.draw(nonEmptyOf(int(0, 60), 3)) })],
	[1, (source) => ({ kind: "or", left: source.draw(int(0, 60)), right: source.draw(int(0, 60)) })],
	[1, constant<LengthForm>({ kind: "other" })]
])

export const lengthConjunctGen: Gen<LengthConjunct> = (source) => ({
	measure: source.draw(element<LengthMeasure>(["charLength", "octetLength"])),
	form: source.draw(lengthFormGen)
})

export type LengthFeature =
	| "charLength bounded"
	| "octetLength bounded"
	| "unbounded"
	| "both measures"
	| "base tighter"
	| "charLength tighter"
	| "octetLength tighter"
	| "mirrored"

/**
 * A key field as drawn, over pg_type's sizes and alignments: a fixed-width type, numeric(p, s), numeric of no typmod,
 * text of a bounded pattern (ASCII, or any code point), the wildcard, or a contract over the wildcard bounding
 * char_length or octet_length.
 */
type FixedType =
	| "smallint"
	| "integer"
	| "bigint"
	| "real"
	| "double precision"
	| "money"
	| "boolean"
	| "uuid"
	| "closedId"

export type KeyFieldSketch =
	| { readonly kind: "fixed"; readonly type: FixedType }
	| { readonly kind: "numeric"; readonly precision: number; readonly scale: number }
	| { readonly kind: "bare numeric" }
	| { readonly kind: "ascii text"; readonly length: number }
	| { readonly kind: "any text"; readonly length: number }
	| { readonly kind: "wildcard" }
	| { readonly kind: "bounded contract"; readonly length: number }
	| { readonly kind: "octet contract"; readonly bytes: number }

/** A datum's longest bytes and its type's alignment, and whether its type is fixed-width (typlen > 0) or a varlena. */
export interface Datum {
	readonly bytes: number
	readonly align: number
	readonly fixed: boolean
}

/** pg_type's typlen and typalign of each fixed key type: a closed id is its code, a smallint. */
const fixedDatum: Readonly<Record<FixedType, Datum>> = {
	smallint: { bytes: 2, align: 2, fixed: true },
	integer: { bytes: 4, align: 4, fixed: true },
	bigint: { bytes: 8, align: 8, fixed: true },
	real: { bytes: 4, align: 4, fixed: true },
	"double precision": { bytes: 8, align: 8, fixed: true },
	money: { bytes: 8, align: 8, fixed: true },
	boolean: { bytes: 1, align: 1, fixed: true },
	uuid: { bytes: 16, align: 1, fixed: true },
	closedId: { bytes: 2, align: 2, fixed: true }
}

/** A varlena datum with its 4-byte header, int-aligned. */
const varlena = (bytes: number): Datum => ({ bytes: 4 + bytes, align: 4, fixed: false })

/** numeric_maximum_size of `digits` significant digits: NUMERIC_HDRSZ (8) and a NumericDigit (2 bytes) per base-10000 digit. */
const numericDatum = (digits: number): Datum => ({
	bytes: 8 + 2 * Math.floor((digits + 6) / 4),
	align: 4,
	fixed: false
})

/**
 * The digits of numeric of no typmod at its widest: 131,072 before the point and 16,383 after it, PostgreSQL's
 * documented limits (datatype.sgml "up to 131072 digits before the decimal point; up to 16383 digits after").
 */
const bareNumericDigits = 131072 + 16383

/**
 * The widest datum a key's index entry holds for a field: numeric(p, s) is at most numeric_maximum_size, NUMERIC_HDRSZ
 * (8) plus a NumericDigit (2 bytes) for each of (p + 2 * (DEC_DIGITS - 1)) / DEC_DIGITS base-10000 digits (numeric.c),
 * numeric of no typmod the same over every digit numeric holds; text is its bytes, four per code point unless pinned to
 * ASCII; none for a text nothing bounds, which no entry holds.
 */
export const datumOf = (f: KeyFieldSketch): Datum | undefined => {
	switch (f.kind) {
		case "fixed":
			return fixedDatum[f.type]
		case "numeric":
			return numericDatum(f.precision)
		case "bare numeric":
			return numericDatum(bareNumericDigits)
		case "ascii text":
			return varlena(f.length)
		case "any text":
		case "bounded contract":
			return varlena(4 * f.length)
		case "octet contract":
			return varlena(f.bytes)
		case "wildcard":
			return undefined
	}
}

/**
 * The most bytes a B-tree tuple over the datums reaches in any order of them, before MAXALIGN, from its data's offset
 * `start`: each datum after its worst alignment padding, align - 1, and a varlena at its longest under its aligned
 * 4-byte header, since every offset past the first datum's depends on the order and the values before it.
 */
const anyOrderEnd = (start: number, datums: ReadonlyArray<Datum>): number =>
	Arr.reduce(datums, start, (end, d) => end + d.align - 1 + d.bytes)

/**
 * The most bytes a B-tree tuple over the datums reaches in any order of them (`anyOrderEnd`), past its header, the
 * whole MAXALIGNed: whether a key fits is a function of its column set, the order a key, a UNIQUE or a reference lists
 * it in deciding nothing.
 */
export const btreeTupleBytes = (datums: ReadonlyArray<Datum>): number =>
	maxalign(anyOrderEnd(indexTupleHeader, datums))

export const Kind = closed("Kind", ["A", "B"], "ordered", [])

/** The descriptor of a fixed-width key field's type. */
const fixedDescriptor = (type: FixedType): FieldBase => {
	switch (type) {
		case "smallint":
			return rawPg.smallint
		case "integer":
			return rawPg.integer
		case "bigint":
			return rawPg.bigint
		case "real":
			return rawPg.real
		case "double precision":
			return rawPg.doublePrecision
		case "money":
			return rawPg.money
		case "boolean":
			return rawPg.boolean
		case "uuid":
			return Id
		case "closedId":
			return rawClosedId(Kind)
	}
}

export const keyFieldDescriptor = (f: KeyFieldSketch, i: number): FieldBase => {
	switch (f.kind) {
		case "fixed":
			return fixedDescriptor(f.type)
		case "numeric":
			return rawPg.numericOf(f.precision, f.scale)
		case "bare numeric":
			return rawPg.numeric
		case "ascii text":
			return regex(`^[a-z]{0,${f.length}}$`, "u")
		case "any text":
			return regex(`^.{0,${f.length}}$`, "su")
		case "wildcard":
			return wildcard
		case "bounded contract":
			return rawContract(`Line${i}`, wildcard, charLengthAtMost(f.length))
		case "octet contract":
			return rawContract(`Octets${i}`, wildcard, octetLengthAtMost(f.bytes))
	}
}

const fixedTypes: Arr.NonEmptyReadonlyArray<FixedType> = [
	"smallint",
	"integer",
	"bigint",
	"real",
	"double precision",
	"money",
	"boolean",
	"uuid",
	"closedId"
]

export const keyFieldGen: Gen<KeyFieldSketch> = weighted([
	[4, map(element(fixedTypes), (type): KeyFieldSketch => ({ kind: "fixed", type }))],
	[
		2,
		map(
			(source) => ({
				precision: source.draw(
					weighted([
						[1, int(1, 40)],
						[1, int(1, 1000)]
					])
				),
				scale: source.draw(int(0, 10))
			}),
			({ precision, scale }): KeyFieldSketch => ({
				kind: "numeric",
				precision,
				scale: Math.min(scale, precision)
			})
		)
	],
	[2, map(int(0, 40), (length): KeyFieldSketch => ({ kind: "ascii text", length }))],
	[1, map(int(0, 40), (length): KeyFieldSketch => ({ kind: "any text", length }))],
	[1, constant<KeyFieldSketch>({ kind: "wildcard" })],
	[2, map(int(0, 700), (length): KeyFieldSketch => ({ kind: "bounded contract", length }))],
	[2, map(int(0, 2800), (bytes): KeyFieldSketch => ({ kind: "octet contract", bytes }))]
])

/**
 * A key field as a key's own entry draws it: any key field, or numeric of no typmod, whose widest value no B-tree entry
 * holds, so a key holds it by its image wherever it stands. A lookup's request draws the rest alone (keyFieldGen): its
 * entry holds no numeric by an image, so one beside it is refused for its bytes whatever else it holds.
 */
export const keyedFieldGen: Gen<KeyFieldSketch> = weighted([
	[14, keyFieldGen],
	[1, constant<KeyFieldSketch>({ kind: "bare numeric" })]
])

export interface KeySizeSketch {
	readonly fields: Arr.NonEmptyReadonlyArray<KeyFieldSketch>
	readonly primary: boolean
	/**
	 * A last field planted to bring the entry to the item limit plus `delta` bytes, when the rest is bounded and leaves
	 * room for it: a text bounded by its octet_length, at the byte, or by its char_length, four bytes at a time.
	 */
	readonly boundary:
		| { readonly kind: "none" }
		| { readonly kind: "at"; readonly delta: number; readonly octets: boolean }
}

/** The drawn fields, with the boundary field appended where one is planted. */
export const sizedFields = (s: KeySizeSketch): ReadonlyArray<KeyFieldSketch> => {
	if (s.boundary.kind === "none") {
		return s.fields
	}
	const own = Arr.map(s.fields, datumOf)
	const bounded = Arr.filter(own, (d): d is Datum => d !== undefined)
	if (bounded.length < own.length) {
		return s.fields
	}
	const start = anyOrderEnd(indexTupleHeader, bounded) + 3 + 4
	const room = postgresBtreeMaxItem + s.boundary.delta - start
	if (room < 0) {
		return s.fields
	}
	return [
		...s.fields,
		s.boundary.octets
			? { kind: "octet contract", bytes: room }
			: { kind: "bounded contract", length: Math.floor(room / 4) }
	]
}

export type KeySizeFeature =
	| "admitted"
	| "refused"
	| "at the limit, admitted"
	| "past the limit, refused"
	| "fitting in its own order, refused"
	| "primary"
	| "candidate"

/**
 * The most bytes a B-tree tuple over the datums reaches laid out in their own order, as index_form_tuple lays one out
 * (heaptuple.c fill_val): each fixed-width datum at its alignment while every datum before it is fixed-width, every
 * offset then known; from the first varlena on, each after its worst padding. One order's bound, never the rule's: a
 * key that fits so and not in some other order is refused, since a reference listing its columns in that other order
 * must hold them alike (`btreeTupleBytes`).
 */
export const inOrderTupleBytes = (datums: ReadonlyArray<Datum>): number => {
	const laid = Arr.reduce(datums, { end: indexTupleHeader, exact: true }, ({ end, exact }, d) => ({
		end: exact ? Math.ceil(end / d.align) * d.align + d.bytes : end + d.align - 1 + d.bytes,
		exact: exact && d.fixed
	}))
	return maxalign(laid.end)
}

/**
 * The GiST key representation of a scalar datum (contrib/btree_gist): a fixed type stores its lower and upper bound
 * side by side, twice its typlen (int16KEY {lower, upper} and the rest), numeric and text both bounds as varlenas inside
 * one varlena (btree_utils_var.c), and a range is its own key under range_ops.
 */
type FixedGistFamily =
	| "int2"
	| "int4"
	| "int8"
	| "float4"
	| "float8"
	| "money"
	| "bool"
	| "uuid"
	| "date"
	| "code"

/** A set over a roster is bit(n), a varlena, which btree_gist keys as it keys text (btree_bit.c over gbt_var), and so
 * is a key's image, a bytea (btree_bytea.c). An inet or cidr is a varlena core's inet_ops keys by a GistInetKey no
 * longer than the datum (network_gist.c), so its key is at most its datum. */
type GistFamily =
	| FixedGistFamily
	| "inet"
	| "numeric"
	| "text"
	| "bit"
	| "bytea"
	| "range"
	| "vector"

/** An inet datum's most bytes: a varlena header, its family and mask length, and an IPv6 address's 16 bytes (inet.h). */
const inetBytes = 4 + 1 + 1 + 16

/** Each fixed family's typlen, its datum's bytes: a code is a smallint. */
export const fixedTyplens: { readonly [F in FixedGistFamily]: number } = {
	int2: typlens.int2,
	int4: typlens.int4,
	int8: typlens.int8,
	float4: typlens.float4,
	float8: typlens.float8,
	money: typlens.money,
	bool: typlens.bool,
	uuid: typlens.uuid,
	date: typlens.date,
	code: typlens.int2
}

const isFixedGistFamily = (family: GistFamily): family is FixedGistFamily => {
	switch (family) {
		case "int2":
		case "int4":
		case "int8":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "code":
			return true
		case "inet":
		case "numeric":
		case "text":
		case "bit":
		case "bytea":
		case "range":
		case "vector":
			return false
	}
}

export const gistKeyBytes = (family: Exclude<GistFamily, "vector">, bytes: number): number => {
	switch (family) {
		case "int2":
		case "int4":
		case "float4":
		case "code":
		case "int8":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
			return 2 * bytes
		case "numeric":
		case "text":
		case "bit":
		case "bytea":
			return 4 + Math.ceil(bytes / 4) * 4 + bytes
		case "inet":
		case "range":
			return bytes
	}
}

/**
 * The most bytes a GiST tuple over the keys reaches: the header, each key after up to MAXALIGN - 1 bytes of padding,
 * the whole MAXALIGNed.
 */
export const gistTupleBytes = (keys: ReadonlyArray<number>): number =>
	maxalign(Arr.reduce(keys, indexTupleHeader, (size, k) => size + 7 + k))

/** A span key's scalar component as drawn: a fixed type, or ASCII text of a bounded pattern. */
type SpanScalar =
	| { readonly kind: "fixed"; readonly type: FixedType }
	| { readonly kind: "text"; readonly length: number }

/** A span key's fixed scalar's family. */
export const spanScalarFamily = (
	s: Extract<SpanScalar, { readonly kind: "fixed" }>
): FixedGistFamily => {
	switch (s.type) {
		case "smallint":
			return "int2"
		case "integer":
			return "int4"
		case "bigint":
			return "int8"
		case "real":
			return "float4"
		case "double precision":
			return "float8"
		case "money":
			return "money"
		case "boolean":
			return "bool"
		case "uuid":
			return "uuid"
		case "closedId":
			return "code"
	}
}

export const scalars = (n: number): Record<string, FieldBase> =>
	Rec.fromEntries(
		Arr.map(indices(n), (i) => [`f${pipe(String(i), Str.padStart(2, "0"))}`, rawPg.boolean])
	)

/** A key's other field beside its text, for keyTextBytes: a fixed-width type, or a text an octet_length contract bounds. */
type Companion =
	| { readonly kind: "fixed"; readonly type: FixedType }
	| { readonly kind: "octets"; readonly bytes: number }

const companionDatum = (c: Companion): Datum =>
	c.kind === "fixed" ? fixedDatum[c.type] : varlena(c.bytes)

const companionDescriptor = (c: Companion, i: number): FieldBase =>
	c.kind === "fixed"
		? fixedDescriptor(c.type)
		: rawContract(`Beside${i}`, wildcard, octetLengthAtMost(c.bytes))

const companionGen: Gen<Companion> = weighted<Companion>([
	[4, map(element(fixedTypes), (type): Companion => ({ kind: "fixed", type }))],
	[1, map(int(0, 300), (bytes): Companion => ({ kind: "octets", bytes }))]
])

/**
 * The budget restated: BTMaxItemSize less the header and the null bitmap, MAXALIGNed to 16 bytes, every datum beside
 * the text at its worst padding, align - 1, and the text's own 4-byte header after its worst padding of 3, which bounds
 * the entry whatever the index's order and whichever of its columns may be NULL.
 */
export const budgetOf = (companions: ReadonlyArray<Companion>): number =>
	postgresBtreeMaxItem -
	Arr.reduce(companions, 16, (end, c) => {
		const d = companionDatum(c)
		return end + d.align - 1 + d.bytes
	}) -
	3 -
	4

/** The data offset of a tuple: past the header, and past the null bitmap, MAXALIGNed to 16, where a column may be
 * NULL. */
const dataOffset = (nullable: boolean): number => (nullable ? 16 : indexTupleHeader)

/**
 * The index a text of keyTextBytes(fields) bytes sits in beside those fields: a key declared over them; a key over a
 * selection of their relation, whose columns are law columns that may hold NULL; or the UNIQUE of a family axis that
 * carries the text as a concat fold's running value: an ordered family's, Line's (doc, at, ‹s›, after), its successor
 * ‹s› a law column of no NULL, beside a uuid and two naturals; a tree's predecessor axis's, Node's root field doc, its
 * parent, a law column that may hold NULL, its slot, its successor, its end and its running text, beside a uuid and
 * four naturals.
 */
type KeyArm = "declared key" | "key over a selection"

type BudgetArm = KeyArm | "ordered axis" | "tree axis"

/** How the text's bound is written: a contract over its octet_length, or str.bytes, which feeds the budget directly. */
type Spelling = "a contract" | "str.bytes"

const spellings: Arr.NonEmptyReadonlyArray<Spelling> = ["a contract", "str.bytes"]

type BudgetCase =
	| {
			readonly arm: KeyArm
			readonly companions: Arr.NonEmptyReadonlyArray<Companion>
			readonly position: number
			readonly spelling: Spelling
	  }
	| { readonly arm: "ordered axis" | "tree axis"; readonly spelling: Spelling }

export const budgetCaseGen: Gen<BudgetCase> = weighted<BudgetCase>([
	[
		4,
		(source): BudgetCase => {
			const companions = source.draw(nonEmptyOf(companionGen, 4))
			return {
				arm: source.draw(element<KeyArm>(["declared key", "key over a selection"])),
				companions,
				position: source.draw(int(0, companions.length)),
				spelling: source.draw(element(spellings))
			}
		}
	],
	[
		1,
		(source): BudgetCase => ({
			arm: source.draw(element<"ordered axis" | "tree axis">(["ordered axis", "tree axis"])),
			spelling: source.draw(element(spellings))
		})
	]
])

export type BudgetFeature =
	| BudgetArm
	| Spelling
	| "tight"
	| "slack"
	| "text first"
	| "text last"
	| "text between"
	| "a text beside it"

/** The key of KeyText, the fixture's own contract, which a mint of its values takes (keyText). */
const keyTextKey = Symbol("KeyText")

/**
 * A text bounded at `bytes`, over the wildcard, and the keys a field grizzle fills with its values takes
 * (scalar/contract.ts admitMintKey): by a contract over its octet_length, KeyText, a consumer's, accumulated under its
 * key, or by str.bytes, under none.
 */
const keyText = (
	bytes: number,
	spelling: Spelling
): { readonly field: FieldBase; readonly mint: ReadonlyArray<symbol> } =>
	spelling === "a contract"
		? { field: rawContract("KeyText", wildcard, octetLengthAtMost(bytes)), mint: [keyTextKey] }
		: { field: str.bytes(bytes, wildcard), mint: [] }

/** The installation of a schema value: every index its law model plans, each entry proved or refused. */
export const installed = (value: unknown) =>
	Result.flatMap(ownValue(value), (owned) => compileInstallation(owned, installOptions(owned)))

/**
 * Doc's lines in order and the concat fold of their pieces into Doc.text, each text bounded at `bytes`: the axis's
 * UNIQUE is Line's (doc, at, ‹s›, after), ‹s› the natural successor each line holds.
 */
const orderedAxis = (bytes: number, spelling: Spelling) => {
	const text = keyText(bytes, spelling)
	const Doc = relation(
		"Doc",
		{ id: Id, n: drawnField(natural, []), text: accumulatedField(text.field, "", text.mint) },
		["id"],
		[]
	)
	const Line = relation(
		"Line",
		{
			doc: Id,
			at: drawnField(natural, []),
			piece: text.field,
			before: accumulatedField(text.field, "", text.mint),
			after: accumulatedField(text.field, "", text.mint)
		},
		["doc", "at"],
		[]
	)
	const lines = orderedBuilder(onBuilder(Line, ["doc", "at"]), finBuilder(Doc, "n"))
	const statements: ReadonlyArray<Statement> = [
		lines,
		foldBuilder(
			lines,
			monoids.concat,
			onBuilder(Line, ["doc", "piece", "before", "after"]),
			onBuilder(Doc, ["id", "text"])
		)
	]
	return schema("Axis", [Doc, Line], statements, [])
}

/**
 * A tree of nodes keyed by their root field doc and their start, and the concat fold of their pieces along it, each
 * text bounded at `bytes`: its predecessor axis's UNIQUE holds the root field, the parent as a law column that may hold
 * NULL, the slot, the node's successor, its end and the running text, the tree's own pair before the fold's.
 */
const treeAxis = (bytes: number, spelling: Spelling) => {
	const text = keyText(bytes, spelling)
	const Node = relation(
		"Node",
		{
			doc: Id,
			parent: drawnField(natural, []),
			at: drawnField(natural, []),
			children: drawnField(natural, []),
			start: drawnField(natural, []),
			end: drawnField(natural, []),
			piece: text.field,
			before: accumulatedField(text.field, "", text.mint),
			after: accumulatedField(text.field, "", text.mint),
			total: accumulatedField(text.field, "", text.mint)
		},
		["doc", "start"],
		[]
	)
	const nodes = treeBuilder(onBuilder(Node, ["parent", "at"]), finBuilder(Node, "children"), {
		root: ["doc"]
	})
	const statements: ReadonlyArray<Statement> = [
		nodes,
		foldBuilder(
			nodes,
			monoids.concat,
			onBuilder(Node, ["doc", "parent", "piece", "before", "after"]),
			onBuilder(Node, ["doc", "start", "total"])
		)
	]
	return schema("Tree", [Node], statements, [])
}

const uuidCompanion: Companion = { kind: "fixed", type: "uuid" }

const naturalCompanion: Companion = { kind: "fixed", type: "bigint" }

/**
 * What an arm reads of a case: the fields keyTextBytes is given, as descriptors and as the companions they lay out as;
 * the arm's schema with its text bounded at so many bytes; and the most bytes its index's entry reaches with a text of
 * so many bytes in any order of its columns, restated (`anyOrderEnd`), which decides whether the schema compiles.
 */
interface Arm {
	readonly fields: ReadonlyArray<FieldBase>
	readonly companions: ReadonlyArray<Companion>
	readonly schemaAt: (bytes: number) => unknown
	readonly entryAt: (bytes: number) => number
}

/** A key over the companions and the text at its position: declared, or over the selection of its relation's live rows. */
const keyArm = (s: Extract<BudgetCase, { readonly arm: KeyArm }>): Arm => {
	const descriptors = Arr.map(s.companions, companionDescriptor)
	const selected = s.arm === "key over a selection"
	return {
		fields: descriptors,
		companions: s.companions,
		schemaAt: (bytes) => {
			const named = Arr.map(descriptors, (d, i): readonly [string, FieldBase] => [`c${i}`, d])
			const text: readonly [string, FieldBase] = ["t", keyText(bytes, s.spelling).field]
			const fields = [...Arr.take(named, s.position), text, ...Arr.drop(named, s.position)]
			const names = Arr.map(fields, ([n]) => n)
			if (!selected) {
				return schema("Budget", [Kind, relation("R", Rec.fromEntries(fields), names, [])], [], [])
			}
			const R = relation(
				"R",
				{ id: Id, live: rawPg.boolean, ...Rec.fromEntries(fields) },
				["id"],
				[]
			)
			const statements: ReadonlyArray<Statement> = [
				keyBuilder(
					onBuilder(
						selectBuilder(R, (r: Row & { readonly live: Row["id"] }) => r.eq(r.live, true)),
						names
					)
				)
			]
			return schema("Budget", [Kind, R], statements, [])
		},
		entryAt: (bytes) =>
			maxalign(
				anyOrderEnd(dataOffset(selected), [
					...Arr.map(s.companions, companionDatum),
					varlena(bytes)
				])
			)
	}
}

export const armOf = (s: BudgetCase): Arm => {
	switch (s.arm) {
		case "declared key":
		case "key over a selection":
			return keyArm(s)
		case "ordered axis":
			return {
				fields: [Id, natural, natural],
				companions: [uuidCompanion, naturalCompanion, naturalCompanion],
				schemaAt: (bytes) => orderedAxis(bytes, s.spelling),
				entryAt: (bytes) =>
					maxalign(
						anyOrderEnd(dataOffset(false), [
							companionDatum(uuidCompanion),
							companionDatum(naturalCompanion),
							companionDatum(naturalCompanion),
							varlena(bytes)
						])
					)
			}
		case "tree axis":
			return {
				fields: [Id, natural, natural, natural, natural],
				companions: [
					uuidCompanion,
					naturalCompanion,
					naturalCompanion,
					naturalCompanion,
					naturalCompanion
				],
				schemaAt: (bytes) => treeAxis(bytes, s.spelling),
				entryAt: (bytes) =>
					maxalign(
						anyOrderEnd(dataOffset(true), [
							companionDatum(uuidCompanion),
							companionDatum(naturalCompanion),
							companionDatum(naturalCompanion),
							companionDatum(naturalCompanion),
							companionDatum(naturalCompanion),
							varlena(bytes)
						])
					)
			}
	}
}

/** Where a key case's text stands among its companions, and whether one of them is a text too. */
export const keyFeatures = (s: BudgetCase): ReadonlyArray<BudgetFeature> => {
	switch (s.arm) {
		case "ordered axis":
		case "tree axis":
			return []
		case "declared key":
		case "key over a selection": {
			const position: BudgetFeature =
				s.position === 0
					? "text first"
					: s.position === s.companions.length
						? "text last"
						: "text between"
			return Arr.some(s.companions, (x) => x.kind === "octets")
				? [position, "a text beside it"]
				: [position]
		}
	}
}

export const spanScalarGen: Gen<SpanScalar> = weighted([
	[3, map(element(fixedTypes), (type): SpanScalar => ({ kind: "fixed", type }))],
	[1, map(int(0, 40), (length): SpanScalar => ({ kind: "text", length }))]
])

export type SpanKeyFeature =
	| "two spans"
	| "the span alone, refused as a primary key"
	| "span first"
	| "span inside"
	| "span last"
	| "int4range"
	| "int8range"

export type GistFeature = "vector refused" | "within a GiST page" | "above a GiST page"

const gistFamilies: Arr.NonEmptyReadonlyArray<GistFamily> = [
	"int2",
	"int4",
	"int8",
	"float4",
	"float8",
	"money",
	"bool",
	"uuid",
	"code",
	"numeric",
	"text",
	"bit",
	"bytea",
	"range",
	"vector",
	"inet"
]

/** A drawn datum: a fixed family's bytes are its typlen, an inet's its longest, and numeric, text and range draw theirs. */
export const gistDatumGen: Gen<{ readonly family: GistFamily; readonly bytes: number }> = (
	source
) => {
	const family = source.draw(element(gistFamilies))
	return {
		family,
		bytes:
			family === "inet"
				? inetBytes
				: isFixedGistFamily(family)
					? fixedTyplens[family]
					: source.draw(int(5, 3000))
	}
}

/**
 * The key's other fields: bounded scalar types, each with a btree_gist operator class, so a key of at most three of
 * them, a span and nothing else is always representable.
 */
const scalarKeyFields: Arr.NonEmptyReadonlyArray<FieldBase> = [
	Id,
	rawPg.bigint,
	rawPg.integer,
	rawPg.smallint,
	rawPg.boolean,
	regex("^[a-z]{1,8}$", "u")
]

interface VectorKeySketch {
	/** Picks into scalarKeyFields: the key's other fields, k0..k2. */
	readonly scalars: ReadonlyArray<FieldBase>
	/** The key also holds during: span(int8). */
	readonly span: boolean
	/** The vector's dimension. */
	readonly dimensions: number
	/** The vector under bareContract("Embedding", vector(d)). */
	readonly contract: boolean
	/** In the primary key, or in a candidate key(on(R, ...)). */
	readonly primary: boolean
}

/**
 * The dimension ranges over pgvector's whole range, and one draw in two is a vector of at most 64 dimensions, small
 * enough for a B-tree entry, which the last required feature checks. The key holds at most five fields, far below
 * INDEX_MAX_KEYS.
 */
export const vectorKeySketchGen: Gen<VectorKeySketch> = (source) => ({
	scalars: source.draw(array(element(scalarKeyFields), { min: 1, max: 3 })),
	span: source.draw(boolean),
	dimensions: source.draw(
		weighted([
			[1, int(1, vectorMaxDimensions)],
			[1, int(1, 64)]
		])
	),
	contract: source.draw(boolean),
	primary: source.draw(boolean)
})

export type VectorKeyFeature =
	| "vector in the primary key"
	| "vector in a candidate key"
	| "contract over a vector"
	| "vector beside a span refused"
	| "a vector key admitted"
	| "a vector key above the B-tree limit"

/** The production bound of a key field's datum; every field the sketch draws has one. */
export const boundOf = (descriptor: FieldBase): DatumBound => {
	const bound = datumBound(descOf(descriptor))
	if (bound === undefined) {
		return assert.fail("a bounded key field: text whose pattern proves no byte bound")
	}
	return bound
}

/**
 * A case of a selected key over a text of no byte bound: the text first among the key's terms, so it is the side's
 * guarded term (laws/model/plan.ts sideColumns), beside `companions` of the budget box's kinds, over the selection of
 * R's live rows.
 */
export interface GuardedTextCase {
	readonly companions: ReadonlyArray<Companion>
}

export const guardedTextCaseGen: Gen<GuardedTextCase> = (source) => ({
	companions: source.draw(array(companionGen, { min: 0, max: 3 }))
})

/** The guarded text case's schema: R(id, live, t, c0…), keyed over select(R, live = true) on (t, c0…). */
export const guardedTextSchemaOf = (c: GuardedTextCase) => {
	const named = Arr.map(c.companions, (x, i): readonly [string, FieldBase] => [
		`c${i}`,
		companionDescriptor(x, i)
	])
	const R = relation(
		"R",
		{ id: Id, live: rawPg.boolean, t: str.regex("^.*$", "su"), ...Rec.fromEntries(named) },
		["id"],
		[]
	)
	return schema(
		"Guarded",
		[Kind, R],
		[
			keyBuilder(
				onBuilder(
					selectBuilder(R, (r: Row & { readonly live: Row["id"] }) => r.eq(r.live, true)),
					["t", ...Arr.map(named, ([n]) => n)]
				)
			)
		],
		[]
	)
}
