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
 * (`required`), and the aimed suites of each area require that area's features of the worlds feature map: a write
 * that breaks a law is the laws suite's (laws.test.ts) and the exhaustive box's.
 */
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { guide, situations, steps } from "#test/pg/world-model/random.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	drawnRealities,
	driveProgram,
	everyAction,
	generatedDocsInstalls,
	noCheck,
	noLead,
	noteNaming,
	programDraw,
	stage
} from "#test/support/worlds/drive/suite.ts"
import { realize } from "#test/support/worlds/execute/index.ts"
import { everyRole, noAims } from "#test/support/worlds/generate/weights.ts"
import type { WorldFeature } from "#test/support/worlds/model/types.ts"

/**
 * The worlds model, random programs: every random program's observations and probes agree with the model. Each case
 * realizes its world in a database of its own (Substrate.fresh), as the Vitest file ran in a database of its own, since
 * a tamper changes database settings. Random programs aim at nothing, the swarm's weights alone keeping them diverse:
 * aimed at every required feature, half of each program's draws went to whatever lay one step from one, and 60 cases
 * took 45 minutes and read no relation at all (no via:* feature reached).
 *
 * Its pre-conversion budget: runs 48, coverage cases 48 (test/pg/world-model/random.test.ts at c568eb123).
 */
export const everyRandomProgramsObservationsAndProbesAgreeWithTheModel = property.explore(
	programDraw(
		generatedDocsInstalls,
		{ kinds: everyAction, roles: everyRole, aims: noAims, lead: noLead },
		steps,
		situations
	),
	{
		needs: { own: Substrate.fresh },
		situations,
		guide: { blocks: guide },
		check:
			({ own }, c: Case<WorldFeature>) =>
			(pc) =>
				Effect.scoped(
					Effect.gen(function* () {
						const substrate = yield* own
						const world = yield* Effect.provideService(
							realize(pc.install, pc.ambient),
							Substrate,
							substrate
						)
						noteNaming(pc, c)
						const staged = yield* stage(world, pc.install, c.draw, drawnRealities)
						yield* driveProgram(staged, pc, c, situations, noCheck)
					})
				),
		oracle: {
			kind: "second-implementation",
			name: "the worlds model (test/support/worlds/model), stepped beside every action: its allowed observations, its stored relations and every open session's probe"
		},
		budget: { runs: 48, steered: 48 },
		kept: [],
		kills: []
	}
)
