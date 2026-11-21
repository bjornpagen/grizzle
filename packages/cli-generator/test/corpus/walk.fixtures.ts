/**
 * What the property of walk.test.ts reads: a 3.1 document drawn as a sketch of its paths, path items, operations and
 * the request elements of each, every component either inline or reached by a `$ref`, with webhooks and callbacks
 * beside them; and the outline the sketch states, each element at its use site, sorted by pointer, which design 8.3
 * gives the corpus walker to list.
 */

import type { Json } from "@bjornpagen/grizzle-text/utf8"
import {
	type Aimed,
	aimed,
	array,
	boolean,
	constant,
	element,
	type Gen,
	map,
	oneOf,
	uniqueKeys
} from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Effect, Option, Order, Record, String as Str } from "effect"
import { walk } from "#corpus/tools/walk.ts"
import type { WalkElement } from "#corpus/tools/walk.ts"
import { fixedDocumentUri } from "#model/brands.ts"
import { formatPointer } from "#model/pointer.ts"
import { resolve } from "#resolve/index.ts"

/** How a component is written where it is used: in place, or as a `$ref` to its copy under `components`. */
export type Form = "inline" | "referenced"

/** One parameter: its location and name, and how its use site writes it. */
export type ParameterSketch = Readonly<{ in: "query" | "header"; name: string; form: Form }>

/** A request body: its media types, and how its use site writes it. */
export type BodySketch = Readonly<{ media: ReadonlyArray<string>; form: Form }>

/** One response: its key, and how its use site writes it. */
export type ResponseSketch = Readonly<{ key: string; form: Form }>

/** A `security` member: absent, or its alternatives, each the names of the schemes it lists. */
export type Security = Option.Option<ReadonlyArray<ReadonlyArray<string>>>

/** A `servers` member: absent, or the URLs it lists, none among them possible. */
export type Servers = Option.Option<ReadonlyArray<string>>

export type OperationSketch = Readonly<{
	method: string
	parameters: ReadonlyArray<ParameterSketch>
	body: Option.Option<BodySketch>
	responses: ReadonlyArray<ResponseSketch>
	security: Security
	servers: Servers
	callback: boolean
}>

export type PathItemSketch = Readonly<{
	path: string
	form: Form
	parameters: ReadonlyArray<ParameterSketch>
	servers: Servers
	operations: ReadonlyArray<OperationSketch>
}>

export type DocumentSketch = Readonly<{
	paths: ReadonlyArray<PathItemSketch>
	security: Security
	servers: Servers
	webhook: boolean
}>

const entry = fixedDocumentUri("file:///spec/openapi.json")

const ok: Json = { description: "ok" }

const formGen: Gen<Form> = element(["inline", "referenced"])

/**
 * A parameter: a query or header parameter named `id`, `Id` or `q`, so a header that differs from another only in case
 * and a query name that differs only in case are both drawn. Inside a path item reached by a `$ref`, the parameter is
 * inline: the walker reads references at use sites of the entry document, which an item's own members are not.
 */
const parameterGen =
	(forms: Gen<Form>): Gen<ParameterSketch> =>
	(source) => ({
		in: source.draw(element(["query", "header"])),
		name: source.draw(element(["id", "Id", "q"])),
		form: source.draw(forms)
	})

/** A member absent or present, each half the time, so every level's absence is as common as its presence. */
const member = <A>(value: Gen<A>): Gen<Option.Option<A>> =>
	oneOf<Option.Option<A>>([constant(Option.none()), map(value, Option.some)])

const securityGen: Gen<Security> = member(
	array(uniqueKeys(element(["key", "token"]), { min: 0, max: 2 }), { min: 0, max: 2 })
)

const serversGen: Gen<Servers> = member(
	array(element(["https://a.example", "https://b.example/v1"]), { min: 0, max: 2 })
)

const operationGen =
	(method: string, forms: Gen<Form>): Gen<OperationSketch> =>
	(source) => ({
		method,
		parameters: source.draw(array(parameterGen(forms), { min: 0, max: 2 })),
		body: source.draw(
			member((inner) => ({
				media: inner.draw(
					uniqueKeys(element(["application/json", "text/plain"]), { min: 0, max: 2 })
				),
				form: inner.draw(forms)
			}))
		),
		responses: Arr.map(
			source.draw(uniqueKeys(element(["200", "204", "default"]), { min: 1, max: 2 })),
			(key) => ({ key, form: source.draw(formGen) })
		),
		security: source.draw(securityGen),
		servers: source.draw(serversGen),
		callback: source.draw(boolean)
	})

