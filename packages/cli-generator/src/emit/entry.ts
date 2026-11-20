import { Effect } from "effect"
import type { EmittedFile } from "#emit/package.ts"
import {
	arr,
	arrow,
	bool,
	call,
	fixedIdentifier,
	fixedMemberName,
	fixedModuleSpecifier,
	fixedShebang,
	fn,
	member,
	newExpr,
	obj,
	path,
	printModule,
	str,
	typeKeyword,
	typeName,
	typeReadonlyArray,
	typeRef
} from "#emit/printer.ts"
import type { Expr, Import, Module, Param, PrinterError, Statement } from "#emit/printer.ts"
import type { AuthorConfig } from "#model/author-config.ts"
import type { SecurityScheme } from "#model/entities.ts"
import { envPrefixOf } from "#names/plan.ts"

const named = (from: string, names: readonly string[], typeOnly = false): Import => ({
	_tag: "Named",
	from: fixedModuleSpecifier(from),
	names: names.map((name) => fixedIdentifier(name)),
	typeOnly
})

const namespace = (from: string, name: string): Import => ({
	_tag: "Namespace",
	from: fixedModuleSpecifier(from),
	name: fixedIdentifier(name),
	typeOnly: false
})

const stringParam = (name: string): Param => ({
	name: fixedIdentifier(name),
	type: typeKeyword("string")
})

const piped = (head: Expr, ...steps: readonly Expr[]): Expr =>
	call(member(head, fixedMemberName("pipe")), steps)

const constant = (name: string, value: Expr, exported = false): Statement => ({
	_tag: "Const",
	exported,
	name: fixedIdentifier(name),
	value
})

/**
 * `main.ts` (design 4.1 Lazy root, 14 D5): reads the arguments from `Stdio`, builds the root with
 * `cli/root.ts` `root` (which loads only the groups the arguments select), then `Command.run` over
 * that root with `renderErrors: false` (the final catch is the only renderer), provided with the
 * root's `services` and `CliOutput.layer(Output.formatter(root))`, then `Output.exitForHelp` (help
 * with parse errors exits 2) inside `Output.finalCatch`, which reads `<PREFIX>_ERROR_FORMAT` for a
 * parse-time error. The credentials the handler evaluated reach the catch through
 * `RunCredentials`, so its own list is empty. Configuration is read from the environment alone:
 * no author default stands in for a runtime setting.
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
	const args = fn(
		"Stdio.Stdio.use",
		arrow([{ name: fixedIdentifier("stdio") }], path("stdio.args"))
	)
	return {
		imports: [
			named("effect", ["Effect", "Layer", "Stdio"]),
			named("effect/cli", ["CliOutput", "Command"]),
			named("./cli/root.ts", ["root", "services"]),
			namespace("./runtime/output.ts", "Output")
		],
		statements: [
			constant(
				"run",
				call(member(args, fixedMemberName("pipe")), [
					fn("Effect.flatMap", path("root")),
					fn(
						"Effect.flatMap",
						arrow(
							[{ name: fixedIdentifier("command") }],
							call(member(runRoot, fixedMemberName("pipe")), [fn("Effect.provide", layers)])
						)
					),
					path("Output.exitForHelp"),
					fn("Output.finalCatch", arr([]), obj([["envPrefix", str(envPrefixOf(config))]]))
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
 * carries are the one derivation) and reads each configured path whole (design 9 I5): a path
 * that cannot be read or is not a regular file (a directory, FIFO or device is never opened) is a
 * `UsageError` naming its environment variable and never the path, exit 2, rendered once by
 * `Output.finalCatch`, which reads `<PREFIX>_ERROR_FORMAT` as for a parse-time error (design 7.4).
 * Over the first configured scheme's PEM text it builds the
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
				name: fixedIdentifier("parts"),
				type: typeReadonlyArray(typeKeyword("string"))
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
	const whole = piped(
		fn("Stream.mapError", fn("fs.stream", path("path")), cannotRead),
		path("Stream.decodeText"),
		path("Stream.mkString")
	)
	const regularOnly = arrow(
		[{ name: fixedIdentifier("info") }],
		piped(
			fn("Match.value", path("info")),
			fn("Match.when", obj([["type", str("File")]]), arrow([], whole)),
			fn("Match.orElse", arrow([], fn("Effect.fail", fileNamed([str(" is not a regular file")]))))
		)
	)
	const certificateFile = arrow(
		[stringParam("name"), stringParam("path")],
		fn(
			"FileSystem.FileSystem.use",
			arrow(
				[{ name: fixedIdentifier("fs") }],
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
					arrow(
						[{ name: fixedIdentifier("ca") }],
						fn("certificateFile", path("scheme.caEnv"), path("ca"))
					)
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
		[{ name: fixedIdentifier("files") }],
		fn(
			"Option.match",
			path("files.ca"),
			obj([
				["onNone", arrow([], obj(pair))],
				["onSome", arrow([{ name: fixedIdentifier("ca") }], obj([["ca", path("ca")], ...pair]))]
			])
		)
	)
	const certificateInit = arrow(
		[
			{
				name: fixedIdentifier("scheme"),
				type: typeRef(fixedIdentifier("Auth"), [fixedMemberName("MutualTlsScheme")])
			}
		],
		piped(
			fn("Auth.clientCertificatePaths", path("scheme")),
			fn(
				"Effect.mapError",
				arrow([], fn("unreadable", arr([str("cannot read the setting "), path("scheme.certEnv")])))
			),
			fn(
				"Effect.flatMap",
				arrow(
					[{ name: fixedIdentifier("paths") }],
					fn(
						"Effect.transposeOption",
						fn(
							"Option.map",
							path("paths"),
							arrow([{ name: fixedIdentifier("configured") }], fn("Effect.all", files))
						)
					)
				)
			),
			fn("Effect.map", fn("Option.map", init))
		)
	)
	const perScheme = arrow(
		[{ name: fixedIdentifier("scheme") }],
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
			arrow([{ name: fixedIdentifier("all") }], fn("Option.firstSomeOf", path("all")))
		),
		fn(
			"Effect.flatMap",
			arrow(
				[{ name: fixedIdentifier("tls") }],
				fn(
					"Effect.transposeOption",
					fn(
						"Option.map",
						path("tls"),
						arrow(
							[{ name: fixedIdentifier("connect") }],
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
 * `bin.ts` (design 4.1, 4.3): the only emitted module that names the platform, Node. It imports
 * each platform module it uses from that module's own path, never `@effect/platform-node`'s index,
 * which loads every platform module (its Redis client's 647 modules among them) before any command
 * runs. It composes Node's services and the runtime's `Transport`: one Effect undici client per way a hop travels,
 * each over its own connection pool, which the run closes when it ends. `environment` routes a hop
 * from the platform's proxy variables (`EnvHttpProxyAgent`) and `direct` sends it straight to the
 * host, for the runtime's loopback hops (design 6.5 Loopback hosts). Neither pool follows
 * redirects; the runtime's own loop does. With a `mutualTLS` scheme whose files this run
 * configured it also builds the certified pair, whose pools present the certificate to the host and
 * never to a proxy (`clientCertificateStatements`); without one the certified pair is none. Then
 * the client policy (the `User-Agent` name and version), the run-scoped `RunCredentials` and
 * `RunRecord` (the error format and retry-hint record) outside the final catch, the runtime
 * presenter with no second formatter, the runtime's built-in flags (`Output.builtIns`: every
 * effect default but `--wizard`, help and version without `-h`/`-v`), logs to stderr and no trace
 * propagation. `runMain` reports no error: the final catch already rendered it.
 */
