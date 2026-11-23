import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order, String as Str } from "effect"
import { check } from "#cli/check.ts"
/**
 * A login's served file is held to its workload's compile, byte for byte: `grizzle generate` writes
 * `served/<login>.json` beside the snapshot for every login of the configuration, and `grizzle check` compiles every
 * login again under the committed snapshot and refuses a committed served file that is not that text (one that
 * differs, named with the first program where it parts, one missing, and one of a login the configuration does not
 * list), each a finding of its own naming the login.
 *
 * A case takes the committed directory of one schema's first draft, whose login serves reads, a key and a ChangeSet over
 * its two roles (the CLI fixture's shop, test/pg/cli/fixture.ts), and plants one fault: the SQL of a nonempty
 * set of its programs that state SQL edited, each at a drawn place by a drawn character; its file deleted; a stray
 * file beside it, of a drawn login name the configuration does not list; or its text mutated (Mutation), a character
 * inserted, replaced or deleted at a drawn place, one member of its JSON value dropped and the rest written as
 * generate writes a file, or whitespace put before or after it. The oracle is the first draft: check passes on it as
 * generate wrote it, so a login compiles to the same bytes from the drafted snapshot and from the committed one; after
 * the plant, check finds exactly the plant's one finding where the planted text is not the draft's byte for byte, at
 * the planted file, naming the login, for an edit the first edited program in the file's order and for another layout
 * its layout alone, and none where it is; generate writes or removes exactly the planted file, drafting no folder, and
 * leaves the served directory as the first draft wrote it, byte for byte; and check passes again.
 *
 * The shop's served customersByName names a pattern, its parameter `name`'s, so the first draft installs that
 * parameter's pattern domain (physical/access/extension.ts workloadExtension), which the first draft's SQL is held to
 * create: check passing on it and the regenerate drafting no folder are generate's idempotence over a workload's
 * parameter domains, which a later generate must find recorded in the snapshot and never draft again.
 */
import { silentPhases } from "#compiler/core/phase.ts"

import { servedDirectory, servedPath } from "#compiler/served/forms.ts"

import { assert, defined } from "@bjornpagen/testing/assert"
import { cliOver, configName, resolvedConfig, workspace } from "#test/pg/cli/support.ts"
import { succeeded } from "#test/support/assert.ts"

import {
	at,
	baseNeed,
	config,
	editedText,
	expectedOf,
	login,
	mutatedText,
	plantSpace,
	schemaDir,
	type Situation,
	situationsOf
} from "#test/unit/cli/served.fixtures.ts"

