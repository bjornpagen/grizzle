/** What the properties of bodies.test.ts read: request body sketches and the alternatives design 6.3 states for them. */

import {
	aimed,
	boolean,
	constant,
	type Gen,
	int,
	oneOf,
	option,
	uniqueKeys,
	weighted
} from "@bjornpagen/testing/gen"
import type { ScratchDir } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, FileSystem, Option, Order, Path, Record as Rec } from "effect"
import { Digest } from "effect/crypto"
import { checkSpecText } from "#check/index.ts"
import { generate } from "#generate.ts"
import type { Json } from "#model/pointer.ts"
import type { SpecLine } from "#model/spec-section.ts"
import { hintDiscriminators, normalizeBody } from "#normalize/bodies.ts"
import {
	configUri,
	documentAt,
	entryUri,
	lineGen,
	normalizedAt,
	openapiOf,
	resolvedAt,
	token
} from "#test/support/normalizing.ts"
import { textOf } from "#test/support/openapi-gen.ts"

/** A content key: media types of every codec family, ranges, parameters and case, and a key that is no media type. */
type MediaKey =
	| "application/json"
	| "application/problem+json"
	| "text/plain"
	| "text/csv"
	| "application/xml"
	| "text/xml"
	| "application/atom+xml"
	| "application/octet-stream"
	| "image/png"
	| "image/*"
	| "application/x-ndjson"
	| "application/json-seq"
	| "application/geo+json-seq"
	| "multipart/form-data"
	| "multipart/mixed"
	| "application/x-www-form-urlencoded"
	| "Application/X-WWW-Form-Urlencoded; charset=utf-8"
	| "not a type"

/**
 * An alternative's schema: none, an object in place or by reference, an array of objects, a string, or an object in
 * place one of whose properties has a name that is no wire name, empty or holding a control character.
 */
type SchemaKind =
	| "none"
	| "object"
	| "component"
	| "array"
	| "string"
	| "empty name"
	| "control name"

/** The misnamed property of each misnamed schema kind. */
const misnamed = { "empty name": "", "control name": "na\u0007me" } as const

/** Whether a schema kind is an object with a misnamed property. */
const isMisnamed = (kind: SchemaKind): kind is keyof typeof misnamed =>
	kind === "empty name" || kind === "control name"

/** One media type of a body: its key, its schema, and the fields a request body ignores there. */
type Alternative = Readonly<{
	key: MediaKey
	schema: SchemaKind
	encoding: boolean
	description: boolean
}>

/** A request body: in place or behind a `$ref`, its marks and its alternatives. */
type BodySketch = Readonly<{
	line: SpecLine
	referenced: boolean
	required: Option.Option<boolean>
	description: Option.Option<"plain" | "unsafe">
	alternatives: ReadonlyArray<Alternative>
}>

/** What a case reaches. */
export type BodyFeature =
	| "JSON alternative"
	| "text alternative"
	| "XML alternative carries no schema"
	| "binary alternative"
	| "media range"
	| "sequential alternative"
	| "form alternative"
	| "multipart alternative"
	| "form-data object body kept"
	| "component schema"
	| "inline schema"
	| "no schema"
	| "key that is no media type dropped"
	| "empty content refused"
	| "multipart without a schema refused"
	| "form-data array refused"
	| "unnamed multipart parts refused"
	| "encoding ignored"
	| "3.2 media description ignored"
	| "referenced body"
	| "required body refused raises its operation"
	| "several alternatives"
	| "part name that is no wire name refused"

const mediaKey: Gen<MediaKey> = weighted([
	[
		3,
		oneOf([constant<MediaKey>("application/json"), constant<MediaKey>("application/problem+json")])
	],
	[2, oneOf([constant<MediaKey>("text/plain"), constant<MediaKey>("text/csv")])],
	[
		2,
		oneOf([
			constant<MediaKey>("application/xml"),
			constant<MediaKey>("text/xml"),
			constant<MediaKey>("application/atom+xml")
		])
	],
	[
		2,
		oneOf([
			constant<MediaKey>("application/octet-stream"),
			constant<MediaKey>("image/png"),
			constant<MediaKey>("image/*")
		])
	],
	[
		1,
		oneOf([
			constant<MediaKey>("application/x-ndjson"),
			constant<MediaKey>("application/json-seq"),
			constant<MediaKey>("application/geo+json-seq")
		])
	],
	[3, oneOf([constant<MediaKey>("multipart/form-data"), constant<MediaKey>("multipart/mixed")])],
	[
		2,
		oneOf([
			constant<MediaKey>("application/x-www-form-urlencoded"),
			constant<MediaKey>("Application/X-WWW-Form-Urlencoded; charset=utf-8")
		])
	],
	[1, constant<MediaKey>("not a type")]
])

