/**
 * A generated CLI renders a run's error once, in the run's error format, and warns once per run.
 *
 * - Format: `--error-format`, then `<PREFIX>_ERROR_FORMAT`, then text (design 7.4). An error raised before the
 *   arguments are parsed (a missing required flag) or at start-up (an unreadable client certificate) is rendered by
 *   the variable alone: json when it says `json`, text otherwise. An error in the command (a body that is not JSON) is
 *   rendered by the flag, else the variable; a variable that is neither `text` nor `json` is itself the command's
 *   error, rendered as text. `json` is exactly one `{"error":{...}}` line naming the error's kind and no text error;
 *   text is an `Error:` line or an `ERROR` section and no JSON object. Every case exits 2 before any connection, and no
 *   message shows the invalid variable's value or the certificate's path.
 * - Warnings: a header credential sent in plaintext to a host that is not loopback warns exactly once in a run, however
 *   many attempts `--retries` makes against a `503`, each attempt carrying the credential.
 *
 * One package with a mutual-TLS scheme beside a header key. An exhaustion per error (every flag, variable and
 * invalid-variable setting) and an exhaustion of retry counts through a recording proxy.
 *
 * Under the owner's swarm gate this suite has not been run yet, nor checked against plants.
 */
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { jsonTextOf } from "@superstarter/json"
import { exhaust } from "@superstarter/testing/explore"
import { requiredInSpace } from "@superstarter/testing/features"
import { element, type Gen } from "@superstarter/testing/gen"
import { searched } from "@superstarter/testing/vitest"
import {
	Array as Arr,
	Context,
	Duration,
	Effect,
	FileSystem,
	Formatter,
	Layer,
	Option,
	Path,
	Schema,
	String as Str
} from "effect"
import {
	type CaptureServer,
	captureServer,
	type ScriptedResponse
} from "#test/support/capture-server.ts"
import {
	buildPackage,
	type BuiltPackage,
	generateFixture,
	harnessLayer,
	runBin
} from "#test/support/cli-package.ts"
import { valuesOf } from "#test/support/http.ts"
import { type RecordingProxy, recordingProxy } from "#test/support/recording-proxy.ts"
import { latin1Bytes } from "#test/support/wire.ts"

/** One POST with a required query flag and a required JSON body, behind a header key or a client certificate. */
const spec = jsonTextOf({
	openapi: "3.1.0",
	info: { title: "Run scoped", version: "1.0.0" },
	paths: {
		"/items": {
			post: {
				operationId: "items-create",
				parameters: [{ in: "query", name: "owner", required: true, schema: { type: "string" } }],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { type: "object", properties: { title: { type: "string" } } }
						}
					}
				},
				responses: { "204": { description: "Created." } },
				security: [{ headerKey: [] }, { client: [] }]
			}
		}
	},
	components: {
		securitySchemes: {
			headerKey: { type: "apiKey", in: "header", name: "X-Key" },
			client: { type: "mutualTLS" }
		}
	}
})

/** The author config, binding the capture server's origin. */
const configOf = (bound: string): string =>
	jsonTextOf({
		package: { name: "run-scoped", version: "1.0.0" },
		binName: "runs",
		envPrefix: "RUNS",
		acceptedOrigins: [bound],
		allowInsecure: true
	})

/** The header key every run carries. */
const KEY = "run-scoped-key"

/** A value of `RUNS_ERROR_FORMAT` that is neither `text` nor `json`, which no message may show. */
const INVALID_FORMAT = "zq-format"

/** The file name of the missing certificate, which no message may show. */
const MISSING_CERTIFICATE = "zq-missing.pem"

/** An error a run raises, by where it is raised. */
type Fault = "a body that is not JSON" | "a missing required flag" | "an unreadable certificate"

/** What sets a run's error format: the flag's choice, the variable's value, or neither. */
type Setting = Readonly<{
	flag: Option.Option<"text" | "json">
	variable: Option.Option<"text" | "json" | "invalid">
}>

/** One run of an exhaustion: its error and its format setting. */
type Case = Readonly<{ fault: Fault; setting: Setting }>

/** Whether an error is raised before the command runs, where only the variable decides the format. */
const beforeTheCommand = (fault: Fault): boolean => fault !== "a body that is not JSON"

/** The format the run's error renders in, by the rules the header states. */
const formatOf = (c: Case): "json" | "text" => {
	const variableSays = Option.contains(c.setting.variable, "json") ? "json" : "text"
	if (beforeTheCommand(c.fault)) {
		return variableSays
	}
	return Option.getOrElse(c.setting.flag, () => variableSays)
}

/** The kind a JSON rendering names. */
const KINDS: Readonly<Record<Fault, string>> = {
	"a body that is not JSON": "UsageError",
	"a missing required flag": "MissingOption",
	"an unreadable certificate": "UsageError"
}

/** How stderr rendered the error: the kind of each JSON error line, and whether any text error line appeared. */
type Rendered = Readonly<{ jsonKinds: ReadonlyArray<string>; text: boolean }>

