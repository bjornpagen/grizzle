import { Effect, Schema } from "effect"
import type { EmittedFile } from "#emit/package.ts"
import {
	Identifier,
	MemberName,
	ModuleSpecifier,
	Shebang,
	arr,
	arrow,
	bool,
	call,
	ident,
	member,
	newExpr,
	num,
	obj,
	printModule,
	str,
	typeKeyword,
	typeName,
	typeReadonlyArray,
	typeRef,
	typeUnion
} from "#emit/printer.ts"
import type { Expr, Import, Module, Param, PrinterError, Statement } from "#emit/printer.ts"
import { runtimeSettings } from "#model/author-config.ts"
import type { AuthorConfig } from "#model/author-config.ts"
import type { SecurityScheme } from "#model/entities.ts"
import { envPrefixOf } from "#names/plan.ts"

const I = Schema.decodeSync(Identifier)

const M = Schema.decodeSync(MemberName)

const S = Schema.decodeSync(ModuleSpecifier)

// `path("a.b.c")` is the member access `a.b.c`; every caller passes a fixed name.
const path = (dotted: string): Expr => {
	const [head = "", ...rest] = dotted.split(".")

	let expr = ident(I(head))
	for (const name of rest) {
		expr = member(expr, M(name))
	}

	return expr
}

const fn = (callee: string, ...args: readonly Expr[]): Expr => call(path(callee), args)

const named = (from: string, names: readonly string[], typeOnly = false): Import => ({
	_tag: "Named",
	from: S(from),
	names: names.map((name) => I(name)),
	typeOnly
})

const namespace = (from: string, name: string): Import => ({
	_tag: "Namespace",
	from: S(from),
	name: I(name),
	typeOnly: false
})

const stringParam = (name: string): Param => ({ name: I(name), type: typeKeyword("string") })

const piped = (head: Expr, ...steps: readonly Expr[]): Expr => call(member(head, M("pipe")), steps)

const constant = (name: string, value: Expr, exported = false): Statement => ({
	_tag: "Const",
	exported,
	name: I(name),
	value
})

/**
 * The fallback object of the `ConfigProvider` `main.ts` composes (design D-AD7): each runtime
 * setting `runtimeSettings` resolves, keyed by the explicit prefixed env name its runtime resolver
 * reads (`<PREFIX>_TIMEOUT`; memo 6f21e261), in key
 * order. Nothing is nested, so an environment value of the same name wins.
 */
export const runtimeFallback = (config: AuthorConfig) => {
	const prefix = envPrefixOf(config)
	const settings = runtimeSettings(config)

	return {
		[`${prefix}_TIMEOUT`]: settings.timeoutSeconds
	}
}

/**
 * `main.ts` (design 4.1 Lazy root, 14 D5): reads the arguments from `Stdio`, builds the root with
 * `cli/root.ts` `root` (which loads only the groups the arguments select), then `Command.run` over
 * that root with `renderErrors: false` (the final catch is the only renderer), provided with the
 * root's `services` and `CliOutput.layer(Output.formatter(root))`, then `Output.exitForHelp` (help
 * with parse errors exits 2) inside `Output.finalCatch`, which reads `<PREFIX>_ERROR_FORMAT` for a
 * parse-time error. The credentials the handler evaluated reach the catch through
 * `RunCredentials`, so its own list is empty. The whole run reads config through
 * `ConfigProvider.orElse(<env>, ConfigProvider.fromUnknown(runtimeFallback(config)))`, so an author
 * default applies when its env name is unset (design D-AD7).
 */
const mainModule = (config: AuthorConfig): Module => {
	const runRoot = fn(
		"Command.run",
		path("command"),
		obj([
			["renderErrors", bool(false)],
			["version", str(config.package.version)]
		])
	)
	const layers = fn(
		"Layer.mergeAll",
		path("services"),
		fn("CliOutput.layer", fn("Output.formatter", path("command")))
	)
	const args = fn("Stdio.Stdio.use", arrow([{ name: I("stdio") }], path("stdio.args")))
	const fallback = Object.entries(runtimeFallback(config)).map(
		([name, value]): readonly [string, Expr] => [name, num(value)]
	)
	const provider = fn(
		"ConfigProvider.orElse",
		fn("ConfigProvider.fromEnv"),
		fn("ConfigProvider.fromUnknown", obj(fallback))
	)

	return {
		imports: [
			named("effect", ["ConfigProvider", "Effect", "Layer", "Stdio"]),
			named("effect/cli", ["CliOutput", "Command"]),
			named("./cli/root.ts", ["root", "services"]),
			namespace("./runtime/output.ts", "Output")
		],
		statements: [
			constant("provider", provider),
			constant(
				"run",
				call(member(args, M("pipe")), [
					fn("Effect.flatMap", path("root")),
					fn(
						"Effect.flatMap",
						arrow(
							[{ name: I("command") }],
							call(member(runRoot, M("pipe")), [fn("Effect.provide", layers)])
						)
					),
					path("Output.exitForHelp"),
					fn("Output.finalCatch", arr([]), obj([["envPrefix", str(envPrefixOf(config))]])),
					fn("Effect.provideService", path("ConfigProvider.ConfigProvider"), path("provider"))
				]),
				true
			)
		]
	}
}

