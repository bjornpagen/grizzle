/** What the properties of rule-query.test.ts read: its spaces, models and helpers. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import type { TableConstraintLaw } from "#compiler/laws/model/model.ts"
import { theoryViolations } from "#compiler/laws/model/violations.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import { type Law, sameLaw } from "#compiler/public/changeset.ts"
import { Text } from "#compiler/public/compute.ts"
import { Numeric, int4, numeric } from "#compiler/public/fields.ts"
import { query, type Rule, v } from "#compiler/public/query.ts"
import {
	check,
	contained,
	derived,
	key,
	on,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { namedLaw } from "#compiler/runtime/law-entry.ts"
import { numericMaxPrecision, numericMaxScale } from "#compiler/scalar/values/fault.ts"
import { installationsOf, rostersOf } from "#compiler/schema/own.ts"
import { type FixtureSchema, testArtifacts, testCompile } from "#test/support/compile.ts"
import { ownedInput } from "#test/support/policy.ts"

/**
 * A schema's artifacts with its laws' violation queries written, each rule over a query's checked against the checked
 * schema (laws/model/violations.ts theoryViolations), as generate writes them into the snapshot, and its installation
 * compiled as generate drafts it (program/install.ts compileInstallation over the complete install options),
 * every probe of each rule over a query among it (analysis/theory/query.ts probe, each navigated and checked as a
 * query over its region).
 */
export const compiledOf = (schema: FixtureSchema): Result.Result<SchemaArtifacts, CompileError> =>
	Result.flatMap(testArtifacts(schema, testCompile), (artifacts) =>
		Result.flatMap(theoryViolations(artifacts.laws.checked, artifacts.laws.theory), () =>
			Result.flatMap(ownedInput(schema), (owned) =>
				Result.map(
					compileInstallation(
						owned,
						completeInstallOptions(
							owned,
							installationsOf(owned),
							[],
							[],
							firstCodebook(rostersOf(owned))
						)
					),
					() => artifacts
				)
			)
		)
	)

/** How a definition binds a field: by a variable, or by a literal, which takes the type of the field it meets. */
type Bound = "variable" | "literal"

const bounds = ["variable", "literal"] as const

/** The Mark row a definition joins: none, or one binding its id and on each by a variable or a literal. */
type Joined = "none" | { readonly id: Bound; readonly on: Bound }

/** The Mark row a definition negates: none, one of the item, or one of the item whose on is a literal. */
type Negated = "none" | "item" | "literal"

/** How the rule reads the derived relation: itself, or through Item's semijoin with it on id, bound so. */
type Read = "itself" | Bound

type Kind = "into" | "out of" | "check" | "check named as Item's"

interface RuleCase {
	readonly kind: Bound
	readonly joined: Joined
	readonly negated: Negated
	readonly read: Read
	readonly rule: Kind
}

export const ruleCase: Gen<RuleCase> = (s) => ({
	kind: s.draw(element(bounds)),
	joined: s.draw(
		element<Joined>([
			"none",
			...Arr.flatMap(bounds, (id) => Arr.map(bounds, (on): Joined => ({ id, on })))
		])
	),
	negated: s.draw(element(["none", "item", "literal"] as const)),
	read: s.draw(element(["itself", ...bounds] as const)),
	rule: s.draw(element(["into", "out of", "check", "check named as Item's"] as const))
})

const Item = relation("Item", { id: int4, kind: int4 }, ["id"])

const Mark = relation("Mark", { id: int4, item: int4, on: int4 }, ["id"])

const Claim = relation("Claim", { item: int4 }, ["item"])

const Base = schema(
	"RuleQuery",
	[Item, Mark, Claim],
	[check("Positive", Item, (x) => x.not(x.eq(x.kind, 0)))]
)

/**
 * The case's schema: its derived relation, on a level of its own, then Item's semijoin with it and the rule over the
 * one the case reads.
 */
