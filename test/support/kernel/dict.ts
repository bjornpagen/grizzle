import { element, type Gen, proportional } from "@grizzle/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Order, String as Str } from "effect"
import {
	conversionOf,
	maxIdentifierBytes,
	parseDeclaredName,
	parseSchemaName
} from "#compiler/core/identity.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { canonicalZero } from "#compiler/ir/carriers.ts"
import { type TypedLiteral, literalProblem } from "#compiler/ir/expr.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { isName } from "#compiler/schema/protocol.ts"
import { nonEmpty } from "#test/support/assert.ts"
import { catalogAlphabet, catalogTypeAlphabet } from "#test/support/kernel/catalog-alphabet.ts"

export type IdentifierFeature =
	| "alias"
	| "digit boundary"
	| "long, at the limit"
	| "long, past the limit"
	| "reserved word"
	| "catalog type"
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
 *   segment, names one segment past the limit, reserved words, names the rule refuses, and the catalog-type names:
 *   every type and function name of pg_catalog and the vector extension the pinned build holds (catalog-alphabet.ts),
 *   spelled as a declared name that converts to exactly that name, so a relation, a closed relation or a contract
 *   takes a name PostgreSQL's own types and functions hold. The naming door's rule
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

/**
 * A name of `segments` words `Segment` and a seven-letter `tail`: seven segments convert to the limit's bytes, eight past
 * it, as the name's feature, computed from its conversion's bytes (longFeature), says.
 */
const longName = (segments: number, tail: string): string =>
	`${Str.repeat(segments)("Segment")}${tail}`

/** A candidate before its feature is known: a long name's is its conversion's byte count's (longFeature). */
type Candidate = DeclaredName | { readonly declared: string; readonly feature: "long" }

/**
 * A long name's feature, read off its conversion's bytes: at the limit when they are maxIdentifierBytes, past it when
 * they are more, and plain when they are fewer.
 */
const longFeature = (declared: string): IdentifierFeature => {
	const bytes = utf8Length(conversionOf(declared))
	return bytes === maxIdentifierBytes.value
		? "long, at the limit"
		: bytes > maxIdentifierBytes.value
			? "long, past the limit"
			: "plain"
}

/** A catalog name spelled as a declared name: each `_`-separated segment capitalized, `int4range` as `Int4range`. */
const declaredSpelling = (name: string): string =>
	Arr.join(
		Arr.map(Str.split(name, "_"), (segment) => Str.capitalize(segment)),
		""
	)

/**
 * The declared name of a catalog name: its declared spelling when the rule admits it and converts it back to exactly
 * that name, none when no declared name converts to it (`int4range` spells `Int4range`, which converts to
 * `int_4_range`).
 */
export const catalogDeclared = (name: string): string | undefined => {
	const declared = declaredSpelling(name)
	const parsed = parseDeclaredName(declared)
	return parsed.ok && conversionOf(parsed.value) === name ? declared : undefined
}

/** The catalog-type candidates: each catalog name a declared name converts to. */
const catalogCandidates: ReadonlyArray<DeclaredName> = Arr.flatMap(catalogAlphabet, (name) => {
	const declared = catalogDeclared(name)
	return declared === undefined ? [] : [{ declared, feature: "catalog type" as const }]
})

