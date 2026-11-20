/** What the properties of yaml.test.ts read: drawn YAML documents, their planted hazards, and what loading them gives. */

import {
	type Aimed,
	aimed,
	array,
	boolean,
	characterOf,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	recursive,
	string,
	uniqueArray,
	weighted
} from "@bjornpagen/testing/gen"
import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	Formatter,
	Option,
	Record,
	Result,
	String as Str
} from "effect"
import { loadBytes, type LoadOptions } from "#load/index.ts"
import { DocumentUri } from "#model/brands.ts"
import { evaluateTokensResult, type Json } from "#model/pointer.ts"

const options: LoadOptions = { document: DocumentUri.make("file:///spec.yaml") }

const encoder = new TextEncoder()

/** A byte order mark, which the loader skips and counts in every byte offset after it. */
const BOM: ReadonlyArray<number> = [0xef, 0xbb, 0xbf]

/** Text a drawn string holds: plain, wide, astral, quotes, escapes, controls and YAML's own indicators. */
const CHARS: Arr.NonEmptyReadonlyArray<string> = [
	"a",
	"Z",
	" ",
	"é",
	"€",
	"😀",
	'"',
	"'",
	"\\",
	"\n",
	"\t",
	"\u0001",
	":",
	"#",
	"-",
	"&",
	"*",
	"!",
	"[",
	"{"
]

/**
 * Words YAML 1.1 read as booleans, merges, dates or numbers that the strict loader's YAML 1.2 core schema keeps as
 * strings when written plain as a value.
 */
const PLAIN_VALUES: Arr.NonEmptyReadonlyArray<string> = [
	"yes",
	"no",
	"on",
	"off",
	"y",
	"n",
	"=",
	"2001-12-14",
	"2001-12-14t21:59:43.10-05:00"
]

/**
 * Keys written plain that YAML would read as another type or a merge, which string keys keep as the text written: a
 * hexadecimal number, null, a boolean, a status code, the merge key and `__proto__` (an own key, never a prototype).
 */
const PLAIN_KEYS: Arr.NonEmptyReadonlyArray<string> = [
	"0x1F",
	"null",
	"true",
	"200",
	"<<",
	"__proto__",
	"yes",
	"2001-12-14"
]

/** A string as a YAML document writes it: double-quoted with JSON's escapes, or plain when it is a plain word. */
type Text = Readonly<{ text: string; plain: boolean }>

const quoted: Gen<Text> = map(string(characterOf(CHARS), { min: 0, max: 6 }), (text) => ({
	text,
	plain: false
}))

const plainValue: Gen<Text> = map(element(PLAIN_VALUES), (text) => ({ text, plain: true }))

const plainKey: Gen<Text> = map(element(PLAIN_KEYS), (text) => ({ text, plain: true }))

/** A key's text: drawn text, or one of the plain keys. */
const keyString: Gen<string> = weighted([
	[3, map(quoted, (key) => key.text)],
	[1, map(plainKey, (key) => key.text)]
])

/** A key as written: plain when it is one of the plain keys, double-quoted otherwise, so one text is one key. */
const keyOfText = (text: string): Text => ({ text, plain: Arr.contains(PLAIN_KEYS, text) })

/** A drawn YAML node: a scalar, a sequence, a mapping, an anchor on a node, or an alias to an earlier anchor. */
export type Node =
	| Readonly<{ kind: "null" }>
	| Readonly<{ kind: "boolean"; value: boolean }>
	| Readonly<{ kind: "number"; value: number }>
	| Readonly<{ kind: "string"; value: Text }>
	| Readonly<{ kind: "flow"; depth: number }>
	| Readonly<{ kind: "seq"; items: ReadonlyArray<Node> }>
	| Readonly<{ kind: "map"; entries: ReadonlyArray<readonly [Text, Node]> }>

const scalarNode: Gen<Node> = oneOf<Node>([
	constant<Node>({ kind: "null" }),
	map(boolean, (value): Node => ({ kind: "boolean", value })),
	map(int(-1000, 1000), (value): Node => ({ kind: "number", value })),
	map(int(-1000, 1000), (value): Node => ({ kind: "number", value: value / 8 })),
	map(
		weighted([
			[3, quoted],
			[1, plainValue]
		]),
		(value): Node => ({ kind: "string", value })
	)
])

