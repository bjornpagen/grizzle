import { Effect, FileSystem, Path, type PlatformError } from "effect"
import { cliError, SkillUninstalled } from "#cli/errors.ts"

/** The skill the package ships, beside src/, relative to this module's directory. */
const skillSource = "../../skills/grizzle/SKILL.md"

/**
 * `grizzle skill`: installs the agent skill.
 *
 * The package ships one skill, skills/grizzle/SKILL.md, listed in package.json `files`. The command copies it into the
 * directory it runs in, as `.claude/skills/grizzle/SKILL.md` and `.agents/skills/grizzle/SKILL.md` for other agents,
 * each replaced by rename, and prints both paths. No network, no prompt, no installer: rerunning overwrites both with
 * the skill of the installed grizzle, so a skill is never staler than the package. It needs no configuration.
 *
 * Where `grizzle skill` installs it, relative to the directory it runs in.
 */
export const skillTargets: ReadonlyArray<string> = [
	".claude/skills/grizzle/SKILL.md",
	".agents/skills/grizzle/SKILL.md"
]

/**
 * Installs the skill under `cwd`; returns the paths written, relative to it.
 *
 * @internal
 */
export const installSkill = Effect.fn("installSkill")(
	function* (
		cwd: string
	): Effect.fn.Return<
		ReadonlyArray<string>,
		PlatformError.PlatformError,
		FileSystem.FileSystem | Path.Path
	> {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const text = yield* fs.readFileString(path.join(import.meta.dirname, skillSource))
		for (const target of skillTargets) {
			const installed = path.resolve(cwd, target)
			yield* fs.makeDirectory(path.dirname(installed), { recursive: true })
			const scratch = `${installed}.partial-${process.pid}`
			yield* fs.writeFileString(scratch, text)
			yield* fs.rename(scratch, installed)
		}
		return skillTargets
	},
	Effect.mapError((cause) => cliError(SkillUninstalled.make({ cause })))
)
