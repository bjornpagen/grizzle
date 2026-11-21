/** What the property of multipart-encoding.test.ts reads: multipart/form-data sketches and the part rules design 6.3 states. */

import type { Json } from "@bjornpagen/grizzle-text/utf8"
import {
	aimed,
	array,
	boolean,
	constant,
	type Gen,
	oneOf,
	option,
	subarray,
	uniqueArray,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order, Record as Rec, String as Str } from "effect"
import { Digest } from "effect/crypto"
import type { SpecLine } from "#model/spec-section.ts"
import { normalizeBody } from "#normalize/bodies.ts"
import { documentAt, entryUri, lineGen, openapiOf, resolvedAt } from "#test/support/normalizing.ts"
import { diagnoseDocument } from "#validate/index.ts"

/** A part's schema: text, binary text by 3.0's format or 3.1's contentEncoding, an object, or a list of them. */
type PartSchema =
	| "string"
	| "binary"
	| "byte"
	| "base64"
	| "identity"
	| "quoted"
	| "object"
	| "strings"
	| "bytes"
	| "base64s"
	| "refObject"
	| "allOfString"
	| "nullableString"
	| "mixedTypes"

/** An explicit contentType: a list of ranges, text, XML, or no list at all. */
type PartType =
	| "image/png, image/*"
	| "text/plain"
	| "application/xml"
	| "text/xml"
	| "image png"
	| ""

/** A part header by name: a typed one, Content-Type, the two the writer owns, or a name that is no token. */
type HeaderName =
	| "X-Rate"
	| "Content-Type"
	| "Content-Disposition"
	| "Content-Transfer-Encoding"
	| "bad name"

/** The schema a Content-Transfer-Encoding header declares: none, or an enum or a const that admits base64 or not. */
type TransferSchema = Readonly<{ keyword: "enum" | "const"; admits: boolean }>

/** Style fields of a part: a style (form or another) and explode, as given. */
type Styled = Readonly<{
	style: Option.Option<"form" | "spaceDelimited">
	explode: Option.Option<boolean>
}>

/** A part's Encoding Object. */
type Entry = Readonly<{
	contentType: Option.Option<PartType>
	headers: ReadonlyArray<HeaderName>
	required: boolean
	transfer: Option.Option<TransferSchema>
	styled: Option.Option<Styled>
}>

/** One part: its name, schema, whether the body requires it, and its Encoding Object, if any. */
type Part = Readonly<{
	name: string
	schema: PartSchema
	required: boolean
	entry: Option.Option<Entry>
}>

/** A multipart/form-data body: its parts, an encoding key naming none, and a schema-valued additionalProperties. */
type MultipartSketch = Readonly<{
	line: SpecLine
	parts: ReadonlyArray<Part>
	ghost: boolean
	extra: "none" | "map" | "boolean"
}>

/** What a case reaches. */
export type MultipartFeature =
	| "3.0 format byte sent base64"
	| "3.1 contentEncoding base64"
	| "identity contentEncoding sent raw"
	| "unsupported contentEncoding refused"
	| "array of base64 items"
	| "comma-separated contentType"
	| "contentType that is no list refused"
	| "object part typed as XML refused"
	| "typed part header"
	| "Content-Type header ignored"
	| "writer-owned header"
	| "header name no token refused"
	| "transfer header admits base64"
	| "transfer header conflict refused"
	| "form pairs style"
	| "unsupported part style refused at field scope"
	| "unsupported part style drops the alternative"
	| "3.0 multipart style ignored"
	| "unknown encoding key"
	| "additionalProperties map refused"
	| "part typed through a reference or allOf"
	| "type list read without null or as disagreeing"

const schemaOn = (line: SpecLine): Gen<PartSchema> =>
	weighted([
		[
			2,
			line === "3.0"
				? oneOf([constant<PartSchema>("refObject"), constant<PartSchema>("allOfString")])
				: oneOf([
						constant<PartSchema>("refObject"),
						constant<PartSchema>("allOfString"),
						constant<PartSchema>("nullableString"),
						constant<PartSchema>("mixedTypes")
					])
		],
		[
			3,
			oneOf([
				constant<PartSchema>("string"),
				constant<PartSchema>("binary"),
				constant<PartSchema>("object"),
				constant<PartSchema>("strings")
			])
		],
		[
			3,
			line === "3.0"
				? oneOf([constant<PartSchema>("byte"), constant<PartSchema>("bytes")])
				: oneOf([
						constant<PartSchema>("base64"),
						constant<PartSchema>("identity"),
						constant<PartSchema>("base64s")
					])
		],
		[1, line === "3.0" ? constant<PartSchema>("string") : constant<PartSchema>("quoted")]
	])

const partType: Gen<PartType> = weighted([
	[3, oneOf([constant<PartType>("image/png, image/*"), constant<PartType>("text/plain")])],
	[2, oneOf([constant<PartType>("application/xml"), constant<PartType>("text/xml")])],
	[1, oneOf([constant<PartType>("image png"), constant<PartType>("")])]
])

const rare = (source: Parameters<Gen<boolean>>[0]): boolean => boolean(source) && boolean(source)

const entryGen: Gen<Entry> = (source) => ({
	contentType: option(partType)(source),
	headers: subarray<HeaderName>([
		"X-Rate",
		"Content-Type",
		"Content-Disposition",
		"Content-Transfer-Encoding",
		"bad name"
	])(source),
	required: boolean(source),
	transfer: option((inner): TransferSchema => ({
		keyword: oneOf([constant<"enum">("enum"), constant<"const">("const")])(inner),
		admits: boolean(inner)
	}))(source),
	styled: rare(source)
		? Option.some({
				style: option(
					oneOf([constant<"form">("form"), constant<"spaceDelimited">("spaceDelimited")])
				)(source),
				explode: option(boolean)(source)
			})
		: Option.none()
})

const partOn =
	(line: SpecLine) =>
	(name: string): Gen<Part> =>
	(source) => ({
		name,
		schema: schemaOn(line)(source),
		required: boolean(source),
		entry: option(entryGen)(source)
	})

const drawnMultipart: Gen<MultipartSketch> = (source) => {
	const line = lineGen(source)
	return {
		line,
		parts: uniqueArray(
			oneOf([constant("file"), constant("meta"), constant("note"), constant("tags")]),
			partOn(line),
			{ min: 1, max: 3 }
		)(source),
		ghost: rare(source) && boolean(source),
		extra: weighted<MultipartSketch["extra"]>([
			[6, constant("none")],
			[1, constant("map")],
			[1, constant("boolean")]
		])(source)
	}
}

const plainEntry: Entry = {
	contentType: Option.none(),
	headers: [],
	required: false,
	transfer: Option.none(),
	styled: Option.none()
}

