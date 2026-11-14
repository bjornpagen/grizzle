import { regex } from "arkregex"
import {
	Array as Arr,
	Effect,
	Option,
	Predicate,
	Record,
	Result,
	Schema,
	String as Str
} from "effect"
import {
	entriesOf,
	expressionsOf,
	listOf,
	locate,
	operationOf,
	pathItems,
	rootMember,
	site
} from "#check/path-items.ts"
import type { Operation, PathItem, Place } from "#check/path-items.ts"
import { HeaderName, MediaRange } from "#model/brands.ts"
import { makeDiagnostic } from "#model/diagnostic.ts"
import type { Diagnostic } from "#model/diagnostic.ts"
import { isObject, isArray, nodeAt, stringMember } from "#model/json-tree.ts"
import type { JsonObject } from "#model/json-tree.ts"
import { methodMembers } from "#model/path-item.ts"
import { childPointer, isPointerWithin } from "#model/pointer.ts"
import type { Json } from "#model/pointer.ts"
import { specSectionUrl, patchVersion } from "#model/spec-section.ts"
import { keyOf } from "#resolve/canonical.ts"
import { allOfReferrers, implicitComponent } from "#resolve/index.ts"
import type { Resolution, ResolveLimits } from "#resolve/index.ts"

interface Rule {
	readonly anchor: string
	readonly element: string
	readonly hint?: string
	readonly message: string
	readonly scope: "document" | "element" | "operation"
	readonly severity: "notice" | "refusal"
}

const rules = {
	"DSC-03/unresolved-target": {
		anchor: "discriminator-mapping",
		element: "Discriminator mapping",
		hint: "Map to a component schema name or to a reference to a schema in the document.",
		message:
			"A discriminator mapping value does not resolve to a schema. The discriminator is not used.",
		scope: "element",
		severity: "refusal"
	},
	"DSC-04/unresolved-target": {
		anchor: "discriminator-default-mapping",
		element: "Discriminator defaultMapping",
		hint: "Point defaultMapping at a component schema name or a reference to a schema in the document.",
		message:
			"The discriminator defaultMapping does not resolve to a schema. The discriminator is not used.",
		scope: "element",
		severity: "refusal"
	},
	"DSC-05/no-composition": {
		anchor: "discriminator-object",
		element: "Discriminator",
		hint: "Put the discriminator beside oneOf or anyOf, or on a base schema that allOf children reference.",
		message:
			"A discriminator is legal only with oneOf, anyOf or allOf, and this schema uses none. The discriminator is not used.",
		scope: "element",
		severity: "refusal"
	},
	"DSC-09/property-not-required": {
		anchor: "discriminator-object",
		element: "Discriminator propertyName",
		hint: "List the property in required, on the schema or on every branch.",
		message: "The discriminating property is not required. The discriminator is not used.",
		scope: "element",
		severity: "refusal"
	},
	"DSC-10/missing-default-mapping": {
		anchor: "discriminator-default-mapping",
		element: "Discriminator",
		hint: "Require the property or add a defaultMapping.",
		message:
			"An optional discriminating property needs a defaultMapping. The discriminator is not used.",
		scope: "element",
		severity: "refusal"
	},
	"HDR-01/invalid-header-name": {
		anchor: "header-object",
		element: "Encoding header name",
		hint: "Name the header with an RFC 9110 token.",
		message: "An encoding header name is not an RFC 9110 token.",
		scope: "element",
		severity: "refusal"
	},
	"HDR-13/parameter-only-field": {
		anchor: "header-object",
		element: "Header Object field",
		hint: "Remove allowEmptyValue and allowReserved from the Header Object.",
		message: "A Header Object uses allowEmptyValue or allowReserved, which the text forbids.",
		scope: "document",
		severity: "refusal"
	},
	"MED-24/invalid-media-type": {
		anchor: "media-types",
		element: "Media type key",
		hint: "Use a media type or range such as application/json, text/* or */*.",
		message: "A content key is not an RFC 9110 media type or range.",
		scope: "element",
		severity: "refusal"
	},
	"PRM-20/invalid-header-name": {
		anchor: "parameter-locations",
		element: "Header parameter name",
		hint: "Name the header with an RFC 9110 token.",
		message: "A header parameter name is not an RFC 9110 token.",
		scope: "element",
		severity: "refusal"
	},
	"REF-18/node-budget": {
		anchor: "reference-object",
		element: "Schema graph",
		hint: "Reduce how often schemas reuse each other through allOf, oneOf and anyOf.",
		message: "The schema graph needs more steps to check than the node budget allows.",
		scope: "document",
		severity: "refusal"
	},
	"RSP-09/invalid-header-name": {
		anchor: "response-headers",
		element: "Response header name",
		hint: "Name the header with an RFC 9110 token.",
		message: "A response header name is not an RFC 9110 token.",
		scope: "element",
		severity: "refusal"
	},
	"RSS-04/no-response-code": {
		anchor: "responses-object",
		element: "Responses Object",
		hint: "Add a status code, a status range or default.",
		message: "A Responses Object has only x- keys, so it holds no response code.",
		scope: "document",
		severity: "refusal"
	},
	"RSS-10/invalid-status": {
		anchor: "responses-code",
		element: "Response status key",
		hint: "Use a status code from 100 to 599, a range from 1XX to 5XX, or default.",
		message: "A responses key is not a status code in 100 to 599, a range 1XX to 5XX, or default.",
		scope: "element",
		severity: "refusal"
	},
	"S30-09/not-unicode-compilable": {
		anchor: "json-schema-keywords",
		element: "Schema pattern",
		hint: "Escape the pattern for Unicode mode, or accept that the server validates it.",
		message: "The pattern does not compile in Unicode mode; the value is sent unvalidated.",
		scope: "element",
		severity: "notice"
	},
	"S30-22/array-without-items": {
		anchor: "json-schema-keywords",
		element: "Schema items",
		hint: "Add items with the schema of the array elements.",
		message: "A 3.0 schema of type array has no items.",
		scope: "element",
		severity: "refusal"
	},
	"S30-30/read-and-write-only": {
		anchor: "schema-read-only",
		element: "Schema readOnly and writeOnly",
		hint: "Set at most one of readOnly and writeOnly to true.",
		message: "A schema sets readOnly and writeOnly to true together.",
		scope: "element",
		severity: "refusal"
	},
	"SCH-37/not-unicode-compilable": {
		anchor: "json-schema-keywords",
		element: "Schema pattern",
		hint: "Escape the pattern for Unicode mode, or accept that the server validates it.",
		message: "The pattern does not compile in Unicode mode; the value is sent unvalidated.",
		scope: "element",
		severity: "notice"
	},
	"SEC-09/unresolved-scheme": {
		anchor: "security-requirements-name",
		element: "Security requirement name",
		hint: "Declare the scheme under components.securitySchemes or fix the name.",
		message: "A security requirement names a scheme that is not declared.",
		scope: "element",
		severity: "refusal"
	},
	"SEC-10/unresolved-scheme": {
		anchor: "security-requirements-name",
		element: "Security requirement name",
		hint: "Name a component scheme, or a URI that identifies a Security Scheme in the document.",
		message:
			"A security requirement names neither a component scheme nor a Security Scheme URI in the document.",
		scope: "element",
		severity: "refusal"
	},
	"SEC-12/non-empty-scopes": {
		anchor: "security-requirements-name",
		element: "Security requirement scopes",
		hint: "Use an empty array for schemes other than oauth2 and openIdConnect.",
		message: "A 3.0 security requirement lists values for a scheme that takes none.",
		scope: "element",
		severity: "refusal"
	},
	"SRV-04/duplicate-name": {
		anchor: "server-name",
		element: "Server name",
		hint: "Give each server in a list its own name.",
		message: "A server name is used by an earlier server in the same list.",
		scope: "operation",
		severity: "refusal"
	},
	"SRV-12/default-not-in-enum": {
		anchor: "server-variable-default",
		element: "Server variable default",
		hint: "Add the default to the enum, or change the default.",
		message: "A server variable default is not one of its enum values.",
		scope: "operation",
		severity: "refusal"
	},
	"SRV-18/query-or-fragment": {
		anchor: "server-url",
		element: "Server url",
		hint: "Remove the query or fragment from the server URL.",
		message: "A server URL contains a query or a fragment.",
		scope: "operation",
		severity: "refusal"
	},
	"SRV-19/repeated-variable": {
		anchor: "server-variable-object",
		element: "Server url",
		hint: "Use each server variable once in the URL.",
		message: "A server variable appears more than once in the server URL.",
		scope: "operation",
		severity: "refusal"
	}
} as const satisfies Record.ReadonlyRecord<string, Rule>

