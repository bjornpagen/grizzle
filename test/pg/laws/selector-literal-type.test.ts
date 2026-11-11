/**
 * A containment into a side selected by `field = literal`, through grizzle's lowering on PostgreSQL 19rc1, where the
 * literal is bare, typed at the field's own type, or typed at another: `select(B, (b) => b.eq(b.x,
 * Compute.literal(pg.numeric(10, 2), "1.25")))` over a numeric(5, 1) field x compares at numeric(10, 2), as a query
 * compares it, so no x equals it. A bare literal adopts the field's type, rounded as PostgreSQL's coercion stores it
 * (1.25 at numeric(5, 1) is 1.3); a typed one fixes the field only where the field's type holds its value exactly
 * (analysis/theory/laws.ts LawSides.selector), on a select() side and on a rule over a query whose match binds the
 * field to it alike.
 *
 * - **The specification turned into a checker:** each source row's containment read row by row: a source row commits
 *   exactly when B holds its id with an x the literal equals as the selection compares them, the exact decimal value
 *   at numeric and the text itself at text. A refusal must be 23503 with an unlawful source row written, and a foreign
 *   key it names must be one of those rows' relations.
 *
 * The box: one of three B relations (numeric(5, 1) keyed by id, the same keyed by id and x, text of up to 3 letters),
 * its row at id 1 absent or at each of two values, and every subset of that relation's sources holding id 1, B's row
 * written first, in one transaction. Types of two carriers never meet without Compute.base, so a literal of another
 * type than its field's is one of another numeric typmod or text refinement. Over the B keyed by id and x, a
 * containment into its selection over id holds a key only where the literal fixes x, so the box holds the fixing
 * literal's select() side and the rules of both, the other keeping its triggers.
 *
 * Plants (~/.cache/grizzle-release/DENTRIAGE/plants): selector-retyped (a typed literal retyped at its field's type as
 * before, so the numeric(10, 2) 1.25 fixes x at 1.3 and a source over B's 1.3 commits) and rule-fixing-unchecked (the
 * rule lowering counting a typed literal its field does not hold as fixing it, so the keyed B's rule over 1.25 is
 * refused when the schema compiles as a containment into an unkeyed side): each caught.
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Data, Effect, Formatter, Option } from "effect"
import { Compute } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema, select } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { cleared, seatOf } from "#test/pg/fin/installed.ts"
import { caseHang } from "#test/support/limits.ts"
import { attempt, momentText, refusalText } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A text of up to 8 letters, a type other than BText's x, of up to 3. */
const Longer = str.regex("^[a-z]{1,8}$")

const BNumeric = relation("BNumeric", { id: pg.int4, x: pg.numeric(5, 1) }, ["id"])
/** BNumeric keyed by id and x, so a containment into it over id is keyed only where its selection fixes x. */
const BKeyed = relation("BKeyed", { id: pg.int4, x: pg.numeric(5, 1) }, ["id", "x"])
const BText = relation("BText", { id: pg.int4, x: str.regex("^[a-z]{1,3}$") }, ["id"])

const NumericOther = relation("NumericOther", { id: pg.int4 }, ["id"])
const NumericOtherExact = relation("NumericOtherExact", { id: pg.int4 }, ["id"])
const NumericOwn = relation("NumericOwn", { id: pg.int4 }, ["id"])
const NumericBare = relation("NumericBare", { id: pg.int4 }, ["id"])
const KeyedOtherExact = relation("KeyedOtherExact", { id: pg.int4 }, ["id"])
const KeyedRuleOther = relation("KeyedRuleOther", { id: pg.int4 }, ["id"])
const KeyedRuleOtherExact = relation("KeyedRuleOtherExact", { id: pg.int4 }, ["id"])
const TextOther = relation("TextOther", { id: pg.int4 }, ["id"])
const TextOtherExact = relation("TextOtherExact", { id: pg.int4 }, ["id"])
const RuleOther = relation("RuleOther", { id: pg.int4 }, ["id"])
const RuleOtherExact = relation("RuleOtherExact", { id: pg.int4 }, ["id"])

