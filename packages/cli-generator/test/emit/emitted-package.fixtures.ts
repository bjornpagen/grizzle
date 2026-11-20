import { type Gen, map, type Steered, steered } from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	FileSystem,
	Formatter,
	JsonPointer,
	Option,
	Path,
	Record,
	String as Str
} from "effect"
import { format } from "oxfmt"
import type { FormatConfig } from "oxfmt"
import { runtimeSources } from "#emit/runtime.ts"
import { typecheckPackage } from "#test/support/cli-package.ts"
import { BINDING_TAGS, configGen, documentGen } from "#test/support/openapi-gen.ts"
import type {
	ConfigSketch,
	AlternativeSketch,
	DocumentSketch,
	Line,
	Location,
	OperationSketch,
	ParameterSketch,
	PropertySketch,
	Requirement,
	ResponseSketch,
	SchemaSketch,
	SchemeSketch
} from "#test/support/openapi-gen.ts"

/** The formatter's options for generated files, as docs/printer.md names them. */
const FORMAT_OPTIONS: FormatConfig = {
	jsdoc: { commentLineStrategy: "multiline", lineWrappingStyle: "balance" }
}

/** A generated document and an author config that fits it. */
export type PackageCase = Readonly<{ document: DocumentSketch; config: ConfigSketch }>

const caseGen: Gen<PackageCase> = (s) => {
	const sketch = s.draw(documentGen)
	return { document: sketch, config: s.draw(configGen(sketch)) }
}

/** A GET no emitter refuses, with no parameter, no body and one empty answer, at a path no drawn operation takes. */
const COMMANDED: OperationSketch = {
	method: "get",
	segments: ["commanded"],
	operationId: Option.none(),
	tags: [],
	summary: Option.none(),
	description: Option.none(),
	deprecated: false,
	parameters: [],
	querystring: Option.none(),
	body: Option.none(),
	responses: [{ status: "204", description: "Done", content: [], headers: [] }],
	security: Option.none(),
	aliases: []
}

/**
 * An operation that requires `scheme` alone: COMMANDED's GET at a path named after the scheme, so each aimed scheme's
 * operation has a command of its own.
 */
const keyedBy = (scheme: SchemeSketch): OperationSketch => ({
	...COMMANDED,
	segments: [`keyed-${Str.toLowerCase(scheme.name)}`],
	security: Option.some([[[scheme.name, []]]])
})

/** The schemes the steered cases add, each named outside the names openapi-gen.ts draws. */
const AIMED_COOKIE: SchemeSketch = {
	name: "aimedCookie",
	deprecated: false,
	kind: { type: "apiKey", in: "cookie", name: "session" }
}

const AIMED_HEADER: SchemeSketch = {
	name: "aimedHeader",
	deprecated: false,
	kind: { type: "apiKey", in: "header", name: "X-Aimed-Key" }
}

const AIMED_QUERY: SchemeSketch = {
	name: "aimedQuery",
	deprecated: false,
	kind: { type: "apiKey", in: "query", name: "aimed_key" }
}

const AIMED_BASIC: SchemeSketch = {
	name: "aimedBasic",
	deprecated: false,
	kind: { type: "http", scheme: "basic" }
}

const AIMED_OIDC: SchemeSketch = {
	name: "aimedOidc",
	deprecated: false,
	kind: { type: "openIdConnect" }
}

const AIMED_MTLS: SchemeSketch = {
	name: "aimedMtls",
	deprecated: false,
	kind: { type: "mutualTLS" }
}

/**
 * An operation the generator refuses: a required body whose one alternative is an event stream, the refusal
 * openapi-gen.ts draws on purpose, so the operation goes with an operation-scope refusal.
 */
const REFUSED: OperationSketch = {
	...COMMANDED,
	method: "post",
	segments: ["refused-stream"],
	body: Option.some({
		required: true,
		description: Option.none(),
		alternatives: [{ kind: "event-stream" }]
	})
}

/**
 * An operation of one optional query parameter written by content with an array schema: COMMANDED's GET at a path of
 * its own. Such a parameter once reached its builder as the flag's Option, which tsc refused (shrunk from a failure at
 * TEST_SEED=2432862457), so every run's steered cases reach it.
 */
