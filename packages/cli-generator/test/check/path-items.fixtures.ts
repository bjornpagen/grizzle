/**
 * What the properties of path-items.test.ts read: documents whose Components Object sections hold drawn keys, and
 * documents whose `paths` hold drawn path items, inline or by reference, with what the specification says of each.
 */

import type { Json } from "@bjornpagen/grizzle-text/utf8"
import { word } from "@bjornpagen/testing/dictionary"
import {
	aimed,
	type Aimed,
	characterOf,
	constant,
	element,
	type Gen,
	string,
	uniqueArray,
	uniqueKeys
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, JsonPointer, Record as Rec, String as Str } from "effect"
import { pathItems } from "#check/path-items.ts"
import { checkStructure } from "#check/structure.ts"
import { fixedDocumentUri } from "#model/brands.ts"
import type { SpecLine } from "#model/spec-section.ts"
import { resolve } from "#resolve/index.ts"
import { type Holding, holdings } from "#test/check/path-items.dictionary.ts"
import { specLines } from "#test/model/spec-section.dictionary.ts"

const entry = fixedDocumentUri("file:///spec/openapi.json")

/** Each line the generator reads with its latest patch release. */
const VERSIONS: Readonly<Record<SpecLine, string>> = {
	"3.0": "3.0.4",
	"3.1": "3.1.2",
	"3.2": "3.2.0"
}

/** A document of `line` with `paths` and, when given, `components`. */
const documentOf = (
	line: SpecLine,
	paths: Readonly<Record<string, Json>>,
	components: Readonly<Record<string, Json>>
): Json => ({
	openapi: VERSIONS[line],
	info: { title: "t", version: "1" },
	paths,
	...(Rec.isEmptyReadonlyRecord(components) ? {} : { components })
})

/**
 * The Components Object's maps on each line, as each line's specification lists its fixed fields: OpenAPI 3.0.4's nine,
 * 3.1's with `pathItems` and 3.2's with `mediaTypes` too. Every one holds its keys to one grammar.
 */
const SECTIONS: Readonly<Record<SpecLine, ReadonlyArray<string>>> = {
	"3.0": [
		"schemas",
		"responses",
		"parameters",
		"examples",
		"requestBodies",
		"headers",
		"securitySchemes",
		"links",
		"callbacks"
	],
	"3.1": [
		"schemas",
		"responses",
		"parameters",
		"examples",
		"requestBodies",
		"headers",
		"securitySchemes",
		"links",
		"callbacks",
		"pathItems"
	],
	"3.2": [
		"schemas",
		"responses",
		"parameters",
		"examples",
		"requestBodies",
		"headers",
		"securitySchemes",
		"links",
		"callbacks",
		"pathItems",
		"mediaTypes"
	]
}

/** One document: its line, and the keys each of its Components Object maps holds. */
export type KeysCase = Readonly<{
	line: SpecLine
	sections: ReadonlyArray<readonly [section: string, keys: ReadonlyArray<string>]>
}>

/**
 * The characters keys are drawn from: the grammar's letters, digits, `.`, `-` and `_`, and outside it a space, `$`,
 * `/`, `~`, a letter outside ASCII and `+`, simplest first.
 */
const keyCharacter = characterOf(["a", "Z", "0", ".", "-", "_", " ", "$", "/", "~", "é", "+"])

const keyGen: Gen<string> = string(keyCharacter, { min: 0, max: 3 })

/** The keys of each map of a line's Components Object, up to two a map. */
const sectionsGen =
	(line: SpecLine): Gen<KeysCase["sections"]> =>
	(source) =>
		Arr.map(SECTIONS[line], (section) => [
			section,
			source.draw(uniqueKeys(keyGen, { min: 0, max: 2 }))
		])

const keysGen: Gen<KeysCase> = (source) => {
	const line = source.draw(word(specLines))
	return { line, sections: source.draw(sectionsGen(line)) }
}

/** A case of `line` whose map `section` holds `key` and every other map is drawn. */
const keyed =
	(line: Gen<SpecLine>, section: string, key: Gen<string>): Gen<KeysCase> =>
	(source) => {
		const drawn = source.draw(line)
		const placed = source.draw(key)
		return {
			line: drawn,
			sections: Arr.map(source.draw(sectionsGen(drawn)), ([name, keys]) =>
				name === section ? [name, Arr.dedupe([placed, ...keys])] : [name, keys]
			)
		}
	}

export type KeyFeature =
	| "a key the grammar admits"
	| "a key the grammar refuses"
	| "the empty key"
	| "a refused key under pathItems"
	| "a refused key under mediaTypes"

