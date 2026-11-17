/** What the property of document-set.test.ts reads: its placements of shared elements and the model they normalize to. */

import { boolean, constant, type Gen, oneOf } from "@bjornpagen/testing/gen"
import {
	Array as Arr,
	Effect,
	Option,
	Order,
	Predicate,
	Record as Rec,
	Schema,
	String as Str
} from "effect"
import { DocumentUri } from "#model/brands.ts"
import { Api } from "#model/entities.ts"
import { isArray, isObject } from "#model/json-tree.ts"
import type { Json } from "#model/pointer.ts"
import { nodeOption } from "#normalize/document-set.ts"
import { normalize } from "#normalize/index.ts"
import type { ResolveMember } from "#resolve/index.ts"
import {
	authorConfigOf,
	configUri,
	entryText,
	resolvedAt,
	token
} from "#test/support/normalizing.ts"

/** Where a shared element is written: in place at its use, among the entry's components, or in a second document. */
type Placement = "inline" | "entry" | "member"

/** The shared schema, parameter and response, each placed, and the two elements whose diagnostics name their place. */
type SetSketch = Readonly<{
	line: "3.1" | "3.2"
	pet: Placement
	limit: Placement
	ok: Placement
	pattern: boolean
	contentType: boolean
}>

/** What a case reaches. */
export type SetFeature =
	| "schema in a second document"
	| "parameter in a second document"
	| "response in a second document"
	| "schema among the entry's components"
	| "schema inline"
	| "diagnostic inside a second document"
	| "single document"

const placement: Gen<Placement> = oneOf([
	constant<Placement>("inline"),
	constant<Placement>("entry"),
	constant<Placement>("member")
])

/** The shared elements, each placed apart, with or without the elements that raise a diagnostic. */
export const setSpace: Gen<SetSketch> = (source) => ({
	line: oneOf([constant<"3.1">("3.1"), constant<"3.2">("3.2")])(source),
	pet: placement(source),
	limit: placement(source),
	ok: placement(source),
	pattern: boolean(source),
	contentType: boolean(source)
})

/** The second document of the set. */
const memberText = "file:///spec/common.json"

const memberUri = Schema.decodeEffect(DocumentUri)(memberText)

/** The pointer of a component of `section` named `name`. */
const componentPointer = (section: string, name: string): string => `/components/${section}/${name}`

/** The document an element placed `where` is written in: the second for a member, else the entry. */
const documentNameOf = (where: Placement): string =>
	where === "member" ? "common.json" : "openapi.json"

/** A use of a component placed in `where`, written in the document of an element placed `from`. */
const referenceTo = (
	where: Exclude<Placement, "inline">,
	from: Placement,
	section: string,
	name: string
): Json => ({
	$ref: `${documentNameOf(where) === documentNameOf(from) ? "" : documentNameOf(where)}#${componentPointer(section, name)}`
})

const petJson = (sketch: SetSketch): Json => ({
	properties: { name: { ...(sketch.pattern ? { pattern: "^a" } : {}), type: "string" } },
	required: ["name"],
	type: "object"
})

const limitJson: Json = { in: "query", name: "limit", required: true, schema: { type: "integer" } }

/** The schema a use in a document placed `from` writes: the schema itself, or a reference to where it lives. */
const petUse = (sketch: SetSketch, from: Placement): Json =>
	sketch.pet === "inline" ? petJson(sketch) : referenceTo(sketch.pet, from, "schemas", "Pet")

const okJson = (sketch: SetSketch): Json => ({
	content: { "application/json": { schema: petUse(sketch, sketch.ok) } },
	description: "ok",
	...(sketch.contentType ? { headers: { "Content-Type": { schema: { type: "string" } } } } : {})
})

/** The components a document placed `where` holds. */
const componentsAt = (sketch: SetSketch, where: Exclude<Placement, "inline">): Json => ({
	...(sketch.pet === where ? { schemas: { Pet: petJson(sketch) } } : {}),
	...(sketch.limit === where ? { parameters: { Limit: limitJson } } : {}),
	...(sketch.ok === where ? { responses: { Ok: okJson(sketch) } } : {})
})

/** The entry's paths, each shared element used where it is placed. */
const pathsOf = (sketch: SetSketch): Json => ({
	"/pets": {
		get: {
			parameters: [
				sketch.limit === "inline"
					? limitJson
					: referenceTo(sketch.limit, "inline", "parameters", "Limit")
			],
			responses: {
				"200":
					sketch.ok === "inline"
						? okJson(sketch)
						: referenceTo(sketch.ok, "inline", "responses", "Ok")
			}
		},
		post: {
			requestBody: { content: { "application/json": { schema: petUse(sketch, "inline") } } },
			responses: { "204": { description: "done" } }
		}
	}
})

