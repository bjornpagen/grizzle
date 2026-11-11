/**
 * The bench's performance gates on PostgreSQL at quick scale, each owner's in one run of the gate runner
 * (bench/harness/runner.ts): the query rule gates (bench/query) and the write, law, queue and refresh gates
 * (bench/write, bench/queue).
 *
 * Property, for each owner: the run finds nothing (gateFindings: no failed record, no leaked release, no incomplete
 * record, no gate's verdict against it), and the gates its records name are exactly the catalog's gates of that owner
 * (bench/harness/rules.ts gateCatalog), each once. The oracle is the gate catalog, the specification of what each owner
 * must measure, and each gate's own verdict on what it measured; the box is the bench files of the owner's directories
 * at quick scale.
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): bench-gate-unmeasured.patch (a bench file of each owner that records no
 * verdict for one of its gates).
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, FileSystem, Order, Path } from "effect"
import { repoRoot } from "#bench/cold/identity.ts"
import { gateFindings } from "#bench/harness/gate.ts"
import { gateCatalog, type GateOwner, ownerDirectories } from "#bench/harness/rules.ts"
import { runGates } from "#bench/harness/runner.ts"
import { assert } from "#test/support/assert.ts"
import { scopedTempDir } from "#test/support/temp.ts"

/** One owner's gates run at quick scale: nothing found, and every gate of the owner's catalog recorded once. */
const ownerGates = (owner: GateOwner) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const results = path.join(repoRoot, "bench/results")
		yield* fs.makeDirectory(results, { recursive: true })
		const outDir = yield* scopedTempDir(results, `gates-${owner}-pg-`)
		const ran = yield* runGates({
			quick: true,
			outDir,
			directories: Arr.map(ownerDirectories[owner], (dir) => path.join(repoRoot, dir)),
			only: [],
			onRecord: () => Effect.void
		})
		assert.deepEqual(gateFindings(ran.records), [], `the ${owner} gates find nothing`)
		assert.deepEqual(
			Arr.sort(
				Arr.flatMap(ran.records, (r) =>
					r.kind === "ran" ? Arr.map(r.verdicts, (v) => v.gate) : r.gates
				),
				Order.String
			),
			Arr.sort(
				Arr.map(
					Arr.filter(gateCatalog, (e) => e.owner === owner),
					(e) => e.id
				),
				Order.String
			),
			`every ${owner} gate of the catalog is recorded once`
		)
	})

layer(NodeServices.layer, { excludeTestServices: true })("the bench gates on PostgreSQL", (it) => {
	it.effect("the query rule gates find nothing at quick scale, each recorded once", () =>
		ownerGates("query")
	)
	it.effect(
		"the write, law, queue and refresh gates find nothing at quick scale, each recorded once",
		() => ownerGates("write")
	)
})
