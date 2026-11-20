/**
 * How the runner runs a case that never finishes (the runner's inline evaluator, which a search nested in a case runs
 * on, and which evaluates a case as a worker of the pool does): when the search itself is interrupted, every case it
 * started is interrupted or has ended, so the finalizers of each release what it holds (a leased session's open
 * transaction, in the database suites). That a hung case the case deadline stops releases what it holds too, before
 * the hang is reported, is the library's own suite's.
 *
 * The property exhausts the place, in start order, of the case that hangs. Every case holds a resource, counting its
 * acquisition and its release; the hanging case never finishes. The search runs as a fiber of its own, which is
 * interrupted once the hanging case has started; the oracle is the count itself: every acquisition the search made has
 * its release by the time the interruption returns. A case left holding never releases, and the runner's case deadline
 * names it: no clock decides the verdict. The nested search runs under the worker's own runner services (test/support/
 * runner.ts workerCluster), as every nested search does; its property needs none, so no cluster is reached. Features: the hanging case
 * first, and after finished cases.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { inlineRun, searchInline } from "@bjornpagen/testing/inline"
import { type Case, property } from "@bjornpagen/testing/property"
import { fnv1a32 } from "@bjornpagen/testing/random"
import { Deferred, Effect, Fiber } from "effect"
import { workerCluster } from "#test/support/runner.ts"
import { type Held, interruptedGen } from "#test/unit/oracle-runner/case-run.fixtures.ts"

/** A generated suite's cases are interrupted, or have ended, and release what they hold, when the check itself is interrupted. */
export const aGeneratedSuitesCasesAreInterruptedOrHaveEndedAndReleaseWhatTheyHoldWhenTheCheckItselfIsInterrupted =
	property.exhaust(finite(interruptedGen), {
		needs: { cluster: workerCluster },
		situations: ["the first case hangs", "after finished cases"] satisfies ReadonlyArray<
			Reached<Held>
		>,
		check:
			({ cluster }, c: Case<Held>) =>
			(drawnSearch) =>
				Effect.gen(function* () {
					const counts = { started: 0, finished: 0, released: 0 }
					const hung = yield* Deferred.make<void>()
					const holding = (index: number) =>
						Effect.scoped(
							Effect.gen(function* () {
								yield* Effect.acquireRelease(Effect.void, () =>
									Effect.sync(() => {
										counts.released++
									})
								)
								if (index === drawnSearch.hangs) {
									yield* Deferred.succeed(hung, undefined)
									return yield* Effect.never
								}
								yield* Effect.yieldNow
								counts.finished++
							})
						)
					const id = `case-run.test.ts#interrupted/${drawnSearch.hangs}`
					const services = yield* cluster
					const check = yield* Effect.forkChild(
						Effect.provide(
							searchInline(
								property.explore(int(0, 2 ** 31 - 1), {
									needs: {},
									situations: [],
									check: () => () => Effect.suspend(() => holding(counts.started++)),
									oracle: {
										kind: "specification",
										name: "a search planted to hang one case, interrupted from outside"
									},
									kept: [],
									kills: []
								}),
								inlineRun(id, fnv1a32(id))
							),
							services
						)
					)
					yield* Deferred.await(hung)
					yield* Fiber.interrupt(check)
					assert.equal(counts.released, counts.started)
					c.note(counts.finished > 0 ? "after finished cases" : "the first case hangs")
				}),
		oracle: {
			kind: "specification",
			name: "every acquisition of an interrupted search has its release"
		},
		box: "every place of the hanging case among the first six cases the search starts",
		kept: [],
		kills: []
	})