/** A drawn body with one part in place of its own: a case built to reach one situation. */
const reaching =
	(part: Part, fields: Partial<MultipartSketch>): Gen<MultipartSketch> =>
	(source) => ({ ...drawnMultipart(source), ghost: false, extra: "none", ...fields, parts: [part] })

/** Multipart bodies, aimed at the situations a draw reaches rarely. */
export const multipartSpace = aimed<MultipartSketch, MultipartFeature>(drawnMultipart, [
	[
		"3.0 format byte sent base64",
		reaching(
			{ name: "file", schema: "byte", required: false, entry: Option.none() },
			{ line: "3.0" }
		)
	],
	[
		"3.1 contentEncoding base64",
		reaching(
			{ name: "file", schema: "base64", required: false, entry: Option.none() },
			{ line: "3.1" }
		)
	],
	[
		"unsupported contentEncoding refused",
		reaching(
			{ name: "file", schema: "quoted", required: false, entry: Option.none() },
			{ line: "3.2" }
		)
	],
	[
		"transfer header conflict refused",
		reaching(
			{
				name: "file",
				schema: "base64",
				required: false,
				entry: Option.some({
					...plainEntry,
					headers: ["Content-Transfer-Encoding"],
					transfer: Option.some({ keyword: "const", admits: false })
				})
			},
			{ line: "3.1" }
		)
	],
	[
		"object part typed as XML refused",
		reaching(
			{
				name: "meta",
				schema: "object",
				required: false,
				entry: Option.some({ ...plainEntry, contentType: Option.some("application/xml") })
			},
			{}
		)
	],
	[
		"header name no token refused",
		reaching(
			{
				name: "note",
				schema: "string",
				required: false,
				entry: Option.some({ ...plainEntry, headers: ["bad name"] })
			},
			{}
		)
	],
	[
		"unsupported part style refused at field scope",
		reaching(
			{
				name: "tags",
				schema: "strings",
				required: false,
				entry: Option.some({
					...plainEntry,
					styled: Option.some({ style: Option.some("spaceDelimited"), explode: Option.none() })
				})
			},
			{ line: "3.1" }
		)
	],
	[
		"unsupported part style drops the alternative",
		reaching(
			{
				name: "tags",
				schema: "strings",
				required: true,
				entry: Option.some({
					...plainEntry,
					styled: Option.some({ style: Option.some("form"), explode: Option.some(false) })
				})
			},
			{ line: "3.2" }
		)
	],
	[
		"3.0 multipart style ignored",
		reaching(
			{
				name: "note",
				schema: "string",
				required: false,
				entry: Option.some({
					...plainEntry,
					styled: Option.some({ style: Option.some("form"), explode: Option.none() })
				})
			},
			{ line: "3.0" }
		)
	],
	[
		"contentType that is no list refused",
		reaching(
			{
				name: "note",
				schema: "string",
				required: false,
				entry: Option.some({ ...plainEntry, contentType: Option.some("image png") })
			},
			{}
		)
	],
	[
		"transfer header admits base64",
		reaching(
			{
				name: "file",
				schema: "base64",
				required: false,
				entry: Option.some({
					...plainEntry,
					headers: ["Content-Transfer-Encoding"],
					transfer: Option.some({ keyword: "const", admits: true })
				})
			},
			{ line: "3.2" }
		)
	],
	[
		"array of base64 items",
		reaching(
			{ name: "file", schema: "base64s", required: false, entry: Option.none() },
			{ line: "3.1" }
		)
	],
	[
		"identity contentEncoding sent raw",
		reaching(
			{ name: "file", schema: "identity", required: false, entry: Option.none() },
			{ line: "3.1" }
		)
	],
	[
		"typed part header",
		reaching(
			{
				name: "note",
				schema: "string",
				required: false,
				entry: Option.some({
					...plainEntry,
					headers: ["X-Rate", "Content-Type", "Content-Disposition"],
					required: true
				})
			},
			{}
		)
	],
	[
		"comma-separated contentType",
		reaching(
			{
				name: "file",
				schema: "binary",
				required: false,
				entry: Option.some({ ...plainEntry, contentType: Option.some("image/png, image/*") })
			},
			{}
		)
	],
	[
		"form pairs style",
		reaching(
			{
				name: "tags",
				schema: "strings",
				required: true,
				entry: Option.some({
					...plainEntry,
					styled: Option.some({ style: Option.none(), explode: Option.none() })
				})
			},
			{ line: "3.2" }
		)
	],
	[
		"unknown encoding key",
		reaching(
			{ name: "note", schema: "string", required: false, entry: Option.none() },
			{ ghost: true }
		)
	],
	[
		"additionalProperties map refused",
		reaching(
			{ name: "file", schema: "binary", required: false, entry: Option.none() },
			{ extra: "map" }
		)
	]
])

/** A part schema as written. */
const schemaJson = (value: PartSchema): Json => {
	switch (value) {
		case "string":
			return { type: "string" }
		case "binary":
			return { format: "binary", type: "string" }
		case "byte":
			return { format: "byte", type: "string" }
		case "base64":
			return { contentEncoding: "base64", type: "string" }
		case "identity":
			return { contentEncoding: "8BIT" }
		case "quoted":
			return { contentEncoding: "quoted-printable", type: "string" }
		case "object":
			return { properties: { a: { type: "string" } }, type: "object" }
		case "strings":
			return { items: { type: "string" }, type: "array" }
		case "bytes":
			return { items: { format: "byte", type: "string" }, type: "array" }
		case "base64s":
			return { items: { contentEncoding: "base64", type: "string" }, type: "array" }
		case "refObject":
			return { $ref: "#/components/schemas/Obj" }
		case "allOfString":
			return { allOf: [{ type: "string" }, { description: "a note" }] }
		case "nullableString":
			return { type: ["string", "null"] }
		case "mixedTypes":
			return { type: ["string", "object"] }
	}
}

const transferJson = (value: TransferSchema): Json =>
	value.keyword === "enum"
		? { enum: value.admits ? ["base64", "7bit"] : ["7bit"], type: "string" }
		: { const: value.admits ? "BASE64" : "binary" }

const headerJson = (name: HeaderName, value: Entry): Json =>
	name === "Content-Transfer-Encoding"
		? {
				schema: Option.match(value.transfer, {
					onNone: () => ({ type: "string" }),
					onSome: transferJson
				})
			}
		: name === "X-Rate"
			? { required: value.required, schema: { type: "string" } }
			: { schema: { type: "string" } }

