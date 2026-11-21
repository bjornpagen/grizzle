/** What the property of informational.test.ts reads: its document sketches and the records design 2.4 states for them. */

import type { Json } from "@bjornpagen/grizzle-text/utf8"
import {
	aimed,
	array,
	boolean,
	constant,
	type Gen,
	oneOf,
	option,
	subarray
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Exit, Option, Order, Record as Rec } from "effect"
import { evaluatePointer } from "#model/pointer.ts"
import type { SpecLine } from "#model/spec-section.ts"
import { collectInformational } from "#normalize/informational.ts"
import { documentAt, lineGen, resolvedAt } from "#test/support/normalizing.ts"

/** A record as the design states one: its row and the use-site pointer it accounts for. */
type Accounted = readonly [row: string, pointer: string]

/** How many entries an informational map holds: none (one record at the map) or some (one record each). */
type MapSize = 0 | 1 | 2

/** One operation of the path item, and what it holds. */
type OperationSketch = Readonly<{
	method: "get" | "put" | "post" | "delete" | "patch"
	extension: boolean
	externalDocs: boolean
	callbacks: Option.Option<MapSize>
	parameterExamples: Option.Option<MapSize>
	mediaExamples: Option.Option<MapSize>
	links: Option.Option<MapSize>
	linkByReference: boolean
	headerExamples: Option.Option<MapSize>
}>

/** A document's informational elements, each drawn present or not, with names that only look like extensions. */
type InformationalSketch = Readonly<{
	line: SpecLine
	contact: boolean
	license: boolean
	infoExtension: boolean
	rootExtensions: ReadonlyArray<string>
	externalDocs: boolean
	tags: ReadonlyArray<Readonly<{ externalDocs: boolean; extension: boolean }>>
	server: Option.Option<Readonly<{ extension: boolean; variableExtension: boolean }>>
	webhooks: Option.Option<MapSize>
	pathsExtension: boolean
	itemExtension: boolean
	operations: ReadonlyArray<OperationSketch>
	components: Readonly<{
		callbacks: Option.Option<MapSize>
		examples: Option.Option<MapSize>
		links: Option.Option<MapSize>
	}>
	namesLikeExtensions: boolean
}>

/** What a case reaches. */
export type InformationalFeature =
	| "info parts"
	| "root extensions"
	| "reserved extension prefix"
	| "tag with external docs"
	| "server extension"
	| "webhooks"
	| "empty webhooks map"
	| "operation callback"
	| "empty informative map"
	| "parameter examples"
	| "media type examples"
	| "response links"
	| "link by reference"
	| "header examples"
	| "component callbacks, examples and links"
	| "post operation"
	| "put operation"
	| "name that looks like an extension"
	| "nothing but info"

const mapSize: Gen<MapSize> = oneOf([
	constant<MapSize>(0),
	constant<MapSize>(1),
	constant<MapSize>(2)
])

const methods: ReadonlyArray<OperationSketch["method"]> = ["get", "put", "post", "delete", "patch"]

const operation =
	(method: OperationSketch["method"]): Gen<OperationSketch> =>
	(source) => ({
		method,
		extension: boolean(source),
		externalDocs: boolean(source),
		callbacks: option(mapSize)(source),
		parameterExamples: option(mapSize)(source),
		mediaExamples: option(mapSize)(source),
		links: option(mapSize)(source),
		linkByReference: boolean(source),
		headerExamples: option(mapSize)(source)
	})

