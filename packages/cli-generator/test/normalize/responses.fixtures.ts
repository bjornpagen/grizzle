/** What the properties of responses.test.ts read: their Responses Object sketches and the cases design 6.6 states. */

import type { Json } from "@bjornpagen/grizzle-text/utf8"
import {
	boolean,
	constant,
	type Gen,
	oneOf,
	option,
	uniqueArray,
	weighted
} from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Effect, Option, Order, Record as Rec, String as Str } from "effect"
import type { SpecLine } from "#model/spec-section.ts"
import { dispatchOrder, normalizeResponses, precedenceOrder } from "#normalize/responses.ts"
import { documentAt, entryText, lineGen, resolvedAt, token } from "#test/support/normalizing.ts"

/** A Responses Object member name: every form of the key grammar, and names just outside it. */
type KeyText =
	| "200"
	| "201"
	| "404"
	| "100"
	| "599"
	| "1XX"
	| "2XX"
	| "5XX"
	| "default"
	| "600"
	| "007"
	| "099"
	| "999"
	| "2xx"
	| "6XX"
	| "DEFAULT"
	| "nope"
	| "X-note"
	| " 200"
	| ""
	| "x-note"

/** A response header's name: tokens, Content-Type in two spellings, and names that are no token. */
type HeaderNameText =
	| "Retry-After"
	| "X-Request-Id"
	| "X-Rate"
	| "Content-Type"
	| "content-type"
	| "bad name"

/** A response header: where it is written, how it is serialized and its two marks. */
type HeaderSketch = Readonly<{
	name: HeaderNameText
	referenced: boolean
	serialization: "schema" | "content"
	required: Option.Option<boolean>
	deprecated: Option.Option<boolean>
}>

/** A content key: media types of each codec family, ranges, and a key that is no media type. */
type MediaKey =
	| "application/json"
	| "application/problem+json"
	| "application/json; charset=utf-8"
	| "text/plain"
	| "application/xml"
	| "application/octet-stream"
	| "text/event-stream"
	| "application/x-ndjson"
	| "application/json-seq"
	| "application/geo+json-seq"
	| "image/*"
	| "text/*"
	| "*/*"
	| "not a type"

/** A media type of a response: its key, its schema (none, inline, or a component's), and the fields ignored there. */
type MediaSketch = Readonly<{
	key: MediaKey
	schema: "none" | "inline" | "component"
	itemSchema: boolean
	encoding: boolean
	description: boolean
}>

/** A response: written in place or behind a `$ref`, its description, headers and content. */
type ResponseSketch = Readonly<{
	referenced: boolean
	useSiteDescription: boolean
	description: Option.Option<"plain" | "unsafe">
	headers: ReadonlyArray<HeaderSketch>
	content: Option.Option<ReadonlyArray<MediaSketch>>
}>

/** One operation's Responses Object, its members drawn from every form of the key grammar. */
type ResponsesSketch = Readonly<{
	line: SpecLine
	entries: ReadonlyArray<readonly [KeyText, ResponseSketch]>
}>

/** What a case reaches. */
export type ResponsesFeature =
	| "explicit code"
	| "range"
	| "default"
	| "code out of range"
	| "key outside the grammar"
	| "extension key skipped"
	| "referenced response"
	| "use-site description"
	| "unsafe description"
	| "Content-Type header ignored"
	| "header name no token"
	| "header marks through a reference"
	| "3.0 header percent-encoding notice"
	| "content-based header"
	| "media key no media type"
	| "encoding ignored"
	| "media description ignored"
	| "component schema"
	| "inline schema"
	| "item schema"
	| "media range dispatched after exact keys"
	| "no responses"

