import { Effect } from "effect"
import {
	type CountedFunction,
	type Coverage,
	counting,
	keptCounts,
	restart,
	siteCounts,
	take
} from "#test/support/kernel/coverage.ts"

/**
 * The counts of `effect` alone, with its exit: one synchronous block from the counts' restart to their take, in which
 * the effect runs to its end (Effect.runSyncExitWith), so no other work of the process, which takes turns of its event
 * loop, runs inside it: a worker's next unit evaluating its module, a stopped case's cleanup or any other fiber. The
 * counts are V8's, process-wide, so a window that spanned a turn counted whatever ran in it, which load moved
 * (test/unit/sql/scope's affinity, red once under load and green alone). An effect that waits on anything, which no
 * synchronous block can run, dies a defect here: work that waits on I/O is counted in a process of its own
 * (kernel/child-counts.ts).
 */
const counted = <A, E, R>(
	effect: Effect.Effect<A, E, R>
): Effect.Effect<readonly [A, Coverage], E, R> =>
	Effect.flatMap(Effect.context<R>(), (context) => {
		const session = counting()
		restart(session)
		take(session)
		const exit = Effect.runSyncExitWith(context)(effect)
		const coverage = take(session)
		return Effect.map(exit, (value) => [value, coverage] as const)
	})

/**
 * How many times each site's functions were called while `effect` ran, with its value: work counted, never time, so a
 * guard over it never depends on the machine. The effect runs alone, in one synchronous block (`counted`), and each
 * count starts from cold, so the counts are the effect's own, whatever the process ran before or runs beside it. A site
 * matches every function of its name in its module.
 */
export const callCounts = <A, E, R, K extends string>(
	effect: Effect.Effect<A, E, R>,
	sites: Readonly<Record<K, CountedFunction>>
): Effect.Effect<readonly [A, Readonly<Record<K, number>>], E, R> =>
	Effect.map(counted(effect), ([value, scripts]) => [value, siteCounts(scripts, sites)] as const)

/**
 * How many times every function of the modules `kept` keeps was called while `effect` ran, with its value: callCounts'
 * counts, of every function rather than of named sites (kernel/coverage.ts keptCounts), in the same one synchronous
 * block (`counted`). A module is kept by its path from the packages' directory.
 */
export const everyCallCount = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	kept: (file: string) => boolean
): Effect.Effect<readonly [A, ReadonlyMap<string, number>], E, R> =>
	Effect.map(counted(effect), ([value, scripts]) => [value, keptCounts(scripts, kept)] as const)