const pathItemGen =
	(path: string): Gen<PathItemSketch> =>
	(source) => {
		const form = source.draw(formGen)
		const forms: Gen<Form> = form === "inline" ? formGen : constant("inline")
		return {
			path,
			form,
			parameters: source.draw(array(parameterGen(forms), { min: 0, max: 2 })),
			servers: source.draw(serversGen),
			operations: Arr.map(
				source.draw(uniqueKeys(element(["get", "post", "delete"]), { min: 0, max: 2 })),
				(method) => source.draw(operationGen(method, forms))
			)
		}
	}

const documentGen: Gen<DocumentSketch> = (source) => ({
	paths: Arr.map(
		source.draw(uniqueKeys(element(["/users/{id}", "/a", "/x~y"]), { min: 0, max: 2 })),
		(path) => source.draw(pathItemGen(path))
	),
	security: source.draw(securityGen),
	servers: source.draw(serversGen),
	webhook: source.draw(boolean)
})

/** A situation an outline reaches. */
export type Feature =
	| "a referenced parameter"
	| "a referenced request body"
	| "a referenced response"
	| "a referenced path item"
	| "a path-level parameter an operation overrides"
	| "a header overridden in another case"
	| "a path-level parameter an operation inherits"
	| "an operation with its own security"
	| "an operation with empty security"
	| "an operation inheriting the root security"
	| "an operation with its own servers"
	| "an operation inheriting path item servers"
	| "an operation inheriting the root servers"
	| "an operation on the default server"
	| "the same name in two locations"
	| "a webhook or a callback"

/** A use site's place in the document, as the tokens its pointer is formatted from. */
type Tokens = ReadonlyArray<string>

const under = (owner: Tokens, ...tokens: ReadonlyArray<string>): Tokens => [...owner, ...tokens]

/** A character no component name may hold (OpenAPI 3.1.1 section 4.8.7.1: `^[a-zA-Z0-9\.\-_]+$`). */
const unnamable = regex("[^A-Za-z0-9._-]", "gu")

/** The name a referenced component is held under: its use site's pointer, read as a component name. */
const componentName = (use: Tokens): string => Str.replaceAll(unnamable, "_")(formatPointer(use))

/** A built document: its value, and the components its `$ref`s point at, by group and name. */
type Built = Readonly<{
	value: Json
	components: ReadonlyArray<readonly [group: string, name: string, value: Json]>
}>

const written = (group: string, use: Tokens, form: Form, value: Json): Built => {
	switch (form) {
		case "inline":
			return { value, components: [] }
		case "referenced": {
			const name = componentName(use)
			return {
				value: { $ref: `#/components/${group}/${name}` },
				components: [[group, name, value]]
			}
		}
	}
}

const all = (built: ReadonlyArray<Built>): Built => ({
	value: Arr.map(built, (each) => each.value),
	components: Arr.flatMap(built, (each) => each.components)
})

const parametersBuilt = (owner: Tokens, parameters: ReadonlyArray<ParameterSketch>): Built =>
	all(
		Arr.map(parameters, (parameter, index) =>
			written("parameters", under(owner, "parameters", String(index)), parameter.form, {
				in: parameter.in,
				name: parameter.name
			})
		)
	)

const securityValue = (alternatives: ReadonlyArray<ReadonlyArray<string>>): Json =>
	Arr.map(alternatives, (schemes) =>
		Record.fromEntries(Arr.map(schemes, (scheme) => [scheme, []] as const))
	)

const serversValue = (urls: ReadonlyArray<string>): Json => Arr.map(urls, (url) => ({ url }))

/** The members an optional member adds: none when it is absent. */
const optionally = <A>(
	key: string,
	held: Option.Option<A>,
	value: (present: A) => Json
): Record<string, Json> =>
	Option.match(held, { onNone: () => ({}), onSome: (present) => ({ [key]: value(present) }) })