type Code = keyof typeof rules

interface Finding {
	readonly code: Code
	readonly operation?: Operation
	readonly pointer: string
	readonly scope?: Rule["scope"]
	readonly severity?: Rule["severity"]
}

const statusKey = regex("^(?:[1-5][0-9]{2}|[1-5]XX|default)$", "u")

const queryOrFragment = regex("[?#]", "u")

const schemaMembers: readonly string[] = [
	"additionalProperties",
	"contains",
	"contentSchema",
	"else",
	"if",
	"items",
	"not",
	"propertyNames",
	"then",
	"unevaluatedItems",
	"unevaluatedProperties"
]

const schemaLists: readonly string[] = ["allOf", "anyOf", "oneOf", "prefixItems"]

const schemaMaps: readonly string[] = [
	"$defs",
	"definitions",
	"dependentSchemas",
	"patternProperties",
	"properties"
]

const compositions: readonly string[] = ["allOf", "anyOf", "oneOf"]

const parameterOnlyFields: readonly string[] = ["allowEmptyValue", "allowReserved"]

const isReference = (node: JsonObject): boolean =>
	Option.exists(Record.get(node, "$ref"), Predicate.isString)

/**
 * The value when it is an object other than a Reference Object.
 */
const ownObject = (value: Option.Option<Json>): Option.Option<JsonObject> =>
	Option.filter(Option.filter(value, isObject), (object) => !isReference(object))

/**
 * The findings `walk` reports for a value that is there, none for nothing.
 */
const whenSome = <A>(
	value: Option.Option<A>,
	walk: (present: A) => readonly Finding[]
): readonly Finding[] => Option.match(value, { onNone: () => [], onSome: walk })

/**
 * Whether the member `name` of an object is `true`.
 */
const isTrue = (node: JsonObject, name: string): boolean =>
	Option.exists(Record.get(node, name), (value) => value === true)

const isToken = Schema.is(HeaderName)

const isMediaRange = Schema.is(MediaRange)

const compilesWithU = (source: string): boolean =>
	Result.isSuccess(Result.try(() => regex.as(source, "u")))

