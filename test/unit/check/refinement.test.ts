import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, element, type Gen, subarray } from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { guarantees, refinedConstants, refinement } from "#compiler/check/refinement/index.ts"
import type { FieldDesc, LiteralDesc } from "#compiler/ir/desc.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import {
	contractOf,
	numericBoundOf,
	numericTypmodOf,
	type ScalarType,
	sameScalarType,
	textOf
} from "#compiler/ir/scalar.ts"
import { Compute } from "#compiler/public/compute.ts"
import { closedId, contract, pg, uuid } from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { sameRegex, wildcardText } from "#compiler/scalar/compute/types.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { assert, defined, refused, succeeded, unorderedEqual } from "#test/support/assert.ts"
import {
	charLength,
	closed as closedDesc,
	closedRelation,
	f,
	ge,
	le,
	literal,
	type SchemaDesc,
	value
} from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import {
	lit,
	match,
	queryDesc,
	ref,
	relationSource,
	rule,
	typedLit,
	vars
} from "#test/unit/check/dsl.ts"

import { regex } from "arkregex"

const Slug = str.regex("^[a-z][a-z0-9-]*$")
/** The same language spelled differently (domain identity is the canonical pattern). */
const SlugAgain = str.regex("^[a-z](?:[a-z0-9]|-)*$")
const State = str.regex("^(?:draft|published)$")
const Prose = str.regex("^.*$", "su")
const Cents = contract("Cents", pg.bigint, (x) => x.ge(0n))
const Brand = contract("Brand", pg.bigint)
const Handle = contract("Handle", Slug, (x) => Compute.charLength(x).le(20))

const Tier = closed("Tier", ["Free", "Pro"])
/** Each tier's plan: a closed relation keyed by its tier, one payload field of each refinement. */
const TierPlan = closed.relation(
	"TierPlan",
	{
		tier: closedId(Tier),
		label: Slug,
		budget: Cents,
		rank: Brand,
		note: Prose,
		handle: Handle
	},
	["tier"],
	[
		{
			tier: "Free",
			label: "free",
			budget: Cents(100n),
			rank: Brand(1n),
			note: "anything",
			handle: Handle("free-tier")
		},
		{
			tier: "Pro",
			label: "pro",
			budget: Cents(1000n),
			rank: Brand(2n),
			note: "Anything At All",
			handle: Handle("pro-tier")
		}
	]
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
const Sheet = relation("Sheet", { id: uuid, amount: pg.numeric(12, 2), count: pg.bigint }, ["id"])
const Ledger = relation("Ledger", { id: uuid, amount: pg.numeric(12, 4) }, ["id"])
const Content = schema("Content", { Tier, TierPlan, Article, Draft, Sheet, Ledger }, [])

/** The type of the column `name` of a heading, which the test knows is there. */
const columnType = (heading: Heading, name: string, what: string): ScalarType =>
	Option.getOrThrowWith(
		Arr.findFirst(heading, (h) => h.name === name),
		() => new Error(`no ${what}`)
	).type

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
	["TierPlan.rank, the Brand contract over the same base", payloadType("TierPlan", "rank")],
	["plain bigint", plainType("int8")]
]

const isWildcard = (t: ScalarType): boolean => textOf(t)?.regex === "wildcard"
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
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
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
						caseHang
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
	)
})

/**
 * A field a union's arm delivers as its `value`, and the type the model reads it at: a language (two spellings of
 * the slug language are one), the wildcard, a numeric typmod as its integer and fraction digits, a contract by its
 * name, or a plain bigint.
 */
type Token =
	| { readonly kind: "language"; readonly language: "slug" | "state" }
	| { readonly kind: "wildcard" }
	| { readonly kind: "numeric"; readonly digits: number; readonly scale: number }
	| { readonly kind: "contract"; readonly name: "Cents" | "Brand" | "Handle" }
	| { readonly kind: "bigint" }

interface Deliverer {
	readonly name: string
	readonly relation: string
	readonly field: string
	/** A closed relation's payload, read at Free's row. */
	readonly closed: boolean
	readonly token: Token
	readonly type: ScalarType
}