export const schemaOf = (c: RuleCase) => {
	const Marked = derived(
		"Marked",
		query(Base).rule((r) => {
			const { id, kind } = v(Item, "item")
			const { id: mark, on } = v(Mark, "mark")
			const items = r.match(Item, { id, kind: c.kind === "literal" ? 1 : kind })
			const joined =
				c.joined === "none"
					? items
					: items.match(Mark, {
							id: c.joined.id === "literal" ? 1 : mark,
							item: id,
							on: c.joined.on === "literal" ? 1 : on
						})
			const negated =
				c.negated === "none"
					? joined
					: joined.where(
							c.negated === "literal" ? r.not(Mark, { item: id, on: 1 }) : r.not(Mark, { item: id })
						)
			return negated.find({ id })
		})
	)
	const Middle = schema.extend([Base], "RuleQueryMiddle", [Marked], [])
	const Read = derived(
		"Read",
		query(Middle).rule((r) => {
			const { id } = v(Item, "item")
			return r
				.match(Item, { id })
				.match(Marked, { id: c.read === "literal" ? 1 : id })
				.find({ id })
		})
	)
	const side = c.read === "itself" ? Marked : Read
	const rule = (() => {
		switch (c.rule) {
			case "into":
				return contained(on(Claim, "item"), on(side, "id"))
			case "out of":
				return contained(on(side, "id"), on(Claim, "item"))
			case "check":
				return check("Nonzero", side, (x) => x.not(x.eq(x.id, 0)))
			case "check named as Item's":
				return check("Positive", side, (x) => x.not(x.eq(x.id, 0)))
		}
	})()
	return schema.extend([Middle], "RuleQueryTop", [Read], [rule])
}

/** The pattern a text field is refined by: Doc's own, one inside it, or one around it. */
type Pattern = "same" | "narrower" | "wider"

const patterns = ["same", "narrower", "wider"] as const

const paths = {
	same: str.bytes(100, str.regex("^[a-z][a-z/]*$")),
	narrower: str.bytes(60, str.regex("^[a-z]+$")),
	wider: str.bytes(200, str.regex("^.*$", "su"))
} as const

interface TextCase {
	readonly ref: Pattern
	readonly note: Pattern | "none"
	readonly read: "itself" | "semijoin"
	readonly rule: "into" | "out of"
}

export const textCase: Gen<TextCase> = (s) => ({
	ref: s.draw(element(patterns)),
	note: s.draw(element(["none", ...patterns] as const)),
	read: s.draw(element(["itself", "semijoin"] as const)),
	rule: s.draw(element(["into", "out of"] as const))
})

const Doc = relation("Doc", { id: int4, path: paths.same }, ["id"])

const refs = {
	same: relation("RefSame", { id: int4, path: paths.same }, ["id"]),
	narrower: relation("RefNarrower", { id: int4, path: paths.narrower }, ["id"]),
	wider: relation("RefWider", { id: int4, path: paths.wider }, ["id"])
} as const

const notes = {
	same: relation("NoteSame", { id: int4, path: paths.same }, ["id"]),
	narrower: relation("NoteNarrower", { id: int4, path: paths.narrower }, ["id"]),
	wider: relation("NoteWider", { id: int4, path: paths.wider }, ["id"])
} as const

const Docs = schema(
	"RuleQueryText",
	[Doc, refs.same, refs.narrower, refs.wider, notes.same, notes.narrower, notes.wider],
	[]
)

/**
 * The case's schema: Doc's paths derived, on a level of its own, then Doc's semijoin with them and a containment between
 * the one the case reads and Ref's paths.
 */