const CONTENT_ARRAY: OperationSketch = {
	...COMMANDED,
	segments: ["content-array"],
	parameters: [
		{
			location: "query",
			name: "limit",
			required: false,
			deprecated: false,
			description: Option.none(),
			serialization: {
				kind: "content",
				mediaType: "application/json",
				schema: { kind: "array", items: { kind: "string", format: Option.none(), values: [] } }
			}
		}
	]
}

/** The case with `operations` and `schemes` added to its document; its config, which names neither, still fits. */
const withAdded =
	(operations: ReadonlyArray<OperationSketch>, schemes: ReadonlyArray<SchemeSketch>) =>
	(drawnCase: PackageCase): PackageCase => ({
		config: drawnCase.config,
		document: {
			...drawnCase.document,
			schemes: [...drawnCase.document.schemes, ...schemes],
			operations: [...drawnCase.document.operations, ...operations]
		}
	})

/**
 * A positional `multipart/mixed` body (3.2's prefixEncoding: a JSON part, then opaque bytes) on a POST of its own.
 */
const MIXED: OperationSketch = {
	...COMMANDED,
	method: "post",
	segments: ["mixed-parts"],
	body: Option.some({
		required: true,
		description: Option.none(),
		alternatives: [{ kind: "mixed", parts: ["json", "binary"] }]
	})
}

/** A string schema with no format and no enumerated values. */
const PLAIN_STRING: SchemaSketch = { kind: "string", format: Option.none(), values: [] }

/** An object schema with no property, as a sequence's item or a response's record. */
const EMPTY_OBJECT: SchemaSketch = { kind: "object", properties: [], closed: false }

/** COMMANDED's GET at `segment`, answering 200 with `content`. */
const answering = (segment: string, content: ResponseSketch["content"]): OperationSketch => ({
	...COMMANDED,
	segments: [segment],
	responses: [{ status: "200", description: "Done", content, headers: [] }]
})

/** A POST at `segment` whose required body has the one alternative `alternative`. */
const sending = (segment: string, alternative: AlternativeSketch): OperationSketch => ({
	...COMMANDED,
	method: "post",
	segments: [segment],
	body: Option.some({ required: true, description: Option.none(), alternatives: [alternative] })
})

/** COMMANDED's GET at `segment`, taking the one optional parameter `parameter`. */
const taking = (segment: string, parameter: ParameterSketch): OperationSketch => ({
	...COMMANDED,
	segments: [segment],
	parameters: [parameter]
})

/** An optional parameter at `location` named `name`, written by `schema` in its location's default style. */
const parameterAt = (location: Location, name: string, schema: SchemaSketch): ParameterSketch => ({
	location,
	name,
	required: false,
	deprecated: false,
	description: Option.none(),
	serialization: { kind: "schema", schema, style: Option.none(), explode: Option.none() }
})

/** A 429 as an API answers one: a problem document and when to retry, beside a 204. */
const RETRIED: OperationSketch = {
	...COMMANDED,
	segments: ["retried"],
	responses: [
		...COMMANDED.responses,
		{
			status: "429",
			description: "Slow down",
			content: [{ kind: "problem" }],
			headers: [{ name: "Retry-After", required: false, deprecated: false }]
		}
	]
}

/** The case with `scheme` declared and an operation of its own requiring it alone. */
const withScheme =
	(scheme: SchemeSketch) =>
	(drawnCase: PackageCase): PackageCase =>
		withAdded([keyedBy(scheme)], [scheme])(drawnCase)

/** The case, changed by `add` when its document's line admits what `add` adds, else as drawn. */
const onLines =
	(lines: ReadonlyArray<Line>, add: (drawnCase: PackageCase) => PackageCase) =>
	(drawnCase: PackageCase): PackageCase =>
		Arr.contains(lines, drawnCase.document.line) ? add(drawnCase) : drawnCase

/** A property of an object a body or a parameter sends: optional, plain, undescribed. */
const plainProperty = (name: string, schema: SchemaSketch): PropertySketch => ({
	name,
	schema,
	required: false,
	readOnly: false,
	deprecated: false,
	description: Option.none(),
	defaultValue: Option.none()
})

/** An object of one string property `id`. */
const ID_OBJECT: SchemaSketch = {
	kind: "object",
	properties: [plainProperty("id", PLAIN_STRING)],
	closed: false
}

