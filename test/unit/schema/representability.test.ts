import { describe, it } from "@effect/vitest"
import { drawn, explore, sketched } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
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
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	pipe,
	Record as Rec,
	String as Str
} from "effect"
import { indices, maxOf } from "#compiler/core/array.ts"
import type { KeyFault } from "#compiler/core/causes.ts"
import { typlens } from "#compiler/core/limits.ts"
import * as Result from "#compiler/core/result.ts"
import { vectorMaxDimensions } from "#compiler/ir/carriers.ts"
import type { ExprDesc, FieldDesc } from "#compiler/ir/desc.ts"
import { fieldTypes } from "#compiler/ir/desc.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { natural, uuid } from "#compiler/public/fields.ts"
import { keyTextBytes, str } from "#compiler/public/text.ts"
import {
	accumulatedField,
	closed,
	drawnField,
	relation,
	relationDescOf
} from "#compiler/schema/relation.ts"
import {
	btreeEntryBytes,
	btreeMaxItemSize,
	type DatumBound,
	datumBound,
	gistEntryBytes,
	keyLayout,
	type LengthMeasure,
	lengthBound,
	textByteBound
} from "#compiler/schema/representability.ts"
import { schema } from "#compiler/schema/schema.ts"
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
import { textLookup } from "#compiler/text/refinement.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { assert, defined, refused, succeeded } from "#test/support/assert.ts"
import { textDesc } from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import { pickGen, pickIndex, pickSpan } from "#test/support/pick.ts"
import { ownedInput } from "#test/support/policy.ts"
import {
	bareContract,
	charLengthAtMost,
	rawClosedId,
	rawContract,
	descOf,
	octetLengthAtMost,
	type Row,
	rawPg,
	rawSpan,
	regex,
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
	ownValue(schema("Keys", { [r.name]: r }, statements, []))

/** The field Descriptions of a relation, read through its accessor. */
const fieldDescsOf = (r: unknown): Readonly<Record<string, FieldDesc>> => {
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
						oracle: { kind: "unstated" },
						suite: "unit/schema/pattern-byte-bound",
						draw: drawn(patternSketchGen),
						literal: Formatter.format,
						coverage: required<RegexFeature>(
							[
								"bounded",
								"exact",
								"long run",
								"unanchored",
								"unbounded repetition",
								"back-reference",
								"lookaround",
								"four-byte code point",
								"group alternation"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.sync(() => {
							const alternatives = plantedAlternatives(s)
							const source = patternSource(alternatives)
							const language = textLookup(source, s.flags)
							/** A pattern the analysis refuses has no descriptor, so nothing it bounds is a key's. */
							const bound = language.ok
								? textByteBound({
										kind: "text",
										source,
										flags: s.flags,
										bytes: undefined,
										language: language.value
									})
								: Number.POSITIVE_INFINITY
							const anchored = Arr.every(alternatives, (a) => a.start && a.end)
							const longest = maxOf(
								Arr.map(alternatives, (a) => sequenceBytes(a.items)),
								Number.NEGATIVE_INFINITY
							)
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
	value: bigint ? BigInt(n) : n,
	type: undefined
})

const conjunctExpr = ({ measure, form: c }: LengthConjunct): ExprDesc => {
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
const boundsAbove = (c: LengthForm): boolean =>
	c.kind === "between" ||
	c.kind === "in" ||
	(c.kind === "compare" &&
		(c.mirrored
			? c.op === "ge" || c.op === "gt" || c.op === "eq"
			: c.op === "le" || c.op === "lt" || c.op === "eq"))

/** Lengths past every drawn literal, and below zero, where an upper bound's arithmetic may land. */
const lengthsScanned = Arr.map(indices(141), (i) => 100 - i)

/**
 * The bound the model reads on `measure` from the conjuncts: each documented upper-bounding conjunct of that measure
 * alone bounds L at the largest scanned length it holds of, and the conjunction at the least of those; Infinity, the top
 * of the bounds' min order, when no conjunct of the measure bounds L.
 */
const modelBound = (conjuncts: ReadonlyArray<LengthConjunct>, measure: LengthMeasure): number =>
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

interface LengthSketch {
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
	[1, (source) => ({ kind: "in", values: source.draw(nonEmpty(int(0, 60), 3)) })],
	[1, (source) => ({ kind: "or", left: source.draw(int(0, 60)), right: source.draw(int(0, 60)) })],
	[1, constant<LengthForm>({ kind: "other" })]
])

const lengthConjunctGen: Gen<LengthConjunct> = (source) => ({
	measure: source.draw(element<LengthMeasure>(["charLength", "octetLength"])),
	form: source.draw(lengthFormGen)
})

type LengthFeature =
	| "charLength bounded"
	| "octetLength bounded"
	| "unbounded"
	| "both measures"
	| "base tighter"
	| "charLength tighter"
	| "octetLength tighter"
	| "mirrored"

describe("length bounds", () => {
	it.effect(
		"reads a charLength bound, four bytes a code point, and an octetLength bound, exact bytes, from a contract predicate",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/schema/length-bound",
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
						coverage: required<LengthFeature>(
							[
								"charLength bounded",
								"octetLength bounded",
								"unbounded",
								"both measures",
								"base tighter",
								"charLength tighter",
								"octetLength tighter",
								"mirrored"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.sync(() => {
							const [first, ...rest] = s.conjuncts
							const tail = Arr.map(rest, conjunctExpr)
							const predicate: ExprDesc = !Arr.isReadonlyArrayNonEmpty(tail)
								? conjunctExpr(first)
								: s.nested
									? { kind: "and", args: [conjunctExpr(first), { kind: "and", args: tail }] }
									: { kind: "and", args: [conjunctExpr(first), ...tail] }
							if (
								Arr.some(
									s.conjuncts,
									({ form }) => form.kind === "compare" && form.mirrored && boundsAbove(form)
								)
							) {
								c.note("mirrored")
							}
							const chars = modelBound(s.conjuncts, "charLength")
							const octets = modelBound(s.conjuncts, "octetLength")
							assert.equal(lengthBound("charLength", predicate), chars, "the charLength bound")
							assert.equal(lengthBound("octetLength", predicate), octets, "the octetLength bound")
							if (Number.isFinite(chars)) {
								c.note("charLength bounded")
							}
							if (Number.isFinite(octets)) {
								c.note("octetLength bounded")
							}
							if (Number.isFinite(chars) && Number.isFinite(octets)) {
								c.note("both measures")
							}
							const base =
								s.base.kind === "wildcard"
									? textDesc("^.*$", "su")
									: textDesc(`^[A-Z]{${s.base.k}}$`, "u")
							const charBytes = 4 * Math.max(0, chars)
							const octetBytes = Math.max(0, octets)
							const baseBytes = s.base.kind === "wildcard" ? Number.POSITIVE_INFINITY : s.base.k
							const expected = Math.min(charBytes, octetBytes, baseBytes)
							if (!Number.isFinite(expected)) {
								c.note("unbounded")
							} else if (expected === baseBytes && baseBytes < Math.min(charBytes, octetBytes)) {
								c.note("base tighter")
							} else if (expected === charBytes && charBytes < octetBytes) {
								c.note("charLength tighter")
							} else if (expected === octetBytes && octetBytes < charBytes) {
								c.note("octetLength tighter")
							}
							assert.equal(
								textByteBound({ kind: "contract", name: "Memo", base, predicate, facts: [] }),
								expected
							)
						})
				)
			)
	)
})

/**
 * A key field as drawn, over pg_type's sizes and alignments: a fixed-width type, numeric(p, s), text of a bounded
 * pattern (ASCII, or any code point), the wildcard, or a contract over the wildcard bounding char_length or
 * octet_length.
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
	| { readonly kind: "ascii text"; readonly length: number }
	| { readonly kind: "any text"; readonly length: number }
	| { readonly kind: "wildcard" }
	| { readonly kind: "bounded contract"; readonly length: number }
	| { readonly kind: "octet contract"; readonly bytes: number }

/** A datum's longest bytes and its type's alignment, and whether its type is fixed-width (typlen > 0) or a varlena. */
interface Datum {
	readonly bytes: number
	readonly align: number
	readonly fixed: boolean
}

/** pg_type's typlen and typalign of each fixed key type: a closed id is its code, a smallint, a serial its integer type. */
const fixedDatum: Readonly<Record<FixedType, Datum>> = {
	smallint: { bytes: 2, align: 2, fixed: true },
	integer: { bytes: 4, align: 4, fixed: true },
	bigint: { bytes: 8, align: 8, fixed: true },
	real: { bytes: 4, align: 4, fixed: true },
	"double precision": { bytes: 8, align: 8, fixed: true },
	money: { bytes: 8, align: 8, fixed: true },
	boolean: { bytes: 1, align: 1, fixed: true },
	uuid: { bytes: 16, align: 1, fixed: true },
	bigserial: { bytes: 8, align: 8, fixed: true },
	serial: { bytes: 4, align: 4, fixed: true },
	closedId: { bytes: 2, align: 2, fixed: true }
}

/** A varlena datum with its 4-byte header, int-aligned. */
const varlena = (bytes: number): Datum => ({ bytes: 4 + bytes, align: 4, fixed: false })

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
				datum: { bytes: 8 + 2 * Math.floor((f.precision + 6) / 4), align: 4, fixed: false }
			}
		case "ascii text":
			return { kind: "bounded", datum: varlena(f.length) }
		case "any text":
		case "bounded contract":
			return { kind: "bounded", datum: varlena(4 * f.length) }
		case "octet contract":
			return { kind: "bounded", datum: varlena(f.bytes) }
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

/** Where the datums laid out so far end, and whether every offset so far is exact. */
interface Laid {
	readonly end: number
	readonly exact: boolean
}

/**
 * Where a B-tree tuple's datums end, before MAXALIGN, as index_form_tuple lays them out (heaptuple.c fill_val): after
 * the header, each fixed-width datum at its alignment while every datum before it is fixed-width, every offset then
 * known; from the first varlena on, whose header and length vary with its value, each datum after its worst alignment
 * padding, align - 1, and a varlena at its longest under its aligned 4-byte header.
 */
const datumsEnd = (datums: ReadonlyArray<Datum>): Laid => {
	const start: Laid = { end: indexTupleHeader, exact: true }
	return Arr.reduce(datums, start, ({ end, exact }, d): Laid => ({
		end: exact ? Math.ceil(end / d.align) * d.align + d.bytes : end + d.align - 1 + d.bytes,
		exact: exact && d.fixed
	}))
}

/** The most bytes a B-tree tuple over the datums reaches (datumsEnd), the whole MAXALIGNed. */
const btreeTupleBytes = (datums: ReadonlyArray<Datum>): number => maxalign(datumsEnd(datums).end)

const Kind = closed("Kind", ["A", "B"], [])

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
			return rawClosedId(Kind)
	}
}

const keyFieldDescriptor = (f: KeyFieldSketch, i: number): FieldBase => {
	switch (f.kind) {
		case "fixed":
			return fixedDescriptor(f.type)
		case "numeric":
			return rawPg.numericOf(f.precision, f.scale)
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
	[2, map(int(0, 40), (length): KeyFieldSketch => ({ kind: "ascii text", length }))],
	[1, map(int(0, 40), (length): KeyFieldSketch => ({ kind: "any text", length }))],
	[1, constant<KeyFieldSketch>({ kind: "wildcard" })],
	[2, map(int(0, 700), (length): KeyFieldSketch => ({ kind: "bounded contract", length }))],
	[2, map(int(0, 2800), (bytes): KeyFieldSketch => ({ kind: "octet contract", bytes }))]
])

interface KeySizeSketch {
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
const sizedFields = (s: KeySizeSketch): ReadonlyArray<KeyFieldSketch> => {
	if (s.boundary.kind === "none") {
		return s.fields
	}
	const datums = boundedDatums(s.fields)
	if (datums.length < s.fields.length) {
		return s.fields
	}
	const { end, exact } = datumsEnd(datums)
	const start = (exact ? Math.ceil(end / 4) * 4 : end + 3) + 4
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
/** A set over a roster is bit(n), a varlena, which btree_gist keys as it keys text (btree_bit.c over gbt_var). */
type GistFamily = FixedGistFamily | "numeric" | "text" | "bit" | "range" | "vector"

/** Each fixed family's typlen, its datum's bytes: a code is a smallint. */
const fixedTyplens: { readonly [F in FixedGistFamily]: number } = {
	int2: typlens.int2.value,
	int4: typlens.int4.value,
	int8: typlens.int8.value,
	float4: typlens.float4.value,
	float8: typlens.float8.value,
	money: typlens.money.value,
	bool: typlens.bool.value,
	uuid: typlens.uuid.value,
	date: typlens.date.value,
	code: typlens.int2.value
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
		case "numeric":
		case "text":
		case "bit":
		case "range":
		case "vector":
			return false
	}
}

const gistKeyBytes = (family: Exclude<GistFamily, "vector">, bytes: number): number => {
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

/** A span key's fixed scalar's family. */
const spanScalarFamily = (s: Extract<SpanScalar, { readonly kind: "fixed" }>): FixedGistFamily => {
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
			return "code"
	}
}

const scalars = (n: number): Record<string, FieldBase> =>
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
const budgetOf = (companions: ReadonlyArray<Companion>): number =>
	postgresBtreeMaxItem -
	Arr.reduce(companions, 16, (end, c) => {
		const d = companionDatum(c)
		return end + d.align - 1 + d.bytes
	}) -
	3 -
	4

/**
 * The most bytes a B-tree tuple over `datums` reaches when its first column is a law column that may hold NULL: its
 * data after the header and the null bitmap, MAXALIGNed to 16, the first datum at its alignment and, the NULL-able
 * column ending the exact offsets, every later one after its worst padding, align - 1; the whole MAXALIGNed.
 */
const nullableTupleBytes = (datums: ReadonlyArray<Datum>): number => {
	const start: Laid = { end: 16, exact: true }
	return maxalign(
		Arr.reduce(datums, start, ({ end, exact }, d): Laid => ({
			end: exact ? Math.ceil(end / d.align) * d.align + d.bytes : end + d.align - 1 + d.bytes,
			exact: false
		})).end
	)
}

/**
 * The index a text of keyTextBytes(fields) bytes sits in beside those fields: a key declared over them; a key over a
 * selection of their relation, whose columns are law columns that may hold NULL; or the UNIQUE of a family axis that
 * carries the text as a concat fold's running value: an ordered family's, Line's (doc, at, after), fields all, beside
 * a uuid and a natural; a tree's predecessor axis's, Node's parent, a law column that may hold NULL, its slot, its
 * running text and its end, beside a uuid and two naturals.
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

const budgetCaseGen: Gen<BudgetCase> = weighted<BudgetCase>([
	[
		4,
		(source): BudgetCase => {
			const companions = source.draw(nonEmpty(companionGen, 4))
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

type BudgetFeature =
	| BudgetArm
	| Spelling
	| "tight"
	| "slack"
	| "text first"
	| "text last"
	| "text between"
	| "a text beside it"

/** A text bounded at `bytes`, over the wildcard: by a contract over its octet_length, or by str.bytes. */
const keyText = (bytes: number, spelling: Spelling): FieldBase =>
	spelling === "a contract"
		? rawContract("KeyText", wildcard, octetLengthAtMost(bytes))
		: str.bytes(bytes, wildcard)

/** The installation of a schema value: every index its law model plans, each entry proved or refused. */
const installed = (value: unknown) =>
	Result.flatMap(ownValue(value), (owned) =>
		compileInstallation(owned, installOptions(owned, "owner"))
	)

/**
 * Doc's lines in order and the concat fold of their pieces into Doc.text, each text bounded at `bytes`: the axis's
 * UNIQUE is Line's (doc, at, after).
 */
const orderedAxis = (bytes: number, spelling: Spelling) => {
	const text = keyText(bytes, spelling)
	const Doc = relation(
		"Doc",
		{ id: uuid, n: drawnField(natural, []), text: accumulatedField(text, "", []) },
		["id"],
		[]
	)
	const Line = relation(
		"Line",
		{
			doc: uuid,
			at: drawnField(natural, []),
			piece: text,
			before: accumulatedField(text, "", []),
			after: accumulatedField(text, "", [])
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
	return schema("Axis", { Doc, Line }, statements, [])
}

/**
 * A tree of nodes and the concat fold of their pieces along it, each text bounded at `bytes`: its predecessor axis's
 * UNIQUE holds the parent as a law column that may hold NULL, the slot, the running text and the node's end.
 */
const treeAxis = (bytes: number, spelling: Spelling) => {
	const text = keyText(bytes, spelling)
	const Node = relation(
		"Node",
		{
			id: uuid,
			parent: uuid,
			at: drawnField(natural, []),
			children: drawnField(natural, []),
			start: drawnField(natural, []),
			end: drawnField(natural, []),
			doc: uuid,
			piece: text,
			before: accumulatedField(text, "", []),
			after: accumulatedField(text, "", []),
			total: accumulatedField(text, "", [])
		},
		["id"],
		[]
	)
	const nodes = treeBuilder(onBuilder(Node, ["parent", "at"]), finBuilder(Node, "children"), {
		root: "doc"
	})
	const statements: ReadonlyArray<Statement> = [
		nodes,
		foldBuilder(
			nodes,
			monoids.concat,
			onBuilder(Node, ["parent", "piece", "before", "after"]),
			onBuilder(Node, ["id", "total"])
		)
	]
	return schema("Tree", { Node }, statements, [])
}

const uuidCompanion: Companion = { kind: "fixed", type: "uuid" }
const naturalCompanion: Companion = { kind: "fixed", type: "bigint" }

/**
 * What an arm reads of a case: the fields keyTextBytes is given, as descriptors and as the companions they lay out as;
 * the arm's schema with its text bounded at so many bytes; and the most bytes its index's entry reaches with a text of
 * so many bytes, restated.
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
			const text: readonly [string, FieldBase] = ["t", keyText(bytes, s.spelling)]
			const fields = [...Arr.take(named, s.position), text, ...Arr.drop(named, s.position)]
			const names = Arr.map(fields, ([n]) => n)
			if (!selected) {
				return schema(
					"Budget",
					{ Kind, R: relation("R", Rec.fromEntries(fields), names, []) },
					[],
					[]
				)
			}
			const R = relation(
				"R",
				{ id: uuid, live: rawPg.boolean, ...Rec.fromEntries(fields) },
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
			return schema("Budget", { Kind, R }, statements, [])
		},
		entryAt: (bytes) => {
			const before = Arr.map(Arr.take(s.companions, s.position), companionDatum)
			const after = Arr.map(Arr.drop(s.companions, s.position), companionDatum)
			const datums = [...before, varlena(bytes), ...after]
			return selected ? nullableTupleBytes(datums) : btreeTupleBytes(datums)
		}
	}
}

const armOf = (s: BudgetCase): Arm => {
	switch (s.arm) {
		case "declared key":
		case "key over a selection":
			return keyArm(s)
		case "ordered axis":
			return {
				fields: [uuid, natural],
				companions: [uuidCompanion, naturalCompanion],
				schemaAt: (bytes) => orderedAxis(bytes, s.spelling),
				entryAt: (bytes) =>
					btreeTupleBytes([
						companionDatum(uuidCompanion),
						companionDatum(naturalCompanion),
						varlena(bytes)
					])
			}
		case "tree axis":
			return {
				fields: [uuid, natural, natural],
				companions: [uuidCompanion, naturalCompanion, naturalCompanion],
				schemaAt: (bytes) => treeAxis(bytes, s.spelling),
				entryAt: (bytes) =>
					nullableTupleBytes([
						companionDatum(uuidCompanion),
						companionDatum(naturalCompanion),
						varlena(bytes),
						companionDatum(naturalCompanion)
					])
			}
	}
}

/** Where a key case's text stands among its companions, and whether one of them is a text too. */
const keyFeatures = (s: BudgetCase): ReadonlyArray<BudgetFeature> => {
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

describe("keyTextBytes", () => {
	it.effect(
		"is the most bytes a text holds beside its fields in every index grizzle plans over them, and one byte more is refused where an index's layout meets the bound",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/schema/key-text-bytes",
						draw: drawn(budgetCaseGen),
						literal: Formatter.format,
						coverage: required<BudgetFeature>(
							[
								"declared key",
								"key over a selection",
								"ordered axis",
								"tree axis",
								"a contract",
								"str.bytes",
								"tight",
								"slack",
								"text first",
								"text last",
								"text between",
								"a text beside it"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.sync(() => {
							const arm = armOf(s)
							const budget = keyTextBytes(arm.fields)
							assert.equal(budget, budgetOf(arm.companions), "the budget")
							succeeded(
								installed(arm.schemaAt(budget)),
								`the ${s.arm} with a text of ${budget} bytes`
							)
							const past = arm.entryAt(budget + 1) > postgresBtreeMaxItem
							c.noteAll([s.arm, s.spelling, past ? "tight" : "slack", ...keyFeatures(s)])
							if (past) {
								refused(installed(arm.schemaAt(budget + 1)), "UnrepresentableKey")
							} else {
								succeeded(
									installed(arm.schemaAt(budget + 1)),
									`the ${s.arm}, whose layout leaves room past the budget`
								)
							}
						})
				)
			)
	)
})

describe("B-tree entries (nbtree.h BTMaxItemSize)", () => {
	it.effect(
		"refuses a key with an unbounded field or a worst-case entry above the item limit, and admits every other",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/schema/btree-entry",
						draw: drawn((source) => ({
							fields: source.draw(nonEmpty(keyFieldGen, 4)),
							primary: source.draw(boolean),
							boundary: source.draw(
								oneOf([
									constant<KeySizeSketch["boundary"]>({ kind: "none" }),
									map(
										(inner) => ({ delta: inner.draw(int(-8, 8)), octets: inner.draw(boolean) }),
										({ delta, octets }): KeySizeSketch["boundary"] => ({
											kind: "at",
											delta,
											octets
										})
									)
								])
							)
						})),
						literal: Formatter.format,
						coverage: required<KeySizeFeature>(
							[
								"admitted",
								"refused, unbounded",
								"refused, over the limit",
								"at the limit, admitted",
								"at the limit, refused",
								"primary",
								"candidate"
							],
							{ cases: 150, sense: notesOnly }
						),
						kept: [],
						runs: 150,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
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
								? relation("R", keyFields, names, [])
								: relation("R", { id: uuid, ...keyFields }, ["id"], [])
							const owned = ownValue(
								schema("Keys", { Kind, R }, s.primary ? [] : [keyBuilder(onBuilder(R, names))], [])
							)
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
						oracle: { kind: "unstated" },
						suite: "unit/schema/key-width",
						draw: drawn((source) => ({
							width: source.draw(int(postgresIndexMaxKeys - 3, postgresIndexMaxKeys + 3)),
							kind: source.draw(
								element(["primary" as const, "candidate" as const, "span" as const])
							)
						})),
						literal: Formatter.format,
						coverage: required<`${"primary" | "candidate" | "span"} ${"admitted" | "refused"}`>(
							[
								"primary admitted",
								"primary refused",
								"candidate admitted",
								"candidate refused",
								"span admitted",
								"span refused"
							],
							{ cases: 120, sense: notesOnly }
						),
						kept: [],
						runs: 120,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ width, kind }, c) =>
						Effect.sync(() => {
							const admitted = width <= postgresIndexMaxKeys
							c.note(`${kind} ${admitted ? "admitted" : "refused"}`)
							const fields: Record<string, FieldBase> =
								kind === "span"
									? { during: rawSpan(rawPg.bigint), ...scalars(width - 1) }
									: scalars(width)
							const names = Rec.keys(fields)
							const R =
								kind === "candidate"
									? relation("Wide", fields, ["f00"], [])
									: relation("Keyed", fields, names, [])
							const result = ownOne(
								R,
								kind === "candidate" ? [keyBuilder(onBuilder(R, names))] : []
							)
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
						oracle: { kind: "unstated" },
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
						coverage: required<SpanKeyFeature>(
							["two spans", "span first", "span inside", "span last", "int4range", "int8range"],
							{ cases: 120, sense: notesOnly }
						),
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
						caseHang
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
								rawSpan(s.endpoint === "integer" ? rawPg.integer : rawPg.bigint)
							]
							const ordered = [...scalarFields.slice(0, at), during, ...scalarFields.slice(at)]
							const keyed = s.second
								? [...ordered, ["other", rawSpan(rawPg.bigint)] as const]
								: ordered
							const names = Arr.map(keyed, ([name]) => name)
							const R = relation("Booking", Rec.fromEntries(keyed), names, [])
							const owned = ownValue(schema("Keys", { Kind, Booking: R }, [], []))
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
								f.kind === "text"
									? gistKeyBytes("text", 4 + f.length)
									: gistKeyBytes(spanScalarFamily(f), fixedTyplens[spanScalarFamily(f)])
							)
							const gist = defined(layout.value.gist, "a span key's GiST layout")
							const counted: { readonly span: string; readonly bytes: number } = gist
							assert.deepEqual(counted, {
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
		"code",
		"numeric",
		"text",
		"bit",
		"range",
		"vector"
	]

	/** A drawn datum: a fixed family's bytes are its typlen, and numeric, text and range draw theirs. */
	const gistDatumGen: Gen<{ readonly family: GistFamily; readonly bytes: number }> = (source) => {
		const family = source.draw(element(gistFamilies))
		return {
			family,
			bytes: isFixedGistFamily(family) ? fixedTyplens[family] : source.draw(int(5, 3000))
		}
	}

	it.effect(
		"bounds a GiST entry by btree_gist's two-bound key representation, refusing a vector",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/schema/gist-entry",
						/**
						 * Planted: two text datums of 3,000 bytes, past a GiST page, which the drawn datums reach a few times a run.
						 */
						draw: sketched(array(gistDatumGen, { min: 0, max: 5 }), (datums) => datums),
						literal: Formatter.format,
						coverage: required<GistFeature>(
							["vector refused", "within a GiST page", "above a GiST page"],
							{ cases: 200, sense: notesOnly }
						),
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
						caseHang
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

describe("a vector field is a key field like any other: every vector has one form, so its equality is identity", () => {
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
		/** In the primary key, or in a candidate key(on(R, ...)). */
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
				[1, int(1, vectorMaxDimensions.value)],
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
		| "vector beside a span refused"
		| "a vector key admitted"
		| "a vector key above the B-tree limit"

	/** The production bound of a key field's datum; every field the sketch draws has one. */
	const boundOf = (descriptor: FieldBase): DatumBound => {
		const bound = datumBound(descOf(descriptor))
		if (bound === undefined) {
			return assert.fail("a bounded key field: text whose pattern proves no byte bound")
		}
		return bound
	}

	it.effect(
		"admits a key holding a vector where its B-tree entry fits, and refuses one beside a span, which btree_gist cannot index",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/schema/vector-keys",
						draw: drawn(vectorKeySketchGen),
						literal: Formatter.format,
						coverage: required<VectorKeyFeature>(
							[
								"vector in the primary key",
								"vector in a candidate key",
								"contract over a vector",
								"vector beside a span refused",
								"a vector key admitted",
								"a vector key above the B-tree limit"
							],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						/**
						 * The rotating stream's sample of six independent booleans' worth of features, which the required list
						 * holds the floor and the steered phase to.
						 */
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.sync(() => {
							const others: Array<readonly [string, FieldBase]> = Arr.map(
								s.scalars,
								(field, i): readonly [string, FieldBase] => [`k${i}`, field]
							)
							if (s.span) {
								others.push(["during", rawSpan(rawPg.bigint)])
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
							const keyed = relation("R", fields, s.primary ? vectorKey : scalarKey, [])
							const owned = ownValue(
								schema(
									"Keys",
									{ R: keyed },
									s.primary ? [] : [keyBuilder(onBuilder(keyed, vectorKey))],
									[]
								)
							)
							const layout = keyLayout(
								Arr.map(keyFields, ([field, descriptor]) => ({ field, desc: descOf(descriptor) }))
							)
							const columns = Arr.map(keyFields, ([name, descriptor]) => ({
								name,
								datum: boundOf(descriptor),
								nullable: false
							}))
							const bytes = btreeEntryBytes(columns)
							c.note(s.primary ? "vector in the primary key" : "vector in a candidate key")
							if (s.contract) {
								c.note("contract over a vector")
							}
							if (s.span) {
								assert.deepEqual(
									layout,
									Result.err<KeyFault>({ kind: "gistOperatorClass", field: "v" })
								)
								refused(owned, "UnrepresentableKey")
								c.note("vector beside a span refused")
							} else if (bytes > btreeMaxItemSize.value) {
								assert.deepEqual(
									layout,
									Result.err<KeyFault>({
										kind: "btreeEntry",
										bytes,
										limit: btreeMaxItemSize.value,
										datums: Arr.map(columns, (col) => ({ field: col.name, bytes: col.datum.bytes }))
									})
								)
								refused(owned, "UnrepresentableKey")
								c.note("a vector key above the B-tree limit")
							} else {
								assert.ok(layout.ok, "the key's layout")
								succeeded(owned)
								c.note("a vector key admitted")
							}
						})
				)
			)
	)
})
