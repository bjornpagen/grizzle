/** What the property of parameters.test.ts reads: Parameter Object sketches and the outcomes design 6.1 states for them. */

import {
	aimed,
	boolean,
	constant,
	type Gen,
	oneOf,
	option,
	weighted
} from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Cause, Effect, Exit, Option, Order, String as Str } from "effect"
import type { Json } from "#model/pointer.ts"
import type { SpecLine } from "#model/spec-section.ts"
import { normalizeParameter } from "#normalize/parameters.ts"
import {
	documentAt,
	lineGen,
	normalizedAt,
	openapiOf,
	resolvedAt,
	token
} from "#test/support/normalizing.ts"

/** Where a parameter goes. */
type Location = "path" | "query" | "header" | "cookie" | "querystring"

/** A style a parameter may name. */
type Style =
	| "form"
	| "simple"
	| "label"
	| "matrix"
	| "spaceDelimited"
	| "pipeDelimited"
	| "deepObject"
	| "cookie"

/**
 * A schema of a known shape: scalars, an array, objects with flat, untyped, nested or array members, a union of
 * objects, a union of an object or a scalar, a type list admitting null, an untyped schema, a reference chain that
 * cycles, and components reached by `$ref`.
 */
type Shape =
	| "string"
	| "integer"
	| "array"
	| "flat"
	| "untypedMember"
	| "nested"
	| "arrayMember"
	| "additional"
	| "memberTypeList"
	| "objectOrNull"
	| "refFlat"
	| "refNested"
	| "anyOfFlat"
	| "untyped"
	| "flatOrEmpty"
	| "nestedOrEmpty"
	| "numberOrNow"
	| "flatOrNull"
	| "cyclic"

/** A content key: concrete media types, a range, and a key that is no media type. */
type Media =
	| "application/json"
	| "text/plain"
	| "application/x-www-form-urlencoded"
	| "Application/X-WWW-Form-Urlencoded; charset=utf-8"
	| "*/*"
	| "text/*"

/** A schema field a querystring parameter may not use beside its content. */
type Forbidden = "schema" | "style" | "explode" | "allowReserved"

/** How a parameter carries its value: by schema with its style fields, by one content entry, or unreadably. */
type Carrier =
	| Readonly<{
			kind: "schema"
			shape: Shape
			style: Option.Option<Style>
			explode: Option.Option<boolean>
			allowReserved: Option.Option<boolean>
	  }>
	| Readonly<{
			kind: "content"
			media: Media
			schema: boolean
			forbidden: Option.Option<Forbidden>
	  }>
	| Readonly<{ kind: "neither" }>
	| Readonly<{ kind: "both" }>
	| Readonly<{ kind: "twoEntries" }>

/** A Parameter Object, written in place or behind a `$ref`, under the author config's deepObject switches. */
type ParameterSketch = Readonly<{
	line: SpecLine
	location: Location
	name: string
	required: boolean
	deprecated: Option.Option<boolean>
	allowEmptyValue: Option.Option<boolean>
	description: Option.Option<"plain" | "unsafe">
	referenced: boolean
	carrier: Carrier
	brackets: Option.Option<boolean>
	scalars: Option.Option<boolean>
}>

/** What a case reaches. */
export type ParameterFeature =
	| "location default style"
	| "path style row"
	| "query style row"
	| "header style row"
	| "cookie form"
	| "cookie style on 3.2"
	| "cookie explode false refused for good"
	| "cookie form over an array or object"
	| "deepObject built"
	| "deepObject explode corrected"
	| "deepObject nested refused"
	| "deepObject nested under the bracket switch"
	| "deepObject over a non-object"
	| "deepObject scalars under the scalar switch"
	| "deepObject under both switches"
	| "explode not applicable"
	| "delimited style over a primitive"
	| "delimited style over an array or object"
	| "style the location does not define"
	| "allowReserved honored"
	| "3.2 path allowReserved honored"
	| "allowReserved ignored"
	| "allowEmptyValue honored"
	| "allowEmptyValue ignored"
	| "3.0 header percent-encoding"
	| "ignored header"
	| "Cookie header refused"
	| "invalid name"
	| "invalid cookie name"
	| "content parameter"
	| "content media type not concrete"
	| "content without schema"
	| "querystring content"
	| "querystring with schema fields"
	| "referenced parameter"
	| "help text sanitized"
	| "required parameter refused raises its operation"
	| "unreadable parameter"
	| "object-valued parameter"

/** A shape a line can write: 3.0 has no `null` type for a union branch. */
const shapeOn = (line: SpecLine): Gen<Shape> =>
	weighted([
		[3, oneOf([constant<Shape>("string"), constant<Shape>("integer")])],
		[
			2,
			oneOf([
				constant<Shape>("array"),
				constant<Shape>("flat"),
				constant<Shape>("refFlat"),
				constant<Shape>("anyOfFlat")
			])
		],
		[
			2,
			oneOf([
				constant<Shape>("untypedMember"),
				constant<Shape>("nested"),
				constant<Shape>("arrayMember"),
				constant<Shape>("additional"),
				constant<Shape>("memberTypeList"),
				constant<Shape>("objectOrNull"),
				constant<Shape>("refNested"),
				constant<Shape>("untyped")
			])
		],
		[
			2,
			oneOf([
				constant<Shape>("flatOrEmpty"),
				constant<Shape>("nestedOrEmpty"),
				constant<Shape>("numberOrNow"),
				...(line === "3.0" ? [] : [constant<Shape>("flatOrNull")]),
				constant<Shape>("cyclic")
			])
		]
	])

const styleGen: Gen<Style> = oneOf([
	constant<Style>("form"),
	constant<Style>("simple"),
	constant<Style>("label"),
	constant<Style>("matrix"),
	constant<Style>("spaceDelimited"),
	constant<Style>("pipeDelimited"),
	constant<Style>("deepObject"),
	constant<Style>("cookie")
])

/** The styles a location's table names, drawn most often, the rest of the vocabulary less. */
const styleFor = (location: Location): Gen<Option.Option<Style>> => {
	const own: Arr.NonEmptyReadonlyArray<Style> =
		location === "path"
			? ["simple", "label", "matrix"]
			: location === "query"
				? ["form", "spaceDelimited", "pipeDelimited", "deepObject"]
				: location === "cookie"
					? ["form", "cookie"]
					: ["simple"]
	return weighted([
		[2, constant(Option.none())],
		[4, (source) => Option.some(oneOf(Arr.map(own, (each) => constant(each)))(source))],
		[1, (source) => Option.some(styleGen(source))]
	])
}

