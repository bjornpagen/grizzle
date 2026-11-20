/**
 * The agent skill: one file, packages/grizzle/skills/grizzle/SKILL.md, shipped in the package (package.json `files`).
 *
 * Every refusal the command line prints, every applied-edit refusal of migrate and every stage's fix is documented in
 * the skill, word for word, so an agent that reads a refusal finds its fix there (packages/grizzle/src/cli/refusals.ts).
 * The box is the refusal table itself, every text of it.
 *
 * Oracle: the refusal table (cli/refusals.ts), whose every text the shipped skill must quote.
 *
 * Features: none; the box is every text.
 */
import { containsText } from "@bjornpagen/testing/assert"
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect, FileSystem } from "effect"
import { repoRoot } from "#test/support/files.ts"
import { documented } from "#test/unit/cli/skill.dictionary.ts"

/** The grizzle skill documents every refusal and every stage's fix word for word. */
export const theGrizzleSkillDocumentsEveryRefusalAndEveryStagesFixWordForWord = property.exhaust(
	finite(word(documented)),
	{
		box: "every text of the refusal table: each refusal's problem and fix, each applied-edit phrase and each stage's fix",
		needs: {},
		situations: [],
		check: () => (text) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const skill = yield* fs.readFileString(
					`${repoRoot}packages/grizzle/skills/grizzle/SKILL.md`
				)
				containsText(skill, text, "the skill quotes the text word for word")
			}),
		oracle: {
			kind: "specification",
			name: "the shipped skill, which quotes every refusal"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/refusals.ts",
				original:
					'\t\tproblem: "the schemas or their logins differ from snapshot.json (an ungenerated change)",\n\t\tfix: "run grizzle generate"',
				replacement:
					'\t\tproblem: "the schemas or their logins differ from snapshot.json (an ungenerated change)",\n\t\tfix: "rerun grizzle generate"',
				why: "A refusal's fix reworded where the skill is not."
			}
		]
	}
)
