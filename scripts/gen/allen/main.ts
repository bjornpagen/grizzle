#!/usr/bin/env -S node

import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, FileSystem, Path } from "effect"
import { allenTableSource } from "#scripts/gen/allen/generate.ts"

/**
 * Writes packages/engine/src/allen/table.generated.ts from the generator: `node scripts/gen/allen/main.ts`. The allen unit
 * test regenerates the table and compares it with the committed file, so a stale table fails the tests.
 */
const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const target = path.join(
		import.meta.dirname,
		"../../../packages/engine/src/allen/table.generated.ts"
	)
	yield* fs.writeFileString(target, allenTableSource())
	yield* Console.log(`wrote ${target}`)
})

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)))
