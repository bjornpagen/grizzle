import { describe, it } from "@effect/vitest"
import { drawn, explore, sketched } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	weighted
} from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Option,
	Order,
	pipe,
	Record as Rec,
	String as Str
} from "effect"
import * as Result from "#compiler/core/result.ts"
import { vectorMaxDimensions } from "#compiler/ir/carriers.ts"
import type { ExprDesc, FieldDesc } from "#compiler/ir/desc.ts"
import { closed, relation, relationDescOf } from "#compiler/schema/relation.ts"
import {
	btreeEntryBytes,
	btreeMaxItemSize,
	charLengthBound,
	type DatumBound,
	datumBound,
	gistEntryBytes,
	keyLayout,
	textByteBound
} from "#compiler/schema/representability.ts"
import { schema } from "#compiler/schema/schema.ts"
import { key } from "#compiler/schema/statements.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { assert, defined, refused, succeeded } from "#test/support/assert.ts"
import { indices } from "#test/support/oracle/pick.ts"
import { pickGen, pickIndex, pickSpan } from "#test/support/pick.ts"
import { ownedInput } from "#test/support/policy.ts"
import {
	bareContract,
	charLengthAtMost,
	closedId,
	rawContract,
	descOf,
	rawPg,
	regex,
	span,
	uuid,
	wildcard
} from "#test/unit/schema/support.ts"

import { regex as arkregex } from "arkregex"
/**
 * Key representability: every primary and candidate key
 * must fit its index entry for every value its fields admit, or ownership refuses it with UnrepresentableKey naming the
 * key and the bound that failed.
 *
 * The oracles restate PostgreSQL rather than read src: the B-tree item limit and the per-type datum sizes and alignments
 * of pg_type, numeric.c's numeric_maximum_size, btree_gist's key representations, and the longest match of a pattern
 * computed from the pattern as drawn, witnessed by the host's own RegExp over the same language spelled greedy and
 * widest first.
 *
 * PostgreSQL's INDEX_MAX_KEYS (pg_config_manual.h), restated: the most columns an index, and so a key, holds.
 */
const postgresIndexMaxKeys = 32
/** BTMaxItemSize for the default 8192-byte block (nbtree.h), restated. */
const postgresBtreeMaxItem = 2704
/** An empty GiST page, GiSTPageSize (8192 - 24 - 16), less one line pointer (gist.c gistfitpage), restated. */
const postgresGistMaxItem = 8148
/** The index tuple header (IndexTupleData) and MAXALIGN of the pinned 64-bit build. */
const indexTupleHeader = 8
const maxalign = (n: number): number => Math.ceil(n / 8) * 8

const utf8 = new TextEncoder()
const utf8Bytes = (text: string): number => utf8.encode(text).length

/** The ownership of a schema value at the schema door. */
const ownValue = (value: unknown) => ownedInput(value)

const ownOne = (r: AnyRelation | AnyClosed, statements: ReadonlyArray<Statement>) =>
	ownValue(schema("Keys", { r }, statements))