/** The candidate declared names, before the production conversion classifies them. */
const candidates: ReadonlyArray<Candidate> = [
	...catalogCandidates,
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
	...Arr.map(["Charlie", "Foxtrot", "Uniform", "Juliett"], (tail): Candidate => ({
		declared: longName(7, tail),
		feature: "long"
	})),
	...Arr.map(["Charlie", "Foxtrot"], (tail): Candidate => ({
		declared: longName(8, tail),
		feature: "long"
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

export interface RefusedName extends DeclaredName {
	/** The production conversion's reason. */
	readonly reason: string
}

const classified: ReadonlyArray<{
	readonly candidate: DeclaredName
	readonly parsed: ReturnType<typeof parseDeclaredName>
}> = Arr.map(candidates, (c) => ({
	candidate: c.feature === "long" ? { declared: c.declared, feature: longFeature(c.declared) } : c,
	parsed: parseDeclaredName(c.declared)
}))

/** The candidates the production conversion admits, with their conversions. */
export const admittedNames: ReadonlyArray<Admitted> = Arr.flatMap(
	classified,
	({ candidate, parsed }) =>
		parsed.ok ? [{ ...candidate, converted: conversionOf(parsed.value) }] : []
)

/** The candidates it refuses, with its reasons. */
export const refusedNames: ReadonlyArray<RefusedName> = Arr.flatMap(
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

/**
 * The admitted names by feature, each feature that admits a name once: a draw picks a feature first, so the many
 * catalog-type names are one kind among the others, never most of the draws.
 */
export const admittedByFeature: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<Admitted>> =
	nonEmpty(
		Arr.flatMap(Arr.dedupe(Arr.map(admittedNames, (n) => n.feature)), (feature) => {
			const group = Arr.filter(admittedNames, (n) => n.feature === feature)
			return Arr.isReadonlyArrayNonEmpty(group) ? [group] : []
		}),
		"admitted feature"
	)

/** How often a draw takes each identifier feature: a whole-number weight of every feature, zero for one never drawn. */
export type IdentifierWeights = { readonly [F in IdentifierFeature]: number }

/** Every feature as often as every other. */
const evenWeights: IdentifierWeights = {
	alias: 1,
	"digit boundary": 1,
	"long, at the limit": 1,
	"long, past the limit": 1,
	"reserved word": 1,
	"catalog type": 1,
	plain: 1
}

/**
 * An admitted declared name of `names`: its feature drawn by `weights` among the features `names` holds a name of, then
 * one of its names of that feature.
 */
export const weightedNameGen = (
	weights: IdentifierWeights,
	names: Arr.NonEmptyReadonlyArray<Admitted>
): Gen<Admitted> =>
	proportional(
		Arr.map(
			Arr.groupWith(
				Arr.sortWith(names, (n) => n.feature, Order.String),
				(a, b) => a.feature === b.feature
			),
			(group) => [weights[Arr.headNonEmpty(group).feature], element(group)] as const
		)
	)

/** An admitted declared name of the dictionary: its feature, each equally often, then a name of it. */
export const dictionaryNameGen: Gen<Admitted> = weightedNameGen(
	evenWeights,
	nonEmpty(admittedNames, "an admitted name")
)

/**
 * An admitted declared name of the dictionary that `excluded` does not hold, drawn as dictionaryNameGen draws one: the
 * finite pool is cut once, so no draw is retried or discarded.
 */
export const dictionaryNameGenOtherThan = (excluded: ReadonlySet<string>): Gen<Admitted> =>
	weightedNameGen(
		evenWeights,
		nonEmpty(
			Arr.filter(admittedNames, (n) => !excluded.has(n.declared)),
			"an admitted name outside the excluded ones"
		)
	)

/**
 * The admitted names a schema may take: every admitted name but those whose conversion starts with pg_, which
 * PostgreSQL reserves for its own schemas and roles (core/identity.ts parseSchemaName).
 */
export const admittedSchemaNames: Arr.NonEmptyReadonlyArray<Admitted> = nonEmpty(
	Arr.filter(admittedNames, (n) => parseSchemaName(n.declared).ok),
	"an admitted schema name"
)

/** An admitted declared name a schema may take, drawn as dictionaryNameGen draws one. */
export const schemaNameGen: Gen<Admitted> = weightedNameGen(evenWeights, admittedSchemaNames)

/** The catalog-type names' conversions: the identifiers a relation shares with a PostgreSQL type or function. */
export const catalogConversions: ReadonlySet<string> = new Set(
	Arr.flatMap(admittedNames, (n) => (n.feature === "catalog type" ? [n.converted] : []))
)

/**
 * The declared names of PostgreSQL's own types, each converting to a type name of the pinned build: what a relation's
 * row type, a closed relation's enum or a contract's domain shadows where the installation's schema comes first.
 */
export const catalogTypeNames: Arr.NonEmptyReadonlyArray<string> = nonEmpty(
	Arr.flatMap(catalogTypeAlphabet, (name) => {
		const declared = catalogDeclared(name)
		return declared === undefined ? [] : [declared]
	}),
	"a declared name of a catalog type"
)

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
		[0, 1.5, -1e-308, 5e-324, 3.4028234663852886e38, 1.7976931348623157e308, 0.1],
		(value): TypedLiteral => ({ kind: "float", value: canonicalZero(value) })
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

/**
 * The text a README harvests: the string literals of its examples, each value once, in the order the values first
 * appear. Every double-quoted literal of at most 64 characters on one line counts, read as the JSON string it spells,
 * so an escape reads as what it stands for.
 */
export const readmeStrings = (readme: string): ReadonlyArray<string> =>
	Arr.dedupe(
		Arr.map(Arr.fromIterable(Str.matchAll(quotedString)(readme)), (match) =>
			trustedJson<string>(match[0])
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