/** A flow sequence nested `depth` deep, past any depth a recursive walk keeps on its stack cheaply. */
const flowNode: Gen<Node> = map(int(1, 300), (depth): Node => ({ kind: "flow", depth }))

/** Entries under keys whose text is unique, so no two of them are one key once loaded. */
const entriesOf = (
	inner: Gen<Node>,
	size: Readonly<{ min: number; max: number }>
): Gen<ReadonlyArray<readonly [Text, Node]>> =>
	uniqueArray(keyString, (key) => map(inner, (node) => [keyOfText(key), node] as const), size)

const nodeGen: Gen<Node> = recursive<Node>(
	weighted([
		[8, scalarNode],
		[1, flowNode]
	]),
	(inner) =>
		oneOf<Node>([
			map(array(inner, { min: 0, max: 4 }), (items): Node => ({ kind: "seq", items })),
			map(entriesOf(inner, { min: 0, max: 4 }), (entries): Node => ({ kind: "map", entries }))
		]),
	3
)

/** A flow sequence `depth` deep as JSON: the empty sequence inside `depth - 1` others. */
const nestedOf = (depth: number): Json => {
	let inner: Json = []
	for (let level = 1; level < depth; level += 1) {
		inner = [inner]
	}
	return inner
}

/** The JSON value a node loads as. */
const valueOf = (node: Node): Json => {
	switch (node.kind) {
		case "null":
			return null
		case "boolean":
		case "number":
			return node.value
		case "string":
			return node.value.text
		case "flow":
			return nestedOf(node.depth)
		case "seq":
			return Arr.map(node.items, valueOf)
		case "map":
			return Record.fromEntries(
				Arr.map(node.entries, ([key, value]) => [key.text, valueOf(value)] as const)
			)
	}
}

const textOf = (text: Text): string => (text.plain ? text.text : Formatter.formatJson(text.text))

const pad = (indent: number): string => Str.repeat(indent)(" ")

/** A scalar's text as YAML writes it, or none for a collection, which takes lines of its own. */
const inline = (node: Node): Option.Option<string> => {
	switch (node.kind) {
		case "null":
			return Option.some("null")
		case "boolean":
			return Option.some(node.value ? "true" : "false")
		case "number":
			return Option.some(String(node.value))
		case "string":
			return Option.some(textOf(node.value))
		case "flow":
			return Option.some(`${Str.repeat(node.depth)("[")}${Str.repeat(node.depth)("]")}`)
		case "seq":
			return Arr.isReadonlyArrayEmpty(node.items) ? Option.some("[]") : Option.none()
		case "map":
			return Arr.isReadonlyArrayEmpty(node.entries) ? Option.some("{}") : Option.none()
	}
}

/** A node's block lines at `indent`, each a line of the document. */
const blockLines = (node: Node, indent: number): ReadonlyArray<string> => {
	switch (node.kind) {
		case "seq":
			return Arr.flatMap(node.items, (item) =>
				Option.match(inline(item), {
					onSome: (text) => [`${pad(indent)}- ${text}`],
					onNone: () => [`${pad(indent)}-`, ...blockLines(item, indent + 2)]
				})
			)
		case "map":
			return Arr.flatMap(node.entries, ([key, value]) => entryLines(key, value, indent, ""))
		case "null":
		case "boolean":
		case "number":
		case "string":
		case "flow":
			return Option.match(inline(node), {
				onSome: (text) => [`${pad(indent)}${text}`],
				onNone: () => []
			})
	}
}

/** One mapping entry's lines: its key, the anchor it carries (if any), and its value inline or below it. */
const entryLines = (
	key: Text,
	value: Node,
	indent: number,
	anchor: string
): ReadonlyArray<string> =>
	Option.match(inline(value), {
		onSome: (text) => [`${pad(indent)}${textOf(key)}:${anchor} ${text}`],
		onNone: () => [`${pad(indent)}${textOf(key)}:${anchor}`, ...blockLines(value, indent + 2)]
	})

/**
 * A document: top-level entries, each a node; some of them anchored and read again by later entries' aliases; and
 * whether it starts with a byte order mark.
 */
export type YamlDocument = Readonly<{
	entries: ReadonlyArray<readonly [Text, Node]>
	aliases: ReadonlyArray<number>
	bom: boolean
}>