const nameFor = (location: Location): Gen<string> => {
	switch (location) {
		case "path":
			return constant("id")
		case "querystring":
			return constant("qs")
		case "query":
			return weighted([
				[4, constant("q")],
				[1, constant("Accept")],
				[1, constant("bad\u0001name")]
			])
		case "header":
			return weighted([
				[4, constant("X-Trace")],
				[1, oneOf([constant("Accept"), constant("content-type"), constant("AUTHORIZATION")])],
				[1, oneOf([constant("Cookie"), constant("cookie")])],
				[1, constant("bad\u0001name")]
			])
		case "cookie":
			return weighted([
				[4, constant("sid")],
				[1, oneOf([constant("a b"), constant("a;b"), constant("a=b"), constant("sé")])],
				[1, constant("bad\u0001name")]
			])
	}
}

const media: Gen<Media> = weighted([
	[3, oneOf([constant<Media>("application/json"), constant<Media>("text/plain")])],
	[
		2,
		oneOf([
			constant<Media>("application/x-www-form-urlencoded"),
			constant<Media>("Application/X-WWW-Form-Urlencoded; charset=utf-8")
		])
	],
	[1, oneOf([constant<Media>("*/*"), constant<Media>("text/*")])]
])

const carrierFor = (location: Location, line: SpecLine): Gen<Carrier> =>
	weighted([
		[
			location === "querystring" ? 1 : 8,
			(source): Carrier => ({
				kind: "schema",
				shape: shapeOn(line)(source),
				style: styleFor(location)(source),
				explode: option(boolean)(source),
				allowReserved: weighted<Option.Option<boolean>>([
					[3, constant(Option.none())],
					[1, (inner) => Option.some(boolean(inner))]
				])(source)
			})
		],
		[
			location === "querystring" ? 8 : 2,
			(source): Carrier => ({
				kind: "content",
				media: media(source),
				schema: weighted([
					[5, constant(true)],
					[1, constant(false)]
				])(source),
				forbidden:
					location === "querystring"
						? weighted<Option.Option<Forbidden>>([
								[3, constant(Option.none())],
								[
									1,
									oneOf([
										constant(Option.some<Forbidden>("schema")),
										constant(Option.some<Forbidden>("style")),
										constant(Option.some<Forbidden>("explode")),
										constant(Option.some<Forbidden>("allowReserved"))
									])
								]
							])(source)
						: Option.none()
			})
		],
		[
			1,
			oneOf([
				constant<Carrier>({ kind: "neither" }),
				constant<Carrier>({ kind: "both" }),
				constant<Carrier>({ kind: "twoEntries" })
			])
		]
	])

const locationGen: Gen<Location> = weighted([
	[3, constant<Location>("query")],
	[
		2,
		oneOf([constant<Location>("path"), constant<Location>("header"), constant<Location>("cookie")])
	],
	[1, constant<Location>("querystring")]
])

/** A parameter of a drawn line and location, every field drawn from what the specification and its faults allow. */
const drawnParameter: Gen<ParameterSketch> = (source) => {
	const line = lineGen(source)
	const where = locationGen(source)
	return {
		line,
		location: where,
		name: nameFor(where)(source),
		required:
			where === "path"
				? weighted([
						[6, constant(true)],
						[1, constant(false)]
					])(source)
				: boolean(source),
		deprecated: option(boolean)(source),
		allowEmptyValue: weighted<Option.Option<boolean>>([
			[3, constant(Option.none())],
			[1, (inner) => Option.some(boolean(inner))]
		])(source),
		description: option(oneOf([constant<"plain">("plain"), constant<"unsafe">("unsafe")]))(source),
		referenced: boolean(source),
		carrier: carrierFor(where, line)(source),
		brackets: option(boolean)(source),
		scalars: option(boolean)(source)
	}
}

/** A drawn parameter with `fields` in place of its own: a case built to reach one situation. */
const reaching =
	(
		fields: (source: Parameters<Gen<ParameterSketch>>[0]) => Partial<ParameterSketch>
	): Gen<ParameterSketch> =>
	(source) => ({ ...drawnParameter(source), ...fields(source) })

/** A schema carrier of `shape` with `style` and `explode` as given. */
const schemaCarrier = (
	shapeOf: Shape,
	chosen: Option.Option<Style>,
	explode: Option.Option<boolean>
): Carrier => ({
	kind: "schema",
	shape: shapeOf,
	style: chosen,
	explode,
	allowReserved: Option.none()
})

const compoundShape: Gen<Shape> = oneOf([
	constant<Shape>("array"),
	constant<Shape>("flat"),
	constant<Shape>("refFlat"),
	constant<Shape>("nested")
])

