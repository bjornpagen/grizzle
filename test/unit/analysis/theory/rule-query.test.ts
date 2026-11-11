/**
 * Rules over queries compile whenever the schema builders admit them: the violation query and every trigger probe of
 * a rule whose side reads a derived relation are descriptions grizzle writes itself, so the checker refusing one is
 * grizzle's defect, never the schema's.
 *
 * The box is every rule of four kinds (a containment into the derived relation, one out of it, and a check over it
 * under a name of its own or under the name of Item's own check, a table it reads) over a derived relation of Item,
 * read directly or through Item's semijoin with it, binding its own id by a variable or by a literal. The definition
 * binds Item's kind by a variable or a literal, may join a Mark row whose id and on it binds by a variable or a literal,
 * and may negate a Mark row of the item, binding its on by a literal or not at all: each probe site a literal binding
 * reaches, a match's pinned key, a withdrawn match's field, an anti-join's binding and a match of a derived relation
 * inlined in another's definition.
 *
 * A second box correlates texts of different refinements: a containment into or out of a derived relation of Doc,
 * read directly or through Doc's semijoin with it, between Doc's path and a Ref's of the same, a narrower or a wider
 * pattern, the definition negating a Note of the doc's path of each of those patterns or none. Equality of two texts is
 * the equality of their bytes whatever patterns refine them, so each correlation is admitted, as a stored foreign key
 * between them is.
 *
 * A third box reads a head literal: a derived relation of Item whose two arms deliver a text or a Decimal as a
 * JavaScript literal, one in both or one each, the union's discriminant, read directly and through Item's semijoin with
 * it binding it by a variable a stored match binds, by a literal, or by a variable minted from the relation itself,
 * which only the head literal defines, under a check, a key and a selection that read it, and a containment into it,
 * on its pair or on its id alone, the semijoin's definition then fixing the stored column it reads to the literal. The
 * Decimal is finite, NaN, an infinity, or one past every numeric(p, s), of one integer digit more than its greatest
 * precision or one fraction digit more than its greatest scale. A
 * bare head literal takes its column's type, a Decimal's the computed numeric of the bound its analysis proves, which
 * no numeric(p, s) states for any but the finite one, so it stands wherever a term of the column does; a variable only
 * a head literal defines is that literal.
 *
 * A fourth box negates: a derived relation of Item whose definition negates Mark, a join of Mark and Note (a query),
 * their union (a query of two rules), the join derived on a level below, a query that aggregates or one that negates in
 * turn, alone among its filters, inside a conjunction or inside a conjunction nested in one, binding Mark's on by a
 * literal or not at all, read itself or through Item's semijoin with it under a containment into it, one out of it, a
 * check and a key. A negation of select-project-join arms is admitted, the conjunction's included, and a negation of a
 * query a rule may not read is refused UnsupportedLawFamily, naming what the query does.
 *
 * The oracle is the builders' admission: a schema schema.extend builds compiles to its artifacts, and its laws'
 * violation queries are written as generate writes them, each rule's checked there (laws/model/violations.ts
 * theoryViolations). Beside it, each name a
 * table holds a constraint or a rule's trigger under reports one law, since PostgreSQL reports a violation by its table
 * and that name alone: a check over the derived relation, under its own name or Item's check's, is held under a name of
 * its law's.
 *
 * Plants (~/.cache/grizzle-release/BR03/plants): rule-literal-binding-first (an equation binding a literal written
 * literal first, which the checker refuses) for the first box; rule-text-meet-narrowed (two texts of different
 * patterns met as the first's pattern, not the wildcard) for the second; rule-head-literal-untyped (a bare head literal
 * left untyped where a term of its column stands) for the third; rule-negation-conjunction-whole (a conjunction holding
 * a negation read whole, which refuses it as a negation below a condition) and rule-negation-nested-admitted (a negated
 * query that negates in turn admitted, its inner negation dropped) for the fourth.
 *
 * Features: each rule kind and each literal binding site for the first box; each pattern relation and negated note for
 * the second; each literal kind, arm placement and reader for the third; each negated source, placement and reader,
 * admitted and refused, for the fourth.
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import type { CompileError, CompileReasonTag } from "#compiler/core/errors.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import * as Result from "#compiler/core/result.ts"
import { numericMaxPrecision, numericMaxScale } from "#compiler/ir/scalar.ts"
import type { TableConstraintLaw } from "#compiler/laws/model/model.ts"
import { theoryViolations } from "#compiler/laws/model/violations.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import { type Law, sameLaw } from "#compiler/public/changeset.ts"
import { Decimal, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
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
import { assert } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * A schema's artifacts with its laws' violation queries written, each rule over a query's checked against the checked
 * schema (laws/model/violations.ts theoryViolations), as generate writes them into the snapshot.
 */
