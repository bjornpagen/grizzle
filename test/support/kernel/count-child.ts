/**
 * A counting child (kernel/child-counts.ts countedInChild): a process of its own that runs one piece of work that waits
 * on I/O and counts its calls. Its argv names the work's module, by its path from the repository's root, the name the
 * module exports it under, and its argument as JSON text; it imports that module and the counter alone, never the test
 * runner, runs the work over the Node platform's services in a scope it closes, and prints the work's value as one JSON
 * value on its standard output.
 *
 * Its windows (ChildCounts) may hold a wait: the process runs nothing but the work, so no turn of its event loop the
 * wait gives up runs anything else, and each window's counts are the calls of the work's effect inside it. Every module
 * the work loads is evaluated as it is imported, before its first window, or by the work itself. A window exists only
 * here, handed to the work, so no test's process holds one.
 */
import { pathToFileURL } from "node:url"
import { jsonText, type Json } from "@bjornpagen/grizzle-text/utf8"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { trusted, trustedJson } from "#compiler/core/trusted.ts"
import { defect } from "#compiler/plan/runtime.ts"
import type { ChildCounts, ChildWork } from "#test/support/kernel/child-counts.ts"
import {
	type Coverage,
	counting,
	keptCounts,
	restart,
	siteCounts,
	take
} from "#test/support/kernel/coverage.ts"

/** The calls `effect` makes, which may wait, in this process alone: from the counts' restart to their take. */
const windowed = <A, E, R>(
	effect: Effect.Effect<A, E, R>
): Effect.Effect<readonly [A, Coverage], E, R> =>
	Effect.gen(function* () {
		const session = counting()
		restart(session)
		take(session)
		const value = yield* effect
		return [value, take(session)] as const
	})

const counts: ChildCounts = {
	sites: (effect, sites) =>
		Effect.map(
			windowed(effect),
			([value, scripts]) => [value, siteCounts(scripts, sites)] as const
		),
	every: (effect, kept) =>
		Effect.map(windowed(effect), ([value, scripts]) => [value, keptCounts(scripts, kept)] as const)
}

const [module, name, argument] = process.argv.slice(2)
if (module === undefined || name === undefined || argument === undefined) {
	defect("a counting child runs with the work's module, its name and its argument")
}
const loaded = trusted<Readonly<Record<string, unknown>>>(
	await import(pathToFileURL(`${import.meta.dirname}/../../../${module}`).href)
)
const work = loaded[name]
if (typeof work !== "function") {
	defect(`${module} exports no work named ${name}`)
}
const value = await Effect.runPromise(
	Effect.scoped(trusted<ChildWork<Json>>(work)(trustedJson<Json>(argument), counts)).pipe(
		Effect.provide(NodeServices.layer)
	)
)
process.stdout.write(jsonText(trusted<Json>(value)))
