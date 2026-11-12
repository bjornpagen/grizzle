/**
 * OpenAPI documents and their author configs, valid by construction. A document is drawn as a sketch: its line (3.0,
 * 3.1 or 3.2), servers, tags, components, security schemes, webhooks and operations, each operation with path
 * parameters that match its template, query, header and cookie parameters by schema or by content, a querystring
 * parameter on 3.2, request bodies of every codec the generator reads (JSON, form, multipart with encodings and part
 * headers, binary, text, XML, the sequential media types and a refused event stream), responses with content and
 * headers, security requirements and deprecation marks. `documentOf` renders a sketch to the document for its line, and
 * `configGen` draws an author config that fits it: its accepted servers, the scheme environment names, the
 * non-standard switches and command overrides by operation id. Suites read what a document holds from its sketch, never
 * by parsing what was rendered.
 *
 * Every operation is one the generator accepts, but for the event stream body, the one refusal drawn on purpose: a
 * parameter's style and explode are a row the style table builds for its schema, location and line; a path parameter
 * is a scalar that is no boolean; a boolean switch is never required; an array never lists passwords; a body's
 * alternatives share its fields, so a field is one flag; no field, part or parameter shares a flag; and a security
 * requirement uses at most one scheme that writes the Authorization header. A suite that needs a refusal plants it.
 */
import { jsonTextOf } from "@superstarter/json"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	option,
	shuffled,
	subarray,
	uniqueArray,
	weighted,
	type Weighted
} from "@superstarter/testing/gen"
import { Array as Arr, Option, Record, Schema, String as Str } from "effect"

/** The OpenAPI lines the generator reads, each written with its latest patch version. */
export type Line = "3.0" | "3.1" | "3.2"

const VERSIONS: Readonly<Record<Line, string>> = { "3.0": "3.0.4", "3.1": "3.1.2", "3.2": "3.2.0" }

/** A schema, as far as the generator's flags, serializers and domain module tell schemas apart. */
export type SchemaSketch =
	| Readonly<{ kind: "string"; format: Option.Option<StringFormat>; values: ReadonlyArray<string> }>
	| Readonly<{ kind: "integer"; format: Option.Option<"int32" | "int64"> }>
	| Readonly<{ kind: "number" }>
	| Readonly<{ kind: "boolean" }>
	| Readonly<{ kind: "array"; items: SchemaSketch }>
	| Readonly<{ kind: "object"; properties: ReadonlyArray<PropertySketch>; closed: boolean }>
	| Readonly<{ kind: "nullable"; type: ScalarType }>
	| Readonly<{ kind: "ref"; component: string }>
	| Readonly<{ kind: "oneOf"; members: ReadonlyArray<string>; discriminator: boolean }>

export type StringFormat = "date-time" | "uuid" | "password" | "binary" | "byte"

export type ScalarType = "string" | "integer" | "number" | "boolean"

/** A property of an object schema, with the annotations help reads. */
export type PropertySketch = Readonly<{
	name: string
	schema: SchemaSketch
	required: boolean
	readOnly: boolean
	deprecated: boolean
	description: Option.Option<string>
	defaultValue: Option.Option<Schema.Json>
}>

/** A named schema under `components/schemas`, always an object so a `$ref` to it may recur through it. */
export type ComponentSketch = Readonly<{ name: string; properties: ReadonlyArray<PropertySketch> }>

export type Location = "path" | "query" | "header" | "cookie"

export type Style =
	| "simple"
	| "label"
	| "matrix"
	| "form"
	| "spaceDelimited"
	| "pipeDelimited"
	| "deepObject"
	| "cookie"

/** A parameter's value: by schema with an optional style and explode, or by one content media type. */
export type Serialization =
	| Readonly<{
			kind: "schema"
			schema: SchemaSketch
			style: Option.Option<Style>
			explode: Option.Option<boolean>
	  }>
	| Readonly<{
			kind: "content"
			mediaType: "application/json" | "text/plain"
			schema: SchemaSketch
	  }>

export type ParameterSketch = Readonly<{
	location: Location
	name: string
	required: boolean
	deprecated: boolean
	description: Option.Option<string>
	serialization: Serialization
}>

/** A multipart part: a property of the body's object schema, with its Encoding Object. */
export type PartSketch = Readonly<{
	name: string
	schema: SchemaSketch
	required: boolean
	contentTypes: ReadonlyArray<string>
	headers: ReadonlyArray<Readonly<{ name: string; required: boolean; deprecated: boolean }>>
}>

/** One media type of a request body. */
export type AlternativeSketch =
	| Readonly<{
			kind: "json"
			mediaType: "application/json" | "application/merge-patch+json"
			schema: SchemaSketch
	  }>
	| Readonly<{
			kind: "form"
			properties: ReadonlyArray<PropertySketch>
			encodings: ReadonlyArray<
				Readonly<{ name: string; style: Option.Option<Style>; explode: Option.Option<boolean> }>
			>
	  }>
	| Readonly<{ kind: "multipart"; parts: ReadonlyArray<PartSketch> }>
	| Readonly<{ kind: "binary"; mediaType: "application/octet-stream" | "image/png" }>
	| Readonly<{ kind: "text"; mediaType: "text/plain" | "text/csv" }>
	| Readonly<{ kind: "xml"; mediaType: "application/xml" }>
	| Readonly<{
			kind: "sequential"
			mediaType: "application/x-ndjson" | "application/jsonl" | "application/json-seq"
			item: SchemaSketch
	  }>
	| Readonly<{ kind: "event-stream" }>
	| Readonly<{ kind: "mixed"; parts: Arr.NonEmptyReadonlyArray<MixedPart> }>

/** One position of a positional `multipart/mixed` body (3.2 `prefixEncoding`): JSON, opaque bytes or text. */
export type MixedPart = "json" | "binary" | "text"

export type BodySketch = Readonly<{
	required: boolean
	description: Option.Option<string>
	alternatives: ReadonlyArray<AlternativeSketch>
}>

export type ResponseContent =
	| Readonly<{ kind: "json"; schema: SchemaSketch }>
	| Readonly<{ kind: "problem" }>
	| Readonly<{ kind: "binary" }>
	| Readonly<{ kind: "text" }>
	| Readonly<{ kind: "event-stream" }>
	| Readonly<{ kind: "ndjson"; item: SchemaSketch }>
	| Readonly<{ kind: "json-seq"; item: SchemaSketch }>

export type ResponseSketch = Readonly<{
	status: string
	description: string
	content: ReadonlyArray<ResponseContent>
	headers: ReadonlyArray<Readonly<{ name: string; required: boolean; deprecated: boolean }>>
}>

/** A security requirement: the schemes one alternative uses together, each with its scopes. */
export type Requirement = ReadonlyArray<readonly [scheme: string, scopes: ReadonlyArray<string>]>

export type Method = "get" | "put" | "post" | "delete" | "patch" | "head" | "options"

export type OperationSketch = Readonly<{
	method: Method
	segments: ReadonlyArray<string>
	operationId: Option.Option<string>
	tags: ReadonlyArray<string>
	summary: Option.Option<string>
	description: Option.Option<string>
	deprecated: boolean
	parameters: ReadonlyArray<ParameterSketch>
	querystring: Option.Option<
		Readonly<{
			mediaType: "application/x-www-form-urlencoded" | "application/json"
			properties: ReadonlyArray<PropertySketch>
		}>
	>
	body: Option.Option<BodySketch>
	responses: ReadonlyArray<ResponseSketch>
	security: Option.Option<ReadonlyArray<Requirement>>
	aliases: ReadonlyArray<Readonly<{ group: string; method: string }>>
}>