const compiledOf = (schema: unknown): Result.Result<SchemaArtifacts, CompileError> =>
	Result.flatMap(testArtifacts(schema, testCompile), (artifacts) =>
		Result.map(theoryViolations(artifacts.laws.checked, artifacts.laws.theory), () => artifacts)
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

const ruleCase: Gen<RuleCase> = (s) => ({
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

const Item = relation("Item", { id: pg.integer, kind: pg.integer }, ["id"])
const Mark = relation("Mark", { id: pg.integer, item: pg.integer, on: pg.integer }, ["id"])
const Claim = relation("Claim", { item: pg.integer }, ["item"])
const Base = schema("RuleQuery", { Item, Mark, Claim }, [
	check("Positive", Item, (x) => x.not(x.eq(x.kind, 0)))
])

/**
 * The case's schema: its derived relation, on a level of its own, then Item's semijoin with it and the rule over the
 * one the case reads.
 */
const schemaOf = (c: RuleCase) => {
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
	const Middle = schema.extend(Base, "RuleQueryMiddle", { Marked }, [])
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
	return schema.extend(Middle, "RuleQueryTop", { Read }, [rule])
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

const textCase: Gen<TextCase> = (s) => ({
	ref: s.draw(element(patterns)),
	note: s.draw(element(["none", ...patterns] as const)),
	read: s.draw(element(["itself", "semijoin"] as const)),
	rule: s.draw(element(["into", "out of"] as const))
})

const Doc = relation("Doc", { id: pg.integer, path: paths.same }, ["id"])
const refs = {
	same: relation("RefSame", { id: pg.integer, path: paths.same }, ["id"]),
	narrower: relation("RefNarrower", { id: pg.integer, path: paths.narrower }, ["id"]),
	wider: relation("RefWider", { id: pg.integer, path: paths.wider }, ["id"])
} as const
const notes = {
	same: relation("NoteSame", { id: pg.integer, path: paths.same }, ["id"]),
	narrower: relation("NoteNarrower", { id: pg.integer, path: paths.narrower }, ["id"]),
	wider: relation("NoteWider", { id: pg.integer, path: paths.wider }, ["id"])
} as const
const Docs = schema(
	"RuleQueryText",
	{
		Doc,
		RefSame: refs.same,
		RefNarrower: refs.narrower,
		RefWider: refs.wider,
		NoteSame: notes.same,
		NoteNarrower: notes.narrower,
		NoteWider: notes.wider
	},
	[]
)

/**
 * The case's schema: Doc's paths derived, on a level of its own, then Doc's semijoin with them and a containment between
 * the one the case reads and Ref's paths.
 */
const textSchemaOf = (c: TextCase) => {
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
	const Middle = schema.extend(Docs, "RuleQueryTextMiddle", { Paths }, [])
	const Read = derived(
		"Read",
		query(Middle).rule((r) => {
			const { id, path } = v(Doc, "doc")
			return r.match(Doc, { id, path }).match(Paths, { id, path }).find({ id, path })
		})
	)
	const side = c.read === "itself" ? Paths : Read
	const ref = refs[c.ref]
	return schema.extend(Middle, "RuleQueryTextTop", { Read }, [
		c.rule === "into"
			? contained(on(ref, "path"), on(side, "path"))
			: contained(on(side, "path"), on(ref, "path"))
	])
}

type TextReached = `a ${Exclude<Pattern, "same">} ${"ref" | "note"}` | "into" | "out of"

/**
 * The names a table holds of two laws: PostgreSQL reports a violation by its table and constraint name alone, so a name
 * under one table reports one law, a table constraint's or a rule's trigger's. One object discharging several laws, a
 * superkey's UNIQUE that a key and a lowered rule's foreign key both rest on, reports its first (laws/model/model.ts
 * constraintLawMap); two objects under one name clash where they report two.
 */
const clashesOf = (constraints: ReadonlyArray<TableConstraintLaw>): ReadonlyArray<string> =>
	Arr.flatMap([...Map.groupBy(constraints, (x) => `${x.owner} ${x.name}`)], ([at, named]) =>
		Arr.dedupeWith(Arr.map(named, reportedOf), sameLaw).length > 1 ? [at] : []
	)

/** The law a constraint or trigger reports, its first, as an outcome names it. */
const reportedOf = (constraint: TableConstraintLaw): Law => constraint.laws[0].described

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
 * The Decimal a derived relation's head delivers, whose column is a computed numeric: a finite one, NaN, an infinity,
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

const decimalOf: { readonly [D in DecimalLiteral]: Decimal } = {
	finite: Decimal.fromOutput("1.5"),
	NaN: Decimal.fromOutput("NaN"),
	Infinity: Decimal.fromOutput("Infinity"),
	"-Infinity": Decimal.fromOutput("-Infinity"),
	"past precision": Decimal.fromOutput(`1${Str.repeat(numericMaxPrecision.value)("0")}`),
	"past scale": Decimal.fromOutput(`0.${Str.repeat(numericMaxScale.value)("0")}1`)
}

/** The literal a derived relation's head delivers: a text, or a Decimal (DecimalLiteral). */
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

const tagCase: Gen<TagCase> = (s) => ({
	literal: s.draw(element(tagLiterals)),
	tagging: s.draw(element(taggings)),
	read: s.draw(element(tagReads)),
	rule: s.draw(element(tagRules))
})

const tags = str.bytes(20, str.regex("^[a-z]+$"))
const Tag = relation("Tag", { item: pg.integer, tag: tags }, ["item"])
const Tags = schema("RuleQueryTags", { Item, Tag }, [])

/**
 * The case's schema, its head literals texts: Item's facts tagged "a" in both arms, or "a" and "b", and in the one arm
 * of Once, on a level of their own, then Read and ReadOnce, Item's semijoins with them binding the tag by a variable or
 * a literal, and the case's rule over each: over Once and ReadOnce for a containment into the id alone, whose target a
 * foreign key holds where its one arm fixes a stored column.
 */
const tagSchemaOf = (c: TagCase) => {
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
	const Middle = schema.extend(Tags, "RuleQueryTagsMiddle", { Tagged, Once }, [])
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
	return schema.extend(Middle, "RuleQueryTagsTop", { Read, ReadOnce }, rules)
}

const Amount = relation("Amount", { item: pg.integer, amount: pg.numeric(4, 2) }, ["item"])
const Amounts = schema("RuleQueryAmounts", { Item, Amount }, [])
const three = Decimal.fromOutput("3")

/**
 * The case's schema, its head literals Decimals: Item's facts priced at `price` in both arms, or at `price` and 2.25,
 * and in the one arm of Once, on a level of their own, then Read and ReadOnce, Item's semijoins with them binding the
 * amount by a variable or a literal, and the case's rule over each, over Once and ReadOnce for a containment into the id
 * alone: ReadOnce's one arm, reading Amount's amount by a variable, fixes it to the head literal, a computed numeric,
 * which no selection states, so the rule keeps its triggers (laws.ts selectable).
 */
const amountSchemaOf = (c: TagCase, price: Decimal) => {
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
					.find({ id, amount: c.tagging === "same" ? price : Decimal.fromOutput("2.25") })
			})
	)
	const Once = derived(
		"Once",
		query(Amounts).rule((r) => {
			const { id } = v(Item, "item")
			return r.match(Item, { id }).find({ id, amount: price })
		})
	)
	const Middle = schema.extend(Amounts, "RuleQueryAmountsMiddle", { Priced, Once }, [])
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
	return schema.extend(Middle, "RuleQueryAmountsTop", { Read, ReadOnce }, rules)
}

/**
 * What a definition of Item negates: one table, Mark; a join of Mark and Note on the item, a query; a union of Mark's and
 * Note's items, a query of two rules; the join derived on a level below; or a query a rule may not read, one that
 * aggregates or one that negates in turn.
 */
type NegatedSource = "table" | "join" | "union" | "derived" | "aggregate" | "negating"
const negatedSources = ["table", "join", "union", "derived", "aggregate", "negating"] as const

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

const negationCase: Gen<NegationCase> = (s) => ({
	source: s.draw(element(negatedSources)),
	placement: s.draw(element(["alone", "conjunction", "nested conjunction"] as const)),
	literal: s.draw(element([false, true])),
	read: s.draw(element(["itself", "semijoin"] as const)),
	rule: s.draw(element(["into", "out of", "check", "key"] as const))
})

const Note = relation("Note", { item: pg.integer, on: pg.integer }, ["item", "on"])
const Notes = schema("RuleQueryNegated", { Item, Mark, Claim, Note }, [])

/**
 * The reason each negated source is refused for, as a refusal reads (reasonOf), or none for one a rule reads: a
 * select-project-join query or a union of them, or a relation of one. An aggregate breaks a rule the types name too
 * (Refused); a negation that negates in turn is UnsupportedLawFamily.
 */
const negatedRefusals: { readonly [S in NegatedSource]: ReasonRead | undefined } = {
	table: undefined,
	join: undefined,
	union: undefined,
	derived: undefined,
	aggregate: {
		tag: "Refused",
		refusal:
			"a rule reads a derived relation whose definition joins, selects and projects: this one aggregates"
	},
	negating: { tag: "UnsupportedLawFamily" }
}

/** A refusal's reason as a refusal reads: a named refusal's roster member, or another reason's tag. */
type ReasonRead =
	| { readonly tag: "Refused"; readonly refusal: Refused }
	| { readonly tag: Exclude<CompileReasonTag, "Refused"> }

/** A refusal's reason as negatedRefusals states it. */
const reasonOf = (e: CompileError): ReasonRead =>
	e.reason._tag === "Refused"
		? { tag: "Refused", refusal: e.reason.refusal }
		: { tag: e.reason._tag }

/**
 * The case's schema: Mark joined with Note derived on a level of its own, then Item's facts negating the case's source,
 * then Item's semijoin with them and the case's rule over the one it reads.
 */
const negationSchemaOf = (c: NegationCase) => {
	const join = query(Notes).rule((r) => {
		const { item, on } = v(Mark, "mark")
		return r.match(Mark, { item, on }).match(Note, { item, on }).find({ item, on })
	})
	const Joined = derived("Joined", join)
	const Middle = schema.extend(Notes, "RuleQueryNegatedMiddle", { Joined }, [])
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
						return items.where(r.and(r.ne(kind, 0), negation))
					case "nested conjunction":
						return items.where(r.and(r.ne(kind, 0), r.and(negation, r.ne(id, 0))))
				}
			})()
			return filtered.find({ id })
		})
	)
	const Upper = schema.extend(Middle, "RuleQueryNegatedUpper", { Unmarked }, [])
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
	return schema.extend(Upper, "RuleQueryNegatedTop", { Read }, [rule])
}

