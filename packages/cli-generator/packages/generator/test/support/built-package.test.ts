/**
 * A built generated CLI never fails as a defect: whatever argv it is given, it exits with a code its contract documents
 * (0 success, 1 a non-2xx answer, 2 a usage error, 3 a credential refusal, 4 a transport or redirect failure, 5 a body
 * failure) and never with 70, an internal error, nor by a signal; and it exits the same way twice.
 *
 * - Invocations: mostly the update operation's command with an id and well-formed fields, body, timeout, error format
 *   and switches, so most runs send a request; otherwise any of the package's command paths, from the generation
 *   report, with flags and values of any shape and words it does not know, the deliberate faults; each with or without
 *   a bearer token, against the capture server as its base, which answers every request with a status and body bytes
 *   drawn per case. The package is generated and built once through cli-package.ts, as every generated-CLI suite
 *   builds its own. Oracles: never-crashes, and determinism: a second run of the same invocation exits with the same
 *   code and prints the same bytes.
 *
 * Plants (local only, reverted): errors.ts UsageError's exit code set to 70.
 */
import { layer } from "@effect/vitest"
import { deepStrictEqual, notDeepStrictEqual } from "@effect/vitest/utils"
import { drawn, explore } from "@superstarter/testing/explore"
import { required } from "@superstarter/testing/features"
import {
	array,
	bytes,
	characterOf,
	element,
	type Gen,
	oneOf,
	option,
	string,
	weighted
} from "@superstarter/testing/gen"
import { notesOnly } from "@superstarter/testing/sense"
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
	Path
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

/** The command module the golden author config names, which the API author owns: one `login` command. */
const AUTHOR_COMMANDS = `import { Command } from "effect/cli";\n\nexport const login = Command.make("login");\n`

/** The golden package's commands: the update operation's path, and every command path it has. */
type Commands = Readonly<{
	update: ReadonlyArray<string>
	all: Arr.NonEmptyReadonlyArray<ReadonlyArray<string>>
}>

/** The suite's fixture: the capture server and the golden package, built, with its command paths. */
class GoldenFixture extends Context.Service<
	GoldenFixture,
	Readonly<{ server: CaptureServer; built: BuiltPackage; commands: Commands }>
>()("effect-openapi-cli-generator/test/support/built-package.test/GoldenFixture") {}

const fixture = Layer.effect(
	GoldenFixture,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const golden = path.join(import.meta.dirname, "../fixtures/golden/users-update")
		const spec = yield* fs.readFileString(path.join(golden, "openapi.json"))
		const config = yield* fs.readFileString(path.join(golden, "author-config.json"))
		const server = yield* captureServer
		const generated = yield* generateFixture({
			spec: { path: "openapi.json", text: spec },
			config: { path: "author-config.json", text: config },
			authorFiles: [{ path: "custom/commands.ts", text: AUTHOR_COMMANDS }]
		})
		const built = yield* buildPackage(generated)
		const names = generated.result.report.commandNames
		const update = yield* Effect.fromOption(
			Arr.findFirst(names, (name) => name.pointer === "/paths/~1users~1{id}/patch")
		)
		const commands: Commands = {
			update: update.path,
			all: Arr.prepend(
				Arr.map(names, (name) => name.path),
				["login"]
			)
		}
		return { server, built, commands }
	})
).pipe(Layer.provideMerge(harnessLayer))

/** The package's flags that take a value: global settings and the update operation's fields. */
const VALUE_FLAGS: Arr.NonEmptyReadonlyArray<string> = [
	"--timeout",
	"--retries",
	"--server",
	"--server-variable",
	"--error-format",
	"--body",
	"--body-file",
	"--name",
	"--if-match",
	"--address.city",
	"--bearer-auth-file"
]

/** The package's flags that stand alone. */
const SWITCHES: Arr.NonEmptyReadonlyArray<string> = [
	"--dry-run",
	"--verbose",
	"--raw",
	"--notify",
	"--no-notify"
]

/** The flags that answer without a request. */
const TERMINALS: Arr.NonEmptyReadonlyArray<string> = ["--help", "--version"]

/** A value of any shape: empty, a number, JSON, a flag-looking word, text with spaces and characters beyond ASCII. */
const value: Gen<string> = oneOf([
	string(characterOf(["a", "1", " ", "-", "=", "{", "}", '"', ":", "é", "\n"]), { min: 0, max: 6 }),
	element(["0", "1", "-1", "{}", "[]", "null", "true", "json", "text", "-", "--"])
])

/** Text a field takes as given. */
const text: Gen<string> = string(characterOf(["a", "Z", "0", " ", "é", "-"]), { min: 1, max: 6 })

/**
 * One well-formed item of the update command's argv: a field with text, a whole JSON body, a timeout in seconds, an
 * error format, or a switch.
 */