export const textSchemaOf = (c: TextCase) => {
	const Paths = derived(
		"Paths",
		query(Docs).rule((r) => {
			const { id, path } = v(Doc, "doc")
			const docs = r.match(Doc, { id, path })
			return (c.note === "none" ? docs : docs.where(r.not(notes[c.note], { path }))).find({
				id,
				path
			})
		})
	)
	const Middle = schema.extend([Docs], "RuleQueryTextMiddle", [Paths], [])
	const Read = derived(
		"Read",
		query(Middle).rule((r) => {
			const { id, path } = v(Doc, "doc")
			return r.match(Doc, { id, path }).match(Paths, { id, path }).find({ id, path })
		})
	)
	const side = c.read === "itself" ? Paths : Read
	const ref = refs[c.ref]
	return schema.extend(
		[Middle],
		"RuleQueryTextTop",
		[Read],
		[
			c.rule === "into"
				? contained(on(ref, "path"), on(side, "path"))
				: contained(on(side, "path"), on(ref, "path"))
		]
	)
}

export type TextReached = `a ${Exclude<Pattern, "same">} ${"ref" | "note"}` | "into" | "out of"

/**
 * The names a table holds of two laws: PostgreSQL reports a violation by its table and constraint name alone, so a name
 * under one table reports one law, a table constraint's or a rule's trigger's. One object discharging several laws, a
 * superkey's UNIQUE that a key and a lowered rule's foreign key both rest on, reports its first (laws/model/model.ts
 * constraintLawMap); two objects under one name clash where they report two.
 */
export const clashesOf = (constraints: ReadonlyArray<TableConstraintLaw>): ReadonlyArray<string> =>
	Arr.flatMap([...Map.groupBy(constraints, (x) => `${x.owner} ${x.name}`)], ([at, named]) =>
		Arr.dedupeWith(Arr.map(named, reportedOf), sameLaw).length > 1 ? [at] : []
	)

/** The law a constraint or trigger reports, its first, as an outcome names it. */
const reportedOf = (constraint: TableConstraintLaw): Law => namedLaw(constraint.laws[0].described)

/**
 * How a derived relation's two arms deliver its head literal: one in both, or one each, the union's discriminant. Both
 * taggings are one query of two arms, so a case's values alone tell them apart.
 */
type Tagging = "same" | "distinct"

/**
 * What the rules over the tagged relation and over its semijoin do with the literal's column: check it, key it, select
 * by it, contain a stored relation's pair in its pair, or contain a stored relation's item in its id alone, over the
 * relation of one arm and its semijoin, whose definition fixes the stored column its variable reads to the head literal.
 */
type TagRule = "check" | "key" | "selection" | "into" | "into id"

/** How a semijoin binds the tagged relation's column (TagCase.read). */
type TagRead = Bound | "own"

const tagReads = [...bounds, "own"] as const

/**
 * The Numeric a derived relation's head delivers, whose column is a computed numeric: a finite one, NaN, an infinity,
 * or one past every numeric(p, s), of one integer digit more than its greatest precision or of one fraction digit more
 * than its greatest scale.
 */
type DecimalLiteral = "finite" | "NaN" | "Infinity" | "-Infinity" | "past precision" | "past scale"

const decimalLiterals = [
	"finite",
	"NaN",
	"Infinity",
	"-Infinity",
	"past precision",
	"past scale"
] as const

export const decimalOf: { readonly [D in DecimalLiteral]: Numeric } = {
	finite: Numeric.fromOutput("1.5"),
	NaN: Numeric.fromOutput("NaN"),
	Infinity: Numeric.fromOutput("Infinity"),
	"-Infinity": Numeric.fromOutput("-Infinity"),
	"past precision": Numeric.fromOutput(`1${Str.repeat(numericMaxPrecision)("0")}`),
	"past scale": Numeric.fromOutput(`0.${Str.repeat(numericMaxScale)("0")}1`)
}

/** The literal a derived relation's head delivers: a text, or a Numeric (DecimalLiteral). */
type Literal = "text" | DecimalLiteral

const tagLiterals = ["text", ...decimalLiterals] as const

const taggings = ["same", "distinct"] as const

const tagRules = ["check", "key", "selection", "into", "into id"] as const

