/** What the properties of declared-names.test.ts read: its spaces, models and helpers. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import { characterOf, element, type Gen, int, string, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { maxIdentifierBytes } from "#compiler/core/identity.ts"
import { closed as dynamicClosed, relation as dynamicRelation } from "#compiler/public/dynamic.ts"
import { closedId, generated, int4 } from "#compiler/public/fields.ts"
import { closed, relation } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { contractParts } from "#compiler/scalar/contract.ts"
import { derivedBuilder } from "#compiler/schema/relation.ts"
import { schemaBuilder } from "#compiler/schema/schema.ts"

const lowercase = nonEmpty(Arr.fromIterable("abcdefghijklmnopqrstuvwxyz"), "lowercase letters")

const uppercase = nonEmpty(Arr.fromIterable("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "capital letters")

const digits = nonEmpty(Arr.fromIterable("0123456789"), "digits")

/** A segment as declared and as its conversion spells it. */
interface Segment {
	readonly declared: string
	readonly converted: string
}

/** A word: a capital and `length - 1` lowercase letters. */
const wordOf =
	(length: number): Gen<Segment> =>
	(source) => {
		const declared = `${source.draw(characterOf(uppercase))}${source.draw(string(characterOf(lowercase), { min: length - 1, max: length - 1 }))}`
		return { declared, converted: Str.toLowerCase(declared) }
	}

/** A run of two to four capitals, which a following word's capital ends. */
const acronym: Gen<Segment> = (source) => {
	const declared = source.draw(string(characterOf(uppercase), { min: 2, max: 4 }))
	return { declared, converted: Str.toLowerCase(declared) }
}

/** A run of one to three digits. */
const digitRun: Gen<Segment> = (source) => {
	const declared = source.draw(string(characterOf(digits), { min: 1, max: 3 }))
	return { declared, converted: declared }
}

type Kind = "word" | "acronym" | "digits"

/**
 * How a segment joins the one before it: an underscore always splits; with nothing between, the boundary rule must
 * split them, which it does unless both are digit runs or both acronyms, or an acronym runs into a digit-free acronym.
 */
const joined = (before: Kind, after: Kind, underscore: boolean): string =>
	underscore || (before === after && before !== "word") ? "_" : ""

/** A declared name of words, acronyms and digit runs whose conversion is `target` bytes, its first segment a word. */
export const nameOf =
	(target: number): Gen<{ readonly declared: string; readonly converted: string }> =>
	(source) => {
		const first = source.draw(wordOf(source.draw(int(2, 8))))
		let declared = first.declared
		const converted: Array<string> = [first.converted]
		let before: Kind = "word"
		const length = () => Arr.reduce(converted, converted.length - 1, (n, s) => n + s.length)
		while (target - length() > 12) {
			const kind = source.draw(element(["word", "acronym", "digits"] as const))
			const segment = source.draw(
				kind === "word" ? wordOf(source.draw(int(2, 8))) : kind === "acronym" ? acronym : digitRun
			)
			declared += `${joined(before, kind, source.draw(element([false, true] as const)))}${segment.declared}`
			converted.push(segment.converted)
			before = kind
		}
		const last = source.draw(wordOf(Math.max(2, target - length() - 1)))
		declared += `${joined(before, "word", source.draw(element([false, true] as const)))}${last.declared}`
		converted.push(last.converted)
		return { declared, converted: Arr.join(converted, "_") }
	}

/** A conversion's length around the limit: mostly within two bytes of it, sometimes well under or past. */
export const targetGen: Gen<number> = weighted<number>([
	[4, int(maxIdentifierBytes - 2, maxIdentifierBytes + 2)],
	[1, int(20, maxIdentifierBytes + 12)]
])

/** Where a conversion's bytes fall against the limit. */
export type ByteFeature = "under the limit" | "at the limit" | "one byte past" | "far past"

export type LimitFeature = ByteFeature | "two at the limit apart"

export const situationOf = (bytes: number): ByteFeature =>
	bytes < maxIdentifierBytes
		? "under the limit"
		: bytes === maxIdentifierBytes
			? "at the limit"
			: bytes === maxIdentifierBytes + 1
				? "one byte past"
				: "far past"

/** PostgreSQL 19's system columns, as src/backend/catalog/heap.c spells its SysAtt: every table and materialized view
 * holds them, and refuses a column declared under one (42701). */
export const pgSystemColumns = ["ctid", "xmin", "cmin", "xmax", "cmax", "tableoid"] as const

/** A field name as declared beside a system column, and its conversion. */
export interface FieldNamed {
	readonly declared: string
	readonly converted: string
}

/** Each spelling of a system column whose conversion is the column's own: lowercase, a capital first, all capitals. */
const systemSpellingGen: Gen<FieldNamed> = (source) => {
	const column = source.draw(element(pgSystemColumns))
	const declared = source.draw(element([column, Str.capitalize(column), Str.toUpperCase(column)]))
	return { declared, converted: column }
}

