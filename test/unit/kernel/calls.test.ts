/**
 * The counts of calls hold the counted work's calls alone (test/support/kernel/calls.ts, child-counts.ts). V8's counts are
 * process-wide, so a window that gives up a turn of its event loop counts whatever the process runs in it: a worker's
 * next unit evaluating its module, a stopped case's cleanup, any other fiber (test/unit/sql/scope's affinity, red once
 * under load and green alone). A count of work that waits on nothing is one synchronous block in the test's process, and
 * work that waits is counted in a process of its own, a counting child that runs nothing else.
 *
 * Each case counts `tick` (calls.fixtures.ts) over work that ticks a drawn number of times, beside strays that tick a
 * drawn number of times: in this process's event loop, a microtask, a macrotask and a stray evaluation of a module that
 * ticks as it is evaluated, all queued before the count.
 *
 * Oracle: specification, the count is the work's ticks exactly, whatever the strays tick.
 *
 * Features: strays that tick, none.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Cause, Effect, Exit } from "effect"
import { callCounts } from "#test/support/kernel/calls.ts"
import { countedInChild } from "#test/support/kernel/child-counts.ts"
import {
	sites,
	strayModule,
	type Ticking,
	tickingGen,
	ticks
} from "#test/unit/kernel/calls.fixtures.ts"

type Strays = "strays that tick" | "no stray"

/** Strays that tick `stray` times each, queued on this process's event loop: a microtask, a macrotask, a module's evaluation. */
const queueStrays = (stray: number, at: number): void => {
	queueMicrotask(() => {
		ticks(stray)
	})
	setImmediate(() => {
		ticks(stray)
	})
	void import(strayModule(stray, at))
}

/** The strays' feature: whether they tick. */
const strays = (c: Case<Strays>, t: Ticking): void =>
	c.note(t.stray === 0 ? "no stray" : "strays that tick")

const windowKill = Object.freeze({
	file: "test/support/kernel/calls.ts",
	original:
		"\t\tconst exit = Effect.runSyncExitWith(context)(effect)\n\t\tconst coverage = take(session)\n\t\treturn Effect.map(exit, (value) => [value, coverage] as const)\n",
	replacement:
		"\t\treturn Effect.andThen(\n\t\t\tEffect.promise(() => new Promise((resolve) => setImmediate(resolve))),\n\t\t\tEffect.map(effect, (value) => [value, take(session)] as const)\n\t\t)\n"
})

/** A synchronous count holds its work's calls alone, whatever this process queued beside it. */
export const aSynchronousCountHoldsItsWorksCallsAloneWhateverTheProcessQueuedBesideIt =
	property.exhaust(finite(tickingGen), {
		needs: {},
		situations: ["strays that tick", "no stray"] satisfies ReadonlyArray<Reached<Strays>>,
		check: (_, c: Case<Strays>) => (t) =>
			Effect.gen(function* () {
				strays(c, t)
				queueStrays(t.stray, t.work)
				const [, counted] = yield* callCounts(
					Effect.sync(() => ticks(t.work)),
					sites
				)
				assert.equal(counted.tick, t.work, "the count holds the work's ticks alone")
			}),
		oracle: { kind: "specification", name: "the count is the work's ticks exactly" },
		box: "work of 1, 7 or 40 ticks, beside a microtask, a macrotask and a module evaluation each of 0, 3 or 50 ticks",
		kept: [],
		kills: [
			{
				...windowKill,
				why: "The window gives up a turn of the event loop before its work runs, as the window that awaited the inspector's posts did, so the strays queued beside it tick inside it and the count holds their calls."
			}
		]
	})

/** Work that waits cannot be counted in the test's process: in a synchronous count it dies, a defect. */
export const workThatWaitsDiesInASynchronousCount = property.exhaust(finite(tickingGen), {
	needs: {},
	situations: [],
	check: () => (t) =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				callCounts(
					Effect.andThen(
						Effect.promise(() => Promise.resolve(0)),
						Effect.sync(() => ticks(t.work))
					),
					sites
				)
			)
			assert.ok(
				Exit.isFailure(exit) && Cause.hasDies(exit.cause),
				"a count of work that waits dies"
			)
		}),
	oracle: { kind: "specification", name: "a synchronous count of work that waits dies" },
	box: "work of 1, 7 or 40 ticks after a wait on a promise",
	kept: [],
	kills: [
		{
			...windowKill,
			why: "The window runs its work as a fiber, so work that waits is counted across the turns it gives up, and the count of it succeeds."
		}
	]
})

/** A counting child's count holds its work's calls alone, whatever the test's process runs beside it. */
export const aCountingChildsCountHoldsItsWorksCallsAloneWhateverTheTestsProcessRunsBesideIt =
	property.exhaust(finite(tickingGen), {
		needs: {},
		situations: ["strays that tick", "no stray"] satisfies ReadonlyArray<Reached<Strays>>,
		check: (_, c: Case<Strays>) => (t) =>
			Effect.gen(function* () {
				strays(c, t)
				queueStrays(t.stray, t.work + 1000)
				const counted = yield* countedInChild<number>(
					{ module: "test/unit/kernel/calls.fixtures.ts", name: "waitingTicks" },
					{ work: t.work }
				)
				assert.equal(counted, t.work, "the child's count holds its work's ticks alone")
			}),
		oracle: { kind: "specification", name: "the child's count is its work's ticks exactly" },
		box: "work of 1, 7 or 40 ticks after a read of a file, beside a microtask, a macrotask and a module evaluation of the test's process each of 0, 3 or 50 ticks",
		kept: [],
		kills: [
			{
				file: "test/support/kernel/child-counts.ts",
				original:
					"\t\tconst ran = yield* run(\n\t\t\tprocess.execPath,\n\t\t\t[...hardenedNode, entry, at.module, at.name, jsonText(argument)],\n\t\t\trunOptions\n\t\t)\n",
				replacement:
					'\t\tconst coverage = yield* Effect.promise(() => import("#test/support/kernel/coverage.ts"))\n\t\tconst loaded = yield* Effect.promise(() => import(import.meta.dirname + "/../../../" + at.module))\n\t\tconst session = coverage.counting()\n\t\tconst inProcess = {\n\t\t\tsites: (effect: Effect.Effect<unknown>, sites: Record<string, { file: string; name: string }>) =>\n\t\t\t\tEffect.suspend(() => {\n\t\t\t\t\tcoverage.restart(session)\n\t\t\t\t\tcoverage.take(session)\n\t\t\t\t\treturn Effect.map(effect, (value) => [value, coverage.siteCounts(coverage.take(session), sites)])\n\t\t\t\t})\n\t\t}\n\t\tconst value = yield* Effect.scoped(loaded[at.name](argument, inProcess))\n\t\tconst ran = { status: 0, stderr: "", stdout: jsonText(value) }\n',
				why: "The work runs in the test's process, its window holding its wait, so the strays the test's process queued tick inside the window and its count holds their calls."
			}
		]
	})