export type Flow =
	| "authorizationCode"
	| "clientCredentials"
	| "implicit"
	| "password"
	| "deviceAuthorization"

export type SchemeKind =
	| Readonly<{ type: "apiKey"; in: "header" | "query" | "cookie"; name: string }>
	| Readonly<{ type: "http"; scheme: "basic" | "bearer" }>
	| Readonly<{
			type: "oauth2"
			flows: ReadonlyArray<
				readonly [Flow, ReadonlyArray<readonly [scope: string, description: string]>]
			>
			metadata: boolean
	  }>
	| Readonly<{ type: "openIdConnect" }>
	| Readonly<{ type: "mutualTLS" }>

export type SchemeSketch = Readonly<{ name: string; deprecated: boolean; kind: SchemeKind }>

export type TagSketch = Readonly<{ name: string; parent: Option.Option<string> }>

/** A whole document. */
export type DocumentSketch = Readonly<{
	line: Line
	title: string
	description: Option.Option<string>
	servers: ReadonlyArray<string>
	tags: ReadonlyArray<TagSketch>
	components: ReadonlyArray<ComponentSketch>
	schemes: ReadonlyArray<SchemeSketch>
	security: Option.Option<ReadonlyArray<Requirement>>
	operations: ReadonlyArray<OperationSketch>
	webhooks: ReadonlyArray<string>
}>

/** Prose a spec author may write: plain words, punctuation, non-ASCII, and the controls and format characters help
 * and the README must keep out of a terminal. */
const PROSE: Arr.NonEmptyReadonlyArray<string> = [
	"Update a user.",
	"The id",
	"résumé",
	"中文",
	"tab\there",
	"line\nbreak",
	"\u001b[31mred\u001b[0m",
	"\u202eevil",
	"zero\u200bwidth",
	"\u2028",
	"`code`",
	"*emphasis*",
	Arr.join(["$", "{placeholder}"], "")
]

const prose: Gen<string> = (s) => Arr.join(s.draw(array(element(PROSE), { min: 1, max: 3 })), " ")

const STRING_VALUES: Arr.NonEmptyReadonlyArray<string> = ["a", "b", "active", "on hold", "é", "x-y"]

const STRING_FORMATS: Arr.NonEmptyReadonlyArray<StringFormat> = [
	"date-time",
	"uuid",
	"password",
	"binary",
	"byte"
]

/** The formats an array's string items take: an array of passwords has no flag (FMT-05). */
const ITEM_FORMATS: Arr.NonEmptyReadonlyArray<StringFormat> = [
	"date-time",
	"uuid",
	"binary",
	"byte"
]

const stringSchemaOf =
	(formats: Arr.NonEmptyReadonlyArray<StringFormat>): Gen<SchemaSketch> =>
	(s) => ({
		kind: "string",
		format: s.draw(option(element(formats))),
		values: s.draw(
			weighted<ReadonlyArray<string>>([
				[4, () => []],
				[1, (t) => t.draw(shuffled(STRING_VALUES, { min: 1, max: 3 }))]
			])
		)
	})

const integerSchema: Gen<SchemaSketch> = (s) => ({
	kind: "integer",
	format: s.draw(option(element<"int32" | "int64">(["int32", "int64"])))
})

const scalarSchemaOf = (formats: Arr.NonEmptyReadonlyArray<StringFormat>): Gen<SchemaSketch> =>
	weighted<SchemaSketch>([
		[4, stringSchemaOf(formats)],
		[2, integerSchema],
		[1, () => ({ kind: "number" })],
		[1, () => ({ kind: "boolean" })]
	])

const scalarSchema = scalarSchemaOf(STRING_FORMATS)

const itemSchema = scalarSchemaOf(ITEM_FORMATS)

const PROPERTY_NAMES: Arr.NonEmptyReadonlyArray<string> = [
	"name",
	"id",
	"count",
	"tags",
	"address",
	"created_at",
	"isActive",
	"trace-id",
	"default",
	"nickName"
]

const defaultFor = (schema: SchemaSketch): Gen<Option.Option<Schema.Json>> =>
	schema.kind === "string" && schema.format._tag === "None"
		? option(
				element<Schema.Json>(Arr.isReadonlyArrayNonEmpty(schema.values) ? schema.values : ["x"])
			)
		: schema.kind === "integer"
			? option(map(int(0, 10), (value): Schema.Json => value))
			: () => Option.none()

const propertyOf =
	(schema: Gen<SchemaSketch>) =>
	(name: string): Gen<PropertySketch> =>
	(s) => {
		const drawn = s.draw(schema)
		return {
			name,
			schema: drawn,
			required: s.draw(boolean),
			readOnly: s.draw(
				weighted([
					[9, () => false],
					[1, () => true]
				])
			),
			deprecated: s.draw(
				weighted([
					[9, () => false],
					[1, () => true]
				])
			),
			description: s.draw(option(prose)),
			defaultValue: s.draw(defaultFor(drawn))
		}
	}

/** A schema at most `depth` levels deep, referring only to `components`, its scalars drawn by `scalar`. */
const schemaGen = (
	depth: number,
	components: ReadonlyArray<string>,
	scalar: Gen<SchemaSketch>
): Gen<SchemaSketch> => {
	const refs: ReadonlyArray<readonly [1, Gen<SchemaSketch>]> = Arr.isReadonlyArrayNonEmpty(
		components
	)
		? [
				[1, map(element(components), (component): SchemaSketch => ({ kind: "ref", component }))],
				[
					1,
					(s) => ({
						kind: "oneOf",
						members: s.draw(shuffled(components, { min: 1, max: Math.min(3, components.length) })),
						discriminator: s.draw(boolean)
					})
				]
			]
		: []
	if (depth === 0) {
		return weighted([[6, scalar], ...refs])
	}
	return weighted<SchemaSketch>([
		[6, scalar],
		[2, (s) => ({ kind: "array", items: s.draw(schemaGen(depth - 1, components, itemSchema)) })],
		[2, objectSchema(depth - 1, components)],
		[
			1,
			map(
				element<ScalarType>(["string", "integer", "number", "boolean"]),
				(type): SchemaSketch => ({ kind: "nullable", type })
			)
		],
		...refs
	])
}

const propertiesGen = (
	depth: number,
	components: ReadonlyArray<string>
): Gen<ReadonlyArray<PropertySketch>> =>
	uniqueArray(element(PROPERTY_NAMES), propertyOf(schemaGen(depth, components, scalarSchema)), {
		min: 0,
		max: 5
	})

const objectSchema =
	(depth: number, components: ReadonlyArray<string>): Gen<SchemaSketch> =>
	(s) => ({
		kind: "object",
		properties: s.draw(propertiesGen(depth, components)),
		closed: s.draw(
			weighted([
				[4, () => false],
				[1, () => true]
			])
		)
	})

const COMPONENT_NAMES: Arr.NonEmptyReadonlyArray<string> = [
	"User",
	"Pet",
	"Error",
	"Node",
	"Multipart",
	"Client"
]

