/**
 * Emitted packages against the compiler. A generated document and an author config that fits it generate a package, and
 * tsc, run as the package's own typecheck script runs it with the workspace's installed dependencies, reports nothing:
 * whatever the generator emits for a document it accepts, its domain, api, cli and entry modules type-check against the
 * runtime it ships. Every file the printer wrote is an oxfmt fixed point under the options docs/printer.md names; the
 * runtime's sources sit under src/ byte for byte as under src/runtime-src; and the root command module is lazy: it
 * imports no command module and no group's api module statically, every command module is loaded exactly once, by the
 * root's `import()` or by its parent group's import, each entry of the root's table names the group its module's
 * `Command.make` makes, and no entry module holds a top-level await or reads process.argv.
 *
 * Required features are read from what the package emitted: a construct counts only when an operation holding it has a
 * command. They reach every family the runtime-gate fixture reached: each parameter location (a query object by
 * deepObject and a query array among them), JSON, form, form-data, positional multipart/mixed, JSON Lines, binary and
 * text bodies, SSE, JSON-seq, NDJSON and binary responses, a problem response with Retry-After, and bearer, basic,
 * apiKey in a header, a query and a cookie, OAuth 2, OpenID Connect and mutual TLS. They also reach a child group and a
 * group whose name folds to a binding a command module holds (`Command`, `Effect`, `Groups`, `Arr`, `Client`).
 *
 * Plants, each applied to src/emit and seen to fail this suite and reverted:
 * - cli.ts's isArrayParameter without its content check, so an optional array parameter written by content reached its
 *   builder as the flag's Option (the kept case).
 */
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { drawn, explore } from "@superstarter/testing/explore"
import type { Kept } from "@superstarter/testing/explore"
import { required } from "@superstarter/testing/features"
import type { Gen } from "@superstarter/testing/gen"
import { notesOnly } from "@superstarter/testing/sense"
import { searched } from "@superstarter/testing/vitest"
import { regex } from "arkregex"
import {
	Array as Arr,
	Cause,
	Duration,
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
import {
	BINDING_TAGS,
	configGen,
	configOf,
	documentGen,
	documentOf,
	textOf
} from "#test/emit/openapi-gen.ts"
import type {
	ConfigSketch,
	DocumentSketch,
	OperationSketch,
	Requirement,
	SchemeSketch
} from "#test/emit/openapi-gen.ts"
import { generateFixture, harnessLayer, typecheckPackage } from "#test/support/cli-package.ts"

/** The formatter's options for generated files, as docs/printer.md names them. */
const FORMAT_OPTIONS: FormatConfig = {
	jsdoc: { commentLineStrategy: "multiline", lineWrappingStyle: "balance" }
}

/** A generated document and an author config that fits it. */
type PackageCase = Readonly<{ document: DocumentSketch; config: ConfigSketch }>

const caseGen: Gen<PackageCase> = (s) => {
	const sketch = s.draw(documentGen)
	return { document: sketch, config: s.draw(configGen(sketch)) }
}

/** The files the printer writes: every module and JSON file of the package but the runtime's sources, which ship
 * verbatim. */
const isPrinted = (path: string): boolean =>
	!Str.startsWith("node_modules/")(path) &&
	!Str.startsWith("src/runtime/")(path) &&
	path !== "src/domain/errors.ts" &&
	(Str.endsWith(".ts")(path) || Str.endsWith(".json")(path))

type Feature =
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

const cliModulesOf = (dir: string) =>
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
const featuresOf = (
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
const unformatted = (dir: string) =>
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
const unshipped = (dir: string) =>
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

/**
 * Whether the root command module is lazy: it imports no command module statically; every command module is loaded
 * exactly once, by the root's `import()` or by its parent's import; and each root table entry's header names the group
 * its module's `Command.make` makes.
 */
const lazyRootFindings = (modules: CliModules): ReadonlyArray<string> => {
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

/**
 * An optional query parameter written by content, with an array schema, reached its builder as the flag's Option,
 * which tsc refused. Shrunk from a failure at TEST_SEED=2432862457; replay it alone with
 * TEST_REPLAY='emitted package:2ffed39b1:2.0.0.0.1.0.0.0.0.2.0.0.0.0.0.0.0.1.1.0.0.0.0.0.1.0.1.1.0.1.0.0.0.0.0.1.0.1.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0.0.1.0.0.0.0.6.0.6.0.0.0.0.0.0.1.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0'
 */
const OPTIONAL_ARRAY_CONTENT: Kept<PackageCase, Feature> = {
	note: "an optional array parameter written by content",
	sketch: {
		document: {
			line: "3.2",
			title: "Update a user.",
			description: Option.none(),
			servers: [],
			tags: [],
			components: [],
			schemes: [],
			security: Option.none(),
			operations: [
				{
					method: "get",
					segments: ["users0"],
					operationId: Option.none(),
					tags: [],
					summary: Option.none(),
					description: Option.some("Update a user."),
					deprecated: false,
					parameters: [],
					querystring: Option.none(),
					body: Option.some({
						required: false,
						description: Option.some("Update a user."),
						alternatives: [
							{
								kind: "json",
								mediaType: "application/json",
								schema: { kind: "object", properties: [], closed: false }
							}
						]
					}),
					responses: [{ status: "200", description: "Update a user.", content: [], headers: [] }],
					security: Option.none(),
					aliases: []
				},
				{
					method: "get",
					segments: ["users1"],
					operationId: Option.none(),
					tags: [],
					summary: Option.none(),
					description: Option.some("Update a user."),
					deprecated: false,
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
								schema: {
									kind: "array",
									items: { kind: "string", format: Option.none(), values: [] }
								}
							}
						}
					],
					querystring: Option.none(),
					body: Option.none(),
					responses: [{ status: "200", description: "Update a user.", content: [], headers: [] }],
					security: Option.none(),
					aliases: []
				}
			],
			webhooks: []
		},
		config: {
			binName: "example",
			envPrefix: Option.none(),
			accepted: [],
			brackets: Option.none(),
			scalars: Option.none(),
			environments: [],
			skipped: [],
			added: Option.none()
		}
	},
	draws: "",
	reaches: ["OpenAPI 3.2", "a content parameter", "a JSON body"]
}