const deliverer = (
	relation: string,
	field: string,
	closedPayload: boolean,
	token: Token,
	type: ScalarType
): Deliverer => ({
	name: `${relation}.${field}`,
	relation,
	field,
	closed: closedPayload,
	token,
	type
})

const deliverers: Arr.NonEmptyReadonlyArray<Deliverer> = [
	deliverer(
		"Article",
		"slug",
		false,
		{ kind: "language", language: "slug" },
		fieldType(Article, "slug")
	),
	deliverer(
		"Draft",
		"slug",
		false,
		{ kind: "language", language: "slug" },
		fieldType(Draft, "slug")
	),
	deliverer(
		"TierPlan",
		"label",
		true,
		{ kind: "language", language: "slug" },
		payloadType("TierPlan", "label")
	),
	deliverer(
		"Article",
		"state",
		false,
		{ kind: "language", language: "state" },
		fieldType(Article, "state")
	),
	deliverer(
		"Draft",
		"state",
		false,
		{ kind: "language", language: "state" },
		fieldType(Draft, "state")
	),
	deliverer("Article", "title", false, { kind: "wildcard" }, fieldType(Article, "title")),
	deliverer("TierPlan", "note", true, { kind: "wildcard" }, payloadType("TierPlan", "note")),
	deliverer(
		"Draft",
		"amount",
		false,
		{ kind: "numeric", digits: 8, scale: 2 },
		fieldType(Draft, "amount")
	),
	deliverer(
		"Sheet",
		"amount",
		false,
		{ kind: "numeric", digits: 10, scale: 2 },
		fieldType(Sheet, "amount")
	),
	deliverer(
		"Ledger",
		"amount",
		false,
		{ kind: "numeric", digits: 8, scale: 4 },
		fieldType(Ledger, "amount")
	),
	deliverer(
		"Article",
		"amount",
		false,
		{ kind: "contract", name: "Cents" },
		fieldType(Article, "amount")
	),
	deliverer(
		"TierPlan",
		"budget",
		true,
		{ kind: "contract", name: "Cents" },
		payloadType("TierPlan", "budget")
	),
	deliverer(
		"TierPlan",
		"rank",
		true,
		{ kind: "contract", name: "Brand" },
		payloadType("TierPlan", "rank")
	),
	deliverer(
		"TierPlan",
		"handle",
		true,
		{ kind: "contract", name: "Handle" },
		payloadType("TierPlan", "handle")
	),
	deliverer("Sheet", "count", false, { kind: "bigint" }, fieldType(Sheet, "count"))
]

/**
 * What a union's column takes from two arms' types, by the documented rule: one type, the type itself; two languages,
 * the wildcard; two numeric typmods, numeric of no typmod whose bound holds both; anything else, no type: the arms are
 * incompatible.
 */
const meet = (a: Token, b: Token): Token | undefined => {
	switch (a.kind) {
		case "language":
			return b.kind === "language"
				? a.language === b.language
					? a
					: { kind: "wildcard" }
				: b.kind === "wildcard"
					? b
					: undefined
		case "wildcard":
			return b.kind === "language" || b.kind === "wildcard" ? a : undefined
		case "numeric":
			return b.kind === "numeric"
				? {
						kind: "numeric",
						digits: Math.max(a.digits, b.digits),
						scale: Math.max(a.scale, b.scale)
					}
				: undefined
		case "contract":
			return b.kind === "contract" && b.name === a.name ? a : undefined
		case "bigint":
			return b.kind === "bigint" ? a : undefined
	}
}

/** One arm delivering a field as `value` beside an id: an ordinary relation's own, or a closed payload's at Free. */
const armOf = (d: Deliverer) =>
	d.closed
		? rule({
				vars: vars(d.relation, d.field),
				matches: [
					match(relationSource(d.relation), {
						tier: lit("Free"),
						[d.field]: ref(d.relation, d.field)
					})
				],
				where: [],
				head: {
					id: typedLit("00000000-0000-4000-8000-000000000001", f.uuid),
					value: ref(d.relation, d.field)
				},
				interiors: [],
				attach: []
			})
		: rule({
				vars: vars(d.relation, "id", d.field),
				matches: [
					match(relationSource(d.relation), {
						id: ref(d.relation, "id"),
						[d.field]: ref(d.relation, d.field)
					})
				],
				where: [],
				head: { id: ref(d.relation, "id"), value: ref(d.relation, d.field) },
				interiors: [],
				attach: []
			})

