/**
 * Startup and write compilation over k guarded keys, counted and never timed (test/support/kernel/calls.ts), so no
 * verdict depends on the machine.
 *
 * A relation T carrying k keys over selected sides, `key(on(select(T, kind = j), "a"))`, each a UNIQUE over law columns
 * guarded by its own predicate, beside a relation U with no law, and a login whose workload holds the ChangeSet that
 * inserts into both: `grizzle generate`, which compiles the ChangeSet into the login's served file, and DbLayer.make
 * over that file, which loads it and compiles nothing, no law model among it.
 *
 * - Each relation's unique objects beyond its primary key are decided once, as its law model is built (uniques.ts
 *   beyondPrimary, RelationLaws.beyond), and the law model specializes the schema once: no write compile, role probe or
 *   second specialization decides them again. The oracle is the specification's counts: one law model for generate,
 *   none for the layer, one specialization and one decision per ordinary relation per law model.
 * - A guard's predicate is encoded once, where its unique object is built, and compared by its label: the canonical
 *   encoder's calls grow at most linearly in k (test/support/growth.ts incrementsDoNotGrow, at 2h, 4h and 6h keys),
 *   where comparing every two guards by encoding both adds more at every step. No encoding changes shape above some
 *   number of keys: every key is the same selected side, its kind its own number.
 * - The installation's objects are ordered by a binary heap of the ready ones (obligations/graph.ts order), each push
 *   comparing once per level of the heap and each pop at most twice: over the order's pushes p, its comparisons
 *   (readyFirst) are at most 3·p·⌊log2 p⌋, the heap's own bound, where comparing every ready object at each step grows
 *   with their number squared. Over r relations with no law between them every table is ready at once.
 *
 * The boxes are exhausted: h of 1 and 2, so k of 2, 4, 6 and of 4, 8, 12; and r from 20 to 40 by tens.
 *
 * Plants (~/.cache/grizzle-release/BR07/plants): guarded-keys-encode-pairs.patch (guards compared by encoding both)
 * turns the first property red; install-order-quadratic.patch (every two ready objects compared at each pop) the
 * second.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { int, map } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, FileSystem, Formatter, Layer, Record as Rec } from "effect"
import { DbLayer, served } from "#adapter/public/layer.ts"
import { resolveConfig } from "#cli/config.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { login } from "#compiler/program/workload/login.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { key, on, relation, schema, select, type Statement } from "#compiler/public/schema.ts"
import { role } from "#compiler/schema/world.ts"
import { servedPath } from "#compiler/served/forms.ts"
import { defineConfig } from "#index.ts"
import {
	cliClock,
	cliOver,
	configName,
	offlineConnection,
	offlineOwner,
	workspace
} from "#test/pg/cli/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { incrementsDoNotGrow } from "#test/support/growth.ts"
import { type CallSite, callCounts } from "#test/support/kernel/calls.ts"
import { caseHang } from "#test/support/limits.ts"
import { clusterPool } from "#test/support/pg.ts"
import { ownedInput } from "#test/support/policy.ts"
import { upTo } from "#test/support/up-to.ts"

/** The ordinary relations of the schema, whose unique objects the law model decides once each. */
const ordinary = 2

/**
 * The functions whose calls the gate reads: the decision of a relation's objects beyond its primary key, the law
 * model's specialization and its one entry, and the canonical encoder, which every encoding of a predicate calls once.
 */
const sites = {
	beyondPrimary: { file: "packages/engine/src/laws/model/uniques.ts", name: "beyondPrimary" },
	specialize: { file: "packages/engine/src/laws/model/model.ts", name: "run" },
	compileLaws: { file: "packages/engine/src/laws/model/model.ts", name: "compileLaws" },
	encode: { file: "packages/engine/src/core/canonical.ts", name: "encode" }
} satisfies Readonly<Record<string, CallSite>>

type Counts = Readonly<Record<keyof typeof sites, number>>

/** The schema of k guarded keys, its writer role, and the login whose workload inserts into U and T. */
const loginOf = (k: number) => {
	const T = relation("T", { id: uuid, kind: pg.integer, a: uuid }, ["id"])
	const U = relation("U", { id: uuid }, ["id"])
	const keys: ReadonlyArray<Statement> = upTo(k, (j) =>
		key(
			on(
				select(T, (t) => t.eq(t.kind, j)),
				"a"
			)
		)
	)
	const base = schema("Guarded", { T, U }, keys)
	const writer = role(base, "writer", { T, U }, { write: ["T", "U"] })
	const load = ChangeSet.empty(writer).insert(writer.relations.U, []).insert(writer.relations.T, [])
	return {
		base,
		server: login(base, "server", [writer], { workload: [workload(writer, { load })] })
	}
}

const nextNow = cliClock()

/** What generate and the layer counted at k guarded keys. */
interface Steps {
	readonly generate: Counts
	readonly layer: Counts
}

