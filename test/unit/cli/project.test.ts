/**
 * The loop a person runs over a project, without a database, as a state machine over the command line: edit the
 * schemas in code, `grizzle generate`, review what it drafts, and `grizzle check`, each command run through `runCli`
 * in process exactly as the bin runs it.
 *
 * The project is generated: one or two declared schemas, each a roster Kind and relations keyed by `id` whose fields
 * are integers, booleans, uuids or Kind's codes, read whole by the role `reader` of the login `server`. Its edits add,
 * drop and rename relations and fields, append, drop and move a roster's handles, and add, remove and rename a declared
 * schema, every new name a fresh one. The model is the documented loop (docs/operations.md "Migrations", SKILL "The loop" and
 * "Refusals"):
 *
 * - `generate` drafts a folder for each selected schema whose code differs from what its snapshot.json was generated
 *   from, `<timestamp>_<name>`, the timestamp one second past the schema's newest folder, the epoch for its first, the name
 *   `--name`'s or the change's; and nothing for a schema that did not change. Each field added to a relation that
 *   already stood is a placeholder, its marker line and its value's line; a schema's first draft beside the directory
 *   of a schema the configuration no longer lists starts under the loss of its rows. `--custom --name` writes an empty
 *   folder of the committed snapshot. `--schema`, by a declared name or a PostgreSQL schema, chooses one of several
 *   schemas, and a custom folder or a declaration needs it there. A drop or rename is drafted only when declared
 *   (`--drop`, `--rename`, in the previous snapshot's names); a roster's handles declared out of their codes' order are
 *   refused; a schema whose directory is a file is refused. A refusal writes nothing for any schema, and exits 2 for a
 *   usage error, 1 otherwise.
 * - What generate writes is exactly what the pure generator drafts (deploy/render/generate.ts) from the committed
 *   snapshot read before it, the schema compiled with its login, the declared renames and drops, the name and the
 *   timestamp, byte for byte: every file, meta.json and snapshot.json.
 * - `check` finds, for each schema: an unresolved placeholder per marker line and value line, an undecided loss, and
 *   then, against the committed snapshot, a roster reordered, else an undeclared drop, else an ungenerated change beside
 *   its login's served file, missing before the schema's first draft and stale after, since the snapshot it compiles
 *   under is another; or, for a directory that is a file, only that. It exits 1 exactly when it finds anything.
 * - Reviewing deletes every marker line and writes every value; deciding a loss writes its statement in. A hidden
 *   entry an editor leaves beside the folders changes nothing.
 *
 * After every command the workspace is read back: the exit status and refusal, every schema's folders and their names,
 * and what the command wrote.
 *
 * Oracle: a model of the documented loop, and the pure generator fed the committed snapshot read before each generate
 * (a second implementation of what generate writes).
 *
 * Features: every command of the loop, each edit, each refusal, each finding, and a hidden entry ignored.
 */
import { runProgram } from "@bjornpagen/testing/commands"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { workspace } from "#test/support/pg/cli/support.ts"
import {
	machine,
	type ProjectFeature,
	projectFeatures,
	programSpace,
	realOf
} from "#test/unit/cli/project.fixtures.ts"

/**
 * The loop over a generated project: every command's exit status, refusal and folders are the model's, and what
 * generate writes is the pure generator's draft byte for byte.
 *
 * Budget: its suite's 64 steered cases (unit/cli/project: 16 independent and 64 steered, Vitest at grizzle 4ca3036a)
 * and 40 runs, measured as the least witnesses that reach every required situation: with a cap of 1,000 steered, 16
 * runs need 272 steered (292 cases), 20 need 144, 24 need 176, 32 need 144, 40 need 64 (114 cases) and 80 need 128
 * (toolchain-test run, 2026-11-16); at TEST_SEED=1 to 5 every kill is killed.
 */
export const theLoopOverAGeneratedProjectEveryCommandsExitStatusRefusalAndFoldersAreTheModelsAndWhatGenerateWritesIsThePureGeneratorsDraftByteForByte =
	property.explore(programSpace, {
		needs: {},
		situations: projectFeatures satisfies ReadonlyArray<Reached<ProjectFeature>>,
		check: (_, c: Case<ProjectFeature>) => (steps) =>
			Effect.gen(function* () {
				const dir = yield* workspace("project")
				yield* runProgram(machine, realOf({ dir, c }), steps)
			}),
		oracle: {
			kind: "second-implementation",
			name: "a model of the documented loop, and the pure generator fed the committed snapshot read before each generate"
		},
		budget: { runs: 40, steered: 64 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/timestamp.ts",
				original: "\t\t\tonSome: (last) => DateTime.add(instantOf(last), timestampResolution)",
				replacement: "\t\t\tonSome: (last) => instantOf(last)",
				why: "A folder's timestamp repeats the newest folder's."
			},
			{
				file: "packages/grizzle/src/cli/check.ts",
				original: `\t\t\tfor (const marker of findMarkers(text)) {\n\t\t\t\tat(marker.kind, \`\${where}:\${marker.line}\`, refusalText[marker.kind].problem)\n\t\t\t}\n`,
				replacement: "",
				why: "check reports no marker left in a file."
			}
		]
	})
