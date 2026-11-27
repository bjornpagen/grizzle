/** What the properties of guarded-keys.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { int, map } from "@bjornpagen/testing/gen"
import type { ScratchDir } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, FileSystem, Layer, Record as Rec } from "effect"
import { served } from "#adapter/public/layer.ts"
import { resolveConfig } from "#cli/config.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { login } from "#compiler/program/workload/login.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { key, on, relation, schema, select, type Statement } from "#compiler/public/schema.ts"
import { relationBuilder } from "#compiler/schema/relation.ts"
import { roleBuilder as role } from "#compiler/schema/world.ts"
import { servedPath } from "#compiler/served/forms.ts"
import { defineConfig } from "#index.ts"
import { cliOver, configName, offlineConnection, offlineOwner } from "#test/pg/cli/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { Id } from "#test/support/ids.ts"
import { callCounts, type CountedFunction } from "#test/support/kernel/calls.ts"
import { offlineDecoders, servedSourcedLayer } from "#test/support/live-layer.ts"
import { clusterPool } from "#test/support/pg.ts"
import { ownedInput } from "#test/support/policy.ts"
import { upTo } from "#test/support/up-to.ts"

/** The ordinary relations of the schema, whose unique objects the law model decides once each. */
export const ordinary = 2

/**
 * The functions whose calls the gate reads: the decision of a relation's objects beyond its primary key, the law
 * model's specialization and its one entry, and the canonical encoder, which every encoding of a predicate calls once.
 * The entry is dischargedLaws, which every law model's compile calls (laws/model/model.ts compileLaws, levelLaws,
 * conservativeLaws): generate compiles its law model through levelLaws, over the closed imports its programs serve,
 * since the merge 1323e2141f passed those explicitly where LAWEXEC's d9407f90ca deleted the slice compileLaws took.
 */
const sites = Object.freeze({
	beyondPrimary: { file: "packages/engine/src/laws/model/uniques.ts", name: "beyondPrimary" },
	specialize: { file: "packages/engine/src/laws/model/model.ts", name: "run" },
	compileLaws: { file: "packages/engine/src/laws/model/model.ts", name: "dischargedLaws" },
	encode: { file: "packages/engine/src/core/canonical.ts", name: "encode" }
} satisfies Readonly<Record<string, CountedFunction>>)

type Counts = Readonly<Record<keyof typeof sites, number>>

/** The schema of k guarded keys, its writer role, and the login whose workload inserts into U and T. */
const loginOf = (k: number) => {
	const T = relation("T", { id: Id, kind: pg.integer, a: Id }, ["id"])
	const U = relation("U", { id: Id }, ["id"])
	const keys: ReadonlyArray<Statement> = upTo(k, (j) =>
		key(
			on(
				select(T, (t) => t.eq(t.kind, j)),
				"a"
			)
		)
	)
	const base = schema("Guarded", [T, U], keys)
	const writer = role(base, "writer", { T, U }, { insert: ["T", "U"] })
	const load = ChangeSet.empty(writer).insert(writer.relations.U, []).insert(writer.relations.T, [])
	return {
		base,
		server: login(base, "server", [writer], { workload: [workload(writer, { load })] })
	}
}

/** What generate and the layer counted at k guarded keys. */
export interface Steps {
	readonly generate: Counts
	readonly layer: Counts
}

/** generate, then the layer over its snapshot, each counted, in a workspace of its own inside the case's directory `dir`. */
export const stepsAt = (dir: ScratchDir) => (k: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const { base, server } = loginOf(k)
			const config = defineConfig({
				contracts: [],
				schemas: [base],
				logins: [server],
				migrations: "migrations",
				rolePrefixBytes: 0,
				connection: () => offlineOwner
			})
			const ws = yield* fs.makeTempDirectoryScoped({ directory: dir, prefix: "guarded-" })
			const [generated, generate] = yield* callCounts(
				cliOver(ws, config, ["generate", configName, "--name", "init"]),
				sites
			)
			assert.equal(generated.code, 0, generated.stderr)
			const resolved = yield* resolveConfig(config, `${ws}/${configName}`)
			const directory = defined(resolved.schemas[0], "the configured schema").directory
			const text = yield* fs.readFileString(`${directory}/${servedPath("server")}`)
			const file = served<typeof server>(trustedJson<unknown>(text), "server")
			const [, built] = yield* callCounts(
				Effect.scoped(
					Layer.build(
						servedSourcedLayer(offlineDecoders, {
							...offlineConnection,
							pool: clusterPool,
							login: file
						})
					)
				),
				sites
			)
			const steps: Steps = { generate, layer: built }
			return steps
		})
	)

export const stepNames: ReadonlyArray<keyof Steps> = ["generate", "layer"]

/** The law models each step compiles: generate's one, and none for the served layer, which loads and compiles nothing. */
export const lawModels: Readonly<Record<keyof Steps, number>> = { generate: 1, layer: 0 }

/** The box of guarded keys: h of 1 and 2, each measured at 2h, 4h and 6h keys. */
export const keysGen = int(1, 2)

/** The install order's heap: its pushes, and its comparisons of two ready objects. */
const orderSites = Object.freeze({
	push: { file: "packages/engine/src/physical/obligations/graph.ts", name: "push" },
	readyFirst: { file: "packages/engine/src/physical/obligations/graph.ts", name: "readyFirst" }
} satisfies Readonly<Record<string, CountedFunction>>)

/**
 * ReadyHeap's bound on its comparisons over `pushes` pushes and as many pops: one comparison a level of a push's sift-up,
 * two a level of a pop's sink (each child of the node it descends to), ⌊log2 p⌋ levels in a heap of at most p objects.
 */
export const heapBound = (pushes: number): number => {
	const levels = pushes === 0 ? 0 : Math.floor(Math.log2(pushes))
	const siftUp = levels
	const sink = 2 * levels
	return pushes * siftUp + pushes * sink
}

/** The heap's pushes and comparisons ordering the installation of r relations, each keyed by its id, no law between. */
export const orderedAt = (r: number) =>
	Effect.gen(function* () {
		const relations = upTo(r, (i) =>
			relationBuilder(`R${i}`, { id: Id, a: pg.integer }, ["id"], [])
		)
		const owned = succeeded(
			ownedInput(
				schema(
					"Tables",
					Rec.values(Rec.fromEntries(Arr.map(relations, (t) => [t.name, t] as const))),
					[]
				)
			)
		)
		const [, counts] = yield* callCounts(
			Effect.sync(() => succeeded(compileInstallation(owned, installOptions(owned)))),
			orderSites
		)
		return counts
	})

/** The box of relations the order holds: r from 20 to 40 by tens. */
export const relationsGen = map(int(2, 4), (tens) => 10 * tens)
