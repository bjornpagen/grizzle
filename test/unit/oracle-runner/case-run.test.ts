/**
 * How a generated suite runs a case that never finishes (the library's explore, which every Effect suite runs on): when
 * the test itself is interrupted, every case it started is interrupted or has ended, so the finalizers of each release
 * what it holds (a leased session's open transaction, in the database suites). That a hung case its hang guard stops
 * releases what it holds too, before the hang is reported, is the library's own suite's
 * (packages/testing/src/explore.test.ts).
 *
 * The property draws a search: how many cases it runs, how many at once, and which case in start order hangs. Every
 * case holds a resource, counting its acquisition and its release; the hanging case never finishes. The search runs as
 * a fiber of its own, which is interrupted once the hanging case has started; the oracle is the count itself: every
 * acquisition the search made has its release by the time the interruption returns. A case left holding never
 * releases, and the test's own timeout, the hang guard, names it: no clock decides the verdict.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink, type ShrinkBudget } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Deferred, Effect, Fiber, Formatter } from "effect"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** A drawn search: its rotating cases, how many run at once, and the case, in start order, that never finishes. */
interface Interrupted {
	readonly runs: number
	readonly concurrency: number
	readonly hangs: number
}

/** What the interrupted search held when it was interrupted: the hanging case alone, finished cases, running ones. */
type Held = "the first case hangs" | "after finished cases" | "beside running cases"

/** No candidate of a hung inner case runs: it is interrupted, never reported. */
const neverShrunk: ShrinkBudget = { kind: "bounded", candidates: 0 }

describe("a generated suite's cases", () => {
	it.live(
		"are interrupted, or have ended, and release what they hold, when the check itself is interrupted",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/oracle-runner/case-interrupted",
						draw: drawn((source): Interrupted => {
							const runs = source.draw(int(1, 6))
							return {
								runs,
								concurrency: source.draw(int(1, 3)),
								hangs: source.draw(int(0, runs - 1))
							}
						}),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "every acquisition of an interrupted search has its release"
						},
						coverage: required<Held>(
							["the first case hangs", "after finished cases", "beside running cases"],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(drawnSearch, c) =>
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
							const check = yield* Effect.forkChild(
								explore(
									{
										oracle: { kind: "unstated" },
										suite: "unit/oracle-runner/case-interrupted-inner",
										draw: drawn(int(0, 2 ** 31 - 1)),
										literal: Formatter.format,
										coverage: noCoverage,
										kept: [],
										runs: drawnSearch.runs,
										shrink: neverShrunk,
										concurrency: drawnSearch.concurrency,
										steerEvery: 16,
										caseHang
									},
									() => Effect.suspend(() => holding(counts.started++))
								)
							)
							yield* Deferred.await(hung)
							const running = counts.started - counts.finished - 1
							yield* Fiber.interrupt(check)
							assert.equal(counts.released, counts.started)
							c.note(
								running > 0
									? "beside running cases"
									: counts.finished > 0
										? "after finished cases"
										: "the first case hangs"
							)
						})
				)
			)
	)
})
