import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, FileSystem, Path } from "effect"
import { assert, defined, failureOf } from "#test/support/assert.ts"
import { scopedTempDir } from "#test/support/temp.ts"
import { buildBatchAt, type Group } from "#test/types/batch/batch.ts"
import { diagnosticKey } from "#test/types/batch/directives.ts"
import { typeRun } from "#test/types/batch/provided.ts"

/** The test file that reads the groups below, which the runner's batch never holds. */
const owner = "test/types/batch/batch.test.ts"

/** The repository root, three levels above this directory. */
const repository = Effect.gen(function* () {
	const path = yield* Path.Path
	return path.resolve(import.meta.dirname, "../../..")
})

/** A disarmed program of one directive, whose diagnostic the batch must attribute to it. */
const probe: Group = {
	owner,
	units: {
		"batch/probe": {
			kind: "program",
			dir: "test/types/batch",
			prefix: ".probe-",
			disarm: true,
			heavy: false,
			source: () => [
				{
					file: "index.ts",
					source:
						'// @ts-expect-error -- TS2322: a string is no number\nexport const probe: number = "probe"\n'
				}
			]
		}
	}
}

/** A program whose one diagnostic is in `planted`, a repository file no unit owns. */
const importing = (planted: string): Group => ({
	owner,
	units: {
		"batch/importer": {
			kind: "program",
			dir: "test/types/batch",
			prefix: ".importer-",
			disarm: false,
			heavy: false,
			source: (entry) => [
				{
					file: "index.ts",
					source: `import { planted } from "${entry(planted)}"\nexport const read: number = planted\n`
				}
			]
		}
	}
})

layer(NodeServices.layer, { excludeTestServices: true })("the type-test batch", (it) => {
	it.effect("fails the batch on a diagnostic in a file no unit owns", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const root = yield* repository
				const dir = yield* scopedTempDir(path.join(root, "test/types/batch"), ".planted-")
				const planted = path.join(dir, "planted.ts")
				yield* fs.writeFileString(planted, 'export const planted: number = "planted"\n')
				const failure = yield* failureOf(
					buildBatchAt(root, [importing(path.relative(root, planted))], typeRun().seed)
				)
				assert.ok(
					failure._tag === "BatchDiagnosticUnowned",
					`the batch failed with ${failure._tag}`
				)
				assert.equal(failure.file, yield* fs.realPath(planted))
			})
		)
	)

	it.effect("attributes every diagnostic through a symlinked batch root", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const outside = yield* fs.makeTempDirectoryScoped({ prefix: "grizzle-batch-root-" })
				const linked = path.join(outside, "repository")
				yield* fs.symlink(yield* repository, linked)
				const batch = yield* buildBatchAt(linked, [probe], typeRun().seed)
				const unit = defined(batch.units["batch/probe"], "the probe's unit")
				assert.deepEqual(batch.unattributed, [])
				assert.equal(unit.directives.length, 1)
				assert.deepEqual(
					Arr.map(unit.errors, diagnosticKey),
					Arr.map(unit.directives, diagnosticKey)
				)
				assert.deepEqual(unit.problems, [])
			})
		)
	)
})