/** A GET of a path parameter of its own. */
const BY_ID: OperationSketch = {
	...COMMANDED,
	segments: ["by-id", "{aimedId}"],
	parameters: [{ ...parameterAt("path", "aimedId", PLAIN_STRING), required: true }]
}

/** A GET of an optional query object written by deepObject. */
const DEEP_QUERY: OperationSketch = taking("deep-taking", {
	...parameterAt("query", "filter", ID_OBJECT),
	serialization: {
		kind: "schema",
		schema: ID_OBJECT,
		style: Option.some("deepObject"),
		explode: Option.some(true)
	}
})

/** A GET of a 3.2 querystring, a form of one string field. */
const QUERYSTRING: OperationSketch = {
	...COMMANDED,
	segments: ["querystring-taking"],
	querystring: Option.some({
		mediaType: "application/x-www-form-urlencoded",
		properties: [plainProperty("q", PLAIN_STRING)]
	})
}

/** A POST whose required body offers a JSON object or text. */
const SEVERAL: OperationSketch = {
	...sending("several-sending", { kind: "json", mediaType: "application/json", schema: ID_OBJECT }),
	body: Option.some({
		required: true,
		description: Option.none(),
		alternatives: [
			{ kind: "json", mediaType: "application/json", schema: ID_OBJECT },
			{ kind: "text", mediaType: "text/plain" }
		]
	})
}

const AIMED_BEARER: SchemeSketch = {
	name: "aimedBearer",
	deprecated: false,
	kind: { type: "http", scheme: "bearer" }
}

const AIMED_OAUTH: SchemeSketch = {
	name: "aimedOauth",
	deprecated: false,
	kind: {
		type: "oauth2",
		flows: [["clientCredentials", [["read", "Read access"]]]],
		metadata: false
	}
}

/** COMMANDED's GET at a path of its own, tagged `tag`, as its group's one command. */
const taggedWith = (segment: string, tags: ReadonlyArray<string>): OperationSketch => ({
	...COMMANDED,
	segments: [segment],
	tags
})

/** The case's config, changed by `change`. */
const configured =
	(change: (config: ConfigSketch) => ConfigSketch) =>
	(drawnCase: PackageCase): PackageCase => ({
		document: drawnCase.document,
		config: change(drawnCase.config)
	})

/** The case's document, changed by `change`. */
const documented =
	(change: (document: DocumentSketch) => DocumentSketch) =>
	(drawnCase: PackageCase): PackageCase => ({
		document: change(drawnCase.document),
		config: drawnCase.config
	})

/** The document with a child group of its own: a parent tag, a child tag under it, and an operation of the child. */
const withChildGroup = (document: DocumentSketch): DocumentSketch => ({
	...document,
	tags: [
		...document.tags,
		{ name: "aimedParent", parent: Option.none() },
		{ name: "aimedChild", parent: Option.some("aimedParent") }
	],
	operations: [...document.operations, taggedWith("child-tagged", ["aimedChild"])]
})

/**
 * What a steered case adds for each situation still pending, every one but a document's line: an operation holding
 * it (each parameter location and style, each body and response kind, each scheme kind, an alias, a deprecated
 * operation, a group named like a binding, a refused operation, an optional array parameter written by content), a
 * child group, a querystring and a positional multipart/mixed body on 3.2, a webhook on 3.1 and 3.2, or the config's
 * added scheme or non-standard switch. The drawn case keeps everything else, so a steered case still reaches what its
 * plain draw reached, and one case reaches every pending situation it has an arm for, whatever its witnesses drew.
 */