/** A document whose every informational element is drawn present or absent; webhooks from 3.1 on. */
const drawnDocument: Gen<InformationalSketch> = (source) => {
	const line = lineGen(source)
	return {
		line,
		contact: boolean(source),
		license: boolean(source),
		infoExtension: boolean(source),
		rootExtensions: subarray(["x-root", "x-oai-a", "x-oas-b"])(source),
		externalDocs: boolean(source),
		tags: array((inner) => ({ externalDocs: boolean(inner), extension: boolean(inner) }), {
			min: 0,
			max: 2
		})(source),
		server: option((inner) => ({ extension: boolean(inner), variableExtension: boolean(inner) }))(
			source
		),
		webhooks: line === "3.0" ? Option.none() : option(mapSize)(source),
		pathsExtension: boolean(source),
		itemExtension: boolean(source),
		operations: Arr.map(subarray(methods)(source), (method) => operation(method)(source)),
		components: {
			callbacks: option(mapSize)(source),
			examples: option(mapSize)(source),
			links: option(mapSize)(source)
		},
		namesLikeExtensions: boolean(source)
	}
}

/** A document holding no informational element but its info, of a drawn line. */
const bareDocument: Gen<InformationalSketch> = (source) => ({
	line: lineGen(source),
	contact: false,
	license: false,
	infoExtension: false,
	rootExtensions: [],
	externalDocs: false,
	tags: [],
	server: Option.none(),
	webhooks: Option.none(),
	pathsExtension: false,
	itemExtension: false,
	operations: [],
	components: { callbacks: Option.none(), examples: Option.none(), links: Option.none() },
	namesLikeExtensions: false
})

/** Documents with their informational elements drawn, aimed at a bare one while none has run. */
export const informationalSpace = aimed<InformationalSketch, InformationalFeature>(drawnDocument, [
	["nothing but info", bareDocument]
])

/** The names a map of `size` entries holds. */
const names = (prefix: string, size: MapSize): ReadonlyArray<string> =>
	Arr.take([`${prefix}0`, `${prefix}1`], size)

/** A map of `size` entries, each `entry`. */
const mapOf = (prefix: string, size: MapSize, entry: Json): Json =>
	Rec.fromEntries(Arr.map(names(prefix, size), (name): readonly [string, Json] => [name, entry]))

/** The records an informative map accounts for at `pointer`: one each, or one at the map when it is empty. */
const recordsOfMap = (
	row: string,
	pointer: string,
	prefix: string,
	size: MapSize
): ReadonlyArray<Accounted> =>
	size === 0
		? [[row, pointer]]
		: Arr.map(names(prefix, size), (name): Accounted => [row, `${pointer}/${name}`])

/** What a drawn optional map writes under `key`, and the records it accounts for. */
const optionalMap = (
	key: string,
	row: string,
	pointer: string,
	prefix: string,
	size: Option.Option<MapSize>,
	entry: Json
): readonly [Readonly<Record<string, Json>>, ReadonlyArray<Accounted>] =>
	Option.match(size, {
		onNone: () => [{}, []] as const,
		onSome: (count) =>
			[
				{ [key]: mapOf(prefix, count, entry) },
				recordsOfMap(row, `${pointer}/${key}`, prefix, count)
			] as const
	})

/** An extension member and its record, when drawn. */
const extension = (
	present: boolean,
	name: string,
	pointer: string
): readonly [Readonly<Record<string, Json>>, ReadonlyArray<Accounted>] =>
	present ? [{ [name]: 1 }, [["EXT-01", `${pointer}/${name}`]]] : [{}, []]

/** An external documentation member and its record, when drawn. */
const externalDocsAt = (
	present: boolean,
	pointer: string
): readonly [Readonly<Record<string, Json>>, ReadonlyArray<Accounted>] =>
	present
		? [
				{ externalDocs: { url: "https://example.com/docs" } },
				[["EXD-01", `${pointer}/externalDocs`]]
			]
		: [{}, []]

