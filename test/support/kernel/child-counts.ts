import type { Json } from "@bjornpagen/grizzle-text/utf8"
import { assert } from "@bjornpagen/testing/assert"
import { Effect, type FileSystem, type Path, type Scope } from "effect"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import type { CountedFunction } from "#test/support/kernel/coverage.ts"
import { hardenedNode, run, runOptions } from "#test/support/process.ts"

/**
 * Counting work that waits on I/O: a process of its own runs it (kernel/count-child.ts), so the counts of its windows are
 * its calls alone. V8's counts are process-wide, and a window that holds a wait holds every turn of the event loop the
 * wait gives up, in which anything else the process runs is counted beside the work: in a test's process, a worker's
 * next unit evaluating its module, a stopped case's cleanup. A process that runs nothing but the work gives those turns
 * to nothing else. Work that waits on nothing is counted in the test's own process, in one synchronous block
 * (kernel/calls.ts).
 */

/**
 * The windows a counting child hands its work, each counting the calls its effect makes, which may wait on I/O: of
 * named sites (`sites`, kernel/calls.ts callCounts' counts), or of every function of the modules `kept` keeps (`every`,
 * kernel/calls.ts everyCallCount's), each by its module's path from the packages' directory, place and name.
 */
export interface ChildCounts {
	readonly sites: <A, E, R, K extends string>(
		effect: Effect.Effect<A, E, R>,
		sites: Readonly<Record<K, CountedFunction>>
	) => Effect.Effect<readonly [A, Readonly<Record<K, number>>], E, R>
	readonly every: <A, E, R>(
		effect: Effect.Effect<A, E, R>,
		kept: (file: string) => boolean
	) => Effect.Effect<readonly [A, ReadonlyMap<string, number>], E, R>
}

/**
 * Work a counting child runs: given its argument, a JSON value, and the child's windows, an effect whose value the child
 * prints as JSON, over the Node platform's services and a scope the child closes when it ends. It fails with nothing:
 * a failure of the work is its defect, which ends the child with its cause on its standard error.
 */
export type ChildWork<I extends Json> = (
	argument: I,
	counts: ChildCounts
) => Effect.Effect<unknown, never, FileSystem.FileSystem | Path.Path | Scope.Scope>

/**
 * Where a counting child finds its work: the module, by its path from the repository's root, and the name it exports
 * the work under. The child imports that module and the counter alone, never the test runner.
 */
export interface ChildWorkAt {
	readonly module: string
	readonly name: string
}

/** The counting child's entry, by its path from the repository's root. */
const entry = "test/support/kernel/count-child.ts"

/**
 * The value of the work at `at` run on `argument` in a counting child, as the child printed it, one JSON value: its
 * counts are its own, whatever this process runs meanwhile.
 */
export const countedInChild = <A>(at: ChildWorkAt, argument: Json) =>
	Effect.gen(function* () {
		const ran = yield* run(
			process.execPath,
			[...hardenedNode, entry, at.module, at.name, jsonText(argument)],
			runOptions
		)
		assert.equal(ran.status, 0, `the counting child of ${at.module} ${at.name}: ${ran.stderr}`)
		return trustedJson<A>(ran.stdout)
	})
