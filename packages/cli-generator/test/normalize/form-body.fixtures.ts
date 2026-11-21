/** What the property of form-body.test.ts reads: form-urlencoded body sketches and the rules design 6.3 states. */

import type { Json } from "@bjornpagen/grizzle-text/utf8"
import {
	aimed,
	boolean,
	constant,
	type Gen,
	oneOf,
	option,
	uniqueArray,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order, Record as Rec, String as Str } from "effect"
import type { SpecLine } from "#model/spec-section.ts"
import { normalizeBody } from "#normalize/bodies.ts"
import { documentAt, lineGen, openapiOf, resolvedAt } from "#test/support/normalizing.ts"

/** A form property's schema: scalars, an object, a nested object, null, binary strings, arrays, or untyped. */
type PropertySchema =
	| "string"
	| "integer"
	| "boolean"
	| "object"
	| "nested"
	| "null"
	| "base64"
	| "byte"
	| "strings"
	| "integers"
	| "untyped"

/** A style a form Encoding entry may name. */
type Style = "form" | "spaceDelimited" | "pipeDelimited" | "deepObject"

/** An explicit contentType: the type the default table gives the property, another valid one, or one that is no list. */
type ContentType =
	| "table"
	| "TABLE"
	| "text/plain"
	| "image/png"
	| "application/json"
	| "not a type"
	| ""
	| "a/b,"

/** A property's Encoding Object: style fields, a contentType, and the fields only multipart reads. */
type Entry = Readonly<{
	style: Option.Option<Style>
	explode: Option.Option<boolean>
	allowReserved: Option.Option<boolean>
	contentType: Option.Option<ContentType>
	headers: boolean
	nested: boolean
	itemEncoding: boolean
	prefixEncoding: boolean
}>

/** One property of the form body's schema and its Encoding Object, if any. */
type Property = Readonly<{
	name: string
	schema: PropertySchema
	required: boolean
	entry: Option.Option<Entry>
}>

/** A form-urlencoded body: its properties, an encoding key naming none of them, and 3.2's positional fields. */
type FormSketch = Readonly<{
	line: SpecLine
	key: "application/x-www-form-urlencoded" | "Application/X-WWW-Form-Urlencoded; charset=utf-8"
	properties: ReadonlyArray<Property>
	ghost: boolean
	positional: boolean
	brackets: boolean
}>

/** What a case reaches. */
export type FormFeature =
	| "default table string"
	| "default table binary string"
	| "default table scalar"
	| "default table object"
	| "default table null"
	| "default table array"
	| "default table untyped"
	| "style fields kept"
	| "contentType beside style ignored"
	| "explicit contentType equal to the table"
	| "explicit contentType refused on an optional property"
	| "explicit contentType refused on a required property"
	| "contentType that is no list refused"
	| "explode not applicable"
	| "delimited style over a primitive"
	| "deepObject over a non-object"
	| "deepObject nested refused"
	| "deepObject nested under the bracket switch"
	| "deepObject explode corrected"
	| "multipart-only fields ignored"
	| "unknown encoding key refused"
	| "unknown encoding key ignored on 3.2"
	| "positional fields ignored on 3.2"
	| "3.0 rows"

const schemaOn = (line: SpecLine): Gen<PropertySchema> =>
	weighted([
		[
			3,
			oneOf([
				constant<PropertySchema>("string"),
				constant<PropertySchema>("integer"),
				constant<PropertySchema>("boolean")
			])
		],
		[2, oneOf([constant<PropertySchema>("object"), constant<PropertySchema>("nested")])],
		[2, oneOf([constant<PropertySchema>("strings"), constant<PropertySchema>("integers")])],
		[
			1,
			oneOf([
				constant<PropertySchema>("untyped"),
				...(line === "3.0"
					? [constant<PropertySchema>("byte")]
					: [constant<PropertySchema>("null"), constant<PropertySchema>("base64")])
			])
		]
	])

const style: Gen<Style> = oneOf([
	constant<Style>("form"),
	constant<Style>("spaceDelimited"),
	constant<Style>("pipeDelimited"),
	constant<Style>("deepObject")
])

