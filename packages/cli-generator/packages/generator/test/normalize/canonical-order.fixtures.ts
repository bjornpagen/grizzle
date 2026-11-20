/** What the property of canonical-order.test.ts reads: generated documents, their member-reversed twins, and packages. */

import {
	aimed,
	boolean,
	constant,
	type Gen,
	oneOf,
	uniqueArray,
	uniqueKeys
} from "@bjornpagen/testing/gen"
import type { ScratchDir } from "@bjornpagen/testing/resources"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Order,
	Path,
	Record as Rec,
	Schema,
	String as Str
} from "effect"
import { Digest } from "effect/crypto"
import { generate } from "#generate.ts"
import { DocumentUri } from "#model/brands.ts"
import { isObject } from "#model/json-tree.ts"
import type { Json } from "#model/pointer.ts"
import {
	type ComponentSketch,
	type ConfigSketch,
	configGen,
	configOf,
	type DocumentSketch,
	documentGen,
	documentOf,
	type OperationSketch,
	type PropertySketch,
	textOf
} from "#test/support/openapi-gen.ts"

/** A drawn document and an author config that fits it. */
type CanonicalSketch = Readonly<{ document: DocumentSketch; config: ConfigSketch }>

/** What a case reaches. */
export type CanonicalFeature =
	| "several paths"
	| "several components"
	| "JSON body or response"
	| "a document generated with no diagnostic"

/** A document of any line and an author config drawn for it. */
const drawnSpace: Gen<CanonicalSketch> = (source) => {
	const document = source.draw(documentGen)
	return { document, config: source.draw(configGen(document)) }
}

/** A plain property of a component: a string or an integer under a name drawn from names that fold apart. */
const plainProperty =
	(name: string): Gen<PropertySketch> =>
	(source) => ({
		name,
		schema: boolean(source)
			? { kind: "string", format: Option.none(), values: [] }
			: { kind: "integer", format: Option.none() },
		required: boolean(source),
		readOnly: false,
		deprecated: false,
		description: Option.none(),
		defaultValue: Option.none()
	})

/** A plain GET operation at its own path answering with a component as JSON. */
const plainOperation = (segment: string, component: string): OperationSketch => ({
	method: "get",
	segments: [segment],
	operationId: Option.none(),
	tags: [],
	summary: Option.none(),
	description: Option.none(),
	deprecated: false,
	parameters: [],
	querystring: Option.none(),
	body: Option.none(),
	responses: [
		{
			status: "200",
			description: "OK",
			content: [{ kind: "json", schema: { kind: "ref", component } }],
			headers: []
		}
	],
	security: Option.none(),
	aliases: []
})

/**
 * A plain document the generator reads with no diagnostic at all: components of plain properties, each served as JSON by
 * a GET of its own, no servers, tags, schemes or webhooks, under an author config that names only the package.
 */
const plainSpace: Gen<CanonicalSketch> = (source) => {
	const names = source.draw(
		uniqueKeys(oneOf([constant("Zone"), constant("Account"), constant("Record")]), {
			min: 1,
			max: 3
		})
	)
	const components = Arr.map(names, (name): ComponentSketch => ({
		name,
		properties: source.draw(
			uniqueArray(
				oneOf([constant("name"), constant("id"), constant("status"), constant("count")]),
				plainProperty,
				{ min: 1, max: 3 }
			)
		)
	}))
	return {
		document: {
			line: source.draw(
				oneOf([
					constant<DocumentSketch["line"]>("3.0"),
					constant<DocumentSketch["line"]>("3.1"),
					constant<DocumentSketch["line"]>("3.2")
				])
			),
			title: "Canon",
			description: Option.none(),
			servers: [],
			tags: [],
			components,
			schemes: [],
			security: Option.none(),
			operations: Arr.map(names, (name) => plainOperation(Str.toLowerCase(name), name)),
			webhooks: []
		},
		config: {
			binName: "canon",
			envPrefix: Option.none(),
			accepted: [],
			brackets: Option.none(),
			scalars: Option.none(),
			environments: [],
			skipped: [],
			added: Option.none()
		}
	}
}

/** Generated documents, aimed at a plain one the generator reads with no diagnostic while none has run. */
export const canonicalSpace = aimed<CanonicalSketch, CanonicalFeature>(drawnSpace, [
	["a document generated with no diagnostic", plainSpace]
])

/** An object's members reversed, or the value itself when it is no object. */
const reversed = (value: Json): Json =>
	isObject(value) ? Rec.fromEntries(Arr.reverse(Rec.toEntries(value))) : value

