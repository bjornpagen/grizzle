/** What the properties of constructors.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	weighted
} from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import { bigint, double } from "@bjornpagen/testing/values"
import { regex as arkregex } from "arkregex"
import { Array as Arr, pipe, Record as Rec, String as Str } from "effect"
import type { ExprDesc, LiteralDesc, TermDesc } from "#compiler/ir/desc.ts"
import { natural, uuid } from "#compiler/public/fields.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { untypedTerm } from "#compiler/query/build/terms.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import {
	closedBuilder as closed,
	derivedBuilder,
	relationBuilder as relation,
	relationDescOf
} from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import {
	checkBuilder,
	keyBuilder,
	mirrorsBuilder,
	mutableBuilder,
	onBuilder,
	selectBuilder,
	statementDescOf
} from "#compiler/schema/statements.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { Id } from "#test/support/ids.ts"
import {
	patternOnly,
	rawClosedId,
	rawContract,
	rawPg,
	regex,
	type Row,
	wildcard
} from "#test/unit/schema/support.ts"

export const Kind = closed("Kind", ["Automatic", "Manual"], "ordered", [])

export const Task = relation("Task", { id: Id, account: Id, kind: rawClosedId(Kind) }, ["id"], [])

/**
 * A one-rule definition over `over` finding the ids of `sources`, each a relation or a derived relation matched on its
 * id, built by the query builder's untyped core as a JavaScript caller builds one.
 */
export const idsOf = (over: unknown, sources: Arr.NonEmptyReadonlyArray<unknown>) =>
	queryOver(over).rule((r: RuleValue) => {
		const { id } = varsOver(sources[0], "source")
		return Arr.reduce(sources, r, (rule: RuleValue, source) => rule.match(source, { id })).find({
			id
		})
	})

/** A drawn roster, which every draw makes nonempty, as the nonempty list closed.ordered(...) takes. */
export const rosterOf = (handles: ReadonlyArray<string>): Arr.NonEmptyReadonlyArray<string> => {
	const [first, ...rest] = handles
	if (first === undefined) {
		return assert.fail("a drawn roster of at least one handle")
	}
	return [first, ...rest]
}

export const wordGen = matching(arkregex("^[a-z][a-zA-Z0-9]{0,7}$"))

/** A payload field's name, never the key's `id`: a word that ends in a digit, which `id` does not. */
export const payloadNameGen = matching(arkregex("^[a-z][a-zA-Z0-9]{0,6}[0-9]$"))

/** A nonempty list: a first element and up to `more` others. */
export const nonEmptyGen =
	<A>(item: Gen<A>, more: number): Gen<Arr.NonEmptyReadonlyArray<A>> =>
	(source) => [source.draw(item), ...source.draw(array(item, { min: 0, max: more }))]

/** The first occurrence of each item, in order. */
export const distinct = <A>(items: ReadonlyArray<A>): Array<A> => [...new Set(items)]

/**
 * A descriptor no builder made: str.regex's public pattern alone, a plain object, or an object spread of a built one.
 */
export type LookAlike = "pattern only" | "plain object" | "spread copy"

export const lookAlikeOf = (kind: LookAlike): unknown =>
	kind === "pattern only"
		? patternOnly("^.*$", "su")
		: kind === "plain object"
			? { sql: "uuid" }
			: { ...uuid }

export const builtDescriptors: Arr.NonEmptyReadonlyArray<FieldBase> = [
	Id,
	rawPg.integer,
	rawPg.bigint,
	regex("^[a-z]{1,8}$", "u")
]

export type RelationDefect =
	| "none"
	| "an empty name"
	| "no fields"
	| "a look-alike descriptor"
	| "an empty field name"
	| "an empty key"
	| "an undeclared key field"
	| "a repeated key field"
	| "a fourth argument"

export const relationDefects: Arr.NonEmptyReadonlyArray<RelationDefect> = [
	"none",
	"an empty name",
	"no fields",
	"a look-alike descriptor",
	"an empty field name",
	"an empty key",
	"an undeclared key field",
	"a repeated key field",
	"a fourth argument"
]

