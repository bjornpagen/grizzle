/**
 * The agent skill: one file, packages/grizzle/skills/grizzle/SKILL.md, shipped in the package (package.json `files`).
 *
 * Every refusal the command line prints, every applied-edit refusal of migrate and every stage's fix is documented in
 * the skill, word for word, so an agent that reads a refusal finds its fix there (packages/grizzle/src/cli/refusals.ts).
 * The box is the refusal table itself, every text of it.
 *
 * Oracle: the refusal table (cli/refusals.ts), whose every text the shipped skill must quote.
 *
 * Plants (~/.cache/grizzle-release/BR04/plants): skill-fix-reworded.patch (a refusal's fix reworded where the skill is
 * not).
 *
 * Features: none; the box is every text.
 */
import { exhaust } from "@bjornpagen/testing/explore"
import { noCoverage } from "@bjornpagen/testing/features"
import { element } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
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
						coverage: noCoverage,
						caseHang,
						box: "every text of the refusal table: each refusal's problem and fix, each applied-edit phrase and each stage's fix",
						oracle: {
							kind: "specification",
							name: "the shipped skill, which quotes every refusal"
						},
						concurrency: 1
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