/** A name one step from a system column's whose conversion is another: a digit after it, a letter before it, or the
 * column cut in two segments. */
const nearSpellingGen: Gen<FieldNamed> = (source) => {
	const column = source.draw(element(pgSystemColumns))
	const digit = source.draw(characterOf(digits))
	const letter = source.draw(characterOf(lowercase))
	const cut = source.draw(int(1, column.length - 1))
	return source.draw(
		element([
			{ declared: `${column}${digit}`, converted: `${column}_${digit}` },
			{ declared: `${letter}${column}`, converted: `${letter}${column}` },
			{
				declared: `${Str.slice(0, cut)(column)}_${Str.slice(cut)(column)}`,
				converted: `${Str.slice(0, cut)(column)}_${Str.slice(cut)(column)}`
			}
		])
	)
}

/** A field name: a system column's spelled any way its conversion keeps, one a step from one, or any short name. */
export const fieldNamedGen: Gen<FieldNamed> = weighted<FieldNamed>([
	[2, systemSpellingGen],
	[2, nearSpellingGen],
	[1, nameOf(12)]
])

export type SystemColumnFeature = `${(typeof pgSystemColumns)[number]} refused` | "admitted"

/**
 * The builders that take a declared name for an object grizzle installs under its conversion, each by the callee a
 * caller writes: the box of the builder-boundary property.
 */
export const nameBuilders = [
	"relation",
	"relation.generated",
	"closed.ordered",
	"closed.unordered",
	"closed.relation",
	"derived",
	"schema",
	"schema.extend",
	"contract"
] as const

export type NameBuilder = (typeof nameBuilders)[number]

/** A case of the builder property: a builder, and a declared name with its conversion. */
export type BuilderCase = readonly [
	NameBuilder,
	{ readonly declared: string; readonly converted: string }
]

/** A builder and a name whose conversion is drawn around the limit (targetGen). */
export const builderCaseGen: Gen<BuilderCase> = (source) =>
	[source.draw(element(nameBuilders)), source.draw(nameOf(source.draw(targetGen)))] as const

/** `builder` with a name whose conversion is drawn from `bytes`: within the limit, or past it. */
const builderAt =
	(builder: NameBuilder, bytes: Gen<number>): Gen<BuilderCase> =>
	(source) =>
		[builder, source.draw(nameOf(source.draw(bytes)))] as const

/**
 * The builder property's aims: for each builder, a name within the limit (at most maxIdentifierBytes) and one past it,
 * so each builder's build and its refusal are reached, where a drawn case meets one builder's refusal in about one in
 * twenty-five.
 */
export const builderAims: ReadonlyArray<readonly [BuilderFeature, Gen<BuilderCase>]> = Arr.flatMap(
	nameBuilders,
	(builder) => [
		[
			`${builder} built`,
			builderAt(builder, int(maxIdentifierBytes - 12, maxIdentifierBytes))
		] as const,
		[
			`${builder} refused`,
			builderAt(builder, int(maxIdentifierBytes + 1, maxIdentifierBytes + 12))
		] as const
	]
)

/** Each builder building a name within the limit and refusing one past it, and where the name's bytes fall. */
export type BuilderFeature =
	| `${NameBuilder} built`
	| `${NameBuilder} refused`
	| Exclude<ByteFeature, "under the limit">
	| "a name within the limit whose conversion passes it"

/** The roster a closed relation's key is over, the relation a derived relation reads, and the level they are in. */
const Kind = closed.ordered("Kind", ["a", "b"])
const Item = relation("Item", { id: int4 }, ["id"])
const Level = schemaBuilder("Level", [Item], [], [])
const itemIds = queryOver(Level).rule((r: RuleValue) => {
	const { id } = varsOver(Item, "item")
	return r.match(Item, { id }).find({ id })
})

/**
 * `builder` called with `name`, a name typed `string` as a generator's is, and every other argument one it builds
 * over, so a name its builder admits builds.
 */
export const builtNamed = (builder: NameBuilder, name: string): unknown => {
	switch (builder) {
		case "relation":
			return dynamicRelation(name, { id: int4 }, ["id"])
		case "relation.generated":
			return dynamicRelation.generated(name, { id: int4, n: int4 }, ["id"], (r) => ({
				m: generated(int4, r.n)
			}))
		case "closed.ordered":
			return dynamicClosed.ordered(name, ["a", "b"])
		case "closed.unordered":
			return dynamicClosed.unordered(name, ["b", "a"])
		case "closed.relation":
			return dynamicClosed.relation(
				name,
				{ kind: closedId(Kind), w: int4 },
				["kind"],
				[{ kind: "a", w: 1 }]
			)
		case "derived":
			return derivedBuilder(name, itemIds, [])
		case "schema":
			return schemaBuilder(name, [Item], [], [])
		case "schema.extend":
			return schemaBuilder.extend([Level], name, [], [], [])
		case "contract":
			return contractParts(name, int4, [])
	}
}
