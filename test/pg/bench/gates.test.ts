import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, FileSystem, Order, Path } from "effect"
import { repoRoot } from "#bench/cold/identity.ts"
import { gateFindings } from "#bench/harness/gate.ts"
import { gateCatalog, ownerDirectories } from "#bench/harness/rules.ts"
import { runGates } from "#bench/harness/runner.ts"
import { assert } from "#test/support/assert.ts"
import { scopedTempDir } from "#test/support/temp.ts"

layer(NodeServices.layer, { excludeTestServices: true })(
	"the write, law, queue and refresh gates on PostgreSQL",
	(it) => {
		it.effect("find nothing at quick scale, and record a verdict for every write gate", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const results = path.join(repoRoot, "bench/results")
				yield* fs.makeDirectory(results, { recursive: true })
				const outDir = yield* scopedTempDir(results, "m15c-pg-")
				const ran = yield* runGates({
					quick: true,
					outDir,
					directories: Arr.map(ownerDirectories.write, (dir) => path.join(repoRoot, dir)),
					only: [],
					onRecord: () => Effect.void
				})
				assert.deepEqual(gateFindings(ran.records), [])
				assert.deepEqual(
					Arr.sort(
						Arr.flatMap(ran.records, (r) =>
							r.kind === "ran" ? Arr.map(r.verdicts, (v) => v.gate) : r.gates
						),
						Order.String
					),
					Arr.sort(
						Arr.map(
							Arr.filter(gateCatalog, (e) => e.owner === "write"),
							(e) => e.id
						),
						Order.String
					)
				)
			})
		)
	}
)
