/** What the properties of head-literals.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { aimed, type Aimed, array, element, type Gen, map, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record as Rec } from "effect"
import { baseOf, sameScalarType, type ScalarType } from "#compiler/ir/scalar.ts"
import {
	closedId,
	Numeric,
	Money,
	bool,
	float8,
	int4,
	int8,
	money,
	numeric
} from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryOver, type QueryValue, varsOver } from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import { checking } from "#test/support/policy.ts"

/**
 * Head literal typing (TODO 0b, literal typing): a literal's type is carried by its value, never guessed from its rule.
 *
 * Property: for a drawn union of one to four arms over Cell, each delivering the one head field `c` as a field of Cell,
 * a roster's typed handle (Kind.handle), a typed literal (Type.literal) or a plain literal (the JavaScript value
 * itself), and each plain-literal or typed arm matching Cell with its handle field fixed to a drawn handle, spelled as
 * its JavaScript value or as its typed handle, or to none, the checker gives `c` exactly the type the oracle below
 * gives it, or refuses the union exactly when the oracle does. The oracle is the rule over a small universe whose types
 * and admissions this file states itself: a term-typed arm (a field, a handle, a typed literal) delivers its own type;
 * a plain literal takes the type the term-typed arms agree on when that type admits its value, and otherwise its
 * value's JavaScript default (bareLiteralType: a string text, a safe integer integer, a bigint bigint, a Numeric
 * numeric, a Money money, a boolean boolean, any other number refused); the arms' types then agree, combine to text
 * when they are text of different refinements, or are refused. The handle a match fixes never types a literal, however
 * the fix is spelled: a plain "A" whose rule fixes Kind to "A" or to Kind.handle("A") is text, which the value-aware
 * handle default this replaced made Kind.
 *
 * Features: each arm kind, each way a match fixes the handle, each type c takes, and each refusal.
 */
const Kind = closed.ordered("Kind", ["A", "B"])

const Short = str.regex("^.{0,4}$", "su")

const Cell = relation(
	"Cell",
	{
		id: int4,
		h: closedId(Kind),
		s: Short,
		n: int4,
		b: int8,
		x: numeric(10, 2),
		m: money,
		f: float8,
		t: bool
	},
	["id"]
)

const Cells = schema("HeadLiterals", [Kind, Cell], [])

/** The types of the universe: Kind's closed id, Cell's short text, unrefined text, and the plain types. */
type Token =
	| "Kind"
	| "Short"
	| "text"
	| "integer"
	| "bigint"
	| "numeric"
	| "money"
	| "float8"
	| "boolean"

/** The fields of Cell an arm may deliver `c` by, each with its type. */
const fieldTypes = {
	h: "Kind",
	s: "Short",
	n: "integer",
	b: "bigint",
	x: "numeric",
	m: "money",
	f: "float8",
	t: "boolean"
} as const satisfies {
	readonly [field: string]: Token
}

type Field = keyof typeof fieldTypes

const fields: Arr.NonEmptyReadonlyArray<Field> = ["h", "s", "n", "b", "x", "m", "f", "t"]

/**
 * The plain literals a head may hold: two handle spellings, a text no handle spells, a text too long for Short (so a
 * plain text beside Short's field combines to text), and one of every other kind, a Numeric and a Money among them.
 */
const plainValues = [
	"A",
	"B",
	"zz",
	"lengthy",
	1,
	7n,
	Numeric.of("2.5"),
	Money.of(150n),
	true,
	1.5
] as const

type Plain = (typeof plainValues)[number]

type Delivery =
	| { readonly kind: "field"; readonly field: Field }
	| { readonly kind: "handle"; readonly member: "A" | "B" }
	| { readonly kind: "typed"; readonly type: "integer" | "bigint" }
	| { readonly kind: "plain"; readonly value: Plain }

/**
 * An arm: how it delivers `c`, the handle its match fixes Cell's handle field to, if any, and how that fix is spelled:
 * the member's JavaScript value or its typed handle.
 */
export interface Arm {
	readonly delivery: Delivery
	readonly fix: "none" | "A" | "B"
	readonly spelling: "value" | "handle"
}

const deliveryGen: Gen<Delivery> = weighted<Delivery>([
	[1, map(element(fields), (field): Delivery => ({ kind: "field", field }))],
	[1, map(element(["A", "B"] as const), (member): Delivery => ({ kind: "handle", member }))],
	[1, map(element(["integer", "bigint"] as const), (type): Delivery => ({ kind: "typed", type }))],
	[2, map(element<Plain>(plainValues), (value): Delivery => ({ kind: "plain", value }))],
	[
		1,
		element<Delivery>([
			{ kind: "field", field: "s" },
			{ kind: "plain", value: "lengthy" }
		])
	]
])

