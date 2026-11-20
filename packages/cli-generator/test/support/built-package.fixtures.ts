import {
	aimed,
	array,
	bytes,
	characterOf,
	element,
	type Gen,
	int,
	oneOf,
	option,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, FileSystem, Option, Path } from "effect"
import { type CaptureServer, captureServer } from "#test/support/capture-server.ts"
import {
	buildPackage,
	type BuiltPackage,
	generateFixture,
	workerFixture
} from "#test/support/cli-package.ts"

/** What the built-package property (built-package.test.ts) draws and its fixture: the golden package's invocations. */

/** The command module the golden author config names, which the API author owns: one `login` command. */
const AUTHOR_COMMANDS = `import { Command } from "effect/cli";\n\nexport const login = Command.make("login");\n`

/** The golden package's commands: the update operation's path, and every command path it has. */
type Commands = Readonly<{
	update: ReadonlyArray<string>
	all: Arr.NonEmptyReadonlyArray<ReadonlyArray<string>>
}>

/** The suite's fixture, once per worker: the capture server and the golden package, built, with its command paths. */
export const goldenFixture = workerFixture(
	"test/support/built-package.fixtures.ts goldenFixture",
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
		const opened: Readonly<{ server: CaptureServer; built: BuiltPackage; commands: Commands }> = {
			server,
			built,
			commands
		}
		return opened
	})
)

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

/**
 * A run's command line before the package names its commands: the update command with its id and well-formed items,
 * or the command at a position along the package's command paths (`at`, taken modulo their count, so it names one
 * whatever the package holds and shrinks toward the first) with items of any shape.
 */
type Argv =
	| Readonly<{ kind: "update"; id: string; items: ReadonlyArray<string> }>
	| Readonly<{ kind: "any"; at: number; items: ReadonlyArray<string> }>

/** One run: argv, the bearer token or none, and the status and body bytes the server answers every request with. */
export type Invocation = Readonly<{
	argv: Argv
	token: Option.Option<string>
	status: number
	body: Uint8Array
}>

/** The argv a run gives the package whose commands are `commands`. */
export const argvOf = (commands: Commands, argv: Argv): ReadonlyArray<string> => {
	switch (argv.kind) {
		case "update":
			return Arr.flatten([commands.update, [argv.id], argv.items])
		case "any":
			return Arr.appendAll(Arr.getUnsafe(commands.all, argv.at % commands.all.length), argv.items)
	}
}

/** The statuses the server answers with: success, client and server errors, and the credential refusals. */
const answerStatus: Gen<number> = element([200, 201, 204, 400, 401, 403, 404, 409, 500, 503])

/**
 * An invocation: mostly the update command with its id and well-formed items, so most runs send a request; otherwise
 * any command path with items of any shape, the deliberate faults.
 */
const invocation: Gen<Invocation> = (source) => ({
	argv: source.draw(
		weighted<Argv>([
			[
				3,
				(well) => ({
					kind: "update",
					id: well.draw(text),
					items: Arr.flatten(well.draw(array(wellFormed, { min: 0, max: 3 })))
				})
			],
			[
				1,
				(any) => ({
					kind: "any",
					at: any.draw(int(0, 1023)),
					items: Arr.flatten([
						any.draw(array(value, { min: 0, max: 1 })),
						Arr.flatten(any.draw(array(anyItem, { min: 0, max: 3 })))
					])
				})
			]
		])
	),
	token: source.draw(option(string(characterOf(["a", "Z", "0", "-"]), { min: 1, max: 6 }))),
	status: source.draw(answerStatus),
	body: source.draw(bytes({ min: 0, max: 12 }))
})

/** What an exit code means under the contract, or a defect: 70 or any code the contract does not name. */
export type Meaning =
	| "success"
	| "non-2xx"
	| "usage"
	| "credential"
	| "transport"
	| "body"
	| "defect"

export const meaningOf = (code: number): Meaning => {
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

/**
 * The meanings an exchange leaves the exit code: with no request answered, anything but an answer's verdict; with an
 * answer, success (or a body the CLI cannot read) for a 2xx, a credential refusal for 401 and 403, and a non-2xx exit
 * for any other status. A defect is never admitted, and neither is an exit 1 that no answer explains, which a CLI that
 * crashes at start-up gives.
 */
export const admittedOf = (requests: number, status: number): ReadonlyArray<Meaning> => {
	if (requests === 0) {
		return ["success", "usage", "credential", "transport"]
	}
	if (status >= 200 && status < 300) {
		return ["success", "body"]
	}
	return status === 401 || status === 403 ? ["credential"] : ["non-2xx"]
}

export type ExitFeature =
	| Exclude<Meaning, "defect">
	| "a request sent"
	| "a body that is no JSON text"

/** Bodies that are no JSON text, which the generated runtime refuses with a UsageError before any request. */
const NOT_JSON: Arr.NonEmptyReadonlyArray<string> = ["{", '{"name":', "[1,", "nope"]

/** Whether an invocation gives the update command a body of NOT_JSON. */
export const bodyNotJson = (c: Invocation): boolean =>
	c.argv.kind === "update" &&
	Arr.some(
		c.argv.items,
		(item, index) =>
			item === "--body" &&
			Option.exists(Arr.get(c.argv.items, index + 1), (next) => Arr.contains(NOT_JSON, next))
	)

/**
 * Invocations, aimed at a body that is no JSON text, the usage error the runtime raises (errors.ts UsageError) where
 * every other usage exit is the parser's.
 */
export const invocations = aimed<Invocation, ExitFeature>(invocation, [
	[
		"a body that is no JSON text",
		(source) => ({
			...invocation(source),
			argv: { kind: "update", id: text(source), items: ["--body", element(NOT_JSON)(source)] }
		})
	]
])