/** The reason each defect is refused for: a malformed call, or a rule the types name too, a key's fields each once. */
export const relationTags: {
	readonly [D in Exclude<RelationDefect, "none">]: "MalformedDescription" | "Refused"
} = {
	"an empty name": "MalformedDescription",
	"no fields": "MalformedDescription",
	"a look-alike descriptor": "MalformedDescription",
	"an empty field name": "MalformedDescription",
	"an empty key": "MalformedDescription",
	"an undeclared key field": "MalformedDescription",
	"a repeated key field": "Refused",
	"a fourth argument": "MalformedDescription"
}

/** The name, field names and primary key an ordinary relation's Description records. */
export const recorded = (value: unknown, label: string) => {
	const desc = relationDescOf(value, label)
	if (desc.kind !== "relation") {
		return assert.fail(`${label} is an ordinary relation`)
	}
	const primaryKey: ReadonlyArray<string> = desc.primaryKey
	return { name: desc.name, fields: Rec.keys(desc.fields), primaryKey }
}

/** What a caller does to its own inputs after the relation is built. */
export type Mutation = "add a field" | "extend the key" | "drop a field" | "reverse the key"

/** A payload field of a closed relation as drawn: its type, and a value of each fact a builder admits for it. */
export type PayloadType = "bigint" | "cents" | "rate" | "money" | "ratio" | "flag"

const Cents = rawContract("Cents", rawPg.bigint, {
	kind: "compare",
	op: "ge",
	left: { kind: "value" },
	right: { kind: "literal", value: 0n }
})

export const payloadDescriptor = (type: PayloadType): FieldBase => {
	switch (type) {
		case "bigint":
			return rawPg.bigint
		case "cents":
			return Cents
		case "rate":
			return rawPg.numericOf(7, 6)
		case "money":
			return rawPg.money
		case "ratio":
			return rawPg.real
		case "flag":
			return rawPg.boolean
	}
}

/**
 * A value of each payload type: a contract's literal is its base's, whether or not it satisfies the predicate (that is
 * the checker's judgment at compilation).
 */
const payloadValueGen = (type: PayloadType): Gen<unknown> => {
	switch (type) {
		case "bigint":
		case "cents":
			return bigint(-1_000_000n, 1_000_000n)
		case "rate":
			return map(
				(source) => ({
					integer: source.draw(int(0, 8)),
					fraction: source.draw(matching(arkregex("^[0-9]{0,8}$")))
				}),
				({ integer, fraction }) => (fraction === "" ? `${integer}` : `${integer}.${fraction}`)
			)
		case "money":
			return map(bigint(-1_000_000n, 1_000_000n), (cents) => Money.of(cents))
		case "ratio":
			return map(int(-1_000_000, 1_000_000), (n) => n / 64)
		case "flag":
			return boolean
	}
}

/** A value of the wrong host kind for each payload type: a JavaScript number is never a numeric or bigint literal. */
export const mistypedValue = (type: PayloadType): unknown => {
	switch (type) {
		case "bigint":
		case "cents":
		case "rate":
			return 1
		case "money":
			return 1n
		case "ratio":
			return "1"
		case "flag":
			return 1
	}
}

/** A roster's declaration's defect, none among them; a roster of no handle is no defect, the empty domain (empty-roster). */
export type RosterDefect = "none" | "a repeated handle" | "a third argument"

export const rosterDefects: Arr.NonEmptyReadonlyArray<RosterDefect> = [
	"none",
	"a repeated handle",
	"a third argument"
]

type ClosedDefect =
	| "none"
	| "an extra field in a row"
	| "a missing field in a row"
	| "a key off the roster"
	| "a mistyped value"
	| "two rows of one key, other payloads"
	| "a key of an open field"
	| "a fifth argument"

export const closedDefects: Arr.NonEmptyReadonlyArray<ClosedDefect> = [
	"none",
	"an extra field in a row",
	"a missing field in a row",
	"a key off the roster",
	"a mistyped value",
	"two rows of one key, other payloads",
	"a key of an open field",
	"a fifth argument"
]