/** Components that may refer to each other and to themselves, always through an optional property. */
const componentsGen: Gen<ReadonlyArray<ComponentSketch>> = (s) => {
	const names = s.draw(shuffled(COMPONENT_NAMES, { min: 0, max: 4 }))
	return Arr.map(names, (name) => ({
		name,
		properties: Arr.map(s.draw(propertiesGen(1, names)), (property) =>
			property.schema.kind === "ref" || property.schema.kind === "oneOf"
				? { ...property, required: false }
				: property
		)
	}))
}

const PARAMETER_NAMES: Readonly<Record<Location, Arr.NonEmptyReadonlyArray<string>>> = {
	path: ["id", "userId", "slug", "petId"],
	query: ["limit", "q", "sort", "filter", "include", "page"],
	header: ["X-Trace", "X-Request-ID", "If-Match", "X-Flag"],
	cookie: ["session", "theme", "csrf"]
}

/** What the style table tells a parameter's schema by: one value, a list of scalars, or an object of scalars. */
type ValueKind = "scalar" | "array" | "object"

const valueKindOf = (schema: SchemaSketch): ValueKind =>
	schema.kind === "array" ? "array" : schema.kind === "object" ? "object" : "scalar"

/** An object of scalar members, the one object a styled parameter takes (PRM-27). */
const scalarObject: Gen<SchemaSketch> = (s) => ({
	kind: "object",
	properties: s.draw(
		uniqueArray(element(PROPERTY_NAMES), propertyOf(scalarSchema), { min: 0, max: 4 })
	),
	closed: s.draw(boolean)
})

/** A path parameter's schema: a scalar its positional argument reads, never a boolean (EMT-1). */
const pathSchema: Gen<SchemaSketch> = weighted<SchemaSketch>([
	[4, stringSchemaOf(STRING_FORMATS)],
	[2, integerSchema],
	[1, () => ({ kind: "number" })]
])

const styledSchema: Gen<SchemaSketch> = weighted<SchemaSketch>([
	[6, scalarSchema],
	[2, (s) => ({ kind: "array", items: s.draw(itemSchema) })],
	[1, scalarObject]
])

/** The schemas a location's styled parameter takes on `line`: a cookie before 3.2 has only the form style, which
 * carries no array or object (PRM-34). */
const schemaAt = (line: Line, location: Location): Gen<SchemaSketch> =>
	location === "path"
		? pathSchema
		: location === "cookie" && line !== "3.2"
			? scalarSchema
			: styledSchema

/** An explode a style takes either way, or the one it takes, spelled or left to its default. */
const eitherExplode: Gen<Option.Option<boolean>> = option(boolean)

const onlyExplode = (value: boolean): Gen<Option.Option<boolean>> => option(constant(value))

/** A style the table builds for a value, with the explode it allows. */
type StyleRule = readonly [style: Style, explode: Gen<Option.Option<boolean>>]

/**
 * The styles the style table builds for a value of `kind` at `location` on `line`, the first the most drawn: a
 * delimited style only over a list or an object and only unexploded (STY-17 to STY-24), deepObject only over an
 * object of scalars, and a 3.2 cookie only exploded, by the form style for a scalar alone (STY-35, PRM-34).
 */
const styleRules = (
	line: Line,
	location: Location,
	kind: ValueKind
): Arr.NonEmptyReadonlyArray<StyleRule> => {
	switch (location) {
		case "path":
			return [
				["simple", eitherExplode],
				["label", eitherExplode],
				["matrix", eitherExplode]
			]
		case "header":
			return [["simple", eitherExplode]]
		case "cookie":
			return line !== "3.2"
				? [["form", eitherExplode]]
				: kind === "scalar"
					? [
							["form", onlyExplode(true)],
							["cookie", onlyExplode(true)]
						]
					: [["cookie", onlyExplode(true)]]
		case "query": {
			const delimited: ReadonlyArray<StyleRule> = [
				["spaceDelimited", onlyExplode(false)],
				["pipeDelimited", onlyExplode(false)]
			]
			return kind === "scalar"
				? [["form", eitherExplode]]
				: kind === "array"
					? [["form", eitherExplode], ...delimited]
					: [["deepObject", eitherExplode], ["form", eitherExplode], ...delimited]
		}
	}
}

/** The style each location takes when a parameter spells none. */
const DEFAULT_STYLES: Readonly<Record<Location, Style>> = {
	path: "simple",
	query: "form",
	header: "simple",
	cookie: "form"
}

/** A style and explode the style table builds for `schema`, the location's default style left out or spelled. */
const stylingGen = (
	line: Line,
	location: Location,
	schema: SchemaSketch
): Gen<Readonly<{ style: Option.Option<Style>; explode: Option.Option<boolean> }>> => {
	const [first, ...rest] = styleRules(line, location, valueKindOf(schema))
	return (s) => {
		const [style, explode] = s.draw(
			weighted<StyleRule>([
				[3, () => first],
				...Arr.map(rest, (rule): Weighted<StyleRule> => [1, () => rule])
			])
		)
		return {
			style:
				style === DEFAULT_STYLES[location] && s.draw(boolean) ? Option.none() : Option.some(style),
			explode: s.draw(explode)
		}
	}
}

/** A parameter's value: styled, or, outside the path, by one content media type of any schema. */
const serializationGen = (
	line: Line,
	location: Location,
	components: ReadonlyArray<string>
): Gen<Serialization> => {
	const styled: Gen<Serialization> = (s) => {
		const schema = s.draw(schemaAt(line, location))
		return { kind: "schema", schema, ...s.draw(stylingGen(line, location, schema)) }
	}
	return location === "path"
		? styled
		: weighted<Serialization>([
				[6, styled],
				[
					1,
					(s) => ({
						kind: "content",
						mediaType: s.draw(
							element<"application/json" | "text/plain">(["application/json", "text/plain"])
						),
						schema: s.draw(
							weighted<SchemaSketch>([
								[6, scalarSchema],
								[2, (t) => ({ kind: "array", items: t.draw(itemSchema) })],
								[1, objectSchema(0, components)]
							])
						)
					})
				]
			])
}

/** Whether a parameter's flag is a boolean switch, which a required parameter cannot be (EMT-1). */
const isSwitch = (serialization: Serialization): boolean =>
	serialization.kind === "schema" && serialization.schema.kind === "boolean"

const parameterGen =
	(line: Line, location: Location, components: ReadonlyArray<string>) =>
	(name: string): Gen<ParameterSketch> =>
	(s) => {
		const serialization = s.draw(serializationGen(line, location, components))
		return {
			location,
			name,
			required: location === "path" || (!isSwitch(serialization) && s.draw(boolean)),
			deprecated: s.draw(
				weighted([
					[8, () => false],
					[1, () => true]
				])
			),
			description: s.draw(option(prose)),
			serialization
		}
	}

/** Part names, none a field name, so a part's flag is never a field's. */
const PART_NAMES: Arr.NonEmptyReadonlyArray<string> = ["file", "title", "meta", "labels", "avatar"]

const MEDIA_PART_TYPES: Arr.NonEmptyReadonlyArray<string> = [
	"image/png",
	"image/jpeg",
	"text/plain",
	"application/json"
]