/** The field Descriptions of a relation, read through its accessor. */
const fieldDescsOf = (r: unknown): Readonly<Record<string, FieldDesc>> => {
	const desc = relationDescOf(r, "test")
	if (desc.kind !== "relation") {
		throw new Error(`${desc.name} is not an ordinary relation`)
	}
	return desc.fields
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

const patternSource = (alternatives: ReadonlyArray<TopAlternative>): string =>
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
	a.kind === "symbol" ? a.symbol.bytes : Math.max(...Arr.map(a.alternatives, sequenceBytes))

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

const sequenceBytes = (items: RegexSequence): number =>
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
const greedyAlternatives = (alternatives: Arr.NonEmptyReadonlyArray<TopAlternative>) =>
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

const sequenceWitness = (items: RegexSequence): string => Arr.join(Arr.map(items, itemWitness), "")

/** A nonempty list: a first element and up to `more` others. */
const nonEmpty = <A>(arb: Gen<A>, more: number): Gen<Arr.NonEmptyReadonlyArray<A>> =>
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
								nonEmpty(array(regexItemGen(depth - 1), { min: 0, max: 3 }), 2)
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

const patternSketchGen: Gen<PatternSketch> = (source) => ({
	alternatives: source.draw(nonEmpty(array(regexItemGen(2), { min: 0, max: 4 }), 2)),
	defect: source.draw(
		element<RegexDefect>([
			"none",
			"none",
			"none",
			"no start anchor",
			"no end anchor",
			"unbounded repetition",
			"back-reference",
			"long run"
		])
	),
	at: source.draw(pickGen),
	spelling: source.draw(element<"*" | "+" | "{2,}">(["*", "+", "{2,}"])),
	flags: source.draw(element<"u" | "su">(["u", "su"]))
})

/** The top-level alternatives with the defect planted in the one `at` picks. */
const plantedAlternatives = (s: PatternSketch): Arr.NonEmptyReadonlyArray<TopAlternative> => {
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

type RegexFeature =
	| "bounded"
	| "exact"
	| "long run"
	| "unanchored"
	| "unbounded repetition"
	| "back-reference"
	| "lookaround"
	| "four-byte code point"
	| "group alternation"

const hasItem = (items: RegexSequence, holds: (item: RegexItem) => boolean): boolean =>
	Arr.some(
		items,
		(item) =>
			holds(item) ||
			(item.kind === "quantified" &&
				item.atom.kind === "group" &&
				Arr.some(item.atom.alternatives, (alt) => hasItem(alt, holds)))
	)

describe("pattern byte bounds", () => {
	it.effect(
		"bounds a pattern's key by at least its longest match in UTF-8 bytes, and by nothing when its language is infinite",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/schema/pattern-byte-bound",
						draw: drawn(patternSketchGen),
						literal: Formatter.format,
						features: features<RegexFeature>([
							"bounded",
							"exact",
							"long run",
							"unanchored",
							"unbounded repetition",
							"back-reference",
							"lookaround",
							"four-byte code point",
							"group alternation"
						]),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(s, c) =>
						Effect.sync(() => {
							const alternatives = plantedAlternatives(s)
							const source = patternSource(alternatives)
							const bound = textByteBound({ kind: "text", source, flags: s.flags })
							const anchored = Arr.every(alternatives, (a) => a.start && a.end)
							const longest = Math.max(...Arr.map(alternatives, (a) => sequenceBytes(a.items)))
							if (
								Arr.some(alternatives, (a) =>
									hasItem(a.items, (item) => item.kind === "lookaround")
								)
							) {
								c.note("lookaround")
							}
							if (s.defect === "back-reference") {
								c.note("back-reference")
								return
							}
							if (!anchored || !Number.isFinite(longest)) {
								c.note(!anchored ? "unanchored" : "unbounded repetition")
								assert.equal(bound, Number.POSITIVE_INFINITY, source)
								return
							}
							const greedy = greedyAlternatives(alternatives)
							const [widest] = greedy
							const witness = sequenceWitness(widest.items)
							assert.equal(utf8Bytes(witness), longest, `the witness of ${source}`)
							const firstPath = patternSource(greedy)
							assert.ok(
								arkregex.as(firstPath, s.flags).test(witness),
								`${source}, spelled greedy and widest first as ${firstPath}, matches its witness`
							)
							if (Arr.some(Arr.fromIterable(witness), (ch) => utf8Bytes(ch) === 4)) {
								c.note("four-byte code point")
							}
							if (
								alternatives.length > 1 ||
								hasItem(
									widest.items,
									(item) => item.kind === "quantified" && item.atom.kind === "group"
								)
							) {
								c.note("group alternation")
							}
							c.note(s.defect === "long run" ? "long run" : "bounded")
							assert.ok(
								bound >= longest,
								`${source}: bound ${bound} below its longest match ${longest}`
							)
							if (bound === longest) {
								c.note("exact")
							}
						})
				)
			)
	)
})

/**
 * A conjunct of a contract predicate over char_length(VALUE) =: L, as drawn: a comparison with a literal on either
 * side (a number or a bigint), between (low <= high), in (a nonempty list), a disjunction of two upper bounds, which
 * bounds L but is no form the reader recognizes, or a test of the value that leaves L free.
 */
type LengthConjunct =
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

const charLengthOfValue: ExprDesc = { kind: "compute", fn: "charLength", args: [{ kind: "value" }] }

const lengthLiteral = (n: number, bigint: boolean): ExprDesc => ({
	kind: "literal",
	value: bigint ? BigInt(n) : n,
	type: undefined
})