/** The codec family a key's media type selects (design 2.2), or none for a key that is no media type. */
const codecOf = (key: MediaKey): Option.Option<string> => {
	switch (key) {
		case "application/json":
		case "application/problem+json":
			return Option.some("json")
		case "text/plain":
		case "text/csv":
			return Option.some("text")
		case "application/xml":
		case "text/xml":
		case "application/atom+xml":
			return Option.some("xml")
		case "application/octet-stream":
		case "image/png":
		case "image/*":
			return Option.some("binary")
		case "application/x-ndjson":
			return Option.some("ndjson")
		case "application/json-seq":
		case "application/geo+json-seq":
			return Option.some("jsonseq")
		case "multipart/form-data":
		case "multipart/mixed":
			return Option.some("multipart")
		case "application/x-www-form-urlencoded":
		case "Application/X-WWW-Form-Urlencoded; charset=utf-8":
			return Option.some("form")
		case "not a type":
			return Option.none()
	}
}

/** An object one of whose properties is misnamed. */
const misnamedKind: Gen<SchemaKind> = oneOf([
	constant<SchemaKind>("empty name"),
	constant<SchemaKind>("control name")
])

/**
 * The schemas a key's codec takes: a form body an object, a misnamed object or none, a multipart one an object, a
 * misnamed object, an array (positional on 3.2 only for mixed) or none.
 */
const schemaFor = (key: MediaKey, line: SpecLine): Gen<SchemaKind> => {
	const codec = codecOf(key)
	if (Option.exists(codec, (each) => each === "form")) {
		return oneOf([
			constant<SchemaKind>("none"),
			constant<SchemaKind>("object"),
			constant<SchemaKind>("component"),
			misnamedKind
		])
	}
	if (Option.exists(codec, (each) => each === "multipart")) {
		return oneOf([
			constant<SchemaKind>("none"),
			constant<SchemaKind>("object"),
			constant<SchemaKind>("component"),
			misnamedKind,
			...(key === "multipart/mixed" && line !== "3.2" ? [] : [constant<SchemaKind>("array")])
		])
	}
	return oneOf([
		constant<SchemaKind>("none"),
		constant<SchemaKind>("object"),
		constant<SchemaKind>("component"),
		constant<SchemaKind>("string")
	])
}

/** Whether a codec reads Encoding Objects: a form or multipart body. */
const encodes = (key: MediaKey): boolean =>
	Option.exists(codecOf(key), (codec) => codec === "form" || codec === "multipart")

const alternative =
	(line: SpecLine) =>
	(key: MediaKey): Gen<Alternative> =>
	(source) => ({
		key,
		schema: schemaFor(key, line)(source),
		encoding: !encodes(key) && boolean(source) && boolean(source),
		description: boolean(source) && boolean(source)
	})

const drawnBody: Gen<BodySketch> = (source) => {
	const line = lineGen(source)
	const keys = uniqueKeys(mediaKey, { min: 0, max: 3 })(source)
	return {
		line,
		referenced: boolean(source) && boolean(source),
		required: option(boolean)(source),
		description: option(oneOf([constant<"plain">("plain"), constant<"unsafe">("unsafe")]))(source),
		alternatives: Arr.map(keys, (key) => alternative(line)(key)(source))
	}
}

/** A drawn body with `alternatives` in place of its own: a case built to reach one situation. */
const reaching =
	(
		alternatives: (line: SpecLine) => Gen<ReadonlyArray<Alternative>>,
		fields: Partial<BodySketch>
	): Gen<BodySketch> =>
	(source) => {
		const drawn = drawnBody(source)
		const line = fields.line ?? drawn.line
		return { ...drawn, ...fields, line, alternatives: alternatives(line)(source) }
	}

const single = (value: Alternative): Gen<ReadonlyArray<Alternative>> => constant([value])