export type ClosedFeature =
	| ClosedDefect
	| "no payload"
	| "payload"
	| "no rows"
	| "a row written twice"

export const payloadFieldOf =
	(
		name: string
	): Gen<{
		readonly name: string
		readonly type: PayloadType
		readonly values: ReadonlyArray<unknown>
	}> =>
	(source) => {
		const type = source.draw(
			element<PayloadType>(["bigint", "cents", "rate", "money", "ratio", "flag"])
		)
		return { name, type, values: source.draw(array(payloadValueGen(type), { min: 4, max: 4 })) }
	}

/** A host value a caller writes against a real, double precision or numeric(p, s) field. */
type HostValue =
	| { readonly kind: "number"; readonly value: number }
	| {
			readonly kind: "decimal"
			readonly negative: boolean
			readonly integer: string
			readonly fraction: string
	  }
	| { readonly kind: "special"; readonly text: "Infinity" | "-Infinity" | "NaN" }
	| { readonly kind: "bigint"; readonly value: bigint }

export const hostValue = (v: HostValue): unknown => {
	switch (v.kind) {
		case "number":
		case "bigint":
			return v.value
		case "decimal":
			return `${v.negative ? "-" : ""}${v.integer}${v.fraction === "" ? "" : `.${v.fraction}`}`
		case "special":
			return v.text
	}
}

type LiteralField =
	| { readonly kind: "real" }
	| { readonly kind: "double precision" }
	| { readonly kind: "numeric(p, s)"; readonly precision: number; readonly scale: number }

/** What the literal rule makes of a value: the float literal, the numeric's text, or the fault. */
type Expected =
	| { readonly kind: "float"; readonly literal: LiteralDesc }
	| { readonly kind: "numeric"; readonly text: string }
	| {
			readonly kind: "fault"
			readonly fault:
				| "floatType"
				| "realOverflow"
				| "realUnderflow"
				| "numericOverflow"
				| "numericInfinity"
				| "numericNaN"
				| "decimalNumber"
	  }

type LiteralOutcome =
	| "rounded"
	| "kept"
	| "special"
	| "integer NaN"
	| "negative zero"
	| "overflow"
	| "underflow"
	| "infinity"
	| "wrong host kind"

/**
 * The literal rules restated (scalar/literal.ts), for a value written opposite a field of `field`'s type: what a
 * comparison records (`compared`), the value as written, and what a stored fact records (`stored`), the value as
 * PostgreSQL's assignment into the column stores it; `outcome` names what the assignment did. A float field takes a
 * JavaScript number, its special values and -0 wrapped. Compared, every other number is itself. Stored, a real is its
 * binary32 rounding (Math.fround), refused when a finite value rounds to an infinity (overflow) or a nonzero value to
 * zero (underflow). A numeric field never takes a JavaScript number. Compared, a decimal, a bigint or a special is
 * itself; stored, numeric(p, s) rounds a decimal to s fractional digits, half away from zero, refuses one that then
 * needs more than p digits and refuses an infinity, and numeric(p, 0), whose values are integers, refuses NaN. A
 * numeric's zero has no sign.
 */