const ARMS: ReadonlyArray<readonly [Feature, (drawnCase: PackageCase) => PackageCase]> = [
	["a path parameter", withAdded([BY_ID], [])],
	["a query deepObject parameter", withAdded([DEEP_QUERY], [])],
	["a querystring parameter", onLines(["3.2"], withAdded([QUERYSTRING], []))],
	["a content parameter", withAdded([CONTENT_ARRAY], [])],
	[
		"a JSON body",
		withAdded(
			[sending("json-sending", { kind: "json", mediaType: "application/json", schema: ID_OBJECT })],
			[]
		)
	],
	[
		"a form body",
		withAdded(
			[
				sending("form-sending", {
					kind: "form",
					properties: [plainProperty("name", PLAIN_STRING)],
					encodings: []
				})
			],
			[]
		)
	],
	[
		"a form-data body",
		withAdded(
			[
				sending("form-data-sending", {
					kind: "multipart",
					parts: [
						{ name: "file", schema: PLAIN_STRING, required: false, contentTypes: [], headers: [] }
					]
				})
			],
			[]
		)
	],
	["several body alternatives", withAdded([SEVERAL], [])],
	["a bearer scheme", withScheme(AIMED_BEARER)],
	["an OAuth 2 scheme", withScheme(AIMED_OAUTH)],
	[
		"an author-supplied scheme",
		configured((config) => ({ ...config, added: Option.some("bearer") }))
	],
	[
		"an alias",
		withAdded(
			[{ ...taggedWith("aliased", []), aliases: [{ group: "aliases", method: "fetchAimed" }] }],
			[]
		)
	],
	["a child group", onLines(["3.2"], documented(withChildGroup))],
	["a group named like a binding", withAdded([taggedWith("binding-tagged", ["Effect"])], [])],
	[
		"a deprecated operation",
		withAdded([{ ...taggedWith("deprecated", []), deprecated: true }], [])
	],
	[
		"a webhook",
		onLines(
			["3.1", "3.2"],
			documented((document) => ({ ...document, webhooks: [...document.webhooks, "aimedHook"] }))
		)
	],
	["a non-standard switch", configured((config) => ({ ...config, brackets: Option.some(true) }))],
	["an apiKey cookie scheme", withScheme(AIMED_COOKIE)],
	["an apiKey header scheme", withScheme(AIMED_HEADER)],
	["an apiKey query scheme", withScheme(AIMED_QUERY)],
	["a basic scheme", withScheme(AIMED_BASIC)],
	["an OpenID Connect scheme", withScheme(AIMED_OIDC)],
	["a mutual TLS scheme", onLines(["3.1", "3.2"], withScheme(AIMED_MTLS))],
	["a positional multipart/mixed body", onLines(["3.2"], withAdded([MIXED], []))],
	[
		"a header parameter",
		withAdded([taking("header-taking", parameterAt("header", "X-Aimed", PLAIN_STRING))], [])
	],
	[
		"a cookie parameter",
		withAdded([taking("cookie-taking", parameterAt("cookie", "aimed", PLAIN_STRING))], [])
	],
	[
		"a query array parameter",
		withAdded(
			[
				taking(
					"array-taking",
					parameterAt("query", "aimed", { kind: "array", items: PLAIN_STRING })
				)
			],
			[]
		)
	],
	[
		"a JSON Lines body",
		withAdded(
			[
				sending("jsonl-sending", {
					kind: "sequential",
					mediaType: "application/jsonl",
					item: EMPTY_OBJECT
				})
			],
			[]
		)
	],
	[
		"a binary body",
		withAdded(
			[sending("binary-sending", { kind: "binary", mediaType: "application/octet-stream" })],
			[]
		)
	],
	[
		"a text body",
		withAdded([sending("text-sending", { kind: "text", mediaType: "text/plain" })], [])
	],
	["an SSE response", withAdded([answering("sse-answering", [{ kind: "event-stream" }])], [])],
	[
		"a JSON-seq response",
		withAdded([answering("seq-answering", [{ kind: "json-seq", item: EMPTY_OBJECT }])], [])
	],
	[
		"an NDJSON response",
		withAdded([answering("ndjson-answering", [{ kind: "ndjson", item: EMPTY_OBJECT }])], [])
	],
	["a binary response", withAdded([answering("binary-answering", [{ kind: "binary" }])], [])],
	["a problem response with Retry-After", withAdded([RETRIED], [])],
	["an operation refused", withAdded([REFUSED], [])],
	["an optional array parameter by content", withAdded([CONTENT_ARRAY], [])]
]

/**
 * The package cases: a generated document and an author config that fits it, unsteered; under steering, the same draw
 * with every arm of a pending situation added.
 */
export const packageSpace: Steered<PackageCase, Feature> = steered((steering) =>
	Option.match(steering, {
		onNone: () => caseGen,
		onSome: (pending) =>
			map(caseGen, (drawnCase) =>
				Arr.reduce(
					Arr.filter(ARMS, ([feature]) => pending.has(feature)),
					drawnCase,
					(changed, [, add]) => add(changed)
				)
			)
	})
)

/** A package case whose package has a command, so its root services layer provides Servers: a generated document
 * with COMMANDED among its operations, and an author config that fits it. */