const armGen: Gen<Arm> = (source) => ({
	delivery: source.draw(deliveryGen),
	fix: source.draw(element(["none", "A", "B"] as const)),
	spelling: source.draw(element(["value", "handle"] as const))
})

/** Whether a value of the universe is a value of a type: what the checker's admission of a literal decides. */
const admits = (type: Token, value: Plain): boolean => {
	switch (type) {
		case "Kind":
			return value === "A" || value === "B"
		case "Short":
			return typeof value === "string" && value.length <= 4
		case "text":
			return typeof value === "string"
		case "integer":
			return typeof value === "number" && Number.isSafeInteger(value)
		case "bigint":
			return typeof value === "bigint"
		case "numeric":
			return value instanceof Numeric || typeof value === "bigint"
		case "money":
			return value instanceof Money
		case "float8":
			return typeof value === "number"
		case "boolean":
			return typeof value === "boolean"
	}
}

/** A plain literal's JavaScript default, or none for a number that is no safe integer, which is refused. */
const defaultOf = (value: Plain): Token | undefined => {
	if (typeof value === "string") {
		return "text"
	}
	if (typeof value === "bigint") {
		return "bigint"
	}
	if (typeof value === "boolean") {
		return "boolean"
	}
	if (value instanceof Numeric) {
		return "numeric"
	}
	if (value instanceof Money) {
		return "money"
	}
	return Number.isSafeInteger(value) ? "integer" : undefined
}

const isText = (t: Token): boolean => t === "Short" || t === "text"

/** The type a list of types agrees on: the one they share, text when every one is text, otherwise none. */
const agreed = (types: ReadonlyArray<Token>): Token | undefined => {
	const [first] = types
	if (first === undefined) {
		return undefined
	}
	if (Arr.every(types, (t) => t === first)) {
		return first
	}
	return Arr.every(types, isText) ? "text" : undefined
}

/** What the rule makes of a union: `c`'s type, or a refusal. */
type Expected = { readonly kind: "typed"; readonly type: Token } | { readonly kind: "refused" }

const termType = (d: Exclude<Delivery, { readonly kind: "plain" }>): Token => {
	switch (d.kind) {
		case "field":
			return fieldTypes[d.field]
		case "handle":
			return "Kind"
		case "typed":
			return d.type
	}
}

export const expectedOf = (arms: Arr.NonEmptyReadonlyArray<Arm>): Expected => {
	const terms = Arr.flatMap(arms, (a) =>
		a.delivery.kind === "plain" ? [] : [termType(a.delivery)]
	)
	const byTerms = agreed(terms)
	const types: Array<Token> = []
	for (const { delivery } of arms) {
		if (delivery.kind !== "plain") {
			types.push(termType(delivery))
			continue
		}
		const own = defaultOf(delivery.value)
		if (own === undefined) {
			return { kind: "refused" }
		}
		types.push(byTerms !== undefined && admits(byTerms, delivery.value) ? byTerms : own)
	}
	const type = agreed(types)
	return type === undefined ? { kind: "refused" } : { kind: "typed", type }
}

/** The tokens of the universe's carriers other than text, which its refinement tells apart. */
const carrierTokens: Readonly<Record<string, Token>> = {
	code: "Kind",
	int4: "integer",
	int8: "bigint",
	numeric: "numeric",
	money: "money",
	float8: "float8",
	bool: "boolean"
}

/** The token of a checked heading type, read by its carrier and, for text, its refinement. */
export const tokenOf = (t: ScalarType): Token => {
	const carrier = baseOf(t).carrier
	if (carrier === "text") {
		return sameScalarType(t, wildcardText) ? "text" : "Short"
	}
	return Option.match(Rec.get(carrierTokens, carrier), {
		onNone: () => assert.fail(`a head type of the universe, not ${carrier}`),
		onSome: (token) => token
	})
}

/** One arm as a rule: Cell matched, the handle field fixed as the arm spells it when it says so, and `c` delivered. */
const armRule =
	(arm: Arm) =>
	(r: RuleValue): FinishedValue => {
		const vars = varsOver(Cell, "cell")
		const bindings: Record<string, unknown> = { id: vars["id"] }
		const d = arm.delivery
		if (arm.fix !== "none" && !(d.kind === "field" && d.field === "h")) {
			bindings["h"] = arm.spelling === "handle" ? Kind.handle(arm.fix) : arm.fix
		}
		switch (d.kind) {
			case "field":
				bindings[d.field] = vars[d.field]
				return r.match(Cell, bindings).find({ c: vars[d.field] })
			case "handle":
				return r.match(Cell, bindings).find({ c: Kind.handle(d.member) })
			case "typed":
				return r.match(Cell, bindings).find({
					c: d.type === "integer" ? computeCore.literal(int4, 7) : computeCore.literal(int8, 7n)
				})
			case "plain":
				return r.match(Cell, bindings).find({ c: d.value })
		}
	}

