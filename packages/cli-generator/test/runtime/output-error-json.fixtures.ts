/**
 * What output-error-json.test.ts's property exhausts: every invocation of a CLI in the generated entry's shape under
 * every error-format setting, what each run prints, and what design 7.4 says it prints.
 */

import { jsonText, utf8Text } from "@bjornpagen/grizzle-text/utf8"
import { defined } from "@bjornpagen/testing/assert"
import { element, finite, type FiniteSpace, type Gen } from "@bjornpagen/testing/gen"
import {
	Array as Arr,
	Cause,
	ConfigProvider,
	Console,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	Order,
	Record,
	Runtime,
	Sink,
	Stdio
} from "effect"
import { CliConfig, CliError, CliOutput, Command, Flag } from "effect/cli"
import { HttpClient, HttpClientResponse } from "effect/http"
import { UsageError } from "#runtime-src/domain/errors.ts"
import * as Auth from "#runtime-src/runtime/auth.ts"
import * as BaseUrl from "#runtime-src/runtime/base-url.ts"
import { Transport } from "#runtime-src/runtime/client.ts"
import * as Input from "#runtime-src/runtime/input.ts"
import * as Output from "#runtime-src/runtime/output.ts"
import { runCredentialsLayer } from "#runtime-src/runtime/redact.ts"
import * as Serialize from "#runtime-src/runtime/serialize.ts"
import { workerFixture } from "#test/support/cli-package.ts"
import { recordingConsole } from "#test/support/console.ts"

/** The environment prefix the CLI reads its settings under, as the generated entry passes it to recordRun and finalCatch. */
const PREFIX = "EXAMPLE"

/** A value given `--port` that the CLI refuses, which no stream may show. */
const REFUSED_PORT = "CANARY-PORT"

/** A value of `EXAMPLE_ERROR_FORMAT` that is neither `text` nor `json`, which no stream may show. */
const INVALID_FORMAT = "yaml-VALUE"

/** The methods the handler sends: three D-AD7 retries without an Idempotency-Key, and two it retries only with one. */
type Method = "GET" | "PUT" | "DELETE" | "POST" | "PATCH"

const METHODS: Arr.NonEmptyReadonlyArray<Method> = ["GET", "PUT", "DELETE", "POST", "PATCH"]

/** The methods D-AD7 retries without an Idempotency-Key. */
const IDEMPOTENT: ReadonlyArray<Method> = ["GET", "PUT", "DELETE"]

/** The request the handler sends, which the server answers `404`: its method, and whether an Idempotency-Key rides it. */
type Sent = Readonly<{ method: Method; idempotencyKey: boolean }>

/**
 * What the parser decides before the command runs: a flag `act` does not know, a value `--port` refuses, or the root
 * run with no subcommand.
 */
type Parsed = "an unknown flag" | "a refused value" | "no subcommand"

const PARSED: Arr.NonEmptyReadonlyArray<Parsed> = [
	"an unknown flag",
	"a refused value",
	"no subcommand"
]

/** What the command's handler does once it runs: fail with a usage error, or send a request the server answers `404`. */
type Step = Readonly<{ kind: "a usage error" }> | Readonly<{ kind: "a 404"; sent: Sent }>

/** How the CLI is invoked: decided by the parser, or run by the command. */
export type Invocation =
	| Readonly<{ kind: "parsed"; parsed: Parsed }>
	| Readonly<{ kind: "run"; step: Step }>

/** What sets the run's error format: `--error-format`'s choice and `EXAMPLE_ERROR_FORMAT`'s value, each or neither. */
type Setting = Readonly<{
	flag: Option.Option<Output.ErrorFormat>
	variable: Option.Option<Output.ErrorFormat | "invalid">
}>

/** One run of the exhaustion: how the CLI is invoked, under which setting. */
export type Run = Readonly<{ invocation: Invocation; setting: Setting }>