const entryJson = (value: Entry): Json => ({
	...Option.match(value.contentType, {
		onNone: () => ({}),
		onSome: (each) => ({ contentType: each })
	}),
	...(Arr.isReadonlyArrayNonEmpty(value.headers)
		? {
				headers: Rec.fromEntries(
					Arr.map(value.headers, (name): readonly [string, Json] => [name, headerJson(name, value)])
				)
			}
		: {}),
	...Option.match(value.styled, {
		onNone: () => ({}),
		onSome: (each) => ({
			...Option.match(each.style, { onNone: () => ({}), onSome: (style) => ({ style }) }),
			...Option.match(each.explode, { onNone: () => ({}), onSome: (explode) => ({ explode }) }),
			...(Option.isNone(each.style) && Option.isNone(each.explode) ? { allowReserved: true } : {})
		})
	})
})

const bodyPointer = "/paths/~1a/post/requestBody"

const media = `${bodyPointer}/content/multipart~1form-data`

const documentOf = (sketch: MultipartSketch): Json =>
	documentAt(sketch.line, {
		components: { schemas: { Obj: { properties: { a: { type: "string" } }, type: "object" } } },
		paths: {
			"/a": {
				post: {
					requestBody: {
						content: {
							"multipart/form-data": {
								schema: {
									properties: Rec.fromEntries(
										Arr.map(sketch.parts, (each): readonly [string, Json] => [
											each.name,
											schemaJson(each.schema)
										])
									),
									required: Arr.map(
										Arr.filter(sketch.parts, (each) => each.required),
										(each) => each.name
									),
									type: "object",
									...(sketch.extra === "map" ? { additionalProperties: { type: "string" } } : {}),
									...(sketch.extra === "boolean" ? { additionalProperties: true } : {})
								},
								encoding: {
									...Rec.fromEntries(
										Arr.flatMap(sketch.parts, (each): ReadonlyArray<readonly [string, Json]> =>
											Option.match(each.entry, {
												onNone: () => [],
												onSome: (value) => [[each.name, entryJson(value)]]
											})
										)
									),
									...(sketch.ghost ? { ghost: { contentType: "text/plain" } } : {})
								}
							}
						}
					},
					responses: { "200": { description: "ok" } }
				}
			}
		}
	})

/** A finding before it is placed: code, severity, own pointer, and whether it drops its alternative. */
type Raw = Readonly<{ code: string; severity: "notice" | "refusal"; at: string; drops: boolean }>

const raw = (code: string, severity: "notice" | "refusal", at: string, drops: boolean): Raw => ({
	code,
	severity,
	at,
	drops
})

/** A finding as the model states it: code, severity, scope, pointer, related pointers and wire name. */
type Located = readonly [
	code: string,
	severity: string,
	scope: string,
	pointer: string,
	related: string,
	wire: string
]

/** A part's rule as the model states it. */
type RuleModel = Readonly<{
	target: string
	contentType: ReadonlyArray<string>
	contentEncoding: Option.Option<string>
	rows: ReadonlyArray<string>
	headers: ReadonlyArray<readonly [string, boolean]>
	serialization: boolean
}>

/** The multipart alternative normalized, as design 6.3 states it. */
type MultipartModel = Readonly<{
	alternative: Option.Option<
		Readonly<{ rules: ReadonlyArray<RuleModel>; refusedFields: ReadonlyArray<string> }>
	>
	findings: ReadonlyArray<Located>
}>

/** The default contentType table for a top-level part (ENC-17 to ENC-26). */
const tableOf = (value: PartSchema, line: SpecLine): readonly [row: string, type: string] => {
	switch (value) {
		case "string":
			return ["ENC-20", "text/plain"]
		case "binary":
		case "byte":
			return line === "3.0" ? ["ENC-18", "application/octet-stream"] : ["ENC-20", "text/plain"]
		case "base64":
		case "quoted":
			return ["ENC-19", "application/octet-stream"]
		case "identity":
			return ["ENC-17", "application/octet-stream"]
		case "object":
			return ["ENC-22", "application/json"]
		case "strings":
			return [line === "3.2" ? "ENC-24" : "ENC-23", "text/plain"]
		case "bytes":
			return ["ENC-23", "application/octet-stream"]
		case "base64s":
			return [line === "3.2" ? "ENC-24" : "ENC-23", "application/octet-stream"]
		case "refObject":
			return ["ENC-22", "application/json"]
		case "allOfString":
		case "nullableString":
			return ["ENC-20", "text/plain"]
		case "mixedTypes":
			return ["ENC-17", "application/octet-stream"]
	}
}

/** The transfer encoding a part's schema declares (ENC-37, ENC-38): base64 with its row, a raw row, or a refusal. */
type Transfer =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "base64"; row: string }>
	| Readonly<{ kind: "raw"; row: string }>
	| Readonly<{ kind: "refused"; at: string }>

const transferOf = (part: Part, line: SpecLine): Transfer => {
	const schema = `${media}/schema/properties/${part.name}`
	switch (part.schema) {
		case "byte":
		case "bytes":
			return line === "3.0" ? { kind: "base64", row: "ENC-38" } : { kind: "none" }
		case "base64":
		case "base64s":
			return { kind: "base64", row: "ENC-37" }
		case "identity":
			return { kind: "raw", row: "ENC-37" }
		case "quoted":
			return { kind: "refused", at: `${schema}/contentEncoding` }
		case "string":
		case "binary":
		case "object":
		case "strings":
		case "refObject":
		case "allOfString":
		case "nullableString":
		case "mixedTypes":
			return { kind: "none" }
	}
}