/** Bodies, aimed at the situations a draw reaches rarely. */
export const bodySpace = aimed<BodySketch, BodyFeature>(drawnBody, [
	["empty content refused", reaching(() => constant([]), { required: Option.some(true) })],
	[
		"multipart without a schema refused",
		reaching(
			() =>
				single({ key: "multipart/form-data", schema: "none", encoding: false, description: false }),
			{ line: "3.1" }
		)
	],
	[
		"form-data object body kept",
		reaching(
			() => (source) => [
				{
					key: "multipart/form-data",
					schema: oneOf([constant<SchemaKind>("object"), constant<SchemaKind>("component")])(
						source
					),
					encoding: false,
					description: false
				}
			],
			{}
		)
	],
	[
		"form-data array refused",
		reaching(
			() =>
				single({
					key: "multipart/form-data",
					schema: "array",
					encoding: false,
					description: false
				}),
			{}
		)
	],
	[
		"unnamed multipart parts refused",
		reaching(
			() =>
				single({ key: "multipart/mixed", schema: "object", encoding: false, description: false }),
			{}
		)
	],
	[
		"required body refused raises its operation",
		reaching(
			() =>
				single({
					key: "multipart/form-data",
					schema: "array",
					encoding: false,
					description: false
				}),
			{ required: Option.some(true) }
		)
	],
	[
		"3.2 media description ignored",
		reaching(
			() =>
				single({ key: "application/json", schema: "object", encoding: false, description: true }),
			{ line: "3.2" }
		)
	],
	[
		"encoding ignored",
		reaching(
			() => single({ key: "text/plain", schema: "none", encoding: true, description: false }),
			{}
		)
	],
	[
		"XML alternative carries no schema",
		reaching(
			() =>
				single({ key: "application/xml", schema: "object", encoding: false, description: false }),
			{}
		)
	],
	[
		"referenced body",
		reaching(
			(line) => (source) => [
				alternative(line)("application/json")(source),
				alternative(line)("multipart/form-data")(source)
			],
			{ referenced: true }
		)
	],
	[
		"part name that is no wire name refused",
		reaching(
			() => (source) => [
				{
					key: oneOf([
						constant<MediaKey>("multipart/form-data"),
						constant<MediaKey>("application/x-www-form-urlencoded")
					])(source),
					schema: misnamedKind(source),
					encoding: false,
					description: false
				}
			],
			{}
		)
	]
])

const objectSchema: Json = {
	properties: { name: { type: "string" }, value: { type: "string" } },
	type: "object"
}

/** The schema a kind writes. */
const schemaJson = (kind: Exclude<SchemaKind, "none">): Json => {
	switch (kind) {
		case "object":
			return objectSchema
		case "component":
			return { $ref: "#/components/schemas/Pet" }
		case "array":
			return { items: objectSchema, type: "array" }
		case "string":
			return { type: "string" }
		case "empty name":
		case "control name":
			return {
				properties: { name: { type: "string" }, [misnamed[kind]]: { type: "string" } },
				type: "object"
			}
	}
}

const descriptionOf = (value: "plain" | "unsafe"): readonly [string, string] =>
	value === "plain" ? ["The thing.", "The thing."] : ["The\u0007 thing‮.", "The thing."]

/** The Request Body Object a sketch writes. */
const bodyJson = (sketch: BodySketch): Json => ({
	content: Rec.fromEntries(
		Arr.map(sketch.alternatives, (each): readonly [string, Json] => [
			each.key,
			{
				...(each.schema === "none" ? {} : { schema: schemaJson(each.schema) }),
				...(each.encoding ? { encoding: { name: { contentType: "text/plain" } } } : {}),
				...(each.description ? { description: "the payload" } : {})
			}
		])
	),
	...Option.match(sketch.required, { onNone: () => ({}), onSome: (each) => ({ required: each }) }),
	...Option.match(sketch.description, {
		onNone: () => ({}),
		onSome: (each) => ({ description: descriptionOf(each)[0] })
	})
})

/** The use site of the body: the one operation's request body. */
const bodyPointer = "/paths/~1a/post/requestBody"

/** The body's own place: the use site, or the component it refers to. */
const homeOf = (sketch: BodySketch): string =>
	sketch.referenced ? "/components/requestBodies/Shared" : bodyPointer

/** The document holding the body on its one POST operation. */
const documentOf = (sketch: BodySketch): Json =>
	documentAt(sketch.line, {
		components: {
			schemas: { Pet: objectSchema },
			...(sketch.referenced ? { requestBodies: { Shared: bodyJson(sketch) } } : {})
		},
		paths: {
			"/a": {
				post: {
					requestBody: sketch.referenced
						? { $ref: "#/components/requestBodies/Shared" }
						: bodyJson(sketch),
					responses: { "200": { description: "ok" } }
				}
			}
		}
	})

/** A finding as the model states it: its code, severity, scope, pointer and related pointers. */
type Located = readonly [
	code: string,
	severity: string,
	scope: string,
	pointer: string,
	related: string
]

/** An alternative as the model states it: media type, codec, schema key and rows. */
type AlternativeModel = readonly [
	mediaType: string,
	codec: string,
	schema: Option.Option<string>,
	rows: ReadonlyArray<string>
]

/** A body normalized, and its operation, as design 6.3 states them. */
type BodyModel = Readonly<{
	outcome:
		| Readonly<{
				kind: "implemented"
				required: boolean
				description: Option.Option<string>
				alternatives: ReadonlyArray<AlternativeModel>
		  }>
		| Readonly<{ kind: "refused"; required: boolean }>
	findings: ReadonlyArray<Located>
	operation: "kept" | "raised" | "removed"
}>

