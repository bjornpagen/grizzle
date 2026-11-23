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
 * - Property: no connection the run opened is one this process still holds open once its fiber has ended: its Db's
 *   release has destroyed every session still open, or waited for the server to close it (adapter/wire/session.ts
 *   makePool, closedAll); the installation's release then ends the login's backends, every one on its way out
 *   (substrate.ts releaseRole), and would fail the case on one still held (SessionsLeaked).
 * - Oracle: the connections the cluster's budget holds open (substrate/budget.ts HeldConnection) as the fiber has
 *   ended, against those it held as the run began: a socket the Db's pool has destroyed is no longer held, whatever its
 *   backend's exit has reached, and one it neither destroyed nor saw closed is held, whatever its backend's exit has
 *   reached. Read in the step the interrupt returns to, so the server's speed decides nothing: an idle session whose
 *   release a pool skipped stays held until the server's close arrives, which pg_stat_activity, read after, may never
 *   show (5374a0575's red, 5 of 20 replays at four at once, none alone).
 */

import { assert, deepEquals } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Deferred, Effect, Exit, Fiber } from "effect"
import { type InterruptFeature, runGen } from "#test/pg/write/oracle/interrupted.fixtures.ts"
import { roleBackendsQuery } from "#test/support/kernel/sanitize.ts"
import { CurrentRestorage } from "#test/support/oracle/gen/restorage.ts"
import { CurrentPerturbation } from "#test/support/oracle/perturb.ts"
import type { WriteOracleFeature } from "#test/support/oracle/write/harness.ts"
import { installRun, resolveRun, runCases } from "#test/support/oracle/write/index.ts"
import { withTarget } from "#test/support/oracle/write/run.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * An interrupted write run a write run interrupted mid-case leaves no session of its writer open.
 *
 * Its budget is one case of each stream, the least the runner runs, at which its kill is killed: its kept case, run
 * before any stream, fails with the kill applied on every replay (8 of 8 alone under TEST_SEED=2219874524), and passes
 * without it (40 of 40 replays at four at once); and its floor's one case reaches its situation on every seed.
 */
export const anInterruptedWriteRunAWriteRunInterruptedMidCaseLeavesNoSessionOfItsWriterOpen =
	property.explore(runGen, {
		needs: { substrate: Substrate.fresh },
		situations: ["interrupted after a commit"] satisfies ReadonlyArray<Reached<InterruptFeature>>,
		check:
			({ substrate }, c: Case<InterruptFeature>) =>
			([run, perturbation, restorage]) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const resolved = c.draw(resolveRun(run))
						const installation = yield* installRun(run, resolved)
						const before = s.cluster.budget.held()
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
						const opened = Arr.filter(
							s.cluster.budget.held(),
							(h) => !Arr.some(before, (b) => deepEquals(b, h))
						)
						c.note(midCase ? "interrupted after a commit" : "ended before any commit")
						const login = installation.installed.as(
							installation.built.worldOf(installation.value).server
						).role
						const listed = yield* s.admin.queryValues(roleBackendsQuery(login), [])
						if (listed.length > 0) {
							c.note("a backend on its way out")
						}
						assert.deepEqual(
							opened,
							[],
							"the connections the interrupted run opened and still holds"
						)
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "the connections the process holds as the interrupted run's fiber has ended, against those it held as the run began: none of the run's left"
		},
		budget: { runs: 1, steered: 1 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/write/oracle/interrupted.test.ts#anInterruptedWriteRunAWriteRunInterruptedMidCaseLeavesNoSessionOfItsWriterOpen:1.0:1.2.b7p.1ek4.13zu.gpb.15ie.hzj.1ae7.2yq.jl4.18tp.9dj.z7b.7ui.13db.1amq.198e.1bii.qqy.11m8.osm.2sg.6ld.d8.sbg.6.k9e.2ua.110a.1.1.0.0.0.0.0.0.0.0.1.0.4.2.1.3.2.2.hfy.2.5no.18bn.1s6.icq.1c11.vbw.obp.on9.15xo.z02.5.1e5b.ow4.7yi.i6p.1dsq.fck.k0r.1ekf.qnk.g9i.16ih.vw9.14tu.cmq.1ck8.b5a.5pm.o89.ds3.b1u.83q.b1n.14ac.1ae0.dfu.0.0.2.2.5pf.5.0.1.w4.0.16wn.83p.1.7ec.3.17r8.2.q91.4.3ub.2.1pf.9.0.0.s8p.0.5gg.xs3.1.mlb.0.slj.2.kvj.1.jub.0.2.2.1.1.2.0.3.3.2.1.1.3.3.121i.1.11la.rgx.dk6.14qd.eyw.5.gls.13gk.a87.hh0.cry.gqt.bmg.cwo.1b.1cxw.17a1.7lh.8bs.186j.ic4.1ek9.f.y8.4ru.itu.8a3.19sr.q7v.vvp.1.0.0.0.0.1.0.0.0.0.0.0.0.0.2.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"5374a0575: a write run interrupted after its first commit, its Db's one session idle, whose pool's release returned with that session's connection open",
				since: "2026-11-23"
			}
		],
		kills: [
			{
				file: "packages/grizzle/src/adapter/wire/session.ts",
				original: "\t\t\treturn closedAll(closing)",
				replacement:
					'\t\t\treturn Effect.interruptible(Effect.all(Arr.map(closing, (session) => session.closed), { concurrency: "unbounded", discard: true }))',
				why: "A pool's release waits for each idle session's close in a fiber of its own, and in a fiber already interrupted every wait is interrupted before its fiber runs, so none reaches the destroy its session's close holds: the release returns with the idle sessions' connections open (5374a0575's red)."
			}
		]
	})
