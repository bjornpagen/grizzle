/** What the properties of selector-literal-type.test.ts read: its spaces, models and helpers. */

import { constant, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Data, Formatter } from "effect"
import { Type } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema, select } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { seatTemplate } from "#test/support/pg/fin/installed.ts"

/** A text of up to 8 letters, a type other than BText's x, of up to 3. */
const Longer = str.regex("^[a-z]{1,8}$")

const BNumeric = relation("BNumeric", { id: pg.integer, x: pg.numeric(5, 1) }, ["id"])

/** BNumeric keyed by id and x, so a containment into it over id is keyed only where its selection fixes x. */
const BKeyed = relation("BKeyed", { id: pg.integer, x: pg.numeric(5, 1) }, ["id", "x"])

const BText = relation("BText", { id: pg.integer, x: str.regex("^[a-z]{1,3}$") }, ["id"])

const NumericOther = relation("NumericOther", { id: pg.integer }, ["id"])

const NumericOtherExact = relation("NumericOtherExact", { id: pg.integer }, ["id"])

const NumericOwn = relation("NumericOwn", { id: pg.integer }, ["id"])

const NumericBare = relation("NumericBare", { id: pg.integer }, ["id"])

const KeyedBare = relation("KeyedBare", { id: pg.integer }, ["id"])

const RuleBare = relation("RuleBare", { id: pg.integer }, ["id"])

const KeyedRuleBare = relation("KeyedRuleBare", { id: pg.integer }, ["id"])

const KeyedOtherExact = relation("KeyedOtherExact", { id: pg.integer }, ["id"])

const KeyedRuleOther = relation("KeyedRuleOther", { id: pg.integer }, ["id"])

const KeyedRuleOtherExact = relation("KeyedRuleOtherExact", { id: pg.integer }, ["id"])

const TextOther = relation("TextOther", { id: pg.integer }, ["id"])

const TextOtherExact = relation("TextOtherExact", { id: pg.integer }, ["id"])

const RuleOther = relation("RuleOther", { id: pg.integer }, ["id"])

const RuleOtherExact = relation("RuleOtherExact", { id: pg.integer }, ["id"])

const Selected = schema(
	"selector_literal",
	[
		BNumeric,
		BKeyed,
		BText,
		NumericOther,
		NumericOtherExact,
		NumericOwn,
		NumericBare,
		KeyedBare,
		RuleBare,
		KeyedRuleBare,
		KeyedOtherExact,
		KeyedRuleOther,
		KeyedRuleOtherExact,
		TextOther,
		TextOtherExact,
		RuleOther,
		RuleOtherExact
	],
	[
		contained(
			on(NumericOther, "id"),
			on(
				select(BNumeric, (b) => b.eq(b.x, Type.literal(pg.numeric(10, 2), "1.25"))),
				"id"
			)
		),
		contained(
			on(NumericOtherExact, "id"),
			on(
				select(BNumeric, (b) => b.eq(b.x, Type.literal(pg.numeric(10, 2), "1.30"))),
				"id"
			)
		),
		contained(
			on(NumericOwn, "id"),
			on(
				select(BNumeric, (b) => b.eq(b.x, Type.literal(BNumeric.fields.x, "1.3"))),
				"id"
			)
		),
		contained(
			on(NumericBare, "id"),
			on(
				select(BNumeric, (b) => b.eq(b.x, "1.3")),
				"id"
			)
		),
		contained(
			on(KeyedBare, "id"),
			on(
				select(BKeyed, (b) => b.eq(b.x, "1.3")),
				"id"
			)
		),
		contained(
			on(KeyedOtherExact, "id"),
			on(
				select(BKeyed, (b) => b.eq(b.x, Type.literal(pg.numeric(10, 2), "1.30"))),
				"id"
			)
		),
		contained(
			on(TextOther, "id"),
			on(
				select(BText, (b) => b.eq(b.x, Type.literal(Longer, "abcdef"))),
				"id"
			)
		),
		contained(
			on(TextOtherExact, "id"),
			on(
				select(BText, (b) => b.eq(b.x, Type.literal(Longer, "abc"))),
				"id"
			)
		)
	]
)

/** The ids of BNumeric whose x a numeric(10, 2) literal names: matched by a rule over a query, which binds x to it. */
const numericAt = (value: string) =>
	query(Selected).rule((r) => {
		const { id } = v(BNumeric, "b")
		return r.match(BNumeric, { id, x: Type.literal(pg.numeric(10, 2), value) }).find({ id })
	})

