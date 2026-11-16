/**
 * `grizzle check` reports every finding at once, one per entry, never stopping at the first, generated: a committed
 * directory of one schema (its first draft, `init`, and a custom folder after it, `seed`) with a drawn set of faults
 * planted into it, and check's findings must be exactly the set the planted faults name, each at its entry.
 *
 * - **The faults:** snapshot.json unreadable; a folder's meta.json unreadable, or off the chain (its source no previous
 *   target); a statement that controls the transaction; a no-transaction marker below a file's first line; a file of no
 *   `NN-<words>.sql` name; a folder of no `<YYYYMMDDHHMMSS>_<name>` name, whose meta.json is no meta; a placeholder
 *   marker left; a stray entry beside the folders.
 * - **The model:** each fault is its own finding at its own entry, but for what the documented chain walk implies: the
 *   walk stops at the first folder whose meta.json is not the schema's link, so a later folder off the chain is no
 *   finding of its own; and a stray entry leaves the directory unread, its one finding. check exits 1 exactly when
 *   it finds anything; that a clean directory passes is the project suite's (project.test.ts).
 *
 * Oracle: the specification of each planted fault's finding at its own entry, as the documented chain walk reaches it
 * (findingsOf); the findings compared as a set of kinds at entries, each once.
 *
 * Features: each finding's kind, a stray entry alone, four findings at once, and a later folder off the chain the walk
 * never reaches.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, FileSystem, Formatter, Order } from "effect"
import { check } from "#cli/check.ts"
import { cliOver, configName, resolvedConfig, workspace } from "#test/pg/cli/support.ts"
import { assert, defined, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { besideFolders } from "#test/support/migrate/kit.ts"
import {
	at,
	type CheckFeature,
	config,
	entryOf,
	findingsOf,
	init,
	type Layout,
	notesOf,
	phaseFile,
	plant,
	plantedGen,
	schemaDir,
	seed
} from "#test/unit/cli/check.fixtures.ts"

/** Grizzle check reports every planted fault at once, each at its entry, exactly as the chain walk implies, and exits 1 exactly when it finds one. */
export const grizzleCheckReportsEveryPlantedFaultAtOnceEachAtItsEntryExactlyAsTheChainWalkImpliesAndExits1ExactlyWhenItFindsOne =
	property.explore(plantedGen, {
		needs: {},
		situations: [
			"a stray entry alone",
			"four findings at once",
			"a later folder off the chain the walk never reaches",
			"strayEntry",
			"unreadableSnapshot",
			"unreadableMeta",
			"brokenChain",
			"transactionControl",
			"misplacedNoTransaction",
			"placeholder",
			"fileName",
			"folderName"
		] satisfies ReadonlyArray<Reached<CheckFeature>>,
		check: (_, c: Case<CheckFeature>) => (p) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const base = yield* workspace("check-base")
				const drafted = yield* cliOver(
					base,
					config,
					["generate", configName, "--name", "init"],
					at(0)
				)
				assert.equal(drafted.code, 0, drafted.stderr)
				const custom = yield* cliOver(
					base,
					config,
					["generate", configName, "--custom", "--name", "seed"],
					at(1)
				)
				assert.equal(custom.code, 0, custom.stderr)
				const committed = yield* fs.readDirectory(`${base}/${schemaDir}`)
				assert.deepEqual(
					Arr.sort(committed, Order.String),
					Arr.sort([init, seed, ...besideFolders], Order.String)
				)
				const files = yield* fs.readDirectory(`${base}/${schemaDir}/${init}`)
				const layout: Layout = {
					setup: phaseFile(files, "setup"),
					structure: phaseFile(files, "structure"),
					publish: phaseFile(files, "publish")
				}
				return yield* Effect.scoped(
					Effect.gen(function* () {
						const ws = yield* workspace("check-planted")
						yield* fs.copy(base, ws, { overwrite: true })
						yield* plant(ws, p, layout)
						const expected = findingsOf(p, layout)
						c.noteAll(notesOf(p, expected))
						const ran = yield* cliOver(ws, config, ["check", configName], at(2))
						assert.equal(ran.code, expected.length > 0 ? 1 : 0, ran.stderr)
						const read = yield* resolvedConfig(config, `${ws}/${configName}`)
						const resolved = succeeded(read)
						const [checked] = yield* check(resolved, ws)
						unorderedEqual(
							Arr.map(defined(checked, "the schema's check").findings, (f) => ({
								kind: f.kind,
								entry: entryOf(f.where)
							})),
							expected,
							Formatter.format(p)
						)
					})
				)
			}),
		oracle: {
			kind: "specification",
			name: "each planted fault's own finding at its own entry, as the documented chain walk reaches it"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/check.ts",
				original:
					'\t\t\t\tat("brokenChain", path(folder.name, "meta.json"), refusalText.brokenChain.problem)',
				replacement:
					'\t\t\t\tat("unreadableMeta", path(folder.name, "meta.json"), refusalText.unreadableMeta.problem)',
				why: "A folder off the chain is reported as an unreadable meta.json."
			},
			{
				file: "packages/grizzle/src/cli/check.ts",
				original: `\t\t\tfor (const marker of findMarkers(file.text)) {\n\t\t\t\tat(marker.kind, \`\${where}:\${marker.line}\`, refusalText[marker.kind].problem)\n\t\t\t}\n`,
				replacement: "",
				why: "check reports no marker left in a file."
			}
		]
	})