const at = (code: Code, pointer: string): Finding => ({ code, pointer })

/**
 * A discriminator mapping value: a component schema name first, else a reference into the set
 * (`implicitComponent`); either way the target must be a Schema Object.
 */
const mappingResolves = (resolution: Resolution, value: string): boolean =>
	Option.match(implicitComponent(resolution, "schemas", value), {
		onNone: () => false,
		onSome: (key) => Option.exists(nodeAt(resolution.value, key.pointer), isObject)
	})

/**
 * One checkGrammar call's walk through allOf, oneOf and anyOf: answers already settled, the
 * schemas being walked (by depth) and the steps left. Reuse across members is a DAG, so each
 * (schema, name) pair is settled once; the budget bounds a hostile graph that stays large anyway.
 */
interface Search {
	readonly active: Map<string, number>
	readonly budget: number
	exhausted: boolean
	readonly memo: Map<string, boolean>
	steps: number
}

const startSearch = (budget: number): Search => ({
	active: new Map(),
	budget,
	exhausted: false,
	memo: new Map(),
	steps: 0
})

interface Answer {
	readonly found: boolean
	/**
	 * The shallowest schema still being walked that this answer assumed to be no; unsettled below it.
	 */
	readonly low: number
}

const settled = (found: boolean): Answer => ({ found, low: Number.POSITIVE_INFINITY })

/**
 * Whether the schema at `place` requires `name`: directly, through its own `$ref` or allOf, or in
 * every oneOf/anyOf branch. References are followed, a schema that is only a `$ref` (a component
 * aliasing another) among them, since its target's assertions are its own; a schema already on the
 * path counts as no. A no that leaned on such a schema is kept only once that schema is settled.
 */
const requiresAt = (
	resolution: Resolution,
	search: Search,
	place: Place,
	name: string,
	depth: number
): Answer => {
	const key = `${place.document}#${place.pointer}\u0000${name}`
	const known = search.memo.get(key)
	const walking = search.active.get(key)
	search.steps += 1

	if (known !== undefined) {
		return settled(known)
	}

	if (walking !== undefined) {
		return { found: false, low: walking }
	}

	if (search.steps > search.budget) {
		search.exhausted = true

		return { found: false, low: -1 }
	}

	search.active.set(key, depth)

	const members = (keyword: string): readonly Place[] =>
		Arr.flatMap(listOf(Record.get(place.node, keyword)), (member, index) =>
			Option.toArray(
				locate(
					resolution,
					{
						document: place.document,
						pointer: childPointer(childPointer(place.pointer, keyword), `${index}`)
					},
					member
				)
			)
		)
	const within = (member: Place): Answer => requiresAt(resolution, search, member, name, depth + 1)
	const referenced = Option.toArray(
		Option.filter(
			stringMember(place.node, "$ref") === undefined
				? Option.none()
				: locate(resolution, { document: place.document, pointer: place.pointer }, place.node),
			(target) => target.document !== place.document || target.pointer !== place.pointer
		)
	)
	const answer = ((): Answer => {
		if (Arr.contains(listOf(Record.get(place.node, "required")), name)) {
			return settled(true)
		}

		let low = Number.POSITIVE_INFINITY

		for (const member of [...referenced, ...members("allOf")]) {
			const inner = within(member)

			if (inner.found) {
				return settled(true)
			}

			low = Math.min(low, inner.low)
		}

		const alternatives = [...members("oneOf"), ...members("anyOf")]

		if (Arr.isReadonlyArrayEmpty(alternatives)) {
			return { found: false, low }
		}

		for (const member of alternatives) {
			const inner = within(member)

			if (!inner.found) {
				return { found: false, low: Math.min(low, inner.low) }
			}
		}

		return settled(true)
	})()

	search.active.delete(key)

	if (answer.found || answer.low >= depth) {
		search.memo.set(key, answer.found)

		return settled(answer.found)
	}

	return answer
}

const requires = (resolution: Resolution, search: Search, place: Place, name: string): boolean =>
	requiresAt(resolution, search, place, name, 0).found

const composes = (node: JsonObject): boolean =>
	Arr.some(compositions, (keyword) =>
		Arr.isReadonlyArrayNonEmpty(listOf(Record.get(node, keyword)))
	)

/**
 * The discriminator findings of the schema at `place`. An allOf base is legal too: the
 * discriminator sits on the base and the children reference it (DSC-11).
 */
const discriminatorFindings = (
	resolution: Resolution,
	search: Search,
	place: Place,
	discriminator: JsonObject
): readonly Finding[] => {
	const base = childPointer(place.pointer, "discriminator")
	const self = keyOf({ document: place.document, pointer: place.pointer })
	if (!composes(place.node) && !allOfReferrers(resolution).has(self)) {
		return [at("DSC-05/no-composition", base)]
	}

	const name = stringMember(discriminator, "propertyName")
	const required = name !== undefined && requires(resolution, search, place, name)
	const defaultMapping = stringMember(discriminator, "defaultMapping")
	const property =
		name === undefined || required || resolution.line === "3.2"
			? []
			: [at("DSC-09/property-not-required", childPointer(base, "propertyName"))]
	const optional =
		name === undefined || required || resolution.line !== "3.2" || defaultMapping !== undefined
			? []
			: [at("DSC-10/missing-default-mapping", base)]
	const mapped = Arr.flatMap(entriesOf(Record.get(discriminator, "mapping")), ([key, value]) =>
		Predicate.isString(value) && !mappingResolves(resolution, value)
			? [at("DSC-03/unresolved-target", childPointer(childPointer(base, "mapping"), key))]
			: []
	)
	const fallback =
		resolution.line === "3.2" &&
		defaultMapping !== undefined &&
		!mappingResolves(resolution, defaultMapping)
			? [at("DSC-04/unresolved-target", childPointer(base, "defaultMapping"))]
			: []

	return [...property, ...optional, ...mapped, ...fallback]
}