/** Documents of drawn entries, with `extra` entries after them, a few aliases and maybe a byte order mark. */
const documentsWith =
	(extra: Gen<ReadonlyArray<readonly [Text, Node]>>): Gen<YamlDocument> =>
	(s) => {
		const drawn = s.draw(entriesOf(nodeGen, { min: 1, max: 5 }))
		const added = s.draw(extra)
		const entries = [
			...Arr.filter(drawn, ([key]) => !Arr.some(added, ([other]) => other.text === key.text)),
			...added
		]
		return {
			entries,
			aliases: Arr.map(s.draw(array(int(0, 4), { min: 0, max: 3 })), (at) => at % entries.length),
			bom: s.draw(boolean)
		}
	}

const drawnDocuments: Gen<YamlDocument> = documentsWith(constant([]))

/** The merge key over a mapping of one to three entries, which a merging loader would fold into its parent. */
const mergeEntry: Gen<ReadonlyArray<readonly [Text, Node]>> = map(
	entriesOf(scalarNode, { min: 1, max: 3 }),
	(entries) => [
		[
			{ text: "<<", plain: true },
			{ kind: "map", entries }
		] as const
	]
)

/** Documents, aimed at the merge key over a mapping while it is pending. */
/** One entry under `key` holding `node`. */
const entryWith = (key: Text, node: Gen<Node>): Gen<ReadonlyArray<readonly [Text, Node]>> =>
	map(node, (value) => [[key, value] as const])

/** A document whose first entry is a collection, so an alias of it is an alias of a collection. */
const collectionAliased: Gen<YamlDocument> = (s) => {
	const doc = s.draw(
		documentsWith(
			entryWith(
				{ text: "anchored", plain: false },
				map(array(scalarNode, { min: 1, max: 3 }), (items): Node => ({ kind: "seq", items }))
			)
		)
	)
	const anchored = Arr.findFirstIndex(doc.entries, ([key]) => key.text === "anchored")
	return {
		...doc,
		aliases: Option.match(anchored, { onNone: () => doc.aliases, onSome: (at) => [at, at] })
	}
}

/** Documents, aimed at each pending situation by a document built to reach it. */
export const documents: Aimed<YamlDocument, ValueFeature> = aimed(drawnDocuments, [
	[
		"a plain word YAML 1.1 reads as another type",
		documentsWith(
			entryWith(
				{ text: "word", plain: false },
				map(plainValue, (value): Node => ({ kind: "string", value }))
			)
		)
	],
	[
		"a plain key YAML reads as another type",
		documentsWith(entryWith({ text: "0x1F", plain: true }, scalarNode))
	],
	["the merge key over a mapping", documentsWith(mergeEntry)],
	[
		"a __proto__ key",
		documentsWith(
			entryWith(
				{ text: "__proto__", plain: true },
				map(entriesOf(scalarNode, { min: 1, max: 2 }), (entries): Node => ({
					kind: "map",
					entries
				}))
			)
		)
	],
	["an alias of a collection", collectionAliased],
	[
		"a flow sequence hundreds deep",
		documentsWith(
			entryWith(
				{ text: "deep", plain: false },
				map(int(100, 300), (depth): Node => ({ kind: "flow", depth }))
			)
		)
	],
	[
		"a block sequence",
		documentsWith(
			entryWith(
				{ text: "list", plain: false },
				map(array(scalarNode, { min: 1, max: 3 }), (items): Node => ({ kind: "seq", items }))
			)
		)
	],
	[
		"a nested mapping",
		documentsWith(
			entryWith(
				{ text: "nested", plain: false },
				map(entriesOf(scalarNode, { min: 1, max: 3 }), (entries): Node => ({
					kind: "map",
					entries
				}))
			)
		)
	],
	["a byte order mark", map(drawnDocuments, (doc): YamlDocument => ({ ...doc, bom: true }))]
])

/** An alias entry's key: one no drawn key can be, so it is never a duplicate. */
const aliasKey = (at: number, target: number): Text => ({
	text: `alias ${at} of ${target}`,
	plain: false
})

/** The document's text: its entries, each anchored as `&e<index>`, then one entry per alias, `*e<index>`. */
export const yamlOf = (doc: YamlDocument): string =>
	Arr.join(
		[
			...Arr.flatMap(doc.entries, ([key, value], at) => entryLines(key, value, 0, ` &e${at}`)),
			...Arr.map(doc.aliases, (target, at) => `${textOf(aliasKey(at, target))}: *e${target}`),
			""
		],
		"\n"
	)