export const unionOf = (arms: Arr.NonEmptyReadonlyArray<Arm>): QueryValue => {
	const [first, ...rest] = arms
	let q = queryOver(Cells).rule(armRule(first))
	for (const arm of rest) {
		q = q.rule(armRule(arm))
	}
	return q
}

export type Feature =
	| "a plain text its rule fixes Kind to"
	| "a plain text its rule fixes Kind to by a handle"
	| "a Numeric or a Money"
	| "a plain literal beside a term-typed arm"
	| "a plain literal the term-typed arms' type refuses"
	| "a handle"
	| "a typed literal"
	| "plain literals only"
	| `plain literals only, typed ${Token}`
	| "a number that is no safe integer"
	| "text of two refinements"
	| "refused"
	| "typed"

export const featuresOf = (
	arms: Arr.NonEmptyReadonlyArray<Arm>,
	expected: Expected
): ReadonlyArray<Feature> => {
	const plains = Arr.flatMap(arms, (a) => (a.delivery.kind === "plain" ? [a.delivery.value] : []))
	const terms = Arr.flatMap(arms, (a) =>
		a.delivery.kind === "plain" ? [] : [termType(a.delivery)]
	)
	const byTerms = agreed(terms)
	const out: Array<Feature> = [expected.kind]
	const fixedTo = Arr.filter(
		arms,
		(a) => a.delivery.kind === "plain" && a.fix !== "none" && a.delivery.value === a.fix
	)
	if (Arr.isReadonlyArrayNonEmpty(fixedTo)) {
		out.push("a plain text its rule fixes Kind to")
	}
	if (Arr.some(fixedTo, (a) => a.spelling === "handle")) {
		out.push("a plain text its rule fixes Kind to by a handle")
	}
	if (Arr.some(plains, (v) => v instanceof Numeric || v instanceof Money)) {
		out.push("a Numeric or a Money")
	}
	if (plains.length > 0 && terms.length > 0) {
		out.push("a plain literal beside a term-typed arm")
		if (byTerms !== undefined && Arr.some(plains, (v) => !admits(byTerms, v))) {
			out.push("a plain literal the term-typed arms' type refuses")
		}
	}
	if (terms.length === 0) {
		out.push("plain literals only")
		if (expected.kind === "typed") {
			out.push(`plain literals only, typed ${expected.type}`)
		}
	}
	if (Arr.some(arms, (a) => a.delivery.kind === "handle")) {
		out.push("a handle")
	}
	if (Arr.some(arms, (a) => a.delivery.kind === "typed")) {
		out.push("a typed literal")
	}
	if (Arr.some(plains, (v) => defaultOf(v) === undefined)) {
		out.push("a number that is no safe integer")
	}
	if (
		expected.kind === "typed" &&
		expected.type === "text" &&
		Arr.some(terms, (t) => t === "Short")
	) {
		out.push("text of two refinements")
	}
	return out
}

export const checked = checking(Cells)

/** The types a plain literal takes by its JavaScript default, each the default of some plain value. */
export const plainDefaults: Arr.NonEmptyReadonlyArray<Token> = [
	"text",
	"integer",
	"bigint",
	"numeric",
	"money",
	"boolean"
]

/**
 * One to four arms of plain literals alone, each a value whose JavaScript default is `type`, fixing no handle: a union
 * the rule types by that default.
 */
const plainOnlyGen = (type: Token): Gen<ReadonlyArray<Arm>> => {
	const [first, ...rest] = Arr.filter(plainValues, (value) => defaultOf(value) === type)
	if (first === undefined) {
		throw new Error(`no plain value takes ${type} by its JavaScript default`)
	}
	return array(
		map(element<Plain>([first, ...rest]), (value): Arm => ({
			delivery: { kind: "plain", value },
			fix: "none",
			spelling: "value"
		})),
		{ min: 1, max: 4 }
	)
}

/** One to four arms, aimed at plain literals alone typed by each JavaScript default. */
export const armsSpace: Aimed<ReadonlyArray<Arm>, Feature> = aimed(
	array(armGen, { min: 1, max: 4 }),
	Arr.map(
		plainDefaults,
		(type) => [`plain literals only, typed ${type}` as const, plainOnlyGen(type)] as const
	)
)