/** One alternative judged: kept with its model, or dropped; with what it raises at its media type. */
const judged = (
	sketch: BodySketch,
	each: Alternative
): readonly [
	Option.Option<AlternativeModel>,
	ReadonlyArray<readonly [string, string, ReadonlyArray<string>]>
] => {
	const codec = codecOf(each.key)
	const site = `${homeOf(sketch)}/content/${token(each.key)}`
	if (Option.isNone(codec)) {
		return [Option.none(), []]
	}
	const multipart = codec.value === "multipart"
	if (multipart && each.schema === "none" && sketch.line !== "3.2") {
		return [Option.none(), [["ENC-33/missing-schema", "refusal", []]]]
	}
	if (each.key === "multipart/form-data" && each.schema === "array") {
		return [Option.none(), [["MED-26/array-form-data", "refusal", []]]]
	}
	if (
		each.key === "multipart/mixed" &&
		(each.schema === "object" || each.schema === "component" || isMisnamed(each.schema))
	) {
		return [Option.none(), [["MED-25/unnamed-parts", "refusal", [`${site}/schema`]]]]
	}
	if (encodes(each.key) && isMisnamed(each.schema)) {
		const property = `${site}/schema/properties/${token(misnamed[each.schema])}`
		return [Option.none(), [["ENC-41/invalid-part-name", "refusal", [property]]]]
	}
	const opaque = codec.value === "xml"
	const schema = !opaque && each.schema !== "none"
	const rows = Arr.sort(
		Arr.dedupe([
			"MED-01",
			...(schema ? ["MED-02"] : []),
			...(each.encoding ? ["MED-06"] : []),
			...(schema ? [] : [sketch.line === "3.0" ? "RQB-10" : "RQB-09"]),
			...(codec.value === "form" ? [sketch.line === "3.2" ? "ENC-28" : "ENC-27", "ENC-29"] : [])
		]),
		Order.String
	)
	return [
		Option.some([
			each.key,
			codec.value,
			schema ? Option.some(each.schema === "component" ? "Pet" : `${site}/schema`) : Option.none(),
			rows
		]),
		[
			...(each.encoding
				? [
						[
							sketch.line === "3.2" ? "MED-14/encoding-ignored" : "MED-10/encoding-ignored",
							"notice",
							[]
						] as const
					]
				: []),
			...(each.description && sketch.line === "3.2"
				? [["MED-09/description-ignored", "notice", []] as const]
				: [])
		]
	]
}

/** The body normalized, and its operation, as design 6.3 states. */
export const expectedOf = (sketch: BodySketch): BodyModel => {
	const required = Option.getOrElse(sketch.required, () => false)
	const placed = (own: string, related: ReadonlyArray<string>): readonly [string, string] =>
		sketch.referenced
			? [bodyPointer, Arr.join([own, ...related], " ")]
			: [own, Arr.join(related, " ")]
	if (!Arr.isReadonlyArrayNonEmpty(sketch.alternatives)) {
		const [pointer, related] = placed(`${homeOf(sketch)}/content`, [])
		return {
			outcome: { kind: "refused", required },
			findings: [["RQB-07/empty-content", "refusal", "element", pointer, related]],
			operation: required ? "raised" : "kept"
		}
	}
	const each = Arr.map(sketch.alternatives, (one) => [one, judged(sketch, one)] as const)
	const findings = Arr.flatMap(each, ([one, [, found]]) => {
		const site = `${homeOf(sketch)}/content/${token(one.key)}`
		return Arr.map(found, ([code, severity, more]): Located => {
			const [pointer, related] = placed(site, more)
			return [code, severity, "element", pointer, related]
		})
	})
	const kept = Arr.getSomes(Arr.map(each, ([, [model]]) => model))
	return Arr.isReadonlyArrayNonEmpty(kept)
		? {
				outcome: {
					kind: "implemented",
					required,
					description: Option.map(sketch.description, (one) => descriptionOf(one)[1]),
					alternatives: kept
				},
				findings,
				operation: "kept"
			}
		: { outcome: { kind: "refused", required }, findings, operation: required ? "raised" : "kept" }
}

/** The body as normalizeBody gives it, and its operation as the whole document normalizes. */
export const actualOf = (sketch: BodySketch) =>
	Effect.gen(function* () {
		const document = documentOf(sketch)
		const resolution = yield* resolvedAt(sketch.line, document, [])
		const outcome = yield* normalizeBody(resolution, {
			openapi: openapiOf[sketch.line],
			pointer: bodyPointer
		})
		const whole = yield* normalizedAt(sketch.line, document, {})
		const model: BodyModel = {
			outcome:
				outcome._tag === "Implemented"
					? {
							kind: "implemented",
							required: outcome.body.required,
							description: Option.map(
								Option.fromUndefinedOr(outcome.body.docs.description),
								String
							),
							alternatives: Arr.map(outcome.body.alternatives, (each): AlternativeModel => [
								String(each.mediaType),
								each.codec,
								Option.map(Option.fromUndefinedOr(each.schema), (schema) => schema.key),
								Arr.map(each.rows, String)
							])
						}
					: { kind: "refused", required: outcome.required },
			findings: Arr.map(outcome.diagnostics, (each): Located => [
				each.code,
				each.severity,
				each.scope,
				String(each.pointer),
				Arr.join(
					Arr.map(each.related ?? [], (site) => String(site.pointer)),
					" "
				)
			]),
			operation: Arr.isReadonlyArrayNonEmpty(whole.api.operations)
				? "kept"
				: Arr.some(whole.diagnostics, (each) => each.code === "OPR-09/required-body-refused")
					? "raised"
					: "removed"
		}
		return model
	})