const partGen =
	(components: ReadonlyArray<string>) =>
	(name: string): Gen<PartSketch> =>
	(s) => ({
		name,
		schema: s.draw(
			weighted<SchemaSketch>([
				[3, () => ({ kind: "string", format: Option.some("binary"), values: [] })],
				[3, scalarSchema],
				[1, objectSchema(0, components)],
				[1, (t) => ({ kind: "array", items: t.draw(scalarSchema) })]
			])
		),
		required: s.draw(boolean),
		contentTypes: s.draw(
			weighted<ReadonlyArray<string>>([
				[3, () => []],
				[1, (t) => t.draw(shuffled(MEDIA_PART_TYPES, { min: 1, max: 3 }))]
			])
		),
		headers: s.draw(
			uniqueArray(
				element(["X-Part-Trace", "X-Checksum"]),
				(header) => (t) => ({
					name: header,
					required: t.draw(boolean),
					deprecated: t.draw(boolean)
				}),
				{ min: 0, max: 1 }
			)
		)
	})

/** The media types a request body may offer, the JSON ones most often. */
type BodyMediaType =
	| "application/json"
	| "application/merge-patch+json"
	| "application/x-www-form-urlencoded"
	| "multipart/form-data"
	| "application/octet-stream"
	| "image/png"
	| "text/plain"
	| "text/csv"
	| "application/xml"
	| "application/x-ndjson"
	| "application/jsonl"
	| "application/json-seq"
	| "text/event-stream"
	| "multipart/mixed"

/** The media types a body may offer before 3.2, which has no positional multipart. */
const EARLY_BODY_MEDIA_TYPES: Arr.NonEmptyReadonlyArray<BodyMediaType> = [
	"application/json",
	"application/merge-patch+json",
	"application/x-www-form-urlencoded",
	"multipart/form-data",
	"application/octet-stream",
	"image/png",
	"text/plain",
	"text/csv",
	"application/xml",
	"application/x-ndjson",
	"application/jsonl",
	"application/json-seq",
	"text/event-stream"
]

const BODY_MEDIA_TYPES: Arr.NonEmptyReadonlyArray<BodyMediaType> = [
	"application/json",
	"application/merge-patch+json",
	"application/x-www-form-urlencoded",
	"multipart/form-data",
	"application/octet-stream",
	"image/png",
	"text/plain",
	"text/csv",
	"application/xml",
	"application/x-ndjson",
	"application/jsonl",
	"application/json-seq",
	"text/event-stream",
	"multipart/mixed"
]

/** A body's fields, which every alternative that has fields shares, so a field's flag is one flag in each (RQB-03). */
type Fields = Readonly<{ properties: ReadonlyArray<PropertySketch>; lone: boolean }>

const SCALAR_KINDS: ReadonlyArray<SchemaSketch["kind"]> = [
	"string",
	"integer",
	"number",
	"boolean",
	"nullable"
]

const isScalar = (schema: SchemaSketch): boolean => Arr.contains(SCALAR_KINDS, schema.kind)

/** Whether a field is flat: a scalar or a list of scalars, which a form body sends as it is. */
const isFlat = ({ schema }: PropertySketch): boolean =>
	schema.kind === "array" ? isScalar(schema.items) : isScalar(schema)

/** A JSON body without fields: one value, a list or a nullable scalar. */
const fieldlessSchema: Gen<SchemaSketch> = weighted<SchemaSketch>([
	[2, scalarSchema],
	[2, (s) => ({ kind: "array", items: s.draw(itemSchema) })],
	[
		1,
		map(element<ScalarType>(["string", "integer", "number", "boolean"]), (type): SchemaSketch => ({
			kind: "nullable",
			type
		}))
	]
])

/** The alternative a body offers under `mediaType`: a JSON object and a form body hold the body's fields, and a lone
 * JSON alternative may be any schema. */
const alternativeFor = (
	line: Line,
	mediaType: BodyMediaType,
	components: ReadonlyArray<string>,
	fields: Fields
): Gen<AlternativeSketch> => {
	switch (mediaType) {
		case "application/json":
		case "application/merge-patch+json":
			return (s) => ({
				kind: "json",
				mediaType,
				schema: s.draw(
					weighted<SchemaSketch>([
						[
							3,
							(t) => ({ kind: "object", properties: fields.properties, closed: t.draw(boolean) })
						],
						[1, fields.lone ? schemaGen(1, components, scalarSchema) : fieldlessSchema]
					])
				)
			})
		case "application/x-www-form-urlencoded":
			return (s) => {
				const properties = Arr.filter(fields.properties, isFlat)
				return {
					kind: "form",
					properties,
					encodings: Arr.map(s.draw(subarray(properties)), (property) => ({
						name: property.name,
						...s.draw(stylingGen(line, "query", property.schema))
					}))
				}
			}
		case "multipart/form-data":
			return (s) => ({
				kind: "multipart",
				parts: s.draw(
					uniqueArray(element(PART_NAMES), partGen(components), {
						min: 1,
						max: 4
					})
				)
			})
		case "application/octet-stream":
		case "image/png":
			return () => ({ kind: "binary", mediaType })
		case "text/plain":
		case "text/csv":
			return () => ({ kind: "text", mediaType })
		case "application/xml":
			return () => ({ kind: "xml", mediaType })
		case "application/x-ndjson":
		case "application/jsonl":
		case "application/json-seq":
			return (s) => ({ kind: "sequential", mediaType, item: s.draw(objectSchema(0, components)) })
		case "text/event-stream":
			return () => ({ kind: "event-stream" })
		case "multipart/mixed":
			return (s) => {
				const first = s.draw(element<MixedPart>(["json", "binary", "text"]))
				return {
					kind: "mixed",
					parts: [
						first,
						...s.draw(array(element<MixedPart>(["json", "binary", "text"]), { min: 0, max: 2 }))
					]
				}
			}
	}
}

const mediaTypeOf = (alternative: AlternativeSketch): string => {
	switch (alternative.kind) {
		case "json":
		case "binary":
		case "text":
		case "xml":
		case "sequential":
			return alternative.mediaType
		case "form":
			return "application/x-www-form-urlencoded"
		case "multipart":
			return "multipart/form-data"
		case "event-stream":
			return "text/event-stream"
		case "mixed":
			return "multipart/mixed"
	}
}

const bodyGen =
	(line: Line, components: ReadonlyArray<string>): Gen<BodySketch> =>
	(s) => {
		const mediaTypes = s.draw(
			uniqueArray(
				weighted([
					[6, element<BodyMediaType>(["application/json", "application/merge-patch+json"])],
					[6, element(line === "3.2" ? BODY_MEDIA_TYPES : EARLY_BODY_MEDIA_TYPES)]
				]),
				(mediaType) => () => mediaType,
				{ min: 1, max: 3 }
			)
		)
		const fields: Fields = {
			properties: s.draw(propertiesGen(1, components)),
			lone: mediaTypes.length === 1
		}
		return {
			required: s.draw(boolean),
			description: s.draw(option(prose)),
			alternatives: Arr.map(mediaTypes, (mediaType) =>
				s.draw(alternativeFor(line, mediaType, components, fields))
			)
		}
	}

const RESPONSE_HEADERS: Arr.NonEmptyReadonlyArray<string> = [
	"X-Request-ID",
	"X-Rate-Limit",
	"ETag",
	"Location",
	"Retry-After"
]

type ContentKind = ResponseContent["kind"]

