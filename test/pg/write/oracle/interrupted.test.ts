/**
 * A write run interrupted mid-case leaves no session of its writer open (test/support/oracle/write/run.ts withTarget):
 * the writer's Db is opened in a scope nested inside its installation's, so whatever ends the cases ends the Db's
 * sessions with them, before any role of the installation is released. The write oracle's own suites cut a run only
 * where their deadline or their hang guard lands; this property cuts every run mid-case.
 *
 * A case is a small write run: a drawn schema (oracle/write/schema.ts), one or two drawn write cases and the planted
 * arms where the schema holds the planted group, under a drawn plan perturbation and restorage. It is installed in the
 * case's own scope (index.ts installRun), and its cases run on the writer's Db (withTarget, index.ts runCases) in a fiber
 * of their own, interrupted as soon as the run's first application has sent its flight and the server has answered it,
 * COMMIT included (its "flight logged"), or once the cases end, should none send one. Then, the fiber ended:
 *
 * - Property: no backend of the writer's login is a session this process still holds open (kernel/sanitize.ts
 *   heldBackends); the installation's release then ends the login's backends, every one on its way out
 *   (substrate.ts releaseRole), and would fail the case on one still held (SessionsLeaked).
 * - Oracle: pg_stat_activity's backends of the login, each by its client's port, against the connections the cluster's
 *   budget holds open (substrate/budget.ts HeldConnection): a socket the Db's pool has destroyed is no longer held,
 *   whatever its backend's exit has reached.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Formatter } from "effect"
import { ambientSessionGen } from "#test/support/ambient.ts"
import { assert } from "#test/support/assert.ts"
import { heldBackends, roleBackendsQuery } from "#test/support/kernel/sanitize.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	CurrentRestorage,
	type Restorage,
	restorageGen
} from "#test/support/oracle/gen/restorage.ts"
import {
	CurrentPerturbation,
	type Perturbation,
	perturbationGen
} from "#test/support/oracle/perturb.ts"
import {
	plantedCasesGen,
	type WriteOracleFeature,
	writeCaseGen
} from "#test/support/oracle/write/harness.ts"
import {
	installRun,
	resolveRun,
	runCases,
	type WriteRun
} from "#test/support/oracle/write/index.ts"
import { withTarget } from "#test/support/oracle/write/run.ts"
import { schemaSketchGen } from "#test/support/oracle/write/schema.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Where a run's cases stood when the property stopped them, and whether a backend of the writer's login was still
 * listed, its session ended and the backend on its way out, when the property read them.
 */
type InterruptFeature =
	| "interrupted after a commit"
	| "ended before any commit"
	| "a backend on its way out"

/** A small write run, drawn with the plan perturbation and the restorage it runs under. */
const runGen: Gen<readonly [WriteRun, Perturbation, Restorage]> = (source) =>
	[
		{
			schema: source.draw(schemaSketchGen),
			statistics: source.draw(element(["analyzed", "none"] as const)),
			ambient: source.draw(ambientSessionGen),
			cases: source.draw(array(writeCaseGen, { min: 1, max: 2 })),
			planted: source.draw(plantedCasesGen)
		},
		source.draw(perturbationGen),
		source.draw(restorageGen)
	] as const

layer(Substrate.layer, { excludeTestServices: true })("an interrupted write run", (it) => {
	it.effect("a write run interrupted mid-case leaves no session of its writer open", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "postgresql",
						name: "pg_stat_activity's backends of the writer's login, by client port, against the connections the process holds"
					},
					suite: "write/interrupted",
					draw: drawn(runGen),
					literal: Formatter.format,
					coverage: required<InterruptFeature>(["interrupted after a commit"], {
						cases: 4,
						sense: notesOnly
					}),
					kept: [],
					runs: 4,
					shrink: { kind: "bounded", candidates: 20 },
					steerEvery: 16,
					caseHang
				},
				([run, perturbation, restorage], c) =>
					Effect.gen(function* () {
						const s = yield* Substrate
						const resolved = c.draw(resolveRun(run))
						const installation = yield* installRun(run, resolved)
						const committed = yield* Deferred.make<void>()
						/** Hears the run's first flight answered, COMMIT included. */
						const note = (feature: WriteOracleFeature): void => {
							if (feature === "flight logged") {
								Deferred.doneUnsafe(committed, Exit.void)
							}
						}
						const cases = yield* Effect.forkChild(
							withTarget(installation, (t) => runCases(run, resolved, t, note)).pipe(
								Effect.provideService(CurrentPerturbation, perturbation),
								Effect.provideService(CurrentRestorage, restorage)
							)
						)
						const midCase = yield* Effect.raceFirst(
							Effect.as(Deferred.await(committed), true),
							Effect.as(Fiber.await(cases), false)
						)
						yield* Fiber.interrupt(cases)
						c.note(midCase ? "interrupted after a commit" : "ended before any commit")
						const login = installation.installed.as(
							installation.built.worldOf(installation.value).server
						).role
						const listed = yield* s.admin.queryValues(roleBackendsQuery(login), [])
						if (listed.length > 0) {
							c.note("a backend on its way out")
						}
						assert.deepEqual(
							heldBackends(listed, s.cluster.budget.held(), s.cluster.port),
							[],
							`the backends of ${login} whose session the interrupted run still holds`
						)
					})
			)
		)
	)
})