/** The features a sketch and its model reach. */
export const bodyFeatures = (sketch: BodySketch, model: BodyModel): ReadonlyArray<BodyFeature> => {
	const codes = new Set(Arr.map(model.findings, ([code]) => code))
	const codecs = new Set(Arr.getSomes(Arr.map(sketch.alternatives, (each) => codecOf(each.key))))
	const kept = model.outcome.kind === "implemented" ? model.outcome.alternatives : []
	const facts: ReadonlyArray<readonly [boolean, BodyFeature]> = [
		[codecs.has("json"), "JSON alternative"],
		[codecs.has("text"), "text alternative"],
		[
			Arr.some(
				sketch.alternatives,
				(each) =>
					Option.exists(codecOf(each.key), (codec) => codec === "xml") && each.schema !== "none"
			),
			"XML alternative carries no schema"
		],
		[codecs.has("binary"), "binary alternative"],
		[Arr.some(sketch.alternatives, (each) => each.key === "image/*"), "media range"],
		[codecs.has("ndjson") || codecs.has("jsonseq"), "sequential alternative"],
		[Arr.some(kept, ([, codec]) => codec === "form"), "form alternative"],
		[Arr.some(kept, ([, codec]) => codec === "multipart"), "multipart alternative"],
		[
			Arr.some(
				kept,
				([mediaType, , schema]) => mediaType === "multipart/form-data" && Option.isSome(schema)
			),
			"form-data object body kept"
		],
		[
			Arr.some(kept, ([, , schema]) => Option.exists(schema, (key) => key === "Pet")),
			"component schema"
		],
		[
			Arr.some(kept, ([, , schema]) => Option.exists(schema, (key) => key !== "Pet")),
			"inline schema"
		],
		[Arr.some(kept, ([, , schema]) => Option.isNone(schema)), "no schema"],
		[
			Arr.some(sketch.alternatives, (each) => each.key === "not a type"),
			"key that is no media type dropped"
		],
		[codes.has("RQB-07/empty-content"), "empty content refused"],
		[codes.has("ENC-33/missing-schema"), "multipart without a schema refused"],
		[codes.has("MED-26/array-form-data"), "form-data array refused"],
		[codes.has("MED-25/unnamed-parts"), "unnamed multipart parts refused"],
		[
			codes.has("MED-10/encoding-ignored") || codes.has("MED-14/encoding-ignored"),
			"encoding ignored"
		],
		[codes.has("MED-09/description-ignored"), "3.2 media description ignored"],
		[sketch.referenced && model.outcome.kind === "implemented", "referenced body"],
		[model.operation === "raised", "required body refused raises its operation"],
		[kept.length > 1, "several alternatives"],
		[codes.has("ENC-41/invalid-part-name"), "part name that is no wire name refused"]
	]
	return Arr.map(
		Arr.filter(facts, ([holds]) => holds),
		([, feature]) => feature
	)
}

/** A branch of a discriminated JSON body: a component by `$ref`, an inline object requiring the property, or one that does not. */
type Branch = "Cat" | "Dog" | "inline" | "unrequired"

/** A JSON body whose schema carries a discriminator over listed branches or an allOf base, or none at all. */
type DiscriminatorSketch = Readonly<{
	line: SpecLine
	shape:
		| Readonly<{
				kind: "listed"
				keyword: "oneOf" | "anyOf"
				branches: ReadonlyArray<Branch>
				mapping: ReadonlyArray<"cat" | "kitty" | "dog">
				discriminated: boolean
		  }>
		| Readonly<{ kind: "base"; children: ReadonlyArray<"Hound" | "Kitty"> }>
}>

/** What a case reaches. */
export type DiscriminatorFeature =
	| "branches labeled by mapping keys"
	| "branch labeled by its component name"
	| "inline branch unlabeled"
	| "anyOf branches"
	| "refused discriminator gives no hint"
	| "allOf base lists its children"
	| "no discriminator"

const branch: Gen<Branch> = weighted([
	[3, oneOf([constant<Branch>("Cat"), constant<Branch>("Dog")])],
	[2, constant<Branch>("inline")],
	[1, constant<Branch>("unrequired")]
])