const ownSchemaFindings = (
	resolution: Resolution,
	search: Search,
	place: Place
): readonly Finding[] => {
	const { node, pointer } = place
	const pattern = stringMember(node, "pattern")
	const legacy = resolution.line === "3.0"
	const patternCode = legacy ? "S30-09/not-unicode-compilable" : "SCH-37/not-unicode-compilable"

	return [
		...(pattern === undefined || compilesWithU(pattern)
			? []
			: [at(patternCode, childPointer(pointer, "pattern"))]),
		...(legacy && stringMember(node, "type") === "array" && !Record.has(node, "items")
			? [at("S30-22/array-without-items", childPointer(pointer, "items"))]
			: []),
		...(legacy && isTrue(node, "readOnly") && isTrue(node, "writeOnly")
			? [at("S30-30/read-and-write-only", pointer)]
			: []),
		...whenSome(Option.filter(Record.get(node, "discriminator"), isObject), (discriminator) =>
			discriminatorFindings(resolution, search, place, discriminator)
		)
	]
}

/**
 * The findings of a Schema Object and the schemas inside it. A 3.0 Reference Object ignores its
 * siblings (design 3.3); later lines keep them as keywords.
 */
const schemaFindings = (
	resolution: Resolution,
	search: Search,
	node: Option.Option<Json>,
	pointer: string
): readonly Finding[] =>
	whenSome(Option.filter(node, isObject), (schema) =>
		resolution.line === "3.0" && isReference(schema)
			? []
			: [
					...ownSchemaFindings(resolution, search, {
						document: resolution.document,
						node: schema,
						pointer
					}),
					...Arr.flatMap(schemaMembers, (keyword) =>
						schemaFindings(
							resolution,
							search,
							Record.get(schema, keyword),
							childPointer(pointer, keyword)
						)
					),
					...Arr.flatMap(schemaLists, (keyword) =>
						Arr.flatMap(listOf(Record.get(schema, keyword)), (member, index) =>
							schemaFindings(
								resolution,
								search,
								Option.some(member),
								childPointer(childPointer(pointer, keyword), `${index}`)
							)
						)
					),
					...Arr.flatMap(schemaMaps, (keyword) =>
						Arr.flatMap(entriesOf(Record.get(schema, keyword)), ([name, member]) =>
							schemaFindings(
								resolution,
								search,
								Option.some(member),
								childPointer(childPointer(pointer, keyword), name)
							)
						)
					)
				]
	)

type HeaderCode = "HDR-01/invalid-header-name" | "RSP-09/invalid-header-name"

/**
 * The 3.1 and 3.2 schemas reject both fields on a Header Object; the 3.0 schema permits them.
 */
const headerFieldFindings = (
	resolution: Resolution,
	node: Option.Option<Json>,
	pointer: string
): readonly Finding[] =>
	resolution.line === "3.0"
		? whenSome(ownObject(node), (header) =>
				Arr.map(
					Arr.filter(parameterOnlyFields, (field) => Record.has(header, field)),
					(field) => at("HDR-13/parameter-only-field", childPointer(pointer, field))
				)
			)
		: []

/**
 * Header, Content, Media Type and Encoding objects refer to each other, so they share one record.
 */
interface Media {
	readonly encoding: (
		resolution: Resolution,
		search: Search,
		node: Option.Option<Json>,
		pointer: string
	) => readonly Finding[]
	readonly content: (
		resolution: Resolution,
		search: Search,
		content: Option.Option<Json>,
		pointer: string
	) => readonly Finding[]
	readonly header: (
		resolution: Resolution,
		search: Search,
		node: Option.Option<Json>,
		pointer: string
	) => readonly Finding[]
	readonly headers: (
		resolution: Resolution,
		search: Search,
		headers: Option.Option<Json>,
		pointer: string,
		code: HeaderCode
	) => readonly Finding[]
	readonly mediaType: (
		resolution: Resolution,
		search: Search,
		node: Option.Option<Json>,
		pointer: string
	) => readonly Finding[]
}