const keyText: Gen<KeyText> = weighted([
	[3, oneOf([constant<KeyText>("200"), constant<KeyText>("201"), constant<KeyText>("404")])],
	[1, oneOf([constant<KeyText>("100"), constant<KeyText>("599")])],
	[2, oneOf([constant<KeyText>("1XX"), constant<KeyText>("2XX"), constant<KeyText>("5XX")])],
	[2, constant<KeyText>("default")],
	[
		1,
		oneOf([
			constant<KeyText>("600"),
			constant<KeyText>("007"),
			constant<KeyText>("099"),
			constant<KeyText>("999")
		])
	],
	[
		1,
		oneOf([
			constant<KeyText>("2xx"),
			constant<KeyText>("6XX"),
			constant<KeyText>("DEFAULT"),
			constant<KeyText>("nope"),
			constant<KeyText>("X-note"),
			constant<KeyText>(" 200"),
			constant<KeyText>("")
		])
	],
	[1, constant<KeyText>("x-note")]
])

const headerName: Gen<HeaderNameText> = weighted([
	[
		3,
		oneOf([
			constant<HeaderNameText>("Retry-After"),
			constant<HeaderNameText>("X-Request-Id"),
			constant<HeaderNameText>("X-Rate")
		])
	],
	[1, oneOf([constant<HeaderNameText>("Content-Type"), constant<HeaderNameText>("content-type")])],
	[1, constant<HeaderNameText>("bad name")]
])

const mark: Gen<Option.Option<boolean>> = option(boolean)

const headerGen =
	(name: HeaderNameText): Gen<HeaderSketch> =>
	(source) => ({
		name,
		referenced: boolean(source),
		serialization: weighted<HeaderSketch["serialization"]>([
			[3, constant("schema")],
			[1, constant("content")]
		])(source),
		required: mark(source),
		deprecated: mark(source)
	})

const mediaKey: Gen<MediaKey> = oneOf([
	constant<MediaKey>("application/json"),
	constant<MediaKey>("application/problem+json"),
	constant<MediaKey>("application/json; charset=utf-8"),
	constant<MediaKey>("text/plain"),
	constant<MediaKey>("application/xml"),
	constant<MediaKey>("application/octet-stream"),
	constant<MediaKey>("text/event-stream"),
	constant<MediaKey>("application/x-ndjson"),
	constant<MediaKey>("application/json-seq"),
	constant<MediaKey>("application/geo+json-seq"),
	constant<MediaKey>("image/*"),
	constant<MediaKey>("text/*"),
	constant<MediaKey>("*/*"),
	constant<MediaKey>("not a type")
])

/** A media type of `line`: an item schema only on 3.2, beside no schema. */
const mediaGen =
	(line: SpecLine) =>
	(key: MediaKey): Gen<MediaSketch> =>
	(source) => {
		const itemSchema = line === "3.2" && boolean(source)
		return {
			key,
			schema: itemSchema
				? "none"
				: oneOf([
						constant<MediaSketch["schema"]>("none"),
						constant<MediaSketch["schema"]>("inline"),
						constant<MediaSketch["schema"]>("component")
					])(source),
			itemSchema,
			encoding: boolean(source) && boolean(source),
			description: boolean(source) && boolean(source)
		}
	}

const response =
	(line: SpecLine): Gen<ResponseSketch> =>
	(source) => {
		const referenced = boolean(source)
		return {
			referenced,
			useSiteDescription: referenced && line !== "3.0" && boolean(source),
			description: option(
				weighted<"plain" | "unsafe">([
					[2, constant("plain")],
					[1, constant("unsafe")]
				])
			)(source),
			headers: uniqueArray(headerName, headerGen, { min: 0, max: 3 })(source),
			content: option(uniqueArray(mediaKey, mediaGen(line), { min: 0, max: 4 }))(source)
		}
	}

/** A Responses Object of a drawn line, each member a response of its own. */
export const responsesSpace: Gen<ResponsesSketch> = (source) => {
	const line = lineGen(source)
	return {
		line,
		entries: uniqueArray(keyText, (key) => (inner) => [key, response(line)(inner)] as const, {
			min: 0,
			max: 4
		})(source)
	}
}

/** The Responses Object's pointer. */
const responsesPointer = "/paths/~1a/get/responses"