const wellFormed: Gen<ReadonlyArray<string>> = oneOf<ReadonlyArray<string>>([
	(source) => [element(["--name", "--if-match", "--address.city"])(source), text(source)],
	(source) => [
		"--body",
		`{"name":"${string(characterOf(["a", "b"]), { min: 0, max: 3 })(source)}"}`
	],
	(source) => ["--timeout", String(element([0, 5, 30])(source))],
	(source) => ["--error-format", element(["json", "text"])(source)],
	(source) => [element(SWITCHES)(source)]
])

/** One item that may not fit: a flag with a value of any shape, a terminal flag, or a word the package does not know. */
const anyItem: Gen<ReadonlyArray<string>> = oneOf<ReadonlyArray<string>>([
	(source) => [element(VALUE_FLAGS)(source), value(source)],
	(source) => [element(TERMINALS)(source)],
	(source) => [string(characterOf(["x", "-", "z"]), { min: 1, max: 4 })(source)]
])

/** One run: argv, the bearer token or none, and the status and body bytes the server answers every request with. */
type Invocation = Readonly<{
	argv: ReadonlyArray<string>
	token: Option.Option<string>
	status: number
	body: Uint8Array
}>

/** The statuses the server answers with: success, client and server errors, and the credential refusals. */
const status: Gen<number> = element([200, 201, 204, 400, 401, 403, 404, 409, 500, 503])

/**
 * An invocation: mostly the update command with its id and well-formed items, so most runs send a request; otherwise
 * any command path with items of any shape, the deliberate faults.
 */
const invocationOf =
	(commands: Commands): Gen<Invocation> =>
	(source) => ({
		argv: weighted<ReadonlyArray<string>>([
			[
				3,
				(well) =>
					Arr.flatten([
						commands.update,
						[text(well)],
						Arr.flatten(array(wellFormed, { min: 0, max: 3 })(well))
					])
			],
			[
				1,
				(any) =>
					Arr.flatten([
						element(commands.all)(any),
						array(value, { min: 0, max: 1 })(any),
						Arr.flatten(array(anyItem, { min: 0, max: 3 })(any))
					])
			]
		])(source),
		token: option(string(characterOf(["a", "Z", "0", "-"]), { min: 1, max: 6 }))(source),
		status: status(source),
		body: bytes({ min: 0, max: 12 })(source)
	})

/** What an exit code means under the contract, or a defect: 70 or any code the contract does not name. */
type Meaning = "success" | "non-2xx" | "usage" | "credential" | "transport" | "body" | "defect"

const meaningOf = (code: number): Meaning => {
	switch (code) {
		case 0:
			return "success"
		case 1:
			return "non-2xx"
		case 2:
			return "usage"
		case 3:
			return "credential"
		case 4:
			return "transport"
		case 5:
			return "body"
		default:
			return "defect"
	}
}

type ExitFeature = Exclude<Meaning, "defect"> | "a request sent"

layer(fixture, { excludeTestServices: true })("a built generated CLI", (it) => {
	it.effect("exits with a documented code for any argv, the same way twice", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { server, built, commands } = yield* GoldenFixture
				const base = { EXAMPLE_BASE_URL: server.origins["127.0.0.1"] }
				return yield* explore(
					{
						suite: "built package exits",
						draw: drawn(invocationOf(commands)),
						literal: Formatter.format,
						coverage: required<ExitFeature>(["success", "non-2xx", "usage", "a request sent"], {
							cases: 24,
							sense: notesOnly
						}),
						kept: [],
						runs: 12,
						shrink: { kind: "bounded", candidates: 40 },
						concurrency: 1,
						steerEvery: 6,
						caseHang: Duration.seconds(60)
					},
					(c, k) =>
						Effect.gen(function* () {
							const answer: ScriptedResponse = {
								status: c.status,
								headers: [["Content-Type", "application/json"]],
								delay: Duration.zero,
								body: { kind: "complete", bytes: c.body }
							}
							const env = Option.match(c.token, {
								onNone: () => base,
								onSome: (token) => ({ ...base, EXAMPLE_BEARER_AUTH: token })
							})
							const run = runBin(built, { args: c.argv, env, stdin: new Uint8Array(0) })
							const first = yield* server.observe(() => answer, run)
							const second = yield* server.observe(() => answer, run)
							const meaning = meaningOf(first.result.exitCode)
							if (meaning !== "defect") {
								k.note(meaning)
							}
							if (first.requests.length > 0) {
								k.note("a request sent")
							}
							notDeepStrictEqual(meaning, "defect", "the exit code is one the contract documents")
							deepStrictEqual(
								second.result,
								first.result,
								"a second run exits the same way and prints the same bytes"
							)
						})
				)
			})
		)
	)
})