const operationBuilt = (owner: Tokens, operation: OperationSketch): Built => {
	const parameters = parametersBuilt(owner, operation.parameters)
	const body = Option.map(operation.body, (sketch) =>
		written("requestBodies", under(owner, "requestBody"), sketch.form, {
			content: Record.fromEntries(Arr.map(sketch.media, (media) => [media, {}] as const))
		})
	)
	const responses = Arr.map(operation.responses, (response) => ({
		key: response.key,
		built: written("responses", under(owner, "responses", response.key), response.form, ok)
	}))
	return {
		value: {
			...(Arr.isReadonlyArrayNonEmpty(operation.parameters)
				? { parameters: parameters.value }
				: {}),
			...Option.match(body, {
				onNone: () => ({}),
				onSome: (built) => ({ requestBody: built.value })
			}),
			responses: Record.fromEntries(
				Arr.map(responses, ({ key, built }) => [key, built.value] as const)
			),
			...optionally("security", operation.security, securityValue),
			...optionally("servers", operation.servers, serversValue),
			...(operation.callback
				? { callbacks: { cb: { "{$request.body#/url}": { post: { responses: { "200": ok } } } } } }
				: {})
		},
		components: [
			...parameters.components,
			...Option.match(body, { onNone: () => [], onSome: (built) => built.components }),
			...Arr.flatMap(responses, ({ built }) => built.components)
		]
	}
}

const pathItemBuilt = (item: PathItemSketch): Built => {
	const owner: Tokens = ["paths", item.path]
	const parameters = parametersBuilt(owner, item.parameters)
	const operations = Arr.map(item.operations, (operation) => ({
		method: operation.method,
		built: operationBuilt(under(owner, operation.method), operation)
	}))
	const value: Json = {
		...(Arr.isReadonlyArrayNonEmpty(item.parameters) ? { parameters: parameters.value } : {}),
		...optionally("servers", item.servers, serversValue),
		...Record.fromEntries(
			Arr.map(operations, ({ method, built }) => [method, built.value] as const)
		)
	}
	const inner = [
		...parameters.components,
		...Arr.flatMap(operations, ({ built }) => built.components)
	]
	const placed = written("pathItems", owner, item.form, value)
	return { value: placed.value, components: [...inner, ...placed.components] }
}

/** The document a sketch draws: its paths, its root security and servers, and every component a `$ref` points at. */
const documentOf = (sketch: DocumentSketch): Json => {
	const paths = Arr.map(sketch.paths, (item) => ({ path: item.path, built: pathItemBuilt(item) }))
	const held = Arr.flatMap(paths, ({ built }) => built.components)
	const groups = Arr.dedupe(Arr.map(held, ([group]) => group))
	return {
		components: {
			securitySchemes: {
				key: { in: "header", name: "x-key", type: "apiKey" },
				token: { scheme: "bearer", type: "http" }
			},
			...Record.fromEntries(
				Arr.map(
					groups,
					(group) =>
						[
							group,
							Record.fromEntries(
								Arr.map(
									Arr.filter(held, ([holder]) => holder === group),
									([, name, value]) => [name, value] as const
								)
							)
						] as const
				)
			)
		},
		info: { title: "t", version: "1" },
		openapi: "3.1.1",
		paths: Record.fromEntries(Arr.map(paths, ({ path, built }) => [path, built.value] as const)),
		...optionally("security", sketch.security, securityValue),
		...optionally("servers", sketch.servers, serversValue),
		...(sketch.webhook ? { webhooks: { hook: { post: { responses: { "200": ok } } } } } : {})
	}
}

/** The outline the walker lists for a sketch's document. */
export const walkedOf = (sketch: DocumentSketch): Effect.Effect<ReadonlyArray<WalkElement>> =>
	resolve({ document: entry, line: "3.1", value: documentOf(sketch) }).pipe(
		Effect.flatMap((resolution) => walk(resolution)),
		Effect.orDie
	)

const at = (tokens: Tokens) => ({ document: entry, pointer: formatPointer(tokens) })

const parameterElements = (
	owner: Tokens,
	parameters: ReadonlyArray<ParameterSketch>
): ReadonlyArray<WalkElement> =>
	Arr.map(parameters, (parameter, index) => ({
		...at(under(owner, "parameters", String(index))),
		in: parameter.in,
		kind: "parameter",
		name: parameter.name
	}))

const securityElements = (owner: Tokens, security: Security): ReadonlyArray<WalkElement> =>
	Arr.map(
		Option.getOrElse(security, () => []),
		(schemes, index) => ({
			...at(under(owner, "security", String(index))),
			kind: "securityAlternative",
			schemes: Arr.sort(schemes, Order.String)
		})
	)

const serverElements = (owner: Tokens, servers: Servers): ReadonlyArray<WalkElement> =>
	Arr.map(
		Option.getOrElse(servers, () => []),
		(url, index) => ({
			...at(under(owner, "servers", String(index))),
			kind: "server",
			url
		})
	)

