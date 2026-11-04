import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage, requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import {
	guarantees,
	hasConstraint,
	refinedConstants,
	refinement
} from "#compiler/check/refinement/index.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import {
	contractOf,
	numericTypmodOf,
	type ScalarType,
	type TextInfo,
	textOf
} from "#compiler/ir/scalar.ts"
import { Compute } from "#compiler/public/compute.ts"
import { contract, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { plainType, sameRegex, wildcardText } from "#compiler/scalar/compute/types.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { checking, checkOptions } from "#test/support/policy.ts"

const Slug = str.regex("^[a-z][a-z0-9-]*$")
/** The same language spelled differently (domain identity is the canonical pattern). */
const SlugAgain = str.regex("^[a-z](?:[a-z0-9]|-)*$")
const State = str.regex("^(?:draft|published)$")
const Prose = str.regex("^.*$", "su")
const Cents = contract("Cents", pg.bigint, (x) => x.ge(0n))
const Brand = contract("Brand", pg.bigint)
const Handle = contract("Handle", Slug, (x) => Compute.charLength(x).le(20))

const Tier = closed("Tier", ["Free", "Pro"]).with(
	{ label: Slug, budget: Cents, rank: Brand, note: Prose, handle: Handle },
	{
		Free: {
			label: "free",
			budget: Cents(100n),
			rank: Brand(1n),
			note: "anything",
			handle: Handle("free-tier")
		},
		Pro: {
			label: "pro",
			budget: Cents(1000n),
			rank: Brand(2n),
			note: "Anything At All",
			handle: Handle("pro-tier")
		}
	}
)

const Article = relation(
	"Article",
	{ id: uuid, slug: Slug, state: State, title: Prose, amount: Cents },
	["id"]
)

const Draft = relation(
	"Draft",
	{ id: uuid, slug: SlugAgain, state: State, title: Prose, amount: pg.numeric(10, 2) },
	["id"]
)
const Sheet = relation("Sheet", { id: uuid, amount: pg.numeric(12, 2) }, ["id"])
const Content = schema("Content", { Tier, Article, Draft, Sheet }, [])

const checked = (q: unknown): LogicalQuery =>
	succeeded(
		checkQuery(checking(Content), queryValueDesc(q), checkOptions("query")),
		"the query checks"
	)

/** The type of the column `name` of a heading, which the test knows is there. */
const columnType = (heading: Heading, name: string, what: string): ScalarType =>
	Option.getOrThrowWith(
		Arr.findFirst(heading, (h) => h.name === name),
		() => new Error(`no ${what}`)
	).type

const typeOf = (q: LogicalQuery, name: string): ScalarType =>
	columnType(q.dag.roots[0].heading, name, `the column ${name}`)

const schemaChecked = checking(Content)

/** A relation's field type, as the checker reads it. */
const fieldType = <F extends object>(
	r: { readonly name: string; readonly fields: F },
	field: keyof F & string
): ScalarType =>
	columnType(
		defined(schemaChecked.relations.get(r.name), r.name).heading,
		field,
		`${r.name}.${field}`
	)

/** A closed relation's payload field type, as the checker reads it. */
const payloadType = (name: string, field: string): ScalarType =>
	columnType(defined(schemaChecked.closed.get(name), name).heading, field, `${name}.${field}`)

/**
 * The types the lattice is judged over, each named: refined text in three languages (one spelled twice), the wildcard,
 * numeric at two typmods, two contracts over one base, and a plain bigint.
 */
const pool: Arr.NonEmptyReadonlyArray<readonly [string, ScalarType]> = [
	["Article.slug", fieldType(Article, "slug")],
	["Draft.slug, the slug language spelled again", fieldType(Draft, "slug")],
	["Article.state", fieldType(Article, "state")],
	["Article.title, the declared wildcard", fieldType(Article, "title")],
	["the canonical wildcard", wildcardText],
	["Draft.amount, numeric(10,2)", fieldType(Draft, "amount")],
	["Sheet.amount, numeric(12,2)", fieldType(Sheet, "amount")],
	["Article.amount, the Cents contract", fieldType(Article, "amount")],
	["Tier.rank, the Brand contract over the same base", payloadType("Tier", "rank")],
	["plain bigint", plainType("int8")]
]

const isWildcard = (t: ScalarType): boolean => textOf(t)?.regex === "wildcard"
/** A text type's refinement; any other type is a defect of the test. */
const textInfo = (t: ScalarType): TextInfo => defined(textOf(t), "a text type")
const isContract = (t: ScalarType): boolean => contractOf(t) !== undefined

type LatticeFeature =
	| "one language"
	| "two languages"
	| "the wildcard"
	| "a contract"
	| "another carrier"

describe("languages and guarantees", () => {
	it.effect(
		"prove one language by its canonical pattern, and guarantee only the wildcard, one language or a contract itself",
		(ctx) => {
			assert.equal(
				sameRegex(
					textInfo(fieldType(Article, "slug")).regex,
					textInfo(fieldType(Draft, "slug")).regex
				),
				true
			)
			assert.ok(isWildcard(fieldType(Article, "title")))
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/check/refinement-lattice",
						generator: (source) =>
							[source.draw(element(pool)), source.draw(element(pool))] as const,
						literal: Formatter.format,
						limit: pool.length * pool.length,
						coverage: requiredInSpace<LatticeFeature>([
							"one language",
							"two languages",
							"the wildcard",
							"a contract",
							"another carrier"
						]),
						caseHang: Duration.minutes(2)
					},
					([[an, a], [bn, b]], c) =>
						Effect.sync(() => {
							const why = `${an} and ${bn}`
							assert.equal(guarantees(a, a), true, `${why}: reflexive`)
							const guaranteed = guarantees(a, b)
							if (a.carrier !== b.carrier) {
								assert.equal(guaranteed, false, why)
								c.note("another carrier")
							} else if (isContract(a) || isContract(b)) {
								assert.equal(guaranteed, a === b, `${why}: a contract guarantees only itself`)
								c.note("a contract")
							} else if (a.carrier === "text" && b.carrier === "text") {
								const same = sameRegex(a.text.regex, b.text.regex)
								assert.equal(same, sameRegex(b.text.regex, a.text.regex), `${why}: symmetric`)
								assert.equal(
									sameRegex(a.text.regex, a.text.regex),
									true,
									`${an}: one language with itself`
								)
								assert.equal(guaranteed, isWildcard(b) || same, why)
								c.note(isWildcard(b) ? "the wildcard" : same ? "one language" : "two languages")
							}
						})
				)
			)
		}
	)
})