type UnionFeature =
	| "one type"
	| "one language spelled twice"
	| "two languages"
	| "two typmods"
	| "incompatible"

const featureOf = (a: Deliverer, b: Deliverer, met: Token | undefined): UnionFeature =>
	met === undefined
		? "incompatible"
		: sameScalarType(a.type, b.type)
			? "one type"
			: met.kind === "language"
				? "one language spelled twice"
				: met.kind === "wildcard"
					? "two languages"
					: "two typmods"

describe("union propagation", () => {
	it.effect(
		"types a union's column as the common guarantees of its arms, which each arm's type guarantees, and refuses incompatible arms",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
						suite: "unit/check/refinement-union",
						generator: (source) =>
							[source.draw(element(deliverers)), source.draw(element(deliverers))] as const,
						literal: Formatter.format,
						limit: deliverers.length * deliverers.length,
						coverage: requiredInSpace<UnionFeature>([
							"one type",
							"one language spelled twice",
							"two languages",
							"two typmods",
							"incompatible"
						]),
						caseHang
					},
					([a, b], c) =>
						Effect.sync(() => {
							const met = meet(a.token, b.token)
							const why = `${a.name} and ${b.name}`
							c.note(featureOf(a, b, met))
							const result = checkQuery(
								schemaChecked,
								queryDesc(armOf(a), armOf(b)),
								checkOptions("union propagation")
							)
							if (met === undefined) {
								refused(result, "MalformedDescription", why)
								return
							}
							const delivered = columnType(
								succeeded(result, why).dag.roots[0].heading,
								"value",
								"the union's value"
							)
							const common = refinement.common([a.type, b.type])
							assert.ok(
								guarantees(a.type, common) && guarantees(b.type, common),
								`${why}: each arm guarantees it`
							)
							switch (met.kind) {
								case "language":
									assert.ok(
										delivered.carrier === "text" &&
											sameRegex(delivered.text.regex, textOf(a.type)?.regex),
										`${why}: the one language`
									)
									break
								case "wildcard":
									assert.ok(isWildcard(delivered), `${why}: the wildcard`)
									break
								case "numeric": {
									const typmod = numericTypmodOf(delivered)
									const same = sameScalarType(a.type, b.type)
									assert.deepEqual(
										same
											? [delivered.carrier, typmod?.precision, typmod?.scale]
											: [
													delivered.carrier,
													numericBoundOf(delivered)?.digits,
													numericBoundOf(delivered)?.scale
												],
										same
											? ["numeric", met.digits + met.scale, met.scale]
											: ["numeric", met.digits, met.scale],
										`${why}: the numeric holding both`
									)
									break
								}
								case "contract":
									assert.equal(
										contractOf(delivered)?.name,
										contractOf(a.type)?.name,
										`${why}: the contract ${met.name}`
									)
									break
								case "bigint":
									assert.ok(sameScalarType(delivered, a.type), `${why}: bigint`)
									break
							}
						})
				)
			)
	)
})

/**
 * A payload field type of a drawn closed relation: its descriptor, whether its domain carries a CHECK (a pattern, a
 * contract's predicate or its base's), and a value of it as a closed row states it, with its TypedLiteral.
 */
interface Payload {
	readonly name: string
	readonly descriptor: FieldDesc
	readonly checked: boolean
	readonly value: Gen<{ readonly host: LiteralDesc; readonly literal: TypedLiteral }>
}

const slugDesc = f.regex("^[a-z][a-z0-9-]*$", "u")
const slugText = matching(regex("^[a-z][a-z0-9-]{0,10}$"))
const textValue = (host: string) => ({ host, literal: { kind: "text" as const, value: host } })
const intValue = (host: bigint) => ({ host, literal: { kind: "int" as const, value: host } })

