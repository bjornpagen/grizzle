/**
 * A world's direct writers end with the case that began them (RealWorld.reset): a case that ends with a direct
 * transaction open, aborted or ended leaves no backend of the world's logins in a transaction, so no SERIALIZABLE
 * snapshot a direct writer took outlives the case that took it. A shared world (exhaustive.test.ts's slot world, the
 * education suites' one world) meets its next reset only when its next case comes, which a run of catalog-changing
 * cases on fresh worlds may hold off for minutes; a snapshot held that long keeps the cluster's SSI cleanup from
 * advancing for every file on it.
 *
 * One world of the documents installation is realized for the whole test and shared by every case, as a slot world is.
 * A case draws a reality and a short program of direct moves (BEGIN, statements, COMMIT or ROLLBACK, under drawn live,
 * stale and wild shares), each performed by the driver and held to the worlds model at every step (runStep), so it ends
 * however its draws leave it: its transaction open, aborted by a refusal, ended, or never begun. The case runs in a
 * scope of its own, and once that scope has closed, before the next case resets the world, the property reads the
 * world's database.
 *
 * Oracle: the specification. After the case, pg_stat_activity lists no backend of the world's database, other than
 * the substrate's own owner and superuser sessions, that is in a transaction, and no direct writer's backend at all.
 * Features: a case that ended with its direct transaction open, one that ended with it aborted, and one that ended with
 * none in progress.
 */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Option } from "effect"
import {
	caseGen,
	cases,
	docsWorld,
	type Ending,
	endingOf,
	leftQuery,
	situations
} from "#test/pg/world-model/sessions.fixtures.ts"
import { assert } from "#test/support/assert.ts"
import { pgCluster } from "#test/support/env.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { checkStart, runStep } from "#test/support/worlds/drive/index.ts"
import { drawAction, unnoted } from "#test/support/worlds/drive/suite.ts"
import { templateWorld } from "#test/support/worlds/execute/template.ts"
import { realityGen } from "#test/support/worlds/generate/reality.ts"
import { docsBase, docsInstall } from "#test/support/worlds/model/bases/docs.ts"
import { hostSchemaOf } from "#test/support/worlds/model/host.ts"
import { initialState } from "#test/support/worlds/model/step.ts"
import type { ModelState } from "#test/support/worlds/model/types.ts"

/**
 * The worlds model: a direct writer's case every direct writer a case begins ends with that case.
 *
 * Its pre-conversion budget: runs cases, coverage cases 4 * cases (test/pg/world-model/sessions.test.ts at d8eed1786).
 */
export const theWorldsModelADirectWritersCaseEveryDirectWriterACaseBeginsEndsWithThatCase =
	property.explore(caseGen, {
		needs: { docs: Substrate.freshOf(docsWorld) },
		situations: situations satisfies ReadonlyArray<Reached<Ending>>,
		check:
			({ docs }, c: Case<Ending>) =>
			(sc) =>
				Effect.flatMap(docs, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const s = yield* Substrate
							const world = yield* templateWorld(taken, Option.none())
							const host = hostSchemaOf(docsBase, world.names)

							const ended = yield* Effect.scoped(
								Effect.gen(function* () {
									const reality = c.draw(realityGen(docsBase, host))
									yield* world.reset(reality)
									const start = yield* checkStart(
										world,
										initialState(docsInstall, world.names, reality)
									)
									return yield* Effect.reduce(
										indices(sc.moves),
										(): ModelState => start,
										(state, index) =>
											Effect.map(
												runStep(
													world,
													state,
													drawAction(c.draw, state, sc.weights),
													index,
													unnoted
												),
												(stepped) => stepped.next
											)
									)
								})
							)
							c.note(endingOf(ended))
							const left = yield* s.admin.queryValues(leftQuery, [pgCluster.owner])
							assert.deepEqual(
								left,
								[],
								`after a case whose program left it so (${endingOf(ended)}), no backend of the world's logins is in a transaction and no direct writer's remains`
							)
						}),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "a case's end ends its direct writers: once its scope closes, no backend of the world's logins is in a transaction and no direct writer's backend remains"
		},
		budget: { runs: cases, steered: 4 * cases },
		kept: [],
		kills: []
	})