/** Parameters, aimed at the situations a draw reaches rarely, each by a case built to reach it. */
export const parameterSpace = aimed<ParameterSketch, ParameterFeature>(drawnParameter, [
	[
		"cookie form over an array or object",
		reaching((source) => ({
			location: "cookie",
			name: "sid",
			carrier: schemaCarrier(compoundShape(source), Option.none(), Option.none())
		}))
	],
	[
		"cookie explode false refused for good",
		reaching((source) => ({
			line: "3.2",
			location: "cookie",
			name: "sid",
			carrier: schemaCarrier(
				"string",
				Option.some(oneOf([constant<Style>("form"), constant<Style>("cookie")])(source)),
				Option.some(false)
			)
		}))
	],
	[
		"deepObject under both switches",
		reaching(() => ({
			location: "query",
			name: "q",
			carrier: schemaCarrier("nestedOrEmpty", Option.some("deepObject"), Option.some(true)),
			brackets: Option.some(true),
			scalars: Option.some(true)
		}))
	],
	[
		"deepObject scalars under the scalar switch",
		reaching((source) => ({
			location: "query",
			name: "q",
			carrier: schemaCarrier(
				oneOf([
					constant<Shape>("numberOrNow"),
					constant<Shape>("flatOrEmpty"),
					constant<Shape>("string")
				])(source),
				Option.some("deepObject"),
				Option.none()
			),
			scalars: Option.some(true)
		}))
	],
	[
		"deepObject nested under the bracket switch",
		reaching(() => ({
			location: "query",
			name: "q",
			carrier: schemaCarrier("nested", Option.some("deepObject"), Option.some(true)),
			brackets: Option.some(true)
		}))
	],
	[
		"required parameter refused raises its operation",
		reaching(() => ({
			location: "header",
			name: "Cookie",
			required: true,
			carrier: schemaCarrier("string", Option.none(), Option.none())
		}))
	],
	[
		"querystring with schema fields",
		reaching((source) => ({
			line: "3.2",
			location: "querystring",
			name: "qs",
			carrier: {
				kind: "content",
				media: "application/json",
				schema: true,
				forbidden: Option.some(
					oneOf([
						constant<Forbidden>("schema"),
						constant<Forbidden>("style"),
						constant<Forbidden>("explode"),
						constant<Forbidden>("allowReserved")
					])(source)
				)
			}
		}))
	],
	[
		"3.0 header percent-encoding",
		reaching(() => ({
			line: "3.0",
			location: "header",
			name: "X-Trace",
			carrier: schemaCarrier("string", Option.none(), Option.none())
		}))
	],
	[
		"deepObject nested refused",
		reaching((source) => ({
			location: "query",
			name: "q",
			carrier: schemaCarrier(
				oneOf([
					constant<Shape>("nested"),
					constant<Shape>("array"),
					constant<Shape>("refNested"),
					constant<Shape>("arrayMember")
				])(source),
				Option.some("deepObject"),
				option(boolean)(source)
			),
			brackets: Option.none(),
			scalars: Option.none()
		}))
	],
	[
		"deepObject over a non-object",
		reaching((source) => ({
			location: "query",
			name: "q",
			carrier: schemaCarrier(
				oneOf([
					constant<Shape>("string"),
					constant<Shape>("untyped"),
					constant<Shape>("cyclic"),
					constant<Shape>("flatOrEmpty")
				])(source),
				Option.some("deepObject"),
				option(boolean)(source)
			),
			scalars: Option.none()
		}))
	],
	[
		"deepObject built",
		reaching((source) => ({
			location: "query",
			name: "q",
			carrier: schemaCarrier(
				oneOf([constant<Shape>("flat"), constant<Shape>("refFlat"), constant<Shape>("anyOfFlat")])(
					source
				),
				Option.some("deepObject"),
				option(boolean)(source)
			)
		}))
	],
	[
		"deepObject explode corrected",
		reaching((source) => ({
			line: oneOf([constant<SpecLine>("3.0"), constant<SpecLine>("3.1")])(source),
			location: "query",
			name: "q",
			carrier: schemaCarrier(
				"flat",
				Option.some("deepObject"),
				oneOf([constant(Option.none()), constant(Option.some(false))])(source)
			)
		}))
	],
	[
		"explode not applicable",
		reaching((source) => ({
			location: "query",
			name: "q",
			carrier: schemaCarrier(
				"array",
				Option.some(
					oneOf([constant<Style>("spaceDelimited"), constant<Style>("pipeDelimited")])(source)
				),
				Option.some(true)
			)
		}))
	],
	[
		"delimited style over a primitive",
		reaching((source) => ({
			location: "query",
			name: "q",
			carrier: schemaCarrier(
				oneOf([constant<Shape>("string"), constant<Shape>("integer")])(source),
				Option.some(
					oneOf([constant<Style>("spaceDelimited"), constant<Style>("pipeDelimited")])(source)
				),
				Option.some(false)
			)
		}))
	],
	[
		"delimited style over an array or object",
		reaching((source) => ({
			location: "query",
			name: "q",
			carrier: schemaCarrier(
				oneOf([constant<Shape>("array"), constant<Shape>("flat")])(source),
				Option.some(
					oneOf([constant<Style>("spaceDelimited"), constant<Style>("pipeDelimited")])(source)
				),
				Option.some(false)
			)
		}))
	],
	[
		"cookie style on 3.2",
		reaching(() => ({
			line: "3.2",
			location: "cookie",
			name: "sid",
			carrier: schemaCarrier("array", Option.some("cookie"), Option.none())
		}))
	],
	[
		"content without schema",
		reaching(() => ({
			location: "query",
			name: "q",
			carrier: {
				kind: "content",
				media: "application/json",
				schema: false,
				forbidden: Option.none()
			}
		}))
	],
	[
		"content media type not concrete",
		reaching((source) => ({
			location: "header",
			name: "X-Trace",
			carrier: {
				kind: "content",
				media: oneOf([constant<Media>("*/*"), constant<Media>("text/*")])(source),
				schema: true,
				forbidden: Option.none()
			}
		}))
	],
	[
		"querystring content",
		reaching((source) => ({
			line: "3.2",
			location: "querystring",
			name: "qs",
			carrier: { kind: "content", media: media(source), schema: true, forbidden: Option.none() }
		}))
	],
	[
		"Cookie header refused",
		reaching(() => ({
			location: "header",
			name: "cookie",
			carrier: schemaCarrier("string", Option.none(), Option.none())
		}))
	],
	[
		"ignored header",
		reaching(() => ({
			location: "header",
			name: "AUTHORIZATION",
			carrier: schemaCarrier("string", Option.none(), Option.none())
		}))
	],
	[
		"invalid name",
		reaching(() => ({
			location: "query",
			name: "bad\u0001name",
			carrier: schemaCarrier("string", Option.none(), Option.none())
		}))
	],
	[
		"invalid cookie name",
		reaching(() => ({
			location: "cookie",
			name: "a b",
			carrier: schemaCarrier("string", Option.none(), Option.none())
		}))
	],
	[
		"unreadable parameter",
		reaching((source) => ({
			location: "query",
			name: "q",
			carrier: oneOf([
				constant<Carrier>({ kind: "neither" }),
				constant<Carrier>({ kind: "both" }),
				constant<Carrier>({ kind: "twoEntries" })
			])(source)
		}))
	],
	[
		"allowReserved honored",
		reaching(() => ({
			location: "query",
			name: "q",
			carrier: {
				kind: "schema",
				shape: "string",
				style: Option.none(),
				explode: Option.none(),
				allowReserved: Option.some(true)
			}
		}))
	],
	[
		"3.2 path allowReserved honored",
		reaching(() => ({
			line: "3.2",
			location: "path",
			name: "id",
			required: true,
			carrier: {
				kind: "schema",
				shape: "string",
				style: Option.none(),
				explode: Option.none(),
				allowReserved: Option.some(true)
			}
		}))
	],
	[
		"allowReserved ignored",
		reaching(() => ({
			location: "header",
			name: "X-Trace",
			carrier: {
				kind: "schema",
				shape: "string",
				style: Option.none(),
				explode: Option.none(),
				allowReserved: Option.some(true)
			}
		}))
	],
	[
		"allowEmptyValue honored",
		reaching(() => ({
			location: "query",
			name: "q",
			allowEmptyValue: Option.some(true),
			carrier: schemaCarrier("string", Option.none(), Option.none())
		}))
	],
	[
		"allowEmptyValue ignored",
		reaching(() => ({
			location: "header",
			name: "X-Trace",
			allowEmptyValue: Option.some(true),
			carrier: schemaCarrier("string", Option.none(), Option.none())
		}))
	]
])