const payloads: Arr.NonEmptyReadonlyArray<Payload> = [
	{ name: "slug", descriptor: slugDesc, checked: true, value: (s) => textValue(s.draw(slugText)) },
	{
		name: "prose",
		descriptor: f.wildcard,
		checked: false,
		value: (s) => textValue(s.draw(matching(regex("^[ -~]{0,8}$"))))
	},
	{
		name: "cents",
		descriptor: f.contract("Cents", f.bigint, ge(value, literal(0n))),
		checked: true,
		value: (s) => intValue(s.draw(bigint(0n, 10_000n)))
	},
	{
		name: "brand",
		descriptor: f.contract("Brand", f.bigint, undefined),
		checked: false,
		value: (s) => intValue(s.draw(bigint(-10_000n, 10_000n)))
	},
	{
		name: "handle",
		descriptor: f.contract("Handle", slugDesc, le(charLength(value), literal(20))),
		checked: true,
		value: (s) => textValue(s.draw(slugText))
	},
	{
		name: "plain",
		descriptor: f.bigint,
		checked: false,
		value: (s) => intValue(s.draw(bigint(-10_000n, 10_000n)))
	}
]

const keyHandles = ["K0", "K1", "K2"] as const

/** A closed relation over a roster of three handles: some of its rows, each payload field of a drawn kind. */
interface ClosedCase {
	readonly fields: ReadonlyArray<{ readonly payload: Payload; readonly name: string }>
	readonly rows: ReadonlyArray<{
		readonly key: (typeof keyHandles)[number]
		readonly values: ReadonlyArray<{ readonly host: LiteralDesc; readonly literal: TypedLiteral }>
	}>
}

const closedCaseGen: Gen<ClosedCase> = (source) => {
	const kinds = source.draw(array(element(payloads), { min: 1, max: 4 }))
	const fields = Arr.map(kinds, (payload, i) => ({ payload, name: `p${i}` }))
	return {
		fields,
		rows: Arr.map(source.draw(subarray(keyHandles)), (key) => ({
			key,
			values: Arr.map(fields, (x) => source.draw(x.payload.value))
		}))
	}
}

/** The case's schema: the roster Key and the closed relation Payloads over it. */
const closedSchema = (c: ClosedCase): SchemaDesc => ({
	name: "Constants",
	relations: [
		closedDesc("Key", keyHandles),
		closedRelation(
			"Payloads",
			Rec.fromEntries([
				["key", f.closedId("Key")] as const,
				...Arr.map(c.fields, (x) => [x.name, x.payload.descriptor] as const)
			]),
			["key"],
			Arr.map(c.rows, (row) =>
				Rec.fromEntries([
					["key", row.key] as const,
					...Arr.map(
						c.fields,
						(x, i) => [x.name, defined(row.values[i], "a row's value").host] as const
					)
				])
			)
		)
	],
	statements: [],
	extends: undefined
})

type ConstantFeature = "a refined cell" | "an unrefined cell" | "no row"

describe("refined constants", () => {
	it.effect(
		"list exactly the closed payload cells of a type whose domain carries a CHECK, each at its field's type",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/check/refinement-constants",
						draw: drawn(closedCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "which payload kinds carry a CHECK: a pattern, a contract's predicate, or its base's"
						},
						coverage: required<ConstantFeature>(["a refined cell", "an unrefined cell", "no row"], {
							cases: 100,
							sense: notesOnly
						}),
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const checked = checking(closedSchema(c))
							const heading = defined(checked.closed.get("Payloads"), "Payloads").heading
							/** Each cell by its field and its row's key, the site naming it: two rows may hold one value. */
							const expected = Arr.flatMap(c.rows, (row) =>
								Arr.flatMap(c.fields, (x, i) => {
									const cell = defined(row.values[i], "a row's value")
									return x.payload.checked
										? [
												{
													literal: cell.literal,
													type: columnType(heading, x.name, x.name),
													site: `closed Payloads.${x.name} at (${row.key})`
												}
											]
										: []
								})
							)
							unorderedEqual(
								Arr.map(refinedConstants(checked), (x) => ({
									literal: x.literal,
									type: x.type,
									site: x.site
								})),
								expected
							)
							if (c.rows.length === 0) {
								k.note("no row")
							}
							if (expected.length > 0) {
								k.note("a refined cell")
							}
							if (Arr.some(c.fields, (x) => !x.payload.checked) && c.rows.length > 0) {
								k.note("an unrefined cell")
							}
						})
				)
			)
	)
})
