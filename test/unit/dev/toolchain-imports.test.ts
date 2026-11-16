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
import { aimed, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, boolean, element, type Gen, option } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, FileSystem, Formatter, Option, Path } from "effect"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { exitedCleanly, runChild } from "#test/unit/dev/consumer.ts"

/** A package an import names: one the toolchain switch moved, under grizzle's scope, or one it left where it was. */
type Package =
	| { readonly kind: "moved"; readonly name: "testing" | "devtools"; readonly subpath: string }
	| { readonly kind: "kept"; readonly specifier: string }

/** An import line's form, each spelled as a foreign style writes it. */
type Form = "named" | "type" | "sideEffect" | "reexport"

interface Import {
	readonly form: Form
	readonly from: Package
}

/** A drawn file: its leading comment, its imports, and its body lines, in the foreign style. */
interface Drawn {
	readonly header: Option.Option<string>
	readonly imports: Arr.NonEmptyReadonlyArray<Import>
	readonly body: ReadonlyArray<string>
}

/** A package the toolchain switch moved, under grizzle's scope. */
const movedGen: Gen<Package> = (source) => ({
	kind: "moved",
	name: source.draw(element(["testing", "devtools"] as const)),
	subpath: source.draw(element(["", "/gen", "/explore", "/vitest/config"]))
})

/** A package the switch left where it was. */
const keptGen: Gen<Package> = (source) => ({
	kind: "kept",
	specifier: source.draw(element(["effect", "@effect/vitest", "node:path", "#local/a.ts"]))
})

const packageGen: Gen<Package> = (source) => source.draw(source.draw(boolean) ? movedGen : keptGen)

/** An import of a package `packages` draws, in a drawn form. */
const importOf =
	(packages: Gen<Package>): Gen<Import> =>
	(source) => ({
		form: source.draw(element(["named", "type", "sideEffect", "reexport"] as const)),
		from: source.draw(packages)
	})

/**
 * Whole statements, each valid TypeScript, written as grizzle's formatter would not write them: four-space indents,
 * semicolons, single quotes, a line past grizzle's print width unbroken, a blank line.
 */
const BODY: Arr.NonEmptyReadonlyArray<string> = [
	"const greeting = 'hello';",
	"export function twice(x: number): number {\n    return x * 2;\n}",
	"const list = [1,2,3];",
	"export const long = { alpha: 'a', beta: 'b', gamma: 'c', delta: 'd', epsilon: 'e', zeta: 'z', eta: 'h' };",
	""
]

/** A file whose first import names a package `first` draws, every other import any package. */
const drawnOf =
	(first: Gen<Package>, others: Gen<Package>): Gen<Drawn> =>
	(source) => ({
		header: source.draw(option(element(["// a consumer's file", "/** A consumer's module. */"]))),
		imports: [
			source.draw(importOf(first)),
			...source.draw(array(importOf(others), { min: 0, max: 3 }))
		],
		body: source.draw(array(element(BODY), { min: 0, max: 6 }))
	})

const drawnGen: Gen<Drawn> = drawnOf(packageGen, packageGen)

type Feature = "a moved import renamed" | "a file with nothing to rename left as it was"

/** The file each feature is aimed at while it is pending: a witness whose turn aims at one draws that file (aimed), the
 * file it runs, prints and keeps: a moved import first, or no moved import. */
const aims: Arr.NonEmptyReadonlyArray<readonly [Feature, Gen<Drawn>]> = [
	["a moved import renamed", drawnOf(movedGen, packageGen)],
	["a file with nothing to rename left as it was", drawnOf(keptGen, keptGen)]
]

/** A specifier as written under `scope` for a moved package, or as it is for a kept one. */
const specifierOf = (from: Package, scope: "@grizzle" | "@bjornpagen"): string =>
	from.kind === "moved" ? `${scope}/${from.name}${from.subpath}` : from.specifier

/** An import line in the foreign style, its specifier `specifier`. */
const importLine = (form: Form, specifier: string): string => {
	switch (form) {
		case "named":
			return `import { b, a } from '${specifier}';`
		case "type":
			return `import type { T } from '${specifier}';`
		case "sideEffect":
			return `import '${specifier}';`
		case "reexport":
			return `export { c } from '${specifier}';`
	}
}

/** The file's text, each moved package's specifier spelled under `scope`. */
const textOf = (file: Drawn, scope: "@grizzle" | "@bjornpagen"): string =>
	`${Arr.join(
		[
			...Option.toArray(file.header),
			...Arr.map(file.imports, (i) => importLine(i.form, specifierOf(i.from, scope))),
			...file.body
		],
		"\n"
	)}\n`

/** The foreign repository's formatter configuration: spaces, semicolons, single quotes, as the body is written. */
const foreignConfig = `{
    "useTabs": false,
    "tabWidth": 4,
    "semi": true,
    "singleQuote": true,
    "printWidth": 120
}
`

layer(NodeServices.layer, { excludeTestServices: true })("toolchain-imports", (it) => {
	it.effect(
		"renames the moved packages' scope in a foreign repository's file and changes no other byte, a second run nothing",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const root = path.resolve(import.meta.dirname, "../../..")
					const script = path.join(root, "scripts/dev/toolchain-imports.ts")
					return yield* explore(
						{
							suite: "unit/dev/toolchain-imports",
							draw: aimed(drawnGen, aims),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "the file the case states, its moved specifiers under the toolchain's scope and every other byte as written"
							},
							coverage: required<Feature>(
								Arr.map(aims, ([feature]) => feature),
								{ cases: 8, sense: notesOnly }
							),
							kept: [],
							runs: 6,
							shrink: completeShrink,
							steerEvery: 4,
							caseHang
						},
						(file, c) =>
							Effect.scoped(
								Effect.gen(function* () {
									const repository = yield* fs.makeTempDirectoryScoped({
										prefix: "toolchain-imports-"
									})
									yield* fs.writeFileString(
										path.join(repository, "pnpm-workspace.yaml"),
										"packages: []\n"
									)
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
								})
							)
					)
				})
			)
	)
})
