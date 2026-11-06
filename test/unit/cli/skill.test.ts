/**
 * The agent skill: one file, packages/grizzle/skills/grizzle/SKILL.md, shipped in the package (package.json `files`).
 *
 * Every refusal the command line prints, every applied-edit refusal of migrate and every stage's fix is documented in
 * the skill, word for word, so an agent that reads a refusal finds its fix there (packages/grizzle/src/cli/refusals.ts).
 * The box is the refusal table itself, every text of it.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Effect, FileSystem, Formatter } from "effect"
import { containsText, nonEmpty } from "#test/support/assert.ts"
import { repoRoot } from "#test/support/files.ts"
import { caseHang } from "#test/support/limits.ts"
import { documentedTexts } from "#test/support/refusals.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the grizzle skill", (it) => {
	it.effect("documents every refusal and every stage's fix word for word", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const skill = yield* fs.readFileString(
					`${repoRoot}packages/grizzle/skills/grizzle/SKILL.md`
				)
				const texts = nonEmpty(documentedTexts(), "the refusal table documents texts")
				return yield* exhaust(
					{
						suite: "unit/cli/skill",
						generator: element(texts),
						literal: Formatter.format,
						limit: texts.length,
						coverage: noCoverage,
						caseHang,
						box: "every text of the refusal table: each refusal's problem and fix, each applied-edit phrase and each stage's fix",
						oracle: { kind: "specification", name: "the shipped skill, which quotes every refusal" }
					},
					(text) =>
						Effect.sync(() => {
							containsText(skill, text, "the skill quotes the text word for word")
						})
				)
			})
		)
	)
})