interface TagCase {
	readonly literal: Literal
	readonly tagging: Tagging
	/**
	 * How Item's semijoin with the tagged relation binds its column: by a variable a stored match binds, by a literal, or
	 * by a variable minted from the tagged relation, which only the head literal its definition delivers defines.
	 */
	readonly read: TagRead
	readonly rule: TagRule
}

export const tagCase: Gen<TagCase> = (s) => ({
	literal: s.draw(element(tagLiterals)),
	tagging: s.draw(element(taggings)),
	read: s.draw(element(tagReads)),
	rule: s.draw(element(tagRules))
})

const tags = str.bytes(20, str.regex("^[a-z]+$"))

const Tag = relation("Tag", { item: int4, tag: tags }, ["item"])

const Tags = schema("RuleQueryTags", [Item, Tag], [])

/**
 * The case's schema, its head literals texts: Item's facts tagged "a" in both arms, or "a" and "b", and in the one arm
 * of Once, on a level of their own, then Read and ReadOnce, Item's semijoins with them binding the tag by a variable or
 * a literal, and the case's rule over each: over Once and ReadOnce for a containment into the id alone, whose target a
 * foreign key holds where its one arm fixes a stored column.
 */
export const tagSchemaOf = (c: TagCase) => {
	const Tagged = derived(
		"Tagged",
		query(Tags)
			.rule((r) => {
				const { id } = v(Item, "item")
				return r.match(Item, { id }).find({ id, tag: "a" })
			})
			.rule((r) => {
				const { id } = v(Item, "item")
				return r.match(Item, { id }).find({ id, tag: c.tagging === "same" ? "a" : "b" })
			})
	)
	const Once = derived(
		"Once",
		query(Tags).rule((r) => {
			const { id } = v(Item, "item")
			return r.match(Item, { id }).find({ id, tag: "a" })
		})
	)
	const Middle = schema.extend([Tags], "RuleQueryTagsMiddle", [Tagged, Once], [])
	const ReadOnce = derived(
		"ReadOnce",
		query(Middle).rule((r) => {
			const { id } = v(Item, "item")
			const { tag } = v(Tag, "tag")
			const { tag: own } = v(Once, "once")
			return r
				.match(Item, { id })
				.match(Tag, { item: id, tag })
				.match(Once, { id, tag: c.read === "literal" ? "a" : c.read === "own" ? own : tag })
				.find({ id, tag })
		})
	)
	const Read = derived(
		"Read",
		query(Middle).rule((r) => {
			const { id } = v(Item, "item")
			const { tag } = v(Tag, "tag")
			const { tag: own } = v(Tagged, "tagged")
			return r
				.match(Item, { id })
				.match(Tag, { item: id, tag })
				.match(Tagged, { id, tag: c.read === "literal" ? "a" : c.read === "own" ? own : tag })
				.find({ id, tag })
		})
	)
	const rules = (() => {
		switch (c.rule) {
			case "check":
				return [
					check("NotA", Tagged, (x) => x.not(x.eq(x.tag, "a"))),
					check("NotA", Read, (x) => x.not(x.eq(x.tag, "a")))
				]
			case "key":
				return [key(on(Tagged, "tag")), key(on(Read, "tag"))]
			case "selection":
				return [
					contained(
						on(
							select(Tagged, (x) => x.eq(x.tag, "a")),
							"id"
						),
						on(Tag, "item")
					),
					contained(
						on(
							select(Read, (x) => x.eq(x.tag, "a")),
							"id"
						),
						on(Tag, "item")
					)
				]
			case "into":
				return [
					contained(on(Tag, "item", "tag"), on(Tagged, "id", "tag")),
					contained(on(Tag, "item", "tag"), on(Read, "id", "tag"))
				]
			case "into id":
				return [
					contained(on(Tag, "item"), on(Once, "id")),
					contained(on(Tag, "item"), on(ReadOnce, "id"))
				]
		}
	})()
	return schema.extend([Middle], "RuleQueryTagsTop", [Read, ReadOnce], rules)
}