/** One part's rule, or the findings that refuse it (design 6.3 buildRule). */
const ruleOf = (
	sketch: MultipartSketch,
	part: Part
): Readonly<{ rule: Option.Option<RuleModel>; findings: ReadonlyArray<Raw> }> => {
	const value = Option.getOrElse(part.entry, () => plainEntry)
	const actual = Option.isSome(part.entry)
		? `${media}/encoding/${part.name}`
		: `${media}/schema/properties/${part.name}`
	const honors = sketch.line !== "3.0"
	const styled = Option.filter(value.styled, () => honors)
	const typingFindings: Array<Raw> = []
	if (Option.isSome(value.styled) && !honors) {
		typingFindings.push(raw("ENC-12/style-ignored", "notice", actual, false))
	}
	const [tableRow, tableType] = tableOf(part.schema, sketch.line)
	const typed = Option.match(styled, {
		onSome: (
			given
		): Readonly<{
			contentType: ReadonlyArray<string>
			rows: ReadonlyArray<string>
			refused: boolean
		}> => {
			if (Option.isSome(value.contentType)) {
				typingFindings.push(raw("ENC-13/content-type-ignored", "notice", actual, false))
			}
			const allowReservedAlone = Option.isNone(given.style) && Option.isNone(given.explode)
			return {
				contentType: [],
				rows: [
					"ENC-01",
					...(Option.isSome(given.style) ? ["ENC-04"] : []),
					...(Option.isSome(given.explode) ? ["ENC-05"] : []),
					...(allowReservedAlone ? ["ENC-06"] : []),
					"ENC-13"
				],
				refused: false
			}
		},
		onNone: () =>
			Option.match(value.contentType, {
				onNone: () => ({ contentType: [tableType], rows: ["ENC-01", tableRow], refused: false }),
				onSome: (given) => {
					if (given === "image png" || given === "") {
						typingFindings.push(
							raw("ENC-02/invalid-content-type", "refusal", `${actual}/contentType`, true)
						)
						return { contentType: [], rows: [], refused: true }
					}
					const types = given === "image/png, image/*" ? ["image/png", "image/*"] : [given]
					if (
						(given === "application/xml" || given === "text/xml") &&
						(part.schema === "object" ||
							part.schema === "refObject" ||
							part.schema === "mixedTypes")
					) {
						typingFindings.push(
							raw("XML-01/schema-driven", "refusal", `${actual}/contentType`, true)
						)
						return { contentType: [], rows: [], refused: true }
					}
					return { contentType: types, rows: ["ENC-01", "ENC-02"], refused: false }
				}
			})
	})
	if (typed.refused) {
		return { rule: Option.none(), findings: typingFindings }
	}
	const transfer = transferOf(part, sketch.line)
	if (transfer.kind === "refused") {
		return {
			rule: Option.none(),
			findings: [
				...typingFindings,
				raw("ENC-37/unsupported-content-encoding", "refusal", transfer.at, true)
			]
		}
	}
	const pairs = Option.exists(
		styled,
		(given) =>
			Option.getOrElse(given.style, () => "form") === "form" &&
			Option.getOrElse(given.explode, () => true)
	)
	const unsupported = Option.isSome(styled) && !pairs
	const styleFindings: ReadonlyArray<Raw> = unsupported
		? [raw("ENC-40/unsupported-part-style", "refusal", actual, false)]
		: []
	const headerFindings: Array<Raw> = []
	const kept: Array<readonly [string, boolean]> = []
	let declares = false
	for (const name of value.headers) {
		const at = `${actual}/headers/${name}`
		if (name === "Content-Type") {
			headerFindings.push(raw("ENC-11/content-type-header-ignored", "notice", at, false))
			continue
		}
		declares = true
		if (name === "bad name") {
			headerFindings.push(raw("ENC-03/invalid-header-name", "refusal", at, true))
			return {
				rule: Option.none(),
				findings: [...typingFindings, ...headerFindings, ...styleFindings]
			}
		}
		if (name === "Content-Transfer-Encoding" || name === "Content-Disposition") {
			headerFindings.push(raw("ENC-03/writer-owned-header", "notice", at, false))
			continue
		}
		kept.push([name, value.required])
	}
	if (transfer.kind === "base64" && Arr.contains(value.headers, "Content-Transfer-Encoding")) {
		const conflict = Option.filter(value.transfer, (schema) => !schema.admits)
		if (Option.isSome(conflict)) {
			return {
				rule: Option.none(),
				findings: [
					...typingFindings,
					...Arr.filter(headerFindings, (each) => each.code !== "ENC-03/writer-owned-header"),
					raw(
						"ENC-39/conflicting-transfer-encoding",
						"refusal",
						`${actual}/headers/Content-Transfer-Encoding/schema/${conflict.value.keyword}`,
						true
					)
				]
			}
		}
	}
	return {
		rule: Option.some({
			target: part.name,
			contentType: pairs ? ["text/plain"] : typed.contentType,
			contentEncoding: transfer.kind === "base64" ? Option.some("base64") : Option.none(),
			rows: Arr.sort(
				Arr.dedupe([
					...typed.rows,
					...(declares ? ["ENC-03"] : []),
					...(transfer.kind === "base64" || transfer.kind === "raw" ? [transfer.row] : []),
					...(Option.isSome(styled) ? ["ENC-40"] : [])
				]),
				Order.String
			),
			headers: kept,
			serialization: Option.isSome(styled)
		}),
		findings: [...typingFindings, ...headerFindings, ...styleFindings]
	}
}

/** The multipart alternative normalized, its findings placed as design 6.3 and 8.5 place them. */
export const expectedOf = (sketch: MultipartSketch): MultipartModel => {
	const located = (
		each: Raw,
		scope: string,
		pointer: string,
		related: ReadonlyArray<string>,
		wire: string
	): Located => [each.code, each.severity, scope, pointer, Arr.join(related, " "), wire]
	const dropped = (findings: ReadonlyArray<Raw>): MultipartModel => ({
		alternative: Option.none(),
		findings: Arr.map(findings, (each) =>
			each.drops
				? located(each, "element", media, [each.at], "")
				: located(each, "element", each.at, [], "")
		)
	})
	const extra: ReadonlyArray<Raw> =
		sketch.extra === "map"
			? [
					raw(
						"SCH-13/multipart-extra-fields",
						"refusal",
						`${media}/schema/additionalProperties`,
						false
					)
				]
			: []
	if (sketch.ghost && sketch.line !== "3.2") {
		return dropped([
			...extra,
			raw("MED-11/unknown-property", "refusal", `${media}/encoding/ghost`, true)
		])
	}
	const keys: ReadonlyArray<Raw> = sketch.ghost
		? [raw("MED-12/absent-property-ignored", "notice", `${media}/encoding/ghost`, false)]
		: []
	const built: Array<Raw> = [...extra, ...keys]
	const rules: Array<RuleModel> = []
	for (const part of sketch.parts) {
		const result = ruleOf(sketch, part)
		for (const finding of result.findings) {
			built.push(finding)
		}
		if (Option.isNone(result.rule)) {
			return dropped(built)
		}
		rules.push(result.rule.value)
	}
	const unsupported = Arr.filter(sketch.parts, (part) =>
		Arr.some(
			built,
			(each) =>
				each.code === "ENC-40/unsupported-part-style" &&
				each.at === `${media}/encoding/${part.name}`
		)
	)
	if (Arr.some(unsupported, (part) => part.required)) {
		return dropped(
			Arr.map(built, (each) =>
				each.code === "ENC-40/unsupported-part-style" ? { ...each, drops: true } : each
			)
		)
	}
	return {
		alternative: Option.some({ rules, refusedFields: Arr.map(unsupported, (part) => part.name) }),
		findings: Arr.map(built, (each) => {
			const part = Arr.findFirst(
				unsupported,
				(one) =>
					each.code === "ENC-40/unsupported-part-style" &&
					each.at === `${media}/encoding/${one.name}`
			)
			return Option.match(part, {
				onNone: () => located(each, "element", each.at, [], ""),
				onSome: (one) => located(each, "field", each.at, [], one.name)
			})
		})
	}
}