const conjunctExpr = (c: LengthConjunct): ExprDesc => {
	switch (c.kind) {
		case "compare":
			return c.mirrored
				? {
						kind: "compare",
						op: c.op,
						left: lengthLiteral(c.n, c.bigint),
						right: charLengthOfValue
					}
				: {
						kind: "compare",
						op: c.op,
						left: charLengthOfValue,
						right: lengthLiteral(c.n, c.bigint)
					}
		case "between":
			return {
				kind: "between",
				arg: charLengthOfValue,
				low: lengthLiteral(c.low, false),
				high: lengthLiteral(c.high, false)
			}
		case "in":
			return { kind: "in", arg: charLengthOfValue, values: c.values }
		case "or":
			return {
				kind: "or",
				args: [
					{
						kind: "compare",
						op: "le",
						left: charLengthOfValue,
						right: lengthLiteral(c.left, false)
					},
					{
						kind: "compare",
						op: "le",
						left: charLengthOfValue,
						right: lengthLiteral(c.right, false)
					}
				]
			}
		case "other":
			return {
				kind: "compare",
				op: "ne",
				left: { kind: "value" },
				right: { kind: "literal", value: "zz", type: undefined }
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

/** Whether a conjunct holds of a value of char_length L. */
const holdsAt = (c: LengthConjunct, length: number): boolean => {
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
const boundsAbove = (c: LengthConjunct): boolean =>
	c.kind === "between" ||
	c.kind === "in" ||
	(c.kind === "compare" &&
		(c.mirrored
			? c.op === "ge" || c.op === "gt" || c.op === "eq"
			: c.op === "le" || c.op === "lt" || c.op === "eq"))

/** Lengths past every drawn literal, and below zero, where an upper bound's arithmetic may land. */
const lengthsScanned = Arr.map(indices(141), (i) => 100 - i)

/** The lengths of the scanned range, from least up, the conjuncts all hold of, largest first. */
const holdingLengths = (
	conjuncts: ReadonlyArray<LengthConjunct>,
	least: number
): ReadonlyArray<number> =>
	Arr.filter(
		lengthsScanned,
		(length) => length >= least && Arr.every(conjuncts, (c) => holdsAt(c, length))
	)

interface LengthSketch {
	readonly conjuncts: Arr.NonEmptyReadonlyArray<LengthConjunct>
	/** The conjuncts after the first written as a conjunction of their own. */
	readonly nested: boolean
	/** The contract's base: the wildcard, or ^[A-Z]{k}$ of k bytes. */
	readonly base: { readonly kind: "wildcard" } | { readonly kind: "letters"; readonly k: number }
}

const lengthConjunctGen: Gen<LengthConjunct> = weighted([
	[
		4,
		map(
			(source) => ({
				op: source.draw(
					element<"le" | "lt" | "eq" | "ge" | "gt" | "ne">(["le", "lt", "eq", "ge", "gt", "ne"])
				),
				n: source.draw(int(-3, 60)),
				mirrored: source.draw(boolean),
				bigint: source.draw(boolean)
			}),
			(r): LengthConjunct => ({ kind: "compare", ...r })
		)
	],
	[
		1,
		map(
			(source) => ({ low: source.draw(int(0, 40)), more: source.draw(int(0, 20)) }),
			({ low, more }): LengthConjunct => ({ kind: "between", low, high: low + more })
		)
	],
	[
		1,
		map(nonEmpty(int(0, 60), 3), (values): LengthConjunct => ({
			kind: "in",
			values
		}))
	],
	[
		1,
		map(
			(source) => ({ left: source.draw(int(0, 60)), right: source.draw(int(0, 60)) }),
			(r): LengthConjunct => ({ kind: "or", ...r })
		)
	],
	[1, constant<LengthConjunct>({ kind: "other" })]
])

type LengthFeature =
	| "bounded"
	| "unbounded"
	| "satisfiable"
	| "base tighter"
	| "length tighter"
	| "mirrored"

describe("charLength bounds", () => {
	it.effect(
		"reads a charLength bound from a contract predicate, four bytes per code point",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/schema/charlength-bound",
						draw: drawn((source) => ({
							conjuncts: source.draw(nonEmpty(lengthConjunctGen, 3)),
							nested: source.draw(boolean),
							base: source.draw(
								oneOf([
									constant<LengthSketch["base"]>({ kind: "wildcard" }),
									map(int(1, 200), (k): LengthSketch["base"] => ({ kind: "letters", k }))
								])
							)
						})),
						literal: Formatter.format,
						features: features<LengthFeature>([
							"bounded",
							"unbounded",
							"satisfiable",
							"base tighter",
							"length tighter",
							"mirrored"
						]),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(s, c) =>
						Effect.sync(() => {
							const [first, ...rest] = s.conjuncts
							const tail = Arr.map(rest, conjunctExpr)
							const predicate: ExprDesc =
								rest.length === 0
									? conjunctExpr(first)
									: s.nested
										? { kind: "and", args: [conjunctExpr(first), { kind: "and", args: tail }] }
										: { kind: "and", args: [conjunctExpr(first), ...tail] }
							const bound = charLengthBound(predicate)
							if (
								Arr.some(s.conjuncts, (x) => x.kind === "compare" && x.mirrored && boundsAbove(x))
							) {
								c.note("mirrored")
							}
							const upper = Arr.filter(s.conjuncts, boundsAbove)
							if (upper.length === 0) {
								c.note("unbounded")
								assert.equal(bound, Number.POSITIVE_INFINITY)
							} else {
								c.note("bounded")
								assert.ok(Number.isFinite(bound), "a bound from an upper-bounding conjunct")
								for (const u of upper) {
									assert.ok(
										bound <= defined(holdingLengths([u], -40)[0]),
										`no looser than ${u.kind}`
									)
								}
								const [reached] = holdingLengths(s.conjuncts, 0)
								if (reached !== undefined) {
									c.note("satisfiable")
									assert.ok(reached <= bound, `sound: the length ${reached} holds, above ${bound}`)
								}
							}
							const base: FieldDesc =
								s.base.kind === "wildcard"
									? { kind: "text", source: "^.*$", flags: "su" }
									: { kind: "text", source: `^[A-Z]{${s.base.k}}$`, flags: "u" }
							const lengthBytes = 4 * Math.max(0, bound)
							const baseBytes = s.base.kind === "wildcard" ? Number.POSITIVE_INFINITY : s.base.k
							const expected = Math.min(lengthBytes, baseBytes)
							if (Number.isFinite(lengthBytes) && Number.isFinite(baseBytes)) {
								c.note(baseBytes < lengthBytes ? "base tighter" : "length tighter")
							}
							assert.equal(
								textByteBound({ kind: "contract", name: "Memo", base, predicate }),
								expected
							)
						})
				)
			)
	)
})

/**
 * A key field as drawn, over pg_type's sizes and alignments: a fixed-width type, numeric(p, s), bare numeric,
 * text of a bounded pattern (ASCII, or any code point), the wildcard, or a contract over the wildcard bounding
 * char_length.
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
	| "bigserial"
	| "serial"
	| "closedId"

type KeyFieldSketch =
	| { readonly kind: "fixed"; readonly type: FixedType }
	| { readonly kind: "numeric"; readonly precision: number; readonly scale: number }
	| { readonly kind: "bare numeric" }
	| { readonly kind: "ascii text"; readonly length: number }
	| { readonly kind: "any text"; readonly length: number }
	| { readonly kind: "wildcard" }
	| { readonly kind: "bounded contract"; readonly length: number }

interface Datum {
	readonly bytes: number
	readonly align: number
}

/** pg_type's typlen and typalign of each fixed key type: an enum is an oid, a serial its integer type. */
const fixedDatum: Readonly<Record<FixedType, Datum>> = {
	smallint: { bytes: 2, align: 2 },
	integer: { bytes: 4, align: 4 },
	bigint: { bytes: 8, align: 8 },
	real: { bytes: 4, align: 4 },
	"double precision": { bytes: 8, align: 8 },
	money: { bytes: 8, align: 8 },
	boolean: { bytes: 1, align: 1 },
	uuid: { bytes: 16, align: 1 },
	bigserial: { bytes: 8, align: 8 },
	serial: { bytes: 4, align: 4 },
	closedId: { bytes: 4, align: 4 }
}

/** A varlena datum with its 4-byte header, int-aligned. */
const varlena = (bytes: number): Datum => ({ bytes: 4 + bytes, align: 4 })

/**
 * The widest datum a key field admits, or that nothing bounds it: numeric(p, s) is at most
 * numeric_maximum_size, NUMERIC_HDRSZ (8) plus a NumericDigit (2 bytes) for each of (p + 2 * (DEC_DIGITS - 1)) /
 * DEC_DIGITS base-10000 digits (numeric.c); text is its bytes, four per code point unless pinned to ASCII.
 */
type DatumBoundOf =
	| { readonly kind: "bounded"; readonly datum: Datum }
	| { readonly kind: "unbounded" }

const datumOf = (f: KeyFieldSketch): DatumBoundOf => {
	switch (f.kind) {
		case "fixed":
			return { kind: "bounded", datum: fixedDatum[f.type] }
		case "numeric":
			return {
				kind: "bounded",
				datum: { bytes: 8 + 2 * Math.floor((f.precision + 6) / 4), align: 4 }
			}
		case "ascii text":
			return { kind: "bounded", datum: varlena(f.length) }
		case "any text":
		case "bounded contract":
			return { kind: "bounded", datum: varlena(4 * f.length) }
		case "bare numeric":
		case "wildcard":
			return { kind: "unbounded" }
	}
}

/** The bounded datums of the fields: as many as the fields exactly when every one is bounded. */
const boundedDatums = (fields: ReadonlyArray<KeyFieldSketch>): ReadonlyArray<Datum> =>
	Arr.flatMap(fields, (f) => {
		const d = datumOf(f)
		return d.kind === "bounded" ? [d.datum] : []
	})

/**
 * The most bytes a B-tree tuple over the datums reaches: the header, each datum after its worst-case alignment padding,
 * the whole MAXALIGNed.
 */
const btreeTupleBytes = (datums: ReadonlyArray<Datum>): number =>
	maxalign(Arr.reduce(datums, indexTupleHeader, (size, d) => size + d.align - 1 + d.bytes))

const Kind = closed("Kind", ["A", "B"])

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
			return uuid
		case "bigserial":
			return rawPg.bigserial
		case "serial":
			return rawPg.serial
		case "closedId":
			return closedId(Kind)
	}
}