/** RFC 9110 section 5.1: a header's name is case-insensitive; every other location's name is compared as written. */
const sameParameter = (left: ParameterSketch, right: ParameterSketch): boolean =>
	left.in === right.in &&
	(left.in === "header"
		? Str.toLowerCase(left.name) === Str.toLowerCase(right.name)
		: left.name === right.name)

/** The pointers of the elements a level's list holds, by index under its owner. */
const pointersOf = (
	owner: Tokens,
	key: string,
	list: ReadonlyArray<unknown>
): ReadonlyArray<string> =>
	Arr.map(list, (_, index) => formatPointer(under(owner, key, String(index))))

/**
 * Design 8.3's outline of an operation: the operation, which inherits the path item's parameters it does not override
 * by name and location, the root's security alternatives when it has no `security`, and the path item's servers, or
 * the root's when the item has no `servers`, when it has none; it is on the default server when no level has
 * `servers`. Then its parameters, request media, responses, security alternatives and servers, each at its use site.
 */
const operationElements = (
	document: DocumentSketch,
	item: PathItemSketch,
	operation: OperationSketch
): ReadonlyArray<WalkElement> => {
	const itemOwner: Tokens = ["paths", item.path]
	const owner = under(itemOwner, operation.method)
	const shared = Arr.getSomes(
		Arr.map(item.parameters, (parameter, index) =>
			Arr.some(operation.parameters, (own) => sameParameter(own, parameter))
				? Option.none()
				: Option.some(formatPointer(under(itemOwner, "parameters", String(index))))
		)
	)
	const security = Option.isNone(operation.security)
		? pointersOf(
				[],
				"security",
				Option.getOrElse(document.security, () => [])
			)
		: []
	const above = Option.orElse(
		Option.map(item.servers, (servers) => pointersOf(itemOwner, "servers", servers)),
		() => Option.map(document.servers, (servers) => pointersOf([], "servers", servers))
	)
	const servers = Option.isNone(operation.servers) ? Option.getOrElse(above, () => []) : []
	return [
		{
			...at(owner),
			defaultServer: Option.isNone(above) && Option.isNone(operation.servers),
			inherits: Arr.sort([...shared, ...security, ...servers], Order.String),
			kind: "operation",
			method: operation.method,
			path: item.path
		},
		...parameterElements(owner, operation.parameters),
		...Arr.map(
			Option.match(operation.body, { onNone: () => [], onSome: (body) => body.media }),
			(media): WalkElement => ({
				...at(under(owner, "requestBody", "content", media)),
				kind: "requestMedia",
				mediaType: media
			})
		),
		...Arr.map(operation.responses, (response): WalkElement => ({
			...at(under(owner, "responses", response.key)),
			key: response.key,
			kind: "response"
		})),
		...securityElements(owner, operation.security),
		...serverElements(owner, operation.servers)
	]
}

/** The outline design 8.3 gives a sketch's document: every request element at its use site, sorted by pointer. */
export const expectedOf = (sketch: DocumentSketch): ReadonlyArray<WalkElement> =>
	Arr.sort(
		[
			...Arr.flatMap(sketch.paths, (item) => [
				...parameterElements(["paths", item.path], item.parameters),
				...Arr.flatMap(item.operations, (operation) => operationElements(sketch, item, operation)),
				...serverElements(["paths", item.path], item.servers)
			]),
			...securityElements([], sketch.security),
			...serverElements([], sketch.servers)
		],
		Order.mapInput(Order.String, (listed: WalkElement) => listed.pointer)
	)

const operationsOf = (
	sketch: DocumentSketch
): ReadonlyArray<readonly [PathItemSketch, OperationSketch]> =>
	Arr.flatMap(sketch.paths, (item) =>
		Arr.map(item.operations, (operation) => [item, operation] as const)
	)