export const commandedCaseGen: Gen<PackageCase> = (s) => {
	const sketch = s.draw(documentGen)
	const document: DocumentSketch = { ...sketch, operations: [...sketch.operations, COMMANDED] }
	return { document, config: s.draw(configGen(document)) }
}

/** The files the printer writes: every module and JSON file of the package but the runtime's sources, which ship
 * verbatim. */
const isPrinted = (path: string): boolean =>
	!Str.startsWith("node_modules/")(path) &&
	!Str.startsWith("src/runtime/")(path) &&
	path !== "src/domain/errors.ts" &&
	(Str.endsWith(".ts")(path) || Str.endsWith(".json")(path))

export type Feature =
	| "OpenAPI 3.0"
	| "OpenAPI 3.1"
	| "OpenAPI 3.2"
	| "a path parameter"
	| "a query deepObject parameter"
	| "a query array parameter"
	| "a header parameter"
	| "a cookie parameter"
	| "a querystring parameter"
	| "a content parameter"
	| "an optional array parameter by content"
	| "a JSON body"
	| "a form body"
	| "a form-data body"
	| "a positional multipart/mixed body"
	| "a JSON Lines body"
	| "a binary body"
	| "a text body"
	| "several body alternatives"
	| "an SSE response"
	| "a JSON-seq response"
	| "an NDJSON response"
	| "a binary response"
	| "a problem response with Retry-After"
	| "a bearer scheme"
	| "a basic scheme"
	| "an apiKey header scheme"
	| "an apiKey query scheme"
	| "an apiKey cookie scheme"
	| "an OAuth 2 scheme"
	| "an OpenID Connect scheme"
	| "a mutual TLS scheme"
	| "an author-supplied scheme"
	| "an alias"
	| "a child group"
	| "a group named like a binding"
	| "a deprecated operation"
	| "a webhook"
	| "a non-standard switch"
	| "an operation refused"

const pointerOf = (operation: OperationSketch): string =>
	`/paths/${JsonPointer.escapeToken(`/${Arr.join(operation.segments, "/")}`)}/${operation.method}`

/** The schemes an operation's requirements name, its own or the document's. */
const schemesOf = (document: DocumentSketch, operation: OperationSketch): ReadonlyArray<string> =>
	Arr.flatMap(
		Option.getOrElse(
			Option.orElse(operation.security, () => document.security),
			(): ReadonlyArray<Requirement> => []
		),
		(requirement) => Arr.map(requirement, ([scheme]) => scheme)
	)

const SCHEME_FEATURES: ReadonlyArray<readonly [Feature, (scheme: SchemeSketch) => boolean]> = [
	["a bearer scheme", (scheme) => scheme.kind.type === "http" && scheme.kind.scheme === "bearer"],
	["a basic scheme", (scheme) => scheme.kind.type === "http" && scheme.kind.scheme === "basic"],
	[
		"an apiKey header scheme",
		(scheme) => scheme.kind.type === "apiKey" && scheme.kind.in === "header"
	],
	[
		"an apiKey query scheme",
		(scheme) => scheme.kind.type === "apiKey" && scheme.kind.in === "query"
	],
	[
		"an apiKey cookie scheme",
		(scheme) => scheme.kind.type === "apiKey" && scheme.kind.in === "cookie"
	],
	["an OAuth 2 scheme", (scheme) => scheme.kind.type === "oauth2"],
	["an OpenID Connect scheme", (scheme) => scheme.kind.type === "openIdConnect"],
	["a mutual TLS scheme", (scheme) => scheme.kind.type === "mutualTLS"]
]

const staticImport = regex('from "\\./([a-z0-9-]+)\\.ts"', "gu")

const apiImport = regex('from "\\.\\./api/([a-z0-9-]+)\\.ts"', "gu")

/** The api modules the root may import statically: its own commands' builders, the security and servers tables. */
const ROOT_API: ReadonlyArray<string> = ["root", "security", "servers"]

/** What starts a run eagerly, which the entry modules never hold: a top-level await, or argv read past Stdio. */
const EAGER: ReadonlyArray<string> = ["await", "process.argv"]

/** The root services layer's `BaseUrl.layer` entry, which provides the `Servers` service every operation command
 * requires. */