const keyFieldDescriptor = (f: KeyFieldSketch, i: number): FieldBase => {
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
	"bigserial",
	"serial",
	"closedId"
]

const keyFieldGen: Gen<KeyFieldSketch> = weighted([
	[4, map(element(fixedTypes), (type): KeyFieldSketch => ({ kind: "fixed", type }))],
	[
		2,
		map(
			(source) => ({
				precision: source.draw(oneOf([int(1, 40), int(1, 1000)])),
				scale: source.draw(int(0, 10))
			}),
			({ precision, scale }): KeyFieldSketch => ({
				kind: "numeric",
				precision,
				scale: Math.min(scale, precision)
			})
		)
	],
	[1, constant<KeyFieldSketch>({ kind: "bare numeric" })],
	[2, map(int(0, 40), (length): KeyFieldSketch => ({ kind: "ascii text", length }))],
	[1, map(int(0, 40), (length): KeyFieldSketch => ({ kind: "any text", length }))],
	[1, constant<KeyFieldSketch>({ kind: "wildcard" })],
	[2, map(int(0, 700), (length): KeyFieldSketch => ({ kind: "bounded contract", length }))]
])

interface KeySizeSketch {
	readonly fields: Arr.NonEmptyReadonlyArray<KeyFieldSketch>
	readonly primary: boolean
	/**
	 * A last field planted to bring the entry to the item limit plus `delta` bytes, when the rest is bounded and leaves
	 * room for it.
	 */
	readonly boundary: { readonly kind: "none" } | { readonly kind: "at"; readonly delta: number }
}