const FLAGS: Arr.NonEmptyReadonlyArray<Setting["flag"]> = [
	Option.none(),
	Option.some("text"),
	Option.some("json")
]

const VARIABLES: Arr.NonEmptyReadonlyArray<Setting["variable"]> = [
	Option.none(),
	Option.some("text"),
	Option.some("json"),
	Option.some("invalid")
]

const steps: Gen<Step> = (source) =>
	source.draw(element<Step["kind"]>(["a usage error", "a 404"])) === "a usage error"
		? { kind: "a usage error" }
		: {
				kind: "a 404",
				sent: {
					method: source.draw(element(METHODS)),
					idempotencyKey: source.draw(element([false, true]))
				}
			}

const invocations: Gen<Invocation> = (source) =>
	source.draw(element<Invocation["kind"]>(["parsed", "run"])) === "parsed"
		? { kind: "parsed", parsed: source.draw(element(PARSED)) }
		: { kind: "run", step: source.draw(steps) }

/** Every invocation, a 404 after each method with and without an Idempotency-Key, under every flag and variable. */
export const runs: FiniteSpace<Run> = finite((source) => ({
	invocation: source.draw(invocations),
	setting: { flag: source.draw(element(FLAGS)), variable: source.draw(element(VARIABLES)) }
}))

/** What a run printed on each stream, and the code it exits with. */
export type Ran = Readonly<{ exitCode: number; stdout: string; stderr: string }>

const servers: BaseUrl.ServersTable = {
	boundOrigins: ["https://api.example.com"],
	defaultServer: 0,
	servers: [{ url: "https://api.example.com", variables: {} }]
}

/** The server: every request it receives is answered `404` with the body `missing`. */
const missing = HttpClient.make((request) =>
	Effect.succeed(HttpClientResponse.fromWeb(request, new Response("missing", { status: 404 })))
)

const metaOf = (method: Method): Output.OperationMeta => ({
	media: { request: [], responses: { "200": [], "404": [] } },
	method,
	operationId: "users-act",
	pathTemplate: "/users",
	security: []
})

/** The handler's step: a usage error, or the request sent through `send`. */
const actionOf = (step: Step) =>
	step.kind === "a 404"
		? Serialize.request(step.sent.method, {
				headers: step.sent.idempotencyKey
					? [Serialize.header("Idempotency-Key", "k-1", { explode: false, required: false })]
					: [],
				path: Serialize.path("/users", []),
				query: []
			}).pipe(Effect.flatMap(Output.send(metaOf(step.sent.method), Option.none())))
		: Effect.fail(new UsageError({ message: "invalid body" }))

/**
 * The CLI, as the generator emits one: a root registering `--error-format` with one command, `act`, whose run records the
 * error format before its handler runs (recordRun), its handler the step, or, for a run the parser decides, a defect,
 * since no such run reaches a handler.
 */
const cliOf = (step: Option.Option<Step>) =>
	Command.make("example").pipe(
		Command.withSubcommands([
			Command.make("act", { port: Flag.Int("port") }, () =>
				Option.match(step, {
					onNone: () => Effect.die("a run the parser decides reached the handler"),
					onSome: actionOf
				})
			).pipe(Command.provideEffectDiscard(Output.recordRun(PREFIX)))
		]),
		Command.withGlobalFlags([Output.errorFormatSetting])
	)

/**
 * Runs the CLI over `args` as the generated entry runs it (bin.ts and main.ts): `renderErrors: false`, the root's
 * formatter, the runtime's presenter and built-in flags, a fresh run record and run credentials outside `finalCatch`,
 * `exitForHelp` inside it, and the configuration read from `env` alone. stdout and stderr are recorded whether the
 * Console or Stdio wrote them; the file system is a no-op, since no run reads a file.
 */
