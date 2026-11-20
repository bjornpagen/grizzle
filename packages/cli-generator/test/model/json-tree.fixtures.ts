/** What the property of json-tree.test.ts reads: JSON trees in any key order, and a reference walk of them. */

import {
	aimed,
	type Aimed,
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	uniqueKeys
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record, String as Str } from "effect"
import { foldJson, isArray, isObject, type JsonFold, stringMember } from "#model/json-tree.ts"
import type { Json } from "#model/pointer.ts"

/** One case: a tree, the tokens a fold starts from, and a member name to read. */
export type TreeCase = Readonly<{ tree: Json; start: ReadonlyArray<string>; name: string }>

export type Feature =
	| "an object"
	| "an array"
	| "null"
	| "a string"
	| "a number or a boolean"
	| "an own string member read"
	| "a member that is no string"
	| "a prototype name"
	| "keys out of sorted order"
	| "a fold from a nonempty start"

const NAMES = ["name", "z", "a", "m", "y", "b", "__proto__", "constructor", "0"] as const

const leafGen: Gen<Json> = oneOf<Json>([
	constant(null),
	boolean,
	int(-3, 3),
	element(["x", "pets", ""])
])

const treeGen = (depth: number): Gen<Json> =>
	depth === 0
		? leafGen
		: oneOf<Json>([
				leafGen,
				(s) => s.draw(array(treeGen(depth - 1), { min: 0, max: 3 })),
				(s) =>
					Record.fromEntries(
						Arr.map(
							s.draw(uniqueKeys(element(NAMES), { min: 0, max: 4 })),
							(key) => [key, s.draw(treeGen(depth - 1))] as const
						)
					)
			])

const caseGen =
	(tree: Gen<Json>): Gen<TreeCase> =>
	(s) => ({
		tree: s.draw(tree),
		start: s.draw(array(element(["root", "0", "a/b"]), { min: 0, max: 2 })),
		name: s.draw(element(NAMES))
	})

/** Whether a node is an object: neither null, a scalar nor an array. */
const isMembers = (node: Json): node is Readonly<Record<string, Json>> =>
	typeof node === "object" && node !== null && !Arr.isArray(node)

/** Whether a node is an array. */
const isItems = (node: Json): node is ReadonlyArray<Json> => Arr.isArray(node)

/** A fold that records each node as `<kind> <tokens>` and each member's key, in the order the fold returns them. */
const recording: JsonFold<ReadonlyArray<string>> = {
	array: (items, tokens) => [...Arr.flatten(items), `array /${Arr.join(tokens, "/")}`],
	leaf: (value, tokens) => [`leaf /${Arr.join(tokens, "/")} ${String(value)}`],
	object: (members, tokens) => [
		...Arr.flatMap(members, ({ folded, key, value }) => [
			`key ${key} ${isMembers(value) ? "object" : isItems(value) ? "array" : "leaf"}`,
			...folded
		]),
		`object /${Arr.join(tokens, "/")}`
	]
}

/** The reference walk: children first, items by index, members in insertion order, each beneath its parent's tokens. */
const walk = (node: Json, tokens: ReadonlyArray<string>): ReadonlyArray<string> => {
	if (isItems(node)) {
		return [
			...Arr.flatMap(node, (item, index) => walk(item, [...tokens, `${index}`])),
			`array /${Arr.join(tokens, "/")}`
		]
	}
	if (isMembers(node)) {
		return [
			...Arr.flatMap(Record.toEntries(node), ([key, value]) => [
				`key ${key} ${isMembers(value) ? "object" : isItems(value) ? "array" : "leaf"}`,
				...walk(value, [...tokens, key])
			]),
			`object /${Arr.join(tokens, "/")}`
		]
	}
	return [`leaf /${Arr.join(tokens, "/")} ${String(node)}`]
}

/** What the module answers for a case: its kind tests, its member read and its fold. */
export type Answer = Readonly<{
	object: boolean
	array: boolean
	member: Option.Option<string>
	folded: ReadonlyArray<string>
}>

export const actualOf = (c: TreeCase): Answer => ({
	object: isObject(c.tree),
	array: isArray(c.tree),
	member: Option.fromUndefinedOr(stringMember(c.tree, c.name)),
	folded: foldJson(c.tree, recording, c.start)
})

export const expectedOf = (c: TreeCase): Answer => ({
	object: isMembers(c.tree),
	array: isItems(c.tree),
	member: isMembers(c.tree)
		? Option.filter(
				Record.get(c.tree, c.name),
				(value): value is string => typeof value === "string"
			)
		: Option.none(),
	folded: walk(c.tree, c.start)
})

export const featuresOf = (c: TreeCase): ReadonlyArray<Feature> => {
	const when = (holds: boolean, feature: Feature): ReadonlyArray<Feature> =>
		holds ? [feature] : []
	const keys = isMembers(c.tree) ? Record.keys(c.tree) : []
	const member = expectedOf(c).member
	return [
		...when(isMembers(c.tree), "an object"),
		...when(isItems(c.tree), "an array"),
		...when(c.tree === null, "null"),
		...when(typeof c.tree === "string", "a string"),
		...when(typeof c.tree === "number" || typeof c.tree === "boolean", "a number or a boolean"),
		...when(Option.isSome(member), "an own string member read"),
		...when(Arr.contains(keys, c.name) && Option.isNone(member), "a member that is no string"),
		...when(
			(c.name === "__proto__" || c.name === "constructor") && isMembers(c.tree),
			"a prototype name"
		),
		...when(
			Arr.some(keys, (key, index) =>
				Option.exists(Arr.get(keys, index + 1), (next) => Str.localeCompare(next)(key) < 0)
			),
			"keys out of sorted order"
		),
		...when(Arr.isReadonlyArrayNonEmpty(c.start), "a fold from a nonempty start")
	]
}

const objectOf = (entries: ReadonlyArray<readonly [string, Json]>): Json =>
	Record.fromEntries(entries)

/** Trees, aimed at each kind, member reads, prototype names, unsorted keys and a nonempty start. */
export const treeSpace: Aimed<TreeCase, Feature> = aimed(caseGen(treeGen(3)), [
	["an object", caseGen(map(treeGen(2), (tree) => objectOf([["a", tree]])))],
	["an array", caseGen(map(treeGen(2), (tree) => [tree, 1]))],
	["null", caseGen(constant(null))],
	["a string", caseGen(element(["x", "name"]))],
	["a number or a boolean", caseGen(oneOf<Json>([int(-3, 3), boolean]))],
	[
		"an own string member read",
		(s) => ({ ...s.draw(caseGen(constant(objectOf([["name", "pets"]])))), name: "name" })
	],
	[
		"a member that is no string",
		(s) => ({ ...s.draw(caseGen(constant(objectOf([["name", 1]])))), name: "name" })
	],
	[
		"a prototype name",
		(s) => ({
			...s.draw(caseGen(constant(objectOf([["a", 1]])))),
			name: s.draw(element(["__proto__", "constructor"]))
		})
	],
	[
		"keys out of sorted order",
		caseGen(
			map(treeGen(1), (tree) =>
				objectOf([
					["z", 1],
					[
						"a",
						[
							true,
							objectOf([
								["y", null],
								["b", "x"]
							])
						]
					],
					["m", tree]
				])
			)
		)
	],
	[
		"a fold from a nonempty start",
		(s) => ({ ...s.draw(caseGen(treeGen(2))), start: ["root", "0"] })
	]
])