/** Whether a character is one the grammar `^[a-zA-Z0-9\.\-_]+$` admits. */
const isNameCharacter = (character: string): boolean =>
	(character >= "a" && character <= "z") ||
	(character >= "A" && character <= "Z") ||
	(character >= "0" && character <= "9") ||
	character === "." ||
	character === "-" ||
	character === "_"

/** Whether the specification's component-name grammar admits a key: one or more of its characters. */
const admitted = (key: string): boolean =>
	Str.isNonEmpty(key) && Arr.every(Str.split(key, ""), isNameCharacter)

/** The case's document: every map holds each of its keys, each naming an empty object. */
const keysDocument = (c: KeysCase) =>
	documentOf(
		c.line,
		{},
		Rec.fromEntries(
			Arr.map(c.sections, ([section, keys]) => [
				section,
				Rec.fromEntries(Arr.map(keys, (key) => [key, {}]))
			])
		)
	)

/** The keys of a case's map as the document holds them, in the document's member order. */
const keysAsHeld = (keys: ReadonlyArray<string>): ReadonlyArray<string> =>
	Rec.keys(Rec.fromEntries(Arr.map(keys, (key) => [key, {}])))

/** The features a case reaches. */
export const keyFeaturesOf = (c: KeysCase): ReadonlyArray<KeyFeature> => {
	const keys = Arr.flatMap(c.sections, ([, held]) => held)
	const refusedUnder = (section: string) =>
		Arr.some(c.sections, ([name, held]) => name === section && !Arr.every(held, admitted))
	const facts: ReadonlyArray<readonly [boolean, KeyFeature]> = [
		[Arr.some(keys, admitted), "a key the grammar admits"],
		[!Arr.every(keys, admitted), "a key the grammar refuses"],
		[Arr.contains(keys, ""), "the empty key"],
		[refusedUnder("pathItems"), "a refused key under pathItems"],
		[refusedUnder("mediaTypes"), "a refused key under mediaTypes"]
	]
	return Arr.map(
		Arr.filter(facts, ([holds]) => holds),
		([, feature]) => feature
	)
}

/** Keys of every map, aimed at an admitted key, a refused one, the empty key and refusals in the later lines' maps. */
export const keysSpace: Aimed<KeysCase, KeyFeature> = aimed(keysGen, [
	["a key the grammar admits", keyed(word(specLines), "schemas", constant("Pet.v1-x_y"))],
	["a key the grammar refuses", keyed(word(specLines), "schemas", constant("bad key"))],
	["the empty key", keyed(word(specLines), "responses", constant(""))],
	["a refused key under pathItems", keyed(element(["3.1", "3.2"]), "pathItems", constant("a/b"))],
	["a refused key under mediaTypes", keyed(constant("3.2"), "mediaTypes", constant("$x"))]
])

/** A diagnostic as the property compares it: its code, its pointer and its message. */
type Stated = Readonly<{ code: string; pointer: string; message: string }>

/** The structure check's diagnostics on a case's document. */
export const keyDiagnosticsOf = (c: KeysCase) =>
	resolve({ document: entry, line: c.line, value: keysDocument(c) }).pipe(
		Effect.flatMap(checkStructure),
		Effect.map((diagnostics): ReadonlyArray<Stated> =>
			Arr.map(diagnostics, (diagnostic) => ({
				code: diagnostic.code,
				pointer: diagnostic.pointer,
				message: diagnostic.message
			}))
		)
	)

/**
 * What the specification says of the case: every key of a map outside the grammar `^[a-zA-Z0-9\.\-_]+$` is refused
 * as CMP-13 at its own pointer, with a message naming the grammar, map by map in the line's order and key by key in the
 * document's; the rest of the document holds nothing the structure check refuses.
 */
export const expectedKeyDiagnostics = (c: KeysCase): ReadonlyArray<Stated> =>
	Arr.flatMap(c.sections, ([section, keys]) =>
		Arr.map(
			Arr.filter(keysAsHeld(keys), (key) => !admitted(key)),
			(key): Stated => ({
				code: "CMP-13/invalid-key",
				pointer: `/components/${section}/${JsonPointer.escapeToken(key)}`,
				message: "A component key is outside ^[a-zA-Z0-9.\\-_]+$."
			})
		)
	)

/** One `paths` entry: its key and how it holds its item. */
type PathEntry = Readonly<{ key: string; holding: Holding }>

/** One document: its line, and its `paths` entries in order. */
export type ItemsCase = Readonly<{ line: SpecLine; entries: ReadonlyArray<PathEntry> }>

/** A path key: `/` and up to three characters, among them `/` and `~`, which a JSON pointer escapes. */
const pathKeyGen: Gen<string> = (source) =>
	`/${source.draw(string(characterOf(["a", "b", "/", "~"]), { min: 0, max: 3 }))}`

