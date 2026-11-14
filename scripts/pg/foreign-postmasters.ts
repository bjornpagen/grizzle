import { NodeFileSystem, NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { postmastersOf } from "#scripts/pg/installation.ts"

/**
 * Prints every postmaster other than the selected cluster's that runs the bin/postgres of a tree its arguments name
 * (scripts/pg/installation.ts postmastersOf), one line each: its port, its data directory, its process and its
 * executable as the kernel names it. build.sh refuses the exchange while one runs, unless --force is given. Its
 * arguments are the selected cluster's data directory, then each tree; fewer are refused.
 */
const main = Effect.gen(function* () {
	const args = yield* Effect.sync((): ReadonlyArray<string> => process.argv.slice(2))
	const [selected, ...trees] = args
	if (selected === undefined || trees.length === 0) {
		return yield* Effect.die(
			new Error("usage: foreign-postmasters.ts <selected data directory> <tree> [tree...]")
		)
	}
	const postmasters = yield* postmastersOf(trees, selected)
	yield* Effect.forEach(
		postmasters,
		(postmaster) =>
			Console.log(
				`  port ${postmaster.port}, data directory ${postmaster.data}: postmaster ${postmaster.pid}, running ${postmaster.executable}`
			),
		{ discard: true }
	)
}).pipe(Effect.provide(NodeFileSystem.layer))

NodeRuntime.runMain(main)