export const baseUrlLayer = regex('BaseUrl\\.layer\\(servers, "[A-Z0-9_]+"\\),\\s*', "u")

/** What tsc reports when a run still requires `Servers` where the entry needs every service provided. */
export const UNPROVIDED_SERVERS = "Type 'Servers' is not assignable to type 'never'"

const dynamicImport = regex('import\\("\\./([a-z0-9-]+)\\.ts"\\)', "gu")

const tableEntry = regex('import\\("\\./([a-z0-9-]+)\\.ts"\\),\\s*name: "([^"\\\\]*)"', "gu")

const groupHeader = regex('export const group = Command\\.make\\(\\s*"([^"\\\\]*)"', "gu")

const modulesIn = (text: string, pattern: RegExp): ReadonlyArray<string> =>
	Arr.map(Arr.fromIterable(Str.matchAll(pattern)(text)), (match) => match[1] ?? "")

const pairsIn = (text: string, pattern: RegExp): ReadonlyArray<readonly [string, string]> =>
	Arr.map(
		Arr.fromIterable(Str.matchAll(pattern)(text)),
		(match) => [match[1] ?? "", match[2] ?? ""] as const
	)

/** A package's command modules: the root's text, each other module's text by its name, and the entry modules' texts by
 * their paths. */
type CliModules = Readonly<{
	root: string
	groups: ReadonlyArray<readonly [name: string, text: string]>
	entries: ReadonlyArray<readonly [file: string, text: string]>
}>

export const cliModulesOf = (dir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const cli = path.join(dir, "src", "cli")
		const listed = yield* fs.readDirectory(cli)
		const names = Arr.map(
			Arr.filter(listed, (file) => Str.endsWith(".ts")(file) && file !== "root.ts"),
			(file) => Str.slice(0, -3)(file)
		)
		const groups = yield* Effect.forEach(names, (name) =>
			Effect.map(fs.readFileString(path.join(cli, `${name}.ts`)), (text) => [name, text] as const)
		)
		const entries = yield* Effect.forEach(
			["src/cli/root.ts", "src/main.ts", "src/bin.ts"],
			(file) => Effect.map(fs.readFileString(path.join(dir, file)), (text) => [file, text] as const)
		)
		const root = yield* fs.readFileString(path.join(cli, "root.ts"))
		const modules: CliModules = { root, groups, entries }
		return modules
	})

/** The command modules another command module imports statically: the child groups. */
const childrenOf = (modules: CliModules): ReadonlyArray<string> =>
	Arr.flatMap(modules.groups, ([, text]) => modulesIn(text, staticImport))