/** One operation's object, and its records in the walk's order: extensions, external docs, callbacks, parameters, body, responses. */
const operationOf = (sketch: OperationSketch): readonly [Json, ReadonlyArray<Accounted>] => {
	const at = `/paths/~1a/${sketch.method}`
	const [ext, extRecords] = extension(sketch.extension, "x-op", at)
	const [docs, docsRecords] = externalDocsAt(sketch.externalDocs, at)
	const [callbacks, callbackRecords] = optionalMap(
		"callbacks",
		"CBK-01",
		at,
		"cb",
		sketch.callbacks,
		{
			"{$request.body#/url}": { post: {} }
		}
	)
	const [examples, exampleRecords] = optionalMap(
		"examples",
		"EXM-01",
		`${at}/parameters/0`,
		"p",
		sketch.parameterExamples,
		{ value: 1 }
	)
	const [mediaExamples, mediaRecords] = optionalMap(
		"examples",
		"EXM-01",
		`${at}/requestBody/content/application~1json`,
		"m",
		sketch.mediaExamples,
		{ value: {} }
	)
	const [headerExamples, headerRecords] = optionalMap(
		"examples",
		"EXM-01",
		`${at}/responses/200/headers/X-Rate`,
		"h",
		sketch.headerExamples,
		{ value: 1 }
	)
	const [links, linkRecords] = optionalMap(
		"links",
		"LNK-01",
		`${at}/responses/200`,
		"l",
		sketch.links,
		{
			operationId: "x"
		}
	)
	const referenced: readonly [Readonly<Record<string, Json>>, ReadonlyArray<Accounted>] =
		sketch.linkByReference
			? [
					{ links: { shared: { $ref: "#/components/links/shared" } } },
					[["LNK-01", `${at}/responses/404/links/shared`]]
				]
			: [{}, []]
	const value: Json = {
		...ext,
		...docs,
		...callbacks,
		parameters: [{ in: "query", name: "q", schema: { type: "string" }, ...examples }],
		requestBody: {
			content: {
				"application/json": { schema: { type: "object", example: { "x-c": 3 } }, ...mediaExamples }
			}
		},
		responses: {
			"200": {
				description: "ok",
				headers: { "X-Rate": { schema: { type: "integer" }, ...headerExamples } },
				...links
			},
			"404": { description: "missing", ...referenced[0] }
		}
	}
	return [
		value,
		[
			...extRecords,
			...docsRecords,
			...callbackRecords,
			...exampleRecords,
			...mediaRecords,
			...headerRecords,
			...linkRecords,
			...referenced[1]
		]
	]
}

/** The order the walk reads a path item's methods in: alphabetical, over every method 3.2 names. */
const methodOrder: Order.Order<OperationSketch> = Order.mapInput(
	Order.String,
	(each: OperationSketch) => each.method
)

