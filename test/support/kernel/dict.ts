import { element, type Gen } from "@grizzle/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Option, Schema, String as Str } from "effect"
import { conversionOf, parseDeclaredName } from "#compiler/core/identity.ts"
import { type TypedLiteral, literalProblem } from "#compiler/ir/expr.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { isName } from "#compiler/schema/protocol.ts"
import { nonEmpty } from "#test/support/assert.ts"

export type IdentifierFeature =
	| "alias"
	| "digit boundary"
	| "long, at the limit"
	| "long, past the limit"
	| "reserved word"
	| "plain"

/**
 * Dictionaries: the tricky identifiers and literals a generator draws besides its own, each admitted by the production
 * validator, never by a test's idea of it.
 *
 * Random names and values rarely hit the boundaries the code branches on, so a generator mixes in dictionaries
 * of values that do, classified by the real rules:
 *
 * - Identifiers. Declared names that convert to one identifier (HTTPRoute, HttpRoute, Http_Route, http_route), digit
 *   boundaries (Task2Note, Task_2_Note), names whose conversions fill exactly 63 bytes and differ only in their last
 *   segment, names one segment past the limit, reserved words, and names the rule refuses. The naming door's rule
 *   (core/identity.ts parseDeclaredName) classifies every entry: an alias group is a set of admitted names whose conversions
 *   coincide, computed, not asserted, and a refused name carries the production reason. A property over them:
 *   installing succeeds exactly when no two names of one scope convert to one identifier, an alias rename drafts no DDL,
 *   and no collision is silent.
 * - Literals. Text harvested from the README, and the edge values of every carrier, each kept only when ir/expr.ts
 *   literalProblem admits it for the type it is drawn at.
 * - Parameter names. Names a page's own inputs and reserved-looking spellings use (pageSize, relation, cursor, names
 *   with a colon, names that differ only in case) and the identifier dictionary's names, each kept only when the
 *   checker's name validation (schema/protocol.ts isName) admits it, so a generated parameter can collide with them.
 *
 * Every entry names its feature, so a suite can require that each kind was drawn.
 */
export interface DeclaredName {
	readonly declared: string
	readonly feature: IdentifierFeature
}

const reservedWords = [
	"Select",
	"Order",
	"User",
	"Group",
	"Table",
	"From",
	"Where",
	"Check",
	"Default",
	"Limit"
] as const

/** A name of `segments` words `Segment` and a seven-letter `tail`: seven segments convert to exactly 63 bytes, eight to
 * 71. */
const longName = (segments: number, tail: string): string =>
	`${Str.repeat(segments)("Segment")}${tail}`

/** The candidate declared names, before the production conversion classifies them. */
const candidates: ReadonlyArray<DeclaredName> = [
	...Arr.map(
		["HTTPRoute", "HttpRoute", "Http_Route", "http_route", "HTTP_Route", "HttpRoute_"],
		(declared): DeclaredName => ({ declared, feature: "alias" })
	),
	...Arr.map(["Note", "_Note", "note", "NOTE"], (declared): DeclaredName => ({
		declared,
		feature: "alias"
	})),
	...Arr.map(
		[
			"Task2Note",
			"Task_2_Note",
			"task2note",
			"Task2note",
			"V2",
			"V_2",
			"Order10Item",
			"Order_10_Item"
		],
		(declared): DeclaredName => ({ declared, feature: "digit boundary" })
	),
	...Arr.map(["Charlie", "Foxtrot", "Uniform", "Juliett"], (tail): DeclaredName => ({
		declared: longName(7, tail),
		feature: "long, at the limit"
	})),
	...Arr.map(["Charlie", "Foxtrot"], (tail): DeclaredName => ({
		declared: longName(8, tail),
		feature: "long, past the limit"
	})),
	...Arr.map(reservedWords, (declared): DeclaredName => ({ declared, feature: "reserved word" })),
	...Arr.map(["Work", "Task", "Payroll", "LineItem", "A", "B1"], (declared): DeclaredName => ({
		declared,
		feature: "plain"
	})),
	...Arr.map(
		["__Private", "9Lives", "Café", "_", "Dash-Name", "Space Name"],
		(declared): DeclaredName => ({
			declared,
			feature: "plain"
		})
	)
]

export interface Admitted extends DeclaredName {
	/** Its conversion, its identifier wherever it names an object readable. */
	readonly converted: string
}

export interface Refused extends DeclaredName {
	/** The production conversion's reason. */
	readonly reason: string
}

const classified: ReadonlyArray<{
	readonly candidate: DeclaredName
	readonly parsed: ReturnType<typeof parseDeclaredName>
}> = Arr.map(candidates, (c) => ({
	candidate: c,
	parsed: parseDeclaredName(c.declared)
}))