const Selected = schema(
	"selector_literal",
	{
		BNumeric,
		BKeyed,
		BText,
		NumericOther,
		NumericOtherExact,
		NumericOwn,
		NumericBare,
		KeyedOtherExact,
		KeyedRuleOther,
		KeyedRuleOtherExact,
		TextOther,
		TextOtherExact,
		RuleOther,
		RuleOtherExact
	},
	[
		contained(
			on(NumericOther, "id"),
			on(
				select(BNumeric, (b) => b.eq(b.x, Compute.literal(pg.numeric(10, 2), "1.25"))),
				"id"
			)
		),
		contained(
			on(NumericOtherExact, "id"),
			on(
				select(BNumeric, (b) => b.eq(b.x, Compute.literal(pg.numeric(10, 2), "1.30"))),
				"id"
			)
		),
		contained(
			on(NumericOwn, "id"),
			on(
				select(BNumeric, (b) => b.eq(b.x, Compute.literal(BNumeric.fields.x, "1.3"))),
				"id"
			)
		),
		contained(
			on(NumericBare, "id"),
			on(
				select(BNumeric, (b) => b.eq(b.x, "1.25")),
				"id"
			)
		),
		contained(
			on(KeyedOtherExact, "id"),
			on(
				select(BKeyed, (b) => b.eq(b.x, Compute.literal(pg.numeric(10, 2), "1.30"))),
				"id"
			)
		),
		contained(
			on(TextOther, "id"),
			on(
				select(BText, (b) => b.eq(b.x, Compute.literal(Longer, "abcdef"))),
				"id"
			)
		),
		contained(
			on(TextOtherExact, "id"),
			on(
				select(BText, (b) => b.eq(b.x, Compute.literal(Longer, "abc"))),
				"id"
			)
		)
	]
)

/** The ids of BNumeric whose x a numeric(10, 2) literal names: matched by a rule over a query, which binds x to it. */
const numericAt = (value: string) =>
	query(Selected).rule((r) => {
		const { id } = v(BNumeric, "b")
		return r.match(BNumeric, { id, x: Compute.literal(pg.numeric(10, 2), value) }).find({ id })
	})

/**
 * The ids of BKeyed whose x a numeric(10, 2) literal names. BKeyed is keyed by id and x, so the rule lowers to a foreign
 * key only where the literal fixes x.
 */
const keyedAt = (value: string) =>
	query(Selected).rule((r) => {
		const { id } = v(BKeyed, "b")
		return r.match(BKeyed, { id, x: Compute.literal(pg.numeric(10, 2), value) }).find({ id })
	})

const AtOther = derived("AtOther", numericAt("1.25"))
const AtOtherExact = derived("AtOtherExact", numericAt("1.30"))
const KeyedAtOther = derived("KeyedAtOther", keyedAt("1.25"))
const KeyedAtOtherExact = derived("KeyedAtOtherExact", keyedAt("1.30"))