const contentOfKind = (
	kind: ContentKind,
	components: ReadonlyArray<string>
): Gen<ResponseContent> => {
	switch (kind) {
		case "json":
			return (s) => ({ kind, schema: s.draw(schemaGen(1, components, scalarSchema)) })
		case "ndjson":
		case "json-seq":
			return (s) => ({ kind, item: s.draw(objectSchema(0, components)) })
		case "problem":
		case "binary":
		case "text":
		case "event-stream":
			return () => ({ kind })
	}
}

const contentKind: Gen<ContentKind> = weighted<ContentKind>([
	[6, () => "json"],
	[2, element<ContentKind>(["binary", "text", "event-stream", "ndjson", "json-seq", "problem"])]
])

const STATUSES: Arr.NonEmptyReadonlyArray<string> = [
	"200",
	"201",
	"204",
	"400",
	"404",
	"429",
	"default",
	"2XX",
	"5XX"
]

/** A 429 as an API answers one: a problem document and when to retry. */
const tooManyRequests = (description: string): ResponseSketch => ({
	status: "429",
	description,
	content: [{ kind: "problem" }],
	headers: [{ name: "Retry-After", required: false, deprecated: false }]
})

const responseGen =
	(components: ReadonlyArray<string>) =>
	(status: string): Gen<ResponseSketch> =>
		status === "429"
			? map(prose, tooManyRequests)
			: (s) => ({
					status,
					description: s.draw(prose),
					content:
						status === "204"
							? []
							: s.draw(
									uniqueArray(contentKind, (kind) => contentOfKind(kind, components), {
										min: 0,
										max: 2
									})
								),
					headers: s.draw(
						uniqueArray(
							element(RESPONSE_HEADERS),
							(name) => (t) => ({
								name,
								required: t.draw(boolean),
								deprecated: t.draw(
									weighted([
										[4, () => false],
										[1, () => true]
									])
								)
							}),
							{ min: 0, max: 2 }
						)
					)
				})

const SCHEME_NAMES: Arr.NonEmptyReadonlyArray<string> = [
	"bearerAuth",
	"apiKey",
	"basic",
	"oauth",
	"oidc",
	"mtls",
	"session"
]

const SCOPES: Arr.NonEmptyReadonlyArray<readonly [string, string]> = [
	["pets:read", "Read pets"],
	["pets:write", "Write \u202epets"],
	["admin", ""]
]

const FLOWS: Arr.NonEmptyReadonlyArray<Flow> = [
	"authorizationCode",
	"clientCredentials",
	"implicit",
	"password",
	"deviceAuthorization"
]

/** The mutualTLS arm a line admits: none before 3.1. */
const mutualTls = (line: Line): ReadonlyArray<Weighted<SchemeKind>> =>
	line === "3.0" ? [] : [[1, () => ({ type: "mutualTLS" })]]

const schemeKindGen = (line: Line): Gen<SchemeKind> =>
	weighted<SchemeKind>([
		[
			2,
			(s) => ({
				type: "apiKey",
				in: s.draw(element<"header" | "query" | "cookie">(["header", "query", "cookie"])),
				name: s.draw(element(["X-API-Key", "api_key", "token"]))
			})
		],
		[
			2,
			(s) => ({ type: "http", scheme: s.draw(element<"basic" | "bearer">(["basic", "bearer"])) })
		],
		[
			1,
			(s) => ({
				type: "oauth2",
				flows: Arr.map(
					s.draw(
						shuffled(
							line === "3.2" ? FLOWS : Arr.filter(FLOWS, (flow) => flow !== "deviceAuthorization"),
							{ min: 1, max: 2 }
						)
					),
					(flow) => [flow, s.draw(subarray(SCOPES))] as const
				),
				metadata: line === "3.2" && s.draw(boolean)
			})
		],
		[1, () => ({ type: "openIdConnect" })],
		...mutualTls(line)
	])

const schemesGen = (line: Line): Gen<ReadonlyArray<SchemeSketch>> =>
	uniqueArray(
		element(SCHEME_NAMES),
		(name) => (s) => ({
			name,
			deprecated:
				line === "3.2" &&
				s.draw(
					weighted([
						[5, () => false],
						[1, () => true]
					])
				),
			kind: s.draw(schemeKindGen(line))
		}),
		{ min: 0, max: 3 }
	)

/** Whether a scheme writes the one Authorization header: http, OAuth 2 and OpenID Connect do; the apiKey names do not. */
const writesAuthorization = ({ kind }: SchemeSketch): boolean =>
	kind.type === "http" || kind.type === "oauth2" || kind.type === "openIdConnect"

/**
 * Requirements over the declared schemes, each using at most one scheme that writes the Authorization header, since
 * a request carries one (SEC-01): none declared reads as no requirement, `{}` as anonymous access.
 */
const requirementsGen = (
	line: Line,
	schemes: ReadonlyArray<SchemeSketch>
): Gen<ReadonlyArray<Requirement>> =>
	array(
		(s) => {
			const writers = Arr.filter(schemes, writesAuthorization)
			const writer = Arr.isReadonlyArrayNonEmpty(writers)
				? s.draw(option(element(writers)))
				: Option.none()
			return Arr.map(
				[
					...s.draw(subarray(Arr.filter(schemes, (scheme) => !writesAuthorization(scheme)))),
					...Option.toArray(writer)
				],
				(scheme) =>
					[
						scheme.name,
						scheme.kind.type === "oauth2" ||
						scheme.kind.type === "openIdConnect" ||
						(line !== "3.0" && s.draw(boolean))
							? Arr.map(s.draw(subarray(SCOPES)), ([scope]) => scope)
							: []
					] as const
			)
		},
		{ min: 0, max: 2 }
	)

const METHODS: Arr.NonEmptyReadonlyArray<Method> = [
	"get",
	"put",
	"post",
	"delete",
	"patch",
	"head",
	"options"
]

const SEGMENTS: Arr.NonEmptyReadonlyArray<string> = [
	"users",
	"pets",
	"items",
	"files",
	"v1",
	"search",
	"me"
]

/** Tag names folding to names a command module binds: every one's `Command` and `Effect`, the root's `Groups`, `Arr`
 * and `Client`. */
export const BINDING_TAGS: Arr.NonEmptyReadonlyArray<string> = [
	"Client",
	"Groups",
	"Arr",
	"Command",
	"Effect"
]

const TAG_NAMES: Arr.NonEmptyReadonlyArray<string> = [
	"users",
	"pets",
	"admin",
	"files",
	...BINDING_TAGS
]