/** The document a sketch describes, and the records design 2.4 states for it in the walk's order. */
export const documentOf = (
	sketch: InformationalSketch
): readonly [Json, ReadonlyArray<Accounted>] => {
	const [infoExt, infoExtRecords] = extension(sketch.infoExtension, "x-info", "/info")
	const info: Json = {
		title: "t",
		version: "1",
		...infoExt,
		...(sketch.contact ? { contact: { name: "n" } } : {}),
		...(sketch.license ? { license: { name: "MIT" } } : {})
	}
	const infoRecords: ReadonlyArray<Accounted> = [
		["INF-01", "/info"],
		...infoExtRecords,
		...(sketch.contact ? [["INF-09", "/info/contact"] as const] : []),
		...(sketch.license ? [["INF-13", "/info/license"] as const] : [])
	]
	const rootExt = Rec.fromEntries(
		Arr.map(sketch.rootExtensions, (name): readonly [string, Json] => [name, 1])
	)
	const rootExtRecords = Arr.map(sketch.rootExtensions, (name): Accounted => [
		name === "x-root" ? "EXT-01" : "EXT-02",
		`/${name}`
	])
	const [docs, docsRecords] = externalDocsAt(sketch.externalDocs, "")
	const tags = Arr.map(sketch.tags, (tag, index) => {
		const at = `/tags/${index}`
		const [ext, extRecords] = extension(tag.extension, "x-tag", at)
		const [tagDocs, tagDocsRecords] = externalDocsAt(tag.externalDocs, at)
		return [
			{ name: `tag${index}`, ...ext, ...tagDocs },
			[["TAG-01", at] as const, ...extRecords, ...tagDocsRecords]
		] as const
	})
	const server = Option.map(sketch.server, (drawn) => {
		const [ext, extRecords] = extension(drawn.extension, "x-s", "/servers/0")
		const [varExt, varRecords] = extension(drawn.variableExtension, "x-v", "/servers/0/variables/v")
		return [
			{ url: "https://example.com/{v}", variables: { v: { default: "1", ...varExt } }, ...ext },
			[...extRecords, ...varRecords]
		] as const
	})
	const webhooks = Option.map(
		sketch.webhooks,
		(size) =>
			[
				mapOf("hook", size, { post: {} }),
				recordsOfMap("DOC-08", "/webhooks", "hook", size)
			] as const
	)
	const sorted = Arr.sort(sketch.operations, methodOrder)
	const operations = Arr.map(sorted, (each) => [each.method, operationOf(each)] as const)
	const [itemExt, itemExtRecords] = extension(sketch.itemExtension, "x-item", "/paths/~1a")
	const [pathsExt, pathsExtRecords] = extension(sketch.pathsExtension, "x-paths", "/paths")
	const [componentCallbacks, componentCallbackRecords] = optionalMap(
		"callbacks",
		"CBK-01",
		"/components",
		"c",
		sketch.components.callbacks,
		{}
	)
	const [componentExamples, componentExampleRecords] = optionalMap(
		"examples",
		"EXM-01",
		"/components",
		"e",
		sketch.components.examples,
		{ value: 1 }
	)
	const sharedLink = Arr.some(sketch.operations, (each) => each.linkByReference)
	const linkNames = [
		...Option.match(sketch.components.links, {
			onNone: () => [],
			onSome: (size) => names("k", size)
		}),
		...(sharedLink ? ["shared"] : [])
	]
	const hasLinks = Option.isSome(sketch.components.links) || sharedLink
	const links = Rec.fromEntries(
		Arr.map(linkNames, (name): readonly [string, Json] => [
			name,
			name === "shared" ? { operationId: "x", "x-note": 1 } : { operationId: "x" }
		])
	)
	const componentLinkAll: ReadonlyArray<Accounted> = hasLinks
		? Arr.isReadonlyArrayNonEmpty(linkNames)
			? Arr.map(linkNames, (name): Accounted => ["LNK-01", `/components/links/${name}`])
			: [["LNK-01", "/components/links"]]
		: []
	const lookalikes: Json = sketch.namesLikeExtensions
		? { schemas: { "x-name": { properties: { "x-prop": {} } } } }
		: {}
	const document = documentAt(sketch.line, {
		info,
		...rootExt,
		...docs,
		...(Arr.isReadonlyArrayNonEmpty(tags) ? { tags: Arr.map(tags, ([tag]) => tag) } : {}),
		...Option.match(server, { onNone: () => ({}), onSome: ([value]) => ({ servers: [value] }) }),
		...Option.match(webhooks, { onNone: () => ({}), onSome: ([value]) => ({ webhooks: value }) }),
		paths: {
			"/a": {
				...itemExt,
				...Rec.fromEntries(
					Arr.map(operations, ([method, [value]]): readonly [string, Json] => [method, value])
				)
			},
			...pathsExt
		},
		components: {
			...componentCallbacks,
			...componentExamples,
			...(hasLinks ? { links } : {}),
			...lookalikes
		}
	})
	return [
		document,
		[
			...infoRecords,
			...rootExtRecords,
			...docsRecords,
			...Arr.flatMap(tags, ([, records]) => records),
			...Option.match(server, { onNone: () => [], onSome: ([, records]) => records }),
			...Option.match(webhooks, { onNone: () => [], onSome: ([, records]) => records }),
			...itemExtRecords,
			...Arr.flatMap(operations, ([, [, records]]) => records),
			...pathsExtRecords,
			...componentCallbackRecords,
			...componentExampleRecords,
			...componentLinkAll
		]
	]
}