/** The document's bytes: its text in UTF-8, after a byte order mark when it has one. */
export const bytesOf = (doc: YamlDocument, text: string): Uint8Array =>
	Uint8Array.from([...(doc.bom ? BOM : []), ...encoder.encode(text)])

/** The value the document loads as: its entries' values, and each alias's its anchor's. */
export const expectedValue = (doc: YamlDocument): Json =>
	Record.fromEntries([
		...Arr.map(doc.entries, ([key, value]) => [key.text, valueOf(value)] as const),
		...Arr.map(
			doc.aliases,
			(target, at) =>
				[
					aliasKey(at, target).text,
					Option.match(Arr.get(doc.entries, target), {
						onNone: (): Json => null,
						onSome: ([, value]) => valueOf(value)
					})
				] as const
		)
	])

/** What loading the document gives: its value, or the code it was refused with. */
export const loaded = (bytes: Uint8Array) =>
	Effect.map(Effect.exit(loadBytes(bytes, options)), (exit) =>
		Exit.match(exit, {
			onSuccess: (doc) => Option.some(doc.value),
			onFailure: () => Option.none()
		})
	)

/**
 * Whether every alias of a collection loaded as its anchor's own value, the very object, never a copy: an alias bomb is
 * as many references to one value.
 */
export const aliasesShared = (doc: YamlDocument, value: Json): boolean =>
	Arr.every(doc.aliases, (target, at) => {
		const anchor = Arr.get(doc.entries, target)
		const own = Option.flatMap(anchor, ([key]) => fieldOf(value, key.text))
		const alias = fieldOf(value, aliasKey(at, target).text)
		return Option.match(Option.all([own, alias]), {
			onNone: () => false,
			onSome: ([left, right]) => (typeof left === "object" && left !== null ? left === right : true)
		})
	})

/** A top-level member of a loaded value, through own members only. */
const fieldOf = (value: Json, key: string): Option.Option<Json> =>
	Result.getSuccess(evaluateTokensResult(value, [key]))

export type ValueFeature =
	| "a plain word YAML 1.1 reads as another type"
	| "a plain key YAML reads as another type"
	| "the merge key over a mapping"
	| "a __proto__ key"
	| "an alias of a collection"
	| "a flow sequence hundreds deep"
	| "a block sequence"
	| "a nested mapping"
	| "a byte order mark"

const nodesOf = (node: Node): ReadonlyArray<Node> => {
	switch (node.kind) {
		case "seq":
			return [node, ...Arr.flatMap(node.items, nodesOf)]
		case "map":
			return [node, ...Arr.flatMap(node.entries, ([, value]) => nodesOf(value))]
		case "null":
		case "boolean":
		case "number":
		case "string":
		case "flow":
			return [node]
	}
}

const pairsOf = (node: Node): ReadonlyArray<readonly [Text, Node]> =>
	node.kind === "map" ? node.entries : []

export const valueFeatures = (doc: YamlDocument): ReadonlyArray<ValueFeature> => {
	const nodes = Arr.flatMap(doc.entries, ([, value]) => nodesOf(value))
	const pairs = [...doc.entries, ...Arr.flatMap(nodes, pairsOf)]
	const keys = Arr.map(pairs, ([key]) => key)
	const when = (holds: boolean, feature: ValueFeature): ReadonlyArray<ValueFeature> =>
		holds ? [feature] : []
	return [
		...when(
			Arr.some(nodes, (node) => node.kind === "string" && node.value.plain),
			"a plain word YAML 1.1 reads as another type"
		),
		...when(
			Arr.some(keys, (key) => key.plain && key.text !== "<<" && key.text !== "__proto__"),
			"a plain key YAML reads as another type"
		),
		...when(
			Arr.some(
				pairs,
				([key, value]) =>
					key.text === "<<" && value.kind === "map" && Arr.isReadonlyArrayNonEmpty(value.entries)
			),
			"the merge key over a mapping"
		),
		...when(
			Arr.some(keys, (key) => key.text === "__proto__"),
			"a __proto__ key"
		),
		...when(
			Arr.some(doc.aliases, (target) =>
				Option.exists(Arr.get(doc.entries, target), ([, value]) => Option.isNone(inline(value)))
			),
			"an alias of a collection"
		),
		...when(
			Arr.some(nodes, (node) => node.kind === "flow" && node.depth >= 100),
			"a flow sequence hundreds deep"
		),
		...when(
			Arr.some(nodes, (node) => node.kind === "seq" && Arr.isReadonlyArrayNonEmpty(node.items)),
			"a block sequence"
		),
		...when(
			Arr.some(nodes, (node) => node.kind === "map" && Arr.isReadonlyArrayNonEmpty(node.entries)),
			"a nested mapping"
		),
		...when(doc.bom, "a byte order mark")
	]
}