/** The drawn fields, with the boundary field appended where one is planted. */
const sizedFields = (s: KeySizeSketch): ReadonlyArray<KeyFieldSketch> => {
	if (s.boundary.kind === "none") {
		return s.fields
	}
	const datums = boundedDatums(s.fields)
	if (datums.length < s.fields.length) {
		return s.fields
	}
	const before = Arr.reduce(datums, indexTupleHeader, (size, d) => size + d.align - 1 + d.bytes)
	const length = Math.floor((postgresBtreeMaxItem + s.boundary.delta - before - 3 - 4) / 4)
	return length < 0 ? s.fields : [...s.fields, { kind: "bounded contract", length }]
}

type KeySizeFeature =
	| "admitted"
	| "refused, unbounded"
	| "refused, over the limit"
	| "at the limit, admitted"
	| "at the limit, refused"
	| "primary"
	| "candidate"

/**
 * The GiST key representation of a scalar datum (contrib/btree_gist): a fixed type stores its lower and upper bound
 * side by side (gbtreekey4, 8, 16, 32; a bool two bytes), numeric and text both bounds as varlenas inside one varlena
 * (btree_utils_var.c), and a range is its own key under range_ops.
 */
type GistFamily =
	| "int2"
	| "int4"
	| "int8"
	| "float4"
	| "float8"
	| "money"
	| "bool"
	| "uuid"
	| "enum"
	| "numeric"
	| "text"
	| "range"
	| "vector"

const gistKeyBytes = (family: Exclude<GistFamily, "vector">, bytes: number): number => {
	switch (family) {
		case "int2":
			return 4
		case "int4":
		case "float4":
		case "enum":
			return 8
		case "int8":
		case "float8":
		case "money":
			return 16
		case "bool":
			return 2
		case "uuid":
			return 32
		case "numeric":
		case "text":
			return 4 + Math.ceil(bytes / 4) * 4 + bytes
		case "range":
			return bytes
	}
}

/**
 * The most bytes a GiST tuple over the keys reaches: the header, each key after up to MAXALIGN - 1 bytes of padding,
 * the whole MAXALIGNed.
 */
const gistTupleBytes = (keys: ReadonlyArray<number>): number =>
	maxalign(Arr.reduce(keys, indexTupleHeader, (size, k) => size + 7 + k))

/** A span key's scalar component as drawn: a fixed type, or ASCII text of a bounded pattern. */
type SpanScalar =
	| { readonly kind: "fixed"; readonly type: FixedType }
	| { readonly kind: "text"; readonly length: number }

const spanScalarFamily = (s: SpanScalar): Exclude<GistFamily, "vector" | "range"> => {
	if (s.kind === "text") {
		return "text"
	}
	switch (s.type) {
		case "smallint":
			return "int2"
		case "integer":
		case "serial":
			return "int4"
		case "bigint":
		case "bigserial":
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
			return "enum"
	}
}