const contentType: Gen<ContentType> = weighted([
	[3, oneOf([constant<ContentType>("table"), constant<ContentType>("TABLE")])],
	[
		2,
		oneOf([
			constant<ContentType>("text/plain"),
			constant<ContentType>("image/png"),
			constant<ContentType>("application/json")
		])
	],
	[
		1,
		oneOf([
			constant<ContentType>("not a type"),
			constant<ContentType>(""),
			constant<ContentType>("a/b,")
		])
	]
])

const rare = (source: Parameters<Gen<boolean>>[0]): boolean =>
	boolean(source) && boolean(source) && boolean(source)

const entryOn =
	(line: SpecLine): Gen<Entry> =>
	(source) => {
		const styled = boolean(source)
		return {
			style: styled ? option(style)(source) : Option.none(),
			explode: styled ? option(boolean)(source) : Option.none(),
			allowReserved: styled && rare(source) ? Option.some(boolean(source)) : Option.none(),
			contentType: weighted<Option.Option<ContentType>>([
				[1, constant(Option.none())],
				[styled ? 1 : 3, (inner) => Option.some(contentType(inner))]
			])(source),
			headers: rare(source),
			nested: line === "3.2" && rare(source),
			itemEncoding: line === "3.2" && rare(source),
			prefixEncoding: line === "3.2" && rare(source)
		}
	}

const propertyOn =
	(line: SpecLine) =>
	(name: string): Gen<Property> =>
	(source) => ({
		name,
		schema: schemaOn(line)(source),
		required: boolean(source),
		entry: option(entryOn(line))(source)
	})

const drawnForm: Gen<FormSketch> = (source) => {
	const line = lineGen(source)
	return {
		line,
		key: weighted<FormSketch["key"]>([
			[3, constant("application/x-www-form-urlencoded")],
			[1, constant("Application/X-WWW-Form-Urlencoded; charset=utf-8")]
		])(source),
		properties: uniqueArray(
			oneOf([
				constant("q"),
				constant("tags"),
				constant("meta"),
				constant("file"),
				constant("count")
			]),
			propertyOn(line),
			{ min: 1, max: 3 }
		)(source),
		ghost: rare(source),
		positional: line === "3.2" && rare(source),
		brackets: boolean(source)
	}
}

/** A drawn form with one property in place of its first: a case built to reach one situation. */
const reaching =
	(property: (line: SpecLine) => Gen<Property>, fields: Partial<FormSketch>): Gen<FormSketch> =>
	(source) => {
		const drawn = drawnForm(source)
		const line = fields.line ?? drawn.line
		return { ...drawn, ...fields, line, properties: [property(line)(source)] }
	}

const plainEntry: Entry = {
	style: Option.none(),
	explode: Option.none(),
	allowReserved: Option.none(),
	contentType: Option.none(),
	headers: false,
	nested: false,
	itemEncoding: false,
	prefixEncoding: false
}

const styledProperty = (
	schema: PropertySchema,
	chosen: Style,
	explode: Option.Option<boolean>,
	required: boolean
): Gen<Property> =>
	constant({
		name: "q",
		schema,
		required,
		entry: Option.some({ ...plainEntry, style: Option.some(chosen), explode })
	})