const media: Media = {
	content: (resolution, search, content, pointer) =>
		Arr.flatMap(entriesOf(content), ([name, mediaType]) => [
			...(isMediaRange(name) ? [] : [at("MED-24/invalid-media-type", childPointer(pointer, name))]),
			...media.mediaType(resolution, search, Option.some(mediaType), childPointer(pointer, name))
		]),
	encoding: (resolution, search, node, pointer) =>
		whenSome(ownObject(node), (encoding) =>
			media.headers(
				resolution,
				search,
				Record.get(encoding, "headers"),
				childPointer(pointer, "headers"),
				"HDR-01/invalid-header-name"
			)
		),
	header: (resolution, search, node, pointer) =>
		whenSome(ownObject(node), (header) => [
			...schemaFindings(
				resolution,
				search,
				Record.get(header, "schema"),
				childPointer(pointer, "schema")
			),
			...media.content(
				resolution,
				search,
				Record.get(header, "content"),
				childPointer(pointer, "content")
			)
		]),
	headers: (resolution, search, headers, pointer, code) =>
		Arr.flatMap(entriesOf(headers), ([name, header]) => [
			...(isToken(name) ? [] : [at(code, childPointer(pointer, name))]),
			...headerFieldFindings(resolution, Option.some(header), childPointer(pointer, name)),
			...media.header(resolution, search, Option.some(header), childPointer(pointer, name))
		]),
	mediaType: (resolution, search, node, pointer) =>
		whenSome(ownObject(node), (mediaType) => [
			...schemaFindings(
				resolution,
				search,
				Record.get(mediaType, "schema"),
				childPointer(pointer, "schema")
			),
			...schemaFindings(
				resolution,
				search,
				Record.get(mediaType, "itemSchema"),
				childPointer(pointer, "itemSchema")
			),
			...Arr.flatMap(entriesOf(Record.get(mediaType, "encoding")), ([name, encoding]) =>
				media.encoding(
					resolution,
					search,
					Option.some(encoding),
					childPointer(childPointer(pointer, "encoding"), name)
				)
			),
			...media.encoding(
				resolution,
				search,
				Record.get(mediaType, "itemEncoding"),
				childPointer(pointer, "itemEncoding")
			),
			...Arr.flatMap(listOf(Record.get(mediaType, "prefixEncoding")), (encoding, index) =>
				media.encoding(
					resolution,
					search,
					Option.some(encoding),
					childPointer(childPointer(pointer, "prefixEncoding"), `${index}`)
				)
			)
		])
}

const parameterFindings = (
	resolution: Resolution,
	search: Search,
	node: Option.Option<Json>,
	pointer: string
): readonly Finding[] =>
	whenSome(ownObject(node), (parameter) => {
		const name = stringMember(parameter, "name")
		const badName =
			stringMember(parameter, "in") === "header" && name !== undefined && !isToken(name)
				? [at("PRM-20/invalid-header-name", childPointer(pointer, "name"))]
				: []

		return [...badName, ...media.header(resolution, search, Option.some(parameter), pointer)]
	})

const parameterListFindings = (
	resolution: Resolution,
	search: Search,
	list: Option.Option<Json>,
	pointer: string
): readonly Finding[] =>
	Arr.flatMap(listOf(list), (parameter, index) =>
		parameterFindings(resolution, search, Option.some(parameter), childPointer(pointer, `${index}`))
	)

const responseFindings = (
	resolution: Resolution,
	search: Search,
	node: Option.Option<Json>,
	pointer: string
): readonly Finding[] =>
	whenSome(ownObject(node), (response) => [
		...media.headers(
			resolution,
			search,
			Record.get(response, "headers"),
			childPointer(pointer, "headers"),
			"RSP-09/invalid-header-name"
		),
		...media.content(
			resolution,
			search,
			Record.get(response, "content"),
			childPointer(pointer, "content")
		)
	])

/**
 * The 3.1 and 3.2 schemas refuse a Responses Object of `x-` keys alone; the 3.0 schema counts an
 * `x-` key toward its one required member (D-OC3).
 */
const extensionsOnly = (resolution: Resolution, responses: Option.Option<Json>): boolean => {
	const keys = Arr.map(entriesOf(responses), ([code]) => code)

	return (
		resolution.line === "3.0" &&
		Arr.isReadonlyArrayNonEmpty(keys) &&
		Arr.every(keys, (code) => Str.startsWith("x-")(code))
	)
}

const responsesFindings = (
	resolution: Resolution,
	search: Search,
	responses: Option.Option<Json>,
	pointer: string
): readonly Finding[] => [
	...(extensionsOnly(resolution, responses) ? [at("RSS-04/no-response-code", pointer)] : []),
	...Arr.flatMap(entriesOf(responses), ([code, response]) =>
		Str.startsWith("x-")(code)
			? []
			: [
					...(statusKey.test(code)
						? []
						: [at("RSS-10/invalid-status", childPointer(pointer, code))]),
					...responseFindings(
						resolution,
						search,
						Option.some(response),
						childPointer(pointer, code)
					)
				]
	)
]

const requestBodyFindings = (
	resolution: Resolution,
	search: Search,
	node: Option.Option<Json>,
	pointer: string
): readonly Finding[] =>
	whenSome(ownObject(node), (body) =>
		media.content(resolution, search, Record.get(body, "content"), childPointer(pointer, "content"))
	)

/**
 * Path Item, Operation and Callback objects refer to each other through callbacks.
 */
interface Items {
	readonly callback: (
		resolution: Resolution,
		search: Search,
		node: Option.Option<Json>,
		pointer: string
	) => readonly Finding[]
	readonly operation: (
		resolution: Resolution,
		search: Search,
		node: Option.Option<Json>,
		pointer: string
	) => readonly Finding[]
	readonly pathItem: (
		resolution: Resolution,
		search: Search,
		node: Option.Option<Json>,
		pointer: string
	) => readonly Finding[]
}

/**
 * An operation member of a path item: its pointer and its value, if any.
 */
interface OperationMember {
	readonly node: Option.Option<Json>
	readonly pointer: string
}