/** Discriminated bodies of a drawn line: listed branches with a mapping, or an allOf base with children. */
export const discriminatorSpace: Gen<DiscriminatorSketch> = (source) => ({
	line: lineGen(source),
	shape: weighted<DiscriminatorSketch["shape"]>([
		[
			3,
			(inner) => ({
				kind: "listed",
				keyword: oneOf([constant<"oneOf">("oneOf"), constant<"anyOf">("anyOf")])(inner),
				branches: uniqueKeys(branch, { min: 1, max: 3 })(inner),
				mapping: subarrayOf(["cat", "kitty", "dog"])(inner),
				discriminated: weighted([
					[5, constant(true)],
					[1, constant(false)]
				])(inner)
			})
		],
		[1, (inner) => ({ kind: "base", children: subarrayOf(["Hound", "Kitty"])(inner) })]
	])(source)
})

/** Some of `values`, in their order. */
const subarrayOf =
	<A extends string>(values: Arr.NonEmptyReadonlyArray<A>): Gen<ReadonlyArray<A>> =>
	(source) =>
		Arr.filter(values, () => boolean(source))

const pet = (own: string): Json => ({
	properties: { [own]: { type: "boolean" }, petType: { type: "string" } },
	required: ["petType", own],
	type: "object"
})

/** The component a mapping key targets: cat and kitty name Cat (by name and by pointer), dog names Dog. */
const mappingTarget = (key: "cat" | "kitty" | "dog"): readonly [string, "Cat" | "Dog"] =>
	key === "cat"
		? ["Cat", "Cat"]
		: key === "kitty"
			? ["#/components/schemas/Cat", "Cat"]
			: ["Dog", "Dog"]

/** The mapping keys whose component is among the branches. */
const usedMapping = (
	sketch: Readonly<{
		branches: ReadonlyArray<Branch>
		mapping: ReadonlyArray<"cat" | "kitty" | "dog">
	}>
) => Arr.filter(sketch.mapping, (key) => Arr.contains(sketch.branches, mappingTarget(key)[1]))

const branchJson = (value: Branch): Json => {
	switch (value) {
		case "Cat":
		case "Dog":
			return { $ref: `#/components/schemas/${value}` }
		case "inline":
			return { properties: { petType: { type: "string" } }, required: ["petType"], type: "object" }
		case "unrequired":
			return {
				properties: { petType: { type: "string" }, purr: { type: "boolean" } },
				type: "object"
			}
	}
}

/** The document holding the discriminated JSON body. */
const discriminatorDocument = (sketch: DiscriminatorSketch): Json => {
	const shape = sketch.shape
	const schemas: Readonly<Record<string, Json>> =
		shape.kind === "listed"
			? { Cat: pet("meow"), Dog: pet("bark") }
			: {
					...(Arr.contains(shape.children, "Hound")
						? {
								Hound: {
									allOf: [
										{ $ref: "#/components/schemas/Pet" },
										{ properties: { bark: { type: "boolean" } } }
									]
								}
							}
						: {}),
					...(Arr.contains(shape.children, "Kitty")
						? {
								Kitty: {
									allOf: [
										{ $ref: "#/components/schemas/Pet" },
										{ properties: { meow: { type: "boolean" } } }
									]
								}
							}
						: {}),
					Other: { oneOf: [{ $ref: "#/components/schemas/Pet" }] },
					Pet: {
						discriminator: { propertyName: "petType" },
						properties: { petType: { type: "string" } },
						required: ["petType"],
						type: "object"
					}
				}
	const schema: Json =
		shape.kind === "listed"
			? {
					...(shape.discriminated
						? {
								discriminator: {
									propertyName: "petType",
									...(Arr.isReadonlyArrayNonEmpty(usedMapping(shape))
										? {
												mapping: Rec.fromEntries(
													Arr.map(usedMapping(shape), (key): readonly [string, Json] => [
														key,
														mappingTarget(key)[0]
													])
												)
											}
										: {})
								}
							}
						: {}),
					[shape.keyword]: Arr.map(shape.branches, branchJson)
				}
			: { $ref: "#/components/schemas/Pet" }
	return documentAt(sketch.line, {
		components: { schemas },
		paths: {
			"/a": {
				post: {
					requestBody: { content: { "application/json": { schema } }, required: true },
					responses: { "200": { description: "ok" } }
				}
			}
		}
	})
}

/** A hint as the model states it: its keyword, property and branches (component, index, labels). */
type HintModel = Readonly<{
	keyword: string
	propertyName: string
	branches: ReadonlyArray<
		readonly [component: Option.Option<string>, index: number, labels: ReadonlyArray<string>]
	>
}>

/** The check codes and the hint, as design D-OQ9 and the DSC rows state them. */
type DiscriminatorModel = Readonly<{
	codes: ReadonlyArray<string>
	hint: Option.Option<HintModel>
}>