/** The component a referenced response or header is written under, named by its key or header name. */
const componentName = (
	sketch: ResponsesSketch,
	key: KeyText,
	header: Option.Option<HeaderNameText>
): string => {
	const place = Option.getOrElse(
		Arr.findFirstIndex(sketch.entries, ([each]) => each === key),
		() => 0
	)
	return Option.match(header, {
		onNone: () => `R${place}`,
		onSome: (name) =>
			`R${place}H${Option.getOrElse(
				Arr.findFirstIndex(headerNames, (each) => each === name),
				() => 0
			)}`
	})
}

/** Every header name a sketch draws, in one order, so a header's component is named by its place here. */
const headerNames: ReadonlyArray<HeaderNameText> = [
	"Retry-After",
	"X-Request-Id",
	"X-Rate",
	"Content-Type",
	"content-type",
	"bad name"
]

/** The description a response writes and the one help shows. */
const descriptionOf = (value: "plain" | "unsafe"): readonly [string, string] =>
	value === "plain" ? ["Too slow.", "Too slow."] : ["a\u0007b‮", "ab"]

/** A media type object as written. */
const mediaJson = (value: MediaSketch): Json => ({
	...(value.schema === "inline" ? { schema: { type: "object" } } : {}),
	...(value.schema === "component" ? { schema: { $ref: "#/components/schemas/User" } } : {}),
	...(value.itemSchema ? { itemSchema: { type: "string" } } : {}),
	...(value.encoding ? { encoding: { name: { contentType: "text/plain" } } } : {}),
	...(value.description ? { description: "the payload" } : {})
})

/** A header object as written, in place. */
const headerJson = (value: HeaderSketch): Json => ({
	...Option.match(value.required, {
		onNone: () => ({}),
		onSome: (marked) => ({ required: marked })
	}),
	...Option.match(value.deprecated, {
		onNone: () => ({}),
		onSome: (marked) => ({ deprecated: marked })
	}),
	...(value.serialization === "schema"
		? { schema: { type: "integer" } }
		: { content: { "text/plain": { schema: { type: "string" } } } })
})

/** A response object as written where it lives (in place, or under components). */
const responseJson = (sketch: ResponsesSketch, key: KeyText, value: ResponseSketch): Json => ({
	...Option.match(value.description, {
		onNone: () => ({}),
		onSome: (each) => ({ description: descriptionOf(each)[0] })
	}),
	...(Arr.isReadonlyArrayNonEmpty(value.headers)
		? {
				headers: Rec.fromEntries(
					Arr.map(value.headers, (each): readonly [string, Json] => [
						each.name,
						each.referenced
							? {
									$ref: `#/components/headers/${componentName(sketch, key, Option.some(each.name))}`
								}
							: headerJson(each)
					])
				)
			}
		: {}),
	...Option.match(value.content, {
		onNone: () => ({}),
		onSome: (entries) => ({
			content: Rec.fromEntries(
				Arr.map(entries, (each): readonly [string, Json] => [each.key, mediaJson(each)])
			)
		})
	})
})

/** The document holding the operation's Responses Object and the components its references name. */
const documentOf = (sketch: ResponsesSketch): Json => {
	const referencedHeaders = Arr.flatMap(sketch.entries, ([key, value]) =>
		Arr.map(
			Arr.filter(value.headers, (each) => each.referenced),
			(each) => [key, each] as const
		)
	)
	return documentAt(sketch.line, {
		components: {
			schemas: { User: { type: "object" } },
			responses: Rec.fromEntries(
				Arr.map(
					Arr.filter(sketch.entries, ([, value]) => value.referenced),
					([key, value]): readonly [string, Json] => [
						componentName(sketch, key, Option.none()),
						responseJson(sketch, key, value)
					]
				)
			),
			headers: Rec.fromEntries(
				Arr.map(referencedHeaders, ([key, each]): readonly [string, Json] => [
					componentName(sketch, key, Option.some(each.name)),
					headerJson(each)
				])
			)
		},
		paths: {
			"/a": {
				get: {
					responses: Rec.fromEntries(
						Arr.map(sketch.entries, ([key, value]): readonly [string, Json] => [
							key,
							key === "x-note"
								? "a note"
								: value.referenced
									? {
											$ref: `#/components/responses/${componentName(sketch, key, Option.none())}`,
											...(value.useSiteDescription ? { description: "Back off." } : {})
										}
									: responseJson(sketch, key, value)
						])
					)
				}
			}
		}
	})
}