/** Whether any element sits in the second document. */
const usesMember = (sketch: SetSketch): boolean =>
	sketch.pet === "member" || sketch.limit === "member" || sketch.ok === "member"

/** The sketch's entry document and, when anything sits there, its second document. */
const setOf = (sketch: SetSketch) =>
	Effect.gen(function* () {
		const member: ResolveMember = {
			document: yield* memberUri,
			value: { components: componentsAt(sketch, "member") }
		}
		const value: Json = {
			components: componentsAt(sketch, "entry"),
			info: { title: "t", version: "1" },
			openapi: sketch.line === "3.1" ? "3.1.1" : "3.2.0",
			paths: pathsOf(sketch)
		}
		return { value, members: usesMember(sketch) ? [member] : [] }
	})

/** The same elements written in place at every use: the inlined twin. */
export const inlinedOf = (sketch: SetSketch): SetSketch => ({
	...sketch,
	pet: "inline",
	limit: "inline",
	ok: "inline"
})

/** The model as plain JSON, as it is written out. */
const encodedOf = (api: Api) =>
	Effect.flatMap(Schema.encodeEffect(Api)(api), Schema.decodeUnknownEffect(Schema.Json))

/** The stored `$defs` of the model's schema document. */
const defsOf = (model: Json): Readonly<Record<string, Json>> => {
	const at = (value: Option.Option<Json>, name: string) =>
		Option.flatMap(Option.filter(value, isObject), (object) => Rec.get(object, name))
	return Option.getOrElse(
		Option.filter(at(at(at(Option.some(model), "schemas"), "document"), "$defs"), isObject),
		(): Readonly<Record<string, Json>> => ({})
	)
}

/** The operations with every schema key replaced by the stored schema it names and every origin dropped. */
const meaningOf = (model: Json): Json => {
	const store = defsOf(model)
	const strip = (value: Json): Json => {
		if (isArray(value)) {
			return Arr.map(value, strip)
		}
		if (!isObject(value)) {
			return value
		}
		const keys = Rec.keys(value)
		const key = Option.filter(Rec.get(value, "key"), Predicate.isString)
		if (keys.length === 1 && Option.isSome(key)) {
			return Option.match(Rec.get(store, key.value), {
				onNone: () => ({ missing: key.value }),
				onSome: strip
			})
		}
		return Rec.fromEntries(
			Arr.map(
				Arr.filter(keys, (name) => name !== "origin"),
				(name): readonly [string, Json] => [
					name,
					strip(Option.getOrElse(Rec.get(value, name), () => null))
				]
			)
		)
	}
	return strip(isObject(model) ? Option.getOrElse(Rec.get(model, "operations"), () => null) : null)
}

/** A located diagnostic: its code, its document and its pointer. */
type Located = readonly [code: string, document: string, pointer: string]

/** One normalization of the set, as the properties compare it. */
type SetReading = Readonly<{
	meaning: Json
	keys: ReadonlyArray<string>
	documents: ReadonlyArray<string>
	diagnostics: ReadonlyArray<Located>
	unread: ReadonlyArray<Located>
	absent: ReadonlyArray<boolean>
}>

/** The document and pointer an element placed `where` (an inline one at `inlineAt`) is read from. */
const homeOf = (
	where: Placement,
	inlineAt: readonly [string, string],
	component: string
): readonly [string, string] =>
	where === "inline" ? inlineAt : [where === "member" ? memberText : entryText, component]

/** The key the store holds a schema under: a member's by its URI and pointer, an entry component's by its name. */
const keyOf = ([document, pointer]: readonly [string, string]): string => {
	const tokens = Str.split(pointer, "/")
	const [, components, schemas, name] = tokens
	return document !== entryText
		? `${document}#${pointer}`
		: tokens.length === 4 &&
			  components === "components" &&
			  schemas === "schemas" &&
			  name !== undefined
			? name
			: pointer
}

