/**
 * How a generated suite runs a case that never finishes (the library's explore, which every Effect suite runs on): when
 * the test itself is interrupted, the case is interrupted, so its finalizers release what it holds (a leased session's
 * open transaction, in the database suites). That a hung case its hang guard stops releases what it holds too, before
 * the hang is reported, is the library's own suite's (packages/testing/src/explore.test.ts).
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
import { Deferred, Effect, Fiber, Formatter } from "effect"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

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
								caseHang
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