/** What the oracle compares of an error run. */
type ErrorOutcome = Readonly<{
	exitCode: number
	connections: number
	rendered: Rendered
	showsSecret: boolean
}>

const expectedError = (c: Case): ErrorOutcome => ({
	exitCode: 2,
	connections: 0,
	rendered:
		formatOf(c) === "json"
			? { jsonKinds: [KINDS[c.fault]], text: false }
			: { jsonKinds: [], text: true },
	showsSecret: false
})

const ErrorLine = Schema.fromJsonString(
	Schema.Struct({ error: Schema.Struct({ kind: Schema.String }) })
)

const decodeErrorLine = Schema.decodeUnknownOption(ErrorLine)

/** How stderr rendered the error: each line that is one `{"error":{...}}` object, and any `Error:` or `ERROR` line. */
const renderedOf = (stderr: string): Rendered => {
	const lines = Str.split("\n")(stderr)
	return {
		jsonKinds: Arr.flatMap(lines, (line) =>
			Option.toArray(Option.map(decodeErrorLine(line), (decoded) => decoded.error.kind))
		),
		text: Arr.some(lines, (line) => Str.startsWith("Error:")(line) || line === "ERROR")
	}
}

/** The arguments a fault's run gives after the command and the base. */
const faultArgs = (fault: Fault): ReadonlyArray<string> => {
	switch (fault) {
		case "a body that is not JSON":
			return ["--owner", "o", "--body", "{"]
		case "a missing required flag":
			return ["--body", "{}"]
		case "an unreadable certificate":
			return ["--owner", "o", "--body", "{}"]
	}
}

/** A situation an error exhaustion reaches. */
type FormatFeature =
	| "rendered as json"
	| "rendered as text"
	| "the flag set"
	| "the variable set"
	| "an invalid variable"

const caseFeatures = (c: Case): ReadonlyArray<FormatFeature> =>
	Arr.flatten<ReadonlyArray<ReadonlyArray<FormatFeature>>>([
		[formatOf(c) === "json" ? "rendered as json" : "rendered as text"],
		Option.isSome(c.setting.flag) ? ["the flag set"] : [],
		Option.isSome(c.setting.variable) ? ["the variable set"] : [],
		Option.contains(c.setting.variable, "invalid") ? ["an invalid variable"] : []
	])

/** Every format setting: the flag absent, text or json, and the variable absent, text, json or invalid. */
const settingOf: Gen<Setting> = (source) => ({
	flag: element<Option.Option<"text" | "json">>([
		Option.none(),
		Option.some("text"),
		Option.some("json")
	])(source),
	variable: element<Option.Option<"text" | "json" | "invalid">>([
		Option.none(),
		Option.some("text"),
		Option.some("json"),
		Option.some("invalid")
	])(source)
})

/** An empty `204`. */
const done: ScriptedResponse = {
	status: 204,
	headers: [],
	delay: Duration.zero,
	body: { kind: "complete", bytes: new Uint8Array(0) }
}

/** A `503` that asks to be retried at once. */
const busy: ScriptedResponse = {
	status: 503,
	headers: [["Retry-After", "0"]],
	delay: Duration.zero,
	body: { kind: "complete", bytes: latin1Bytes("busy") }
}

/** The host a plaintext base names, which only the proxy reaches. */
const PLAIN_HOST = "plain.test"

/** The suite's fixture: the capture server, a proxy that reaches it as `PLAIN_HOST`, the package, and its command. */
class RunFixture extends Context.Service<
	RunFixture,
	Readonly<{
		server: CaptureServer
		proxy: RecordingProxy
		plainBase: string
		built: BuiltPackage
		command: ReadonlyArray<string>
	}>
>()("effect-openapi-cli-generator/test/generated/run-scoped.test/RunFixture") {}

const fixture = Layer.effect(
	RunFixture,
	Effect.gen(function* () {
		const server = yield* captureServer
		const port = Number(new URL(server.origins["127.0.0.1"]).port)
		const authority = `${PLAIN_HOST}:${String(port)}`
		const proxy = yield* recordingProxy({ [authority]: { host: "127.0.0.1", port } })
		const generated = yield* generateFixture({
			spec: { path: "openapi.json", text: spec },
			config: { path: "author-config.json", text: configOf(server.origins["127.0.0.1"]) },
			authorFiles: []
		})
		const built = yield* buildPackage(generated)
		const name = yield* Effect.fromOption(
			Arr.findFirst(
				generated.result.report.commandNames,
				(entry) => entry.pointer === "/paths/~1items/post"
			)
		)
		return { server, proxy, plainBase: `http://${authority}`, built, command: name.path }
	})
).pipe(Layer.provideMerge(harnessLayer))