const flatJson: Json = { properties: { a: { type: "string" } }, type: "object" }

const nestedJson: Json = { properties: { a: { type: "object" } }, type: "object" }

/** The schema a shape writes; 3.0 spells a type list as a nullable object. */
const shapeJson = (value: Shape, line: SpecLine): Json => {
	switch (value) {
		case "string":
			return { type: "string" }
		case "integer":
			return { type: "integer" }
		case "array":
			return { items: { type: "string" }, type: "array" }
		case "flat":
			return flatJson
		case "untypedMember":
			return { properties: { a: {} }, type: "object" }
		case "nested":
			return nestedJson
		case "arrayMember":
			return { properties: { a: { items: { type: "string" }, type: "array" } } }
		case "additional":
			return { additionalProperties: { type: "object" }, type: "object" }
		case "memberTypeList":
			return {
				properties: {
					a: line === "3.0" ? { nullable: true, type: "object" } : { type: ["object", "null"] }
				},
				type: "object"
			}
		case "objectOrNull":
			return line === "3.0" ? { nullable: true, type: "object" } : { type: ["object", "null"] }
		case "refFlat":
			return { $ref: "#/components/schemas/Flat" }
		case "refNested":
			return { $ref: "#/components/schemas/Filter" }
		case "anyOfFlat":
			return { anyOf: [flatJson, { properties: { b: { type: "integer" } }, type: "object" }] }
		case "untyped":
			return {}
		case "flatOrEmpty":
			return {
				anyOf: [
					flatJson,
					line === "3.0" ? { enum: [""], type: "string" } : { const: "", type: "string" }
				]
			}
		case "nestedOrEmpty":
			return { anyOf: [nestedJson, line === "3.0" ? { enum: [""] } : { const: "" }] }
		case "numberOrNow":
			return { anyOf: [{ type: "number" }, line === "3.0" ? { enum: ["now"] } : { const: "now" }] }
		case "flatOrNull":
			return { anyOf: [flatJson, { type: "null" }] }
		case "cyclic":
			return { $ref: "#/components/schemas/Cycle" }
	}
}

/** What design 6.1's tests read of a schema shape. */
type Traits = Readonly<{
	/** It declares types and none is an array or object (STY-17, STY-21). */
	primitive: boolean
	/** It declares an array or object type, through `$ref` (a cookie's PRM-34). */
	compound: boolean
	/** It admits only objects or arrays, through `$ref` and its unions (deepObject's PRM-27). */
	objectsOrArrays: boolean
	/** It admits only objects (a styled value taken as JSON). */
	objects: boolean
	/** It is an array, or an object with an object or array member (deepObject's PRM-27 compound-nested). */
	nested: boolean
	/** What the scalar switch makes of it: no scalar branch, or a branch it cannot cover, leaves the strict rules. */
	cover: "strict" | "scalars" | "scalarsWithNested"
}>

/** The traits of each shape, read from the schema it writes. */
const traitsOf = (value: Shape, line: SpecLine): Traits => {
	const none = {
		primitive: false,
		compound: false,
		objectsOrArrays: false,
		objects: false,
		nested: false,
		cover: "strict"
	} as const
	switch (value) {
		case "string":
		case "integer":
			return { ...none, primitive: true, cover: "scalars" }
		case "array":
			return { ...none, compound: true, objectsOrArrays: true, nested: true }
		case "flat":
		case "untypedMember":
		case "refFlat":
			return { ...none, compound: true, objectsOrArrays: true, objects: true }
		case "nested":
		case "additional":
		case "memberTypeList":
		case "refNested":
			return { ...none, compound: true, objectsOrArrays: true, objects: true, nested: true }
		case "arrayMember":
			return { ...none, objectsOrArrays: true, objects: true, nested: true }
		case "anyOfFlat":
			return { ...none, objectsOrArrays: true, objects: true }
		case "objectOrNull":
			return line === "3.0"
				? { ...none, compound: true, objectsOrArrays: true, objects: true }
				: { ...none, compound: true }
		case "untyped":
		case "flatOrNull":
		case "cyclic":
			return none
		case "flatOrEmpty":
		case "numberOrNow":
			return { ...none, cover: "scalars" }
		case "nestedOrEmpty":
			return { ...none, cover: "scalarsWithNested" }
	}
}

/** The component schemas every document holds for the shapes' references. */
const componentSchemas: Readonly<Record<string, Json>> = {
	Cycle: { anyOf: [{ $ref: "#/components/schemas/Cycle" }] },
	Filter: { properties: { range: { $ref: "#/components/schemas/Range" } }, type: "object" },
	Flat: flatJson,
	Range: { properties: { gte: { type: "integer" } }, type: "object" }
}

/** A description as written, and as help shows it. */
const descriptionOf = (value: "plain" | "unsafe"): readonly [string, string] =>
	value === "plain" ? ["The query.", "The query."] : ["The\u0007 query‮.", "The query."]

