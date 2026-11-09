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
 * which only the head literal defines, under a check, a key and a selection that read it, and a containment into it. A
 * bare head literal takes its column's type, a Decimal's computed numeric as numeric(p, s) of the bound its analysis
 * proves, so it stands wherever a term of the column does; a variable only a head literal defines is that literal.
 *
 * The oracle is the builders' admission: a schema schema.extend builds compiles to its artifacts. Beside it, each name a
 * table holds a constraint or a rule's trigger under names one law, since PostgreSQL reports a violation by its table
 * and that name alone: a check over the derived relation, under its own name or Item's check's, is held under a name of
 * its law's.
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import type { ConstraintLaw, ConstraintLawOf } from "#compiler/laws/model/model.ts"
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
 * under one table names one law, a table constraint's or a rule's trigger's.
 */
const clashesOf = (constraints: ReadonlyArray<ConstraintLaw>): ReadonlyArray<string> =>
	Arr.flatMap([...Map.groupBy(constraints, (x) => `${x.owner} ${x.name}`)], ([at, named]) =>
		Arr.dedupeWith(
			Arr.flatMap(named, (x) => describedOf(x.laws)),
			sameLaw
		).length > 1
			? [at]
			: []
	)

/** The laws a constraint or trigger discharges, as an outcome names them. */
const describedOf = (laws: ReadonlyArray<ConstraintLawOf>): ReadonlyArray<Law> =>
	Arr.map(laws, (l) => l.described)

/**
 * How a derived relation's two arms deliver its head literal: one in both, or one each, the union's discriminant. Both
 * taggings are one query of two arms, so a case's values alone tell them apart.
 */
type Tagging = "same" | "distinct"

/** What the rules over the tagged relation and over its semijoin do with the literal's column. */
type TagRule = "check" | "key" | "selection" | "into"

/** How a semijoin binds the tagged relation's column (TagCase.read). */
type TagRead = Bound | "own"
const tagReads = [...bounds, "own"] as const

/** The literal a derived relation's head delivers: a text, or a Decimal, whose column is a computed numeric. */
type Literal = "text" | "decimal"

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
	literal: s.draw(element(["text", "decimal"] as const)),
	tagging: s.draw(element(["same", "distinct"] as const)),
	read: s.draw(element(tagReads)),
	rule: s.draw(element(["check", "key", "selection", "into"] as const))
})

const tags = str.bytes(20, str.regex("^[a-z]+$"))
const Tag = relation("Tag", { item: pg.integer, tag: tags }, ["item"])
const Tags = schema("RuleQueryTags", { Item, Tag }, [])

/**
 * The case's schema, its head literals texts: Item's facts tagged "a" in both arms, or "a" and "b", on a level of
 * their own, then Read, Item's semijoin with them binding the tag by a variable or a literal, and the case's rule over
 * each.
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
	const Middle = schema.extend(Tags, "RuleQueryTagsMiddle", { Tagged }, [])
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
		}
	})()
	return schema.extend(Middle, "RuleQueryTagsTop", { Read }, rules)
}

const Amount = relation("Amount", { item: pg.integer, amount: pg.numeric(4, 2) }, ["item"])
const Amounts = schema("RuleQueryAmounts", { Item, Amount }, [])
const half = Decimal.fromOutput("1.5")
const three = Decimal.fromOutput("3")

/**
 * The case's schema, its head literals Decimals: Item's facts priced 1.5 in both arms, or 1.5 and 2.25, on a level of
 * their own, then Read, Item's semijoin with them binding the amount by a variable or a literal, and the case's rule
 * over each.
 */
const amountSchemaOf = (c: TagCase) => {
	const Priced = derived(
		"Priced",
		query(Amounts)
			.rule((r) => {
				const { id } = v(Item, "item")
				return r.match(Item, { id }).find({ id, amount: half })
			})
			.rule((r) => {
				const { id } = v(Item, "item")
				return r
					.match(Item, { id })
					.find({ id, amount: c.tagging === "same" ? half : Decimal.fromOutput("2.25") })
			})
	)
	const Middle = schema.extend(Amounts, "RuleQueryAmountsMiddle", { Priced }, [])
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
					amount: c.read === "literal" ? half : c.read === "own" ? own : amount
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
							select(Priced, (x) => x.eq(x.amount, half)),
							"id"
						),
						on(Amount, "item")
					),
					contained(
						on(
							select(Read, (x) => x.eq(x.amount, half)),
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
		}
	})()
	return schema.extend(Middle, "RuleQueryAmountsTop", { Read }, rules)
}

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
							const compiled = testArtifacts(schemaOf(c), testCompile)
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
							const compiled = testArtifacts(textSchemaOf(c), testCompile)
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
						limit: 100,
						box: "every check, key and selection over, and containment into, a derived relation of Item whose two arms deliver a text or Decimal head literal, one in both or a discriminant, and over its semijoin binding it by a variable a stored match binds, a literal, or a variable only its head literal defines",
						oracle: {
							kind: "specification",
							name: "the builders' admission: a schema schema.extend builds compiles to its artifacts"
						},
						coverage: requiredInSpace<TagReached>([
							"text literal",
							"decimal literal",
							"same tagging",
							"distinct tagging",
							"read by variable",
							"read by literal",
							"read by own",
							"check",
							"key",
							"selection",
							"into"
						]),
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							k.note(`${c.literal} literal`)
							k.note(`${c.tagging} tagging`)
							k.note(`read by ${c.read}`)
							k.note(c.rule)
							const compiled = testArtifacts(
								c.literal === "text" ? tagSchemaOf(c) : amountSchemaOf(c),
								testCompile
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
})
