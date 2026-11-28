/** What the properties of refinement.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, subarray } from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import { bigint } from "@bjornpagen/testing/values"
import { regex } from "arkregex"
import { Array as Arr, Option, Record as Rec } from "effect"
import type { FieldDesc, LiteralDesc } from "#compiler/ir/desc.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { sameScalarType, type ScalarType, textOf } from "#compiler/ir/scalar.ts"
import { Logic, Text } from "#compiler/public/compute.ts"
import { closedId, contract, mintOf, int8, numeric } from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import { plainType } from "#compiler/scalar/native.ts"
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
import { Id } from "#test/support/ids.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { checking } from "#test/support/policy.ts"
import {
	lit,
	match,
	ref,
	relationSource,
	rule,
	typedLit,
	vars
} from "#test/support/unit/check/dsl.ts"

const Slug = str.regex("^[a-z][a-z0-9-]*$")

/** The same language spelled differently (domain identity is the canonical pattern). */
const SlugAgain = str.regex("^[a-z](?:[a-z0-9]|-)*$")

const State = str.regex("^(?:draft|published)$")

/** Upper-case codes, a language neither the slugs nor the state names hold a member of in common with. */
const Code = str.regex("^[A-Z]+$")

const Prose = str.regex("^.*$", "su")

const centsKey = Symbol("Cents")
const Cents = contract<typeof centsKey>()("Cents", int8, (x) => Logic.ge(x, 0n))
const toCents = mintOf(centsKey)

const brandKey = Symbol("Brand")
const Brand = contract<typeof brandKey>()("Brand", int8)
const toBrand = mintOf(brandKey)

const handleKey = Symbol("Handle")
const Handle = contract<typeof handleKey>()("Handle", Slug, (x) => Logic.le(Text.charLength(x), 20))
const toHandle = mintOf(handleKey)

const Tier = closed.ordered("Tier", ["Free", "Pro"])

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
			budget: toCents(100n),
			rank: toBrand(1n),
			note: "anything",
			handle: toHandle("free-tier")
		},
		{
			tier: "Pro",
			label: "pro",
			budget: toCents(1000n),
			rank: toBrand(2n),
			note: "Anything At All",
			handle: toHandle("pro-tier")
		}
	]
)

const Article = relation(
	"Article",
	{ id: Id, slug: Slug, state: State, code: Code, title: Prose, amount: Cents },
	["id"]
)

const Draft = relation(
	"Draft",
	{ id: Id, slug: SlugAgain, state: State, code: Code, title: Prose, amount: numeric(10, 2) },
	["id"]
)

const Sheet = relation("Sheet", { id: Id, amount: numeric(12, 2), count: int8 }, ["id"])

const Ledger = relation("Ledger", { id: Id, amount: numeric(12, 4) }, ["id"])

const Content = schema("Content", [Tier, TierPlan, Article, Draft, Sheet, Ledger], [])

/** The type of the column `name` of a heading, which the test knows is there. */
export const columnType = (heading: Heading, name: string, what: string): ScalarType =>
	Option.getOrThrowWith(
		Arr.findFirst(heading, (h) => h.name === name),
		() => new Error(`no ${what}`)
	).type

export const schemaChecked = checking(Content)

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
 * A field a union's arm delivers as its `value`, and the type the model reads it at: a language (two spellings of
 * the slug language are one), the wildcard, a numeric typmod as its integer and fraction digits, a contract by its
 * name, or a plain bigint.
 */
type Token =
	| { readonly kind: "language"; readonly language: "slug" | "state" | "code" }
	| { readonly kind: "wildcard" }
	| { readonly kind: "numeric"; readonly digits: number; readonly scale: number }
	| {
			readonly kind: "contract"
			readonly name: "Cents" | "Brand" | "Handle"
			readonly base: "bigint" | "text"
	  }
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

export const deliverers: Arr.NonEmptyReadonlyArray<Deliverer> = [
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
	deliverer(
		"Article",
		"code",
		false,
		{ kind: "language", language: "code" },
		fieldType(Article, "code")
	),
	deliverer(
		"Draft",
		"code",
		false,
		{ kind: "language", language: "code" },
		fieldType(Draft, "code")
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
		{ kind: "contract", name: "Cents", base: "bigint" },
		fieldType(Article, "amount")
	),
	deliverer(
		"TierPlan",
		"budget",
		true,
		{ kind: "contract", name: "Cents", base: "bigint" },
		payloadType("TierPlan", "budget")
	),
	deliverer(
		"TierPlan",
		"rank",
		true,
		{ kind: "contract", name: "Brand", base: "bigint" },
		payloadType("TierPlan", "rank")
	),
	deliverer(
		"TierPlan",
		"handle",
		true,
		{ kind: "contract", name: "Handle", base: "text" },
		payloadType("TierPlan", "handle")
	),
	deliverer("Sheet", "count", false, { kind: "bigint" }, fieldType(Sheet, "count"))
]