/** One operation at its own path: a unique leading segment, then literal and parameter segments. */
const operationGen =
	(
		line: Line,
		components: ReadonlyArray<string>,
		schemes: ReadonlyArray<SchemeSketch>,
		tags: ReadonlyArray<string>
	) =>
	(index: number): Gen<OperationSketch> =>
	(s) => {
		const pathNames = s.draw(shuffled(PARAMETER_NAMES.path, { min: 0, max: 2 }))
		const literals = s.draw(array(element(SEGMENTS), { min: 0, max: 2 }))
		const segments = [
			`${s.draw(element(SEGMENTS))}${index}`,
			...Arr.flatMap(pathNames, (name, position) =>
				Option.match(Arr.get(literals, position), {
					onNone: () => [`{${name}}`],
					onSome: (literal) => [literal, `{${name}}`]
				})
			)
		]
		const querystring =
			line === "3.2"
				? s.draw(
						weighted([
							[6, () => false],
							[1, () => true]
						])
					)
				: false
		const located = (location: Location, most: number) =>
			s.draw(
				uniqueArray(element(PARAMETER_NAMES[location]), parameterGen(line, location, components), {
					min: 0,
					max: most
				})
			)
		return {
			method: s.draw(element(METHODS)),
			segments,
			operationId: s.draw(
				option(
					map(element(["list", "get", "update", "delete-all"]), (verb) => `op${index}-${verb}`)
				)
			),
			tags: s.draw(subarray(tags)),
			summary: s.draw(option(prose)),
			description: s.draw(option(prose)),
			deprecated: s.draw(
				weighted([
					[6, () => false],
					[1, () => true]
				])
			),
			parameters: [
				...Arr.map(pathNames, (name) => s.draw(parameterGen(line, "path", components)(name))),
				...(querystring ? [] : located("query", 3)),
				...located("header", 2),
				...located("cookie", 1)
			],
			querystring: querystring
				? Option.some({
						mediaType: s.draw(
							element<"application/x-www-form-urlencoded" | "application/json">([
								"application/x-www-form-urlencoded",
								"application/json"
							])
						),
						properties: s.draw(propertiesGen(0, components))
					})
				: Option.none(),
			body: s.draw(
				weighted([
					[1, () => Option.none()],
					[2, map(bodyGen(line, components), Option.some)]
				])
			),
			responses: s.draw(
				uniqueArray(element(STATUSES), responseGen(components), { min: 1, max: 3 })
			),
			security: s.draw(option(requirementsGen(line, schemes))),
			aliases: s.draw(
				weighted<ReadonlyArray<Readonly<{ group: string; method: string }>>>([
					[6, () => []],
					[1, (t) => [{ group: t.draw(element(["items", "aliases"])), method: `fetch${index}` }]]
				])
			)
		}
	}

const SERVERS: Arr.NonEmptyReadonlyArray<string> = [
	"https://api.example.com",
	"https://api.example.com/v1",
	"https://{region}.example.com"
]

/** A document of its line, every part drawn from what the line admits. */
export const documentGen: Gen<DocumentSketch> = (s) => {
	const line = s.draw(element<Line>(["3.0", "3.1", "3.2"]))
	const components = s.draw(componentsGen)
	const names = Arr.map(components, (component) => component.name)
	const schemes = s.draw(schemesGen(line))
	const tagNames = s.draw(shuffled(TAG_NAMES, { min: 0, max: 4 }))
	const tags = Arr.map(tagNames, (name, index) => ({
		name,
		parent:
			line === "3.2" && index > 0 && s.draw(boolean) ? Arr.get(tagNames, index - 1) : Option.none()
	}))
	return {
		line,
		title: s.draw(prose),
		description: s.draw(option(prose)),
		servers: s.draw(shuffled(SERVERS, { min: 0, max: 2 })),
		tags,
		components,
		schemes,
		security: s.draw(option(requirementsGen(line, schemes))),
		operations: Arr.map(Arr.range(0, s.draw(int(0, 5)) - 1), (index) =>
			s.draw(operationGen(line, names, schemes, tagNames)(index))
		),
		webhooks: line === "3.0" ? [] : s.draw(subarray(["userCreated", "pet.deleted", "évènement"]))
	}
}

/** An object of the members that are present. */
const members = (
	entries: ReadonlyArray<readonly [string, Option.Option<Schema.Json>]>
): Schema.JsonObject =>
	Record.fromEntries(
		Arr.getSomes(
			Arr.map(entries, ([key, value]) => Option.map(value, (inner) => [key, inner] as const))
		)
	)

const when = (holds: boolean, value: Schema.Json): Option.Option<Schema.Json> =>
	holds ? Option.some(value) : Option.none()

const componentRef = (name: string): Schema.JsonObject => ({ $ref: `#/components/schemas/${name}` })

/** A schema as its line writes it: `nullable` on 3.0, a type list after. */
const schemaOf = (line: Line, schema: SchemaSketch): Schema.JsonObject => {
	switch (schema.kind) {
		case "string":
			return members([
				["type", Option.some("string")],
				["format", schema.format],
				["enum", when(Arr.isReadonlyArrayNonEmpty(schema.values), schema.values)]
			])
		case "integer":
			return members([
				["type", Option.some("integer")],
				["format", schema.format]
			])
		case "number":
		case "boolean":
			return { type: schema.kind }
		case "array":
			return { type: "array", items: schemaOf(line, schema.items) }
		case "object":
			return objectOf(line, schema.properties, schema.closed)
		case "nullable":
			return line === "3.0"
				? { type: schema.type, nullable: true }
				: { type: [schema.type, "null"] }
		case "ref":
			return componentRef(schema.component)
		case "oneOf":
			return members([
				["oneOf", Option.some(Arr.map(schema.members, componentRef))],
				["discriminator", when(schema.discriminator, { propertyName: "kind" })]
			])
	}
}

const isReference = (schema: SchemaSketch): boolean =>
	schema.kind === "ref" || schema.kind === "oneOf"

/** A property's schema with the annotations help reads; 3.0 ignores siblings of `$ref`, so a reference carries none
 * there. */
const propertySchema = (line: Line, property: PropertySketch): Schema.JsonObject => {
	const schema = schemaOf(line, property.schema)
	return line === "3.0" && isReference(property.schema)
		? schema
		: Record.fromEntries([
				...Record.toEntries<string, Schema.Json>(schema),
				...Record.toEntries<string, Schema.Json>(
					members([
						["description", property.description],
						["readOnly", when(property.readOnly, true)],
						["deprecated", when(property.deprecated, true)],
						["default", property.defaultValue]
					])
				)
			])
}

const objectOf = (
	line: Line,
	properties: ReadonlyArray<PropertySketch>,
	closed: boolean
): Schema.JsonObject =>
	members([
		["type", Option.some("object")],
		[
			"properties",
			Option.some(
				Record.fromEntries(
					Arr.map(
						properties,
						(property) => [property.name, propertySchema(line, property)] as const
					)
				)
			)
		],
		[
			"required",
			when(
				Arr.some(properties, (property) => property.required),
				Arr.map(
					Arr.filter(properties, (property) => property.required),
					(property) => property.name
				)
			)
		],
		["additionalProperties", when(closed, false)]
	])

const parameterOf = (line: Line, parameter: ParameterSketch): Schema.Json => {
	const { serialization } = parameter
	return members([
		["name", Option.some(parameter.name)],
		["in", Option.some(parameter.location)],
		["required", when(parameter.required, true)],
		["deprecated", when(parameter.deprecated, true)],
		["description", parameter.description],
		...(serialization.kind === "schema"
			? ([
					["schema", Option.some(schemaOf(line, serialization.schema))],
					["style", serialization.style],
					["explode", serialization.explode]
				] as const)
			: ([
					[
						"content",
						Option.some({
							[serialization.mediaType]: { schema: schemaOf(line, serialization.schema) }
						})
					]
				] as const))
	])
}

const headerOf = (header: Readonly<{ required: boolean; deprecated: boolean }>): Schema.Json =>
	members([
		["required", when(header.required, true)],
		["deprecated", when(header.deprecated, true)],
		["schema", Option.some({ type: "string" })]
	])

