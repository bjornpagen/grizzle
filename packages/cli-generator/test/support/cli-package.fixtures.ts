import {
	array,
	bytes,
	characterOf,
	type Gen,
	map,
	string,
	uniqueArray
} from "@bjornpagen/testing/gen"
import { Effect, FileSystem, Path, Record as Rec, Schema } from "effect"
import { ChildProcess } from "effect/process"
import { type BinInvocation, type BuiltPackage, workerFixture } from "#test/support/cli-package.ts"
import { type Finished, finished } from "#test/support/process.ts"

/** What the bin-run property (cli-package.test.ts) draws and its fixture: the echo bin and the invocations. */

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
	`${source.draw(characterOf(["A", "Z", "_"]))}${source.draw(string(characterOf(["A", "B", "0", "9", "_"]), { min: 0, max: 4 }))}`

/** An invocation: up to five arguments, up to four environment variables of distinct names, and up to 64 stdin bytes. */
export const invocation: Gen<BinInvocation> = (source) => ({
	args: source.draw(array(string(valueCharacter, { min: 0, max: 5 }), { min: 0, max: 5 })),
	env: Rec.fromEntries(
		source.draw(
			uniqueArray(
				environmentName,
				(name) =>
					map(string(valueCharacter, { min: 0, max: 5 }), (value): readonly [string, string] => [
						name,
						value
					]),
				{ min: 0, max: 4 }
			)
		)
	),
	stdin: source.draw(bytes({ min: 0, max: 64 }))
})

/** What the echo bin reported of one run: its argv and environment, the stdin it copied, and its exit code. */
type Echo = Readonly<{
	args: ReadonlyArray<string>
	env: Readonly<Record<string, string>>
	stdin: Uint8Array
	exitCode: number
}>

/** What the echo bin reported of a finished run. */
export const echoOf = Effect.fn("cliPackageTest.echo")(function* (run: Finished) {
	const echoed = yield* Schema.decodeEffect(Echoed)(new TextDecoder().decode(run.stdout))
	const echo: Echo = {
		args: echoed.args,
		env: echoed.env,
		stdin: run.stderr,
		exitCode: run.exitCode
	}
	return echo
})

export type InvocationFeature =
	| "no arguments"
	| "an empty argument"
	| "an empty environment"
	| "an empty value"
	| "no stdin"
	| "a non-zero exit"
	| "text beyond ASCII"

/**
 * The suite's fixture, once per worker: the echo bin in a scratch directory, and what it reports of Node spawned
 * directly with an empty environment (the variables the platform adds to one).
 */
export const echoFixture = workerFixture(
	"test/support/cli-package.fixtures.ts echoFixture",
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
		const opened: Readonly<{ built: BuiltPackage; platform: Echo }> = { built, platform }
		return opened
	})
)
