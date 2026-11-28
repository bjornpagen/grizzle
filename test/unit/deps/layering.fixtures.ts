/**
 * What the layering property of layering.test.ts draws and runs: modules of the tree's places, a test tier or the
 * shared layer, each importing a module of another, written into a hidden directory of its place in the checkout
 * (`test/<place>/.layering/<index>.ts`, which .gitignore names) and linted there at once by the checkout's root lint's
 * restrictions, as the root's oxlint lints every file of the tree.
 */

import { element, finite } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, FileSystem, Option, String as Str } from "effect"
import { trustedJson } from "#compiler/core/trusted.ts"
import { run } from "#test/support/process.ts"

/** Where a probe sits: a test tier, or test/support, the shared layer. */
type Place = "unit" | "pg" | "support"

/**
 * One import a probe makes: its name, its place, its statements (an import and a use of what it imports), and whether
 * the root lint refuses it.
 */
export interface LayeringCase {
	readonly name: string
	readonly place: Place
	readonly source: string
	readonly refused: boolean
}

/**
 * The imports the layering decides: a tier's value and type imports of another tier's module and of a bench module
 * outside the shared harness, refused, and of the shared harness and test/support, admitted; and test/support's
 * import of a tier, refused.
 */
const CASES: Arr.NonEmptyReadonlyArray<LayeringCase> = [
	{
		name: "a unit module importing a value of test/pg",
		place: "unit",
		source: 'import { probe } from "#test/pg/probe.ts"\nexport const used = probe\n',
		refused: true
	},
	{
		name: "a unit module importing a type of test/pg",
		place: "unit",
		source: 'import type { Probe } from "#test/pg/probe.ts"\nexport type Used = Probe\n',
		refused: true
	},
	{
		name: "a pg module importing a bench module outside the shared harness",
		place: "pg",
		source: 'import { probe } from "#bench/main.ts"\nexport const used = probe\n',
		refused: true
	},
	{
		name: "a pg module importing bench's shared harness",
		place: "pg",
		source: 'import { probe } from "#bench/harness/explain.ts"\nexport const used = probe\n',
		refused: false
	},
	{
		name: "a unit module importing test/support",
		place: "unit",
		source: 'import { probe } from "#test/support/assert.ts"\nexport const used = probe\n',
		refused: false
	},
	{
		name: "a module of test/support importing test/unit",
		place: "support",
		source: 'import { probe } from "#test/unit/probe.ts"\nexport const used = probe\n',
		refused: true
	}
]

/**
 * The box, one value: every case, linted in one run, since a lint's start (its configuration's modules and plugins,
 * read under the runner's trace of a child's reads) is most of its time, where the files it reads are a handful.
 */
export const layeringBoxes = finite((source) => source.draw(element([CASES])))

/** The rule the layering is held by. */
const RESTRICTED_IMPORTS = "eslint(no-restricted-imports)"

/** What the root lint's JSON report holds that this reads: each diagnostic's rule and file. */
interface LintReport {
	readonly diagnostics: ReadonlyArray<Readonly<{ code: string; filename: string }>>
}

/** Case `index`'s probe, by its path from the checkout. */
const probeOf = (layering: LayeringCase, index: number): string =>
	`test/${layering.place}/.layering/${index}.ts`

/**
 * Each case with whether the checkout's root lint refuses its import: every probe written into a hidden directory of
 * its place, linted at once by toolchain-oxlint, the root lint's oxlint at the task's share, under the root lint's
 * AST-only twin (oxlint.ast.config.ts, the commit gate's: every restriction and no type-aware rule, so no program is
 * built for a handful of files), with --no-ignore since .gitignore names the directories, and the directories removed.
 * The report is oxlint's own JSON, which the case trusts as it trusts the tool.
 */
export const refusalsIn = (checkout: string, cases: ReadonlyArray<LayeringCase>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const directories = Arr.dedupe(
			Arr.map(cases, (layering) => `${checkout}/test/${layering.place}/.layering`)
		)
		return yield* Effect.acquireUseRelease(
			Effect.forEach(directories, (directory) => fs.makeDirectory(directory, { recursive: true })),
			() =>
				Effect.gen(function* () {
					yield* Effect.forEach(cases, (layering, index) =>
						fs.writeFileString(`${checkout}/${probeOf(layering, index)}`, layering.source)
					)
					const ran = yield* run(
						`${checkout}/node_modules/.bin/toolchain-oxlint`,
						[
							"-c",
							"oxlint.ast.config.ts",
							"--no-ignore",
							"--format",
							"json",
							...Arr.map(cases, probeOf)
						],
						{ cwd: checkout, env: {} }
					)
					const report = trustedJson<LintReport>(
						Str.slice(Option.getOrElse(Str.indexOf("{")(ran.stdout), () => 0))(ran.stdout)
					)
					return Arr.map(cases, (layering, index) => ({
						layering,
						refused: Arr.some(
							report.diagnostics,
							(diagnostic) =>
								diagnostic.code === RESTRICTED_IMPORTS &&
								diagnostic.filename === probeOf(layering, index)
						)
					}))
				}),
			() =>
				Effect.forEach(directories, (directory) =>
					Effect.ignore(fs.remove(directory, { recursive: true }))
				)
		)
	})
