import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, FileSystem, String as Str } from "effect"
import { assert } from "#test/support/assert.ts"
import { repoRoot } from "#test/support/files.ts"
import { documentedTexts } from "#test/support/refusals.ts"

/**
 * The agent skill: one file, packages/grizzle/skills/grizzle/SKILL.md, shipped in the package (package.json `files`).
 *
 * Every refusal the command line prints, every applied-edit refusal of migrate and every stage's fix is documented in
 * the skill, word for word, so an agent that reads a refusal finds its fix there (packages/grizzle/src/cli/refusals.ts).
 */
const skillText = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	return yield* fs.readFileString(`${repoRoot}packages/grizzle/skills/grizzle/SKILL.md`)
})

layer(NodeServices.layer, { excludeTestServices: true })("the grizzle skill", (it) => {
	it.effect("documents every refusal and every stage's fix word for word", () =>
		Effect.gen(function* () {
			const skill = yield* skillText
			const missing = Arr.filter(documentedTexts(), (t) => !Str.includes(t)(skill))
			assert.deepEqual(missing, [])
		})
	)
})
