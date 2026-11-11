import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Schema, Stdio } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { FuzzTime } from "#fuzz.ts"

/**
 * `pnpm fuzz <suite> [fuzztime]`: runs the tests as `go test -fuzz` runs a package's, `pnpm test` and then
 * `pnpm test:network`, with the suite of that label fuzzed for the fuzz time (Go's `-fuzztime`: `30s`, `5m`, `1000x`)
 * or, without one, until a case fails. The suite lives in one of the two runs; the other runs its tests as it always
 * does. The first run that fails ends the fuzz run with its status. The suite's corpus is its package's gitignored
 * `.vitest/testing/<suite>/`; a failure prints its kept-case literal, ready to paste.
 */
const Arguments = Schema.Union([
	Schema.Tuple([Schema.NonEmptyString]),
	Schema.Tuple([Schema.NonEmptyString, FuzzTime])
])

/** `pnpm fuzz` was given arguments its usage does not admit. */
class FuzzUsage extends Schema.TaggedError<FuzzUsage, { readonly brand: unique symbol }>()(
	"FuzzUsage",
	{
		usage: Schema.NonEmptyString
	}
) {}

const main = Effect.gen(function* () {
	const stdio = yield* Stdio.Stdio
	const args = yield* stdio.args
	const [suite, fuzzTime] = yield* Schema.decodeUnknownEffect(Arguments)(args).pipe(
		Effect.mapError(() => FuzzUsage.make({ usage: "pnpm fuzz <suite> [fuzztime]" }))
	)
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const env =
		fuzzTime === undefined ? { TEST_FUZZ: suite } : { TEST_FUZZ: suite, TEST_FUZZTIME: fuzzTime }
	const run = (script: "test" | "test:network") =>
		spawner.exitCode(
			ChildProcess.make("pnpm", ["run", script], {
				env,
				extendEnv: true,
				stdout: "inherit",
				stderr: "inherit"
			})
		)
	const unit = yield* run("test")
	const code = unit === 0 ? yield* run("test:network") : unit
	yield* Effect.sync(() => {
		process.exitCode = code
	})
})

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)))
