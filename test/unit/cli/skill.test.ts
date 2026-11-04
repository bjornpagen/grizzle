import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, FileSystem, String as Str } from "effect"
import { skillTargets } from "#cli/skill.ts"
import { cli, cliClock, workspace } from "#test/pg/cli/support.ts"
import { assert } from "#test/support/assert.ts"
import { repoRoot } from "#test/support/files.ts"
import { documentedTexts } from "#test/support/refusals.ts"

/** The clock the in-process command lines of this file read. */
const nextNow = cliClock()

/**
 * The agent skill and `grizzle skill`: one file, packages/grizzle/skills/grizzle/SKILL.md, shipped in the package.
 *
 * - Every refusal the command line prints, every applied-edit refusal of migrate and every stage's fix is documented
 *   in the skill, word for word, so an agent that reads a refusal finds its fix there (packages/grizzle/src/cli/refusals.ts).
 * - `grizzle skill` copies it to .claude/skills/grizzle/SKILL.md and .agents/skills/grizzle/SKILL.md, needs no
 *   configuration, and a rerun replaces a stale copy.
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

	it.effect(
		"grizzle skill installs it for Claude and other agents, and a rerun replaces a stale copy",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const skill = yield* skillText
				const ws = yield* workspace("skill")
				const first = yield* cli(ws, ["skill"], nextNow(), {})
				assert.equal(first.code, 0, first.stderr)
				for (const target of skillTargets) {
					const text = yield* fs.readFileString(`${ws}/${target}`)
					assert.equal(text, skill)
				}
				yield* fs.makeDirectory(`${ws}/.claude/skills/grizzle`, { recursive: true })
				yield* fs.writeFileString(`${ws}/.claude/skills/grizzle/SKILL.md`, "stale\n")
				const rerun = yield* cli(ws, ["skill"], nextNow(), {})
				assert.equal(rerun.code, 0)
				const text = yield* fs.readFileString(`${ws}/.claude/skills/grizzle/SKILL.md`)
				assert.equal(text, skill)
			})
	)
})