/**
 * The client-certificate part of `bin.ts` (design 4.3, 6.5 `mutualTLS` row, D-SEC3), emitted only
 * for a package with a `mutualTLS` scheme. At start-up it reads each `mutualTLS` scheme of
 * `api/security.ts` through the runtime's `Auth.clientCertificatePaths` (the names the scheme
 * carries are the one derivation) and reads each configured path into bytes (design 9 I5): a path
 * that cannot be read, is not a regular file (a directory, FIFO or device is never opened) or holds
 * more than `Auth.maxCertificateBytes` is a `UsageError` naming its environment variable and never
 * the path, exit 2, rendered once by `Output.finalCatch`, which reads `<PREFIX>_ERROR_FORMAT` as
 * for a parse-time error (design 7.4). The read itself stops at the bound, so a file swapped after
 * the `stat` cannot exceed it. Over the first configured scheme's PEM text it builds the
 * certified clients: a direct pool that presents `{ cert, key, ca? }` to the host it connects to,
 * and a proxy-environment pool that presents it to the host through the tunnel (`requestTls`) and
 * never to the proxy. The runtime sends a hop through them only on the operation's bound origins,
 * because a client that always presents the certificate presents it to every host (I3).
 */
const clientCertificateStatements = (): readonly Statement[] => {
	// `parts` are joined: the printer has no nested `+` (printer.ts `check`, `Plus`).
	const unreadable = arrow(
		[
			{
				name: I("parts"),
				type: typeReadonlyArray(typeUnion([typeKeyword("number"), typeKeyword("string")]))
			}
		],
		newExpr(path("UsageError"), [obj([["message", fn("parts.join", str(""))]])])
	)
	const fileNamed = (tail: readonly Expr[]): Expr =>
		fn("unreadable", arr([str("the file named by "), path("name"), ...tail]))
	const cannotRead = arrow(
		[],
		fn("unreadable", arr([str("cannot read the file named by "), path("name")]))
	)
	const bounded = piped(
		fn("Stream.mapError", fn("fs.stream", path("path")), cannotRead),
		fn(
			"Stream.limitBytes",
			path("Auth.maxCertificateBytes"),
			arrow(
				[],
				fn(
					"Stream.fail",
					fileNamed([str(" is larger than "), path("Auth.maxCertificateBytes"), str(" bytes")])
				)
			)
		),
		path("Stream.decodeText"),
		path("Stream.mkString")
	)
	const regularOnly = arrow(
		[{ name: I("info") }],
		piped(
			fn("Match.value", path("info")),
			fn("Match.when", obj([["type", str("File")]]), arrow([], bounded)),
			fn("Match.orElse", arrow([], fn("Effect.fail", fileNamed([str(" is not a regular file")]))))
		)
	)
	const certificateFile = arrow(
		[stringParam("name"), stringParam("path")],
		fn(
			"FileSystem.FileSystem.use",
			arrow(
				[{ name: I("fs") }],
				piped(
					fn("Effect.mapError", fn("fs.stat", path("path")), cannotRead),
					fn("Effect.flatMap", regularOnly)
				)
			)
		)
	)
	const files = obj([
		[
			"ca",
			fn(
				"Effect.transposeOption",
				fn(
					"Option.map",
					path("configured.ca"),
					arrow([{ name: I("ca") }], fn("certificateFile", path("scheme.caEnv"), path("ca")))
				)
			)
		],
		["cert", fn("certificateFile", path("scheme.certEnv"), path("configured.cert"))],
		["key", fn("certificateFile", path("scheme.keyEnv"), path("configured.key"))]
	])
	const pair: readonly (readonly [string, Expr])[] = [
		["cert", path("files.cert")],
		["key", path("files.key")]
	]
	const init = arrow(
		[{ name: I("files") }],
		fn(
			"Option.match",
			path("files.ca"),
			obj([
				["onNone", arrow([], obj(pair))],
				["onSome", arrow([{ name: I("ca") }], obj([["ca", path("ca")], ...pair]))]
			])
		)
	)
	const certificateInit = arrow(
		[{ name: I("scheme"), type: typeRef(I("Auth"), [M("MutualTlsScheme")]) }],
		piped(
			fn("Auth.clientCertificatePaths", path("scheme")),
			fn(
				"Effect.mapError",
				arrow([], fn("unreadable", arr([str("cannot read the setting "), path("scheme.certEnv")])))
			),
			fn(
				"Effect.flatMap",
				arrow(
					[{ name: I("paths") }],
					fn(
						"Effect.transposeOption",
						fn(
							"Option.map",
							path("paths"),
							arrow([{ name: I("configured") }], fn("Effect.all", files))
						)
					)
				)
			),
			fn("Effect.map", fn("Option.map", init))
		)
	)
	const perScheme = arrow(
		[{ name: I("scheme") }],
		piped(
			fn("Match.value", path("scheme")),
			fn("Match.when", obj([["kind", str("mutualTLS")]]), path("certificateInit")),
			fn("Match.orElse", arrow([], path("Effect.succeedNone")))
		)
	)
	const certificateInits = fn(
		"Effect.forEach",
		fn("Object.values", path("security.schemes")),
		perScheme
	)
	const certified = piped(
		fn(
			"Effect.map",
			path("certificateInits"),
			arrow([{ name: I("all") }], fn("Option.firstSomeOf", path("all")))
		),
		fn(
			"Effect.flatMap",
			arrow(
				[{ name: I("tls") }],
				fn(
					"Effect.transposeOption",
					fn(
						"Option.map",
						path("tls"),
						arrow(
							[{ name: I("connect") }],
							fn(
								"pathClients",
								obj([["connect", path("connect")]]),
								obj([
									["connect", path("connect")],
									["requestTls", path("connect")]
								])
							)
						)
					)
				)
			)
		)
	)

	return [
		constant("unreadable", unreadable),
		constant("certificateFile", certificateFile),
		constant("certificateInit", certificateInit),
		constant("certificateInits", certificateInits),
		constant("certified", certified)
	]
}