/** generate, then the layer over its snapshot, each counted, in a workspace of its own. */
const stepsAt = (k: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const { base, server } = loginOf(k)
			const config = defineConfig({
				schemas: [base],
				logins: [server],
				migrations: "migrations",
				connection: () => offlineOwner
			})
			const ws = yield* workspace("guarded")
			const [generated, generate] = yield* callCounts(
				cliOver(ws, config, ["generate", configName, "--name", "init"], nextNow()),
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
						DbLayer.make({
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

const stepNames: ReadonlyArray<keyof Steps> = ["generate", "layer"]

/** The law models each step compiles: generate's one, and none for the served layer, which loads and compiles nothing. */
const lawModels: Readonly<Record<keyof Steps, number>> = { generate: 1, layer: 0 }

/** The box of guarded keys: h of 1 and 2, each measured at 2h, 4h and 6h keys. */
const keysGen = int(1, 2)

layer(NodeServices.layer, { excludeTestServices: true })("guarded keys at startup", (it) => {
	it.effect(
		"decide each relation's objects beyond its primary key once, specialize once, and encode linearly in k",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "2h, 4h and 6h guarded keys for h of 1 and 2",
						oracle: {
							kind: "specification",
							name: "one law model, specialization and decision per relation; encodings whose second step adds no more than the first"
						},
						suite: "unit/startup/guarded-keys",
						generator: keysGen,
						literal: Formatter.format,
						limit: 2,
						coverage: noCoverage,
						caseHang
					},
					(half) =>
						Effect.gen(function* () {
							const sizes = [2 * half, 4 * half, 6 * half] as const
							const measured = yield* Effect.forEach(sizes, stepsAt)
							const bySize = new Map(
								Arr.map(measured, (steps, i) => [2 * half * (i + 1), steps] as const)
							)
							const stepsOf = (k: number): Steps => defined(bySize.get(k), `the steps at ${k} keys`)
							const at = `k at ${Arr.join(Arr.map(sizes, String), ", ")}`
							for (const step of stepNames) {
								for (const steps of measured) {
									assert.equal(
										steps[step].compileLaws,
										lawModels[step],
										`${at}: ${step} compiles the law model ${lawModels[step]} times`
									)
									assert.equal(
										steps[step].specialize,
										steps[step].compileLaws,
										`${at}: ${step} specializes the schema once a law model`
									)
									assert.equal(
										steps[step].beyondPrimary,
										ordinary * steps[step].compileLaws,
										`${at}: ${step} decides each relation's objects beyond its primary key once`
									)
								}
								incrementsDoNotGrow((k) => stepsOf(k)[step].encode, half, `${step}'s encodings`)
							}
						})
				)
			)
	)
})

/** The install order's heap: its pushes, and its comparisons of two ready objects. */
const orderSites = {
	push: { file: "packages/engine/src/physical/obligations/graph.ts", name: "push" },
	readyFirst: { file: "packages/engine/src/physical/obligations/graph.ts", name: "readyFirst" }
} satisfies Readonly<Record<string, CallSite>>

/** A binary heap's bound on its comparisons over `pushes` pushes and as many pops: ⌊log2 p⌋ a push, twice that a pop. */
const heapBound = (pushes: number): number =>
	pushes === 0 ? 0 : 3 * pushes * Math.floor(Math.log2(pushes))

/** The heap's pushes and comparisons ordering the installation of r relations, each keyed by its id, no law between. */
const orderedAt = (r: number) =>
	Effect.gen(function* () {
		const relations = upTo(r, (i) => relation(`R${i}`, { id: uuid, a: pg.integer }, ["id"]))
		const owned = succeeded(
			ownedInput(
				schema("Tables", Rec.fromEntries(Arr.map(relations, (t) => [t.name, t] as const)), [])
			)
		)
		const [, counts] = yield* callCounts(
			Effect.sync(() => succeeded(compileInstallation(owned, installOptions(owned, "owner")))),
			orderSites
		)
		return counts
	})

/** The box of relations the order holds: r from 20 to 40 by tens. */
const relationsGen = map(int(2, 4), (tens) => 10 * tens)

layer(NodeServices.layer, { excludeTestServices: true })("the install order", (it) => {
	it.effect("compares its objects within a binary heap's bound on its pushes", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					box: "r relations with no law between them, for r from 20 to 40 by tens",
					oracle: {
						kind: "specification",
						name: "a binary heap's bound: at most 3·p·⌊log2 p⌋ comparisons over p pushes and their pops"
					},
					suite: "unit/startup/install-order",
					generator: relationsGen,
					literal: Formatter.format,
					limit: 3,
					coverage: noCoverage,
					caseHang
				},
				(r) =>
					Effect.gen(function* () {
						const counts = yield* orderedAt(r)
						assert.ok(counts.push > 0, `r at ${r}: the order pushes its objects`)
						assert.ok(
							counts.readyFirst <= heapBound(counts.push),
							`r at ${r}: ${counts.readyFirst} comparisons over ${counts.push} pushes`
						)
					})
			)
		)
	)
})