/** The multipart alternative as normalizeBody gives it. */
export const actualOf = (sketch: MultipartSketch) =>
	Effect.gen(function* () {
		const resolution = yield* resolvedAt(sketch.line, documentOf(sketch), [])
		const outcome = yield* normalizeBody(resolution, {
			openapi: openapiOf[sketch.line],
			pointer: bodyPointer
		})
		const model: MultipartModel = {
			alternative:
				outcome._tag === "Implemented"
					? Option.map(Arr.head(outcome.body.alternatives), (found) => ({
							rules: Arr.map(found.encoding, (rule) => ({
								target:
									rule.target.kind === "property" ? rule.target.name : `#${rule.target.index}`,
								contentType: Arr.map(rule.contentType, String),
								contentEncoding: Option.fromUndefinedOr(rule.contentEncoding),
								rows: Arr.map(rule.rows, String),
								headers: Arr.map(
									rule.headers,
									(header) => [String(header.name), header.required] as const
								),
								serialization: rule.serialization !== undefined
							})),
							refusedFields: Arr.map(found.refusedFields ?? [], String)
						}))
					: Option.none(),
			findings: Arr.map(outcome.diagnostics, (each): Located => [
				each.code,
				each.severity,
				each.scope,
				String(each.pointer),
				Arr.join(
					Arr.map(each.related ?? [], (site) => String(site.pointer)),
					" "
				),
				each.wire ?? ""
			])
		}
		return model
	})

/** The features a sketch and its model reach. */
export const multipartFeatures = (
	sketch: MultipartSketch,
	model: MultipartModel
): ReadonlyArray<MultipartFeature> => {
	const codes = Arr.map(model.findings, ([code, , scope]) => `${code} ${scope}`)
	const has = (text: string) => Arr.some(codes, (code) => Str.startsWith(text)(code))
	const rules = Option.getOrElse(
		Option.map(model.alternative, (found) => found.rules),
		(): ReadonlyArray<RuleModel> => []
	)
	const facts: ReadonlyArray<readonly [boolean, MultipartFeature]> = [
		[Arr.some(rules, (rule) => Arr.contains(rule.rows, "ENC-38")), "3.0 format byte sent base64"],
		[
			Arr.some(
				rules,
				(rule) => Arr.contains(rule.rows, "ENC-37") && Option.isSome(rule.contentEncoding)
			),
			"3.1 contentEncoding base64"
		],
		[
			Arr.some(
				rules,
				(rule) => Arr.contains(rule.rows, "ENC-37") && Option.isNone(rule.contentEncoding)
			),
			"identity contentEncoding sent raw"
		],
		[has("ENC-37/unsupported-content-encoding"), "unsupported contentEncoding refused"],
		[
			Arr.some(sketch.parts, (part) => part.schema === "base64s" || part.schema === "bytes") &&
				Arr.isReadonlyArrayNonEmpty(rules),
			"array of base64 items"
		],
		[Arr.some(rules, (rule) => rule.contentType.length > 1), "comma-separated contentType"],
		[has("ENC-02/invalid-content-type"), "contentType that is no list refused"],
		[has("XML-01/schema-driven"), "object part typed as XML refused"],
		[Arr.some(rules, (rule) => Arr.isReadonlyArrayNonEmpty(rule.headers)), "typed part header"],
		[has("ENC-11/content-type-header-ignored"), "Content-Type header ignored"],
		[has("ENC-03/writer-owned-header"), "writer-owned header"],
		[has("ENC-03/invalid-header-name"), "header name no token refused"],
		[
			Arr.some(rules, (rule) => Option.isSome(rule.contentEncoding)) &&
				Arr.some(sketch.parts, (part) =>
					Option.exists(
						part.entry,
						(value) =>
							Arr.contains(value.headers, "Content-Transfer-Encoding") &&
							Option.exists(value.transfer, (schema) => schema.admits)
					)
				),
			"transfer header admits base64"
		],
		[has("ENC-39/conflicting-transfer-encoding"), "transfer header conflict refused"],
		[
			Arr.some(rules, (rule) => rule.serialization && Arr.contains(rule.contentType, "text/plain")),
			"form pairs style"
		],
		[has("ENC-40/unsupported-part-style field"), "unsupported part style refused at field scope"],
		[has("ENC-40/unsupported-part-style element"), "unsupported part style drops the alternative"],
		[has("ENC-12/style-ignored"), "3.0 multipart style ignored"],
		[has("MED-11/") || has("MED-12/"), "unknown encoding key"],
		[has("SCH-13/"), "additionalProperties map refused"],
		[
			Arr.some(rules, (rule) =>
				Arr.some(
					sketch.parts,
					(part) =>
						part.name === rule.target &&
						(part.schema === "refObject" || part.schema === "allOfString")
				)
			),
			"part typed through a reference or allOf"
		],
		[
			Arr.some(rules, (rule) =>
				Arr.some(
					sketch.parts,
					(part) =>
						part.name === rule.target &&
						(part.schema === "nullableString" || part.schema === "mixedTypes")
				)
			),
			"type list read without null or as disagreeing"
		]
	]
	return Arr.map(
		Arr.filter(facts, ([holds]) => holds),
		([, feature]) => feature
	)
}

/** A position's or item's schema: text, an integer, a binary-format string (3.2 reads no format) or an object. */
type ItemKind = "string" | "integer" | "binary" | "object"

/** An explicit contentType of a positional or nested entry, or none (the default table decides). */
type EntryType = Option.Option<"text/csv" | "image/png">

/** A nested entry: its contentType, or a deeper nesting (refused), and a nested part declaring base64 (refused). */
type NestedEntry = Readonly<{ contentType: EntryType; deeper: boolean }>

/**
 * A 3.2 body read by position: multipart/mixed (every prefixItems position a rule) or multipart/related (only declared
 * entries), its array schema or itemSchema, its prefixEncoding and itemEncoding, and an `encoding` beside them; or a
 * form-data part nesting one level by name, by position and by item.
 */
type PositionalSketch =
	| Readonly<{
			kind: "positional"
			key: "multipart/mixed" | "multipart/related"
			schema: Option.Option<
				Readonly<{
					prefixItems: ReadonlyArray<ItemKind>
					items: Option.Option<ItemKind | "closed">
				}>
			>
			itemSchema: Option.Option<ItemKind>
			prefixEncoding: Option.Option<ReadonlyArray<EntryType>>
			itemEncoding: Option.Option<EntryType>
			conflict: boolean
	  }>
	| Readonly<{
			kind: "nested"
			part: "object" | "array"
			base64Note: boolean
			byName: Option.Option<NestedEntry>
			byPosition: Option.Option<ReadonlyArray<EntryType>>
			item: Option.Option<NestedEntry>
	  }>

/** What a case reaches. */
export type PositionalFeature =
	| "prefixItems positions by the default table"
	| "explicit position contentType"
	| "item rule by the default table"
	| "item rule from itemSchema"
	| "closed items give no item rule"
	| "multipart/related positions only as declared"
	| "encoding beside positional fields refused"
	| "nested by name"
	| "nested by position"
	| "nested item rule"
	| "second nested level refused"
	| "nested base64 part refused"
	| "nesting part sent base64"