/** What the package reached, read from the operations it emitted a command for and the command modules it wrote. */
export const featuresOf = (
	drawnCase: PackageCase,
	commanded: ReadonlyArray<string>,
	modules: CliModules
): ReadonlyArray<Feature> => {
	const { document, config } = drawnCase
	const emitted = Arr.filter(document.operations, (operation) =>
		Arr.contains(commanded, pointerOf(operation))
	)
	const parameters = Arr.flatMap(emitted, (operation) => operation.parameters)
	const alternatives = Arr.flatMap(emitted, (operation) =>
		Option.match(operation.body, { onNone: () => [], onSome: (body) => body.alternatives })
	)
	const responses = Arr.flatMap(emitted, (operation) => operation.responses)
	const contents = Arr.flatMap(responses, (response) =>
		Arr.map(response.content, (content) => content.kind)
	)
	const used = Arr.flatMap(emitted, (operation) => schemesOf(document, operation))
	const usedSchemes = Arr.filter(document.schemes, (scheme) => Arr.contains(used, scheme.name))
	const when = (holds: boolean, feature: Feature): ReadonlyArray<Feature> =>
		holds ? [feature] : []
	const located = (location: string) =>
		Arr.some(parameters, (parameter) => parameter.location === location)
	const bodies = (kind: string) =>
		Arr.some(alternatives, (alternative) => alternative.kind === kind)
	return [
		...when(document.line === "3.0", "OpenAPI 3.0"),
		...when(document.line === "3.1", "OpenAPI 3.1"),
		...when(document.line === "3.2", "OpenAPI 3.2"),
		...when(located("path"), "a path parameter"),
		...when(
			Arr.some(
				parameters,
				(parameter) =>
					parameter.location === "query" &&
					parameter.serialization.kind === "schema" &&
					parameter.serialization.schema.kind === "object" &&
					Option.contains(parameter.serialization.style, "deepObject")
			),
			"a query deepObject parameter"
		),
		...when(
			Arr.some(
				parameters,
				(parameter) =>
					parameter.location === "query" &&
					parameter.serialization.kind === "schema" &&
					parameter.serialization.schema.kind === "array"
			),
			"a query array parameter"
		),
		...when(located("header"), "a header parameter"),
		...when(located("cookie"), "a cookie parameter"),
		...when(
			Arr.some(emitted, (operation) => Option.isSome(operation.querystring)),
			"a querystring parameter"
		),
		...when(
			Arr.some(parameters, (parameter) => parameter.serialization.kind === "content"),
			"a content parameter"
		),
		...when(
			Arr.some(
				parameters,
				(parameter) =>
					!parameter.required &&
					parameter.serialization.kind === "content" &&
					parameter.serialization.schema.kind === "array"
			),
			"an optional array parameter by content"
		),
		...when(bodies("json"), "a JSON body"),
		...when(bodies("form"), "a form body"),
		...when(bodies("multipart"), "a form-data body"),
		...when(bodies("mixed"), "a positional multipart/mixed body"),
		...when(
			Arr.some(
				alternatives,
				(alternative) =>
					alternative.kind === "sequential" && alternative.mediaType === "application/jsonl"
			),
			"a JSON Lines body"
		),
		...when(bodies("binary"), "a binary body"),
		...when(bodies("text"), "a text body"),
		...when(
			Arr.some(emitted, (operation) =>
				Option.exists(operation.body, (body) => body.alternatives.length > 1)
			),
			"several body alternatives"
		),
		...when(Arr.contains(contents, "event-stream"), "an SSE response"),
		...when(Arr.contains(contents, "json-seq"), "a JSON-seq response"),
		...when(Arr.contains(contents, "ndjson"), "an NDJSON response"),
		...when(Arr.contains(contents, "binary"), "a binary response"),
		...when(
			Arr.some(
				responses,
				(response) =>
					Arr.some(response.content, (content) => content.kind === "problem") &&
					Arr.some(response.headers, (header) => header.name === "Retry-After")
			),
			"a problem response with Retry-After"
		),
		...Arr.flatMap(SCHEME_FEATURES, ([feature, matches]) =>
			when(Arr.some(usedSchemes, matches), feature)
		),
		...when(
			Option.isSome(config.added) && Arr.isReadonlyArrayNonEmpty(emitted),
			"an author-supplied scheme"
		),
		...when(
			Arr.some(emitted, (operation) => Arr.isReadonlyArrayNonEmpty(operation.aliases)),
			"an alias"
		),
		...when(Arr.isReadonlyArrayNonEmpty(childrenOf(modules)), "a child group"),
		...when(
			Arr.some(modules.groups, ([name]) =>
				Arr.contains(Arr.map(BINDING_TAGS, Str.toLowerCase), name)
			),
			"a group named like a binding"
		),
		...when(
			Arr.some(emitted, (operation) => operation.deprecated),
			"a deprecated operation"
		),
		...when(Arr.isReadonlyArrayNonEmpty(document.webhooks), "a webhook"),
		...when(
			Option.contains(config.brackets, true) || Option.contains(config.scalars, true),
			"a non-standard switch"
		),
		...when(
			emitted.length < document.operations.length - config.skipped.length,
			"an operation refused"
		)
	]
}

/** Each printed file of a generated package that oxfmt would change, by path. */
export const unformatted = (dir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const listed = yield* fs.readDirectory(dir, { recursive: true })
		const files = Arr.filter(listed, isPrinted)
		const changed = yield* Effect.forEach(files, (file) =>
			Effect.gen(function* () {
				const text = yield* fs.readFileString(path.join(dir, file))
				const result = yield* Effect.promise(() => format(file, text, FORMAT_OPTIONS))
				return result.code === text && !Arr.isReadonlyArrayNonEmpty(result.errors)
					? Option.none()
					: Option.some(file)
			})
		)
		return Arr.getSomes(changed)
	})