const binModule = (config: AuthorConfig, mutualTls: boolean): Module => {
	const pool = (constructor: string) =>
		arrow(
			[
				{
					name: fixedIdentifier("options"),
					type: typeRef(fixedIdentifier(constructor), [fixedMemberName("Options")])
				}
			],
			fn(
				"Effect.acquireRelease",
				fn("Effect.sync", arrow([], newExpr(path(constructor), [path("options")]))),
				arrow(
					[{ name: fixedIdentifier("pool") }],
					fn("Effect.promise", arrow([], fn("pool.close")))
				)
			)
		)
	const clientOver = arrow(
		[{ name: fixedIdentifier("dispatcher"), type: typeName(fixedIdentifier("Dispatcher")) }],
		fn(
			"Effect.provideService",
			path("NodeHttpClient.makeUndici"),
			path("NodeHttpClient.Dispatcher"),
			path("dispatcher")
		)
	)
	const pathClients = arrow(
		[
			{
				name: fixedIdentifier("directOptions"),
				type: typeRef(fixedIdentifier("Agent"), [fixedMemberName("Options")])
			},
			{
				name: fixedIdentifier("environmentOptions"),
				type: typeRef(fixedIdentifier("EnvHttpProxyAgent"), [fixedMemberName("Options")])
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
		fn("CliOutput.layerPresenter", path("Output.presenter")),
		fn("CliConfig.layer", obj([["builtIns", path("Output.builtIns")]])),
		fn("Layer.succeed", path("References.LogToStderr"), bool(true)),
		fn("Layer.succeed", path("HttpClient.TracerPropagationEnabled"), bool(false))
	)

	return {
		imports: [
			namespace("@effect/platform-node/NodeHttpClient", "NodeHttpClient"),
			namespace("@effect/platform-node/NodeRuntime", "NodeRuntime"),
			namespace("@effect/platform-node/NodeServices", "NodeServices"),
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
		shebang: fixedShebang("/usr/bin/env node"),
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