export const featuresOf = (sketch: DocumentSketch): ReadonlyArray<Feature> => {
	const when = (holds: boolean, feature: Feature): ReadonlyArray<Feature> =>
		holds ? [feature] : []
	const operations = operationsOf(sketch)
	const parameters = Arr.flatMap(sketch.paths, (item) => [
		...item.parameters,
		...Arr.flatMap(item.operations, (operation) => operation.parameters)
	])
	const overrides = Arr.flatMap(operations, ([item, operation]) =>
		Arr.flatMap(item.parameters, (shared) =>
			Arr.map(
				Arr.filter(operation.parameters, (own) => sameParameter(own, shared)),
				(own) => [shared, own] as const
			)
		)
	)
	return [
		...when(
			Arr.some(parameters, (parameter) => parameter.form === "referenced"),
			"a referenced parameter"
		),
		...when(
			Arr.some(operations, ([, operation]) =>
				Option.exists(operation.body, (body) => body.form === "referenced")
			),
			"a referenced request body"
		),
		...when(
			Arr.some(operations, ([, operation]) =>
				Arr.some(operation.responses, (response) => response.form === "referenced")
			),
			"a referenced response"
		),
		...when(
			Arr.some(sketch.paths, (item) => item.form === "referenced"),
			"a referenced path item"
		),
		...when(
			Arr.isReadonlyArrayNonEmpty(overrides),
			"a path-level parameter an operation overrides"
		),
		...when(
			Arr.some(overrides, ([shared, own]) => shared.name !== own.name),
			"a header overridden in another case"
		),
		...when(
			Arr.some(operations, ([item, operation]) =>
				Arr.some(
					item.parameters,
					(shared) => !Arr.some(operation.parameters, (own) => sameParameter(own, shared))
				)
			),
			"a path-level parameter an operation inherits"
		),
		...when(
			Arr.some(operations, ([, operation]) =>
				Option.exists(operation.security, Arr.isReadonlyArrayNonEmpty)
			),
			"an operation with its own security"
		),
		...when(
			Arr.some(operations, ([, operation]) =>
				Option.exists(operation.security, Arr.isReadonlyArrayEmpty)
			),
			"an operation with empty security"
		),
		...when(
			Option.exists(sketch.security, Arr.isReadonlyArrayNonEmpty) &&
				Arr.some(operations, ([, operation]) => Option.isNone(operation.security)),
			"an operation inheriting the root security"
		),
		...when(
			Arr.some(operations, ([, operation]) => Option.isSome(operation.servers)),
			"an operation with its own servers"
		),
		...when(
			Arr.some(
				operations,
				([item, operation]) => Option.isSome(item.servers) && Option.isNone(operation.servers)
			),
			"an operation inheriting path item servers"
		),
		...when(
			Option.isSome(sketch.servers) &&
				Arr.some(
					operations,
					([item, operation]) => Option.isNone(item.servers) && Option.isNone(operation.servers)
				),
			"an operation inheriting the root servers"
		),
		...when(
			Option.isNone(sketch.servers) &&
				Arr.some(
					operations,
					([item, operation]) => Option.isNone(item.servers) && Option.isNone(operation.servers)
				),
			"an operation on the default server"
		),
		...when(
			Arr.some(sketch.paths, (item) =>
				Arr.some(item.operations, (operation) =>
					Arr.some(operation.parameters, (left) =>
						Arr.some(
							operation.parameters,
							(right) => left.name === right.name && left.in !== right.in
						)
					)
				)
			),
			"the same name in two locations"
		),
		...when(
			sketch.webhook || Arr.some(operations, ([, operation]) => operation.callback),
			"a webhook or a callback"
		)
	]
}

/** A document holding one path item, inline with no servers, the rest of it drawn. */
const holdingItem =
	(item: Gen<PathItemSketch>): Gen<DocumentSketch> =>
	(source) => ({ ...source.draw(documentGen), paths: [source.draw(item)] })

const inlineOperation = (parameters: ReadonlyArray<ParameterSketch>): Gen<OperationSketch> =>
	map(operationGen("get", constant("inline")), (operation) => ({ ...operation, parameters }))

/**
 * Documents, aimed at the two parameter situations a drawn document reaches rarely: a path item's header overridden by
 * an operation's header named in another case, and an operation's two parameters of one name in two locations.
 */
export const documentSpace: Aimed<DocumentSketch, Feature> = aimed(documentGen, [
	[
		"a header overridden in another case",
		holdingItem((source) => ({
			path: "/a",
			form: "inline",
			parameters: [{ in: "header", name: "id", form: "inline" }],
			servers: Option.none(),
			operations: [source.draw(inlineOperation([{ in: "header", name: "Id", form: "inline" }]))]
		}))
	],
	[
		"the same name in two locations",
		holdingItem((source) => ({
			path: "/a",
			form: "inline",
			parameters: [],
			servers: Option.none(),
			operations: [
				source.draw(
					inlineOperation([
						{ in: "query", name: "id", form: "inline" },
						{ in: "header", name: "id", form: "inline" }
					])
				)
			]
		}))
	]
])