const ranIn = (
	step: Option.Option<Step>,
	args: ReadonlyArray<string>,
	env: Readonly<Record<string, string>>
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const stdout: Array<string> = []
			const stderr: Array<string> = []
			const capture = (into: Array<string>) => () =>
				Sink.forEachArray((chunks: ReadonlyArray<string | Uint8Array>) =>
					Effect.sync(() => {
						for (const chunk of chunks) {
							into.push(
								typeof chunk === "string"
									? chunk
									: defined(utf8Text(chunk), "a run writes its streams in UTF-8")
							)
						}
					})
				)
			const cli = cliOf(step)
			const context = yield* Layer.build(
				Layer.mergeAll(
					BaseUrl.layer(servers, PREFIX),
					Auth.layer({ schemes: {} }, PREFIX, []),
					Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({})),
					Input.stdinClaimLayer,
					Layer.succeed(Transport, {
						certified: Option.none(),
						plain: { direct: missing, environment: missing }
					}),
					Layer.succeed(Output.ClientPolicy, { binName: "example", version: "1.2.3" }),
					Layer.succeed(Output.OutputPath, Option.none()),
					Layer.succeed(Output.Force, false),
					Layer.succeed(BaseUrl.baseUrlSetting, Option.none()),
					Layer.succeed(BaseUrl.serverSetting, Option.none()),
					Layer.succeed(BaseUrl.serverVariableSetting, []),
					Layer.succeed(Auth.allowCredentialsForBaseUrl, false),
					Stdio.layerTest({ stderr: capture(stderr), stdout: capture(stdout) }),
					runCredentialsLayer,
					Output.runRecordLayer,
					ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)),
					CliOutput.layer(Output.formatter(cli)),
					CliOutput.layerPresenter(Output.presenter),
					CliConfig.layer({ builtIns: Output.builtIns })
				)
			)
			const exit = yield* Command.runWith(cli, { renderErrors: false, version: "1.2.3" })(
				args
			).pipe(
				Output.exitForHelp,
				Output.finalCatch([], { envPrefix: PREFIX }),
				Effect.provideContext(context),
				Effect.provideService(
					Console.Console,
					recordingConsole({ log: stdout, error: stderr }, "\n")
				),
				Effect.exit
			)
			const ran: Ran = {
				exitCode: Exit.isSuccess(exit) ? 0 : Runtime.getErrorExitCode(Cause.squash(exit.cause)),
				stdout: Arr.join(stdout, ""),
				stderr: Arr.join(stderr, "")
			}
			return ran
		})
	)

const parsedArgs = (parsed: Parsed): ReadonlyArray<string> => {
	switch (parsed) {
		case "an unknown flag":
			return ["act", "--port", "1", "--bogus"]
		case "a refused value":
			return ["act", "--port", REFUSED_PORT]
		case "no subcommand":
			return []
	}
}

const envOf = (setting: Setting): Readonly<Record<string, string>> =>
	Option.match(setting.variable, {
		onNone: () => ({}),
		onSome: (variable) => ({
			EXAMPLE_ERROR_FORMAT: variable === "invalid" ? INVALID_FORMAT : variable
		})
	})

/** What the run printed and its exit: `--error-format` first when the setting gives it, then the invocation. */
export const ranOf = (run: Run) => {
	const flag = Option.match(run.setting.flag, {
		onNone: (): ReadonlyArray<string> => [],
		onSome: (format) => ["--error-format", format]
	})
	const env = envOf(run.setting)
	return run.invocation.kind === "parsed"
		? ranIn(Option.none(), [...flag, ...parsedArgs(run.invocation.parsed)], env)
		: ranIn(Option.some(run.invocation.step), [...flag, "act", "--port", "1"], env)
}

/** The help each command prints when asked: the root's and `act`'s. */
export type Asked = Readonly<{ root: string; act: string }>

