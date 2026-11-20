import { jsonText } from "@bjornpagen/grizzle-text/utf8"
import { element, finite, type FiniteSpace, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Duration, Effect, Option, String as Str } from "effect"
import {
	type CaptureServer,
	captureServer,
	type ScriptedResponse
} from "#test/support/capture-server.ts"
import {
	buildPackage,
	type BuiltPackage,
	generateFixture,
	workerFixture
} from "#test/support/cli-package.ts"
import { errorLineOf } from "#test/support/printed.ts"
import { type RecordingProxy, recordingProxy } from "#test/support/recording-proxy.ts"
import { latin1Bytes } from "#test/support/wire.ts"

/** What the run-scoped properties (run-scoped.test.ts) exhaust and their fixture: each error and each retry count. */

/** One POST with a required query flag and a required JSON body, behind a header key or a client certificate. */
const spec = jsonText({
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
	jsonText({
		package: { name: "run-scoped", version: "1.0.0" },
		binName: "runs",
		envPrefix: "RUNS",
		acceptedOrigins: [bound],
		allowInsecure: true
	})

/** The header key every run carries. */
export const KEY = "run-scoped-key"

/** A value of `RUNS_ERROR_FORMAT` that is neither `text` nor `json`, which no message may show. */
export const INVALID_FORMAT = "zq-format"

/** The file name of the missing certificate, which no message may show. */
export const MISSING_CERTIFICATE = "zq-missing.pem"

/** An error a run raises, by where it is raised. */
export type Fault =
	| "a body that is not JSON"
	| "a missing required flag"
	| "an unreadable certificate"

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
export type ErrorOutcome = Readonly<{
	exitCode: number
	connections: number
	rendered: Rendered
	showsSecret: boolean
}>

export const expectedError = (c: Case): ErrorOutcome => ({
	exitCode: 2,
	connections: 0,
	rendered:
		formatOf(c) === "json"
			? { jsonKinds: [KINDS[c.fault]], text: false }
			: { jsonKinds: [], text: true },
	showsSecret: false
})

/** How stderr rendered the error: each line that is one `{"error":{...}}` object, and any `Error:` or `ERROR` line. */
export const renderedOf = (stderr: string): Rendered => {
	const lines = Str.split("\n")(stderr)
	return {
		jsonKinds: Arr.flatMap(lines, (line) =>
			Option.toArray(Option.map(errorLineOf(line), (error) => error.kind))
		),
		text: Arr.some(lines, (line) => Str.startsWith("Error:")(line) || line === "ERROR")
	}
}

/** The arguments a fault's run gives after the command and the base. */
export const faultArgs = (fault: Fault): ReadonlyArray<string> => {
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
export type FormatFeature =
	| "rendered as json"
	| "rendered as text"
	| "the flag set"
	| "the variable set"
	| "an invalid variable"

export const caseFeatures = (c: Case): ReadonlyArray<FormatFeature> =>
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
export const done: ScriptedResponse = {
	status: 204,
	headers: [],
	delay: Duration.zero,
	body: { kind: "complete", bytes: new Uint8Array(0) }
}

/** A `503` that asks to be retried at once. */
export const busy: ScriptedResponse = {
	status: 503,
	headers: [["Retry-After", "0"]],
	delay: Duration.zero,
	body: { kind: "complete", bytes: latin1Bytes("busy") }
}

/** The host a plaintext base names, which only the proxy reaches. */
export const PLAIN_HOST = "plain.test"

/**
 * The suite's fixture, once per worker: the capture server, a proxy that reaches it as `PLAIN_HOST`, the package, and
 * its command.
 */
export const runFixture = workerFixture(
	"test/generated/run-scoped.fixtures.ts runFixture",
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
		const opened: Readonly<{
			server: CaptureServer
			proxy: RecordingProxy
			plainBase: string
			built: BuiltPackage
			command: ReadonlyArray<string>
		}> = { server, proxy, plainBase: `http://${authority}`, built, command: name.path }
		return opened
	})
)

/** A situation a warning run reaches, by its count of retries. */
export type RetryFeature = "no retry" | "one retry" | "two retries"

/** Each count of retries' situation, by the count. */
export const RETRY_FEATURES: Arr.NonEmptyReadonlyArray<RetryFeature> = [
	"no retry",
	"one retry",
	"two retries"
]

/** What the oracle compares of a warning run: its exit code, each attempt's header key, and each warning line. */
export type WarningOutcome = Readonly<{
	exitCode: number
	keys: ReadonlyArray<ReadonlyArray<string>>
	warningsNamingTheHost: ReadonlyArray<boolean>
}>

/** The warning run the rules give: every attempt answered `503` and carrying the key, one warning naming the host. */
export const expectedWarning = (retries: number): WarningOutcome => ({
	exitCode: 1,
	keys: Array.from({ length: retries + 1 }, () => [KEY]),
	warningsNamingTheHost: [true]
})

/** The errors a run raises, one each: in the command, before the arguments are parsed, and at start-up. */
const FAULTS: Arr.NonEmptyReadonlyArray<Fault> = [
	"a body that is not JSON",
	"a missing required flag",
	"an unreadable certificate"
]

/** Every error with every format setting. */
export const errorCases: FiniteSpace<Case> = finite((source) => ({
	fault: source.draw(element(FAULTS)),
	setting: source.draw(settingOf)
}))

/** 0, 1 and 2 retries. */
export const retryCounts: FiniteSpace<number> = finite(int(0, 2))