/** The Parameter Object a sketch writes. */
const parameterJson = (sketch: ParameterSketch): Json => {
	const carrier = sketch.carrier
	const fields = (): Readonly<Record<string, Json>> => {
		switch (carrier.kind) {
			case "schema":
				return {
					schema: shapeJson(carrier.shape, sketch.line),
					...Option.match(carrier.style, {
						onNone: () => ({}),
						onSome: (each) => ({ style: each })
					}),
					...Option.match(carrier.explode, {
						onNone: () => ({}),
						onSome: (each) => ({ explode: each })
					}),
					...Option.match(carrier.allowReserved, {
						onNone: () => ({}),
						onSome: (each) => ({ allowReserved: each })
					})
				}
			case "content": {
				const forbidden = Option.match(carrier.forbidden, {
					onNone: () => ({}),
					onSome: (each): Readonly<Record<string, Json>> => {
						switch (each) {
							case "schema":
								return { schema: { type: "object" } }
							case "style":
								return { style: "form" }
							case "explode":
								return { explode: true }
							case "allowReserved":
								return { allowReserved: false }
						}
					}
				})
				return {
					content: { [carrier.media]: carrier.schema ? { schema: { type: "object" } } : {} },
					...forbidden
				}
			}
			case "neither":
				return {}
			case "both":
				return {
					content: { "application/json": { schema: { type: "object" } } },
					schema: { type: "string" }
				}
			case "twoEntries":
				return {
					content: {
						"application/json": { schema: { type: "object" } },
						"text/plain": { schema: { type: "string" } }
					}
				}
		}
	}
	return {
		in: sketch.location,
		name: sketch.name,
		...(sketch.required ? { required: true } : {}),
		...Option.match(sketch.deprecated, {
			onNone: () => ({}),
			onSome: (each) => ({ deprecated: each })
		}),
		...Option.match(sketch.allowEmptyValue, {
			onNone: () => ({}),
			onSome: (each) => ({ allowEmptyValue: each })
		}),
		...Option.match(sketch.description, {
			onNone: () => ({}),
			onSome: (each) => ({ description: descriptionOf(each)[0] })
		}),
		...fields()
	}
}

/** The operation's path: a template holding the path parameter's name, or a plain path. */
const pathOf = (sketch: ParameterSketch): string => (sketch.location === "path" ? "/a/{id}" : "/a")

/** The pointer of the operation, and of its one parameter. */
const operationPointer = (sketch: ParameterSketch): string => `/paths/${token(pathOf(sketch))}/get`

const parameterPointer = (sketch: ParameterSketch): string =>
	`${operationPointer(sketch)}/parameters/0`

/** The document holding the parameter on its one operation, in place or behind a `$ref`. */
const documentOf = (sketch: ParameterSketch): Json =>
	documentAt(sketch.line, {
		components: {
			schemas: componentSchemas,
			...(sketch.referenced ? { parameters: { Shared: parameterJson(sketch) } } : {})
		},
		paths: {
			[pathOf(sketch)]: {
				get: {
					parameters: [
						sketch.referenced ? { $ref: "#/components/parameters/Shared" } : parameterJson(sketch)
					],
					responses: { "200": { description: "ok" } }
				}
			}
		}
	})

/** A finding as the model states it: its code and severity (every one at the parameter's use site, element scope). */
type Finding = readonly [code: string, severity: "notice" | "refusal"]

const notice = (code: string): Finding => [code, "notice"]

const refusal = (code: string): Finding => [code, "refusal"]

/** A styled serialization as the model states it. */
type StyleModel = Readonly<{
	kind: "style"
	style: Style
	explode: boolean
	allowReserved: boolean
	rows: ReadonlyArray<string>
	objectValued: boolean
	nonStandard: Option.Option<string>
	nonStandardScalars: Option.Option<string>
}>

/** A content serialization as the model states it. */
type ContentModel = Readonly<{ kind: "content"; mediaType: string; rows: ReadonlyArray<string> }>

/** A built parameter as the model states it. */
type ParameterModel = Readonly<{
	location: Location
	wireName: string
	required: boolean
	deprecated: boolean
	rows: ReadonlyArray<string>
	description: Option.Option<string>
	schemaKey: string
	serialization: StyleModel | ContentModel
}>

/** What normalizing one parameter gives, where its diagnostics stand, and what its operation becomes. */
type ParameterModelOutcome = Readonly<{
	sites: ReadonlyArray<string>
	outcome:
		| Readonly<{ kind: "unreadable"; reason: string }>
		| Readonly<{ kind: "ignored"; findings: ReadonlyArray<Finding> }>
		| Readonly<{ kind: "refused"; required: boolean; findings: ReadonlyArray<Finding> }>
		| Readonly<{ kind: "implemented"; findings: ReadonlyArray<Finding>; parameter: ParameterModel }>
	operation: "kept" | "raised" | "removed" | "unreadable"
}>

/** The style table's rows (design 6.1) by location, style, explode and allowReserved; deepObject and cookie apart. */
const tableRow = (
	location: Location,
	chosen: Style,
	explode: boolean,
	allowReserved: boolean
): Option.Option<string> => {
	const rows: ReadonlyArray<readonly [Location, Style, boolean, boolean, string]> = [
		["path", "matrix", false, false, "STY-01"],
		["path", "matrix", true, false, "STY-02"],
		["path", "label", false, false, "STY-03"],
		["path", "label", true, false, "STY-04"],
		["path", "simple", false, false, "STY-05"],
		["path", "simple", true, false, "STY-06"],
		["path", "matrix", false, true, "STY-07"],
		["path", "matrix", true, true, "STY-08"],
		["path", "label", false, true, "STY-09"],
		["path", "label", true, true, "STY-10"],
		["path", "simple", false, true, "STY-11"],
		["path", "simple", true, true, "STY-12"],
		["query", "form", true, false, "STY-13"],
		["query", "form", false, false, "STY-14"],
		["query", "form", true, true, "STY-15"],
		["query", "form", false, true, "STY-16"],
		["query", "spaceDelimited", false, false, "STY-17"],
		["query", "spaceDelimited", true, false, "STY-18"],
		["query", "spaceDelimited", false, true, "STY-19"],
		["query", "spaceDelimited", true, true, "STY-20"],
		["query", "pipeDelimited", false, false, "STY-21"],
		["query", "pipeDelimited", true, false, "STY-22"],
		["query", "pipeDelimited", false, true, "STY-23"],
		["query", "pipeDelimited", true, true, "STY-24"],
		["header", "simple", false, false, "STY-31"],
		["header", "simple", true, false, "STY-32"]
	]
	return Option.map(
		Arr.findFirst(
			rows,
			([at, named, exploded, reserved]) =>
				at === location && named === chosen && exploded === explode && reserved === allowReserved
		),
		([, , , , row]) => row
	)
}

/** The styles a location defines on a line. */
const stylesOf = (where: Location, line: SpecLine): ReadonlyArray<Style> => {
	switch (where) {
		case "path":
			return ["label", "matrix", "simple"]
		case "query":
			return ["deepObject", "form", "pipeDelimited", "spaceDelimited"]
		case "header":
			return ["simple"]
		case "cookie":
			return line === "3.2" ? ["cookie", "form"] : ["form"]
		case "querystring":
			return []
	}
}

