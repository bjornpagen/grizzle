import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, map, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { baseOf, type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { closedId, Decimal, Money, pg } from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import { assert, defined, refused, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking, checkOptions } from "#test/support/policy.ts"

/**
 * Head literal typing (TODO 0b, literal typing): a literal's type is carried by its value, never guessed from its rule.
 *
 * Property: for a drawn union of one to four arms over Cell, each delivering the one head field `c` as a field of Cell,
 * a roster's typed handle (Kind.handle), a typed literal (Compute.literal) or a plain literal (the JavaScript value
 * itself), and each plain-literal or typed arm matching Cell with its handle field fixed to a drawn handle, spelled as
 * its JavaScript value or as its typed handle, or to none, the checker gives `c` exactly the type the oracle below
 * gives it, or refuses the union exactly when the oracle does. The oracle is the rule over a small universe whose types
 * and admissions this file states itself: a term-typed arm (a field, a handle, a typed literal) delivers its own type;
 * a plain literal takes the type the term-typed arms agree on when that type admits its value, and otherwise its
 * value's JavaScript default (bareLiteralType: a string text, a safe integer integer, a bigint bigint, a Decimal
 * numeric, a Money money, a boolean boolean, any other number refused); the arms' types then agree, combine to text
 * when they are text of different refinements, or are refused. The handle a match fixes never types a literal, however
 * the fix is spelled: a plain "A" whose rule fixes Kind to "A" or to Kind.handle("A") is text, which the value-aware
 * handle default this replaced made Kind.
 */
const Kind = closed("Kind", ["A", "B"])
const Short = str.regex("^.{0,4}$", "su")
const Cell = relation(
	"Cell",
	{
		id: pg.integer,
		h: closedId(Kind),
		s: Short,
		n: pg.integer,
		b: pg.bigint,
		x: pg.numeric(10, 2),
		m: pg.money,
		f: pg.float8,
		t: pg.boolean
	},
	["id"]
)
const Cells = schema("HeadLiterals", { Kind, Cell }, [])

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
 * plain text beside Short's field combines to text), and one of every other kind, a Decimal and a Money among them.
 */
const plainValues = [
	"A",
	"B",
	"zz",
	"lengthy",
	1,
	7n,
	Decimal.of("2.5"),
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
interface Arm {
	readonly delivery: Delivery
	readonly fix: "none" | "A" | "B"
	readonly spelling: "value" | "handle"
}

const deliveryGen: Gen<Delivery> = oneOf<Delivery>([
	map(element(fields), (field): Delivery => ({ kind: "field", field })),
	map(element(["A", "B"] as const), (member): Delivery => ({ kind: "handle", member })),
	map(element(["integer", "bigint"] as const), (type): Delivery => ({ kind: "typed", type })),
	map(element<Plain>(plainValues), (value): Delivery => ({ kind: "plain", value })),
	map(element<Plain>(plainValues), (value): Delivery => ({ kind: "plain", value })),
	element<Delivery>([
		{ kind: "field", field: "s" },
		{ kind: "plain", value: "lengthy" }
	])
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
			return value instanceof Decimal || typeof value === "bigint"
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
	if (value instanceof Decimal) {
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

const expectedOf = (arms: Arr.NonEmptyReadonlyArray<Arm>): Expected => {
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
const tokenOf = (t: ScalarType): Token => {
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
					c:
						d.type === "integer"
							? computeCore.literal(pg.integer, 7)
							: computeCore.literal(pg.bigint, 7n)
				})
			case "plain":
				return r.match(Cell, bindings).find({ c: d.value })
		}
	}

const unionOf = (arms: Arr.NonEmptyReadonlyArray<Arm>): QueryValue => {
	const [first, ...rest] = arms
	let q = queryOver(Cells).rule(armRule(first))
	for (const arm of rest) {
		q = q.rule(armRule(arm))
	}
	return q
}

type Feature =
	| "a plain text its rule fixes Kind to"
	| "a plain text its rule fixes Kind to by a handle"
	| "a Decimal or a Money"
	| "a plain literal beside a term-typed arm"
	| "a plain literal the term-typed arms' type refuses"
	| "a handle"
	| "a typed literal"
	| "plain literals only"
	| "a number that is no safe integer"
	| "text of two refinements"
	| "refused"
	| "typed"

const featuresOf = (
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
	if (Arr.some(plains, (v) => v instanceof Decimal || v instanceof Money)) {
		out.push("a Decimal or a Money")
	}
	if (plains.length > 0 && terms.length > 0) {
		out.push("a plain literal beside a term-typed arm")
		if (byTerms !== undefined && Arr.some(plains, (v) => !admits(byTerms, v))) {
			out.push("a plain literal the term-typed arms' type refuses")
		}
	}
	if (terms.length === 0) {
		out.push("plain literals only")
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

const coverage = required<Feature>(
	[
		"a plain text its rule fixes Kind to",
		"a plain text its rule fixes Kind to by a handle",
		"a Decimal or a Money",
		"a plain literal beside a term-typed arm",
		"a plain literal the term-typed arms' type refuses",
		"a handle",
		"a typed literal",
		"plain literals only",
		"a number that is no safe integer",
		"text of two refinements",
		"refused",
		"typed"
	],
	{ cases: 400, sense: notesOnly }
)

describe("head literal typing", () => {
	it.effect(
		"types a head literal by the field it writes, its union's term-typed arms or its value, and a handle by its roster",
		(ctx) => {
			const checked = checking(Cells)
			return searched(
				ctx,
				explore(
					{
						suite: "unit/check/head-literals",
						draw: drawn(array(armGen, { min: 1, max: 4 })),
						literal: Formatter.format,
						coverage,
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(drawnArms, c) =>
						Effect.sync(() => {
							const [first, ...rest] = drawnArms
							const arms: Arr.NonEmptyReadonlyArray<Arm> = [defined(first, "a drawn arm"), ...rest]
							const expected = expectedOf(arms)
							c.noteAll(featuresOf(arms, expected))
							/**
							 * A union whose arms deliver `c` at types no rule combines is refused at its description: by the
							 * builder's read of the union's arms (program/compile.ts queryInput), or else by the checker.
							 */
							const built = queryInput(unionOf(arms))
							if (expected.kind === "refused" && !built.ok) {
								refused(built, "MalformedDescription", "the union the rule refuses is refused")
								return
							}
							const input = succeeded(built, "the builder admits every union the rule types")
							const result = checkQuery(checked, input.desc, checkOptions("head literals"))
							if (expected.kind === "refused") {
								refused(result, "MalformedDescription", "the union the rule refuses is refused")
								return
							}
							const dag = succeeded(result, "the union the rule types is checked").dag
							const root = dag.roots[0]
							Option.match(
								Arr.findFirst(root.heading, (col) => col.name === "c"),
								{
									onNone: () => assert.fail("the checked root delivers the head field c"),
									onSome: (column) => {
										assert.equal(
											tokenOf(column.type),
											expected.type,
											"c takes the type the rule gives it"
										)
									}
								}
							)
						})
				)
			)
		}
	)
})