/** The store's keys, the documents and the located diagnostics the set normalizes to (design 3.7, 5). */
export const expectedOf = (
	sketch: SetSketch
): Omit<SetReading, "meaning" | "unread" | "absent"> => {
	const ok = homeOf(
		sketch.ok,
		[entryText, "/paths/~1pets/get/responses/200"],
		"/components/responses/Ok"
	)
	const okSchema: readonly [string, string] = [
		ok[0],
		`${ok[1]}/content/${token("application/json")}/schema`
	]
	const bodySchema: readonly [string, string] = [
		entryText,
		`/paths/~1pets/post/requestBody/content/${token("application/json")}/schema`
	]
	const limit = homeOf(
		sketch.limit,
		[entryText, "/paths/~1pets/get/parameters/0"],
		"/components/parameters/Limit"
	)
	const pet = homeOf(sketch.pet, bodySchema, "/components/schemas/Pet")
	const petSites: ReadonlyArray<readonly [string, string]> =
		sketch.pet === "inline" ? [bodySchema, okSchema] : [pet]
	const contentType: readonly [string, string] = [ok[0], `${ok[1]}/headers/Content-Type`]
	const sites = [
		bodySchema,
		okSchema,
		[limit[0], `${limit[1]}/schema`] as const,
		...(sketch.contentType ? [[contentType[0], `${contentType[1]}/schema`] as const] : []),
		...(sketch.pet === "inline" ? [] : [pet])
	]
	return {
		keys: Arr.sort(Arr.dedupe(Arr.map(sites, keyOf)), Order.String),
		documents: usesMember(sketch) ? [entryText, memberText] : [entryText],
		diagnostics: Arr.sort(
			[
				...(sketch.contentType
					? [["RSP-09/ignored-content-type", contentType[0], contentType[1]] as const]
					: []),
				...(sketch.pattern
					? Arr.map(
							petSites,
							([document, pointer]) =>
								["SCH-37/not-asserted", document, `${pointer}/properties/name/pattern`] as const
						)
					: [])
			],
			Order.mapInput(
				Order.String,
				([code, document, pointer]: Located) => `${document}#${pointer} ${code}`
			)
		)
	}
}

/** The set normalized: the operations' meaning, the store's keys, the documents, the diagnostics, and node reads. */
export const readingOf = (sketch: SetSketch) =>
	Effect.gen(function* () {
		const { value, members } = yield* setOf(sketch)
		const resolution = yield* resolvedAt(sketch.line, value, members)
		const config = yield* authorConfigOf({})
		const configDocument = yield* configUri
		const member = yield* memberUri
		const { api, diagnostics } = yield* normalize(resolution, {
			checkFindings: [],
			config,
			configDocument
		})
		const model = yield* encodedOf(api)
		const located = Arr.map(diagnostics, (each): Located => [
			each.code,
			each.document,
			String(each.pointer)
		])
		const absentDocument = yield* Schema.decodeEffect(DocumentUri)("file:///spec/absent.json")
		const reading: SetReading = {
			meaning: meaningOf(model),
			keys: Arr.sort(Rec.keys(defsOf(model)), Order.String),
			documents: Arr.map(api.documents, String),
			diagnostics: Arr.sort(
				located,
				Order.mapInput(
					Order.String,
					([code, document, pointer]: Located) => `${document}#${pointer} ${code}`
				)
			),
			unread: Arr.filter(located, ([, document, pointer]) =>
				Option.isNone(
					nodeOption(resolution, {
						document: document === entryText ? resolution.document : member,
						pointer
					})
				)
			),
			absent: [
				Option.isNone(nodeOption(resolution, { document: absentDocument, pointer: "" })),
				Option.isNone(
					nodeOption(resolution, { document: resolution.document, pointer: "/components/missing" })
				),
				Option.isSome(
					nodeOption(resolution, { document: resolution.document, pointer: "/info/title" })
				)
			]
		}
		return reading
	})

/** The features a sketch reaches. */
export const setFeatures = (sketch: SetSketch): ReadonlyArray<SetFeature> => {
	const facts: ReadonlyArray<readonly [boolean, SetFeature]> = [
		[sketch.pet === "member", "schema in a second document"],
		[sketch.limit === "member", "parameter in a second document"],
		[sketch.ok === "member", "response in a second document"],
		[sketch.pet === "entry", "schema among the entry's components"],
		[sketch.pet === "inline", "schema inline"],
		[
			(sketch.contentType && sketch.ok === "member") || (sketch.pattern && sketch.pet === "member"),
			"diagnostic inside a second document"
		],
		[!usesMember(sketch), "single document"]
	]
	return Arr.map(
		Arr.filter(facts, ([holds]) => holds),
		([, feature]) => feature
	)
}