const items: Items = {
	callback: (resolution, search, node, pointer) =>
		whenSome(ownObject(node), (callback) =>
			Arr.flatMap(Record.toEntries(callback), ([key, item]) =>
				Str.startsWith("x-")(key)
					? []
					: items.pathItem(resolution, search, Option.some(item), childPointer(pointer, key))
			)
		),
	operation: (resolution, search, node, pointer) =>
		whenSome(Option.filter(node, isObject), (operation) => [
			...parameterListFindings(
				resolution,
				search,
				Record.get(operation, "parameters"),
				childPointer(pointer, "parameters")
			),
			...requestBodyFindings(
				resolution,
				search,
				Record.get(operation, "requestBody"),
				childPointer(pointer, "requestBody")
			),
			...responsesFindings(
				resolution,
				search,
				Record.get(operation, "responses"),
				childPointer(pointer, "responses")
			),
			...Arr.flatMap(entriesOf(Record.get(operation, "callbacks")), ([name, callback]) =>
				items.callback(
					resolution,
					search,
					Option.some(callback),
					childPointer(childPointer(pointer, "callbacks"), name)
				)
			)
		]),
	pathItem: (resolution, search, node, pointer) =>
		whenSome(ownObject(node), (item) => {
			const fixed = Arr.map(methodMembers(resolution.line), (method): OperationMember => ({
				node: Record.get(item, method),
				pointer: childPointer(pointer, method)
			}))
			const extra =
				resolution.line === "3.2"
					? Arr.map(
							entriesOf(Record.get(item, "additionalOperations")),
							([name, operation]): OperationMember => ({
								node: Option.some(operation),
								pointer: childPointer(childPointer(pointer, "additionalOperations"), name)
							})
						)
					: []

			return [
				...parameterListFindings(
					resolution,
					search,
					Record.get(item, "parameters"),
					childPointer(pointer, "parameters")
				),
				...Arr.flatMap([...fixed, ...extra], (member) =>
					items.operation(resolution, search, member.node, member.pointer)
				)
			]
		})
}

const componentFindings = (resolution: Resolution, search: Search): readonly Finding[] =>
	whenSome(Option.filter(rootMember(resolution, "components"), isObject), (components) => {
		const each = (
			section: string,
			visit: (node: Option.Option<Json>, pointer: string) => readonly Finding[]
		): readonly Finding[] =>
			Arr.flatMap(entriesOf(Record.get(components, section)), ([name, node]) =>
				visit(Option.some(node), childPointer(childPointer("/components", section), name))
			)

		return [
			...each("schemas", (node, pointer) => schemaFindings(resolution, search, node, pointer)),
			...each("responses", (node, pointer) => responseFindings(resolution, search, node, pointer)),
			...each("parameters", (node, pointer) =>
				parameterFindings(resolution, search, node, pointer)
			),
			...each("requestBodies", (node, pointer) =>
				requestBodyFindings(resolution, search, node, pointer)
			),
			...each("headers", (node, pointer) => [
				...headerFieldFindings(resolution, node, pointer),
				...media.header(resolution, search, node, pointer)
			]),
			...each("pathItems", (node, pointer) => items.pathItem(resolution, search, node, pointer)),
			...each("callbacks", (node, pointer) => items.callback(resolution, search, node, pointer)),
			...each("mediaTypes", (node, pointer) => media.mediaType(resolution, search, node, pointer))
		]
	})

const elementFindings = (resolution: Resolution, search: Search): readonly Finding[] => {
	const under = (member: string): readonly Finding[] =>
		Arr.flatMap(entriesOf(rootMember(resolution, member)), ([key, item]) =>
			items.pathItem(
				resolution,
				search,
				Option.some(item),
				childPointer(childPointer("", member), key)
			)
		)

	return [
		...under("paths"),
		...(resolution.line === "3.0" ? [] : under("webhooks")),
		...componentFindings(resolution, search)
	]
}

/**
 * An operation of a path item as the server and security checks find it: its method as sent, its
 * pointer, and whether it is a 3.2 `additionalOperations` entry.
 */
interface OperationSite {
	readonly additional: boolean
	readonly method: string
	readonly pointer: string
}

const operationsOf = (resolution: Resolution, item: PathItem): readonly Operation[] => {
	const fixed = Arr.map(
		Arr.filter(methodMembers(resolution.line), (name) =>
			Option.exists(Record.get(item.node, name), isObject)
		),
		(name): OperationSite => ({
			additional: false,
			method: Str.toUpperCase(name),
			pointer: childPointer(item.pointer, name)
		})
	)
	const extra =
		resolution.line === "3.2"
			? Arr.map(
					entriesOf(Record.get(item.node, "additionalOperations")),
					([name]): OperationSite => ({
						additional: true,
						method: name,
						pointer: childPointer(childPointer(item.pointer, "additionalOperations"), name)
					})
				)
			: []

	return Arr.flatMap([...fixed, ...extra], ({ additional, method, pointer }) =>
		Option.match(Option.filter(nodeAt(resolution.value, pointer), isObject), {
			onNone: (): readonly Operation[] => [],
			onSome: (node) => [
				{ additional, id: stringMember(node, "operationId"), item, method, node, pointer }
			]
		})
	)
}