type NegationReached =
	| `negates ${NegatedSource}`
	| `negates ${Placement}`
	| "a literal negated on"
	| `${NegationCase["rule"]} read through a semijoin`
	| NegationCase["rule"]

type TagReached = `${Literal} literal` | `${Tagging} tagging` | `read by ${TagRead}` | TagRule

type Reached = `a literal ${"kind" | "mark id" | "mark on" | "negated on" | "read id"}` | Kind

describe("a rule over a query", () => {
	it.effect(
		"compiles whenever the builders admit it, a literal bound anywhere in a definition it reads",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/theory/rule-query",
						generator: ruleCase,
						literal: Formatter.format,
						limit: 500,
						box: "every containment into, containment out of and check over a derived relation of Item, the check named apart or as a check of Item, read itself or through a semijoin binding its id by a variable or a literal, whose definition binds kind, a joined Mark's id and on, and a negated Mark's on each by a variable or a literal",
						oracle: {
							kind: "specification",
							name: "the builders' admission: a schema schema.extend builds compiles to its artifacts"
						},
						coverage: requiredInSpace<Reached>([
							"a literal kind",
							"a literal mark id",
							"a literal mark on",
							"a literal negated on",
							"a literal read id",
							"into",
							"out of",
							"check",
							"check named as Item's"
						]),
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							k.note(c.rule)
							if (c.kind === "literal") {
								k.note("a literal kind")
							}
							if (c.joined !== "none" && c.joined.id === "literal") {
								k.note("a literal mark id")
							}
							if (c.joined !== "none" && c.joined.on === "literal") {
								k.note("a literal mark on")
							}
							if (c.negated === "literal") {
								k.note("a literal negated on")
							}
							if (c.read === "literal") {
								k.note("a literal read id")
							}
							const compiled = compiledOf(schemaOf(c))
							assert.deepEqual(
								compiled.ok ? undefined : compiled.error.reason,
								undefined,
								`the builders admit ${Formatter.format(c)}, and its compilation refuses it`
							)
							assert.deepEqual(
								compiled.ok ? clashesOf(compiled.value.laws.constraints) : [],
								[],
								`each constraint or trigger name of ${Formatter.format(c)} names one law on its table`
							)
						})
				)
			)
	)

	it.effect(
		"compiles whenever the builders admit it, correlating texts of different patterns as a stored foreign key does",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/theory/rule-query/text",
						generator: textCase,
						literal: Formatter.format,
						limit: 100,
						box: "every containment into and out of Doc's paths, read itself or through a semijoin, against a Ref path of Doc's, a narrower or a wider pattern, the paths negating a Note path of each pattern or none",
						oracle: {
							kind: "specification",
							name: "the builders' admission: a schema schema.extend builds compiles to its artifacts"
						},
						coverage: requiredInSpace<TextReached>([
							"a narrower ref",
							"a wider ref",
							"a narrower note",
							"a wider note",
							"into",
							"out of"
						]),
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							k.note(c.rule)
							if (c.ref !== "same") {
								k.note(`a ${c.ref} ref`)
							}
							if (c.note !== "none" && c.note !== "same") {
								k.note(`a ${c.note} note`)
							}
							const compiled = compiledOf(textSchemaOf(c))
							assert.deepEqual(
								compiled.ok ? undefined : compiled.error.reason,
								undefined,
								`the builders admit ${Formatter.format(c)}, and its compilation refuses it`
							)
						})
				)
			)
	)

	it.effect(
		"compiles whenever the builders admit it, a head literal read where a term of its column stands",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/theory/rule-query/head",
						generator: tagCase,
						literal: Formatter.format,
						limit: tagLiterals.length * taggings.length * tagReads.length * tagRules.length,
						box: "every check, key and selection over, and containment into, on its pair or its id alone, a derived relation of Item whose two arms deliver a text or Decimal head literal, the Decimal finite, NaN, an infinity, or one past numeric(p, s)'s greatest precision or scale, one in both or a discriminant, and over its semijoin binding it by a variable a stored match binds, a literal, or a variable only its head literal defines",
						oracle: {
							kind: "specification",
							name: "the builders' admission: a schema schema.extend builds compiles to its artifacts"
						},
						coverage: requiredInSpace<TagReached>([
							"text literal",
							"finite literal",
							"NaN literal",
							"Infinity literal",
							"-Infinity literal",
							"past precision literal",
							"past scale literal",
							"same tagging",
							"distinct tagging",
							"read by variable",
							"read by literal",
							"read by own",
							"check",
							"key",
							"selection",
							"into",
							"into id"
						]),
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							k.note(`${c.literal} literal`)
							k.note(`${c.tagging} tagging`)
							k.note(`read by ${c.read}`)
							k.note(c.rule)
							const compiled = compiledOf(
								c.literal === "text" ? tagSchemaOf(c) : amountSchemaOf(c, decimalOf[c.literal])
							)
							assert.deepEqual(
								compiled.ok ? undefined : compiled.error.reason,
								undefined,
								`the builders admit ${Formatter.format(c)}, and its compilation refuses it`
							)
						})
				)
			)
	)

	it.effect(
		"compiles a negation of a table, a join, a union or a derived relation, alone or in a conjunction, on either side of every rule, and refuses one of a query a rule may not read, by name",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/theory/rule-query/negated",
						generator: negationCase,
						literal: Formatter.format,
						limit: 500,
						box: "every containment into and out of, check over and key over a derived relation of Item, read itself or through a semijoin, whose definition negates Mark, a join of Mark and Note, their union, the join derived, a query that aggregates or one that negates, alone, in a conjunction or in a conjunction nested in one, binding Mark's on by a literal or not at all",
						oracle: {
							kind: "specification",
							name: "a rule over a query reads a negation of select-project-join arms: a schema schema.extend builds compiles to its artifacts exactly when every arm it negates joins, selects and projects, and is refused otherwise: an aggregate by the rule the types name, a negation that negates in turn as UnsupportedLawFamily"
						},
						coverage: requiredInSpace<NegationReached>([
							...Arr.map(negatedSources, (n) => `negates ${n}` as const),
							"negates alone",
							"negates conjunction",
							"negates nested conjunction",
							"a literal negated on",
							"into",
							"out of",
							"check",
							"key",
							"into read through a semijoin",
							"out of read through a semijoin"
						]),
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							k.note(`negates ${c.source}`)
							k.note(`negates ${c.placement}`)
							k.note(c.rule)
							if (c.literal) {
								k.note("a literal negated on")
							}
							if (c.read === "semijoin") {
								k.note(`${c.rule} read through a semijoin`)
							}
							const compiled = compiledOf(negationSchemaOf(c))
							const refusal = negatedRefusals[c.source]
							if (refusal === undefined) {
								assert.deepEqual(
									compiled.ok ? undefined : compiled.error.reason,
									undefined,
									`the builders admit ${Formatter.format(c)}, and its compilation refuses it`
								)
								assert.deepEqual(
									compiled.ok ? clashesOf(compiled.value.laws.constraints) : [],
									[],
									`each constraint or trigger name of ${Formatter.format(c)} names one law on its table`
								)
								return
							}
							assert.deepEqual(
								compiled.ok ? undefined : reasonOf(compiled.error),
								refusal,
								`${Formatter.format(c)} is refused for its negated source`
							)
						})
				)
			)
	)
})