const Amount = relation("Amount", { item: int4, amount: numeric(4, 2) }, ["item"])

const Amounts = schema("RuleQueryAmounts", [Item, Amount], [])

const three = Numeric.fromOutput("3")

/**
 * The case's schema, its head literals Decimals: Item's facts priced at `price` in both arms, or at `price` and 2.25,
 * and in the one arm of Once, on a level of their own, then Read and ReadOnce, Item's semijoins with them binding the
 * amount by a variable or a literal, and the case's rule over each, over Once and ReadOnce for a containment into the id
 * alone: ReadOnce's one arm, reading Amount's amount by a variable, fixes it to the head literal, a computed numeric,
 * which no selection states, so the rule keeps its triggers (laws.ts selectable).
 */
export const amountSchemaOf = (c: TagCase, price: Numeric) => {
	const Priced = derived(
		"Priced",
		query(Amounts)
			.rule((r) => {
				const { id } = v(Item, "item")
				return r.match(Item, { id }).find({ id, amount: price })
			})
			.rule((r) => {
				const { id } = v(Item, "item")
				return r
					.match(Item, { id })
					.find({ id, amount: c.tagging === "same" ? price : Numeric.fromOutput("2.25") })
			})
	)
	const Once = derived(
		"Once",
		query(Amounts).rule((r) => {
			const { id } = v(Item, "item")
			return r.match(Item, { id }).find({ id, amount: price })
		})
	)
	const Middle = schema.extend([Amounts], "RuleQueryAmountsMiddle", [Priced, Once], [])
	const ReadOnce = derived(
		"ReadOnce",
		query(Middle).rule((r) => {
			const { id } = v(Item, "item")
			const { amount } = v(Amount, "amount")
			const { amount: own } = v(Once, "once")
			return r
				.match(Item, { id })
				.match(Amount, { item: id, amount })
				.match(Once, {
					id,
					amount: c.read === "literal" ? price : c.read === "own" ? own : amount
				})
				.find({ id, amount })
		})
	)
	const Read = derived(
		"Read",
		query(Middle).rule((r) => {
			const { id } = v(Item, "item")
			const { amount } = v(Amount, "amount")
			const { amount: own } = v(Priced, "priced")
			return r
				.match(Item, { id })
				.match(Amount, { item: id, amount })
				.match(Priced, {
					id,
					amount: c.read === "literal" ? price : c.read === "own" ? own : amount
				})
				.find({ id, amount })
		})
	)
	const rules = (() => {
		switch (c.rule) {
			case "check":
				return [
					check("NotThree", Priced, (x) => x.not(x.eq(x.amount, three))),
					check("NotThree", Read, (x) => x.not(x.eq(x.amount, three)))
				]
			case "key":
				return [key(on(Priced, "amount")), key(on(Read, "amount"))]
			case "selection":
				return [
					contained(
						on(
							select(Priced, (x) => x.eq(x.amount, price)),
							"id"
						),
						on(Amount, "item")
					),
					contained(
						on(
							select(Read, (x) => x.eq(x.amount, price)),
							"id"
						),
						on(Amount, "item")
					)
				]
			case "into":
				return [
					contained(on(Amount, "item", "amount"), on(Priced, "id", "amount")),
					contained(on(Amount, "item", "amount"), on(Read, "id", "amount"))
				]
			case "into id":
				return [
					contained(on(Amount, "item"), on(Once, "id")),
					contained(on(Amount, "item"), on(ReadOnce, "id"))
				]
		}
	})()
	return schema.extend([Middle], "RuleQueryAmountsTop", [Read, ReadOnce], rules)
}

/**
 * What a definition of Item negates: one table, Mark; a join of Mark and Note on the item, a query; a union of Mark's and
 * Note's items, a query of two rules; the join derived on a level below; a query that negates in turn; or a query that
 * aggregates, whose groups a probe reads where a write touches them (analysis/theory/query.ts GroupedMatch).
 */
