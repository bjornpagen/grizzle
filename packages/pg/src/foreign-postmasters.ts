import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Console, Effect } from "effect"
import { postmastersOf } from "#pg/installation.ts"

/**
 * Prints every postmaster that runs the bin/postgres of a tree its arguments name (installation.ts postmastersOf), one
 * line each: its port, its data directory, its process and its executable as the kernel names it. build.sh refuses the
 * exchange while one runs, unless --force is given. Its arguments are the trees; none is refused.
 */
const main = Effect.gen(function* () {
	const trees = yield* Effect.sync((): ReadonlyArray<string> => process.argv.slice(2))
	if (trees.length === 0) {
		return yield* Effect.die(new Error("usage: foreign-postmasters.ts <tree> [tree...]"))
	}
	const postmasters = yield* postmastersOf(trees)
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
