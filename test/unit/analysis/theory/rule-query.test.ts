/**
 * Rules over queries compile whenever the schema builders admit them: the violation query and every trigger probe of
 * a rule whose side reads a derived relation are descriptions grizzle writes itself, so the checker refusing one is
 * grizzle's defect, never the schema's.
 *
 * The box is every rule of three kinds (a containment into the derived relation, one out of it, and a check over it)
 * over a derived relation of Item, read directly or through Item's semijoin with it, binding its own id by a variable
 * or by a literal. The definition binds Item's kind by a variable or a literal, may join a Mark row whose id and on it
 * binds by a variable or a literal, and may negate a Mark row of the item, binding its on by a literal or not at all:
 * each probe site a literal binding reaches, a match's pinned key, a withdrawn match's field, an anti-join's binding
 * and a match of a derived relation inlined in another's definition.
 *
 * The oracle is the builders' admission: a schema schema.extend builds compiles to its artifacts.
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, contained, derived, on, relation, schema } from "#compiler/public/schema.ts"
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

type Kind = "into" | "out of" | "check"

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
	rule: s.draw(element(["into", "out of", "check"] as const))
})

const Item = relation("Item", { id: pg.integer, kind: pg.integer }, ["id"])
const Mark = relation("Mark", { id: pg.integer, item: pg.integer, on: pg.integer }, ["id"])
const Claim = relation("Claim", { item: pg.integer }, ["item"])
const Base = schema("RuleQuery", { Item, Mark, Claim }, [])

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
				return check("Positive", side, (x) => x.not(x.eq(x.id, 0)))
		}
	})()
	return schema.extend(Middle, "RuleQueryTop", { Read }, [rule])
}

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
						box: "every containment into, containment out of and check over a derived relation of Item, read itself or through a semijoin binding its id by a variable or a literal, whose definition binds kind, a joined Mark's id and on, and a negated Mark's on each by a variable or a literal",
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
							"check"
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
						})
				)
			)
	)

})