type NegatedSource = "table" | "join" | "union" | "derived" | "aggregate" | "negating"

export const negatedSources = [
	"table",
	"join",
	"union",
	"derived",
	"aggregate",
	"negating"
] as const

/** Where the negation stands among the definition's filters: alone, inside a conjunction, or inside one nested in another. */
type Placement = "alone" | "conjunction" | "nested conjunction"

interface NegationCase {
	readonly source: NegatedSource
	readonly placement: Placement
	/** Whether the negation binds Mark's on, or the query's, to a literal beside the item. */
	readonly literal: boolean
	readonly read: "itself" | "semijoin"
	readonly rule: Exclude<Kind, "check named as Item's"> | "key"
}

export const negationCase: Gen<NegationCase> = (s) => ({
	source: s.draw(element(negatedSources)),
	placement: s.draw(element(["alone", "conjunction", "nested conjunction"] as const)),
	literal: s.draw(element([false, true])),
	read: s.draw(element(["itself", "semijoin"] as const)),
	rule: s.draw(element(["into", "out of", "check", "key"] as const))
})

const Note = relation("Note", { item: int4, on: int4 }, ["item", "on"])

const Notes = schema("RuleQueryNegated", [Item, Mark, Claim, Note], [])

/**
 * The case's schema: Mark joined with Note derived on a level of its own, then Item's facts negating the case's source,
 * then Item's semijoin with them and the case's rule over the one it reads.
 */
export const negationSchemaOf = (c: NegationCase) => {
	const join = query(Notes).rule((r) => {
		const { item, on } = v(Mark, "mark")
		return r.match(Mark, { item, on }).match(Note, { item, on }).find({ item, on })
	})
	const Joined = derived("Joined", join)
	const Middle = schema.extend([Notes], "RuleQueryNegatedMiddle", [Joined], [])
	const union = query(Middle)
		.rule((r) => {
			const { item, on } = v(Mark, "mark")
			return r.match(Mark, { item, on }).find({ item, on })
		})
		.rule((r) => {
			const { item, on } = v(Note, "note")
			return r.match(Note, { item, on }).find({ item, on })
		})
	const aggregate = query(Middle).rule((r) => {
		const { id, item, on } = v(Mark, "mark")
		return r.match(Mark, { id, item, on }).find({ item, on: r.max(on) })
	})
	const negating = query(Middle).rule((r) => {
		const { item, on } = v(Mark, "mark")
		return r.match(Mark, { item, on }).where(r.not(Note, { item })).find({ item, on })
	})
	const Unmarked = derived(
		"Unmarked",
		query(Middle).rule((r) => {
			const { id, kind } = v(Item, "item")
			const negation = (() => {
				switch (c.source) {
					case "table":
						return c.literal ? r.not(Mark, { item: id, on: 1 }) : r.not(Mark, { item: id })
					case "join":
						return c.literal ? r.not(join, { item: id, on: 1 }) : r.not(join, { item: id })
					case "union":
						return c.literal ? r.not(union, { item: id, on: 1 }) : r.not(union, { item: id })
					case "derived":
						return c.literal ? r.not(Joined, { item: id, on: 1 }) : r.not(Joined, { item: id })
					case "aggregate":
						return c.literal
							? r.not(aggregate, { item: id, on: 1 })
							: r.not(aggregate, { item: id })
					case "negating":
						return c.literal ? r.not(negating, { item: id, on: 1 }) : r.not(negating, { item: id })
				}
			})()
			const items = r.match(Item, { id, kind })
			const filtered = (() => {
				switch (c.placement) {
					case "alone":
						return items.where(negation)
					case "conjunction":
						return items.where(r.and([r.ne(kind, 0), negation]))
					case "nested conjunction":
						return items.where(r.and([r.ne(kind, 0), r.and([negation, r.ne(id, 0)])]))
				}
			})()
			return filtered.find({ id })
		})
	)
	const Upper = schema.extend([Middle], "RuleQueryNegatedUpper", [Unmarked], [])
	const Read = derived(
		"Read",
		query(Upper).rule((r) => {
			const { id } = v(Item, "item")
			return r.match(Item, { id }).match(Unmarked, { id }).find({ id })
		})
	)
	const side = c.read === "itself" ? Unmarked : Read
	const rule = (() => {
		switch (c.rule) {
			case "into":
				return contained(on(Claim, "item"), on(side, "id"))
			case "out of":
				return contained(on(side, "id"), on(Claim, "item"))
			case "check":
				return check("Nonzero", side, (x) => x.not(x.eq(x.id, 0)))
			case "key":
				return key(on(side, "id"))
		}
	})()
	return schema.extend([Upper], "RuleQueryNegatedTop", [Read], [rule])
}