const scalars = (n: number): Record<string, FieldBase> =>
	Rec.fromEntries(
		Arr.map(indices(n), (i) => [`f${pipe(String(i), Str.padStart(2, "0"))}`, rawPg.boolean])
	)

describe("B-tree entries (nbtree.h BTMaxItemSize)", () => {
	it.effect(
		"refuses a key with an unbounded field or a worst-case entry above the item limit, and admits every other",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/schema/btree-entry",
						draw: drawn((source) => ({
							fields: source.draw(nonEmpty(keyFieldGen, 4)),
							primary: source.draw(boolean),
							boundary: source.draw(
								oneOf([
									constant<KeySizeSketch["boundary"]>({ kind: "none" }),
									map(int(-8, 8), (delta): KeySizeSketch["boundary"] => ({ kind: "at", delta }))
								])
							)
						})),
						literal: Formatter.format,
						features: features<KeySizeFeature>([
							"admitted",
							"refused, unbounded",
							"refused, over the limit",
							"at the limit, admitted",
							"at the limit, refused",
							"primary",
							"candidate"
						]),
						kept: [],
						runs: 150,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(s, c) =>
						Effect.sync(() => {
							const fields = sizedFields(s)
							const planted = fields.length > s.fields.length
							c.note(s.primary ? "primary" : "candidate")
							const keyFields = Rec.fromEntries(
								Arr.map(fields, (f, i) => [`k${i}`, keyFieldDescriptor(f, i)])
							)
							const names = Rec.keys(keyFields)
							const R = s.primary
								? relation("R", keyFields, names)
								: relation("R", { id: uuid, ...keyFields }, ["id"])
							const owned = ownValue(schema("Keys", { Kind, R }, s.primary ? [] : [key(R, names)]))
							const bounded = boundedDatums(fields)
							if (bounded.length < fields.length) {
								c.note("refused, unbounded")
								refused(owned, "UnrepresentableKey")
								return
							}
							const admitted = btreeTupleBytes(bounded) <= postgresBtreeMaxItem
							if (planted) {
								c.note(admitted ? "at the limit, admitted" : "at the limit, refused")
							}
							if (admitted) {
								c.note("admitted")
								succeeded(owned)
							} else {
								c.note("refused, over the limit")
								refused(owned, "UnrepresentableKey")
							}
						})
				)
			)
	)

	it.effect(
		"refuses a key of more than 32 fields, PostgreSQL's INDEX_MAX_KEYS, and admits one of at most 32, span keys included",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/schema/key-width",
						draw: drawn((source) => ({
							width: source.draw(int(postgresIndexMaxKeys - 3, postgresIndexMaxKeys + 3)),
							kind: source.draw(
								element(["primary" as const, "candidate" as const, "span" as const])
							)
						})),
						literal: Formatter.format,
						features: features<`${"primary" | "candidate" | "span"} ${"admitted" | "refused"}`>([
							"primary admitted",
							"primary refused",
							"candidate admitted",
							"candidate refused",
							"span admitted",
							"span refused"
						]),
						kept: [],
						runs: 120,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					({ width, kind }, c) =>
						Effect.sync(() => {
							const admitted = width <= postgresIndexMaxKeys
							c.note(`${kind} ${admitted ? "admitted" : "refused"}`)
							const fields: Record<string, FieldBase> =
								kind === "span"
									? { during: span(rawPg.bigint), ...scalars(width - 1) }
									: scalars(width)
							const names = Rec.keys(fields)
							const R =
								kind === "candidate"
									? relation("Wide", fields, ["f00"])
									: relation("Keyed", fields, names)
							const result = ownOne(R, kind === "candidate" ? [key(R, names)] : [])
							if (admitted) {
								succeeded(result)
							} else {
								refused(result, "UnrepresentableKey")
							}
						})
				)
			)
	)
})