/** Form bodies, aimed at the situations a draw reaches rarely. */
export const formSpace = aimed<FormSketch, FormFeature>(drawnForm, [
	[
		"explode not applicable",
		reaching(() => styledProperty("strings", "spaceDelimited", Option.some(true), false), {})
	],
	[
		"delimited style over a primitive",
		reaching(() => styledProperty("string", "pipeDelimited", Option.none(), true), {})
	],
	[
		"deepObject over a non-object",
		reaching(() => styledProperty("integer", "deepObject", Option.some(true), false), {})
	],
	[
		"deepObject nested refused",
		reaching(() => styledProperty("nested", "deepObject", Option.some(true), true), {
			brackets: false
		})
	],
	[
		"deepObject nested under the bracket switch",
		reaching(() => styledProperty("nested", "deepObject", Option.some(true), false), {
			brackets: true
		})
	],
	[
		"deepObject explode corrected",
		reaching(() => styledProperty("object", "deepObject", Option.none(), false), { line: "3.1" })
	],
	[
		"unknown encoding key refused",
		reaching(() => (source) => propertyOn("3.0")("q")(source), { line: "3.0", ghost: true })
	],
	[
		"unknown encoding key ignored on 3.2",
		reaching(() => (source) => propertyOn("3.2")("q")(source), { line: "3.2", ghost: true })
	],
	[
		"positional fields ignored on 3.2",
		reaching(() => (source) => propertyOn("3.2")("q")(source), { line: "3.2", positional: true })
	],
	[
		"explicit contentType refused on a required property",
		reaching(
			() =>
				constant({
					name: "meta",
					schema: "object",
					required: true,
					entry: Option.some({ ...plainEntry, contentType: Option.some("text/plain") })
				}),
			{}
		)
	],
	[
		"explicit contentType refused on an optional property",
		reaching(
			() =>
				constant({
					name: "meta",
					schema: "object",
					required: false,
					entry: Option.some({ ...plainEntry, contentType: Option.some("image/png") })
				}),
			{}
		)
	],
	[
		"contentType that is no list refused",
		reaching(
			() =>
				constant({
					name: "q",
					schema: "string",
					required: false,
					entry: Option.some({ ...plainEntry, contentType: Option.some("a/b,") })
				}),
			{}
		)
	],
	[
		"multipart-only fields ignored",
		reaching(
			() =>
				constant({
					name: "q",
					schema: "object",
					required: false,
					entry: Option.some({
						...plainEntry,
						headers: true,
						nested: true,
						itemEncoding: true,
						prefixEncoding: true
					})
				}),
			{ line: "3.2" }
		)
	]
])

/** A property schema as written. */
const schemaJson = (value: PropertySchema): Json => {
	switch (value) {
		case "string":
			return { type: "string" }
		case "integer":
			return { type: "integer" }
		case "boolean":
			return { type: "boolean" }
		case "object":
			return { properties: { a: { type: "string" } }, type: "object" }
		case "nested":
			return { properties: { a: { type: "object" } }, type: "object" }
		case "null":
			return { type: "null" }
		case "base64":
			return { contentEncoding: "base64", type: "string" }
		case "byte":
			return { format: "byte", type: "string" }
		case "strings":
			return { items: { type: "string" }, type: "array" }
		case "integers":
			return { items: { type: "integer" }, type: "array" }
		case "untyped":
			return {}
	}
}

/** The default table (ENC-17 to ENC-26) for a top-level form property: its row and its type. */
const tableOf = (value: PropertySchema, line: SpecLine): readonly [row: string, type: string] => {
	switch (value) {
		case "string":
			return ["ENC-20", "text/plain"]
		case "integer":
		case "boolean":
			return ["ENC-21", "text/plain"]
		case "object":
		case "nested":
			return ["ENC-22", "application/json"]
		case "null":
			return ["ENC-25", "text/plain"]
		case "base64":
			return ["ENC-19", "application/octet-stream"]
		case "byte":
			return ["ENC-18", "application/octet-stream"]
		case "strings":
			return [line === "3.2" ? "ENC-24" : "ENC-23", "text/plain"]
		case "integers":
			return [line === "3.2" ? "ENC-24" : "ENC-23", "text/plain"]
		case "untyped":
			return line === "3.0"
				? ["ENC-26", "application/octet-stream"]
				: ["ENC-17", "application/octet-stream"]
	}
}

/** An explicit contentType as written for a property. */
const contentTypeText = (value: ContentType, property: Property, line: SpecLine): string => {
	switch (value) {
		case "table":
			return tableOf(property.schema, line)[1]
		case "TABLE":
			return Str.toUpperCase(tableOf(property.schema, line)[1])
		case "text/plain":
		case "image/png":
		case "application/json":
		case "not a type":
		case "":
		case "a/b,":
			return value
	}
}