export type NegationReached =
	| `negates ${NegatedSource}`
	| `negates ${Placement}`
	| "a literal negated on"
	| `${NegationCase["rule"]} read through a semijoin`
	| NegationCase["rule"]

export type TagReached =
	| `${Literal} literal`
	| `${Tagging} tagging`
	| `read by ${TagRead}`
	| TagRule

export type Reached =
	| `a literal ${"kind" | "mark id" | "mark on" | "negated on" | "read id"}`
	| Kind

/**
 * One case of the computed box: a rule over Unmarked, the items no Names row holds at a term an inlined definition computes,
 * Unmarked one rule or two (`rules`), each matching Titled, a query of one rule over Titles whose head collapses its
 * title's whitespace, and negating Names at that term: flattened, the variable Titled's head defines is that computed term
 * in the negation's binding (analysis/theory/query.ts definedArm).
 */
interface ComputedCase {
	readonly rules: "one rule" | "two rules"
	readonly rule: "into" | "out of" | "check" | "key"
}

export const computedCase: Gen<ComputedCase> = (s) => ({
	rules: s.draw(element(["one rule", "two rules"] as const)),
	rule: s.draw(element(["into", "out of", "check", "key"] as const))
})

export type ComputedReached = ComputedCase["rules"] | ComputedCase["rule"]

const Titles = relation("Titles", { id: int4, title: str.bytes(200, str.regex("^.*$", "su")) }, [
	"id"
])

const Names = relation("Names", { name: str.bytes(60, str.regex("^[a-z]+$")) }, ["name"])

const Computed = schema("RuleQueryComputed", [Item, Titles, Names, Claim], [])

/** The computed box's schema (ComputedCase): Unmarked of the case's rules, and the case's rule over it. */
export const computedSchemaOf = (c: ComputedCase) => {
	const titled = query(Computed).rule((r) => {
		const { id, title } = v(Titles, "doc")
		return r.match(Titles, { id, title }).find({ id, name: Text.collapse(title) })
	})
	const unmarked = (kind: number) => (r: Rule<typeof Computed>) => {
		const { id, name } = v(titled, "titled")
		return r
			.match(titled, { id, name })
			.match(Item, { id, kind })
			.where(r.not(Names, { name }))
			.find({ id })
	}
	const Unmarked = derived(
		"Unmarked",
		c.rules === "one rule"
			? query(Computed).rule(unmarked(0))
			: query(Computed).rule(unmarked(0)).rule(unmarked(1))
	)
	const rule = (() => {
		switch (c.rule) {
			case "into":
				return contained(on(Claim, "item"), on(Unmarked, "id"))
			case "out of":
				return contained(on(Unmarked, "id"), on(Claim, "item"))
			case "check":
				return check("Nonzero", Unmarked, (x) => x.not(x.eq(x.id, 0)))
			case "key":
				return key(on(Unmarked, "id"))
		}
	})()
	return schema.extend([Computed], "RuleQueryComputedTop", [Unmarked], [rule])
}
