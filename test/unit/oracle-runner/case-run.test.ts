/**
 * How a generated suite runs a case that never finishes (the library's explore, which every Effect suite runs on, and
 * its hang guard): the case is interrupted, so its finalizers release what it holds (a
 * leased session's open transaction, in the database suites), whether the hang guard fires or the test itself is
 * interrupted.
 *
 * The case runs as a fiber of its own; its release follows the interruption of the check. A case left running
 * never releases, and the test's own timeout, the hang guard, names it: no clock decides the verdict.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { int } from "@grizzle/testing/gen"
import type { ShrinkBudget } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Deferred, Duration, Effect, Fiber, Formatter } from "effect"
import { assert } from "#test/support/assert.ts"

/** A case that holds a resource and never finishes: it counts its start and its release. */
const holdForever = (counts: { started: number; released: number }) =>
	Effect.scoped(
		Effect.gen(function* () {
			yield* Effect.acquireRelease(
				Effect.sync(() => {
					counts.started++
				}),
				() =>
					Effect.sync(() => {
						counts.released++
					})
			)
			return yield* Effect.never
		})
	)

/** One case suffices: it hangs. No shrink candidate runs, since a hung case is reported as drawn. */
const neverShrunk: ShrinkBudget = { kind: "bounded", candidates: 0 }

describe("a generated suite's case that never finishes", () => {
	it.effect(
		"fails as hung, releases what it holds, and is reported as drawn without shrinking",
		(ctx) =>
			Effect.gen(function* () {
				const counts = { started: 0, released: 0 }
				const failed = yield* Effect.flip(
					searched(
						ctx,
						explore(
							{
								suite: "unit/oracle-runner/case-hangs",
								draw: drawn(int(0, 2 ** 31 - 1)),
								literal: Formatter.format,
								coverage: noCoverage,
								kept: [],
								runs: 1,
								shrink: neverShrunk,
								concurrency: 1,
								steerEvery: 16,
								caseHang: Duration.millis(50)
							},
							() => holdForever(counts)
						)
					)
				)
				assert.equal(failed._tag, "CaseHung", "the case failed as hung")
				assert.ok(
					counts.started >= 1 && counts.released === counts.started,
					"every case it started released what it held"
				)
			})
	)

	it.live(
		"is interrupted, and releases what it holds, when the check itself is interrupted",
		(ctx) =>
			Effect.gen(function* () {
				const counts = { started: 0, released: 0 }
				const started = yield* Deferred.make<void>()
				const released = yield* Deferred.make<void>()
				const check = yield* Effect.forkChild(
					searched(
						ctx,
						explore(
							{
								suite: "unit/oracle-runner/case-interrupted",
								draw: drawn(int(0, 2 ** 31 - 1)),
								literal: Formatter.format,
								coverage: noCoverage,
								kept: [],
								runs: 1,
								shrink: neverShrunk,
								concurrency: 1,
								steerEvery: 16,
								caseHang: Duration.minutes(2)
							},
							() =>
								Effect.andThen(
									Deferred.succeed(started, undefined),
									holdForever(counts).pipe(Effect.ensuring(Deferred.succeed(released, undefined)))
								)
						)
					)
				)
				yield* Deferred.await(started)
				yield* Fiber.interrupt(check)
				yield* Deferred.await(released)
				assert.deepEqual(counts, { started: 1, released: 1 })
			})
	)
})