/** The records a document's walk makes, and those of them that point at no node of it. */
type Collected = Readonly<{ records: ReadonlyArray<Accounted>; dangling: ReadonlyArray<string> }>

/** The records collectInformational makes of the sketch's document, and whether each points at a node of it. */
export const actualOf = (sketch: InformationalSketch) =>
	Effect.gen(function* () {
		const [document] = documentOf(sketch)
		const resolution = yield* resolvedAt(sketch.line, document, [])
		const collected = yield* collectInformational(resolution)
		const records = Arr.map(collected, (record): Accounted => [
			record.row,
			String(record.origin.pointer)
		])
		const evaluated = yield* Effect.forEach(records, ([, pointer]) =>
			Effect.map(
				Effect.exit(evaluatePointer(document, pointer)),
				(exit) => [pointer, Exit.isFailure(exit)] as const
			)
		)
		const dangling = Arr.map(
			Arr.filter(evaluated, ([, failed]) => failed),
			([pointer]) => pointer
		)
		const found: Collected = { records, dangling }
		return found
	})

/** The features a sketch reaches. */
export const informationalFeatures = (
	sketch: InformationalSketch
): ReadonlyArray<InformationalFeature> => {
	const anyOperation = (has: (each: OperationSketch) => boolean) => Arr.some(sketch.operations, has)
	const sized = (size: Option.Option<MapSize>) => Option.isSome(size)
	const empty = (size: Option.Option<MapSize>) => Option.exists(size, (count) => count === 0)
	const maps = [
		sketch.components.callbacks,
		sketch.components.examples,
		sketch.components.links,
		...Arr.flatMap(sketch.operations, (each) => [
			each.callbacks,
			each.parameterExamples,
			each.mediaExamples,
			each.links,
			each.headerExamples
		])
	]
	const facts: ReadonlyArray<readonly [boolean, InformationalFeature]> = [
		[sketch.contact && sketch.license, "info parts"],
		[Arr.contains(sketch.rootExtensions, "x-root"), "root extensions"],
		[Arr.some(sketch.rootExtensions, (name) => name !== "x-root"), "reserved extension prefix"],
		[Arr.some(sketch.tags, (tag) => tag.externalDocs), "tag with external docs"],
		[
			Option.exists(sketch.server, (server) => server.extension && server.variableExtension),
			"server extension"
		],
		[Option.exists(sketch.webhooks, (size) => size > 0), "webhooks"],
		[empty(sketch.webhooks), "empty webhooks map"],
		[
			anyOperation((each) => Option.exists(each.callbacks, (size) => size > 0)),
			"operation callback"
		],
		[Arr.some(maps, empty), "empty informative map"],
		[
			anyOperation((each) => Option.exists(each.parameterExamples, (size) => size > 0)),
			"parameter examples"
		],
		[
			anyOperation((each) => Option.exists(each.mediaExamples, (size) => size > 0)),
			"media type examples"
		],
		[anyOperation((each) => Option.exists(each.links, (size) => size > 0)), "response links"],
		[anyOperation((each) => each.linkByReference), "link by reference"],
		[
			anyOperation((each) => Option.exists(each.headerExamples, (size) => size > 0)),
			"header examples"
		],
		[
			sized(sketch.components.callbacks) &&
				sized(sketch.components.examples) &&
				sized(sketch.components.links),
			"component callbacks, examples and links"
		],
		[anyOperation((each) => each.method === "post"), "post operation"],
		[anyOperation((each) => each.method === "put"), "put operation"],
		[sketch.namesLikeExtensions, "name that looks like an extension"],
		[Arr.length(documentOf(sketch)[1]) === 1, "nothing but info"]
	]
	return Arr.map(
		Arr.filter(facts, ([holds]) => holds),
		([, feature]) => feature
	)
}