const itemKind: Gen<ItemKind> = oneOf([
	constant<ItemKind>("string"),
	constant<ItemKind>("integer"),
	constant<ItemKind>("binary"),
	constant<ItemKind>("object")
])

const entryType: Gen<EntryType> = option(
	oneOf([constant<"text/csv">("text/csv"), constant<"image/png">("image/png")])
)

const nestedEntry: Gen<NestedEntry> = (source) => ({
	contentType: entryType(source),
	deeper: rare(source) && boolean(source)
})

/** 3.2 positional bodies and nesting parts, each field drawn present or absent. */
const drawnPositional: Gen<PositionalSketch> = oneOf([
	(source): PositionalSketch => {
		const withSchema = boolean(source)
		return {
			kind: "positional",
			key: weighted<"multipart/mixed" | "multipart/related">([
				[3, constant("multipart/mixed")],
				[1, constant("multipart/related")]
			])(source),
			schema: withSchema
				? Option.some({
						prefixItems: array(itemKind, { min: 0, max: 2 })(source),
						items: option(oneOf([itemKind, constant<"closed">("closed")]))(source)
					})
				: Option.none(),
			itemSchema: withSchema ? Option.none() : option(itemKind)(source),
			prefixEncoding: option(array(entryType, { min: 0, max: 3 }))(source),
			itemEncoding: option(entryType)(source),
			conflict: rare(source) && boolean(source)
		}
	},
	(source): PositionalSketch => ({
		kind: "nested",
		part: oneOf([constant<"object">("object"), constant<"array">("array")])(source),
		base64Note: rare(source) && boolean(source),
		byName: option(nestedEntry)(source),
		byPosition: option(array(entryType, { min: 1, max: 2 }))(source),
		item: option(nestedEntry)(source)
	})
])

/** Positional bodies and nesting parts, aimed at the refusals a draw reaches rarely. */
export const positionalSpace = aimed<PositionalSketch, PositionalFeature>(drawnPositional, [
	[
		"nested base64 part refused",
		oneOf([
			constant<PositionalSketch>({
				kind: "nested",
				part: "object",
				base64Note: true,
				byName: Option.some({ contentType: Option.none(), deeper: false }),
				byPosition: Option.none(),
				item: Option.none()
			}),
			constant<PositionalSketch>({
				kind: "nested",
				part: "array",
				base64Note: true,
				byName: Option.none(),
				byPosition: Option.none(),
				item: Option.some({ contentType: Option.none(), deeper: false })
			})
		])
	],
	[
		"nesting part sent base64",
		constant<PositionalSketch>({
			kind: "nested",
			part: "array",
			base64Note: true,
			byName: Option.none(),
			byPosition: Option.some([Option.none()]),
			item: Option.none()
		})
	],
	[
		"second nested level refused",
		constant<PositionalSketch>({
			kind: "nested",
			part: "object",
			base64Note: false,
			byName: Option.some({ contentType: Option.none(), deeper: true }),
			byPosition: Option.none(),
			item: Option.none()
		})
	],
	[
		"encoding beside positional fields refused",
		constant<PositionalSketch>({
			kind: "positional",
			key: "multipart/mixed",
			schema: Option.none(),
			itemSchema: Option.none(),
			prefixEncoding: Option.none(),
			itemEncoding: Option.some(Option.none()),
			conflict: true
		})
	],
	[
		"closed items give no item rule",
		constant<PositionalSketch>({
			kind: "positional",
			key: "multipart/mixed",
			schema: Option.some({ prefixItems: ["string"], items: Option.some("closed") }),
			itemSchema: Option.none(),
			prefixEncoding: Option.none(),
			itemEncoding: Option.none(),
			conflict: false
		})
	]
])

const itemJson = (value: ItemKind): Json => {
	switch (value) {
		case "string":
			return { type: "string" }
		case "integer":
			return { type: "integer" }
		case "binary":
			return { format: "binary", type: "string" }
		case "object":
			return { properties: { a: { type: "string" } }, type: "object" }
	}
}

/** The default table (3.2) for a position's or item's schema: its row and type, an absent schema octet-stream. */
const itemTable = (value: Option.Option<ItemKind>): readonly [string, string] =>
	Option.match(value, {
		onNone: () => ["ENC-17", "application/octet-stream"] as const,
		onSome: (kind) => {
			switch (kind) {
				case "string":
				case "binary":
					return ["ENC-20", "text/plain"] as const
				case "integer":
					return ["ENC-21", "text/plain"] as const
				case "object":
					return ["ENC-22", "application/json"] as const
			}
		}
	})

const entryJsonOf = (value: EntryType): Readonly<Record<string, Json>> =>
	Option.match(value, { onNone: () => ({}), onSome: (contentType) => ({ contentType }) })

const nestedJson = (value: NestedEntry): Json => ({
	...entryJsonOf(value.contentType),
	...(value.deeper ? { encoding: { deep: {} } } : {})
})

/** The 3.2 document holding the sketch's body. */
const positionalDocument = (sketch: PositionalSketch): Json => {
	const content: Json =
		sketch.kind === "positional"
			? {
					[sketch.key]: {
						...Option.match(sketch.schema, {
							onNone: () => ({}),
							onSome: (schema) => ({
								schema: {
									prefixItems: Arr.map(schema.prefixItems, itemJson),
									type: "array",
									...Option.match(schema.items, {
										onNone: () => ({}),
										onSome: (items) => ({ items: items === "closed" ? false : itemJson(items) })
									})
								}
							})
						}),
						...Option.match(sketch.itemSchema, {
							onNone: () => ({}),
							onSome: (kind) => ({ itemSchema: itemJson(kind) })
						}),
						...Option.match(sketch.prefixEncoding, {
							onNone: () => ({}),
							onSome: (entries) => ({ prefixEncoding: Arr.map(entries, entryJsonOf) })
						}),
						...Option.match(sketch.itemEncoding, {
							onNone: () => ({}),
							onSome: (entry) => ({ itemEncoding: entryJsonOf(entry) })
						}),
						...(sketch.conflict ? { encoding: { a: {} } } : {})
					}
				}
			: {
					"multipart/form-data": {
						schema: {
							properties: {
								batch:
									sketch.part === "object"
										? {
												properties: {
													note: sketch.base64Note
														? { contentEncoding: "base64", type: "string" }
														: { type: "string" }
												},
												type: "object"
											}
										: {
												items: sketch.base64Note
													? { contentEncoding: "base64", type: "string" }
													: { type: "string" },
												type: "array"
											}
							},
							type: "object"
						},
						encoding: {
							batch: {
								contentType: "multipart/mixed",
								...Option.match(sketch.byName, {
									onNone: () => ({}),
									onSome: (entry) => ({ encoding: { note: nestedJson(entry) } })
								}),
								...Option.match(sketch.byPosition, {
									onNone: () => ({}),
									onSome: (entries) => ({ prefixEncoding: Arr.map(entries, entryJsonOf) })
								}),
								...Option.match(sketch.item, {
									onNone: () => ({}),
									onSome: (entry) => ({ itemEncoding: nestedJson(entry) })
								})
							}
						}
					}
				}
	return documentAt("3.2", {
		paths: {
			"/a": { post: { requestBody: { content }, responses: { "200": { description: "ok" } } } }
		}
	})
}