/** The help each command prints on stdout when asked, read once a worker: what a run that holds help prints. */
export const askedHelp = workerFixture(
	"test/runtime/output-error-json.fixtures.ts askedHelp",
	Effect.gen(function* () {
		const root = yield* ranIn(Option.none(), ["--help"], {})
		const act = yield* ranIn(Option.none(), ["act", "--help"], {})
		const asked: Asked = { root: root.stdout, act: act.stdout }
		return asked
	})
)

const RETRY_HINT = "The request is idempotent, so running the command again is safe."

const byKey = Order.mapInput(Order.String, ([key]: readonly [string, string | number]) => key)

/** The one `{"error":{...}}` line design 7.4 prints: each field a member written by the JSON door, keys alphabetical. */
const errorLine = (fields: Readonly<Record<string, string | number>>): string =>
	`{"error":{${Arr.join(
		Arr.map(
			Arr.sort(Record.toEntries(fields), byKey),
			([key, value]) => `${jsonText(key)}:${jsonText(value)}`
		),
		","
	)}}}\n`

/** The format an error the parser decides renders in: json when the variable says json, text otherwise. */
const parsedFormat = (setting: Setting): Output.ErrorFormat =>
	Option.contains(setting.variable, "json") ? "json" : "text"

/**
 * The format recordRun records before the handler runs: the flag's, else the variable's, else text; none when, with no
 * flag, the variable it reads is neither `text` nor `json`.
 */
const recordedFormat = (setting: Setting): Option.Option<Output.ErrorFormat> =>
	Option.match(setting.flag, {
		onSome: (format) => Option.some(format),
		onNone: () =>
			Option.match(setting.variable, {
				onNone: () => Option.some("text" as const),
				onSome: (variable) => (variable === "invalid" ? Option.none() : Option.some(variable))
			})
	})

/**
 * A parse error of `act`'s: as json, its object alone, the help held for it dropped; as text, `act`'s help, then its
 * message under ERROR. Exit 2.
 */
const parseError = (setting: Setting, asked: Asked, kind: string, message: string): Ran => ({
	exitCode: 2,
	stdout: "",
	stderr:
		parsedFormat(setting) === "json"
			? errorLine({ kind, message })
			: `${asked.act}\nERROR\n  ${message}\n`
})

/** What a run the parser decides prints. */
const parsedRan = (parsed: Parsed, setting: Setting, asked: Asked): Ran => {
	switch (parsed) {
		case "an unknown flag":
			return parseError(
				setting,
				asked,
				"UnrecognizedOption",
				CliError.UnrecognizedOption.make({
					option: "--bogus",
					command: ["example", "act"],
					suggestions: []
				}).message
			)
		case "a refused value":
			return parseError(
				setting,
				asked,
				"InvalidValue",
				"Invalid value for flag --port. Run with --help for usage."
			)
		case "no subcommand":
			return { exitCode: 0, stdout: "", stderr: asked.root }
	}
}

/** Whether D-AD7 would retry the request `send` recorded: an idempotent method, or any with an Idempotency-Key. */
const hinted = (sent: Sent): boolean => sent.idempotencyKey || Arr.contains(IDEMPOTENT, sent.method)

/** What the step's error prints in the format the run recorded. */
const stepRan = (step: Step, format: Output.ErrorFormat): Ran => {
	switch (step.kind) {
		case "a usage error":
			return {
				exitCode: 2,
				stdout: "",
				stderr:
					format === "json"
						? errorLine({ kind: "UsageError", message: "invalid body" })
						: "Error: invalid body\n"
			}
		case "a 404": {
			const message = "users-act returned 404 (matched 404)"
			const hint = hinted(step.sent)
			return {
				exitCode: 1,
				stdout: "",
				stderr:
					format === "json"
						? errorLine({
								body: "missing",
								kind: "ApiResponseError",
								matched: "404",
								message: hint ? `${message}. ${RETRY_HINT}` : message,
								operation: "users-act",
								status: 404
							})
						: `Error: ${message}\n${hint ? `${RETRY_HINT}\n` : ""}missing\n`
			}
		}
	}
}