const headersOf = (
	headers: ReadonlyArray<Readonly<{ name: string; required: boolean; deprecated: boolean }>>
): Option.Option<Schema.Json> =>
	when(
		Arr.isReadonlyArrayNonEmpty(headers),
		Record.fromEntries(Arr.map(headers, (header) => [header.name, headerOf(header)] as const))
	)

const sequenceOf = (line: Line, item: SchemaSketch): Schema.Json =>
	line === "3.2" ? { itemSchema: schemaOf(line, item) } : { schema: schemaOf(line, item) }

const BINARY: Schema.Json = { type: "string", format: "binary" }

const mediaOf = (line: Line, alternative: AlternativeSketch): Schema.Json => {
	switch (alternative.kind) {
		case "json":
			return { schema: schemaOf(line, alternative.schema) }
		case "form":
			return members([
				["schema", Option.some(objectOf(line, alternative.properties, false))],
				[
					"encoding",
					when(
						Arr.isReadonlyArrayNonEmpty(alternative.encodings),
						Record.fromEntries(
							Arr.map(
								alternative.encodings,
								(encoding) =>
									[
										encoding.name,
										members([
											["style", encoding.style],
											["explode", encoding.explode]
										])
									] as const
							)
						)
					)
				]
			])
		case "multipart":
			return members([
				[
					"schema",
					Option.some(
						objectOf(
							line,
							Arr.map(alternative.parts, (part) => ({
								name: part.name,
								schema: part.schema,
								required: part.required,
								readOnly: false,
								deprecated: false,
								description: Option.none(),
								defaultValue: Option.none()
							})),
							false
						)
					)
				],
				[
					"encoding",
					Option.some(
						Record.fromEntries(
							Arr.map(
								alternative.parts,
								(part) =>
									[
										part.name,
										members([
											[
												"contentType",
												when(
													Arr.isReadonlyArrayNonEmpty(part.contentTypes),
													Arr.join(part.contentTypes, ", ")
												)
											],
											["headers", headersOf(part.headers)]
										])
									] as const
							)
						)
					)
				]
			])
		case "binary":
			return { schema: BINARY }
		case "text":
		case "event-stream":
			return { schema: { type: "string" } }
		case "xml":
			return { schema: { type: "object" } }
		case "sequential":
			return sequenceOf(line, alternative.item)
		case "mixed":
			return {
				schema: {
					type: "array",
					prefixItems: Arr.map(alternative.parts, (part) => MIXED_SCHEMAS[part])
				},
				prefixEncoding: Arr.map(alternative.parts, (part) => ({ contentType: MIXED_TYPES[part] }))
			}
	}
}

const MIXED_SCHEMAS: Readonly<Record<MixedPart, Schema.Json>> = {
	json: { type: "object", properties: { name: { type: "string" } } },
	binary: { type: "string", contentMediaType: "application/octet-stream" },
	text: { type: "string" }
}

const MIXED_TYPES: Readonly<Record<MixedPart, string>> = {
	json: "application/json",
	binary: "application/octet-stream",
	text: "text/plain"
}

const RESPONSE_MEDIA: Readonly<Record<ContentKind, string>> = {
	json: "application/json",
	problem: "application/problem+json",
	binary: "application/octet-stream",
	text: "text/plain",
	"event-stream": "text/event-stream",
	ndjson: "application/x-ndjson",
	"json-seq": "application/json-seq"
}

const PROBLEM: Schema.JsonObject = {
	type: "object",
	properties: { type: { type: "string" }, title: { type: "string" }, status: { type: "integer" } }
}

/** An SSE event as 3.2 types an event stream's items. */
const EVENT: Schema.JsonObject = {
	type: "object",
	properties: {
		data: { type: "string" },
		event: { type: "string" },
		id: { type: "string" },
		retry: { type: "integer" }
	}
}

const responseMediaOf = (line: Line, content: ResponseContent): Schema.Json => {
	switch (content.kind) {
		case "json":
			return { schema: schemaOf(line, content.schema) }
		case "problem":
			return { schema: PROBLEM }
		case "binary":
			return { schema: BINARY }
		case "text":
			return { schema: { type: "string" } }
		case "event-stream":
			return line === "3.2" ? { itemSchema: EVENT } : { schema: { type: "string" } }
		case "ndjson":
		case "json-seq":
			return sequenceOf(line, content.item)
	}
}

const responseOf = (line: Line, response: ResponseSketch): Schema.Json =>
	members([
		["description", Option.some(response.description)],
		[
			"content",
			when(
				Arr.isReadonlyArrayNonEmpty(response.content),
				Record.fromEntries(
					Arr.map(
						response.content,
						(content) => [RESPONSE_MEDIA[content.kind], responseMediaOf(line, content)] as const
					)
				)
			)
		],
		["headers", headersOf(response.headers)]
	])

const requirementsOf = (requirements: ReadonlyArray<Requirement>): Schema.Json =>
	Arr.map(requirements, (requirement) =>
		Record.fromEntries(Arr.map(requirement, ([scheme, scopes]) => [scheme, scopes] as const))
	)

const pathOf = (operation: OperationSketch): string => `/${Arr.join(operation.segments, "/")}`

const operationOf = (line: Line, operation: OperationSketch): Schema.Json =>
	members([
		["tags", when(Arr.isReadonlyArrayNonEmpty(operation.tags), operation.tags)],
		["summary", operation.summary],
		["description", operation.description],
		["operationId", operation.operationId],
		[
			"parameters",
			when(
				Arr.isReadonlyArrayNonEmpty(operation.parameters) || Option.isSome(operation.querystring),
				[
					...Arr.map(operation.parameters, (parameter) => parameterOf(line, parameter)),
					...Option.toArray(
						Option.map(operation.querystring, (querystring) => ({
							name: "qs",
							in: "querystring",
							content: {
								[querystring.mediaType]: { schema: objectOf(line, querystring.properties, false) }
							}
						}))
					)
				]
			)
		],
		[
			"requestBody",
			Option.map(operation.body, (body) =>
				members([
					["description", body.description],
					["required", when(body.required, true)],
					[
						"content",
						Option.some(
							Record.fromEntries(
								Arr.map(
									body.alternatives,
									(alternative) => [mediaTypeOf(alternative), mediaOf(line, alternative)] as const
								)
							)
						)
					]
				])
			)
		],
		[
			"responses",
			Option.some(
				Record.fromEntries(
					Arr.map(
						operation.responses,
						(response) => [response.status, responseOf(line, response)] as const
					)
				)
			)
		],
		["security", Option.map(operation.security, requirementsOf)],
		["deprecated", when(operation.deprecated, true)],
		[
			"x-forge-aliases",
			when(
				Arr.isReadonlyArrayNonEmpty(operation.aliases),
				Arr.map(operation.aliases, (alias) => ({
					"x-forge-group-name": alias.group,
					"x-forge-method-name": alias.method
				}))
			)
		]
	])

const FLOW_URLS: Readonly<Record<Flow, ReadonlyArray<string>>> = {
	authorizationCode: ["authorizationUrl", "tokenUrl"],
	clientCredentials: ["tokenUrl"],
	implicit: ["authorizationUrl"],
	password: ["tokenUrl"],
	deviceAuthorization: ["deviceAuthorizationUrl", "tokenUrl"]
}