/** A response key as the model reads it. */
type KeyModel = Readonly<{ code: number }> | Readonly<{ range: number }> | "default"

/** How a member name classifies under the key grammar. */
type Classified =
	| Readonly<{ kind: "case"; key: KeyModel }>
	| Readonly<{ kind: "refused"; code: string }>
	| Readonly<{ kind: "skipped" }>

const threeDigits = regex("^[0-9]{3}$", "u")

const rangeKey = regex("^[1-5]XX$", "u")

/** The key grammar of design 6.6: default, 1XX to 5XX, a code from 100 to 599; an extension is skipped. */
const classify = (text: string): Classified => {
	if (text === "default") {
		return { kind: "case", key: "default" }
	}
	if (rangeKey.test(text)) {
		return { kind: "case", key: { range: Number(Arr.headNonEmpty(Str.split(text, "X"))) } }
	}
	if (threeDigits.test(text)) {
		const code = Number(text)
		return code >= 100 && code <= 599
			? { kind: "case", key: { code } }
			: { kind: "refused", code: "RSS-10/status-out-of-range" }
	}
	return Str.startsWith("x-")(text)
		? { kind: "skipped" }
		: { kind: "refused", code: "RSS-06/invalid-key" }
}

/** The codec a media type selects, by its essence alone (design 2.2). */
const codecOf = (key: MediaKey): string => {
	switch (key) {
		case "application/json":
		case "application/problem+json":
		case "application/json; charset=utf-8":
			return "json"
		case "text/plain":
			return "text"
		case "application/xml":
			return "xml"
		case "text/event-stream":
			return "sse"
		case "application/x-ndjson":
			return "ndjson"
		case "application/json-seq":
		case "application/geo+json-seq":
			return "jsonseq"
		case "application/octet-stream":
		case "image/*":
		case "text/*":
		case "*/*":
			return "binary"
		case "not a type":
			return "none"
	}
}

/** How specific a media key is: an exact type, a type range, or the full range. */
const specificity = (key: string): number => (key === "*/*" ? 2 : Str.endsWith("/*")(key) ? 1 : 0)

/** A finding as the model states it: document, code, severity, scope and pointer. */
type Located = readonly [
	document: string,
	code: string,
	severity: string,
	scope: string,
	pointer: string
]

/** A response case as the model states it. */
type CaseModel = Readonly<{
	key: KeyModel
	pointer: string
	description: Option.Option<string>
	headers: ReadonlyArray<readonly [name: string, required: boolean, deprecated: boolean]>
	alternatives: ReadonlyArray<
		readonly [
			mediaType: string,
			codec: string,
			schema: Option.Option<string>,
			itemSchema: Option.Option<string>
		]
	>
	dispatched: ReadonlyArray<string>
}>

/** One Responses Object normalized, as design 6.6 states it. */
type ResponsesModel = Readonly<{
	cases: ReadonlyArray<CaseModel>
	precedence: ReadonlyArray<KeyModel>
	findings: ReadonlyArray<Located>
}>

const notice = (code: string, pointer: string): Located => [
	entryText,
	code,
	"notice",
	"element",
	pointer
]

const refusal = (code: string, pointer: string): Located => [
	entryText,
	code,
	"refusal",
	"element",
	pointer
]

/** The rank and value a key sorts by: codes, then ranges, then default. */
const precedenceOf = Order.combine(
	Order.mapInput(Order.Number, (key: KeyModel) => (key === "default" ? 2 : "code" in key ? 0 : 1)),
	Order.mapInput(Order.Number, (key: KeyModel) =>
		key === "default" ? 0 : "code" in key ? key.code : key.range
	)
)