/** How an entry of `line` holds its item: inline on 3.0, whose Components Object holds no path items. */
const holdingGen = (line: SpecLine): Gen<Holding> =>
	line === "3.0" ? constant("inline") : word(holdings)

const itemsGen =
	(line: Gen<SpecLine>, holding: (line: SpecLine) => Gen<Holding>): Gen<ItemsCase> =>
	(source) => {
		const drawn = source.draw(line)
		return {
			line: drawn,
			entries: source.draw(
				uniqueArray(
					pathKeyGen,
					(key) =>
						(entrySource): PathEntry => ({ key, holding: entrySource.draw(holding(drawn)) }),
					{ min: 0, max: 4 }
				)
			)
		}
	}

export type ItemFeature =
	| "an inline path item"
	| "a referenced path item"
	| "a chain of references"
	| "a key a pointer escapes ~ in"
	| "several path items"

/** The features a case reaches. */
export const itemFeaturesOf = (c: ItemsCase): ReadonlyArray<ItemFeature> => {
	const holds = (holding: Holding) => Arr.some(c.entries, (each) => each.holding === holding)
	const facts: ReadonlyArray<readonly [boolean, ItemFeature]> = [
		[holds("inline"), "an inline path item"],
		[holds("referenced"), "a referenced path item"],
		[holds("chained"), "a chain of references"],
		[Arr.some(c.entries, (each) => Str.includes("~")(each.key)), "a key a pointer escapes ~ in"],
		[c.entries.length > 1, "several path items"]
	]
	return Arr.map(
		Arr.filter(facts, ([holds]) => holds),
		([, feature]) => feature
	)
}

const laterLines = element<SpecLine>(["3.1", "3.2"])

/** Path items of every holding, aimed at each holding, an escaped `~` and several entries. */
export const itemsSpace: Aimed<ItemsCase, ItemFeature> = aimed(
	itemsGen(word(specLines), holdingGen),
	[
		["an inline path item", itemsGen(word(specLines), () => constant("inline"))],
		["a referenced path item", itemsGen(laterLines, () => constant("referenced"))],
		["a chain of references", itemsGen(laterLines, () => constant("chained"))],
		[
			"a key a pointer escapes ~ in",
			(source) => {
				const drawn = source.draw(itemsGen(laterLines, holdingGen))
				return { ...drawn, entries: [{ key: "/x~", holding: "referenced" }, ...drawn.entries] }
			}
		],
		[
			"several path items",
			(source) => {
				const drawn = source.draw(itemsGen(laterLines, holdingGen))
				return {
					...drawn,
					entries: [
						{ key: "/z", holding: "inline" },
						{ key: "/y", holding: "chained" },
						...drawn.entries
					]
				}
			}
		]
	]
)

const inlineItem: Json = { get: { responses: {} } }

/** The item an entry's holding writes under its key. */
const itemOf = (holding: Holding): Json => {
	switch (holding) {
		case "inline":
			return inlineItem
		case "referenced":
			return { $ref: "#/components/pathItems/Shared" }
		case "chained":
			return { $ref: "#/components/pathItems/Chained" }
	}
}

/** The case's document: its entries, and on 3.1 and 3.2 the shared item and the reference that chains to it. */
const itemsDocument = (c: ItemsCase) =>
	documentOf(
		c.line,
		Rec.fromEntries(Arr.map(c.entries, (each) => [each.key, itemOf(each.holding)])),
		c.line === "3.0"
			? {}
			: {
					pathItems: {
						Shared: inlineItem,
						Chained: { $ref: "#/components/pathItems/Shared" }
					}
				}
	)

/** A path item as the property compares it: its key, its use site and the pointer of the object it stands for. */
type Walked = Readonly<{ key: string; use: string; pointer: string }>

/** The path items the checks walk in a case's document. */
export const walkedOf = (c: ItemsCase) =>
	resolve({ document: entry, line: c.line, value: itemsDocument(c) }).pipe(
		Effect.map((resolution): ReadonlyArray<Walked> =>
			Arr.map(pathItems(resolution), (item) => ({
				key: item.key,
				use: item.use,
				pointer: item.pointer
			}))
		)
	)

/**
 * What the specification says of the case: every entry of `paths`, in its order, at its use site `/paths/<key>` (RFC
 * 6901, `~` written `~0` and `/` written `~1`), standing for itself when inline and for the object at the end of its
 * reference chain otherwise.
 */
export const expectedWalked = (c: ItemsCase): ReadonlyArray<Walked> =>
	Arr.map(c.entries, (each) => {
		const use = `/paths/${JsonPointer.escapeToken(each.key)}`
		return {
			key: each.key,
			use,
			pointer: each.holding === "inline" ? use : "/components/pathItems/Shared"
		}
	})