const serverFindings = (
	resolution: Resolution,
	server: Json,
	pointer: string
): readonly Finding[] => {
	if (!isObject(server)) {
		return []
	}

	const url = stringMember(server, "url")
	const names = url === undefined ? [] : expressionsOf(url)
	const repeated = Arr.dedupe(names).length !== names.length
	const defaultSeverity: Rule["severity"] = resolution.line === "3.0" ? "notice" : "refusal"
	const variables = Arr.flatMap(entriesOf(Record.get(server, "variables")), ([name, variable]) => {
		const fallback = isObject(variable) ? stringMember(variable, "default") : undefined
		const members = listOf(
			Option.flatMap(Option.filter(Option.some(variable), isObject), (object) =>
				Record.get(object, "enum")
			)
		)

		return fallback !== undefined &&
			Arr.isReadonlyArrayNonEmpty(members) &&
			!Arr.contains(members, fallback)
			? [
					{
						...at(
							"SRV-12/default-not-in-enum",
							childPointer(childPointer(pointer, "variables"), name)
						),
						severity: defaultSeverity
					}
				]
			: []
	})

	return [
		...(url !== undefined && queryOrFragment.test(url)
			? [at("SRV-18/query-or-fragment", childPointer(pointer, "url"))]
			: []),
		...(repeated ? [at("SRV-19/repeated-variable", childPointer(pointer, "url"))] : []),
		...variables
	]
}

/**
 * A `servers` list and the pointer of the object that holds it.
 */
interface ServerList {
	readonly owner: string
	readonly servers: readonly Json[]
}

const ownServers = (node: JsonObject, owner: string): Option.Option<ServerList> =>
	Option.map(Option.filter(Record.get(node, "servers"), isArray), (servers) => ({
		owner,
		servers
	}))

/**
 * Operation servers replace the path item's, which replace the root's (SRV-15).
 */
const serversOf = (resolution: Resolution, operation: Operation): ServerList =>
	ownServers(operation.node, operation.pointer).pipe(
		Option.orElse(() => ownServers(operation.item.node, operation.item.pointer)),
		Option.getOrElse(() => ({ owner: "", servers: listOf(rootMember(resolution, "servers")) }))
	)

/**
 * One server of an effective list, with its pointer.
 */
interface ServerAt {
	readonly pointer: string
	readonly server: Json
}

const effectiveServers = (resolution: Resolution, operation: Operation): readonly ServerAt[] => {
	const { owner, servers } = serversOf(resolution, operation)

	return Arr.map(servers, (server, index): ServerAt => ({
		pointer: childPointer(childPointer(owner, "servers"), `${index}`),
		server
	}))
}

/**
 * A 3.2 server name is unique within its list (D-OC3); no schema enforces it.
 */
const duplicateNameFindings = (
	resolution: Resolution,
	servers: readonly ServerAt[]
): readonly Finding[] => {
	if (resolution.line !== "3.2") {
		return []
	}

	const seen = new Set<string>()

	return Arr.flatMap(servers, ({ pointer, server }) => {
		const name = isObject(server) ? stringMember(server, "name") : undefined
		if (name === undefined) {
			return []
		}

		if (seen.has(name)) {
			return [at("SRV-04/duplicate-name", childPointer(pointer, "name"))]
		}

		seen.add(name)

		return []
	})
}

const operationServerFindings = (
	resolution: Resolution,
	operation: Operation
): readonly Finding[] => {
	const servers = effectiveServers(resolution, operation)

	return Arr.map(
		[
			...Arr.flatMap(servers, ({ pointer, server }) => serverFindings(resolution, server, pointer)),
			...duplicateNameFindings(resolution, servers)
		],
		(finding) => ({ ...finding, operation })
	)
}

const schemeNode = (resolution: Resolution, name: string): Option.Option<JsonObject> =>
	Option.flatMap(implicitComponent(resolution, "securitySchemes", name), (key) =>
		Option.flatMap(
			Option.flatMap(Option.fromUndefinedOr(resolution.documents.get(key.document)), (document) =>
				nodeAt(document, key.pointer)
			),
			(node) => Option.map(locate(resolution, key, node), (place) => place.node)
		)
	)

interface Requirement {
	readonly scopes: readonly Finding[]
	readonly unresolved: readonly Finding[]
}

/**
 * SEC-12 holds in 3.0 only: a scheme that takes no scopes must list none.
 */
const scopesFinding = (
	resolution: Resolution,
	scheme: JsonObject,
	scopes: Json,
	pointer: string
): readonly Finding[] => {
	const kind = stringMember(scheme, "type")
	const takesScopes = kind === "oauth2" || kind === "openIdConnect"

	return resolution.line === "3.0" &&
		!takesScopes &&
		Arr.isReadonlyArrayNonEmpty(listOf(Option.some(scopes)))
		? [at("SEC-12/non-empty-scopes", pointer)]
		: []
}

const requirementFindings = (
	resolution: Resolution,
	alternative: Json,
	pointer: string
): Requirement => {
	const code = resolution.line === "3.2" ? "SEC-10/unresolved-scheme" : "SEC-09/unresolved-scheme"
	const names = Arr.map(entriesOf(Option.some(alternative)), ([name, scopes]): Requirement => {
		const place = childPointer(pointer, name)

		return Option.match(schemeNode(resolution, name), {
			onNone: () => ({ scopes: [], unresolved: [at(code, place)] }),
			onSome: (scheme) => ({
				scopes: scopesFinding(resolution, scheme, scopes, place),
				unresolved: []
			})
		})
	})

	return {
		scopes: Arr.flatMap(names, (entry) => entry.scopes),
		unresolved: Arr.flatMap(names, (entry) => entry.unresolved)
	}
}