const entryJson = (entry: Entry, property: Property, line: SpecLine): Json => ({
	...Option.match(entry.style, { onNone: () => ({}), onSome: (each) => ({ style: each }) }),
	...Option.match(entry.explode, { onNone: () => ({}), onSome: (each) => ({ explode: each }) }),
	...Option.match(entry.allowReserved, {
		onNone: () => ({}),
		onSome: (each) => ({ allowReserved: each })
	}),
	...Option.match(entry.contentType, {
		onNone: () => ({}),
		onSome: (each) => ({ contentType: contentTypeText(each, property, line) })
	}),
	...(entry.headers ? { headers: { "X-Part": { schema: { type: "string" } } } } : {}),
	...(entry.nested ? { encoding: { a: { contentType: "text/plain" } } } : {}),
	...(entry.itemEncoding ? { itemEncoding: { contentType: "text/plain" } } : {}),
	...(entry.prefixEncoding ? { prefixEncoding: [{ contentType: "text/plain" }] } : {})
})

/** The form body as written. */
const bodyJson = (sketch: FormSketch): Json => ({
	content: {
		[sketch.key]: {
			schema: {
				properties: Rec.fromEntries(
					Arr.map(sketch.properties, (each): readonly [string, Json] => [
						each.name,
						schemaJson(each.schema)
					])
				),
				required: Arr.map(
					Arr.filter(sketch.properties, (each) => each.required),
					(each) => each.name
				),
				type: "object"
			},
			encoding: {
				...Rec.fromEntries(
					Arr.flatMap(sketch.properties, (each): ReadonlyArray<readonly [string, Json]> =>
						Option.match(each.entry, {
							onNone: () => [],
							onSome: (entry) => [[each.name, entryJson(entry, each, sketch.line)]]
						})
					)
				),
				...(sketch.ghost ? { ghost: { style: "form" } } : {})
			},
			...(sketch.positional
				? {
						itemEncoding: { contentType: "text/plain" },
						prefixEncoding: [{ contentType: "text/plain" }]
					}
				: {})
		}
	}
})

const bodyPointer = "/paths/~1a/post/requestBody"