/** The deepObject row of a line, by whether explode and allowReserved are written true. */
const deepObjectRow = (line: SpecLine, explode: boolean, allowReserved: boolean): string =>
	line === "3.2"
		? allowReserved
			? "STY-30"
			: "STY-27"
		: allowReserved
			? explode
				? "STY-28"
				: "STY-29"
			: explode
				? "STY-25"
				: "STY-26"

const sortedRows = (rows: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.sort(Arr.dedupe(rows), Order.String)

/** An RFC 9110 token, as an RFC 6265 cookie name must be. */
const tokenName = regex("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$", "u")

/** Whether a name is an RFC 9110 token. */
const isToken = (name: string): boolean => tokenName.test(name)

/** Whether a name carries a control character, which no wire name may. */
const hasControl = (name: string): boolean => Str.includes("\u0001")(name)

/** The parameter's decision, as design 6.1 states it, before its operation reads it. */
const decided = (sketch: ParameterSketch): ParameterModelOutcome["outcome"] => {
	const carrier = sketch.carrier
	const lower = Str.toLowerCase(sketch.name)
	if (sketch.location === "querystring" && sketch.line !== "3.2") {
		return { kind: "unreadable", reason: "line-mismatch" }
	}
	switch (carrier.kind) {
		case "neither":
			return { kind: "unreadable", reason: "schema-xor-content" }
		case "both":
			return sketch.location === "querystring"
				? {
						kind: "refused",
						required: sketch.required,
						findings: [refusal("STY-45/querystring-schema-fields")]
					}
				: { kind: "unreadable", reason: "schema-xor-content" }
		case "twoEntries":
			return { kind: "unreadable", reason: "content-entry-count" }
		case "schema":
		case "content":
			break
	}
	if (sketch.location === "path" && !sketch.required) {
		return { kind: "unreadable", reason: "path-not-required" }
	}
	const refused = (finding: Finding): ParameterModelOutcome["outcome"] => ({
		kind: "refused",
		required: sketch.required,
		findings: [finding]
	})
	if (
		sketch.location === "header" &&
		(lower === "accept" || lower === "authorization" || lower === "content-type")
	) {
		return { kind: "ignored", findings: [notice("PRM-19/ignored-header")] }
	}
	if (sketch.location === "header" && lower === "cookie") {
		return refused(refusal("PRM-21/cookie-header"))
	}
	if (hasControl(sketch.name)) {
		return refused(refusal("PRM-02/invalid-name"))
	}
	if (sketch.location === "cookie" && !isToken(sketch.name)) {
		return refused(refusal("PRM-02/invalid-cookie-name"))
	}
	const emptyValue = Option.getOrElse(sketch.allowEmptyValue, () => false)
	const description = Option.map(sketch.description, (each) => descriptionOf(each)[1])
	const base = {
		location: sketch.location,
		wireName: sketch.name,
		required: sketch.required,
		deprecated: Option.getOrElse(sketch.deprecated, () => false),
		description
	}
	const site = sketch.referenced ? "/components/parameters/Shared" : parameterPointer(sketch)
	if (carrier.kind === "content") {
		if (sketch.location === "querystring" && Option.isSome(carrier.forbidden)) {
			return refused(refusal("STY-45/querystring-schema-fields"))
		}
		if (carrier.media === "*/*" || carrier.media === "text/*") {
			return refused(refusal("PRM-15/invalid-media-type"))
		}
		if (!carrier.schema) {
			return refused(refusal("PRM-15/missing-schema"))
		}
		const contentRows =
			sketch.location === "querystring"
				? ["STY-42", "STY-43"]
				: sketch.location === "header" || sketch.location === "cookie"
					? ["PRM-24"]
					: ["PRM-23"]
		return {
			kind: "implemented",
			findings: emptyValue ? [notice("PRM-08/allow-empty-value-ignored")] : [],
			parameter: {
				...base,
				rows: ["PRM-01", "PRM-15"],
				schemaKey: `${site}/content/${token(carrier.media)}/schema`,
				serialization: {
					kind: "content",
					mediaType: carrier.media,
					rows: sortedRows(["PRM-15", ...contentRows])
				}
			}
		}
	}
	if (sketch.location === "querystring") {
		return refused(refusal("STY-45/querystring-schema-fields"))
	}
	const where = sketch.location
	const traits = traitsOf(carrier.shape, sketch.line)
	const chosen = Option.getOrElse(carrier.style, (): Style =>
		where === "path" || where === "header" ? "simple" : "form"
	)
	const explode = Option.getOrElse(carrier.explode, () => chosen === "form" || chosen === "cookie")
	if (!Arr.contains(stylesOf(where, sketch.line), chosen)) {
		return refused(refusal("STY-40/style-location"))
	}
	const honored =
		where === "query" ||
		(sketch.line === "3.2" && (where === "path" || (where === "cookie" && chosen === "form")))
	const reservedWritten = Option.getOrElse(carrier.allowReserved, () => false)
	const allowReserved = honored && reservedWritten
	const deepRow =
		chosen === "deepObject"
			? Option.some(
					deepObjectRow(
						sketch.line,
						Option.getOrElse(carrier.explode, () => false),
						allowReserved
					)
				)
			: Option.none()
	const notices: ReadonlyArray<Finding> = [
		...(emptyValue && where !== "query" ? [notice("PRM-08/allow-empty-value-ignored")] : []),
		...(sketch.line === "3.0" && where === "header"
			? [notice("PRM-32/header-percent-encoding")]
			: []),
		...(reservedWritten && !honored ? [notice("PRM-35/allow-reserved-ignored")] : []),
		...Option.match(deepRow, {
			onNone: () => [],
			onSome: (row) =>
				sketch.line !== "3.2" && !Option.getOrElse(carrier.explode, () => false)
					? [notice(`${row}/explode-no-effect`)]
					: []
		})
	]
	const objectValued = traits.objects
	const schemaKey =
		carrier.shape === "refFlat"
			? "Flat"
			: carrier.shape === "refNested"
				? "Filter"
				: carrier.shape === "cyclic"
					? "Cycle"
					: `${site}/schema`
	const styled = (
		row: string,
		plan: Readonly<{ explode: boolean; brackets: boolean; scalars: boolean }>,
		extra: ReadonlyArray<Finding>
	) => ({
		kind: "implemented" as const,
		findings: [...notices, ...extra],
		parameter: {
			...base,
			rows: where === "query" && emptyValue ? ["PRM-01", "PRM-08"] : ["PRM-01"],
			schemaKey,
			serialization: {
				kind: "style" as const,
				style: chosen,
				explode: plan.explode,
				allowReserved,
				rows: sortedRows(where === "query" && emptyValue ? [row, "PRM-08"] : [row]),
				objectValued,
				nonStandard: plan.brackets ? Option.some("deepObjectBrackets") : Option.none(),
				nonStandardScalars: plan.scalars ? Option.some("deepObjectScalars") : Option.none()
			}
		}
	})
	if (where === "cookie") {
		if (!explode && sketch.line === "3.2") {
			const row = chosen === "cookie" ? "STY-39" : allowReserved ? "STY-37" : "STY-35"
			return refused(refusal(`${row}/cookie-explode-false`))
		}
		if (chosen === "form" && traits.compound) {
			return refused(refusal("PRM-34/cookie-form-multiple"))
		}
		const row = !explode
			? "STY-34"
			: chosen === "cookie"
				? "STY-38"
				: allowReserved
					? "STY-36"
					: "STY-33"
		return styled(row, { explode, brackets: false, scalars: false }, [])
	}
	const found = Option.orElse(deepRow, () => tableRow(where, chosen, explode, allowReserved))
	if (Option.isNone(found)) {
		return refused(refusal("STY-40/style-location"))
	}
	const row = found.value
	const switches = {
		brackets: Option.getOrElse(sketch.brackets, () => false),
		scalars: Option.getOrElse(sketch.scalars, () => false)
	}
	const cover = Option.isSome(deepRow) && switches.scalars ? traits.cover : "strict"
	if (row === "STY-18" || row === "STY-20" || row === "STY-22" || row === "STY-24") {
		return refused(refusal(`${row}/explode-not-applicable`))
	}
	if ((chosen === "spaceDelimited" || chosen === "pipeDelimited") && traits.primitive) {
		return refused(refusal(`${row}/primitive-not-applicable`))
	}
	if (chosen === "deepObject" && cover === "strict" && !traits.objectsOrArrays) {
		return refused(refusal("PRM-27/non-object-schema"))
	}
	const nested = Option.isSome(deepRow) && traits.nested
	const marks: Option.Option<Readonly<{ brackets: boolean; scalars: boolean }>> =
		cover === "scalars"
			? Option.some({ brackets: false, scalars: true })
			: cover === "scalarsWithNested"
				? switches.brackets
					? Option.some({ brackets: true, scalars: true })
					: Option.none()
				: nested && !switches.brackets
					? Option.none()
					: Option.some({ brackets: nested, scalars: false })
	return Option.match(marks, {
		onNone: () => refused(refusal("PRM-27/compound-nested")),
		onSome: (marked) =>
			styled(row, { explode: explode || Option.isSome(deepRow), ...marked }, [
				...(marked.brackets ? [notice("PRM-27/bracket-author-choice")] : []),
				...(marked.scalars ? [notice("PRM-27/scalar-author-choice")] : [])
			])
	})
}

/** A parameter normalized, and its operation, as design 6.1 and 6.3 state. */
export const expectedOf = (sketch: ParameterSketch): ParameterModelOutcome => {
	const outcome = decided(sketch)
	const findings = outcome.kind === "unreadable" ? [] : outcome.findings
	return {
		sites: Arr.isReadonlyArrayNonEmpty(findings)
			? [
					siteOf(
						parameterPointer(sketch),
						sketch.referenced ? ["/components/parameters/Shared"] : [],
						Str.replaceAll("\u0001", "")(sketch.name)
					)
				]
			: [],
		outcome,
		operation:
			outcome.kind === "unreadable"
				? "unreadable"
				: outcome.kind === "refused" && outcome.required
					? "raised"
					: "kept"
	}
}

/** Where every diagnostic of a parameter stands: its use site at element scope, its reference's target, its wire name. */
const siteOf = (pointer: string, related: ReadonlyArray<string>, wire: string): string =>
	`${pointer} element [${Arr.join(related, " ")}] ${wire}`

/** A diagnostic's findings as the model states them. */
const findingsOf = (
	diagnostics: ReadonlyArray<Readonly<{ code: string; severity: "notice" | "refusal" }>>
): ReadonlyArray<Finding> => Arr.map(diagnostics, (each): Finding => [each.code, each.severity])

/** One parameter normalized alone, and its operation as the whole document normalizes. */
export const actualOf = (sketch: ParameterSketch) =>
	Effect.gen(function* () {
		const document = documentOf(sketch)
		const resolution = yield* resolvedAt(sketch.line, document, [])
		const nonStandard = {
			...Option.match(sketch.brackets, {
				onNone: () => ({}),
				onSome: (each) => ({ deepObjectBrackets: each })
			}),
			...Option.match(sketch.scalars, {
				onNone: () => ({}),
				onSome: (each) => ({ deepObjectScalars: each })
			})
		}
		const single = yield* Effect.exit(
			normalizeParameter(resolution, {
				nonStandard,
				openapi: openapiOf[sketch.line],
				pointer: parameterPointer(sketch)
			})
		)
		const whole = yield* Effect.exit(normalizedAt(sketch.line, document, { nonStandard }))
		const outcome: ParameterModelOutcome["outcome"] = Exit.match(single, {
			onFailure: (cause) => ({
				kind: "unreadable",
				reason: Option.match(Cause.findErrorOption(cause), {
					onNone: () => "died",
					onSome: (error) => error.reason
				})
			}),
			onSuccess: (found): ParameterModelOutcome["outcome"] => {
				switch (found._tag) {
					case "Ignored":
						return { kind: "ignored", findings: findingsOf(found.diagnostics) }
					case "Refused":
						return {
							kind: "refused",
							required: found.required,
							findings: findingsOf(found.diagnostics)
						}
					case "Implemented": {
						const parameter = found.parameter
						const serialization = parameter.serialization
						return {
							kind: "implemented",
							findings: findingsOf(found.diagnostics),
							parameter: {
								location: parameter.location,
								wireName: String(parameter.wireName),
								required: parameter.required,
								deprecated: parameter.deprecated,
								rows: Arr.map(parameter.rows, String),
								description: Option.map(Option.fromUndefinedOr(parameter.docs.description), String),
								schemaKey: parameter.schema.key,
								serialization:
									serialization.kind === "content"
										? {
												kind: "content",
												mediaType: String(serialization.mediaType),
												rows: Arr.map(serialization.rows, String)
											}
										: {
												kind: "style",
												style: serialization.style,
												explode: serialization.explode,
												allowReserved: serialization.allowReserved,
												rows: Arr.map(serialization.rows, String),
												objectValued: serialization.objectValued,
												nonStandard: Option.fromUndefinedOr(serialization.nonStandard),
												nonStandardScalars: Option.fromUndefinedOr(serialization.nonStandardScalars)
											}
							}
						}
					}
				}
			}
		})
		const diagnostics = Exit.match(single, {
			onFailure: () => [],
			onSuccess: (found) => found.diagnostics
		})
		const model: ParameterModelOutcome = {
			sites: Arr.dedupe(
				Arr.map(
					diagnostics,
					(each) =>
						`${String(each.pointer)} ${each.scope} [${Arr.join(
							Arr.map(each.related ?? [], (site) => String(site.pointer)),
							" "
						)}] ${each.wire ?? ""}`
				)
			),
			outcome,
			operation: Exit.match(whole, {
				onFailure: () => "unreadable",
				onSuccess: ({ api, diagnostics: all }) =>
					Arr.isReadonlyArrayNonEmpty(api.operations)
						? "kept"
						: Arr.some(all, (each) => each.code === "OPR-08/required-parameter-refused")
							? "raised"
							: "removed"
			})
		}
		return model
	})

/** The features a sketch and its model reach. */
export const parameterFeatures = (
	sketch: ParameterSketch,
	model: ParameterModelOutcome
): ReadonlyArray<ParameterFeature> => {
	const outcome = model.outcome
	const codes = outcome.kind === "unreadable" ? [] : Arr.map(outcome.findings, ([code]) => code)
	const has = (prefix: string) => Arr.some(codes, (code) => Str.startsWith(prefix)(code))
	const serialization =
		outcome.kind === "implemented" ? Option.some(outcome.parameter.serialization) : Option.none()
	const style = Option.flatMap(serialization, (each) =>
		each.kind === "style" ? Option.some(each) : Option.none()
	)
	const carrier = sketch.carrier
	const facts: ReadonlyArray<readonly [boolean, ParameterFeature]> = [
		[
			carrier.kind === "schema" && Option.isNone(carrier.style) && Option.isSome(style),
			"location default style"
		],
		[sketch.location === "path" && Option.isSome(style), "path style row"],
		[
			sketch.location === "query" && Option.exists(style, (each) => each.style !== "deepObject"),
			"query style row"
		],
		[sketch.location === "header" && Option.isSome(style), "header style row"],
		[
			sketch.location === "cookie" && Option.exists(style, (each) => each.style === "form"),
			"cookie form"
		],
		[
			sketch.location === "cookie" && Option.exists(style, (each) => each.style === "cookie"),
			"cookie style on 3.2"
		],
		[has("STY-35/") || has("STY-37/") || has("STY-39/"), "cookie explode false refused for good"],
		[has("PRM-34/"), "cookie form over an array or object"],
		[Option.exists(style, (each) => each.style === "deepObject"), "deepObject built"],
		[
			Arr.some(codes, (code) => Str.endsWith("/explode-no-effect")(code)),
			"deepObject explode corrected"
		],
		[has("PRM-27/compound-nested"), "deepObject nested refused"],
		[
			Option.exists(
				style,
				(each) => Option.isSome(each.nonStandard) && Option.isNone(each.nonStandardScalars)
			),
			"deepObject nested under the bracket switch"
		],
		[has("PRM-27/non-object-schema"), "deepObject over a non-object"],
		[
			Option.exists(
				style,
				(each) => Option.isSome(each.nonStandardScalars) && Option.isNone(each.nonStandard)
			),
			"deepObject scalars under the scalar switch"
		],
		[
			Option.exists(
				style,
				(each) => Option.isSome(each.nonStandardScalars) && Option.isSome(each.nonStandard)
			),
			"deepObject under both switches"
		],
		[
			Arr.some(codes, (code) => Str.endsWith("/explode-not-applicable")(code)),
			"explode not applicable"
		],
		[
			Arr.some(codes, (code) => Str.endsWith("/primitive-not-applicable")(code)),
			"delimited style over a primitive"
		],
		[
			Option.exists(
				style,
				(each) => each.style === "spaceDelimited" || each.style === "pipeDelimited"
			),
			"delimited style over an array or object"
		],
		[has("STY-40/"), "style the location does not define"],
		[Option.exists(style, (each) => each.allowReserved), "allowReserved honored"],
		[
			sketch.line === "3.2" &&
				sketch.location === "path" &&
				Option.exists(style, (each) => each.allowReserved),
			"3.2 path allowReserved honored"
		],
		[has("PRM-35/"), "allowReserved ignored"],
		[
			Option.exists(serialization, (each) => Arr.contains(each.rows, "PRM-08")),
			"allowEmptyValue honored"
		],
		[has("PRM-08/"), "allowEmptyValue ignored"],
		[has("PRM-32/"), "3.0 header percent-encoding"],
		[has("PRM-19/"), "ignored header"],
		[has("PRM-21/"), "Cookie header refused"],
		[has("PRM-02/invalid-name"), "invalid name"],
		[has("PRM-02/invalid-cookie-name"), "invalid cookie name"],
		[
			Option.exists(serialization, (each) => each.kind === "content") &&
				sketch.location !== "querystring",
			"content parameter"
		],
		[has("PRM-15/invalid-media-type"), "content media type not concrete"],
		[has("PRM-15/missing-schema"), "content without schema"],
		[
			Option.exists(serialization, (each) => each.kind === "content") &&
				sketch.location === "querystring",
			"querystring content"
		],
		[has("STY-45/"), "querystring with schema fields"],
		[sketch.referenced && outcome.kind === "implemented", "referenced parameter"],
		[
			Option.exists(sketch.description, (each) => each === "unsafe") &&
				outcome.kind === "implemented",
			"help text sanitized"
		],
		[model.operation === "raised", "required parameter refused raises its operation"],
		[outcome.kind === "unreadable", "unreadable parameter"],
		[Option.exists(style, (each) => each.objectValued), "object-valued parameter"]
	]
	return Arr.map(
		Arr.filter(facts, ([holds]) => holds),
		([, feature]) => feature
	)
}