/**
 * The findings of one security requirement list. `exhausted`: every alternative names a scheme
 * that does not resolve, so none remains usable.
 */
interface SecurityList {
	readonly exhausted: boolean
	readonly scopes: readonly Finding[]
	readonly unresolved: readonly Finding[]
}

const securityList = (
	resolution: Resolution,
	list: readonly Json[],
	pointer: string
): SecurityList => {
	const requirements = Arr.map(list, (alternative, index) =>
		requirementFindings(resolution, alternative, childPointer(pointer, `${index}`))
	)

	return {
		exhausted:
			Arr.isReadonlyArrayNonEmpty(requirements) &&
			Arr.every(requirements, (requirement) => Arr.isReadonlyArrayNonEmpty(requirement.unresolved)),
		scopes: Arr.flatMap(requirements, (requirement) => requirement.scopes),
		unresolved: Arr.flatMap(requirements, (requirement) => requirement.unresolved)
	}
}

const operationScoped = (findings: readonly Finding[], operation: Operation): readonly Finding[] =>
	Arr.map(findings, (finding) => ({ ...finding, operation, scope: "operation" }))

const securityOf = (node: JsonObject): Option.Option<readonly Json[]> =>
	Option.filter(Record.get(node, "security"), isArray)

const ownSecurity = (resolution: Resolution, operation: Operation): readonly Finding[] =>
	whenSome(securityOf(operation.node), (list) => {
		const found = securityList(resolution, list, childPointer(operation.pointer, "security"))

		return [
			...(found.exhausted ? operationScoped(found.unresolved, operation) : found.unresolved),
			...found.scopes
		]
	})

/**
 * A root list that leaves an operation no alternative is that operation's refusal.
 */
const rootSecurity = (
	resolution: Resolution,
	operations: readonly Operation[]
): readonly Finding[] =>
	whenSome(Option.filter(rootMember(resolution, "security"), isArray), (list) => {
		const found = securityList(resolution, list, "/security")
		const inheriting = Arr.filter(operations, (operation) =>
			Option.isNone(securityOf(operation.node))
		)
		const unresolved =
			found.exhausted && Arr.isReadonlyArrayNonEmpty(inheriting)
				? Arr.flatMap(inheriting, (operation) => operationScoped(found.unresolved, operation))
				: found.unresolved

		return [...unresolved, ...found.scopes]
	})

const securityFindings = (
	resolution: Resolution,
	operations: readonly Operation[]
): readonly Finding[] => [
	...rootSecurity(resolution, operations),
	...Arr.flatMap(operations, (operation) => ownSecurity(resolution, operation))
]

const operationFindingsOf = (resolution: Resolution): readonly Finding[] => {
	const operations = Arr.flatMap(pathItems(resolution), (item) => operationsOf(resolution, item))

	return [
		...Arr.flatMap(operations, (operation) => operationServerFindings(resolution, operation)),
		...securityFindings(resolution, operations)
	]
}

const underItem = (operation: Operation, pointer: string): boolean =>
	operation.item.use !== operation.item.pointer && isPointerWithin(operation.item.pointer, pointer)

/**
 * The diagnostic of one finding. Under a Reference Object the use site is the pointer and the
 * target is related (design 3.3).
 */
const toDiagnostic = (resolution: Resolution, finding: Finding) => {
	const rule: Rule = rules[finding.code]
	const { operation } = finding
	const viaReference = operation !== undefined && underItem(operation, finding.pointer)

	return makeDiagnostic({
		code: finding.code,
		document: resolution.document,
		element: rule.element,
		hint: rule.hint,
		message: rule.message,
		openapi: Option.getOrElse(
			Option.filter(rootMember(resolution, "openapi"), Predicate.isString),
			() => patchVersion[resolution.line]
		),
		operation: operation === undefined ? undefined : operationOf(operation),
		pointer: viaReference ? operation.item.use : finding.pointer,
		related: viaReference ? [site(resolution, finding.pointer)] : undefined,
		scope: finding.scope ?? rule.scope,
		severity: finding.severity ?? rule.severity,
		specSection: specSectionUrl(resolution.line, rule.anchor)
	})
}

/**
 * The spec-text checks on values and grammars (design 3.4 rows 10 to 17): server variables, URLs
 * and 3.2 names, security requirement names, media type keys, header-name tokens, discriminators,
 * status keys and patterns, and the 3.0 rows the 3.0 schema leaves open: `items`, `readOnly` and
 * `writeOnly`, a Responses Object of `x-` keys alone and Header `allowEmptyValue` or
 * `allowReserved`. Pure over the resolved document; findings are refusals except the 3.0 server
 * default and the pattern notices.
 * Walking allOf, oneOf and anyOf is bounded by `limits.maxNodes` steps; past it the only finding
 * is a document-scope refusal (design 9 I5).
 */
export const checkGrammar = Effect.fnUntraced(function* checkGrammar(
	resolution: Resolution,
	limits: Pick<ResolveLimits, "maxNodes">
): Effect.fn.Return<readonly Diagnostic[]> {
	const search = startSearch(limits.maxNodes)
	const findings = [...elementFindings(resolution, search), ...operationFindingsOf(resolution)]
	const reported = search.exhausted ? [at("REF-18/node-budget", "")] : findings

	return yield* Effect.forEach(reported, (finding) => toDiagnostic(resolution, finding))
})