/** The candidates the production conversion admits, with their conversions. */
export const admittedNames: ReadonlyArray<Admitted> = Arr.flatMap(
	classified,
	({ candidate, parsed }) =>
		parsed.ok ? [{ ...candidate, converted: conversionOf(parsed.value) }] : []
)

/** The candidates it refuses, with its reasons. */
export const refusedNames: ReadonlyArray<Refused> = Arr.flatMap(
	classified,
	({ candidate, parsed }) => (parsed.ok ? [] : [{ ...candidate, reason: parsed.error }])
)

/**
 * The admitted names grouped by their conversion: every group of two or more is a set of names one scope cannot hold
 * together.
 */
export const aliasGroups: ReadonlyArray<Arr.NonEmptyReadonlyArray<string>> = (() => {
	const groups = new Map<string, Array<string>>()
	for (const name of admittedNames) {
		const group = groups.get(name.converted)
		if (group === undefined) {
			groups.set(name.converted, [name.declared])
		} else {
			group.push(name.declared)
		}
	}
	return Arr.flatMap(
		[...groups.values()],
		(group): ReadonlyArray<Arr.NonEmptyReadonlyArray<string>> => {
			const [first, second, ...rest] = group
			return first === undefined || second === undefined ? [] : [[first, second, ...rest]]
		}
	)
})()

/** An admitted declared name of the dictionary. */
export const dictionaryNameGen: Gen<Admitted> = element(nonEmpty(admittedNames, "admitted name"))

/** The edge values of every carrier a literal can be. */
const edgeLiterals: ReadonlyArray<TypedLiteral> = [
	...Arr.map(
		[
			0n,
			1n,
			-1n,
			-32768n,
			32767n,
			-2147483648n,
			2147483647n,
			-9223372036854775808n,
			9223372036854775807n
		],
		(value): TypedLiteral => ({ kind: "int", value })
	),
	...Arr.map(
		[0, -0, 1.5, -1e-308, 5e-324, 3.4028234663852886e38, 1.7976931348623157e308, 0.1],
		(value): TypedLiteral => ({ kind: "float", value })
	),
	...Arr.map(["NaN", "Infinity", "-Infinity"] as const, (value): TypedLiteral => ({
		kind: "floatSpecial",
		value
	})),
	{ kind: "bool", value: false },
	{ kind: "bool", value: true },
	...Arr.map(
		["", " ", "a", "A", "ß", "İ", "é", "é", "😀", "%", "_", "\\", "'", '"', "\t", "NULL"],
		(value): TypedLiteral => ({ kind: "text", value })
	),
	...Arr.map(
		["00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"],
		(value): TypedLiteral => ({ kind: "uuid", value })
	),
	...Arr.map(
		[
			[0n, 1n],
			[-1n, 0n],
			[-2147483648n, 2147483647n],
			[-9223372036854775808n, 9223372036854775807n]
		],
		([start = 0n, end = 1n]): TypedLiteral => ({ kind: "span", start, end })
	)
]

/** A double-quoted string literal on one line, of at most 64 characters, an escape counting as one. */
const quotedString = regex('"(?:[^"\\\\\\n]|\\\\.){0,64}"', "g")

const decodeString = Schema.decodeOption(Schema.fromJsonString(Schema.String))

/**
 * The text a README harvests: the string literals of its examples, each value once, in the order the values first
 * appear. Every double-quoted literal of at most 64 characters on one line that decodes as JSON counts, so an escape
 * reads as what it stands for.
 */
export const readmeStrings = (readme: string): ReadonlyArray<string> =>
	Arr.dedupe(
		Arr.flatMap(Arr.fromIterable(Str.matchAll(quotedString)(readme)), (match) =>
			Option.toArray(decodeString(match[0]))
		)
	)

/**
 * The dictionary literals of a type: the edge values and the given harvested text, each kept when literalProblem
 * admits it at the type.
 */
export const literalDictionary = (
	type: ScalarType,
	harvested: ReadonlyArray<string>
): ReadonlyArray<TypedLiteral> =>
	Arr.filter(
		[...edgeLiterals, ...Arr.map(harvested, (value): TypedLiteral => ({ kind: "text", value }))],
		(literal) => literalProblem(literal, type) === undefined
	)

/**
 * The parameter-name dictionary: a page's own input names and reserved-looking spellings, then the identifier
 * dictionary's names, each once, kept when the checker's name validation admits it.
 */
export const parameterNames: ReadonlyArray<string> = Arr.filter(
	[
		...new Set([
			"ids",
			"pageSize",
			"page:limit",
			"page:size",
			"page:boundary:0",
			"relation",
			"cursor",
			"limit",
			"size",
			"page",
			"parentKeys",
			"Select",
			"select",
			"p",
			"P",
			...Arr.map([...admittedNames, ...refusedNames], (name) => name.declared)
		])
	],
	isName
)