/** The Responses Object normalized as design 6.6 states, its members in the order the parsed object lists them. */
export const expectedOf = (sketch: ResponsesSketch): ResponsesModel => {
	const written = Rec.fromEntries(
		Arr.map(sketch.entries, ([key, value]): readonly [string, ResponseSketch] => [key, value])
	)
	const built = Arr.map(Rec.keys(written), (key) => {
		const at = `${responsesPointer}/${token(key)}`
		const value = Arr.findFirst(sketch.entries, ([each]) => each === key)
		const classified = classify(key)
		if (classified.kind === "skipped" || Option.isNone(value)) {
			return [Option.none<CaseModel>(), []] as const
		}
		if (classified.kind === "refused") {
			return [Option.none<CaseModel>(), [refusal(classified.code, at)]] as const
		}
		const [text, each] = value.value
		const home = each.referenced
			? `/components/responses/${componentName(sketch, text, Option.none())}`
			: at
		const media = Option.getOrElse(each.content, () => [])
		const alternatives = Arr.map(media, (one) => {
			const site = `${home}/content/${token(one.key)}`
			if (one.key === "not a type") {
				return [Option.none(), [refusal("RSP-05/invalid-media-type", site)]] as const
			}
			const findings: ReadonlyArray<Located> = [
				...(one.encoding && sketch.line !== "3.2" ? [notice("MED-10/encoding-ignored", site)] : []),
				...(one.description && sketch.line === "3.2"
					? [notice("MED-09/description-ignored", site)]
					: [])
			]
			const schema =
				one.schema === "component"
					? Option.some("User")
					: one.schema === "inline"
						? Option.some(`${site}/schema`)
						: Option.none()
			return [
				Option.some([
					one.key,
					codecOf(one.key),
					schema,
					one.itemSchema ? Option.some(`${site}/itemSchema`) : Option.none()
				] as const),
				findings
			] as const
		})
		const headers = Arr.map(each.headers, (one) => {
			const site = `${home}/headers/${token(one.name)}`
			if (Str.toLowerCase(one.name) === "content-type") {
				return [Option.none(), [notice("RSP-09/ignored-content-type", site)]] as const
			}
			if (one.name === "bad name") {
				return [Option.none(), [refusal("RSP-09/invalid-header-name", site)]] as const
			}
			const percent: ReadonlyArray<Located> =
				sketch.line === "3.0" && one.serialization === "schema"
					? [notice("HDR-15/header-percent-encoding", site)]
					: []
			return [
				Option.some([
					one.name,
					Option.getOrElse(one.required, () => false),
					Option.getOrElse(one.deprecated, () => false)
				] as const),
				percent
			] as const
		})
		const kept = Arr.getSomes(Arr.map(alternatives, ([one]) => one))
		const shown = each.useSiteDescription
			? Option.some("Back off.")
			: Option.map(each.description, (one) => descriptionOf(one)[1])
		return [
			Option.some<CaseModel>({
				key: classified.key,
				pointer: at,
				description: shown,
				headers: Arr.getSomes(Arr.map(headers, ([one]) => one)),
				alternatives: kept,
				dispatched: Arr.map(
					Arr.sort(
						kept,
						Order.mapInput(Order.Number, ([mediaType]: (typeof kept)[number]) =>
							specificity(mediaType)
						)
					),
					([mediaType]) => mediaType
				)
			}),
			[
				...Arr.flatMap(alternatives, ([, found]) => found),
				...Arr.flatMap(headers, ([, found]) => found)
			]
		] as const
	})
	const cases = Arr.getSomes(Arr.map(built, ([one]) => one))
	return {
		cases,
		precedence: Arr.sort(
			Arr.map(cases, (one) => one.key),
			precedenceOf
		),
		findings: Arr.flatMap(built, ([, found]) => found)
	}
}