/** Each member of an object changed by `change`, or the value itself. */
const eachMember = (value: Json, change: (member: Json) => Json): Json =>
	isObject(value) ? Rec.map(value, change) : value

/** The member `name` of an object changed by `change`, or the value itself. */
const atMember = (value: Json, name: string, change: (member: Json) => Json): Json =>
	isObject(value)
		? Rec.map(value, (member, key) => (key === name ? change(member) : member))
		: value

/** A JSON schema with its `properties` reversed, and every schema in them. */
const reverseSchema = (schema: Json): Json =>
	atMember(schema, "properties", (properties) => reversed(eachMember(properties, reverseSchema)))

/** A request body's or response's JSON media schema reversed; every other media type, whose order is semantic, kept. */
const reverseJsonMedia = (holder: Json): Json =>
	atMember(holder, "content", (content) =>
		atMember(content, "application/json", (media) => atMember(media, "schema", reverseSchema))
	)

/** An operation's JSON bodies and responses reversed. */
const reverseOperation = (operation: Json): Json =>
	atMember(atMember(operation, "requestBody", reverseJsonMedia), "responses", (responses) =>
		eachMember(responses, reverseJsonMedia)
	)

/** A path item with its members reversed and each operation's JSON media reversed; its parameters, an ordered list, kept. */
const reverseItem = (item: Json): Json =>
	reversed(
		isObject(item)
			? Rec.map(item, (member, key) => (key === "parameters" ? member : reverseOperation(member)))
			: item
	)

/**
 * The twin of a document whose non-semantic member orders (design 3.7: `paths`, each path item, `components.schemas`
 * and a JSON media schema's `properties`) are reversed; `content`, `encoding`, a form or multipart body's properties and
 * every list keep their order.
 */
export const twinOf = (document: Json): Json =>
	atMember(
		atMember(document, "paths", (paths) => reversed(eachMember(paths, reverseItem))),
		"components",
		(components) => atMember(components, "schemas", reversed)
	)

/** A generated file: its path in the package and its text. */
type Written = readonly [relative: string, text: string]

/**
 * The package `generate` writes for `document` under the sketch's author config, in a directory of `scratch`: every
 * file but `generation-report.json` (which records each input's digest), sorted by path, with its text.
 */
export const packageOf = (
	scratch: ScratchDir,
	digest: typeof Digest.Digest.Service,
	name: string,
	document: Json,
	config: ConfigSketch
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const directory = path.join(scratch, name)
		yield* fs.makeDirectory(directory, { recursive: true })
		const specPath = path.join(directory, "openapi.json")
		const configPath = path.join(directory, "author-config.json")
		const out = path.join(directory, "out")
		yield* fs.writeFileString(specPath, textOf(document))
		yield* fs.writeFileString(configPath, textOf(configOf(config)))
		const specDocument = yield* Schema.decodeEffect(DocumentUri)("file:///canon/openapi.json")
		const configDocument = yield* Schema.decodeEffect(DocumentUri)(
			"file:///canon/author-config.json"
		)
		const result = yield* generate(
			{
				document: specDocument,
				outDir: out,
				source: { _tag: "File", path: specPath },
				strict: false
			},
			{ document: configDocument, path: configPath }
		).pipe(Effect.provideService(Digest.Digest, digest))
		const kept = Arr.sort(
			Arr.filter(result.files, (file) => file !== "generation-report.json"),
			Order.String
		)
		const files = yield* Effect.forEach(kept, (relative) =>
			Effect.map(fs.readFileString(path.join(out, relative)), (text): Written => [relative, text])
		)
		return { files, diagnostics: Arr.map(result.diagnostics, (each) => each.code) }
	})

/** The rendered document of a sketch. */
export const renderedOf = (sketch: CanonicalSketch): Json => documentOf(sketch.document)

/** The features a sketch reaches. */
export const canonicalFeatures = (sketch: CanonicalSketch): ReadonlyArray<CanonicalFeature> => {
	const facts: ReadonlyArray<readonly [boolean, CanonicalFeature]> = [
		[sketch.document.operations.length > 1, "several paths"],
		[sketch.document.components.length > 1, "several components"],
		[
			Option.isSome(
				Arr.findFirst(
					sketch.document.operations,
					(operation) =>
						Option.isSome(operation.body) || Arr.isReadonlyArrayNonEmpty(operation.responses)
				)
			),
			"JSON body or response"
		]
	]
	return Arr.map(
		Arr.filter(facts, ([holds]) => holds),
		([, feature]) => feature
	)
}