describe("GiST entries for span keys (gist.c gistSplit)", () => {
	const spanScalarGen: Gen<SpanScalar> = weighted([
		[3, map(element(fixedTypes), (type): SpanScalar => ({ kind: "fixed", type }))],
		[1, map(int(0, 40), (length): SpanScalar => ({ kind: "text", length }))]
	])

	type SpanKeyFeature =
		| "two spans"
		| "span first"
		| "span inside"
		| "span last"
		| "int4range"
		| "int8range"

	it.effect(
		"lays a span key out over btree_gist's scalar keys and the span, and refuses a key with two span fields",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/schema/span-key-layout",
						/** Planted: the span between two scalar fields, which the drawn positions reach a few times a run. */
						draw: sketched(
							(source) => ({
								scalars: source.draw(array(spanScalarGen, { min: 0, max: 3 })),
								endpoint: source.draw(element<"integer" | "bigint">(["integer", "bigint"])),
								position: source.draw(pickGen),
								second: source.draw(boolean)
							}),
							(s) => s
						),
						literal: Formatter.format,
						features: features<SpanKeyFeature>([
							"two spans",
							"span first",
							"span inside",
							"span last",
							"int4range",
							"int8range"
						]),
						kept: [
							{
								note: "the span between two text fields",
								sketch: {
									scalars: [
										{ kind: "text", length: 4 },
										{ kind: "text", length: 4 }
									],
									endpoint: "bigint",
									position: pickSpan / 2,
									second: false
								},
								draws: "",
								reaches: ["span inside" as const]
							}
						],
						runs: 120,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(s, c) =>
						Effect.sync(() => {
							const scalarFields: ReadonlyArray<readonly [string, FieldBase]> = Arr.map(
								s.scalars,
								(f, i): readonly [string, FieldBase] => [
									`s${i}`,
									f.kind === "text"
										? regex(`^[a-z]{0,${f.length}}$`, "u")
										: keyFieldDescriptor(f, i)
								]
							)
							const at = pickIndex(s.position, scalarFields.length + 1)
							const during: readonly [string, FieldBase] = [
								"during",
								span(s.endpoint === "integer" ? rawPg.integer : rawPg.bigint)
							]
							const ordered = [...scalarFields.slice(0, at), during, ...scalarFields.slice(at)]
							const keyed = s.second
								? [...ordered, ["other", span(rawPg.bigint)] as const]
								: ordered
							const names = Arr.map(keyed, ([name]) => name)
							const R = relation("Booking", Rec.fromEntries(keyed), names)
							const owned = ownValue(schema("Keys", { Kind, R }, []))
							if (s.second) {
								c.note("two spans")
								refused(owned, "UnrepresentableKey")
								return
							}
							c.note(
								at === 0 ? "span first" : at === scalarFields.length ? "span last" : "span inside"
							)
							c.note(s.endpoint === "integer" ? "int4range" : "int8range")
							succeeded(owned)
							const descs = fieldDescsOf(R)
							const layout = keyLayout(
								Arr.map(names, (field) => ({
									field,
									desc: defined(descs[field], `field ${field}`)
								}))
							)
							if (!layout.ok) {
								return assert.fail(layout.error.kind)
							}
							assert.deepEqual(layout.value.fields, names)
							/**
							 * int4range is 17 bytes at most and int8range 25: a varlena header, the type oid, a flags byte and two bounds.
							 */
							const rangeBytes = s.endpoint === "integer" ? 17 : 25
							const scalarKeys = Arr.map(s.scalars, (f) =>
								gistKeyBytes(spanScalarFamily(f), f.kind === "text" ? 4 + f.length : 0)
							)
							assert.deepEqual(layout.value.gist, {
								span: "during",
								bytes: gistTupleBytes([...scalarKeys, rangeBytes])
							})
						})
				)
			)
	)

	type GistFeature = "vector refused" | "within a GiST page" | "above a GiST page"

	const gistFamilies: Arr.NonEmptyReadonlyArray<GistFamily> = [
		"int2",
		"int4",
		"int8",
		"float4",
		"float8",
		"money",
		"bool",
		"uuid",
		"enum",
		"numeric",
		"text",
		"range",
		"vector"
	]

	it.effect(
		"bounds a GiST entry by btree_gist's two-bound key representation, refusing a vector",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/schema/gist-entry",
						/**
						 * Planted: two text datums of 3,000 bytes, past a GiST page, which the drawn datums reach a few times a run.
						 */
						draw: sketched(
							array(
								(source) => ({
									family: source.draw(element(gistFamilies)),
									bytes: source.draw(int(5, 3000))
								}),
								{ min: 0, max: 5 }
							),
							(datums) => datums
						),
						literal: Formatter.format,
						features: features<GistFeature>([
							"vector refused",
							"within a GiST page",
							"above a GiST page"
						]),
						kept: [
							{
								note: "two text datums of 3,000 bytes",
								sketch: [
									{ family: "text", bytes: 3000 },
									{ family: "text", bytes: 3000 }
								],
								draws: "",
								reaches: ["above a GiST page" as const]
							}
						],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(drawnDatums, c) =>
						Effect.sync(() => {
							const datums: ReadonlyArray<DatumBound> = Arr.map(
								drawnDatums,
								({ family, bytes }) => ({
									family,
									bytes,
									align: 4
								})
							)
							const result = gistEntryBytes(
								Arr.map(datums, (datum, i) => ({ field: `f${i}`, datum }))
							)
							const firstVector = Arr.findFirstIndex(datums, (d) => d.family === "vector")
							if (Option.isSome(firstVector)) {
								c.note("vector refused")
								assert.deepEqual(result, Result.err(`f${firstVector.value}`))
								return
							}
							const keys = Arr.map(datums, (d) =>
								d.family === "vector" ? 0 : gistKeyBytes(d.family, d.bytes)
							)
							const bytes = gistTupleBytes(keys)
							c.note(bytes <= postgresGistMaxItem ? "within a GiST page" : "above a GiST page")
							assert.deepEqual(result, Result.ok(bytes))
						})
				)
			)
	)
})