/**
 * The ids of BKeyed whose x a numeric(10, 2) literal names. BKeyed is keyed by id and x, so the rule lowers to a foreign
 * key only where the literal fixes x.
 */
const keyedAt = (value: string) =>
	query(Selected).rule((r) => {
		const { id } = v(BKeyed, "b")
		return r.match(BKeyed, { id, x: Type.literal(pg.numeric(10, 2), value) }).find({ id })
	})

/** The ids of BNumeric whose x a bare literal names, a value of x's numeric(5, 1) as written: matched by a rule. */
const numericBare = query(Selected).rule((r) => {
	const { id } = v(BNumeric, "b")
	return r.match(BNumeric, { id, x: "1.3" }).find({ id })
})

/** The ids of BKeyed whose x the bare 1.3 names: a rule keyed within BKeyed, which fixes x. */
const keyedBare = query(Selected).rule((r) => {
	const { id } = v(BKeyed, "b")
	return r.match(BKeyed, { id, x: "1.3" }).find({ id })
})

const AtOther = derived("AtOther", numericAt("1.25"))

const AtBare = derived("AtBare", numericBare)

const KeyedAtBare = derived("KeyedAtBare", keyedBare)

const AtOtherExact = derived("AtOtherExact", numericAt("1.30"))

const KeyedAtOther = derived("KeyedAtOther", keyedAt("1.25"))

const KeyedAtOtherExact = derived("KeyedAtOtherExact", keyedAt("1.30"))

const SelectorLiteral = schema.extend(
	[Selected],
	"selector_literal_rules",
	[AtOther, AtOtherExact, KeyedAtOther, KeyedAtOtherExact, AtBare, KeyedAtBare],
	[
		contained(on(RuleBare, "id"), on(AtBare, "id")),
		contained(on(KeyedRuleBare, "id"), on(KeyedAtBare, "id")),
		contained(on(RuleOther, "id"), on(AtOther, "id")),
		contained(on(RuleOtherExact, "id"), on(AtOtherExact, "id")),
		contained(on(KeyedRuleOther, "id"), on(KeyedAtOther, "id")),
		contained(on(KeyedRuleOtherExact, "id"), on(KeyedAtOtherExact, "id"))
	]
)

type Family = "numeric" | "keyed" | "text"

/**
 * A source: its relation, the B relation it reads, and its literal's meaning as the selection compares it, over B's
 * x as the box writes it.
 */
interface Source {
	readonly relation: SourceName
	readonly family: Family
	readonly holds: (x: Stored) => boolean
}

/** A stored x of the box: its SQL text and its exact value, a numeric(5, 1) in tenths or a text itself. */
interface Stored {
	readonly sql: string
	readonly exact: string
}

/** The values the box writes into each B's x. */
const STORED: { readonly [F in Family]: readonly [Stored, Stored] } = {
	numeric: [
		{ sql: "1.2", exact: "12" },
		{ sql: "1.3", exact: "13" }
	],
	keyed: [
		{ sql: "1.2", exact: "12" },
		{ sql: "1.3", exact: "13" }
	],
	text: [
		{ sql: "'abc'", exact: "abc" },
		{ sql: "'abd'", exact: "abd" }
	]
}

export const B_OF: { readonly [F in Family]: string } = {
	numeric: "BNumeric",
	keyed: "BKeyed",
	text: "BText"
}

/**
 * Each source and its literal's meaning: 1.25 and 1.30 at numeric(10, 2) are 12.5 and 13 tenths, 1.3 at x's own type
 * 13, and the bare 1.3, a value of x's numeric(5, 1) as written, 13 too, in a selection and in a rule's match binding,
 * over BNumeric and BKeyed alike; the 8-letter texts abcdef and abc themselves, the first longer than any x. A bare
 * literal of more digits than x holds is refused at compile (test/unit/analysis/literal-opposite), so no source reads
 * one.
 */
type SourceName =
	| "NumericOther"
	| "NumericOtherExact"
	| "NumericOwn"
	| "NumericBare"
	| "KeyedBare"
	| "RuleBare"
	| "KeyedRuleBare"
	| "RuleOther"
	| "RuleOtherExact"
	| "KeyedOtherExact"
	| "KeyedRuleOther"
	| "KeyedRuleOtherExact"
	| "TextOther"
	| "TextOtherExact"

export type Feature = `held ${SourceName}` | `refused ${SourceName}`

