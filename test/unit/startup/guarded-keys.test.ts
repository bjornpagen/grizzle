/**
 * Startup and write compilation over k guarded keys, counted and never timed (test/support/kernel/calls.ts), so no
 * verdict depends on the machine.
 *
 * A relation T carrying k keys over selected sides, `key(on(select(T, kind = j), "a"))`, each a UNIQUE over law columns
 * guarded by its own predicate, beside a relation U with no law, and a login whose workload holds the ChangeSet that
 * inserts into both: `grizzle generate` and DbLayer.make, which compiles the ChangeSet as every db.apply does.
 *
 * - Each relation's unique objects beyond its primary key are decided once, as its law model is built (uniques.ts
 *   beyondPrimary, RelationLaws.beyond), and the law model specializes the schema once: no write compile, role probe or
 *   second specialization decides them again.
 * - A guard's predicate is encoded once, where its unique object is built, and compared by that text: the canonical
 *   encoder's calls grow linearly in k, where comparing every two guards by encoding both grew with k squared.
 *
 * - The installation's objects are ordered with n log n comparisons (obligations/graph.ts order), where re-sorting every
 *   ready object at each step grew with their number squared: over r relations with no law between them, every table
 *   ready at once, its comparisons at 2r are at most linear's bound over those at r.
 *
 * The boxes are exhausted: k even from 6 to 10, and r from 20 to 40 by tens, each against twice it.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { int, map } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, FileSystem, Formatter, Layer, Record as Rec } from "effect"
import { DbLayer } from "#adapter/public/layer.ts"
import { resolveConfig } from "#cli/config.ts"
import { snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { login } from "#compiler/program/workload/login.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { key, on, relation, schema, select, type Statement } from "#compiler/public/schema.ts"
import { role } from "#compiler/schema/world.ts"
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
import { type CallSite, callCounts } from "#test/support/kernel/calls.ts"
import { caseHang } from "#test/support/limits.ts"
import { clusterPool } from "#test/support/pg.ts"
import { ownedInput } from "#test/support/policy.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"
import { upTo } from "#test/support/up-to.ts"

/** The bound on growth from k to 2k: linear, with ε for the parts that do not grow. */
const linear = 2.5

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
				connection: offlineOwner
			})
			const ws = yield* workspace("guarded")
			const [generated, generate] = yield* callCounts(
				cliOver(ws, config, ["generate", configName, "--name", "init"], nextNow()),
				sites
			)
			assert.equal(generated.code, 0, generated.stderr)
			const resolved = yield* resolveConfig(config, `${ws}/${configName}`)
			const directory = defined(resolved.schemas[0], "the configured schema").directory
			const text = yield* fs.readFileString(`${directory}/${snapshotFileName}`)
			const [, built] = yield* callCounts(
				Effect.scoped(
					Layer.build(
						DbLayer.make({
							...offlineConnection,
							pool: clusterPool,
							login: server,
							snapshot: snapshotJson(text)
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

/** The box of guarded keys: k even, from 6 to 10, each measured against twice it. */
const keysGen = map(int(3, 5), (half) => 2 * half)

layer(NodeServices.layer, { excludeTestServices: true })("guarded keys at startup", (it) => {
	it.effect(
		"decide each relation's objects beyond its primary key once, specialize once, and encode linearly in k",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
						suite: "unit/startup/guarded-keys",
						generator: keysGen,
						literal: Formatter.format,
						limit: 3,
						coverage: noCoverage,
						caseHang
					},
					(k) =>
						Effect.gen(function* () {
							const small = yield* stepsAt(k)
							const large = yield* stepsAt(2 * k)
							const at = `k at ${k} against ${2 * k}`
							for (const step of stepNames) {
								for (const steps of [small, large]) {
									assert.equal(
										steps[step].compileLaws,
										1,
										`${at}: ${step} compiles the law model once`
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
								assert.ok(
									large[step].encode <= linear * small[step].encode,
									`${at}: ${step}'s encodings grow from ${small[step].encode} to ${large[step].encode}`
								)
							}
						})
				)
			)
	)
})

/** The comparisons ordering an installation's objects, the order's one comparator of two object keys. */
const orderSites = {
	compareKeys: { file: "packages/engine/src/physical/obligations/graph.ts", name: "compareKeys" }
} satisfies Readonly<Record<string, CallSite>>

/** The comparisons ordering the installation of r relations, each keyed by its id, with no law between them. */
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
		return counts.compareKeys
	})

/** The box of relations the order holds: r from 20 to 40 by tens, each measured against twice it. */
const relationsGen = map(int(2, 4), (tens) => 10 * tens)

layer(NodeServices.layer, { excludeTestServices: true })("the install order", (it) => {
	it.effect("compares its objects n log n times, linearly in r within the bound", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					box: { kind: "unstated" },
					oracle: { kind: "unstated" },
					suite: "unit/startup/install-order",
					generator: relationsGen,
					literal: Formatter.format,
					limit: 3,
					coverage: noCoverage,
					caseHang
				},
				(r) =>
					Effect.gen(function* () {
						const small = yield* orderedAt(r)
						const large = yield* orderedAt(2 * r)
						assert.ok(
							large <= linear * small,
							`r at ${r} against ${2 * r}: the order's comparisons grow from ${small} to ${large}`
						)
					})
			)
		)
	)
})