/** The check findings and hint design D-OQ9 states for the sketch. */
export const discriminatorExpected = (sketch: DiscriminatorSketch): DiscriminatorModel => {
	const shape = sketch.shape
	if (shape.kind === "base") {
		return {
			codes: Arr.isReadonlyArrayNonEmpty(shape.children) ? [] : ["DSC-05/no-composition"],
			hint: Arr.isReadonlyArrayNonEmpty(shape.children)
				? Option.some({
						keyword: "allOf",
						propertyName: "petType",
						branches: Arr.map(
							shape.children,
							(child, index) => [Option.some(child), index, [child]] as const
						)
					})
				: Option.none()
		}
	}
	if (!shape.discriminated) {
		return { codes: [], hint: Option.none() }
	}
	if (Arr.contains(shape.branches, "unrequired")) {
		return {
			codes: [
				sketch.line === "3.2" ? "DSC-10/missing-default-mapping" : "DSC-09/property-not-required"
			],
			hint: Option.none()
		}
	}
	const used = usedMapping(shape)
	return {
		codes: [],
		hint: Option.some({
			keyword: shape.keyword,
			propertyName: "petType",
			branches: Arr.map(shape.branches, (value, index) => {
				if (value !== "Cat" && value !== "Dog") {
					return [Option.none(), index, []] as const
				}
				const labels = Arr.filter(used, (key) => mappingTarget(key)[1] === value)
				return [
					Option.some(value),
					index,
					Arr.isReadonlyArrayNonEmpty(labels) ? labels : [value]
				] as const
			})
		})
	}
}

/** Check's findings and the hint hintDiscriminators puts on the body's alternative. */
export const discriminatorActual = (sketch: DiscriminatorSketch) =>
	Effect.gen(function* () {
		const resolution = yield* resolvedAt(sketch.line, discriminatorDocument(sketch), [])
		const findings = yield* checkSpecText(resolution)
		const outcome = yield* normalizeBody(resolution, {
			openapi: openapiOf[sketch.line],
			pointer: bodyPointer
		})
		const hint =
			outcome._tag === "Implemented"
				? Option.flatMap(
						Arr.head(hintDiscriminators(resolution, outcome.body, findings).alternatives),
						(found) => Option.fromUndefinedOr(found.discriminator)
					)
				: Option.none()
		const model: DiscriminatorModel = {
			codes: Arr.map(findings, (each) => each.code),
			hint: Option.map(hint, (found) => ({
				keyword: found.keyword,
				propertyName: found.propertyName,
				branches: Arr.map(
					found.branches,
					(each) => [Option.fromUndefinedOr(each.component), each.index, each.labels] as const
				)
			}))
		}
		return model
	})

/** The features a sketch and its model reach. */
export const discriminatorFeatures = (
	sketch: DiscriminatorSketch,
	model: DiscriminatorModel
): ReadonlyArray<DiscriminatorFeature> => {
	const branches = Option.getOrElse(
		Option.map(model.hint, (hint) => hint.branches),
		() => []
	)
	const facts: ReadonlyArray<readonly [boolean, DiscriminatorFeature]> = [
		[
			Arr.some(
				branches,
				([component, , labels]) =>
					Option.isSome(component) &&
					Arr.some(labels, (label) => label === "cat" || label === "kitty" || label === "dog")
			),
			"branches labeled by mapping keys"
		],
		[
			Arr.some(branches, ([component, , labels]) =>
				Option.exists(component, (name) => Arr.contains(labels, name))
			),
			"branch labeled by its component name"
		],
		[Arr.some(branches, ([component]) => Option.isNone(component)), "inline branch unlabeled"],
		[Option.exists(model.hint, (hint) => hint.keyword === "anyOf"), "anyOf branches"],
		[
			Arr.contains(model.codes, "DSC-09/property-not-required") ||
				Arr.contains(model.codes, "DSC-10/missing-default-mapping"),
			"refused discriminator gives no hint"
		],
		[
			Option.exists(model.hint, (hint) => hint.keyword === "allOf"),
			"allOf base lists its children"
		],
		[sketch.shape.kind === "listed" && !sketch.shape.discriminated, "no discriminator"]
	]
	return Arr.map(
		Arr.filter(facts, ([holds]) => holds),
		([, feature]) => feature
	)
}

/** A multipart body over a diamond of shared allOf members, or a schema listing itself in its allOf. */
type SharedSketch =
	| Readonly<{ kind: "diamond"; depth: number; width: number }>
	| Readonly<{ kind: "loop" }>

/** Diamonds up to 64 levels and 8 wide, and the self-listing loop. */
export const sharedSpace: Gen<SharedSketch> = weighted([
	[
		4,
		(source): SharedSketch => ({
			kind: "diamond",
			depth: int(1, 64)(source),
			width: int(1, 8)(source)
		})
	],
	[1, constant<SharedSketch>({ kind: "loop" })]
])

