/**
 * A built bin runs under exactly the invocation it is given: its arguments after the bin, its whole environment and its
 * stdin, with its stdout, stderr and exit code reported whole.
 *
 * - Invocations: arguments and environment values of quotes, spaces, newlines, shell metacharacters and characters
 *   beyond ASCII, environment names in the portable shape, and stdin bytes of any value, run through a bin that
 *   prints its argv and environment as JSON on stdout, copies stdin to stderr and exits with its argument count
 *   modulo four. Oracle: the invocation itself, beside the variables the platform adds to an empty environment (macOS
 *   adds `__CF_USER_TEXT_ENCODING` to every process), read once from Node spawned directly with none.
 *
 * Plants (local only, reverted): cli-package.ts runBin with `extendEnv: true`; runBin dropping its first argument;
 * process.ts finished reading stderr from stdout.
 */
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { drawn, explore } from "@superstarter/testing/explore"
import { required } from "@superstarter/testing/features"
import {
	array,
	bytes,
	characterOf,
	type Gen,
	map,
	string,
	uniqueArray
} from "@superstarter/testing/gen"
import { notesOnly } from "@superstarter/testing/sense"
import { searched } from "@superstarter/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	FileSystem,
	Formatter,
	Path,
	Record as Rec,
	Schema
} from "effect"
import { ChildProcess } from "effect/process"
import {
	type BinInvocation,
	type BuiltPackage,
	harnessLayer,
	runBin
} from "#test/support/cli-package.ts"
import { type Finished, finished } from "#test/support/process.ts"

/** A bin that reports its invocation: argv and environment as JSON on stdout, stdin on stderr, its argument count modulo four as its exit code. */
const ECHO_BIN = `import { readFileSync } from "node:fs"
const args = process.argv.slice(2)
process.stdout.write(JSON.stringify({ args, env: process.env }))
process.stderr.write(readFileSync(0))
process.exitCode = args.length % 4
`

/** What the echo bin prints on stdout. */
const Echoed = Schema.fromJsonString(
	Schema.Struct({
		args: Schema.Array(Schema.String),
		env: Schema.Record(Schema.String, Schema.String)
	})
)

/** Characters an argument or a value may hold: quotes, spaces, a newline, shell metacharacters and text beyond ASCII. */
const valueCharacter = characterOf([
	"a",
	" ",
	"\n",
	"'",
	'"',
	"$",
	"\\",
	"*",
	"=",
	"-",
	"é",
	"😀",
	"\t"
])

/** A portable environment name: an upper-case letter or underscore, then letters, digits and underscores. */
const environmentName: Gen<string> = (source) =>
	`${characterOf(["A", "Z", "_"])(source)}${string(characterOf(["A", "B", "0", "9", "_"]), { min: 0, max: 4 })(source)}`

const invocation: Gen<BinInvocation> = (source) => ({
	args: array(string(valueCharacter, { min: 0, max: 5 }), { min: 0, max: 5 })(source),
	env: Rec.fromEntries(
		uniqueArray(
			environmentName,
			(name) =>
				map(string(valueCharacter, { min: 0, max: 5 }), (value): readonly [string, string] => [
					name,
					value
				]),
			{ min: 0, max: 4 }
		)(source)
	),
	stdin: bytes({ min: 0, max: 64 })(source)
})

/** What the echo bin reported of one run: its argv and environment, the stdin it copied, and its exit code. */
type Echo = Readonly<{
	args: ReadonlyArray<string>
	env: Readonly<Record<string, string>>
	stdin: Uint8Array
	exitCode: number
}>

/** What the echo bin reported of a finished run. */
const echoOf = Effect.fn("cliPackageTest.echo")(function* (run: Finished) {
	const echoed = yield* Schema.decodeEffect(Echoed)(new TextDecoder().decode(run.stdout))
	const echo: Echo = {
		args: echoed.args,
		env: echoed.env,
		stdin: run.stderr,
		exitCode: run.exitCode
	}
	return echo
})

type InvocationFeature =
	| "no arguments"
	| "an empty argument"
	| "an empty environment"
	| "an empty value"
	| "no stdin"
	| "a non-zero exit"
	| "text beyond ASCII"

layer(harnessLayer, { excludeTestServices: true })("a built bin's run", (it) => {
	it.effect(
		"passes exactly its arguments, environment and stdin, and reports its output and exit code",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cli-package-run-" })
					const bin = path.join(dir, "echo.mjs")
					yield* fs.writeFileString(bin, ECHO_BIN)
					const built: BuiltPackage = { dir, bin }
					const empty = yield* finished(
						ChildProcess.make(process.execPath, [bin], {
							env: {},
							extendEnv: false,
							stdin: "ignore"
						})
					)
					const platform = yield* echoOf(empty)
					return yield* explore(
						{
							suite: "built bin invocation",
							draw: drawn(invocation),
							literal: Formatter.format,
							coverage: required<InvocationFeature>(
								[
									"no arguments",
									"an empty argument",
									"an empty environment",
									"an empty value",
									"no stdin",
									"a non-zero exit",
									"text beyond ASCII"
								],
								{ cases: 60, sense: notesOnly }
							),
							kept: [],
							runs: 20,
							shrink: { kind: "bounded", candidates: 60 },
							concurrency: 1,
							steerEvery: 10,
							caseHang: Duration.seconds(30)
						},
						(c, k) =>
							Effect.gen(function* () {
								if (Arr.isReadonlyArrayEmpty(c.args)) {
									k.note("no arguments")
								}
								if (Arr.contains(c.args, "")) {
									k.note("an empty argument")
								}
								if (Rec.isEmptyReadonlyRecord(c.env)) {
									k.note("an empty environment")
								}
								if (Arr.contains(Rec.values(c.env), "")) {
									k.note("an empty value")
								}
								if (c.stdin.length === 0) {
									k.note("no stdin")
								}
								if (c.args.length % 4 !== 0) {
									k.note("a non-zero exit")
								}
								if (
									Arr.some(Arr.appendAll(c.args, Rec.values(c.env)), (text) =>
										Arr.some(Arr.fromIterable(text), (character) => character > "\u007f")
									)
								) {
									k.note("text beyond ASCII")
								}
								const run = yield* runBin(built, c)
								const echoed = yield* echoOf(run)
								deepStrictEqual(
									echoed,
									{
										args: c.args,
										env: Rec.union(platform.env, c.env, (_platform, invoked) => invoked),
										stdin: c.stdin,
										exitCode: c.args.length % 4
									},
									"the bin sees exactly the invocation, beside what the platform adds to an empty environment, and its output and exit code come back whole"
								)
							})
					)
				}).pipe(Effect.scoped)
			)
	)
})
