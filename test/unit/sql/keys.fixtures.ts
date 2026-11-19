/** What the property of keys.test.ts reads: its space of name pairs and the features of a case. */

import type { Reached } from "@bjornpagen/testing/features"
import { array, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { ObjectName } from "#compiler/sql/ast.ts"

/**
 * The characters a case's identifiers are written in: letters, an underscore, a dot, which a quoted PostgreSQL
 * identifier holds and a `<schema>.<name>` spelling cannot tell from its own separator, a control character and a
 * letter outside ASCII. None is a NUL, which no identifier holds.
 */
const characters = ["a", "b", ".", "_", "\u0001", "é"] as const

const identifier: Gen<string> = (source) =>
	Arr.join(source.draw(array(element(characters), { min: 1, max: 4 })), "")

/** Two names of schema objects, each with a column of the relation it names. */
export interface NamePair {
	readonly first: ObjectName
	readonly second: ObjectName
	readonly firstColumn: string
	readonly secondColumn: string
}

export type KeyFeature =
	| "one name twice"
	| "two names one dotted text spells"
	| "two names apart"
	| "one column of two names"
	| "two columns one joined text spells"

const nameGen: Gen<ObjectName> = (source) => ({
	schema: source.draw(identifier),
	name: source.draw(identifier)
})

/** Two names drawn apart, each with a column, the second's often the first's. */
const apartGen: Gen<NamePair> = (source) => {
	const firstColumn = source.draw(identifier)
	return {
		first: source.draw(nameGen),
		second: source.draw(nameGen),
		firstColumn,
		secondColumn: source.draw(
			weighted([
				[1, () => firstColumn],
				[1, identifier]
			])
		)
	}
}

/** One name twice, with one column or two. */
const sameGen: Gen<NamePair> = (source) => {
	const name = source.draw(nameGen)
	const firstColumn = source.draw(identifier)
	return {
		first: name,
		second: { ...name },
		firstColumn,
		secondColumn: source.draw(
			weighted([
				[1, () => firstColumn],
				[1, identifier]
			])
		)
	}
}

/** Two names one dotted text spells, `"p"."q.r"` and `"p.q"."r"`, with one column. */
const dottedGen: Gen<NamePair> = (source) => {
	const p = source.draw(identifier)
	const q = source.draw(identifier)
	const r = source.draw(identifier)
	const column = source.draw(identifier)
	return {
		first: { schema: p, name: `${q}.${r}` },
		second: { schema: `${p}.${q}`, name: r },
		firstColumn: column,
		secondColumn: column
	}
}

/** Two columns whose names and their relations' joined with nothing between spell one text: the column `y` of
 * `"p"."qx"` and the column `xy` of `"p"."q"`. */
const joinedGen: Gen<NamePair> = (source) => {
	const schema = source.draw(identifier)
	const q = source.draw(identifier)
	const x = source.draw(identifier)
	const y = source.draw(identifier)
	return {
		first: { schema, name: `${q}${x}` },
		second: { schema, name: q },
		firstColumn: y,
		secondColumn: `${x}${y}`
	}
}

export const pairGen: Gen<NamePair> = weighted([
	[2, apartGen],
	[1, sameGen],
	[1, dottedGen],
	[1, joinedGen]
])

export const keyAims: ReadonlyArray<readonly [Reached<KeyFeature>, Gen<NamePair>]> = [
	["one name twice", sameGen],
	["two names one dotted text spells", dottedGen],
	["two columns one joined text spells", joinedGen]
]

/** Whether two names are one: their schemas' identifiers and their own alike. */
export const sameName = (a: ObjectName, b: ObjectName): boolean =>
	a.schema === b.schema && a.name === b.name

/** The features of a case, read off the pair itself. */
export const keyFeatures = (pair: NamePair): ReadonlyArray<KeyFeature> => {
	const { first, second } = pair
	const one = sameName(first, second)
	return [
		...(one ? (["one name twice"] as const) : (["two names apart"] as const)),
		...(!one && `${first.schema}.${first.name}` === `${second.schema}.${second.name}`
			? (["two names one dotted text spells"] as const)
			: []),
		...(!one && pair.firstColumn === pair.secondColumn
			? (["one column of two names"] as const)
			: []),
		...(!one &&
		`${first.schema}\u0000${first.name}${pair.firstColumn}` ===
			`${second.schema}\u0000${second.name}${pair.secondColumn}`
			? (["two columns one joined text spells"] as const)
			: [])
	]
}