/**
 * Two field types the checker unions as one column, and the arms' query: refined text in one language, two languages,
 * one state language, numeric at two typmods, and a contract column beside a closed payload of the same contract.
 */
interface Unioned {
	readonly what: string
	readonly types: readonly [ScalarType, ScalarType]
	readonly union: () => unknown
	/** What the arms' types meet as: the first arm's type, the wildcard, or unconstrained numeric. */
	readonly meet: "the first" | "the wildcard" | "unconstrained numeric"
}

const unioned: Arr.NonEmptyReadonlyArray<Unioned> = [
	{
		what: "one language spelled twice",
		meet: "the first",
		types: [fieldType(Article, "slug"), fieldType(Draft, "slug")],
		union: () =>
			query(Content)
				.rule((r) => {
					const { id, slug } = v(Article, "article")
					return r.match(Article, { id, slug }).find({ id, value: slug })
				})
				.rule((r) => {
					const { id, slug } = v(Draft, "draft")
					return r.match(Draft, { id, slug }).find({ id, value: slug })
				})
	},
	{
		what: "one state language",
		meet: "the first",
		types: [fieldType(Article, "state"), fieldType(Draft, "state")],
		union: () =>
			query(Content)
				.rule((r) => {
					const { id, state } = v(Article, "article")
					return r.match(Article, { id, state }).find({ id, value: state })
				})
				.rule((r) => {
					const { id, state } = v(Draft, "draft")
					return r.match(Draft, { id, state }).find({ id, value: state })
				})
	},
	{
		what: "two languages",
		meet: "the wildcard",
		types: [fieldType(Article, "slug"), fieldType(Draft, "state")],
		union: () =>
			query(Content)
				.rule((r) => {
					const { id, slug } = v(Article, "article")
					return r.match(Article, { id, slug }).find({ id, value: slug })
				})
				.rule((r) => {
					const { id, state } = v(Draft, "draft")
					return r.match(Draft, { id, state }).find({ id, value: state })
				})
	},
	{
		/** numeric(10, 2) and numeric(12, 2) meet as unconstrained numeric, PostgreSQL's select_common_typmod. */
		what: "numeric at two typmods",
		meet: "unconstrained numeric",
		types: [fieldType(Draft, "amount"), fieldType(Sheet, "amount")],
		union: () =>
			query(Content)
				.rule((r) => {
					const { id, amount } = v(Draft, "draft")
					return r.match(Draft, { id, amount }).find({ id, value: amount })
				})
				.rule((r) => {
					const { id, amount } = v(Sheet, "sheet")
					return r.match(Sheet, { id, amount }).find({ id, value: amount })
				})
	},
	{
		what: "a contract column and a closed payload of the same contract",
		meet: "the first",
		types: [fieldType(Article, "amount"), fieldType(Article, "amount")],
		union: () =>
			query(Content)
				.rule((r) => {
					const { id, amount } = v(Article, "article")
					return r.match(Article, { id, amount }).find({ id, value: amount })
				})
				.rule((r) => {
					const { budget } = v(Tier, "tier")
					return r.match(Tier, { id: "Free", budget }).find({
						id: Compute.literal(uuid, "00000000-0000-4000-8000-000000000001"),
						value: budget
					})
				})
	}
]

