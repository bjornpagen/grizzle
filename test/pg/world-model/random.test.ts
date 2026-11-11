import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required, type Situations } from "@grizzle/testing/features"
import { v8Coverage } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	drawnRealities,
	driveProgram,
	everyAction,
	generatedDocsInstalls,
	noCheck,
	noLead,
	noteNaming,
	programCaseGen,
	stage
} from "#test/support/worlds/drive/suite.ts"
import { realize } from "#test/support/worlds/execute/index.ts"
import { drawnNameFeatures } from "#test/support/worlds/generate/names.ts"
import { everyRole, noAims } from "#test/support/worlds/generate/weights.ts"
import type { WorldFeature } from "#test/support/worlds/model/types.ts"

/**
 * Random programs over the documents base, judged by the worlds model at every step: a case draws an installation of
 * the base's worlds, then, once its names exist, a lawful reality, and then a short program, each action drawn under
 * the case's swarm weights (every action kind, live, stale and wild inputs in drawn shares) from the model's state as
 * the program reaches it. The driver (test/support/worlds/drive) performs each action on the realized world and holds
 * it to the model: the observation is one the model allows, no value hidden from the acting session appears in
 * anything grizzle answered, every stored base and derived relation holds exactly the model's facts, every open
 * session's connection probes as the model expects, and the model's state keeps every invariant.
 *
 * The search is guided by block coverage of the worlds code: the compiler's world analysis and role DDL, and the
 * adapter's claims, Db.open and the drift check. The file runs among the guided suites, whose processes start V8's block
 * coverage before the code under test loads, so V8 counts the blocks of every guide file; its steered phase keeps each
 * case that ran a block no earlier case ran, and mutates those. A tamper changes database settings, so the file runs in
 * a database of its own.
 *
 * The suite is the unbiased explorer: it aims at nothing, so it requires only what its generator reaches by construction
 * (`required`), and the aimed suites of each area require that area's features of the worlds feature map.
 *
 * Plants (main's test phase): worlds-pool-claims-outlive-transaction.patch, worlds-laws-foreign-keys-dropped.patch.
 */
const guide: Arr.NonEmptyReadonlyArray<string> = [
	"packages/engine/src/schema/world.ts",
	"packages/engine/src/physical/ddl/roles.ts",
	"packages/grizzle/src/adapter/db/claims.ts",
	"packages/grizzle/src/adapter/db/open.ts",
	"packages/grizzle/src/adapter/admission/drift.ts",
	"packages/grizzle/src/adapter/admission/roles.ts",
	"packages/engine/src/write/entry/precheck.ts"
]

/**
 * What every population of random programs reaches by construction: each invariant the driver holds whose triggering
 * actions the swarm draws in nearly every program (an open, a write, a commit, a migration, a catalog change, a Db's
 * transaction, a delete); each feature of the names a generated installation draws from the kernel dictionary
 * (generate/names.ts), each in at least one case in eight; and a base object or a role entry named after a PostgreSQL
 * type under the installation's schemas first on its owner's search path, about one case in five. Left out:
 * no-hidden-value, which needs an action to meet a fact outside the actor's world, as the reality and the actor happen
 * to give it (once to thrice in 48 cases of the model's own run of the suite), and is the errors suite's to require.
 */
const situations: Situations<WorldFeature> = [
	["grizzle-first path", "catalog-type name"],
	...Arr.map(drawnNameFeatures, (feature): WorldFeature => `name:${feature}`),
	"invariant:laws-hold",
	"invariant:claims-end-with-transaction",
	"invariant:role-ends-with-transaction",
	"invariant:login-isolation",
	"invariant:deleted-means-gone",
	"invariant:least-privilege"
]

const cases = 48
const steps = 12
const name = "every random program's observations and probes agree with the model"

layer(Substrate.isolatedLayer, { excludeTestServices: true })(
	"the worlds model: random programs",
	(it) => {
		it.effect(name, (ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const sense = yield* v8Coverage((url) =>
						Arr.some(guide, (file) => Str.endsWith(file)(url))
					)
					return yield* explore(
						{
							oracle: {
								kind: "second-implementation",
								name: "the worlds model (test/support/worlds/model), stepped beside every action: its allowed observations, its stored relations and every open session's probe"
							},
							suite: "pg/world-model/random",
							/**
							 * Random programs aim at nothing, the swarm's weights alone keeping them diverse: aimed at every required
							 * feature, half of each program's draws went to whatever lay one step from one, and 60 cases took 45
							 * minutes and read no relation at all (no via:* feature reached).
							 */
							draw: drawn(
								programCaseGen(
									generatedDocsInstalls,
									{ kinds: everyAction, roles: everyRole, aims: noAims, lead: noLead },
									steps
								)
							),
							literal: Formatter.format,
							coverage: required<WorldFeature>(situations, { cases, sense }),
							kept: [],
							runs: cases,
							shrink: { kind: "bounded", candidates: 200 },
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(pc, c) =>
							Effect.scoped(
								Effect.gen(function* () {
									const world = yield* realize(pc.install, pc.ambient)
									noteNaming(pc, c)
									const staged = yield* stage(world, pc.install, c.draw, drawnRealities)
									yield* driveProgram(staged, pc, c, situations, noCheck)
								})
							)
					)
				})
			)
		)
	}
)
