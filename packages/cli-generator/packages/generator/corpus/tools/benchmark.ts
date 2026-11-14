import { tmpdir } from "node:os"
import { NodeCrypto, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Array as Arr, Effect, FileSystem, Path } from "effect"
import { FetchHttpClient } from "effect/http"
import { exerciseCommands } from "#corpus/tools/exercise.ts"
import { decodeCorpus, settle, verdictFor } from "#corpus/tools/run.ts"
import type { Context } from "#corpus/tools/run.ts"

/**
 * The benchmark, a task of `pnpm check`: every `ci` entry of the corpus whose bytes are committed, so it needs no
 * network, is generated, built against the workspace's installed dependencies, held to its committed verdict byte for
 * byte, and exercised command by command (exercise.ts). Any finding fails it, as one fails `pnpm corpus --check`.
 * Scratch goes to the system's temporary directory, never under the package, whose typecheck would read it.
 *
 * Plants, each applied to the generator, seen to fail the benchmark and reverted: the schema store keeping a nested
 * `$id` (normalize/schemas.ts before 5b35e52: eight SCH-02 refusals, so the verdict differs); the package build writing
 * declarations (emit/package.ts before 9f6166b: TS7056, so the build fails); and an `allOf` beside a string read as
 * JSON (names/flatten.ts before bab3c6b: help shows no `string` after `--params.package`).
 */
const benchmark = Effect.gen(function* benchmark() {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = path.resolve(import.meta.dirname, "../..")
	const manifest = yield* fs.readFileString(path.join(root, "corpus/corpus.json"))
	const corpus = yield* decodeCorpus(manifest)
	const committed = Arr.filter(
		corpus.specs,
		(spec) => spec.tier === "ci" && spec.source.kind === "committed"
	)
	const context: Context = {
		build: "linked",
		cacheDir: path.join(tmpdir(), "effect-openapi-cli-generator-benchmark"),
		exercise: exerciseCommands,
		out: undefined,
		root,
		work: tmpdir()
	}
	const found = yield* Effect.forEach(committed, (entry) =>
		verdictFor(entry, corpus.version, context, true)
	)

	yield* settle(found)
})

NodeRuntime.runMain(
	benchmark.pipe(
		Effect.provide([NodeServices.layer, NodeCrypto.layerDigest, FetchHttpClient.layer])
	)
)