const SelectorLiteral = schema.extend(
	Selected,
	"selector_literal_rules",
	{ AtOther, AtOtherExact, KeyedAtOther, KeyedAtOtherExact },
	[
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

const B_OF: { readonly [F in Family]: string } = {
	numeric: "BNumeric",
	keyed: "BKeyed",
	text: "BText"
}

/**
 * Each source and its literal's meaning: 1.25 and 1.30 at numeric(10, 2) are 12.5 and 13 tenths, 1.3 at x's own type
 * 13, the bare 1.25 at numeric(5, 1) rounded to 13; the 8-letter texts abcdef and abc themselves, the first longer
 * than any x.
 */
type SourceName =
	| "NumericOther"
	| "NumericOtherExact"
	| "NumericOwn"
	| "NumericBare"
	| "RuleOther"
	| "RuleOtherExact"
	| "KeyedOtherExact"
	| "KeyedRuleOther"
	| "KeyedRuleOtherExact"
	| "TextOther"
	| "TextOtherExact"

type Feature = `held ${SourceName}` | `refused ${SourceName}`

const SOURCES: Arr.NonEmptyReadonlyArray<Source> = [
	{ relation: "NumericOther", family: "numeric", holds: (x) => x.exact === "12.5" },
	{ relation: "NumericOtherExact", family: "numeric", holds: (x) => x.exact === "13" },
	{ relation: "NumericOwn", family: "numeric", holds: (x) => x.exact === "13" },
	{ relation: "NumericBare", family: "numeric", holds: (x) => x.exact === "13" },
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

const RELATIONS: Arr.NonEmptyReadonlyArray<string> = [
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

const sketchGen: Gen<Sketch> = (source) => {
	const family = source.draw(element(FAMILIES))
	const [low, high] = STORED[family]
	return {
		family,
		stored: source.draw(element<Stored | undefined>([undefined, low, high])),
		sources: source.draw(element(subsetsOf(sourcesOf(family))))
	}
}

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** Whether a source row at id 1 meets its containment: B holds id 1 at an x its literal equals. */
const lawful = (s: Sketch, source: Source): boolean =>
	s.stored !== undefined && source.holds(s.stored)

/** A source's features: refused, and held where a value the box writes meets its literal. */
const featuresOf = (s: Source): Arr.NonEmptyReadonlyArray<Feature> => {
	const refused: Feature = `refused ${s.relation}`
	const held: Feature = `held ${s.relation}`
	return Arr.some([...STORED[s.family]], s.holds) ? [refused, held] : [refused]
}

const FEATURES: Arr.NonEmptyReadonlyArray<Feature> = Arr.flatMap(SOURCES, featuresOf)

const literalOf = (s: Sketch): string =>
	Formatter.format({
		family: s.family,
		stored: s.stored?.sql,
		sources: Arr.map(s.sources, (x) => x.relation)
	})

layer(Substrate.layer)(
	"a containment into a side a literal selects, bare, at its field's type or at another, on PostgreSQL 19rc1",
	(it) => {
		it.effect(
			"commit exactly the states whose every source row's B row holds an x the literal equals as the selection compares them, refusing the rest by 23503",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const seat = yield* seatOf(SelectorLiteral, RELATIONS, "selector_literal")
						const col = (r: string, f: string) => seat.column(r, f)
						return yield* exhaust(
							{
								suite: "laws/selector-literal-type",
								generator: sketchGen,
								literal: literalOf,
								box: "one B relation of numeric(5, 1), keyed by id or by id and x, or of text of up to 3 letters, its row at id 1 absent or at one of two values, and every subset of its sources holding id 1, B written first",
								oracle: {
									kind: "specification",
									name: "each source row's containment as a checker: B holds its id at an x its literal equals as the selection compares them"
								},
								coverage: requiredInSpace<Feature>(FEATURES),
								caseHang
							},
							(s, c) =>
								Effect.gen(function* () {
									const b = B_OF[s.family]
									const statements = [
										...(s.stored === undefined
											? []
											: [
													`INSERT INTO ${seat.table(b)} (${col(b, "id")}, ${col(b, "x")}) VALUES (1, ${s.stored.sql})`
												]),
										...Arr.map(
											s.sources,
											(x) =>
												`INSERT INTO ${seat.table(x.relation)} (${col(x.relation, "id")}) VALUES (1)`
										)
									]
									const unlawful = Arr.filter(s.sources, (x) => !lawful(s, x))
									const real = yield* attempt(seat.session, statements)
									if (real.kind === "committed") {
										yield* cleared(seat, RELATIONS)
										if (unlawful.length > 0) {
											return yield* new Disagreed({
												message: `committed a state whose rows of ${Arr.join(
													Arr.map(unlawful, (x) => x.relation),
													", "
												)} meet no B row their literal selects: ${literalOf(s)}`
											})
										}
										for (const x of s.sources) {
											c.note(`held ${x.relation}`)
										}
										return
									}
									const named = seat.refusedBy(real.fields)
									const namesLawful = Option.exists(
										named,
										(k) =>
											k.kind === "foreign" && !Arr.some(unlawful, (x) => x.relation === k.relation)
									)
									if (real.fields.code !== "23503" || unlawful.length === 0 || namesLawful) {
										return yield* new Disagreed({
											message: `refused ${momentText(real.moment)} by ${refusalText(real.fields)}, where the unlawful rows are ${Formatter.format(
												Arr.map(unlawful, (x) => x.relation)
											)}: ${literalOf(s)}`
										})
									}
									if (unlawful.length === 1) {
										c.note(`refused ${Arr.getUnsafe(unlawful, 0).relation}`)
									}
								})
						)
					})
				)
		)
	}
)