export const expectedLiteral = (
	field: LiteralField,
	v: HostValue
): {
	readonly compared: Expected
	readonly stored: Expected
	readonly outcome: LiteralOutcome
} => {
	if (field.kind === "real" || field.kind === "double precision") {
		if (v.kind !== "number") {
			const fault: Expected = { kind: "fault", fault: "floatType" }
			return { compared: fault, stored: fault, outcome: "wrong host kind" }
		}
		const x = v.value
		const special = Number.isNaN(x)
			? "NaN"
			: x === Number.POSITIVE_INFINITY
				? "Infinity"
				: x === Number.NEGATIVE_INFINITY
					? "-Infinity"
					: undefined
		if (special !== undefined) {
			const wrapped: Expected = { kind: "float", literal: { float: special } }
			return { compared: wrapped, stored: wrapped, outcome: "special" }
		}
		if (Object.is(x, -0)) {
			const wrapped: Expected = { kind: "float", literal: { float: "-0" } }
			return { compared: wrapped, stored: wrapped, outcome: "negative zero" }
		}
		const compared: Expected = { kind: "float", literal: x }
		if (field.kind === "double precision") {
			return { compared, stored: compared, outcome: "kept" }
		}
		const f = Math.fround(x)
		if (!Number.isFinite(f)) {
			return { compared, stored: { kind: "fault", fault: "realOverflow" }, outcome: "overflow" }
		}
		if (f === 0 && x !== 0) {
			return { compared, stored: { kind: "fault", fault: "realUnderflow" }, outcome: "underflow" }
		}
		return {
			compared,
			stored: { kind: "float", literal: f },
			outcome: f === x ? "kept" : "rounded"
		}
	}
	switch (v.kind) {
		case "number": {
			const fault: Expected = { kind: "fault", fault: "decimalNumber" }
			return { compared: fault, stored: fault, outcome: "wrong host kind" }
		}
		case "special": {
			const compared: Expected = { kind: "numeric", text: v.text }
			return v.text !== "NaN"
				? { compared, stored: { kind: "fault", fault: "numericInfinity" }, outcome: "infinity" }
				: field.scale === 0
					? { compared, stored: { kind: "fault", fault: "numericNaN" }, outcome: "integer NaN" }
					: { compared, stored: compared, outcome: "special" }
		}
		case "bigint":
		case "decimal": {
			const negative = v.kind === "bigint" ? v.value < 0n : v.negative
			const integer = v.kind === "bigint" ? (negative ? -v.value : v.value).toString() : v.integer
			const fraction = v.kind === "bigint" ? "" : v.fraction
			const digits = BigInt(`${integer}${fraction}`)
			/** The value's one text, units · 10^-scale with every trailing fractional zero dropped and no -0. */
			const oneText = (magnitude: bigint, at: number): string => {
				let units = magnitude
				let scale = at
				while (scale > 0 && units % 10n === 0n) {
					units /= 10n
					scale--
				}
				const padded = pipe(units.toString(), Str.padStart(scale + 1, "0"))
				const text =
					scale === 0 ? padded : `${Str.slice(0, -scale)(padded)}.${Str.slice(-scale)(padded)}`
				return negative && units > 0n ? `-${text}` : text
			}
			const compared: Expected = { kind: "numeric", text: oneText(digits, fraction.length) }
			const { precision, scale } = field
			const units =
				fraction.length <= scale
					? digits * 10n ** BigInt(scale - fraction.length)
					: roundedHalfUp(digits, 10n ** BigInt(fraction.length - scale))
			if (units >= 10n ** BigInt(precision)) {
				return {
					compared,
					stored: { kind: "fault", fault: "numericOverflow" },
					outcome: "overflow"
				}
			}
			return {
				compared,
				stored: { kind: "numeric", text: oneText(units, scale) },
				outcome: fraction.length > scale ? "rounded" : "kept"
			}
		}
	}
}

/** `digits` divided by `drop`, a power of ten, rounded half away from zero as numeric rounds a magnitude. */
const roundedHalfUp = (digits: bigint, drop: bigint): bigint =>
	digits / drop + ((digits % drop) * 2n >= drop ? 1n : 0n)

export const literalFieldDescriptor = (field: LiteralField): FieldBase => {
	switch (field.kind) {
		case "real":
			return rawPg.real
		case "double precision":
			return rawPg.doublePrecision
		case "numeric(p, s)":
			return rawPg.numericOf(field.precision, field.scale)
	}
}

/** The literal's value as the rule states it: a float literal itself, a numeric by its text. */
export const agrees = (literal: LiteralDesc, expected: Expected): void => {
	if (expected.kind === "float") {
		assert.deepEqual(literal, expected.literal)
	} else if (expected.kind === "numeric") {
		assert.ok(literal instanceof Decimal, "a numeric literal is a Decimal")
		assert.equal(literal.toString(), expected.text)
	} else {
		assert.fail(`the fault ${expected.fault}`)
	}
}

/**
 * Doubles of every magnitude, with both zeros and binary32's edges planted: its largest finite value, the first double
 * that rounds past it, its smallest subnormal and the doubles on either side of half of it.
 */