/** The document whose multipart body's schema is the diamond's top or the loop. */
const sharedDocument = (sketch: SharedSketch): Json => {
	const schemas: Readonly<Record<string, Json>> =
		sketch.kind === "loop"
			? {
					Top: {
						allOf: [{ $ref: "#/components/schemas/Top" }],
						properties: { a: { type: "string" } }
					}
				}
			: Rec.fromEntries(
					Arr.map(
						Array.from({ length: sketch.depth + 1 }, (_unused, level) => level),
						(level): readonly [string, Json] => [
							level === 0 ? "Top" : `L${level}`,
							level === sketch.depth
								? { properties: { leaf: { type: "integer" } }, type: "object" }
								: {
										allOf: Array.from({ length: sketch.width }, () => ({
											$ref: `#/components/schemas/L${level + 1}`
										}))
									}
						]
					)
				)
	return documentAt("3.1", {
		components: { schemas },
		paths: {
			"/a": {
				post: {
					requestBody: {
						content: { "multipart/form-data": { schema: { $ref: "#/components/schemas/Top" } } }
					},
					responses: { "200": { description: "ok" } }
				}
			}
		}
	})
}

/** The one part a shared schema declares: the diamond's leaf, or the loop's own property. */
export const sharedExpected = (sketch: SharedSketch): ReadonlyArray<string> =>
	sketch.kind === "loop" ? ["a"] : ["leaf"]

/** The parts normalizeBody finds through the shared members. */
export const sharedActual = (sketch: SharedSketch) =>
	Effect.gen(function* () {
		const resolution = yield* resolvedAt("3.1", sharedDocument(sketch), [])
		const outcome = yield* normalizeBody(resolution, {
			openapi: openapiOf["3.1"],
			pointer: bodyPointer
		})
		return outcome._tag === "Implemented"
			? Arr.flatMap(outcome.body.alternatives, (found) =>
					Arr.map(found.encoding, (rule) =>
						rule.target.kind === "property" ? rule.target.name : `#${rule.target.index}`
					)
				)
			: ["refused"]
	})

/** Request bodies holding content keys that are no media type, each beside a JSON one, on one or two operations. */
type InvalidKeySketch = Readonly<{
	line: SpecLine
	keys: ReadonlyArray<ReadonlyArray<"not a type" | "also bad">>
}>

/** One or two operations, each body holding one or two keys that are no media type. */
export const invalidKeySpace: Gen<InvalidKeySketch> = (source) => ({
	line: oneOf([constant<SpecLine>("3.1"), constant<SpecLine>("3.2")])(source),
	keys: uniqueKeysOf(source)
})

const uniqueKeysOf = (
	source: Parameters<Gen<boolean>>[0]
): ReadonlyArray<ReadonlyArray<"not a type" | "also bad">> =>
	Array.from({ length: int(1, 2)(source) }, () =>
		boolean(source) ? ["not a type"] : ["not a type", "also bad"]
	)

/** The document of the sketch's operations, each body's invalid keys beside an application/json alternative. */
const invalidKeyDocument = (sketch: InvalidKeySketch): Json =>
	documentAt(sketch.line, {
		paths: Rec.fromEntries(
			Arr.map(sketch.keys, (keys, index): readonly [string, Json] => [
				`/op${index}`,
				{
					post: {
						requestBody: {
							content: Rec.fromEntries([
								["application/json", { schema: objectSchema }] as const,
								...Arr.map(keys, (key): readonly [string, Json] => [key, { schema: objectSchema }])
							])
						},
						responses: { "200": { description: "ok" } }
					}
				}
			])
		)
	})

/** How many MED-24 refusals a generation reports: one per key that is no media type. */
export const invalidKeyExpected = (sketch: InvalidKeySketch): number =>
	Arr.reduce(sketch.keys, 0, (total, keys) => total + keys.length)

/**
 * How many MED-24 refusals `generate` reports for the sketch's document, written into the case's directory: the
 * diagnostics of the generation, or of its refusal. Any other failure fails the case.
 */
export const invalidKeyActual = (
	scratch: ScratchDir,
	digest: typeof Digest.Digest.Service,
	sketch: InvalidKeySketch
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const spec = path.join(scratch, "openapi.json")
		const config = path.join(scratch, "author-config.json")
		yield* fs.writeFileString(spec, textOf(invalidKeyDocument(sketch)))
		yield* fs.writeFileString(
			config,
			textOf({ binName: "example", package: { name: "example-cli", version: "1.0.0" } })
		)
		const diagnostics = yield* generate(
			{
				document: yield* entryUri,
				outDir: path.join(scratch, "out"),
				source: { _tag: "File", path: spec },
				strict: false
			},
			{ document: yield* configUri, path: config }
		).pipe(
			Effect.provideService(Digest.Digest, digest),
			Effect.map((result) => result.diagnostics),
			Effect.catchTag("GenerateRefused", (refused) => Effect.succeed(refused.diagnostics))
		)
		return Arr.filter(diagnostics, (each) => each.code === "MED-24/invalid-media-type").length
	})