/** A hazard planted after a document's entries, each a thing strict YAML refuses. */
export type Hazard =
	| Readonly<{ kind: "duplicate key" }>
	| Readonly<{ kind: "second document" }>
	| Readonly<{ kind: "alias cycle" }>
	| Readonly<{ kind: "sequence as a key" }>
	| Readonly<{ kind: "mapping as a key" }>
	| Readonly<{ kind: "tag"; tag: "!!timestamp 2001-12-14" | "!!binary R0lGODlh" | "!custom value" }>
	| Readonly<{ kind: "non-finite"; text: ".inf" | "-.inf" | ".nan" | ".NaN" | ".Inf" }>
	| Readonly<{ kind: "unclosed flow" }>
	| Readonly<{ kind: "unclosed nesting"; depth: number }>
	| Readonly<{ kind: "empty stream" }>

const hazardGen: Gen<Hazard> = oneOf<Hazard>([
	constant<Hazard>({ kind: "duplicate key" }),
	constant<Hazard>({ kind: "second document" }),
	constant<Hazard>({ kind: "alias cycle" }),
	constant<Hazard>({ kind: "sequence as a key" }),
	constant<Hazard>({ kind: "mapping as a key" }),
	map(
		element<"!!timestamp 2001-12-14" | "!!binary R0lGODlh" | "!custom value">([
			"!!timestamp 2001-12-14",
			"!!binary R0lGODlh",
			"!custom value"
		]),
		(tag): Hazard => ({ kind: "tag", tag })
	),
	map(
		element<".inf" | "-.inf" | ".nan" | ".NaN" | ".Inf">([".inf", "-.inf", ".nan", ".NaN", ".Inf"]),
		(text): Hazard => ({
			kind: "non-finite",
			text
		})
	),
	constant<Hazard>({ kind: "unclosed flow" }),
	map(int(2000, 5000), (depth): Hazard => ({ kind: "unclosed nesting", depth })),
	constant<Hazard>({ kind: "empty stream" })
])

/** A document with one hazard planted after its entries. */
export type Planted = Readonly<{ doc: YamlDocument; hazard: Hazard }>

/** A document of no aliases with a hazard `hazards` draws, opened with a byte order mark as `boms` draws. */
const plantedOf =
	(
		hazards: Gen<Hazard>,
		boms: Gen<boolean>,
		extra: ReadonlyArray<readonly [Text, Node]>
	): Gen<Planted> =>
	(s) => {
		const doc = s.draw(drawnDocuments)
		return {
			doc: { entries: [...doc.entries, ...extra], aliases: [], bom: s.draw(boms) },
			hazard: s.draw(hazards)
		}
	}

/** A located hazard: a repeated key, or a non-finite number. */
const locatedHazard: Gen<Hazard> = oneOf<Hazard>([
	constant<Hazard>({ kind: "duplicate key" }),
	map(element<".inf" | "-.inf" | ".Inf">([".inf", "-.inf", ".Inf"]), (text): Hazard => ({
		kind: "non-finite",
		text
	}))
])

/** An entry whose key and value hold characters of two, three and four UTF-8 bytes. */
const wideEntry: readonly [Text, Node] = [
	{ text: "a wide key: é€😀", plain: false },
	{ kind: "string", value: { text: "€😀é", plain: false } }
]