layer(harnessLayer, { excludeTestServices: true })("emit: generated packages", (it) => {
	it.effect(
		"every package generated from a generated document type-checks, with a lazy root, its runtime verbatim and every printed file one the formatter keeps",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "emitted package",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"OpenAPI 3.0",
								"OpenAPI 3.1",
								"OpenAPI 3.2",
								"a path parameter",
								"a query deepObject parameter",
								"a query array parameter",
								"a header parameter",
								"a cookie parameter",
								"a querystring parameter",
								"a content parameter",
								"a JSON body",
								"a form body",
								"a form-data body",
								"a positional multipart/mixed body",
								"a JSON Lines body",
								"a binary body",
								"a text body",
								"several body alternatives",
								"an SSE response",
								"a JSON-seq response",
								"an NDJSON response",
								"a binary response",
								"a problem response with Retry-After",
								"a bearer scheme",
								"a basic scheme",
								"an apiKey header scheme",
								"an apiKey query scheme",
								"an apiKey cookie scheme",
								"an OAuth 2 scheme",
								"an OpenID Connect scheme",
								"a mutual TLS scheme",
								"an author-supplied scheme",
								"an alias",
								"a child group",
								"a group named like a binding",
								"a deprecated operation",
								"a webhook",
								"a non-standard switch",
								"an operation refused"
							],
							{ cases: 40, sense: notesOnly }
						),
						kept: [OPTIONAL_ARRAY_CONTENT],
						runs: 8,
						shrink: { kind: "bounded", candidates: 60 },
						concurrency: 1,
						steerEvery: 4,
						caseHang: Duration.minutes(2)
					},
					(drawnCase, k) =>
						Effect.scoped(
							Effect.gen(function* () {
								const generated = yield* generateFixture({
									spec: { path: "openapi.json", text: textOf(documentOf(drawnCase.document)) },
									config: { path: "author-config.json", text: textOf(configOf(drawnCase.config)) },
									authorFiles: []
								})
								const modules = yield* cliModulesOf(generated.dir)
								k.noteAll(
									featuresOf(
										drawnCase,
										Arr.map(generated.result.report.commandNames, (command) => command.pointer),
										modules
									)
								)
								const kept = yield* unformatted(generated.dir)
								const shipped = yield* unshipped(generated.dir)
								const lazyRoot = lazyRootFindings(modules)
								const checked = yield* Effect.exit(typecheckPackage(generated))
								const got = {
									typecheck: Exit.match(checked, {
										onSuccess: () => "",
										onFailure: (cause) =>
											Option.match(Cause.findErrorOption(cause), {
												onNone: () => Formatter.format(cause),
												onSome: (failed) =>
													failed._tag === "BuildStepFailed"
														? decoder.decode(failed.stdout)
														: Formatter.format(failed)
											})
									}),
									unformatted: kept,
									unshipped: shipped,
									lazyRoot
								}
								const want: typeof got = {
									typecheck: "",
									unformatted: [],
									unshipped: [],
									lazyRoot: []
								}
								deepStrictEqual(got, want)
							})
						)
				)
			),
		Duration.toMillis(Duration.minutes(5))
	)
})