describe("a vector field is never a key field, since its float equality (-0 equal to 0) is no identity", () => {
	/**
	 * The key's other fields: bounded scalar types, each with a btree_gist operator class, so a key of at most three of
	 * them, a span and nothing else is always representable.
	 */
	const scalarKeyFields: Arr.NonEmptyReadonlyArray<FieldBase> = [
		uuid,
		rawPg.bigint,
		rawPg.integer,
		rawPg.smallint,
		rawPg.boolean,
		regex("^[a-z]{1,8}$", "u")
	]

	interface VectorKeySketch {
		/** Picks into scalarKeyFields: the key's other fields, k0..k2. */
		readonly scalars: ReadonlyArray<FieldBase>
		/** The key also holds during: span(pg.bigint). */
		readonly span: boolean
		/** The vector's dimension. */
		readonly dimensions: number
		/** The vector under bareContract("Embedding", pg.vector(d)). */
		readonly contract: boolean
		/** In the primary key, or in a candidate key(R, ...). */
		readonly primary: boolean
	}

	/**
	 * The dimension ranges over pgvector's whole range, and one draw in two is a vector of at most 64 dimensions, small
	 * enough for a B-tree entry, which the last required feature checks. The key holds at most five fields, far below
	 * INDEX_MAX_KEYS.
	 */
	const vectorKeySketchGen: Gen<VectorKeySketch> = (source) => ({
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

	type VectorKeyFeature =
		| "vector in the primary key"
		| "vector in a candidate key"
		| "contract over a vector"
		| "vector beside a span"
		| "a vector key the B-tree limit admits"

	/** The production bound of a key field's datum; every field the sketch draws has one. */
	const boundOf = (descriptor: FieldBase): DatumBound => {
		const bound = datumBound(descOf(descriptor))
		if (!bound.ok) {
			return assert.fail(`a bounded key field: ${bound.error}`)
		}
		return bound.value
	}

	it.effect(
		"refuses a key holding a vector field, and admits the same relation with the vector as payload only",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/schema/vector-keys",
						draw: drawn(vectorKeySketchGen),
						literal: Formatter.format,
						features: features<VectorKeyFeature>([
							"vector in the primary key",
							"vector in a candidate key",
							"contract over a vector",
							"vector beside a span",
							"a vector key the B-tree limit admits"
						]),
						kept: [],
						/**
						 * Five independent booleans' worth of features, which 100 cases reach with near certainty; the
						 * required list checks it.
						 */
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(s, c) =>
						Effect.sync(() => {
							const others: Array<readonly [string, FieldBase]> = Arr.map(
								s.scalars,
								(field, i): readonly [string, FieldBase] => [`k${i}`, field]
							)
							if (s.span) {
								others.push(["during", span(rawPg.bigint)])
							}
							const vector = s.contract
								? bareContract("Embedding", rawPg.vector(s.dimensions))
								: rawPg.vector(s.dimensions)
							const keyFields: ReadonlyArray<readonly [string, FieldBase]> = [
								...others,
								["v", vector]
							]
							const fields = Rec.fromEntries(keyFields)
							const scalarKey = Arr.map(others, ([name]) => name)
							const vectorKey = Arr.map(keyFields, ([name]) => name)
							const keyed = relation("R", fields, s.primary ? vectorKey : scalarKey)
							refused(
								ownValue(schema("Keys", { R: keyed }, s.primary ? [] : [key(keyed, vectorKey)])),
								"UnrepresentableKey"
							)
							succeeded(ownValue(schema("Keys", { R: relation("R", fields, scalarKey) }, [])))
							c.note(s.primary ? "vector in the primary key" : "vector in a candidate key")
							if (s.contract) {
								c.note("contract over a vector")
							}
							if (s.span) {
								c.note("vector beside a span")
							}
							if (
								btreeEntryBytes(Arr.map(keyFields, ([, descriptor]) => boundOf(descriptor))) <=
								btreeMaxItemSize
							) {
								c.note("a vector key the B-tree limit admits")
							}
						})
				)
			)
	)
})
