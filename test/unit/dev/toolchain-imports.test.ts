/**
 * scripts/dev/toolchain-imports.ts renames and changes nothing else: on a file of another repository, formatted under
 * that repository's own configuration, it gives back every byte as it was but the moved packages' scope in its import
 * specifiers, and a second run changes nothing.
 *
 * A case is a file drawn whole: an optional leading comment, imports of the moved packages (@grizzle/testing and
 * @grizzle/devtools, which the toolchain switch renamed to @bjornpagen/testing and @bjornpagen/devtools, lane rule
 * TOOLCHAIN SWITCH) beside others, and body lines in a style grizzle's own formatter would rewrite (four spaces,
 * semicolons, single quotes), in a scratch pnpm workspace whose .oxfmtrc.json states that style. The script runs on it
 * from that workspace, as a consumer's lane runs it, a child process.
 *
 * Oracle: the file the case states it should become, built from the same draws with each moved specifier spelled under
 * the toolchain's scope; byte-exact.
 *
 * Features: a moved import renamed; a file with nothing to rename left as it was; each, while pending, aimed at by a
 * case constructed to reach it (`aims`).
 */

import { Checkout } from "@bjornpagen/testing/checkout"
import { type Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, FileSystem, Path } from "effect"
import { assert } from "#test/support/assert.ts"
import { exitedCleanly, runChild } from "#test/unit/dev/consumer.ts"
import {
	aims,
	drawnGen,
	type Feature,
	foreignConfig,
	textOf
} from "#test/unit/dev/toolchain-imports.fixtures.ts"

/** Toolchain-imports renames the moved packages' scope in a foreign repository's file and changes no other byte, a second run nothing. */
export const toolchainImportsRenamesTheMovedPackagesScopeInAForeignRepositorysFileAndChangesNoOtherByteASecondRunNothing =
	property.explore(aimed(drawnGen, aims), {
		needs: { dir: Scratch.dir, checkout: Checkout.dir },
		situations: Arr.map(aims, ([feature]) => feature) satisfies ReadonlyArray<Reached<Feature>>,
		check: (resources, c: Case<Feature>) => (file) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const root = yield* resources.checkout
				const script = path.join(root, "scripts/dev/toolchain-imports.ts")
				const repository = yield* resources.dir
				yield* fs.writeFileString(path.join(repository, "pnpm-workspace.yaml"), "packages: []\n")
				yield* fs.writeFileString(path.join(repository, ".oxfmtrc.json"), foreignConfig)
				yield* fs.makeDirectory(path.join(repository, "src"))
				const target = path.join(repository, "src", "module.ts")
				const before = textOf(file, "@grizzle")
				const after = textOf(file, "@bjornpagen")
				yield* fs.writeFileString(target, before)
				const runScript = runChild(process.execPath, [script, target], repository, {})
				const first = yield* runScript
				assert.equal(first.exitCode, exitedCleanly, first.stderr)
				const renamedText = yield* fs.readFileString(target)
				assert.equal(renamedText, after, "the file as renamed")
				const second = yield* runScript
				assert.equal(second.exitCode, exitedCleanly, second.stderr)
				const againText = yield* fs.readFileString(target)
				assert.equal(againText, after, "the file after a second run")
				c.note(
					before === after
						? "a file with nothing to rename left as it was"
						: "a moved import renamed"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the file the case states, its moved specifiers under the toolchain's scope and every other byte as written"
		},
		kept: [],
		kills: []
	})