/** The Responses Object as normalizeResponses builds it, its cases in precedence order and each case's dispatch order. */
export const actualOf = (sketch: ResponsesSketch) =>
	Effect.gen(function* () {
		const resolution = yield* resolvedAt(sketch.line, documentOf(sketch), [])
		const normalized = yield* normalizeResponses(resolution, responsesPointer, {
			method: "GET",
			path: "/a"
		})
		const model: ResponsesModel = {
			cases: Arr.map(normalized.responses, (one) => ({
				key: one.key,
				pointer: String(one.origin.pointer),
				description: Option.map(Option.fromUndefinedOr(one.docs.description), String),
				headers: Arr.map(
					one.headers,
					(each) => [String(each.name), each.required, each.deprecated] as const
				),
				alternatives: Arr.map(
					one.alternatives,
					(each) =>
						[
							String(each.mediaType),
							each.codec,
							Option.map(Option.fromUndefinedOr(each.schema), (schema) => schema.key),
							Option.map(Option.fromUndefinedOr(each.itemSchema), (schema) => schema.key)
						] as const
				),
				dispatched: Arr.map(dispatchOrder(one.alternatives), (each) => String(each.mediaType))
			})),
			precedence: Arr.map(precedenceOrder(normalized.responses), (one) => one.key),
			findings: Arr.map(normalized.diagnostics, (each): Located => [
				each.document,
				each.code,
				each.severity,
				each.scope,
				String(each.pointer)
			])
		}
		return model
	})

/** The features a sketch and its model reach. */
export const responsesFeatures = (
	sketch: ResponsesSketch,
	model: ResponsesModel
): ReadonlyArray<ResponsesFeature> => {
	const codes = new Set(Arr.map(model.findings, ([, code]) => code))
	const responses = Arr.map(sketch.entries, ([, value]) => value)
	const headers = Arr.flatMap(responses, (value) => value.headers)
	const media = Arr.flatMap(responses, (value) => Option.getOrElse(value.content, () => []))
	const facts: ReadonlyArray<readonly [boolean, ResponsesFeature]> = [
		[Arr.some(model.cases, (one) => one.key !== "default" && "code" in one.key), "explicit code"],
		[Arr.some(model.cases, (one) => one.key !== "default" && "range" in one.key), "range"],
		[Arr.some(model.cases, (one) => one.key === "default"), "default"],
		[codes.has("RSS-10/status-out-of-range"), "code out of range"],
		[codes.has("RSS-06/invalid-key"), "key outside the grammar"],
		[Arr.some(sketch.entries, ([key]) => key === "x-note"), "extension key skipped"],
		[Arr.some(responses, (value) => value.referenced), "referenced response"],
		[Arr.some(responses, (value) => value.useSiteDescription), "use-site description"],
		[
			Arr.some(responses, (value) => Option.exists(value.description, (one) => one === "unsafe")),
			"unsafe description"
		],
		[codes.has("RSP-09/ignored-content-type"), "Content-Type header ignored"],
		[codes.has("RSP-09/invalid-header-name"), "header name no token"],
		[
			Arr.some(
				headers,
				(one) =>
					one.referenced &&
					(Option.getOrElse(one.required, () => false) ||
						Option.getOrElse(one.deprecated, () => false))
			),
			"header marks through a reference"
		],
		[codes.has("HDR-15/header-percent-encoding"), "3.0 header percent-encoding notice"],
		[
			sketch.line === "3.0" &&
				Arr.some(headers, (one) => one.serialization === "content" && one.name !== "bad name"),
			"content-based header"
		],
		[codes.has("RSP-05/invalid-media-type"), "media key no media type"],
		[codes.has("MED-10/encoding-ignored"), "encoding ignored"],
		[codes.has("MED-09/description-ignored"), "media description ignored"],
		[Arr.some(media, (one) => one.schema === "component"), "component schema"],
		[Arr.some(media, (one) => one.schema === "inline"), "inline schema"],
		[Arr.some(media, (one) => one.itemSchema), "item schema"],
		[
			Arr.some(
				model.cases,
				(one) =>
					Arr.join(one.dispatched, "\n") !==
					Arr.join(
						Arr.map(one.alternatives, ([each]) => each),
						"\n"
					)
			),
			"media range dispatched after exact keys"
		],
		[!Arr.isReadonlyArrayNonEmpty(sketch.entries), "no responses"]
	]
	return Arr.map(
		Arr.filter(facts, ([holds]) => holds),
		([, feature]) => feature
	)
}