/**
 * What a union's column takes from two arms' types, by the documented rule: one type, the type itself; two languages,
 * the one holding the other's (the slugs hold a state's draft and published), else the wildcard; two numeric typmods,
 * numeric of no typmod whose bound holds both; anything else, no type: the arms are incompatible.
 */
export const meet = (a: Token, b: Token): Token | undefined => {
	switch (a.kind) {
		case "language":
			return b.kind === "language"
				? a.language === b.language || (a.language === "slug" && b.language === "state")
					? a
					: b.language === "slug" && a.language === "state"
						? b
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

/** The deliverers of an uncontracted text: the slugs spelled two ways, the state names, the codes and the wildcard. */
export const textDeliverers: Arr.NonEmptyReadonlyArray<Deliverer> = nonEmptyList(
	Arr.filter(deliverers, (d) => d.type.carrier === "text" && d.type.contract === undefined),
	"the text deliverers"
)

export const isWildcard = (t: ScalarType): boolean => textOf(t) === "wildcard"

/** A type the lattice is judged over: a deliverer's, the canonical wildcard, or a plain bigint, with its token. */
interface Judged {
	readonly name: string
	readonly token: Token
	readonly type: ScalarType
}

export const judged: Arr.NonEmptyReadonlyArray<Judged> = [
	...Arr.map(deliverers, ({ name, token, type }) => ({ name, token, type })),
	{ name: "the canonical wildcard", token: { kind: "wildcard" }, type: wildcardText },
	{ name: "a plain bigint", token: { kind: "bigint" }, type: plainType("int8") }
]

/** The carrier a token's values are stored in. */
const carrierOf = (t: Token): "text" | "numeric" | "bigint" => {
	switch (t.kind) {
		case "language":
		case "wildcard":
			return "text"
		case "numeric":
			return "numeric"
		case "contract":
			return t.base
		case "bigint":
			return "bigint"
	}
}

/**
 * Whether every value of `a` is a value of `b`, by the documented rule (check/refinement guarantees): one carrier and
 * one nominal identity, so a contract guarantees only itself and nothing else guarantees it; one numeric typmod; and
 * for text, `b` the wildcard or a language holding `a`'s: its own, or the slugs, which hold a state's draft and
 * published.
 */
export const guaranteed = (a: Token, b: Token): boolean => {
	if (carrierOf(a) !== carrierOf(b)) {
		return false
	}
	if (a.kind === "contract" || b.kind === "contract") {
		return a.kind === "contract" && b.kind === "contract" && a.name === b.name
	}
	if (a.kind === "numeric" && b.kind === "numeric") {
		return a.digits === b.digits && a.scale === b.scale
	}
	if (b.kind === "wildcard") {
		return true
	}
	return a.kind === "language" && b.kind === "language"
		? a.language === b.language || (a.language === "state" && b.language === "slug")
		: a.kind === b.kind
}

export type LatticeFeature =
	| "one language"
	| "two languages"
	| "the wildcard"
	| "a contract"
	| "one typmod"
	| "two typmods"
	| "another carrier"

export const latticeFeature = (a: Token, b: Token): LatticeFeature => {
	if (carrierOf(a) !== carrierOf(b)) {
		return "another carrier"
	}
	if (a.kind === "contract" || b.kind === "contract") {
		return "a contract"
	}
	if (a.kind === "numeric" && b.kind === "numeric") {
		return a.digits === b.digits && a.scale === b.scale ? "one typmod" : "two typmods"
	}
	if (b.kind === "wildcard") {
		return "the wildcard"
	}
	return a.kind === "language" && b.kind === "language" && a.language === b.language
		? "one language"
		: "two languages"
}

/** One arm delivering a field as `value` beside an id: an ordinary relation's own, or a closed payload's at Free. */
export const armOf = (d: Deliverer) =>
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
					id: typedLit("00000000-0000-4000-8000-000000000001", f.contract("Id", f.uuid, undefined)),
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

export type UnionFeature =
	| "one type"
	| "one language spelled twice"
	| "a language holding the other"
	| "two languages"
	| "two typmods"
	| "incompatible"

export const featureOf = (a: Deliverer, b: Deliverer, met: Token | undefined): UnionFeature =>
	met === undefined
		? "incompatible"
		: sameScalarType(a.type, b.type)
			? "one type"
			: met.kind === "language"
				? a.token.kind === "language" &&
					b.token.kind === "language" &&
					a.token.language !== b.token.language
					? "a language holding the other"
					: "one language spelled twice"
				: met.kind === "wildcard"
					? "two languages"
					: "two typmods"

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

export const closedCaseGen: Gen<ClosedCase> = (source) => {
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
export const closedSchema = (c: ClosedCase): SchemaDesc => ({
	name: "Constants",
	relations: [
		closedDesc.ordered("Key", keyHandles),
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
	bases: []
})

export type ConstantFeature = "a refined cell" | "an unrefined cell" | "no row"