/** Checks every format setting against one error. */
const exhaustFault = (fault: Fault) =>
	Effect.gen(function* () {
		const { server, built, command } = yield* RunFixture
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "run-scoped-" })
		const certificate = path.join(scratch, MISSING_CERTIFICATE)
		return yield* exhaust(
			{
				suite: `run-scoped errors: ${fault}`,
				generator: (source): Case => ({ fault, setting: settingOf(source) }),
				literal: Formatter.format,
				limit: 12,
				coverage: requiredInSpace<FormatFeature>([
					"rendered as json",
					"rendered as text",
					"the flag set",
					"the variable set",
					"an invalid variable"
				]),
				caseHang: Duration.seconds(60)
			},
			(c, k) =>
				Effect.gen(function* () {
					k.noteAll(caseFeatures(c))
					const observed = yield* server.observe(
						() => done,
						runBin(built, {
							args: Arr.flatten([
								command,
								["--base-url", server.origins["127.0.0.1"]],
								Option.match(c.setting.flag, {
									onNone: () => [],
									onSome: (format) => ["--error-format", format]
								}),
								faultArgs(c.fault)
							]),
							env: {
								RUNS_HEADER_KEY: KEY,
								...Option.match(c.setting.variable, {
									onNone: () => ({}),
									onSome: (variable) => ({
										RUNS_ERROR_FORMAT: variable === "invalid" ? INVALID_FORMAT : variable
									})
								}),
								...(c.fault === "an unreadable certificate"
									? { RUNS_CLIENT_CERT: certificate, RUNS_CLIENT_KEY: certificate }
									: {})
							},
							stdin: new Uint8Array(0)
						})
					)
					const stderr = Buffer.from(observed.result.stderr).toString("utf8")
					deepStrictEqual<ErrorOutcome>(
						{
							exitCode: observed.result.exitCode,
							connections: observed.connections.length,
							rendered: renderedOf(stderr),
							showsSecret:
								Str.includes(INVALID_FORMAT)(stderr) || Str.includes(MISSING_CERTIFICATE)(stderr)
						},
						expectedError(c),
						"the error renders once in the run's format, before any connection, showing no secret"
					)
				})
		)
	}).pipe(Effect.scoped)

/** A retry count a warning run makes. */
type Retries = 0 | 1 | 2

/** A situation a warning run reaches. */
type RetryFeature = "no retry" | "one retry" | "two retries"

const RETRY_FEATURES: Readonly<Record<Retries, RetryFeature>> = {
	0: "no retry",
	1: "one retry",
	2: "two retries"
}

/** What the oracle compares of a warning run: its exit code, each attempt's header key, and each warning line. */
type WarningOutcome = Readonly<{
	exitCode: number
	keys: ReadonlyArray<ReadonlyArray<string>>
	warningsNamingTheHost: ReadonlyArray<boolean>
}>

/** The warning run the rules give: every attempt answered `503` and carrying the key, one warning naming the host. */
const expectedWarning = (retries: Retries): WarningOutcome => ({
	exitCode: 1,
	keys: Arr.replicate([KEY], retries + 1),
	warningsNamingTheHost: [true]
})

layer(fixture, { excludeTestServices: true })("a generated CLI's run-scoped rendering", (it) => {
	it.effect("renders a missing required flag by the variable alone", (ctx) =>
		searched(ctx, exhaustFault("a missing required flag"))
	)

	it.effect("renders an unreadable certificate by the variable alone", (ctx) =>
		searched(ctx, exhaustFault("an unreadable certificate"))
	)

	it.effect("renders a command's error by the flag, then the variable", (ctx) =>
		searched(ctx, exhaustFault("a body that is not JSON"))
	)

	it.effect("warns once in a run however many attempts it makes", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { server, proxy, plainBase, built, command } = yield* RunFixture
				return yield* exhaust(
					{
						suite: "run-scoped warnings",
						generator: element<Retries>([0, 1, 2]),
						literal: Formatter.format,
						limit: 3,
						coverage: requiredInSpace<RetryFeature>(["no retry", "one retry", "two retries"]),
						caseHang: Duration.seconds(60)
					},
					(retries, k) =>
						Effect.gen(function* () {
							k.note(RETRY_FEATURES[retries])
							const observed = yield* proxy.observe(
								server.observe(
									() => busy,
									runBin(built, {
										args: Arr.flatten([
											command,
											[
												"--base-url",
												plainBase,
												"--allow-credentials-for-base-url",
												"--retry-unsafe",
												"--retries",
												String(retries),
												"--owner",
												"o",
												"--body",
												"{}"
											]
										]),
										env: { RUNS_HEADER_KEY: KEY, HTTP_PROXY: proxy.url },
										stdin: new Uint8Array(0)
									})
								)
							)
							const stderr = Buffer.from(observed.result.result.stderr).toString("utf8")
							deepStrictEqual<WarningOutcome>(
								{
									exitCode: observed.result.result.exitCode,
									keys: Arr.map(observed.result.requests, (request) =>
										valuesOf(request.headers, "x-key")
									),
									warningsNamingTheHost: Arr.map(
										Arr.filter(Str.split("\n")(stderr), Str.startsWith("Warning:")),
										Str.includes(PLAIN_HOST)
									)
								},
								expectedWarning(retries),
								"one warning per run, each attempt carrying the key"
							)
						})
				)
			})
		)
	)
})