/**
 * What design 7.4 says a run prints, given the help each command prints when asked.
 *
 * - The parser decides an unknown flag, a refused value and a missing subcommand before the command runs, so nothing
 *   is recorded and the variable alone decides the format: json when it says `json`, text otherwise. A parse error
 *   prints its object alone (the help the presenter held is dropped) or, as text, the help then the error, never the
 *   refused value, and exits 2; the message is the parse error's own, the runtime's value-free one for a refused value.
 *   The root with no subcommand prints its help on stderr whatever the format, and exits 0.
 * - In the command, recordRun records `--error-format`, else the variable, else text, before the handler runs. A
 *   variable that is neither `text` nor `json`, with no flag, is the command's error: a usage error naming the
 *   variable, never its value, rendered as text, since nothing was recorded. A usage error exits 2; a `404` exits 1,
 *   its body printed, and its message carries the retry hint (as a second sentence in json, its own line in text) when
 *   D-AD7 would retry the request `send` recorded.
 */
export const expectedOf = (run: Run, asked: Asked): Ran => {
	const { invocation, setting } = run
	if (invocation.kind === "parsed") {
		return parsedRan(invocation.parsed, setting, asked)
	}
	return Option.match(recordedFormat(setting), {
		onNone: () => ({
			exitCode: 2,
			stdout: "",
			stderr: "Error: EXAMPLE_ERROR_FORMAT must be text or json\n"
		}),
		onSome: (format) => stepRan(invocation.step, format)
	})
}

/** A situation the exhaustion reaches. */
export type RunFeature =
	| "a parse error as json"
	| "a parse error as text"
	| "no subcommand under json"
	| "an error in the command as json"
	| "an error in the command as text"
	| "the flag over the variable"
	| "an invalid variable"
	| "a retry hint after an idempotent method"
	| "a retry hint after an Idempotency-Key"
	| "no retry hint"

export const RUN_FEATURES: Arr.NonEmptyReadonlyArray<RunFeature> = [
	"a parse error as json",
	"a parse error as text",
	"no subcommand under json",
	"an error in the command as json",
	"an error in the command as text",
	"the flag over the variable",
	"an invalid variable",
	"a retry hint after an idempotent method",
	"a retry hint after an Idempotency-Key",
	"no retry hint"
]

const parsedFeatures = (parsed: Parsed, setting: Setting): ReadonlyArray<RunFeature> => {
	const format = parsedFormat(setting)
	if (parsed === "no subcommand") {
		return format === "json" ? ["no subcommand under json"] : []
	}
	return [format === "json" ? "a parse error as json" : "a parse error as text"]
}

const sentFeatures = (sent: Sent): ReadonlyArray<RunFeature> => {
	if (Arr.contains(IDEMPOTENT, sent.method)) {
		return ["a retry hint after an idempotent method"]
	}
	return [sent.idempotencyKey ? "a retry hint after an Idempotency-Key" : "no retry hint"]
}

const stepFeatures = (step: Step, setting: Setting): ReadonlyArray<RunFeature> =>
	Option.match(recordedFormat(setting), {
		onNone: () => ["an invalid variable"],
		onSome: (format) => [
			format === "json" ? "an error in the command as json" : "an error in the command as text",
			...(Option.isSome(setting.flag) &&
			Option.isSome(setting.variable) &&
			!Option.contains(setting.variable, setting.flag.value)
				? (["the flag over the variable"] as const)
				: []),
			...(step.kind === "a 404" ? sentFeatures(step.sent) : [])
		]
	})

/** The situations a run reaches. */
export const runFeatures = (run: Run): ReadonlyArray<RunFeature> =>
	run.invocation.kind === "parsed"
		? parsedFeatures(run.invocation.parsed, run.setting)
		: stepFeatures(run.invocation.step, run.setting)