const documentOf = (sketch: FormSketch): Json =>
	documentAt(sketch.line, {
		paths: {
			"/a": { post: { requestBody: bodyJson(sketch), responses: { "200": { description: "ok" } } } }
		}
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

/** A kept property's rule as the model states it. */
type RuleModel = Readonly<{
	target: string
	contentType: ReadonlyArray<string>
	serialization: Option.Option<
		Readonly<{
			style: Option.Option<string>
			explode: Option.Option<boolean>
			allowReserved: Option.Option<boolean>
		}>
	>
	rows: ReadonlyArray<string>
	nonStandard: Option.Option<string>
}>

/** The form alternative normalized, as design 6.3 states it. */
type FormModel = Readonly<{
	alternative: Option.Option<
		Readonly<{ rules: ReadonlyArray<RuleModel>; refusedFields: ReadonlyArray<string> }>
	>
	findings: ReadonlyArray<Located>
}>

/** A finding before it is placed: its code, severity, own pointer, and whether it drops what it refuses. */
type Raw = Readonly<{ code: string; severity: "notice" | "refusal"; at: string; drops: boolean }>

const raw = (code: string, severity: "notice" | "refusal", at: string, drops: boolean): Raw => ({
	code,
	severity,
	at,
	drops
})

/** Whether a schema is an object or an array for deepObject, nested for deepObject, primitive for the delimited styles. */
const objectsOrArrays = (value: PropertySchema): boolean =>
	value === "object" || value === "nested" || value === "strings" || value === "integers"

const nestedValue = (value: PropertySchema): boolean =>
	value === "nested" || value === "strings" || value === "integers"

const primitive = (value: PropertySchema): boolean =>
	value === "string" ||
	value === "integer" ||
	value === "boolean" ||
	value === "null" ||
	value === "base64" ||
	value === "byte"

/** Whether a drawn contentType is a comma-separated list of media ranges. */
const isList = (value: ContentType): boolean =>
	value !== "not a type" && value !== "" && value !== "a/b,"

/** The deepObject explode-or-row facts a style's entry is judged by, through the query style table (design 6.1, 6.3). */
const styleRefusal = (entry: Entry, schema: PropertySchema): Option.Option<string> => {
	const chosen = Option.getOrElse(entry.style, (): Style => "form")
	const reserved = Option.getOrElse(entry.allowReserved, () => false)
	if (chosen === "deepObject") {
		return objectsOrArrays(schema) ? Option.none() : Option.some("PRM-27/non-object-schema")
	}
	const explode = Option.getOrElse(entry.explode, () => chosen === "form")
	const rowOf: Readonly<
		Record<Exclude<Style, "deepObject">, readonly [string, string, string, string]>
	> = {
		form: ["STY-14", "STY-13", "STY-16", "STY-15"],
		spaceDelimited: ["STY-17", "STY-18", "STY-19", "STY-20"],
		pipeDelimited: ["STY-21", "STY-22", "STY-23", "STY-24"]
	}
	const [plain, exploded, reservedPlain, reservedExploded] = rowOf[chosen]
	const row = reserved ? (explode ? reservedExploded : reservedPlain) : explode ? exploded : plain
	if (chosen !== "form" && explode) {
		return Option.some(`${row}/explode-not-applicable`)
	}
	return chosen !== "form" && primitive(schema)
		? Option.some(`${row}/primitive-not-applicable`)
		: Option.none()
}

/** One property's rule, or the findings that refuse it, as design 6.3 states (formRule). */
const ruleOf = (
	sketch: FormSketch,
	property: Property,
	media: string
): Readonly<{ rule: Option.Option<RuleModel>; findings: ReadonlyArray<Raw> }> => {
	const entry = Option.getOrElse(property.entry, () => plainEntry)
	const at = Option.isSome(property.entry)
		? `${media}/encoding/${property.name}`
		: `${media}/schema/properties/${property.name}`
	const styled =
		Option.isSome(entry.style) || Option.isSome(entry.explode) || Option.isSome(entry.allowReserved)
	const [tableRow, tableType] = tableOf(property.schema, sketch.line)
	const ignored: ReadonlyArray<Raw> = [
		...(entry.nested
			? [raw("ENC-07/nested-encoding-ignored", "notice", `${at}/encoding`, false)]
			: []),
		...(entry.headers ? [raw("ENC-11/headers-ignored", "notice", `${at}/headers`, false)] : []),
		...(entry.itemEncoding
			? [raw("ENC-09/item-encoding-ignored", "notice", `${at}/itemEncoding`, false)]
			: []),
		...(entry.prefixEncoding
			? [raw("ENC-08/prefix-encoding-ignored", "notice", `${at}/prefixEncoding`, false)]
			: [])
	]
	const lineRows = sketch.line === "3.0" ? ["ENC-14"] : []
	if (styled) {
		const typing: ReadonlyArray<Raw> = Option.isSome(entry.contentType)
			? [raw("ENC-13/content-type-ignored", "notice", at, false)]
			: []
		const refused = styleRefusal(entry, property.schema)
		if (Option.isSome(refused)) {
			return { rule: Option.none(), findings: [...typing, raw(refused.value, "refusal", at, true)] }
		}
		const deep = Option.exists(entry.style, (each) => each === "deepObject")
		const nested = deep && nestedValue(property.schema)
		if (nested && !sketch.brackets) {
			return {
				rule: Option.none(),
				findings: [...typing, raw("PRM-27/compound-nested", "refusal", at, true)]
			}
		}
		return {
			rule: Option.some({
				target: property.name,
				contentType: [],
				serialization: Option.some({
					style: entry.style,
					explode: entry.explode,
					allowReserved: entry.allowReserved
				}),
				rows: Arr.sort(
					Arr.dedupe([
						"ENC-01",
						...(Option.isSome(entry.style) ? ["ENC-04"] : []),
						...(Option.isSome(entry.explode) ? ["ENC-05"] : []),
						...(Option.isSome(entry.allowReserved) ? ["ENC-06"] : []),
						"ENC-13",
						"ENC-12",
						...lineRows
					]),
					Order.String
				),
				nonStandard: nested ? Option.some("deepObjectBrackets") : Option.none()
			}),
			findings: [
				...typing,
				...(nested ? [raw("PRM-27/bracket-author-choice", "notice", at, false)] : []),
				...(deep && sketch.line !== "3.2" && !Option.getOrElse(entry.explode, () => false)
					? [raw("ENC-12/explode-no-effect", "notice", at, false)]
					: []),
				...ignored
			]
		}
	}
	return Option.match(entry.contentType, {
		onNone: () => ({
			rule: Option.some({
				target: property.name,
				contentType: [tableType],
				serialization: Option.none(),
				rows: Arr.sort(Arr.dedupe(["ENC-01", tableRow, ...lineRows]), Order.String),
				nonStandard: Option.none()
			}),
			findings: ignored
		}),
		onSome: (given) => {
			if (!isList(given)) {
				return {
					rule: Option.none(),
					findings: [raw("ENC-02/invalid-content-type", "refusal", `${at}/contentType`, true)]
				}
			}
			const text = contentTypeText(given, property, sketch.line)
			if (Str.toLowerCase(text) !== tableType) {
				return {
					rule: Option.none(),
					findings: [raw("ENC-02/form-content-type", "refusal", `${at}/contentType`, true)]
				}
			}
			return {
				rule: Option.some({
					target: property.name,
					contentType: [text],
					serialization: Option.none(),
					rows: Arr.sort(Arr.dedupe(["ENC-01", "ENC-02", tableRow, ...lineRows]), Order.String),
					nonStandard: Option.none()
				}),
				findings: ignored
			}
		}
	})
}

/** The form alternative normalized, its findings placed as design 6.3 and 8.5 place them. */
export const expectedOf = (sketch: FormSketch): FormModel => {
	const media = `${bodyPointer}/content/${Str.replaceAll("/", "~1")(sketch.key)}`
	const located = (
		finding: Raw,
		scope: string,
		pointer: string,
		related: ReadonlyArray<string>,
		wire: string
	): Located => [finding.code, finding.severity, scope, pointer, Arr.join(related, " "), wire]
	const dropped = (findings: ReadonlyArray<Raw>): FormModel => ({
		alternative: Option.none(),
		findings: Arr.map(
			Arr.filter(findings, (each) => each.code !== "PRM-27/bracket-author-choice"),
			(each) =>
				each.drops
					? located(each, "element", media, [each.at], "")
					: located(each, "element", each.at, [], "")
		)
	})
	if (sketch.ghost && sketch.line !== "3.2") {
		return dropped([raw("MED-11/unknown-property", "refusal", `${media}/encoding/ghost`, true)])
	}
	const head: ReadonlyArray<Raw> = [
		...(sketch.ghost
			? [raw("MED-12/absent-property-ignored", "notice", `${media}/encoding/ghost`, false)]
			: []),
		...(sketch.positional
			? [
					raw("MED-08/item-encoding-ignored", "notice", `${media}/itemEncoding`, false),
					raw("MED-07/prefix-encoding-ignored", "notice", `${media}/prefixEncoding`, false)
				]
			: [])
	]
	const rules: Array<RuleModel> = []
	const refusedFields: Array<string> = []
	const placed: Array<Located> = Arr.map(head, (each) => located(each, "element", each.at, [], ""))
	const all: Array<Raw> = [...head]
	for (const property of sketch.properties) {
		const result = ruleOf(sketch, property, media)
		for (const finding of result.findings) {
			all.push(finding)
		}
		if (Option.isSome(result.rule)) {
			rules.push(result.rule.value)
			for (const each of result.findings) {
				placed.push(located(each, "element", each.at, [], ""))
			}
			continue
		}
		if (property.required) {
			return dropped(all)
		}
		refusedFields.push(property.name)
		const entry = `${media}/encoding/${property.name}`
		for (const each of result.findings) {
			placed.push(
				each.drops
					? located(each, "field", entry, each.at === entry ? [] : [each.at], property.name)
					: located(each, "element", each.at, [], "")
			)
		}
	}
	return { alternative: Option.some({ rules, refusedFields }), findings: placed }
}

/** The form alternative as normalizeBody gives it. */
export const actualOf = (sketch: FormSketch) =>
	Effect.gen(function* () {
		const resolution = yield* resolvedAt(sketch.line, documentOf(sketch), [])
		const outcome = yield* normalizeBody(resolution, {
			nonStandard: sketch.brackets ? { deepObjectBrackets: true } : {},
			openapi: openapiOf[sketch.line],
			pointer: bodyPointer
		})
		const model: FormModel = {
			alternative:
				outcome._tag === "Implemented"
					? Option.map(Arr.head(outcome.body.alternatives), (found) => ({
							rules: Arr.map(found.encoding, (rule) => ({
								target:
									rule.target.kind === "property" ? rule.target.name : `#${rule.target.index}`,
								contentType: Arr.map(rule.contentType, String),
								serialization: Option.map(Option.fromUndefinedOr(rule.serialization), (each) => ({
									style: Option.fromUndefinedOr(each.style),
									explode: Option.fromUndefinedOr(each.explode),
									allowReserved: Option.fromUndefinedOr(each.allowReserved)
								})),
								rows: Arr.map(rule.rows, String),
								nonStandard: Option.fromUndefinedOr(rule.nonStandard)
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
export const formFeatures = (sketch: FormSketch, model: FormModel): ReadonlyArray<FormFeature> => {
	const codes = Arr.map(model.findings, ([code, , scope]) => `${code} ${scope}`)
	const has = (text: string) => Arr.some(codes, (code) => Str.startsWith(text)(code))
	const rules = Option.getOrElse(
		Option.map(model.alternative, (found) => found.rules),
		(): ReadonlyArray<RuleModel> => []
	)
	const tableRows = Arr.flatMap(
		Arr.filter(rules, (rule: RuleModel) => Option.isNone(rule.serialization)),
		(rule: RuleModel) => rule.rows
	)
	const facts: ReadonlyArray<readonly [boolean, FormFeature]> = [
		[Arr.contains(tableRows, "ENC-20"), "default table string"],
		[
			Arr.contains(tableRows, "ENC-18") || Arr.contains(tableRows, "ENC-19"),
			"default table binary string"
		],
		[Arr.contains(tableRows, "ENC-21"), "default table scalar"],
		[Arr.contains(tableRows, "ENC-22"), "default table object"],
		[Arr.contains(tableRows, "ENC-25"), "default table null"],
		[Arr.contains(tableRows, "ENC-23") || Arr.contains(tableRows, "ENC-24"), "default table array"],
		[
			Arr.contains(tableRows, "ENC-17") || Arr.contains(tableRows, "ENC-26"),
			"default table untyped"
		],
		[Arr.some(rules, (rule) => Option.isSome(rule.serialization)), "style fields kept"],
		[has("ENC-13/content-type-ignored"), "contentType beside style ignored"],
		[
			Arr.some(rules, (rule) => Arr.contains(rule.rows, "ENC-02")),
			"explicit contentType equal to the table"
		],
		[has("ENC-02/form-content-type field"), "explicit contentType refused on an optional property"],
		[
			has("ENC-02/form-content-type element"),
			"explicit contentType refused on a required property"
		],
		[has("ENC-02/invalid-content-type"), "contentType that is no list refused"],
		[
			Arr.some(codes, (code) => Str.includes("/explode-not-applicable")(code)),
			"explode not applicable"
		],
		[
			Arr.some(codes, (code) => Str.includes("/primitive-not-applicable")(code)),
			"delimited style over a primitive"
		],
		[has("PRM-27/non-object-schema"), "deepObject over a non-object"],
		[has("PRM-27/compound-nested"), "deepObject nested refused"],
		[
			Arr.some(rules, (rule) => Option.isSome(rule.nonStandard)),
			"deepObject nested under the bracket switch"
		],
		[has("ENC-12/explode-no-effect"), "deepObject explode corrected"],
		[
			has("ENC-07/") || has("ENC-08/") || has("ENC-09/") || has("ENC-11/"),
			"multipart-only fields ignored"
		],
		[has("MED-11/unknown-property"), "unknown encoding key refused"],
		[has("MED-12/absent-property-ignored"), "unknown encoding key ignored on 3.2"],
		[has("MED-07/") || has("MED-08/"), "positional fields ignored on 3.2"],
		[
			sketch.line === "3.0" && Arr.some(rules, (rule) => Arr.contains(rule.rows, "ENC-14")),
			"3.0 rows"
		]
	]
	return Arr.map(
		Arr.filter(facts, ([holds]) => holds),
		([, feature]) => feature
	)
}