/** Each runtime source the package does not hold byte for byte under src/, by its path. */
export const unshipped = (dir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const sources = yield* runtimeSources
		const missing = yield* Effect.forEach(Record.toEntries(sources), ([key, content]) =>
			Effect.map(Effect.exit(fs.readFileString(path.join(dir, "src", key))), (read) =>
				Exit.isSuccess(read) && read.value === content ? Option.none() : Option.some(key)
			)
		)
		return Arr.getSomes(missing)
	})

const decoder = new TextDecoder()

/** What a package's own typecheck reports: nothing when it passes, else tsc's output, or the failure itself when tsc
 * never ran. */
export const typecheckReport = (generated: Parameters<typeof typecheckPackage>[0]) =>
	Effect.map(Effect.exit(typecheckPackage(generated)), (checked) =>
		Exit.match(checked, {
			onSuccess: () => "",
			onFailure: (cause) =>
				Option.match(Cause.findErrorOption(cause), {
					onNone: () => Formatter.format(cause),
					onSome: (failed) =>
						failed._tag === "BuildStepFailed"
							? decoder.decode(failed.stdout)
							: Formatter.format(failed)
				})
		})
	)

const commandExport = regex("^export const ([A-Za-z0-9_$]+) = Command\\.make\\(", "gmu")

const RUN_RECORD = "Command.provideEffectDiscard(Output.recordRun("

/**
 * Each operation command, in the root's module and in every group's, that does not record the run (the error format
 * the run renders in) as a step of its own before its first annotation, by module and command.
 */
export const runRecordFindings = (modules: CliModules): ReadonlyArray<string> =>
	Arr.flatMap([["root", modules.root] as const, ...modules.groups], ([module, text]) => {
		const starts = Arr.fromIterable(Str.matchAll(commandExport)(text))
		return Arr.flatMap(starts, (match, index) => {
			const name = match[1] ?? ""
			const start = match.index
			const end = Option.getOrElse(
				Option.map(Arr.get(starts, index + 1), (next) => next.index),
				() => text.length
			)
			const command = Str.slice(start, end)(text)
			const recorded = Str.indexOf(RUN_RECORD)(command)
			const annotated = Str.indexOf("Command.annotate(")(command)
			const before = Option.match(recorded, {
				onNone: () => false,
				onSome: (at) =>
					Option.match(annotated, { onNone: () => true, onSome: (first) => at < first })
			})
			return name === "group" || before ? [] : [`${module}.${name} does not record the run first`]
		})
	})

/**
 * Whether the root command module is lazy: it imports no command module statically; every command module is loaded
 * exactly once, by the root's `import()` or by its parent's import; and each root table entry's header names the group
 * its module's `Command.make` makes.
 */
export const lazyRootFindings = (modules: CliModules): ReadonlyArray<string> => {
	const names = Arr.map(modules.groups, ([name]) => name)
	const lazy = modulesIn(modules.root, dynamicImport)
	const loaded = [...lazy, ...childrenOf(modules)]
	const headers = Arr.map(
		modules.groups,
		([name, text]) => [name, modulesIn(text, groupHeader)] as const
	)
	const entries = pairsIn(modules.root, tableEntry)
	return [
		...Arr.flatMap(modules.entries, ([file, text]) =>
			Arr.map(
				Arr.filter(EAGER, (word) => Str.includes(word)(text)),
				(word) => `${file} holds ${word}`
			)
		),
		...Arr.map(
			Arr.filter(modulesIn(modules.root, apiImport), (name) => !Arr.contains(ROOT_API, name)),
			(name) => `root imports api/${name} statically`
		),
		...Arr.map(
			Arr.filter(modulesIn(modules.root, staticImport), (name) => Arr.contains(names, name)),
			(name) => `root imports ${name} statically`
		),
		...Arr.flatMap(names, (name) => {
			const count = Arr.filter(loaded, (load) => load === name).length
			return count === 1 ? [] : [`${name} is loaded ${count} times`]
		}),
		...Arr.flatMap(lazy, (name) => {
			const named = Arr.flatMap(entries, ([module, header]) => (module === name ? [header] : []))
			const made = Arr.flatMap(headers, ([module, makes]) => (module === name ? makes : []))
			const agrees =
				named.length > 0 &&
				made.length > 0 &&
				Arr.every(named, (header) => Arr.every(made, (make) => make === header))
			return agrees
				? []
				: [
						`root's entry for ${name} names ${Arr.join(named, ", ")} and its module makes ${Arr.join(made, ", ")}`
					]
		})
	]
}