/**
 * Served files: check refuses a served file that is not its login's compile, one missing and one of no login, each
 * naming the login and an edit its first program, and generate writes the served directory back.
 *
 * Budget: its suite's count before the conversion (unit/cli/served: 8 independent cases and 32 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const servedFilesCheckRefusesAServedFileThatIsNotItsLoginsCompileOneMissingAndOneOfNoLoginEachNamingTheLoginAndAnEditItsFirstProgramAndGenerateWritesTheServedDirectoryBack =
	property.explore(plantSpace, {
		needs: { baseNeed },
		situations: [
			"a program edited",
			"programs of both roles edited",
			"a program of the second role edited alone",
			"the file missing",
			"a stray file",
			"a character inserted",
			"a character replaced",
			"a character deleted",
			"a member dropped",
			"another layout"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ baseNeed }, c: Case<Situation>) =>
			(plant) =>
				Effect.gen(function* () {
					const { fs, base, text, json, programs, paths, entries } = yield* baseNeed
					c.noteAll(situationsOf(plant, programs))
					const ws = yield* workspace("served-planted")
					yield* fs.copy(base, ws, { overwrite: true })
					const planted = `${ws}/${schemaDir}/${servedPath(login)}`
					const written = ((): string => {
						switch (plant.kind) {
							case "edited":
								return editedText(text, programs, plant)
							case "missing":
							case "stray":
								return text
							case "mutated":
								return mutatedText(text, json, paths, plant.mutation)
						}
					})()
					switch (plant.kind) {
						case "edited":
						case "mutated":
							yield* fs.writeFileString(planted, written)
							break
						case "missing":
							yield* fs.remove(planted)
							break
						case "stray":
							yield* fs.writeFileString(`${ws}/${schemaDir}/${servedPath(plant.login)}`, text)
							break
					}
					const expected = expectedOf(plant, programs, written, text)
					const refused = yield* cliOver(ws, config, ["check", configName], at(2))
					assert.equal(refused.code, expected.length === 0 ? 0 : 1, refused.stdout)
					const read = yield* resolvedConfig(config, `${ws}/${configName}`)
					const [checked] = yield* check(succeeded(read), ws, silentPhases)
					const findings = defined(checked, "the schema's check").findings
					assert.deepEqual(
						Arr.map(findings, (f) => ({ kind: f.kind, where: f.where })),
						Arr.map(expected, (e) => ({ kind: e.kind, where: e.file })),
						Formatter.format(plant)
					)
					for (const [i, e] of expected.entries()) {
						const found = defined(findings[i], "the finding")
						assert.ok(
							Str.startsWith(e.says)(found.problem),
							`the finding names ${e.says}: ${Formatter.format(found)}`
						)
					}
					const regenerated = yield* cliOver(ws, config, ["generate", configName], at(3))
					assert.equal(regenerated.code, 0, regenerated.stderr)
					for (const e of expected) {
						assert.ok(
							Str.includes(e.file)(regenerated.stdout),
							`generate names the file it writes or removes: ${regenerated.stdout}`
						)
					}
					const after = yield* fs.readDirectory(`${ws}/${schemaDir}`)
					assert.deepEqual(Arr.sort(after, Order.String), entries, "generate drafts no folder")
					const served = yield* fs.readDirectory(`${ws}/${schemaDir}/${servedDirectory}`)
					assert.deepEqual(
						Arr.sort(served, Order.String),
						[`${login}.json`],
						"the served directory holds the login's file alone"
					)
					const rewritten = yield* fs.readFileString(planted)
					assert.equal(rewritten, text, "the served file is the first draft's again")
					const again = yield* cliOver(ws, config, ["check", configName], at(4))
					assert.equal(again.code, 0, again.stdout)
				}),
		oracle: {
			kind: "specification",
			name: "the first draft's own served file, which check passes and generate writes back"
		},
		budget: { runs: 8, steered: 32 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original:
					"\t...membersForm(s, forms.relation),\n\tmanifest: forms.manifest(s.manifest, units)",
				replacement:
					'\t...membersForm(s, forms.relation),\n\tmanifest: forms.manifest({ ...s.manifest, objects: s.manifest.objects.filter((o) => !o.ident.includes(".__param_")), edges: s.manifest.edges.filter((e) => !e.to.includes(".__param_")) }, units)',
				why: "The snapshot is recorded without the parameters' pattern domains its migration installs, so every generate drafts them again."
			},
			{
				file: "packages/engine/src/served/json.ts",
				original:
					'const isRevived = (json: Json): boolean => {\n\tif (typeof json === "string") {\n\t\treturn json.startsWith("~")\n\t}\n\treturn (\n\t\ttypeof json === "object" &&\n\t\t!isList(json) &&\n\t\t(Object.hasOwn(json, revivedKey) || Object.hasOwn(json, mapKey) || Object.hasOwn(json, setKey))\n\t)\n}',
				replacement: "const isRevived = (json: Json): boolean => { return false }",
				why: 'Operator mutant (boolean-return) at packages/engine/src/served/json.ts:246 in isRevived: `{\n\tif (typeof json === "string") {\n\t\treturn json.startsWith("~")\n\t}\n\treturn (\n\t\t` becomes `{ return false }`; the property fails (lane CATCH, grizzle 0baff5d6).'
			}
		]
	})