const floatGen: Gen<HostValue> = weighted([
	[
		3,
		map(double(-Number.MAX_VALUE, Number.MAX_VALUE), (value): HostValue => ({
			kind: "number",
			value
		}))
	],
	[
		2,
		map(
			element([
				Number.NaN,
				Number.POSITIVE_INFINITY,
				Number.NEGATIVE_INFINITY,
				-0,
				0,
				0.1,
				1e300,
				-1e300,
				1e-50,
				3.4028234663852886e38,
				3.4028235677973366e38,
				3.402823669209385e38,
				1.401298464324817e-45,
				7.006492321624085e-46,
				7.006492321624087e-46
			]),
			(value): HostValue => ({ kind: "number", value })
		)
	],
	[1, map(bigint(-10n, 10n), (value): HostValue => ({ kind: "bigint", value }))]
])

/**
 * Decimals with up to a few digits beyond the field's precision and scale, exact halves planted, the specials and a
 * JavaScript number.
 */
const numericGen = (precision: number, scale: number): Gen<HostValue> =>
	weighted([
		[
			4,
			map(
				(source) => ({
					negative: source.draw(boolean),
					integer: source.draw((source) => {
						const n = source.draw(int(0, precision - scale + 1))
						return source.draw(
							n === 0 ? constant("0") : matching(arkregex.as(`^[1-9][0-9]{${n - 1}}$`))
						)
					}),
					fraction: source.draw(matching(arkregex.as(`^[0-9]{0,${scale + 3}}$`)))
				}),
				(d): HostValue => ({ kind: "decimal", ...d })
			)
		],
		[
			2,
			map(
				(source) => ({
					negative: source.draw(boolean),
					integer: source.draw(element(["0", Str.repeat(Math.max(1, precision - scale))("9")])),
					kept: source.draw(matching(arkregex.as(`^[0-9]{${scale}}$`)))
				}),
				({ negative, integer, kept }): HostValue => ({
					kind: "decimal",
					negative,
					integer,
					fraction: `${kept}5`
				})
			)
		],
		[
			2,
			map(
				element<"Infinity" | "-Infinity" | "NaN">(["Infinity", "-Infinity", "NaN"]),
				(text): HostValue => ({ kind: "special", text })
			)
		],
		[1, map(bigint(-100n, 100n), (value): HostValue => ({ kind: "bigint", value }))],
		[
			1,
			map(
				weighted([
					[9, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
					[1, element([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])]
				]),
				(value): HostValue => ({ kind: "number", value })
			)
		]
	])

export const caseGen = weighted<{ readonly field: LiteralField; readonly value: HostValue }>([
	[1, (source) => ({ field: { kind: "real" }, value: source.draw(floatGen) })],
	[1, (source) => ({ field: { kind: "double precision" }, value: source.draw(floatGen) })],
	[
		1,
		(source) => {
			const precision = source.draw(int(1, 12))
			const scale = Math.min(source.draw(int(0, 12)), precision)
			return {
				field: { kind: "numeric(p, s)", precision, scale },
				value: source.draw(numericGen(precision, scale))
			}
		}
	]
])

export type LiteralSite = "closed row" | "selection" | "check operand"

export type LiteralFeature = `${LiteralField["kind"]}: ${LiteralOutcome}` | LiteralSite

/** A side's terms when each is a field, as on(...) records them. */
export const fieldTerms = (fields: ReadonlyArray<string>): ReadonlyArray<TermDesc> =>
	Arr.map(fields, (field): TermDesc => ({ kind: "field", field }))

/**
 * Where a side's terms or a selection is written, and the defects a JavaScript caller can plant there: on's terms,
 * over a relation or a selection, are a nonempty list of distinct terms, each a field of the heading or pred of a
 * natural one; key takes a side built by on and nothing else; select takes a callback over the row that returns a
 * predicate of its own fields, and nothing else.
 */
type TermsDefect =
	| "none"
	| "an empty list"
	| "an undeclared field"
	| "a repeated term"
	| "pred of a field that is not natural"

type KeyDefect = "none" | "no side"

type SelectDefect = "no callback" | "an undeclared field" | "no predicate"

type FieldListCase =
	| { readonly site: "key"; readonly defect: KeyDefect }
	| { readonly site: "on" | "on a selection"; readonly defect: TermsDefect }
	| { readonly site: "pred"; readonly defect: "none" }
	| { readonly site: "select"; readonly defect: SelectDefect }

const termsDefects: Arr.NonEmptyReadonlyArray<TermsDefect> = [
	"none",
	"an empty list",
	"an undeclared field",
	"a repeated term",
	"pred of a field that is not natural"
]

export const fieldListCases: Arr.NonEmptyReadonlyArray<FieldListCase> = [
	{ site: "key", defect: "none" },
	{ site: "key", defect: "no side" },
	...Arr.map(termsDefects, (defect): FieldListCase => ({ site: "on", defect })),
	...Arr.map(termsDefects, (defect): FieldListCase => ({ site: "on a selection", defect })),
	{ site: "pred", defect: "none" },
	{ site: "select", defect: "no callback" },
	{ site: "select", defect: "an undeclared field" },
	{ site: "select", defect: "no predicate" }
]

export type FieldListFeature = `${FieldListCase["site"]}: ${FieldListCase["defect"]}`

export const featureOf = (k: FieldListCase): FieldListFeature => `${k.site}: ${k.defect}`

export const taskFields: Arr.NonEmptyReadonlyArray<string> = ["id", "account", "kind"]

/** A relation with a count, the one type a pred term reads. */
export const Counted = relation("Counted", { id: Id, n: natural }, ["id"], [])

/** Task's facts of one kind, as a JavaScript caller writes the callback. */
export const ofKind = (handle: string) => (r: Row & { readonly kind: Row["id"] }) =>
	r.eq(r.kind, handle)

/** The predicate a check records for `callback` over Task: what a selection over the same callback records. */
export const predicateOf = (callback: unknown) => {
	const desc = statementDescOf(checkBuilder("Selected", Task, callback))
	return desc?.kind === "check" ? desc.predicate : assert.fail("a check statement")
}

export type SideStatement = "contained" | "mirrors"

export const Triple = relation("Triple", { a: Id, b: Id, c: Id }, ["a", "b", "c"], [])

export const tripleFields: Arr.NonEmptyReadonlyArray<string> = ["a", "b", "c"]

/**
 * A row check's predicate as drawn over Election: comparisons of integer fields, Num.add sums (a term its builder
 * registered, or the same expression as an untyped term of the query builder), and charLength of the text field, with
 * integer literals, under and, or and not.
 */
type Operand =
	| { readonly kind: "field"; readonly field: "limit" | "maximum" }
	| {
			readonly kind: "sum"
			readonly typed: boolean
			readonly field: "limit" | "maximum"
			readonly addend: number
	  }

type Op = "eq" | "ne" | "lt" | "le" | "gt" | "ge"

type CheckPredicate =
	| {
			readonly kind: "fields"
			readonly op: Op
			readonly left: Operand
			readonly right: "limit" | "maximum"
	  }
	| {
			readonly kind: "literal"
			readonly op: Op
			readonly left: Operand
			readonly value: number
	  }
	| { readonly kind: "length"; readonly op: Op; readonly n: number }
	| { readonly kind: "and" | "or"; readonly args: Arr.NonEmptyReadonlyArray<CheckPredicate> }
	| { readonly kind: "not"; readonly arg: CheckPredicate }

export type CheckDefect =
	| "none"
	| "a fraction for an integer field"
	| "a bigint for an integer field"
	| "a parameter"
	| "charLength of an integer field"
	| "a callback returning no predicate"
	| "a look-alike term"
	| "a spread copy of a term"
	| "a symbol operand"

export const checkDefects: Arr.NonEmptyReadonlyArray<CheckDefect> = [
	"none",
	"a fraction for an integer field",
	"a bigint for an integer field",
	"a parameter",
	"charLength of an integer field",
	"a callback returning no predicate",
	"a look-alike term",
	"a spread copy of a term",
	"a symbol operand"
]

const opGen = element<Op>(["eq", "ne", "lt", "le", "gt", "ge"])

const intField = element<"limit" | "maximum">(["limit", "maximum"])

const operandGen: Gen<Operand> = weighted([
	[3, map(intField, (field): Operand => ({ kind: "field", field }))],
	[
		1,
		map(
			(source) => ({
				typed: source.draw(boolean),
				field: source.draw(intField),
				addend: source.draw(int(-100, 100))
			}),
			(r): Operand => ({ kind: "sum", ...r })
		)
	]
])

const atomGen: Gen<CheckPredicate> = weighted([
	[
		1,
		map(
			(source) => ({
				op: source.draw(opGen),
				left: source.draw(operandGen),
				right: source.draw(intField)
			}),
			(r): CheckPredicate => ({ kind: "fields", ...r })
		)
	],
	[
		1,
		map(
			(source) => ({
				op: source.draw(opGen),
				left: source.draw(operandGen),
				value: source.draw(int(-1000, 1000))
			}),
			(r): CheckPredicate => ({ kind: "literal", ...r })
		)
	],
	[
		1,
		map(
			(source) => ({ op: source.draw(opGen), n: source.draw(int(0, 2000)) }),
			(r): CheckPredicate => ({ kind: "length", ...r })
		)
	]
])

export const predicateGen = (depth: number): Gen<CheckPredicate> =>
	depth === 0
		? atomGen
		: weighted([
				[2, atomGen],
				[
					1,
					map(
						(source) => ({
							kind: source.draw(element<"and" | "or">(["and", "or"])),
							args: source.draw(nonEmptyGen(predicateGen(depth - 1), 2))
						}),
						(r): CheckPredicate => r
					)
				],
				[1, map(predicateGen(depth - 1), (arg): CheckPredicate => ({ kind: "not", arg }))]
			])

export const Election = relation(
	"Election",
	{ id: Id, limit: rawPg.integer, maximum: rawPg.integer, label: wildcard },
	["id"],
	[]
)

const literalExpr = (value: LiteralDesc): ExprDesc => ({
	kind: "literal",
	value
})

/** The term an operand builds over the row, and the ExprDesc it records. */
const operandTerm = (e: Row, o: Operand): unknown => {
	if (o.kind === "field") {
		return e[o.field]
	}
	const sum = computeCore.add(e[o.field], o.addend)
	return o.typed ? sum : untypedTerm(sum.expr)
}

const operandExpr = (o: Operand): ExprDesc =>
	o.kind === "field"
		? { kind: "field", field: o.field }
		: {
				kind: "compute",
				fn: "add",
				args: [{ kind: "field", field: o.field }, literalExpr(o.addend)]
			}

export const built = (e: Row, p: CheckPredicate): unknown => {
	switch (p.kind) {
		case "fields":
			return e[p.op](operandTerm(e, p.left), e[p.right])
		case "literal":
			return e[p.op](operandTerm(e, p.left), p.value)
		case "length":
			return e[p.op](e.charLength(e.label), p.n)
		case "and":
		case "or":
			return e[p.kind](Arr.map(p.args, (a) => built(e, a)))
		case "not":
			return e.not(built(e, p.arg))
	}
}

export const recordedExpr = (p: CheckPredicate): ExprDesc => {
	switch (p.kind) {
		case "fields":
			return {
				kind: "compare",
				op: p.op,
				left: operandExpr(p.left),
				right: { kind: "field", field: p.right }
			}
		case "literal":
			return { kind: "compare", op: p.op, left: operandExpr(p.left), right: literalExpr(p.value) }
		case "length":
			return {
				kind: "compare",
				op: p.op,
				left: { kind: "compute", fn: "charLength", args: [{ kind: "field", field: "label" }] },
				right: literalExpr(p.n)
			}
		case "and":
		case "or": {
			/** A connective of one predicate is that predicate. */
			const [only, ...more] = p.args
			return more.length === 0
				? recordedExpr(only)
				: { kind: p.kind, args: Arr.map(p.args, recordedExpr) }
		}
		case "not":
			return { kind: "not", arg: recordedExpr(p.arg) }
	}
}

/** Every operand of a drawn predicate. */
export const operandsOf = (p: CheckPredicate): ReadonlyArray<Operand> => {
	switch (p.kind) {
		case "fields":
		case "literal":
			return [p.left]
		case "length":
			return []
		case "and":
		case "or":
			return Arr.flatMap(p.args, operandsOf)
		case "not":
			return operandsOf(p.arg)
	}
}

/** The conjunct a defect plants beside the drawn predicate. */
export const plantedConjunct = (e: Row, defect: CheckDefect): unknown => {
	const sum = computeCore.add(e.limit, 1)
	switch (defect) {
		case "a fraction for an integer field":
			return e.ge(e.limit, 1.5)
		case "a bigint for an integer field":
			return e.ge(e.limit, 1n)
		case "a parameter":
			return e.ge(e.limit, { param: "x" })
		case "charLength of an integer field":
			return e.le(e.charLength(e.limit), 3)
		case "a look-alike term":
			return e.le({ expr: sum.expr }, e.maximum)
		case "a spread copy of a term":
			return e.le({ ...sum }, e.maximum)
		case "a symbol operand":
			return e.lt(untypedTerm(sum.expr), Symbol("x"))
		case "none":
		case "a callback returning no predicate":
			return e.ge(e.limit, 0)
	}
}

const Account = relation("Account", { id: Id, name: regex("^[a-z]{1,40}$", "u") }, ["id"], [])

const AutomaticTask = relation("AutomaticTask", { task: Id, budget: Cents }, ["task"], [])

type Entry = "Kind" | "Task" | "Account" | "AutomaticTask"

export const entryNames: Arr.NonEmptyReadonlyArray<Entry> = [
	"Kind",
	"Task",
	"Account",
	"AutomaticTask"
]

/** Each entry's relation, which carries its own name: a list holds no name apart from the relation it names. */
export const entryValues: { readonly [E in Entry]: AnyRelation | AnyClosed } = {
	Kind,
	Task,
	Account,
	AutomaticTask
}

/**
 * Each statement with the relations it was built over, which every list it is drawn with declares: a statement over
 * a relation no level declares is refused, and that refusal, with every clash of one name's two meanings, is
 * unit/schema/compose's to hold.
 */
export const statementValues: Arr.NonEmptyReadonlyArray<{
	readonly statement: Statement
	readonly over: ReadonlyArray<Entry>
}> = [
	{ statement: mutableBuilder(Task), over: ["Task"] },
	{ statement: keyBuilder(onBuilder(Account, ["name"])), over: ["Account"] },
	{
		statement: mirrorsBuilder(
			onBuilder(AutomaticTask, ["task"]),
			onBuilder(selectBuilder(Task, ofKind("Automatic")), ["id"])
		),
		over: ["AutomaticTask", "Task", "Kind"]
	},
	{
		statement: mirrorsBuilder(onBuilder(AutomaticTask, ["task"]), onBuilder(Task, ["id"])),
		over: ["AutomaticTask", "Task"]
	}
]

export type SchemaDefect =
	| "none"
	| "relations that are no list"
	| "a list as a statement"
	| "a statement no builder made"
	| "a derived relation"
	| "statements that are no list"

export const schemaDefects: Arr.NonEmptyReadonlyArray<SchemaDefect> = [
	"none",
	"relations that are no list",
	"a list as a statement",
	"a statement no builder made",
	"a derived relation",
	"statements that are no list"
]

/** A derived relation, which no schema's own relations may hold. */
export const D = derivedBuilder("TaskIds", idsOf(schema("Edu", [Kind, Task], [], []), [Task]), [])

/**
 * A derived relation as drawn: the relations of the levels below it its definition reads (picks into them, at least
 * one), on their ids.
 */
export type LevelDefect =
	| "none"
	| "a read of its own level"
	| "a parameter"
	| "a definition that is no query"
	| "two bases"

export const levelDefects: Arr.NonEmptyReadonlyArray<LevelDefect> = [
	"none",
	"a read of its own level",
	"a parameter",
	"a definition that is no query",
	"two bases"
]