const SOURCES: Arr.NonEmptyReadonlyArray<Source> = [
	{ relation: "NumericOther", family: "numeric", holds: (x) => x.exact === "12.5" },
	{ relation: "NumericOtherExact", family: "numeric", holds: (x) => x.exact === "13" },
	{ relation: "NumericOwn", family: "numeric", holds: (x) => x.exact === "13" },
	{ relation: "NumericBare", family: "numeric", holds: (x) => x.exact === "13" },
	{ relation: "RuleBare", family: "numeric", holds: (x) => x.exact === "13" },
	{ relation: "KeyedBare", family: "keyed", holds: (x) => x.exact === "13" },
	{ relation: "KeyedRuleBare", family: "keyed", holds: (x) => x.exact === "13" },
	{ relation: "RuleOther", family: "numeric", holds: (x) => x.exact === "12.5" },
	{ relation: "RuleOtherExact", family: "numeric", holds: (x) => x.exact === "13" },
	{ relation: "KeyedOtherExact", family: "keyed", holds: (x) => x.exact === "13" },
	{ relation: "KeyedRuleOther", family: "keyed", holds: (x) => x.exact === "12.5" },
	{ relation: "KeyedRuleOtherExact", family: "keyed", holds: (x) => x.exact === "13" },
	{ relation: "TextOther", family: "text", holds: (x) => x.exact === "abcdef" },
	{ relation: "TextOtherExact", family: "text", holds: (x) => x.exact === "abc" }
]

const sourcesOf = (family: Family): ReadonlyArray<Source> =>
	Arr.filter(SOURCES, (s) => s.family === family)

const subsetsOf = <A>(items: ReadonlyArray<A>): Arr.NonEmptyReadonlyArray<ReadonlyArray<A>> =>
	Arr.reduce(items, Arr.of<ReadonlyArray<A>>([]), (subsets, item) =>
		Arr.appendAll(
			subsets,
			Arr.map(subsets, (s) => Arr.append(s, item))
		)
	)

const FAMILIES = ["numeric", "keyed", "text"] as const

export const RELATIONS: Arr.NonEmptyReadonlyArray<string> = [
	"BNumeric",
	"BKeyed",
	"BText",
	...Arr.map(SOURCES, (s) => s.relation)
]

/** A case: a family, B's row at id 1 (absent, or at one of its two values), and the sources holding id 1. */
interface Sketch {
	readonly family: Family
	readonly stored: Stored | undefined
	readonly sources: ReadonlyArray<Source>
}

export const sketchGen: Gen<Sketch> = (source) => {
	const family = source.draw(element(FAMILIES))
	const [low, high] = STORED[family]
	return {
		family,
		stored: source.draw(element<Stored | undefined>([undefined, low, high])),
		sources: source.draw(element(subsetsOf(sourcesOf(family))))
	}
}

export class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** Whether a source row at id 1 meets its containment: B holds id 1 at an x its literal equals. */
export const lawful = (s: Sketch, source: Source): boolean =>
	s.stored !== undefined && source.holds(s.stored)

/** A source's features: refused, and held where a value the box writes meets its literal. */
const featuresOf = (s: Source): Arr.NonEmptyReadonlyArray<Feature> => {
	const refused: Feature = `refused ${s.relation}`
	const held: Feature = `held ${s.relation}`
	return Arr.some([...STORED[s.family]], s.holds) ? [refused, held] : [refused]
}

export const FEATURES: Arr.NonEmptyReadonlyArray<Feature> = Arr.flatMap(SOURCES, featuresOf)

/**
 * Each situation with the case constructed to reach it, which a witness whose turn aims at it draws: a source refused
 * alone, its B row absent, and a source held alone, its B row at the value its literal equals. A drawn case reaches a
 * source refused alone only where the subset it draws holds that source and no other its row leaves unlawful, one case
 * in hundreds for a family of seven sources.
 */
export const aims: ReadonlyArray<readonly [Feature, Gen<Sketch>]> = Arr.flatMap(SOURCES, (s) => [
	[
		`refused ${s.relation}`,
		constant({ family: s.family, stored: undefined, sources: [s] })
	] as const,
	...Arr.map(
		Arr.filter([...STORED[s.family]], s.holds),
		(x) => [`held ${s.relation}`, constant({ family: s.family, stored: x, sources: [s] })] as const
	)
])

export const literalOf = (s: Sketch): string =>
	Formatter.format({
		family: s.family,
		stored: s.stored?.sql,
		sources: Arr.map(s.sources, (x) => x.relation)
	})

/** SelectorLiteral installed once per member (fin/installed.ts seatTemplate), which each case's seat holds. */
export const selectorLiteralTemplate = seatTemplate(
	import.meta,
	SelectorLiteral,
	"selector_literal"
)