/** Documents with one planted hazard, aimed at each pending situation by a plant built to reach it. */
export const planted: Aimed<Planted, HazardFeature> = aimed(plantedOf(hazardGen, boolean, []), [
	["a duplicate key", plantedOf(constant<Hazard>({ kind: "duplicate key" }), boolean, [])],
	["a second document", plantedOf(constant<Hazard>({ kind: "second document" }), boolean, [])],
	["an alias cycle", plantedOf(constant<Hazard>({ kind: "alias cycle" }), boolean, [])],
	["a sequence as a key", plantedOf(constant<Hazard>({ kind: "sequence as a key" }), boolean, [])],
	["a mapping as a key", plantedOf(constant<Hazard>({ kind: "mapping as a key" }), boolean, [])],
	[
		"a timestamp tag",
		plantedOf(constant<Hazard>({ kind: "tag", tag: "!!timestamp 2001-12-14" }), boolean, [])
	],
	[
		"a binary tag",
		plantedOf(constant<Hazard>({ kind: "tag", tag: "!!binary R0lGODlh" }), boolean, [])
	],
	["a custom tag", plantedOf(constant<Hazard>({ kind: "tag", tag: "!custom value" }), boolean, [])],
	["an infinity", plantedOf(constant<Hazard>({ kind: "non-finite", text: ".inf" }), boolean, [])],
	[
		"a NaN",
		plantedOf(
			map(element<".nan" | ".NaN">([".nan", ".NaN"]), (text): Hazard => ({
				kind: "non-finite",
				text
			})),
			boolean,
			[]
		)
	],
	["an unclosed flow", plantedOf(constant<Hazard>({ kind: "unclosed flow" }), boolean, [])],
	[
		"an unclosed nesting thousands deep",
		plantedOf(
			map(int(2000, 5000), (depth): Hazard => ({ kind: "unclosed nesting", depth })),
			boolean,
			[]
		)
	],
	["an empty stream", plantedOf(constant<Hazard>({ kind: "empty stream" }), boolean, [])],
	["a byte order mark before the hazard", plantedOf(locatedHazard, constant(true), [])],
	["a wide character before the hazard", plantedOf(locatedHazard, boolean, [wideEntry])]
])

/** The lines a hazard adds after the document's own. */
const hazardLines = (doc: YamlDocument, hazard: Hazard): ReadonlyArray<string> => {
	switch (hazard.kind) {
		case "duplicate key":
			return Option.match(Arr.head(doc.entries), {
				onNone: () => [],
				onSome: ([key]) => [`${textOf(key)}: 1`]
			})
		case "second document":
			return ["---", "second: 2"]
		case "alias cycle":
			return ["cycle: &cycle", "  y: *cycle"]
		case "sequence as a key":
			return ["[0, 1]: v"]
		case "mapping as a key":
			return ["? { a: 1 }", ": v"]
		case "tag":
			return [`tagged: ${hazard.tag}`]
		case "non-finite":
			return [`infinite: ${hazard.text}`]
		case "unclosed flow":
			return ["unclosed: [1, 2", "after: {"]
		case "unclosed nesting":
			return [`deep: ${Str.repeat(hazard.depth)("[")}`]
		case "empty stream":
			return []
	}
}

/** The planted document's text: no text at all for an empty stream. */
export const plantedText = (plant: Planted): string =>
	plant.hazard.kind === "empty stream"
		? ""
		: Arr.join(
				[
					...Arr.flatMap(plant.doc.entries, ([key, value], at) =>
						entryLines(key, value, 0, ` &e${at}`)
					),
					...hazardLines(plant.doc, plant.hazard),
					""
				],
				"\n"
			)

/** Where a refusal points: its code, and its pointer, line, column and byte offset where the planter knows them. */
export type Refused = Readonly<{
	code: string
	pointer: Option.Option<string>
	line: Option.Option<number>
	column: Option.Option<number>
	offset: Option.Option<number>
}>

/** The 1-based line the hazard's first line takes: one after every line the entries take. */
const hazardLine = (plant: Planted): number =>
	Arr.flatMap(plant.doc.entries, ([key, value], at) => entryLines(key, value, 0, ` &e${at}`))
		.length + 1

/** The input byte offset of the hazard's first line plus `column - 1` characters into it. */
const offsetAt = (plant: Planted, text: string, column: number): number => {
	const lines = Str.split("\n")(text)
	const before = Arr.join(Arr.take(lines, hazardLine(plant) - 1), "\n")
	const lead = Arr.isReadonlyArrayEmpty(Arr.take(lines, hazardLine(plant) - 1)) ? "" : `${before}\n`
	const into = Str.slice(
		0,
		column - 1
	)(Option.getOrElse(Arr.get(lines, hazardLine(plant) - 1), () => ""))
	return (plant.doc.bom ? BOM.length : 0) + encoder.encode(`${lead}${into}`).length
}

/**
 * The refusal the specification gives each hazard: a repeated key at its key, at the key's line, column 1 and byte
 * offset; a second document; an alias inside its own anchor; a key that is no scalar; a tag JSON has no value for, at
 * the tagged value's pointer and line; a non-finite number at its pointer, line, column and byte offset; a flow left
 * open, a nesting thousands deep left open and an empty stream as invalid YAML.
 */