/** A positional or nested rule as the model states it: target, contentType and rows. */
type Positioned = readonly [
	target: string,
	contentType: ReadonlyArray<string>,
	rows: ReadonlyArray<string>
]

/** The 3.2 alternative's positional and nested rules, as design 6.3 states them, or the code that refuses it. */
type PositionalModel =
	| Readonly<{
			kind: "kept"
			rows: ReadonlyArray<string>
			prefix: ReadonlyArray<Positioned>
			item: Option.Option<Positioned>
			nested: Option.Option<
				Readonly<{
					rows: ReadonlyArray<string>
					nested: ReadonlyArray<readonly [string, ReadonlyArray<string>]>
					item: Option.Option<readonly [string, ReadonlyArray<string>]>
				}>
			>
	  }>
	| Readonly<{ kind: "refused"; codes: ReadonlyArray<string> }>

const typed = (target: string, given: EntryType, schema: Option.Option<ItemKind>): Positioned =>
	Option.match(given, {
		onNone: () => {
			const [row, type] = itemTable(schema)
			return [target, [type], Arr.sort(["ENC-01", row], Order.String)] as const
		},
		onSome: (type) => [target, [type], ["ENC-01", "ENC-02"]] as const
	})

/** The alternative as design 6.3 states it. */
export const positionalExpected = (sketch: PositionalSketch): PositionalModel => {
	if (sketch.kind === "positional") {
		const positional = Option.isSome(sketch.prefixEncoding) || Option.isSome(sketch.itemEncoding)
		if (sketch.conflict && positional) {
			return { kind: "refused", codes: ["MED-13/encoding-with-positional"] }
		}
		const mixed = sketch.key === "multipart/mixed"
		const prefixItems = Option.match(sketch.schema, {
			onNone: () => [],
			onSome: (schema) => schema.prefixItems
		})
		const entries = Option.getOrElse(sketch.prefixEncoding, () => [])
		const count = mixed ? Math.max(entries.length, prefixItems.length) : entries.length
		const prefix = Arr.map(
			Array.from({ length: count }, (_unused, index) => index),
			(index) =>
				typed(
					`#${index}`,
					Option.flatten(Option.fromUndefinedOr(entries[index])),
					Option.fromUndefinedOr(prefixItems[index])
				)
		)
		const itemSchema = Option.orElse(sketch.itemSchema, () =>
			Option.flatMap(sketch.schema, (schema) =>
				Option.filter(schema.items, (items): items is ItemKind => items !== "closed")
			)
		)
		const defaulted = mixed && Option.isSome(itemSchema)
		const item =
			Option.isSome(sketch.itemEncoding) || defaulted
				? Option.some(typed(`#${count}`, Option.flatten(sketch.itemEncoding), itemSchema))
				: Option.none()
		const schema = Option.isSome(sketch.schema)
		return {
			kind: "kept",
			rows: Arr.sort(
				[
					"MED-01",
					...(schema ? ["MED-02"] : []),
					...(Option.isSome(sketch.itemSchema) ? ["MED-03"] : []),
					...(sketch.conflict ? ["MED-06"] : []),
					...(Option.isSome(sketch.prefixEncoding) ? ["MED-07"] : []),
					...(Option.isSome(sketch.itemEncoding) ? ["MED-08"] : []),
					...(schema || Option.isSome(sketch.itemSchema) ? [] : ["RQB-09"])
				],
				Order.String
			),
			prefix,
			item,
			nested: Option.none()
		}
	}
	const refusalOf = (entry: NestedEntry, base64: boolean): Option.Option<string> =>
		base64
			? Option.some("ENC-37/nested-transfer-encoding")
			: entry.deeper
				? Option.some("ENC-16/nesting-too-deep")
				: Option.none()
	const refused = Option.firstSomeOf([
		Option.flatMap(sketch.byName, (entry) =>
			refusalOf(entry, sketch.base64Note && sketch.part === "object")
		),
		Option.flatMap(sketch.item, (entry) =>
			refusalOf(entry, sketch.base64Note && sketch.part === "array")
		)
	])
	if (Option.isSome(refused)) {
		return { kind: "refused", codes: [refused.value] }
	}
	const byName: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = Option.match(
		sketch.byName,
		{
			onNone: () => [],
			onSome: (entry) => [
				[
					"note",
					Option.match(entry.contentType, {
						onNone: () => [sketch.part === "object" ? "text/plain" : "application/octet-stream"],
						onSome: (type) => [type]
					})
				] as const
			]
		}
	)
	const positions = Option.getOrElse(sketch.byPosition, () => [])
	const byPosition = Arr.map(
		positions,
		(entry, index) =>
			[
				`#${index}`,
				Option.match(entry, {
					onNone: () => ["application/octet-stream"],
					onSome: (type) => [type]
				})
			] as const
	)
	return {
		kind: "kept",
		rows: ["MED-01", "MED-02", "MED-06"],
		prefix: [],
		item: Option.none(),
		nested: Option.some({
			rows: Arr.sort(
				[
					"ENC-01",
					"ENC-02",
					...(Option.isSome(sketch.byName) ? ["ENC-07"] : []),
					...(Option.isSome(sketch.byPosition) ? ["ENC-08"] : []),
					...(Option.isSome(sketch.item) ? ["ENC-09"] : []),
					...(sketch.base64Note && sketch.part === "array" ? ["ENC-37"] : [])
				],
				Order.String
			),
			nested: [...byName, ...byPosition],
			item: Option.map(
				sketch.item,
				(entry) =>
					[
						`#${positions.length}`,
						Option.match(entry.contentType, {
							onNone: () => [sketch.part === "array" ? "text/plain" : "application/octet-stream"],
							onSome: (type) => [type]
						})
					] as const
			)
		})
	}
}

