#!/usr/bin/env -S node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Console, Effect, FileSystem, Path } from "effect"
import { categoriesSource } from "#scripts/gen/unicode/generate.ts"

/**
 * Writes packages/engine/src/scalar/regex/categories.generated.ts from the generator: `node scripts/gen/unicode/main.ts`.
 * The XSD reader's unit test regenerates the table and holds the committed one to it, so a Node that ships another
 * Unicode, or a stale table, fails the tests until it is regenerated.
 */
const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const target = path.join(
		import.meta.dirname,
		"../../../packages/engine/src/scalar/regex/categories.generated.ts"
	)
	yield* fs.writeFileString(target, categoriesSource())
	yield* Console.log(`wrote ${target}`)
})

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)))