describe("union propagation", () => {
	it.effect(
		"types a union's column as the common guarantees of its arms, which each arm's type guarantees",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/check/refinement-union",
						generator: element(unioned),
						literal: Formatter.format,
						limit: unioned.length,
						coverage: noCoverage,
						caseHang: Duration.minutes(2)
					},
					(u) =>
						Effect.sync(() => {
							const common = refinement.common(u.types)
							for (const t of u.types) {
								assert.ok(guarantees(t, common), `${u.what}: each arm guarantees it`)
							}
							const value = typeOf(checked(u.union()), "value")
							assert.equal(value.carrier, common.carrier, u.what)
							if (value.carrier === "text" && common.carrier === "text") {
								assert.equal(sameRegex(value.text.regex, common.text.regex), true, u.what)
							}
							assert.deepEqual(numericTypmodOf(value), numericTypmodOf(common), u.what)
							assert.equal(contractOf(value)?.name, contractOf(common)?.name, u.what)
							switch (u.meet) {
								case "the first": {
									const first = u.types[0]
									if (common.carrier === "text" && first.carrier === "text") {
										assert.equal(sameRegex(common.text.regex, first.text.regex), true, u.what)
									}
									assert.equal(contractOf(common)?.name, contractOf(first)?.name, u.what)
									break
								}
								case "the wildcard":
									assert.ok(isWildcard(common), u.what)
									break
								case "unconstrained numeric":
									assert.deepEqual(
										[common.carrier, numericTypmodOf(common)],
										["numeric", undefined],
										u.what
									)
									break
							}
						})
				)
			)
	)
})

/**
 * Every payload cell of Tier: its handle, field, value, and whether its type carries a CHECK (Slug's pattern, Cents'
 * predicate, Handle's pattern and length); Brand has no predicate and Prose is the wildcard.
 */
const payloadCells: Arr.NonEmptyReadonlyArray<{
	readonly handle: string
	readonly field: string
	readonly value: TypedLiteral
	readonly refined: boolean
}> = Arr.flatMap(["Free", "Pro"] as const, (handle) => {
	const free = handle === "Free"
	return [
		{
			handle,
			field: "label",
			value: { kind: "text", value: free ? "free" : "pro" } satisfies TypedLiteral,
			refined: true
		},
		{
			handle,
			field: "budget",
			value: { kind: "int", value: free ? 100n : 1000n } satisfies TypedLiteral,
			refined: true
		},
		{
			handle,
			field: "rank",
			value: { kind: "int", value: free ? 1n : 2n } satisfies TypedLiteral,
			refined: false
		},
		{
			handle,
			field: "note",
			value: { kind: "text", value: free ? "anything" : "Anything At All" } satisfies TypedLiteral,
			refined: false
		},
		{
			handle,
			field: "handle",
			value: { kind: "text", value: free ? "free-tier" : "pro-tier" } satisfies TypedLiteral,
			refined: true
		}
	]
})

describe("refined constants", () => {
	it.effect("list exactly the closed payload cells of a type with a CHECK", (ctx) => {
		type Cell = "refined" | "unrefined"
		const listed = refinedConstants(schemaChecked)
		assert.equal(listed.length, Arr.filter(payloadCells, (x) => x.refined).length)
		assert.ok(Arr.every(listed, (x) => hasConstraint(x.type)))
		return searched(
			ctx,
			exhaust(
				{
					suite: "unit/check/refinement-constants",
					generator: element(payloadCells),
					literal: Formatter.format,
					limit: payloadCells.length,
					coverage: requiredInSpace<Cell>(["refined", "unrefined"]),
					caseHang: Duration.minutes(2)
				},
				(cell, c) =>
					Effect.sync(() => {
						const site = `closed Tier.${cell.field} of ${cell.handle}`
						const found = Arr.filter(listed, (x) => x.site === site)
						assert.deepEqual(
							Arr.map(found, (x) => x.literal),
							cell.refined ? [cell.value] : [],
							site
						)
						c.note(cell.refined ? "refined" : "unrefined")
					})
			)
		)
	})
})