export const expectedRefusal = (plant: Planted, text: string): Refused => {
	const unknown = {
		pointer: Option.none(),
		line: Option.none(),
		column: Option.none(),
		offset: Option.none()
	}
	const line = hazardLine(plant)
	switch (plant.hazard.kind) {
		case "duplicate key":
			return {
				code: "DOC-14/duplicate-key",
				pointer: Option.none(),
				line: Option.some(line),
				column: Option.some(1),
				offset: Option.some(offsetAt(plant, text, 1))
			}
		case "second document":
			return { code: "DOC-14/yaml-multi-document", ...unknown }
		case "alias cycle":
			return { code: "DOC-14/yaml-alias-cycle", ...unknown, pointer: Option.some("/cycle/y") }
		case "sequence as a key":
		case "mapping as a key":
			return { code: "DOC-14/yaml-non-string-key", ...unknown }
		case "tag":
			return { code: "DOC-14/yaml-non-json-tag", ...unknown, line: Option.some(line) }
		case "non-finite": {
			const column = "infinite: ".length + 1
			return {
				code: "DOC-14/yaml-non-finite",
				pointer: Option.some("/infinite"),
				line: Option.some(line),
				column: Option.some(column),
				offset: Option.some(offsetAt(plant, text, column))
			}
		}
		case "unclosed flow":
		case "unclosed nesting":
		case "empty stream":
			return { code: "DOC-14/invalid-yaml", ...unknown }
	}
}

/** The refusal loading the bytes gives, read in the fields `expected` states; none when they loaded. */
export const actualRefusal = (bytes: Uint8Array, expected: Refused) =>
	Effect.map(Effect.exit(loadBytes(bytes, options)), (exit) =>
		Exit.match(exit, {
			onSuccess: (): Option.Option<Refused> => Option.none(),
			onFailure: (cause) =>
				Option.map(Cause.findErrorOption(cause), (refusal): Refused => ({
					code: refusal.diagnostic.code,
					pointer: Option.map(expected.pointer, () => String(refusal.diagnostic.pointer)),
					line: Option.flatMap(expected.line, () => Option.fromNullishOr(refusal.diagnostic.line)),
					column: Option.flatMap(expected.column, () =>
						Option.fromNullishOr(refusal.diagnostic.column)
					),
					offset: Option.flatMap(expected.offset, () => Option.fromNullishOr(refusal.offset))
				}))
		})
	)

export type HazardFeature =
	| "a duplicate key"
	| "a second document"
	| "an alias cycle"
	| "a sequence as a key"
	| "a mapping as a key"
	| "a timestamp tag"
	| "a binary tag"
	| "a custom tag"
	| "an infinity"
	| "a NaN"
	| "an unclosed flow"
	| "an unclosed nesting thousands deep"
	| "an empty stream"
	| "a byte order mark before the hazard"
	| "a wide character before the hazard"

export const hazardFeatures = (plant: Planted, text: string): ReadonlyArray<HazardFeature> => {
	const hazard = plant.hazard
	const own: HazardFeature = ((): HazardFeature => {
		switch (hazard.kind) {
			case "duplicate key":
				return "a duplicate key"
			case "second document":
				return "a second document"
			case "alias cycle":
				return "an alias cycle"
			case "sequence as a key":
				return "a sequence as a key"
			case "mapping as a key":
				return "a mapping as a key"
			case "tag":
				return hazard.tag === "!!timestamp 2001-12-14"
					? "a timestamp tag"
					: hazard.tag === "!!binary R0lGODlh"
						? "a binary tag"
						: "a custom tag"
			case "non-finite":
				return Str.includes("nan")(Str.toLowerCase(hazard.text)) ? "a NaN" : "an infinity"
			case "unclosed flow":
				return "an unclosed flow"
			case "unclosed nesting":
				return "an unclosed nesting thousands deep"
			case "empty stream":
				return "an empty stream"
		}
	})()
	const located = hazard.kind === "duplicate key" || hazard.kind === "non-finite"
	return [
		own,
		...(located && plant.doc.bom ? ["a byte order mark before the hazard" as const] : []),
		...(located && encoder.encode(text).length > text.length
			? ["a wide character before the hazard" as const]
			: [])
	]
}