const schemeOf = (scheme: SchemeSketch): Schema.Json => {
	const { kind } = scheme
	const deprecated = when(scheme.deprecated, true)
	switch (kind.type) {
		case "apiKey":
			return members([
				["type", Option.some("apiKey")],
				["in", Option.some(kind.in)],
				["name", Option.some(kind.name)],
				["deprecated", deprecated]
			])
		case "http":
			return members([
				["type", Option.some("http")],
				["scheme", Option.some(kind.scheme)],
				["deprecated", deprecated]
			])
		case "oauth2":
			return members([
				["type", Option.some("oauth2")],
				[
					"flows",
					Option.some(
						Record.fromEntries(
							Arr.map(
								kind.flows,
								([flow, scopes]) =>
									[
										flow,
										{
											...Record.fromEntries(
												Arr.map(
													FLOW_URLS[flow],
													(url) => [url, `https://auth.example.com/${url}`] as const
												)
											),
											scopes: Record.fromEntries(scopes)
										}
									] as const
							)
						)
					)
				],
				[
					"oauth2MetadataUrl",
					when(kind.metadata, "https://auth.example.com/.well-known/oauth-authorization-server")
				],
				["deprecated", deprecated]
			])
		case "openIdConnect":
			return members([
				["type", Option.some("openIdConnect")],
				[
					"openIdConnectUrl",
					Option.some("https://auth.example.com/.well-known/openid-configuration")
				],
				["deprecated", deprecated]
			])
		case "mutualTLS":
			return members([
				["type", Option.some("mutualTLS")],
				["deprecated", deprecated]
			])
	}
}

const serverOf = (url: string): Schema.Json =>
	Str.includes("{region}")(url)
		? { url, variables: { region: { default: "us", enum: ["us", "eu"] } } }
		: { url }

/** The document a sketch describes, in its line's own spelling. */
export const documentOf = (sketch: DocumentSketch): Schema.JsonObject => {
	const { line } = sketch
	return members([
		["openapi", Option.some(VERSIONS[line])],
		[
			"info",
			Option.some(
				members([
					["title", Option.some(sketch.title)],
					["version", Option.some("1.0.0")],
					["description", sketch.description]
				])
			)
		],
		[
			"servers",
			when(Arr.isReadonlyArrayNonEmpty(sketch.servers), Arr.map(sketch.servers, serverOf))
		],
		[
			"tags",
			when(
				Arr.isReadonlyArrayNonEmpty(sketch.tags),
				Arr.map(sketch.tags, (tag) =>
					members([
						["name", Option.some(tag.name)],
						["parent", tag.parent]
					])
				)
			)
		],
		[
			"paths",
			Option.some(
				Record.fromEntries(
					Arr.map(
						sketch.operations,
						(operation) =>
							[pathOf(operation), { [operation.method]: operationOf(line, operation) }] as const
					)
				)
			)
		],
		[
			"webhooks",
			when(
				Arr.isReadonlyArrayNonEmpty(sketch.webhooks),
				Record.fromEntries(
					Arr.map(
						sketch.webhooks,
						(name) =>
							[name, { post: { responses: { "200": { description: "Received." } } } }] as const
					)
				)
			)
		],
		[
			"components",
			when(
				Arr.isReadonlyArrayNonEmpty(sketch.components) ||
					Arr.isReadonlyArrayNonEmpty(sketch.schemes),
				members([
					[
						"schemas",
						when(
							Arr.isReadonlyArrayNonEmpty(sketch.components),
							Record.fromEntries(
								Arr.map(
									sketch.components,
									(component) =>
										[component.name, objectOf(line, component.properties, false)] as const
								)
							)
						)
					],
					[
						"securitySchemes",
						when(
							Arr.isReadonlyArrayNonEmpty(sketch.schemes),
							Record.fromEntries(
								Arr.map(sketch.schemes, (scheme) => [scheme.name, schemeOf(scheme)] as const)
							)
						)
					]
				])
			)
		],
		["security", Option.map(sketch.security, requirementsOf)]
	])
}

/** An author config: a bin name and package, the servers it accepts, the non-standard switches, scheme environment
 * names and skipped operations. */
export type ConfigSketch = Readonly<{
	binName: string
	envPrefix: Option.Option<string>
	accepted: ReadonlyArray<string>
	brackets: Option.Option<boolean>
	scalars: Option.Option<boolean>
	environments: ReadonlyArray<readonly [scheme: string, env: string]>
	skipped: ReadonlyArray<string>
	added: Option.Option<"bearer" | "header">
}>

/** An author config that fits `document`: it accepts some of its servers and names some of its schemes and operations. */
export const configGen =
	(document: DocumentSketch): Gen<ConfigSketch> =>
	(s) => ({
		binName: s.draw(element(["example", "pets-cli", "x"])),
		envPrefix: s.draw(option(element(["EXAMPLE", "PETS_API"]))),
		accepted: s.draw(subarray(document.servers)),
		brackets: s.draw(option(boolean)),
		scalars: s.draw(option(boolean)),
		environments: Arr.map(
			s.draw(subarray(document.schemes)),
			(scheme, index) => [scheme.name, `CUSTOM_SECRET_${index}`] as const
		),
		skipped: s.draw(
			subarray(Arr.getSomes(Arr.map(document.operations, (operation) => operation.operationId)))
		),
		added: s.draw(
			weighted<Option.Option<"bearer" | "header">>([
				[4, () => Option.none()],
				[1, map(element<"bearer" | "header">(["bearer", "header"]), Option.some)]
			])
		)
	})

/** The name of the scheme an author config adds, beside every name a document declares. */
const ADDED_SCHEME = "authorToken"

/** The author config a sketch describes. */
export const configOf = (config: ConfigSketch): Schema.JsonObject =>
	members([
		["package", Option.some({ name: `${config.binName}-cli`, version: "1.0.0" })],
		["binName", Option.some(config.binName)],
		["envPrefix", config.envPrefix],
		["servers", Option.some({ accepted: config.accepted })],
		[
			"nonStandard",
			when(
				Option.isSome(config.brackets) || Option.isSome(config.scalars),
				members([
					["deepObjectBrackets", config.brackets],
					["deepObjectScalars", config.scalars]
				])
			)
		],
		[
			"security",
			when(
				Arr.isReadonlyArrayNonEmpty(config.environments) || Option.isSome(config.added),
				Record.fromEntries([
					...Arr.map(config.environments, ([scheme, env]) => [scheme, { env }] as const),
					...Record.toEntries<string, Schema.Json>(
						members([
							[
								"add",
								Option.map(config.added, (kind) => ({
									requirement: [{ [ADDED_SCHEME]: [] }],
									schemes: {
										[ADDED_SCHEME]:
											kind === "bearer"
												? { type: "http", scheme: "bearer" }
												: { type: "apiKey", in: "header", name: "X-Author-Token" }
									}
								}))
							]
						])
					)
				])
			)
		],
		[
			"naming",
			when(Arr.isReadonlyArrayNonEmpty(config.skipped), {
				operations: Record.fromEntries(
					Arr.map(config.skipped, (operationId) => [operationId, { skip: true }] as const)
				)
			})
		]
	])

/** A JSON value's text, as a document or config file holds it. */
export const textOf = (value: Schema.Json): string => jsonTextOf(value)