/**
 * `bin.ts` (design 4.1, 4.3): the only emitted module that names the platform, Node. It composes
 * Node's services and the runtime's `Transport`: one Effect undici client per way a hop travels,
 * each over its own connection pool, which the run closes when it ends. `environment` routes a hop
 * from the platform's proxy variables (`EnvHttpProxyAgent`) and `direct` sends it straight to the
 * host, for the runtime's loopback hops (design 6.5 Loopback hosts). Neither pool follows
 * redirects; the runtime's own loop does. With a `mutualTLS` scheme whose files this run
 * configured it also builds the certified pair, whose pools present the certificate to the host and
 * never to a proxy (`clientCertificateStatements`); without one the certified pair is none. Then
 * the client policy (the `User-Agent` name and version), the run-scoped `RunCredentials`,
 * `RunRecord` (the error format and retry-hint record) and `RunWarnings` (the once-per-run
 * warnings) outside the final catch, the runtime presenter with no second formatter, the runtime's
 * built-in flags (`Output.builtIns`: every effect default but `--wizard`, help and version without
 * `-h`/`-v`), logs to stderr and no trace propagation. `runMain` reports no error: the final catch
 * already rendered it.
 */
const binModule = (config: AuthorConfig, mutualTls: boolean): Module => {
	const pool = (constructor: string) =>
		arrow(
			[{ name: I("options"), type: typeRef(I(constructor), [M("Options")]) }],
			fn(
				"Effect.acquireRelease",
				fn("Effect.sync", arrow([], newExpr(path(constructor), [path("options")]))),
				arrow([{ name: I("pool") }], fn("Effect.promise", arrow([], fn("pool.close"))))
			)
		)
	const clientOver = arrow(
		[{ name: I("dispatcher"), type: typeName(I("Dispatcher")) }],
		fn(
			"Effect.provideService",
			path("NodeHttpClient.makeUndici"),
			path("NodeHttpClient.Dispatcher"),
			path("dispatcher")
		)
	)
	const pathClients = arrow(
		[
			{ name: I("directOptions"), type: typeRef(I("Agent"), [M("Options")]) },
			{
				name: I("environmentOptions"),
				type: typeRef(I("EnvHttpProxyAgent"), [M("Options")])
			}
		],
		fn(
			"Effect.all",
			obj([
				["direct", fn("Effect.flatMap", fn("direct", path("directOptions")), path("clientOver"))],
				[
					"environment",
					fn("Effect.flatMap", fn("environment", path("environmentOptions")), path("clientOver"))
				]
			])
		)
	)
	const clients = fn(
		"Effect.all",
		obj([
			["certified", mutualTls ? path("certified") : path("Effect.succeedNone")],
			["plain", fn("pathClients", obj([]), obj([]))]
		])
	)
	const transportLayer = fn(
		"Layer.effect",
		path("Client.Transport"),
		mutualTls
			? piped(
					clients,
					fn("Output.finalCatch", arr([]), obj([["envPrefix", str(envPrefixOf(config))]]))
				)
			: clients
	)
	const transport = mutualTls
		? piped(
				transportLayer,
				fn(
					"Layer.provide",
					fn("Layer.mergeAll", path("NodeServices.layer"), path("Redact.runCredentialsLayer"))
				)
			)
		: transportLayer
	const clientPolicy = fn(
		"Layer.succeed",
		path("Output.ClientPolicy"),
		obj([
			["binName", str(config.binName)],
			["version", str(config.package.version)]
		])
	)
	const entry = fn(
		"Layer.mergeAll",
		path("NodeServices.layer"),
		path("transport"),
		path("clientPolicy"),
		path("Redact.runCredentialsLayer"),
		path("Output.runRecordLayer"),
		path("Output.runWarningsLayer"),
		fn("CliOutput.layerPresenter", path("Output.presenter")),
		fn("CliConfig.layer", obj([["builtIns", path("Output.builtIns")]])),
		fn("Layer.succeed", path("References.LogToStderr"), bool(true)),
		fn("Layer.succeed", path("HttpClient.TracerPropagationEnabled"), bool(false))
	)

	return {
		imports: [
			named("@effect/platform-node", ["NodeHttpClient", "NodeRuntime", "NodeServices"]),
			named("@effect/platform-node/Undici", ["Agent", "EnvHttpProxyAgent"]),
			named("@effect/platform-node/Undici", ["Dispatcher"], true),
			named(
				"effect",
				mutualTls
					? ["Effect", "FileSystem", "Layer", "Match", "Option", "References", "Stream"]
					: ["Effect", "Layer", "References"]
			),
			named("effect/cli", ["CliConfig", "CliOutput"]),
			named("effect/http", ["HttpClient"]),
			...(mutualTls
				? [named("./api/security.ts", ["security"]), named("./domain/errors.ts", ["UsageError"])]
				: []),
			named("./main.ts", ["run"]),
			...(mutualTls ? [namespace("./runtime/auth.ts", "Auth")] : []),
			namespace("./runtime/client.ts", "Client"),
			namespace("./runtime/output.ts", "Output"),
			namespace("./runtime/redact.ts", "Redact")
		],
		shebang: Schema.decodeSync(Shebang)("/usr/bin/env node"),
		statements: [
			constant("direct", pool("Agent")),
			constant("environment", pool("EnvHttpProxyAgent")),
			constant("clientOver", clientOver),
			constant("pathClients", pathClients),
			...(mutualTls ? clientCertificateStatements() : []),
			constant("transport", transport),
			constant("clientPolicy", clientPolicy),
			constant("entry", entry),
			{
				_tag: "Expression",
				value: fn(
					"NodeRuntime.runMain",
					fn("Effect.provide", path("run"), path("entry")),
					obj([["disableErrorReporting", bool(true)]])
				)
			}
		]
	}
}

/**
 * Emits the generated package's `src/bin.ts` and `src/main.ts` (design 4.1, 4.3), sorted by path.
 * The package version is the `--version` text and the `User-Agent` version; the bin name is the
 * `User-Agent` name. Both print as escaped string literals. `securitySchemes` are the model's
 * declared schemes: a `mutualTLS` one among them makes `bin.ts` provide the client certificate.
 */
export const emitEntryFiles = (
	config: AuthorConfig,
	securitySchemes: readonly SecurityScheme[]
): Effect.Effect<readonly EmittedFile[], PrinterError> =>
	Effect.all([
		printModule(
			binModule(
				config,
				securitySchemes.some((scheme) => scheme.kind.type === "mutualTls")
			)
		),
		printModule(mainModule(config))
	]).pipe(
		Effect.map(([bin, main]) => [
			{ content: bin, path: "src/bin.ts" },
			{ content: main, path: "src/main.ts" }
		])
	)