/** The alternative as normalizeBody gives it. */
export const positionalActual = (sketch: PositionalSketch) =>
	Effect.gen(function* () {
		const resolution = yield* resolvedAt("3.2", positionalDocument(sketch), [])
		const outcome = yield* normalizeBody(resolution, {
			openapi: openapiOf["3.2"],
			pointer: bodyPointer
		})
		const target = (
			each: Readonly<{
				target:
					| Readonly<{ kind: "property"; name: string }>
					| Readonly<{ kind: "position"; index: number }>
			}>
		): string => (each.target.kind === "property" ? each.target.name : `#${each.target.index}`)
		const positioned = (
			rule: Readonly<{ contentType: ReadonlyArray<string>; rows: ReadonlyArray<string> }> &
				Parameters<typeof target>[0]
		): Positioned => [target(rule), Arr.map(rule.contentType, String), Arr.map(rule.rows, String)]
		const model: PositionalModel =
			outcome._tag === "Refused"
				? {
						kind: "refused",
						codes: Arr.map(
							Arr.filter(outcome.diagnostics, (each) => each.severity === "refusal"),
							(each) => each.code
						)
					}
				: Option.match(Arr.head(outcome.body.alternatives), {
						onNone: () => ({ kind: "refused", codes: [] }),
						onSome: (found): PositionalModel => ({
							kind: "kept",
							rows: Arr.map(found.rows, String),
							prefix: Arr.map(found.prefixEncoding, positioned),
							item: Option.map(Option.fromUndefinedOr(found.itemEncoding), positioned),
							nested: Option.map(Arr.head(found.encoding), (rule) => ({
								rows: Arr.map(rule.rows, String),
								nested: Arr.map(
									rule.nested ?? [],
									(each) => [target(each), Arr.map(each.contentType, String)] as const
								),
								item: Option.map(
									Option.fromUndefinedOr(rule.nestedItem),
									(each) => [target(each), Arr.map(each.contentType, String)] as const
								)
							}))
						})
					})
		return model
	})

/** The features a sketch and its model reach. */
export const positionalFeatures = (
	sketch: PositionalSketch,
	model: PositionalModel
): ReadonlyArray<PositionalFeature> => {
	const codes = model.kind === "refused" ? model.codes : []
	const kept = model.kind === "kept" ? Option.some(model) : Option.none()
	const facts: ReadonlyArray<readonly [boolean, PositionalFeature]> =
		sketch.kind === "positional"
			? [
					[
						Option.exists(kept, (found) =>
							Arr.some(found.prefix, ([, , rows]) => !Arr.contains(rows, "ENC-02"))
						) && sketch.key === "multipart/mixed",
						"prefixItems positions by the default table"
					],
					[
						Option.exists(kept, (found) =>
							Arr.some(found.prefix, ([, , rows]) => Arr.contains(rows, "ENC-02"))
						),
						"explicit position contentType"
					],
					[
						Option.exists(kept, (found) =>
							Option.exists(found.item, ([, , rows]) => !Arr.contains(rows, "ENC-02"))
						),
						"item rule by the default table"
					],
					[
						Option.isSome(sketch.itemSchema) &&
							Option.exists(kept, (found) => Option.isSome(found.item)),
						"item rule from itemSchema"
					],
					[
						Option.exists(sketch.schema, (schema) =>
							Option.exists(schema.items, (items) => items === "closed")
						) && Option.exists(kept, (found) => Option.isNone(found.item)),
						"closed items give no item rule"
					],
					[
						sketch.key === "multipart/related" && Option.isSome(kept),
						"multipart/related positions only as declared"
					],
					[
						Arr.contains(codes, "MED-13/encoding-with-positional"),
						"encoding beside positional fields refused"
					]
				]
			: [
					[
						Option.exists(kept, (found) =>
							Option.exists(found.nested, (nested) =>
								Arr.some(nested.nested, ([name]) => name === "note")
							)
						),
						"nested by name"
					],
					[
						Option.exists(kept, (found) =>
							Option.exists(found.nested, (nested) =>
								Arr.some(nested.nested, ([name]) => Str.startsWith("#")(name))
							)
						),
						"nested by position"
					],
					[
						Option.exists(kept, (found) =>
							Option.exists(found.nested, (nested) => Option.isSome(nested.item))
						),
						"nested item rule"
					],
					[Arr.contains(codes, "ENC-16/nesting-too-deep"), "second nested level refused"],
					[Arr.contains(codes, "ENC-37/nested-transfer-encoding"), "nested base64 part refused"],
					[
						Option.exists(kept, (found) =>
							Option.exists(found.nested, (nested) => Arr.contains(nested.rows, "ENC-37"))
						),
						"nesting part sent base64"
					]
				]
	return Arr.map(
		Arr.filter(facts, ([holds]) => holds),
		([, feature]) => feature
	)
}

/** A 3.0 multipart part schema carrying 3.1's `contentEncoding`: on the part itself or on a member of an object part. */
type KeywordSketch = Readonly<{
	part: "file" | "meta"
	depth: "part" | "member"
	siblings: boolean
}>

/** Where the 3.1 keyword sits, and whether other parts stand beside its part. */
export const keywordSpace: Gen<KeywordSketch> = (source) => ({
	part: oneOf([constant<"file">("file"), constant<"meta">("meta")])(source),
	depth: oneOf([constant<"part">("part"), constant<"member">("member")])(source),
	siblings: boolean(source)
})

/** The 3.0 document whose multipart part schema carries `contentEncoding` where the sketch puts it. */
const keywordDocument = (sketch: KeywordSketch): Json => {
	const keyword: Json = { contentEncoding: "identity", type: "string" }
	const part: Json =
		sketch.depth === "part" ? keyword : { properties: { inner: keyword }, type: "object" }
	return documentAt("3.0", {
		paths: {
			"/a": {
				post: {
					requestBody: {
						content: {
							"multipart/form-data": {
								schema: {
									properties: {
										[sketch.part]: part,
										...(sketch.siblings ? { note: { type: "string" } } : {})
									},
									type: "object"
								}
							}
						}
					},
					responses: { "200": { description: "ok" } }
				}
			}
		}
	})
}

/** The one refusal 3.0 schema validation states: VAL-02 at the 3.1 keyword itself, document scope. */
export const keywordExpected = (
	sketch: KeywordSketch
): ReadonlyArray<readonly [string, string, string]> => [
	[
		"VAL-02/schema-invalid",
		`${media}/schema/properties/${sketch.part}${sketch.depth === "part" ? "" : "/properties/inner"}/contentEncoding`,
		"document"
	]
]

/** The refusals diagnoseDocument gives the document. */
export const keywordActual = (sketch: KeywordSketch, digest: typeof Digest.Digest.Service) =>
	Effect.gen(function* () {
		const document = entryUri
		const diagnosis = yield* diagnoseDocument(keywordDocument(sketch), document).pipe(
			Effect.provideService(Digest.Digest, digest)
		)
		return Arr.map(
			diagnosis.refusals,
			({ diagnostic }) => [diagnostic.code, String(diagnostic.pointer), diagnostic.scope] as const
		)
	})
